import { CanActivate, ExecutionContext, HttpStatus, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { config } from '../config';
import { AppError } from './errors';
import { RedisService } from './redis.service';

interface RateLimitOpts {
  limit: number;
  windowSec: number;
  /** Bucket name; defaults to the route path */
  bucket?: string;
}

const KEY = 'mc:ratelimit';
export const RateLimit = (opts: RateLimitOpts) => SetMetadata(KEY, opts);

const DEFAULT: RateLimitOpts = { limit: 600, windowSec: 60, bucket: 'global' };

/** Fixed-window limiter in Redis, keyed by IP (+ user when authenticated). */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(private reflector: Reflector, private redis: RedisService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (config().RATE_LIMIT_DISABLED) return true;
    const req = ctx.switchToHttp().getRequest<Request>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const opts = this.reflector.getAllAndOverride<RateLimitOpts>(KEY, [ctx.getHandler(), ctx.getClass()]) ?? DEFAULT;
    const bucket = opts.bucket ?? `${req.method}:${req.route?.path ?? req.path}`;
    const window = Math.floor(Date.now() / 1000 / opts.windowSec);
    const key = `rl:${bucket}:${req.ip}:${window}`;
    const n = await this.redis.incr(key);
    if (n === 1) await this.redis.expire(key, opts.windowSec + 1);
    res.setHeader('X-RateLimit-Limit', opts.limit);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, opts.limit - n));
    if (n > opts.limit) {
      res.setHeader('Retry-After', opts.windowSec);
      throw new AppError(HttpStatus.TOO_MANY_REQUESTS, 'RATE_LIMITED', 'Too many requests, slow down.');
    }
    return true;
  }
}
