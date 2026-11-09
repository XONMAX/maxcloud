import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, registerUser, type TestCtx } from './helpers';
import { uploadFile } from './upload-helpers';
import { QuotaService } from '../src/quota/quota.service';
import { MailService } from '../src/mail/mail.service';
import { MaintenanceProcessor } from '../src/jobs/maintenance.processor';
import { PrismaService } from '../src/common/prisma.service';
import { FilesService } from '../src/files/files.service';
import { UploadsService } from '../src/files/uploads.service';
import { BillingService } from '../src/billing/billing.service';
import { AccountService } from '../src/account/account.service';

const DAY = 86400_000;
let ctx: TestCtx;
let quota: QuotaService;
let maint: MaintenanceProcessor;
beforeAll(async () => {
  ctx = await createTestApp();
  quota = ctx.app.get(QuotaService);
  maint = new MaintenanceProcessor(
    ctx.app.get(PrismaService),
    ctx.app.get(FilesService),
    ctx.app.get(UploadsService),
    quota,
    ctx.app.get(BillingService),
    ctx.app.get(AccountService),
  );
});
afterAll(async () => {
  await ctx.app.close();
});

const user = (id: string) => ctx.prisma.user.findUniqueOrThrow({ where: { id } });
const mailsTo = (to: string) => ctx.app.get(MailService).outbox.filter((m) => m.to === to);

describe('quota lifecycle (end to end, real files)', () => {
  it('downgrade -> grace (old quota honoured) -> read-only -> 30/7/1-day warnings once -> purge newest -> active', async () => {
    const u = await registerUser(ctx, 'lifecycle');
    await quota.setOverride(u.user.id, 5000);
    // Oldest -> newest uploads
    const old = await uploadFile(ctx, u, 'old-photo.jpg', Buffer.alloc(1500, 1));
    await uploadFile(ctx, u, 'mid.jpg', Buffer.alloc(1000, 2));
    await uploadFile(ctx, u, 'new-1.jpg', Buffer.alloc(800, 3));
    await uploadFile(ctx, u, 'new-2.jpg', Buffer.alloc(700, 4)); // used 4000
    const trashed = await uploadFile(ctx, u, 'junk.bin', Buffer.alloc(200, 5)); // used 4200
    await u.auth(ctx.http().delete(`/files/${trashed.body.id}`)).expect(200);

    // Downgrade to 2000 bytes
    const t0 = new Date();
    await quota.setOverride(u.user.id, 2000, t0);
    let s = await user(u.user.id);
    expect(s.storageState).toBe('GRACE');
    expect(Number(s.graceQuotaBytes)).toBe(5000);
    expect(mailsTo(u.email).filter((m) => /limit/i.test(m.subject))).toHaveLength(1);

    // During grace the old 5000 quota still applies: 600 more bytes fit (4200+600=4800), 300 more don't.
    expect((await uploadFile(ctx, u, 'grace-ok.jpg', Buffer.alloc(600))).status).toBe(200);
    expect((await u.auth(ctx.http().post('/uploads')).send({ name: 'too-much', parentId: null, size: 300 })).status).toBe(413);

    // Day 7: grace over -> read-only, 30-day deletion warning
    await maint.quotaTick(new Date(t0.getTime() + 7 * DAY + 1000));
    s = await user(u.user.id);
    expect(s.storageState).toBe('READ_ONLY');
    const deletionAt = s.deletionScheduledAt!;
    expect(Math.round((deletionAt.getTime() - t0.getTime()) / DAY)).toBe(37);
    expect((await u.auth(ctx.http().post('/uploads')).send({ name: 'x', parentId: null, size: 1 })).body.code).toBe('ACCOUNT_READ_ONLY');
    await u.auth(ctx.http().get(`/files/${old.body.id}/download`)).expect(200); // still readable

    const warnings = () => mailsTo(u.email).filter((m) => /deleted|o'chiril/i.test(m.subject + m.text));
    const afterReadOnly = warnings().length;
    expect(afterReadOnly).toBe(2); // read-only notice + 30-day warning

    // Ticks are idempotent: running hourly doesn't spam.
    await maint.quotaTick(new Date(t0.getTime() + 10 * DAY));
    await maint.quotaTick(new Date(t0.getTime() + 11 * DAY));
    expect(warnings().length).toBe(afterReadOnly);

    await maint.quotaTick(new Date(deletionAt.getTime() - 6.5 * DAY));
    await maint.quotaTick(new Date(deletionAt.getTime() - 6 * DAY));
    expect(warnings().length).toBe(afterReadOnly + 1); // 7-day
    await maint.quotaTick(new Date(deletionAt.getTime() - 0.5 * DAY));
    expect(warnings().length).toBe(afterReadOnly + 2); // 1-day

    // Deadline: purge Trash first, then newest files until it fits 2000 bytes.
    const r = await maint.quotaTick(new Date(deletionAt.getTime() + 1000));
    expect(r.purged).toBeGreaterThanOrEqual(1); // the tick covers every non-ACTIVE account in the DB
    s = await user(u.user.id);
    expect(s.storageState).toBe('ACTIVE');
    expect(Number(s.usedBytes)).toBeLessThanOrEqual(2000);
    const left = await ctx.prisma.node.findMany({ where: { ownerId: u.user.id }, select: { name: true } });
    expect(left.map((n) => n.name)).toEqual(['old-photo.jpg']); // oldest survives
    expect(Number(s.usedBytes)).toBe(1500);
    expect(mailsTo(u.email).some((m) => /deleted|o'chirildi/i.test(m.subject) && /\d+ ta fayl|file\(s\)/.test(m.text))).toBe(true);
  });

  it('freeing space during read-only restores ACTIVE without deleting anything', async () => {
    const u = await registerUser(ctx, 'recover');
    await quota.setOverride(u.user.id, 3000);
    const a = await uploadFile(ctx, u, 'a.bin', Buffer.alloc(1500));
    await uploadFile(ctx, u, 'b.bin', Buffer.alloc(1000));
    const t0 = new Date();
    await quota.setOverride(u.user.id, 1200, t0);
    await maint.quotaTick(new Date(t0.getTime() + 8 * DAY));
    expect((await user(u.user.id)).storageState).toBe('READ_ONLY');
    await u.auth(ctx.http().delete(`/files/${a.body.id}`)).expect(200);
    await u.auth(ctx.http().delete(`/trash/${a.body.id}`)).expect(200);
    await maint.quotaTick(new Date(t0.getTime() + 9 * DAY));
    const s = await user(u.user.id);
    expect(s).toMatchObject({ storageState: 'ACTIVE', deletionScheduledAt: null });
    expect(Number(s.usedBytes)).toBe(1000);
  });

  it('unpaid grace expiry downgrades to the free plan', async () => {
    const u = await registerUser(ctx, 'unpaid');
    await quota.changePlan(u.user.id, 's100');
    await ctx.prisma.subscription.create({
      data: { userId: u.user.id, provider: 'PAYME', planId: 's100', interval: 'month', status: 'PAST_DUE', currentPeriodStart: new Date(), currentPeriodEnd: new Date() },
    });
    const t0 = new Date();
    await quota.paymentFailed(u.user.id, t0);
    await maint.quotaTick(new Date(t0.getTime() + 7 * DAY + 1000));
    const s = await user(u.user.id);
    expect(s).toMatchObject({ planId: 'free', storageState: 'ACTIVE' });
    expect((await ctx.prisma.subscription.findFirstOrThrow({ where: { userId: u.user.id } })).status).toBe('EXPIRED');
  });

  it('reconcile job repairs drifted counters', async () => {
    const u = await registerUser(ctx, 'drift');
    await uploadFile(ctx, u, 'f.bin', Buffer.alloc(777));
    await ctx.prisma.user.update({ where: { id: u.user.id }, data: { usedBytes: 5n, reservedBytes: 999n } });
    const r = await maint.reconcile();
    expect(r.drifted).toBeGreaterThanOrEqual(1);
    const s = await user(u.user.id);
    expect(Number(s.usedBytes)).toBe(777);
    expect(Number(s.reservedBytes)).toBe(0);
  });
});

describe('account export & deletion', () => {
  it('exports JSON and deletes after the 7-day window, freeing storage', async () => {
    const u = await registerUser(ctx, 'gdpr');
    await uploadFile(ctx, u, 'mine.txt', Buffer.from('personal'));
    const ex = await u.auth(ctx.http().get('/account/export')).expect(200);
    const data = JSON.parse(ex.text);
    expect(data.profile.email).toBe(u.email);
    expect(data.files[0].name).toBe('mine.txt');
    await u.auth(ctx.http().post('/account/delete')).expect(200);
    await u.auth(ctx.http().get('/auth/me')).expect(401); // sessions revoked
    await ctx.app.get(AccountService).purgeDeletedAccounts(new Date(Date.now() + 8 * DAY));
    const s = await user(u.user.id);
    expect(s.email).toMatch(/^deleted\+/);
    expect(await ctx.prisma.node.count({ where: { ownerId: u.user.id } })).toBe(0);
  });
});
