import { CanActivate, ExecutionContext, Injectable, SetMetadata, createParamDecorator } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { jwtVerify } from 'jose';
import { allowedOrigins, config } from '../config';
import { AppError, Errors } from './errors';
import { RedisService } from './redis.service';
import { HttpStatus } from '@nestjs/common';

export interface AuthContext {
  userId: string;
  sessionId: string;
  role: 'USER' | 'ADMIN';
}

export const ACCESS_COOKIE = 'mc_at';
export const REFRESH_COOKIE = 'mc_rt';

const PUBLIC_KEY = 'mc:public';
const ADMIN_KEY = 'mc:admin';
/** Route needs no auth. */
export const Public = () => SetMetadata(PUBLIC_KEY, true);
/** Route requires ADMIN role. */
export const AdminOnly = () => SetMetadata(ADMIN_KEY, true);

export const Auth = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthContext => {
  const req = ctx.switchToHttp().getRequest<Request & { auth?: AuthContext }>();
  if (!req.auth) throw Errors.unauth();
  return req.auth;
});

export function jwtKey() {
  return new TextEncoder().encode(config().JWT_SECRET);
}

export function revokedKey(sessionId: string) {
  return `revoked:sess:${sessionId}`;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Global guard:
 *  - accepts `Authorization: Bearer <jwt>` (mobile/desktop) or the httpOnly access cookie (web)
 *  - checks the session was not revoked (Redis set on revoke, TTL = access token lifetime)
 *  - CSRF: cookie-authenticated mutating requests must come from an allowed Origin
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector, private redis: RedisService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { auth?: AuthContext }>();
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()]);
    const header = req.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const cookieToken = (req.cookies as Record<string, string> | undefined)?.[ACCESS_COOKIE];
    const token = bearer ?? cookieToken;

    if (!SAFE_METHODS.has(req.method) && !bearer && cookieToken) {
      const origin = req.headers.origin;
      if (!origin || !allowedOrigins().includes(origin)) {
        throw new AppError(HttpStatus.FORBIDDEN, 'BAD_ORIGIN', 'Cross-origin request rejected');
      }
    }

    if (token) {
      try {
        const { payload } = await jwtVerify(token, jwtKey(), { issuer: 'maxcloud', audience: 'maxcloud-api' });
        const sid = String(payload.sid);
        if (await this.redis.exists(revokedKey(sid))) throw new Error('revoked');
        req.auth = { userId: String(payload.sub), sessionId: sid, role: payload.role === 'ADMIN' ? 'ADMIN' : 'USER' };
      } catch {
        if (!isPublic) throw Errors.unauth('Session expired');
      }
    }

    if (isPublic) return true;
    if (!req.auth) throw Errors.unauth();
    const adminOnly = this.reflector.getAllAndOverride<boolean>(ADMIN_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (adminOnly && req.auth.role !== 'ADMIN') throw Errors.forbidden('Admin only');
    return true;
  }
}
