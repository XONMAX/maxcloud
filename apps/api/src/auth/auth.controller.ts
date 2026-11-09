import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  ChangePasswordSchema,
  LoginSchema,
  OAuthSchema,
  RegisterSchema,
  TotpDisableSchema,
  TotpEnableSchema,
} from '@maxcloud/shared';
import { ACCESS_COOKIE, Auth, Public, REFRESH_COOKIE, type AuthContext } from '../common/auth.guard';
import { PrismaService } from '../common/prisma.service';
import { RateLimit } from '../common/rate-limit.guard';
import { ZodPipe } from '../common/zod.pipe';
import { Errors } from '../common/errors';
import { toUserDto } from '../common/serialize';
import { config } from '../config';
import { AuthService } from './auth.service';
import { deviceNameFromUA } from './device';
import { ACCESS_TTL_SEC, REFRESH_TTL_SEC, TokensService, type IssuedTokens } from './tokens.service';

const OAuthLoginSchema = OAuthSchema.extend({ totp: z.string().optional() });
const TokenSchema = z.object({ token: z.string().min(10) });
const EmailOnlySchema = z.object({ email: z.string().trim().toLowerCase().email() });
const ResetSchema = z.object({ token: z.string().min(10), password: z.string().min(10).max(200) });
const RefreshSchema = z.object({ refreshToken: z.string().optional() });

/** Native clients (mobile/desktop) send X-Client and get tokens in the body instead of cookies. */
function isNative(req: Request) {
  return typeof req.headers['x-client'] === 'string' && ['mobile', 'desktop'].includes(req.headers['x-client'] as string);
}

function device(req: Request) {
  return {
    deviceName: deviceNameFromUA(req.headers['user-agent'], req.headers['x-device-name'] as string | undefined),
    userAgent: req.headers['user-agent'],
    ip: req.ip,
  };
}

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService, private tokens: TokensService, private prisma: PrismaService) {}

  private respond(req: Request, res: Response, tokens: IssuedTokens, body: Record<string, unknown>) {
    if (isNative(req)) return { ...body, ...tokens };
    const secure = config().COOKIE_SECURE;
    res.cookie(ACCESS_COOKIE, tokens.accessToken, { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: ACCESS_TTL_SEC * 1000 });
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, { httpOnly: true, sameSite: 'lax', secure, path: '/api/auth', maxAge: REFRESH_TTL_SEC * 1000 });
    return { ...body, accessExpiresIn: tokens.accessExpiresIn };
  }

  private clear(res: Response) {
    res.clearCookie(ACCESS_COOKIE, { path: '/' });
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
  }

  @Public()
  @RateLimit({ limit: 5, windowSec: 3600, bucket: 'register' })
  @Post('register')
  async register(@Body(new ZodPipe(RegisterSchema)) body: z.infer<typeof RegisterSchema>, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { user, tokens } = await this.auth.register(body, device(req));
    return this.respond(req, res, tokens, { user: toUserDto(user) });
  }

  @Public()
  @RateLimit({ limit: 10, windowSec: 60, bucket: 'login' })
  @HttpCode(200)
  @Post('login')
  async login(@Body(new ZodPipe(LoginSchema)) body: z.infer<typeof LoginSchema>, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { user, tokens } = await this.auth.login(body, device(req));
    return this.respond(req, res, tokens, { user: toUserDto(user) });
  }

  @Public()
  @RateLimit({ limit: 10, windowSec: 60, bucket: 'login' })
  @HttpCode(200)
  @Post('oauth/:provider')
  async oauthLogin(
    @Param('provider') provider: string,
    @Body(new ZodPipe(OAuthLoginSchema)) body: z.infer<typeof OAuthLoginSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (provider !== 'google' && provider !== 'apple') throw Errors.notFound('Provider');
    const { user, tokens } = await this.auth.loginWithOAuth(provider, body.idToken, body.totp, body.name, device(req));
    return this.respond(req, res, tokens, { user: toUserDto(user) });
  }

  @Public()
  @RateLimit({ limit: 60, windowSec: 60, bucket: 'refresh' })
  @HttpCode(200)
  @Post('refresh')
  async refresh(@Body(new ZodPipe(RefreshSchema)) body: z.infer<typeof RefreshSchema>, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = body.refreshToken ?? (req.cookies as Record<string, string>)[REFRESH_COOKIE];
    if (!token) throw Errors.unauth('No refresh token');
    try {
      const tokens = await this.tokens.refresh(token, req.ip);
      return this.respond(req, res, tokens, { ok: true });
    } catch (e) {
      this.clear(res);
      throw e;
    }
  }

  @HttpCode(200)
  @Post('logout')
  async logout(@Auth() a: AuthContext, @Res({ passthrough: true }) res: Response) {
    await this.tokens.revoke(a.userId, a.sessionId);
    this.clear(res);
    return { ok: true };
  }

  @Get('me')
  async me(@Auth() a: AuthContext) {
    const user = await this.prisma.user.findUnique({ where: { id: a.userId } });
    if (!user) throw Errors.unauth();
    return { user: toUserDto(user) };
  }

  // ----- devices / sessions -----
  @Get('sessions')
  async sessions(@Auth() a: AuthContext) {
    const list = await this.prisma.session.findMany({ where: { userId: a.userId, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { lastUsedAt: 'desc' } });
    return {
      sessions: list.map((s) => ({
        id: s.id,
        deviceName: s.deviceName,
        ip: s.ip,
        createdAt: s.createdAt.toISOString(),
        lastUsedAt: s.lastUsedAt.toISOString(),
        current: s.id === a.sessionId,
      })),
    };
  }

  @Delete('sessions/:id')
  async revokeSession(@Auth() a: AuthContext, @Param('id') id: string) {
    if (!(await this.tokens.revoke(a.userId, id))) throw Errors.notFound('Session');
    return { ok: true };
  }

  @HttpCode(200)
  @Post('sessions/revoke-others')
  async revokeOthers(@Auth() a: AuthContext) {
    return { revoked: await this.tokens.revokeAll(a.userId, a.sessionId) };
  }

  // ----- 2FA -----
  @HttpCode(200)
  @Post('2fa/setup')
  totpSetup(@Auth() a: AuthContext) {
    return this.auth.totpSetup(a.userId);
  }

  @HttpCode(200)
  @Post('2fa/enable')
  totpEnable(@Auth() a: AuthContext, @Body(new ZodPipe(TotpEnableSchema)) body: z.infer<typeof TotpEnableSchema>) {
    return this.auth.totpEnable(a.userId, body.code);
  }

  @HttpCode(200)
  @RateLimit({ limit: 10, windowSec: 300, bucket: '2fa-disable' })
  @Post('2fa/disable')
  async totpDisable(@Auth() a: AuthContext, @Body(new ZodPipe(TotpDisableSchema)) body: z.infer<typeof TotpDisableSchema>) {
    await this.auth.totpDisable(a.userId, body.password, body.code);
    return { ok: true };
  }

  // ----- password & email -----
  @HttpCode(200)
  @Post('password')
  async changePassword(@Auth() a: AuthContext, @Body(new ZodPipe(ChangePasswordSchema)) body: z.infer<typeof ChangePasswordSchema>) {
    await this.auth.changePassword(a.userId, a.sessionId, body.currentPassword, body.newPassword);
    return { ok: true };
  }

  @Public()
  @HttpCode(200)
  @Post('verify-email')
  async verifyEmail(@Body(new ZodPipe(TokenSchema)) body: z.infer<typeof TokenSchema>) {
    await this.auth.verifyEmail(body.token);
    return { ok: true };
  }

  @HttpCode(200)
  @RateLimit({ limit: 3, windowSec: 3600, bucket: 'resend-verify' })
  @Post('verify-email/resend')
  async resend(@Auth() a: AuthContext) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: a.userId } });
    if (!user.emailVerifiedAt) await this.auth.sendVerification(user);
    return { ok: true };
  }

  @Public()
  @HttpCode(200)
  @RateLimit({ limit: 5, windowSec: 3600, bucket: 'forgot' })
  @Post('password/forgot')
  async forgot(@Body(new ZodPipe(EmailOnlySchema)) body: z.infer<typeof EmailOnlySchema>) {
    await this.auth.requestPasswordReset(body.email);
    return { ok: true };
  }

  @Public()
  @HttpCode(200)
  @RateLimit({ limit: 10, windowSec: 3600, bucket: 'reset' })
  @Post('password/reset')
  async reset(@Body(new ZodPipe(ResetSchema)) body: z.infer<typeof ResetSchema>) {
    await this.auth.resetPassword(body.token, body.password);
    return { ok: true };
  }
}
