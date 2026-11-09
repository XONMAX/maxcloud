import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createApp } from '../src/bootstrap';
import { PrismaService } from '../src/common/prisma.service';
import { RedisService } from '../src/common/redis.service';
import { StorageService } from '../src/storage/storage.service';
import { syncPlans } from '../src/billing/plans.sync';

export interface TestCtx {
  app: INestApplication;
  prisma: PrismaService;
  http: () => ReturnType<typeof request>;
}

export async function createTestApp(): Promise<TestCtx> {
  const app = await createApp({ logger: false });
  // Listen once so concurrent supertest requests share one server (otherwise each opens an ephemeral one).
  await app.listen(0, '127.0.0.1');
  const prisma = app.get(PrismaService);
  await syncPlans(prisma);
  await app.get(RedisService).flushdb();
  await app.get(StorageService).ensureBucket(['http://localhost:3000']);
  return { app, prisma, http: () => request(app.getHttpServer()) };
}

let n = 0;
export function uniqueEmail(tag = 'user') {
  return `${tag}.${Date.now()}.${++n}@test.maxcloud.uz`;
}

/** Registers a user via the API (native mode) and returns bearer auth helpers. */
export async function registerUser(ctx: TestCtx, tag = 'user', password = 'correct horse battery') {
  const email = uniqueEmail(tag);
  const res = await ctx.http().post('/auth/register').set('X-Client', 'mobile').send({ email, password, name: tag }).expect(201);
  const token: string = res.body.accessToken;
  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
  return { email, password, token, user: res.body.user, refreshToken: res.body.refreshToken as string, auth };
}
