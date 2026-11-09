import { Injectable } from '@nestjs/common';
import { SignJWT } from 'jose';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';
import { jwtKey, revokedKey } from '../common/auth.guard';
import { randomToken, sha256 } from '../common/crypto';
import { Errors } from '../common/errors';

export const ACCESS_TTL_SEC = 15 * 60;
export const REFRESH_TTL_SEC = 30 * 24 * 3600;

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresIn: number;
  sessionId: string;
}

export interface DeviceInfo {
  deviceName: string;
  userAgent?: string;
  ip?: string;
}

@Injectable()
export class TokensService {
  constructor(private prisma: PrismaService, private redis: RedisService) {}

  private async signAccess(userId: string, sessionId: string, role: string) {
    return new SignJWT({ sid: sessionId, role })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuer('maxcloud')
      .setAudience('maxcloud-api')
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TTL_SEC}s`)
      .sign(jwtKey());
  }

  async createSession(user: { id: string; role: string }, device: DeviceInfo): Promise<IssuedTokens> {
    const refreshToken = randomToken();
    const session = await this.prisma.session.create({
      data: {
        userId: user.id,
        refreshTokenHash: sha256(refreshToken),
        deviceName: device.deviceName,
        userAgent: device.userAgent?.slice(0, 500),
        ip: device.ip,
        expiresAt: new Date(Date.now() + REFRESH_TTL_SEC * 1000),
      },
    });
    return {
      accessToken: await this.signAccess(user.id, session.id, user.role),
      refreshToken,
      accessExpiresIn: ACCESS_TTL_SEC,
      sessionId: session.id,
    };
  }

  /**
   * Rotating refresh tokens with reuse detection: a refresh token can be used
   * once. Presenting an already-rotated token revokes the whole session
   * (someone copied it).
   */
  async refresh(refreshToken: string, ip?: string): Promise<IssuedTokens> {
    const hash = sha256(refreshToken);
    const session = await this.prisma.session.findUnique({ where: { refreshTokenHash: hash }, include: { user: true } });
    if (!session) {
      const reused = await this.prisma.session.findUnique({ where: { prevRefreshHash: hash } });
      if (reused && !reused.revokedAt) await this.revoke(reused.userId, reused.id);
      throw Errors.unauth('Refresh token invalid');
    }
    if (session.revokedAt || session.expiresAt < new Date()) throw Errors.unauth('Session ended');
    const next = randomToken();
    // Conditional update makes concurrent refreshes with the same token safe: only one wins.
    const res = await this.prisma.session.updateMany({
      where: { id: session.id, refreshTokenHash: hash },
      data: { refreshTokenHash: sha256(next), prevRefreshHash: hash, lastUsedAt: new Date(), ip: ip ?? session.ip },
    });
    if (res.count !== 1) throw Errors.unauth('Refresh token invalid');
    return {
      accessToken: await this.signAccess(session.userId, session.id, session.user.role),
      refreshToken: next,
      accessExpiresIn: ACCESS_TTL_SEC,
      sessionId: session.id,
    };
  }

  async revoke(userId: string, sessionId: string) {
    const r = await this.prisma.session.updateMany({ where: { id: sessionId, userId, revokedAt: null }, data: { revokedAt: new Date() } });
    // Access tokens are stateless; blacklist the session id for their remaining lifetime.
    await this.redis.set(revokedKey(sessionId), '1', 'EX', ACCESS_TTL_SEC + 5);
    return r.count > 0;
  }

  async revokeAll(userId: string, exceptSessionId?: string) {
    const sessions = await this.prisma.session.findMany({ where: { userId, revokedAt: null, NOT: exceptSessionId ? { id: exceptSessionId } : undefined } });
    for (const s of sessions) await this.revoke(userId, s.id);
    return sessions.length;
  }
}
