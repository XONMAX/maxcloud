import Stripe from 'stripe';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, registerUser, type TestCtx } from './helpers';
import { StripeProvider } from '../src/billing/providers/stripe.provider';
import { MailService } from '../src/mail/mail.service';

const GB = 1024 ** 3;
const SECRET = 'whsec_test_secret';
let ctx: TestCtx;
let stripe: Stripe;
const subs = new Map<string, Stripe.Subscription>();
let n = 0;
/** Unique per run: the test DB is not wiped between runs (Prisma blocks AI-driven resets). */
const RUN = Date.now().toString(36);

beforeAll(async () => {
  ctx = await createTestApp();
  await ctx.prisma.plan.update({ where: { id: 's100' }, data: { stripePriceMonthId: 'price_s100_m', stripePriceYearId: 'price_s100_y' } });
  await ctx.prisma.plan.update({ where: { id: 's500' }, data: { stripePriceMonthId: 'price_s500_m', stripePriceYearId: 'price_s500_y' } });
  await ctx.prisma.plan.update({ where: { id: 's50' }, data: { stripePriceMonthId: 'price_s50_m', stripePriceYearId: 'price_s50_y' } });
  stripe = new Stripe('sk_test_dummy');
  // Only the network calls are faked; signature verification is the real Stripe code.
  (stripe.subscriptions as unknown as { retrieve: (id: string) => Promise<Stripe.Subscription> }).retrieve = async (id: string) => subs.get(id)!;
  ctx.app.get(StripeProvider).stripe = stripe;
});
afterAll(async () => {
  await ctx.app.close();
});

function subscription(customer: string, price: string, status: Stripe.Subscription.Status = 'active', extra: Partial<Stripe.Subscription> = {}): Stripe.Subscription {
  const now = Math.floor(Date.now() / 1000);
  const s = {
    id: `sub_${RUN}_${++n}`,
    object: 'subscription',
    customer,
    status,
    cancel_at_period_end: false,
    start_date: now,
    metadata: {},
    items: { object: 'list', data: [{ id: `si_${RUN}_${n}`, price: { id: price }, current_period_start: now, current_period_end: now + 30 * 86400 }] },
    ...extra,
  } as unknown as Stripe.Subscription;
  subs.set(s.id, s);
  return s;
}

let evt = 0;
async function send(type: string, object: unknown, id = `evt_${Date.now()}_${++evt}`) {
  const payload = JSON.stringify({ id, object: 'event', type, data: { object }, api_version: '2025-08-27.basil', created: Math.floor(Date.now() / 1000) });
  const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
  return ctx.http().post('/billing/webhooks/stripe').set('Content-Type', 'application/json').set('Stripe-Signature', sig).send(payload);
}

async function customerUser(tag: string) {
  const u = await registerUser(ctx, tag);
  const cus = `cus_${tag}_${Date.now()}`;
  await ctx.prisma.user.update({ where: { id: u.user.id }, data: { stripeCustomerId: cus } });
  return { ...u, cus };
}

const dbUser = (id: string) => ctx.prisma.user.findUniqueOrThrow({ where: { id } });

beforeEach(() => ctx.app.get(MailService).outbox.splice(0));

describe('Stripe webhooks', () => {
  it('rejects an invalid signature', async () => {
    const r = await ctx.http().post('/billing/webhooks/stripe').set('Stripe-Signature', 't=1,v1=bad').set('Content-Type', 'application/json').send('{"id":"x"}');
    expect(r.status).toBe(400);
  });

  it('checkout.session.completed activates the plan and quota', async () => {
    const u = await customerUser('checkout');
    const s = subscription(u.cus, 'price_s100_m');
    const r = await send('checkout.session.completed', { id: 'cs_1', object: 'checkout.session', mode: 'subscription', subscription: s.id, customer: u.cus });
    expect(r.status).toBe(200);
    const user = await dbUser(u.user.id);
    expect(user.planId).toBe('s100');
    expect(Number(user.quotaBytes)).toBe(100 * GB);
    const billing = await u.auth(ctx.http().get('/billing')).expect(200);
    expect(billing.body.subscription).toMatchObject({ provider: 'STRIPE', planId: 's100', status: 'ACTIVE', recurring: true });
  });

  it('is idempotent: a redelivered event is processed once, invoices are not duplicated', async () => {
    const u = await customerUser('idem');
    const s = subscription(u.cus, 'price_s100_m');
    await send('customer.subscription.created', s);
    const inv = {
      id: `in_${Date.now()}`,
      object: 'invoice',
      customer: u.cus,
      amount_paid: 149,
      currency: 'usd',
      created: Math.floor(Date.now() / 1000),
      period_start: Math.floor(Date.now() / 1000),
      period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
      status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
      hosted_invoice_url: 'https://invoice.stripe.com/x',
      parent: { subscription_details: { subscription: s.id } },
      lines: { data: [{ pricing: { price_details: { price: 'price_s100_m' } }, period: { start: 1, end: 2 }, metadata: {} }] },
    };
    const first = await send('invoice.payment_succeeded', inv, `evt_same_${RUN}`);
    const again = await send('invoice.payment_succeeded', inv, `evt_same_${RUN}`);
    expect(first.body.duplicate).toBe(false);
    expect(again.body.duplicate).toBe(true);
    // Different event id, same invoice (e.g. invoice.paid + invoice.payment_succeeded): still one invoice row.
    await send('invoice.paid', inv);
    const invoices = await ctx.prisma.invoice.findMany({ where: { userId: u.user.id } });
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ amount: 149, currency: 'USD', status: 'PAID', planId: 's100' });
    expect(invoices[0].number).toMatch(/^MC-\d{4}-\d{6}$/);
    const pdf = await u.auth(ctx.http().get(`/billing/invoices/${invoices[0].id}/pdf`)).expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.body.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('upgrade via subscription.updated raises the quota immediately', async () => {
    const u = await customerUser('upgrade');
    const s = subscription(u.cus, 'price_s100_m');
    await send('customer.subscription.created', s);
    await send('customer.subscription.updated', { ...s, items: { data: [{ ...s.items.data[0], price: { id: 'price_s500_m' } }] } });
    expect(Number((await dbUser(u.user.id)).quotaBytes)).toBe(500 * GB);
  });

  it('payment failure -> 7-day grace + email; payment success -> back to ACTIVE', async () => {
    const u = await customerUser('dunning');
    const s = subscription(u.cus, 'price_s100_m');
    await send('customer.subscription.created', s);
    const inv = { id: `in_f_${Date.now()}`, object: 'invoice', customer: u.cus, parent: { subscription_details: { subscription: s.id } } };
    await send('invoice.payment_failed', inv);
    let user = await dbUser(u.user.id);
    expect(user).toMatchObject({ storageState: 'GRACE', graceReason: 'PAYMENT_FAILED', planId: 's100' });
    expect(Number(user.graceQuotaBytes)).toBe(100 * GB);
    expect(ctx.app.get(MailService).outbox.some((m) => m.to === u.email && /payment|to'lov/i.test(m.subject))).toBe(true);
    expect((await ctx.prisma.subscription.findFirstOrThrow({ where: { providerSubscriptionId: s.id } })).status).toBe('PAST_DUE');

    await send('invoice.payment_succeeded', {
      ...inv,
      id: `in_ok_${Date.now()}`,
      amount_paid: 149,
      currency: 'usd',
      created: Math.floor(Date.now() / 1000),
      period_start: 1,
      period_end: 2,
      lines: { data: [{ pricing: { price_details: { price: 'price_s100_m' } }, period: { start: 1, end: 2 } }] },
    });
    user = await dbUser(u.user.id);
    expect(user.storageState).toBe('ACTIVE');
    expect((await ctx.prisma.subscription.findFirstOrThrow({ where: { providerSubscriptionId: s.id } })).status).toBe('ACTIVE');
  });

  it('downgrade below usage starts grace honouring the old quota; deletion falls back to free', async () => {
    const u = await customerUser('downgrade');
    const s = subscription(u.cus, 'price_s100_m');
    await send('customer.subscription.created', s);
    await ctx.prisma.user.update({ where: { id: u.user.id }, data: { usedBytes: BigInt(80 * GB) } });
    await send('customer.subscription.updated', { ...s, items: { data: [{ ...s.items.data[0], price: { id: 'price_s50_m' } }] } });
    let user = await dbUser(u.user.id);
    expect(user).toMatchObject({ planId: 's50', storageState: 'GRACE', graceReason: 'PLAN_DOWNGRADE' });
    expect(Number(user.graceQuotaBytes)).toBe(100 * GB);

    await send('customer.subscription.deleted', { ...s, status: 'canceled' });
    user = await dbUser(u.user.id);
    expect(user.planId).toBe('free');
    expect(user.storageState).toBe('GRACE'); // clock not restarted
  });

  it('a processing failure returns 500 (Stripe retries) and the retry succeeds once data exists', async () => {
    const s = subscription(`cus_unknown_${RUN}`, 'price_s100_m');
    const id = `evt_retry_${Date.now()}`;
    const r1 = await send('customer.subscription.created', s, id);
    expect(r1.status).toBe(500);
    const row = await ctx.prisma.webhookEvent.findFirstOrThrow({ where: { eventId: id } });
    expect(row.processedAt).toBeNull();
    expect(row.error).toMatch(/No user/);
    const u = await registerUser(ctx, 'late');
    await ctx.prisma.user.update({ where: { id: u.user.id }, data: { stripeCustomerId: `cus_unknown_${RUN}` } });
    const r2 = await send('customer.subscription.created', s, id);
    expect(r2.status).toBe(200);
    expect((await dbUser(u.user.id)).planId).toBe('s100');
  });

  it('checkout and plan change guard rails', async () => {
    const u = await customerUser('rails');
    const s = subscription(u.cus, 'price_s100_m');
    await send('customer.subscription.created', s);
    const r = await u.auth(ctx.http().post('/billing/checkout')).send({ planId: 's500', interval: 'month', provider: 'stripe' }).expect(409);
    expect(r.body.message).toMatch(/Change plan/);
    await u.auth(ctx.http().post('/billing/checkout')).send({ planId: 's500', interval: 'month', provider: 'click' }).expect(503);
  });
});
