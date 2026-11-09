import { afterAll, beforeAll, describe, it } from 'vitest';
import { resetConfig } from '../src/config';
import { createTestApp, type TestCtx } from './helpers';

/** On Vercel the api service receives the original /api/... path (vercel.json rewrite). */
describe('API_BASE_PATH', () => {
  let ctx: TestCtx;
  beforeAll(async () => {
    process.env.API_BASE_PATH = '/api';
    resetConfig();
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.app.close();
    delete process.env.API_BASE_PATH;
    resetConfig();
  });

  it('mounts every route under the prefix', async () => {
    await ctx.http().get('/api/health').expect(200);
    await ctx.http().get('/api/billing/plans').expect(200);
    await ctx.http().get('/api/auth/me').expect(401);
    await ctx.http().get('/health').expect(404);
  });
});
