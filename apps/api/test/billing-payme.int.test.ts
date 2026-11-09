import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, registerUser, type TestCtx } from './helpers';
import { PAYME_TIMEOUT_MS } from '../src/billing/providers/payme.provider';
import { BillingService } from '../src/billing/billing.service';
import { MailService } from '../src/mail/mail.service';

const GB = 1024 ** 3;
let ctx: TestCtx;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});

/** Payme checkout URL = <base>/<base64 params>; base64 may itself contain '/'. */
const b64 = (url: string) => Buffer.from(url.replace(/^https:\/\/checkout\.(test\.)?paycom\.uz\//, ''), 'base64');

const AUTH = 'Basic ' + Buffer.from('Paycom:test-payme-key').toString('base64');
let rpcId = 0;
async function rpc(method: string, params: Record<string, unknown>, auth = AUTH) {
  const r = await ctx.http().post('/billing/payme').set('Authorization', auth).send({ id: ++rpcId, method, params });
  expect(r.status).toBe(200); // Payme always expects HTTP 200
  return r.body as { result?: Record<string, unknown>; error?: { code: number; message: { uz: string; ru: string; en: string } } };
}

async function newOrder(tag: string, planId = 's100', interval = 'month') {
  const u = await registerUser(ctx, tag);
  const r = await u.auth(ctx.http().post('/billing/checkout')).send({ planId, interval, provider: 'payme' }).expect(200);
  expect(r.body.url).toMatch(/^https:\/\/checkout\.(test\.)?paycom\.uz\//);
  const decoded = b64(r.body.url).toString();
  const orderNo = /ac\.order_id=(\d+)/.exec(decoded)![1];
  const amount = Number(/;a=(\d+)/.exec(decoded)![1]);
  return { u, orderNo, amount, orderId: r.body.orderId as string, decoded };
}

let txSeq = 0;
const txId = () => `payme_${Date.now()}_${++txSeq}`;

describe('Payme Merchant API', () => {
  it('checkout URL encodes merchant, order, amount in tiyin', async () => {
    const { decoded, amount } = await newOrder('url');
    expect(decoded).toContain('m=test-merchant');
    expect(amount).toBe(17_900 * 100); // 100 GB monthly = 17 900 so'm
  });

  it('rejects bad credentials with -32504 and malformed JSON with -32700', async () => {
    expect((await rpc('CheckTransaction', { id: 'x' }, 'Basic ' + Buffer.from('Paycom:wrong').toString('base64'))).error?.code).toBe(-32504);
    const r = await ctx.http().post('/billing/payme').set('Authorization', AUTH).set('Content-Type', 'application/json').send('{bad json');
    expect(r.status).toBe(200);
    expect(r.body.error.code).toBe(-32700);
    expect((await rpc('Nope', {})).error?.code).toBe(-32601);
  });

  it('CheckPerformTransaction validates order and amount', async () => {
    const { orderNo, amount } = await newOrder('check');
    expect((await rpc('CheckPerformTransaction', { amount, account: { order_id: orderNo } })).result?.allow).toBe(true);
    expect((await rpc('CheckPerformTransaction', { amount: amount - 1, account: { order_id: orderNo } })).error?.code).toBe(-31001);
    expect((await rpc('CheckPerformTransaction', { amount, account: { order_id: '999999999' } })).error?.code).toBe(-31050);
  });

  it('happy path: Create -> Perform activates plan, writes invoice; retries are idempotent', async () => {
    const { u, orderNo, amount } = await newOrder('happy');
    const id = txId();
    const c1 = await rpc('CreateTransaction', { id, time: Date.now(), amount, account: { order_id: orderNo } });
    expect(c1.result?.state).toBe(1);
    const c2 = await rpc('CreateTransaction', { id, time: Date.now(), amount, account: { order_id: orderNo } });
    expect(c2.result?.transaction).toBe(c1.result?.transaction);
    // a second Payme transaction for the same order is refused while the first is open
    expect((await rpc('CreateTransaction', { id: txId(), time: Date.now(), amount, account: { order_id: orderNo } })).error?.code).toBe(-31051);

    const p1 = await rpc('PerformTransaction', { id });
    expect(p1.result?.state).toBe(2);
    const p2 = await rpc('PerformTransaction', { id });
    expect(p2.result?.perform_time).toBe(p1.result?.perform_time);

    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: u.user.id } });
    expect(user.planId).toBe('s100');
    expect(Number(user.quotaBytes)).toBe(100 * GB);
    const inv = await ctx.prisma.invoice.findMany({ where: { userId: u.user.id } });
    expect(inv).toHaveLength(1);
    expect(inv[0]).toMatchObject({ provider: 'PAYME', amount, currency: 'UZS' });
    expect((await rpc('CheckTransaction', { id })).result).toMatchObject({ state: 2, reason: null });
    // order can't be paid twice
    expect((await rpc('CheckPerformTransaction', { amount, account: { order_id: orderNo } })).error?.code).toBe(-31052);
  });

  it('times out unperformed transactions after 12h (state -1, reason 4)', async () => {
    const { orderNo, amount } = await newOrder('timeout');
    const id = txId();
    await rpc('CreateTransaction', { id, time: Date.now(), amount, account: { order_id: orderNo } });
    await ctx.prisma.paymeTransaction.update({ where: { paymeId: id }, data: { createTime: BigInt(Date.now() - PAYME_TIMEOUT_MS - 1000) } });
    expect((await rpc('PerformTransaction', { id })).error?.code).toBe(-31008);
    expect((await rpc('CheckTransaction', { id })).result).toMatchObject({ state: -1, reason: 4 });
  });

  it('cancel before perform (-1) and refund after perform (-2) reverts the plan', async () => {
    const a = await newOrder('cancel1');
    const id1 = txId();
    await rpc('CreateTransaction', { id: id1, time: Date.now(), amount: a.amount, account: { order_id: a.orderNo } });
    expect((await rpc('CancelTransaction', { id: id1, reason: 3 })).result?.state).toBe(-1);
    expect((await rpc('PerformTransaction', { id: id1 })).error?.code).toBe(-31008);

    const b = await newOrder('cancel2');
    const id2 = txId();
    await rpc('CreateTransaction', { id: id2, time: Date.now(), amount: b.amount, account: { order_id: b.orderNo } });
    await rpc('PerformTransaction', { id: id2 });
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: b.u.user.id } })).planId).toBe('s100');
    const c = await rpc('CancelTransaction', { id: id2, reason: 5 });
    expect(c.result?.state).toBe(-2);
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: b.u.user.id } });
    expect(user.planId).toBe('free');
    expect((await ctx.prisma.invoice.findFirstOrThrow({ where: { userId: b.u.user.id } })).status).toBe('REFUNDED');
    // cancelling again just reports the state
    expect((await rpc('CancelTransaction', { id: id2, reason: 5 })).result?.state).toBe(-2);
  });

  it('GetStatement returns transactions in the window', async () => {
    const { orderNo, amount } = await newOrder('statement');
    const id = txId();
    const time = Date.now();
    await rpc('CreateTransaction', { id, time, amount, account: { order_id: orderNo } });
    const r = await rpc('GetStatement', { from: time - 1000, to: time + 1000 });
    const list = r.result?.transactions as { id: string; account: { order_id: string } }[];
    expect(list.find((t) => t.id === id)?.account.order_id).toBe(orderNo);
  });

  it('prepaid upgrade credits unused days; renewal of the same plan extends the period', async () => {
    const pay = async (o: Awaited<ReturnType<typeof newOrder>>) => {
      const id = txId();
      await rpc('CreateTransaction', { id, time: Date.now(), amount: o.amount, account: { order_id: o.orderNo } });
      await rpc('PerformTransaction', { id });
    };
    const first = await newOrder('prorate', 's100', 'month');
    await pay(first);
    const s1 = await ctx.prisma.subscription.findFirstOrThrow({ where: { userId: first.u.user.id, status: 'ACTIVE' } });

    // renew same plan: +1 month on top
    const r = await first.u.auth(ctx.http().post('/billing/checkout')).send({ planId: 's100', interval: 'month', provider: 'payme' }).expect(200);
    const renewNo = /ac\.order_id=(\d+)/.exec(b64(r.body.url).toString())![1];
    await pay({ ...first, orderNo: renewNo });
    const s2 = await ctx.prisma.subscription.findUniqueOrThrow({ where: { id: s1.id } });
    expect(s2.currentPeriodEnd.getTime() - s1.currentPeriodEnd.getTime()).toBeGreaterThan(27 * 86400_000);

    // upgrade to 500 GB: ~2 months of 100 GB credit (2*17900) buys ~22 extra days at 47 900/month
    const up = await first.u.auth(ctx.http().post('/billing/checkout')).send({ planId: 's500', interval: 'month', provider: 'payme' }).expect(200);
    const upNo = /ac\.order_id=(\d+)/.exec(b64(up.body.url).toString())![1];
    await pay({ ...first, orderNo: upNo, amount: 47_900 * 100 });
    const active = await ctx.prisma.subscription.findFirstOrThrow({ where: { userId: first.u.user.id, status: 'ACTIVE' } });
    expect(active.planId).toBe('s500');
    const days = (active.currentPeriodEnd.getTime() - Date.now()) / 86400_000;
    expect(days).toBeGreaterThan(28 + 18);
    expect(days).toBeLessThan(31 + 25);
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: first.u.user.id } })).planId).toBe('s500');
  });

  it('prepaid expiry: reminder 3 days before, then PAST_DUE + payment grace', async () => {
    const o = await newOrder('expiry');
    const id = txId();
    await rpc('CreateTransaction', { id, time: Date.now(), amount: o.amount, account: { order_id: o.orderNo } });
    await rpc('PerformTransaction', { id });
    const sub = await ctx.prisma.subscription.findFirstOrThrow({ where: { userId: o.u.user.id, status: 'ACTIVE' } });
    const billing = ctx.app.get(BillingService);
    const mail = ctx.app.get(MailService);
    const before = new Date(sub.currentPeriodEnd.getTime() - 2 * 86400_000);
    await billing.sendRenewalReminders(before);
    await billing.sendRenewalReminders(before); // no duplicate
    expect(mail.outbox.filter((m) => m.to === o.u.email && m.subject.includes('MaxCloud tarifingiz'))).toHaveLength(1);
    await billing.sendRenewalReminders(new Date(sub.currentPeriodEnd.getTime() + 1000));
    expect((await ctx.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe('PAST_DUE');
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: o.u.user.id } })).storageState).toBe('GRACE');
  });
});
