import { HttpStatus, Injectable } from '@nestjs/common';
import type { User } from '@prisma/client';
import argon2 from 'argon2';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { randomBytes } from 'node:crypto';
import { getPlan, FREE_PLAN_ID } from '@maxcloud/shared';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';
import { AppError, Errors } from '../common/errors';
import { decrypt, encrypt, randomToken, sha256 } from '../common/crypto';
import { config } from '../config';
import { MailService } from '../mail/mail.service';
import { OAuthService } from './oauth.service';
import { TokensService, type DeviceInfo, type IssuedTokens } from './tokens.service';

authenticator.options = { window: 1 };

const ARGON_OPTS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;
let dummyHash: Promise<string> | null = null;

export interface LoginResult {
  user: User;
  tokens: IssuedTokens;
}

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private tokens: TokensService,
    private oauth: OAuthService,
    private mail: MailService,
  ) {}

  hashPassword(pw: string) {
    return argon2.hash(pw, ARGON_OPTS);
  }

  async register(input: { email: string; password: string; name: string; locale: string }, device: DeviceInfo): Promise<LoginResult> {
    const exists = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (exists) throw Errors.conflict('An account with this email already exists');
    const user = await this.prisma.user.create({
      data: {
        email: input.email,
        name: input.name,
        locale: input.locale,
        passwordHash: await this.hashPassword(input.password),
        planId: FREE_PLAN_ID,
        quotaBytes: BigInt(getPlan(FREE_PLAN_ID).quotaBytes),
      },
    });
    await this.sendVerification(user);
    return { user, tokens: await this.tokens.createSession(user, device) };
  }

  async login(input: { email: string; password: string; totp?: string }, device: DeviceInfo): Promise<LoginResult> {
    const user = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (!user?.passwordHash) {
      // Equalise timing so we don't leak which emails exist.
      dummyHash ??= argon2.hash('timing-equaliser', ARGON_OPTS);
      await argon2.verify(await dummyHash, input.password);
      throw new AppError(HttpStatus.UNAUTHORIZED, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
    }
    if (!(await argon2.verify(user.passwordHash, input.password))) {
      throw new AppError(HttpStatus.UNAUTHORIZED, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
    }
    await this.checkSecondFactor(user, input.totp);
    return { user, tokens: await this.tokens.createSession(user, device) };
  }

  async loginWithOAuth(provider: 'google' | 'apple', idToken: string, totp: string | undefined, nameHint: string | undefined, device: DeviceInfo): Promise<LoginResult> {
    const id = await this.oauth.verify(provider, idToken);
    const subField = provider === 'google' ? 'googleSub' : 'appleSub';
    let user = await this.prisma.user.findUnique({ where: provider === 'google' ? { googleSub: id.sub } : { appleSub: id.sub } });
    if (!user) {
      const byEmail = await this.prisma.user.findUnique({ where: { email: id.email } });
      if (byEmail) {
        // Only auto-link when the provider vouches for the email, otherwise anyone could claim an account.
        if (!id.emailVerified) throw Errors.conflict('Sign in with your password, then link this account in settings');
        user = await this.prisma.user.update({ where: { id: byEmail.id }, data: { [subField]: id.sub, emailVerifiedAt: byEmail.emailVerifiedAt ?? new Date() } });
      } else {
        user = await this.prisma.user.create({
          data: {
            email: id.email,
            name: id.name ?? nameHint ?? id.email.split('@')[0],
            [subField]: id.sub,
            emailVerifiedAt: id.emailVerified ? new Date() : null,
            planId: FREE_PLAN_ID,
            quotaBytes: BigInt(getPlan(FREE_PLAN_ID).quotaBytes),
          },
        });
      }
    }
    await this.checkSecondFactor(user, totp);
    return { user, tokens: await this.tokens.createSession(user, device) };
  }

  private async checkSecondFactor(user: User, code?: string) {
    if (!user.totpEnabledAt || !user.totpSecretEnc) return;
    if (!code) throw new AppError(HttpStatus.UNAUTHORIZED, 'TOTP_REQUIRED', 'Enter the code from your authenticator app');
    if (/^\d{6}$/.test(code)) {
      const secret = decrypt(user.totpSecretEnc);
      // Block replay of the same code within its validity window.
      const replayKey = `totp:used:${user.id}:${code}`;
      if (authenticator.check(code, secret) && (await this.redis.set(replayKey, '1', 'EX', 90, 'NX'))) return;
    } else {
      const h = sha256(code.toLowerCase());
      if (user.recoveryCodes.includes(h)) {
        await this.prisma.user.update({ where: { id: user.id }, data: { recoveryCodes: user.recoveryCodes.filter((c) => c !== h) } });
        return;
      }
    }
    throw new AppError(HttpStatus.UNAUTHORIZED, 'TOTP_INVALID', 'The code is incorrect');
  }

  // ---------- 2FA management ----------
  async totpSetup(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.totpEnabledAt) throw Errors.conflict('Two-factor authentication is already on');
    const secret = authenticator.generateSecret();
    await this.redis.set(`totp:setup:${userId}`, encrypt(secret), 'EX', 600);
    const otpauthUrl = authenticator.keyuri(user.email, config().APP_NAME, secret);
    return { secret, otpauthUrl, qrDataUrl: await QRCode.toDataURL(otpauthUrl) };
  }

  async totpEnable(userId: string, code: string) {
    const enc = await this.redis.get(`totp:setup:${userId}`);
    if (!enc) throw Errors.bad('Setup expired, start again');
    if (!authenticator.check(code, decrypt(enc))) throw new AppError(HttpStatus.BAD_REQUEST, 'TOTP_INVALID', 'The code is incorrect');
    const recovery = Array.from({ length: 8 }, () => randomBytes(8).toString('base64url').replace(/[-_]/g, 'x').slice(0, 10).toLowerCase());
    await this.prisma.user.update({ where: { id: userId }, data: { totpSecretEnc: enc, totpEnabledAt: new Date(), recoveryCodes: recovery.map(sha256) } });
    await this.redis.del(`totp:setup:${userId}`);
    return { recoveryCodes: recovery };
  }

  async totpDisable(userId: string, password: string, code: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.passwordHash && !(await argon2.verify(user.passwordHash, password))) {
      throw new AppError(HttpStatus.UNAUTHORIZED, 'INVALID_CREDENTIALS', 'Password is incorrect');
    }
    await this.checkSecondFactor(user, code);
    await this.prisma.user.update({ where: { id: userId }, data: { totpSecretEnc: null, totpEnabledAt: null, recoveryCodes: [] } });
  }

  // ---------- Passwords & email ----------
  async changePassword(userId: string, sessionId: string, current: string, next: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.passwordHash && !(await argon2.verify(user.passwordHash, current))) {
      throw new AppError(HttpStatus.UNAUTHORIZED, 'INVALID_CREDENTIALS', 'Current password is incorrect');
    }
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash: await this.hashPassword(next) } });
    await this.tokens.revokeAll(userId, sessionId);
  }

  private async issueEmailToken(userId: string, kind: 'VERIFY' | 'RESET', ttlMs: number) {
    const token = randomToken();
    await this.prisma.emailToken.create({ data: { userId, kind, tokenHash: sha256(token), expiresAt: new Date(Date.now() + ttlMs) } });
    return token;
  }

  async sendVerification(user: User) {
    const token = await this.issueEmailToken(user.id, 'VERIFY', 24 * 3600_000);
    await this.mail.send(user.email, 'verify_email', user.locale, { name: user.name, url: `${config().WEB_ORIGIN}/verify-email?token=${token}` });
  }

  private async consumeEmailToken(token: string, kind: 'VERIFY' | 'RESET') {
    const t = await this.prisma.emailToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (!t || t.kind !== kind || t.usedAt || t.expiresAt < new Date()) throw Errors.bad('Link is invalid or expired', 'LINK_EXPIRED');
    const used = await this.prisma.emailToken.updateMany({ where: { id: t.id, usedAt: null }, data: { usedAt: new Date() } });
    if (used.count !== 1) throw Errors.bad('Link already used', 'LINK_EXPIRED');
    return t;
  }

  async verifyEmail(token: string) {
    const t = await this.consumeEmailToken(token, 'VERIFY');
    await this.prisma.user.update({ where: { id: t.userId }, data: { emailVerifiedAt: new Date() } });
  }

  async requestPasswordReset(email: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) return; // same response either way
    const token = await this.issueEmailToken(user.id, 'RESET', 3600_000);
    await this.mail.send(user.email, 'reset_password', user.locale, { url: `${config().WEB_ORIGIN}/reset-password?token=${token}` });
  }

  async resetPassword(token: string, password: string) {
    const t = await this.consumeEmailToken(token, 'RESET');
    await this.prisma.user.update({ where: { id: t.userId }, data: { passwordHash: await this.hashPassword(password) } });
    await this.tokens.revokeAll(t.userId);
  }
}
