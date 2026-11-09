import { Controller, Get, Header, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../common/auth.guard';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';
import { registry } from '../common/metrics';
import { StorageService } from '../storage/storage.service';

@Controller()
export class HealthController {
  constructor(private prisma: PrismaService, private redis: RedisService, private storage: StorageService) {}

  /** Liveness: process is up. */
  @Public()
  @Get('health')
  health() {
    return { ok: true };
  }

  /** Readiness: dependencies reachable. Point the uptime monitor here. */
  @Public()
  @Get('health/ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const checks: Record<string, boolean> = {};
    await Promise.all([
      this.prisma.$queryRaw`SELECT 1`.then(() => (checks.db = true)).catch(() => (checks.db = false)),
      this.redis.ping().then(() => (checks.redis = true)).catch(() => (checks.redis = false)),
      this.storage.ping().then(() => (checks.storage = true)).catch(() => (checks.storage = false)),
    ]);
    const ok = Object.values(checks).every(Boolean);
    res.status(ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { ok, checks };
  }

  /** Prometheus scrape endpoint. Block it at the edge (Cloudflare rule) or scrape over the private network. */
  @Public()
  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4')
  metrics() {
    return registry.metrics();
  }
}
