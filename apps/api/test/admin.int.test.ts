import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SCENARIO } from '@maxcloud/shared';
import { createTestApp, registerUser, type TestCtx } from './helpers';
import { uploadFile } from './upload-helpers';

const GB = 1024 ** 3;
let ctx: TestCtx;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});

async function admin() {
  const a = await registerUser(ctx, 'admin');
  await ctx.prisma.user.update({ where: { id: a.user.id }, data: { role: 'ADMIN' } });
  // role is in the access token: log in again
  const r = await ctx.http().post('/auth/login').set('X-Client', 'mobile').send({ email: a.email, password: a.password }).expect(200);
  return { ...a, auth: (t: ReturnType<ReturnType<TestCtx['http']>['get']>) => t.set('Authorization', `Bearer ${r.body.accessToken}`) };
}

describe('admin', () => {
  it('non-admins are refused', async () => {
    const u = await registerUser(ctx, 'plain');
    await u.auth(ctx.http().get('/admin/overview')).expect(403);
  });

  it('overview flags a tier whose COGS exceed 60% of revenue', async () => {
    const a = await admin();
    // A 1 TB monthly subscriber storing ~900 GB: $6.99 revenue vs ~$6.11 storage -> alert.
    const heavy = await registerUser(ctx, 'heavy');
    await ctx.prisma.user.update({ where: { id: heavy.user.id }, data: { planId: 's1000', usedBytes: BigInt(900 * GB), quotaBytes: BigInt(1024 * GB) } });
    await ctx.prisma.subscription.create({
      data: { userId: heavy.user.id, provider: 'PAYME', planId: 's1000', interval: 'month', status: 'ACTIVE', currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86400_000) },
    });
    // Tier totals are global: retire 1 TB subscriptions left by earlier runs so this tier is just our heavy user.
    await ctx.prisma.subscription.updateMany({ where: { planId: 's1000', userId: { not: heavy.user.id } }, data: { status: 'EXPIRED' } });
    const o = await a.auth(ctx.http().get('/admin/overview')).expect(200);
    const tb = o.body.tiers.find((t: { planId: string }) => t.planId === 's1000');
    expect(tb.alert).toBe(true);
    expect(o.body.alerts.some((x: string) => x.startsWith('1 TB'))).toBe(true);
  });

  it('per-user storage cost and manual quota override with audit log', async () => {
    const a = await admin();
    const u = await registerUser(ctx, 'override');
    await uploadFile(ctx, u, 'x.bin', Buffer.alloc(1000));
    const list = await a.auth(ctx.http().get(`/admin/users?q=${encodeURIComponent(u.email)}`)).expect(200);
    expect(list.body.items[0]).toMatchObject({ email: u.email, usedBytes: 1000 });
    expect(typeof list.body.items[0].storageCostUsd).toBe('number');
    await a.auth(ctx.http().post(`/admin/users/${u.user.id}/quota`)).send({ quotaBytes: 20 * GB, reason: 'Support goodwill' }).expect(200);
    const me = await u.auth(ctx.http().get('/auth/me')).expect(200);
    expect(me.body.user.quotaBytes).toBe(20 * GB);
    const log = await ctx.prisma.auditLog.findFirstOrThrow({ where: { userId: u.user.id, action: 'quota.override' } });
    expect(log.actorId).toBe(a.user.id);
    await a.auth(ctx.http().post(`/admin/users/${u.user.id}/quota`)).send({ quotaBytes: null, reason: 'Back to plan' }).expect(200);
    expect((await u.auth(ctx.http().get('/auth/me'))).body.user.quotaBytes).toBe(5 * GB);
  });

  it('scenario economics endpoint uses the shared module', async () => {
    const a = await admin();
    const r = await a.auth(ctx.http().post('/admin/economics')).send(DEFAULT_SCENARIO).expect(200);
    expect(r.body.totals.revenue).toBeGreaterThan(0);
    expect(r.body.tiers).toHaveLength(DEFAULT_SCENARIO.mix.length);
  });

  it('DMCA report -> admin action revokes links and trashes the item', async () => {
    const a = await admin();
    const u = await registerUser(ctx, 'pirate');
    const f = await uploadFile(ctx, u, 'movie.mkv', Buffer.alloc(10));
    const link = await u.auth(ctx.http().post('/share-links')).send({ nodeId: f.body.id }).expect(201);
    const rep = await ctx.http().post('/public/abuse-reports').send({
      kind: 'DMCA', shareToken: link.body.token, reporterEmail: 'legal@studio.example', description: 'This link distributes our copyrighted film without permission.', goodFaith: true,
    }).expect(201);
    const reports = await a.auth(ctx.http().get('/admin/abuse-reports?status=OPEN')).expect(200);
    expect(reports.body.items.some((r: { id: string }) => r.id === rep.body.id)).toBe(true);
    await a.auth(ctx.http().post(`/admin/abuse-reports/${rep.body.id}/resolve`)).send({ action: 'ACTIONED', resolution: 'Valid notice; content disabled' }).expect(200);
    await ctx.http().get(`/public/shares/${link.body.token}`).expect(404);
    const trash = await u.auth(ctx.http().get('/trash')).expect(200);
    expect(trash.body.items[0].name).toBe('movie.mkv');
  });
});
