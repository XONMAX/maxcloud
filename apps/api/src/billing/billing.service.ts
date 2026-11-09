import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Prisma, type PaymentProviderId, type Subscription } from '@prisma/client';
import type Stripe from 'stripe';
import { FREE_PLAN_ID, PLANS, formatMoney, getPlan, priceFor, type BillingInterval, type PlanId } from '@maxcloud/shared';
import { PrismaService } from '../common/prisma.service';
import { AppError, Errors } from '../common/errors';
import { webhookEvents } from '../common/metrics';
import { config } from '../config';
import { MailService } from '../mail/mail.service';
import { QuotaService } from '../quota/quota.service';
import { ClickProvider } from './providers/click.provider';
import { PaymeProvider } from './providers/payme.provider';
import { StripeProvider } from './providers/stripe.provider';
import { UzumProvider } from './providers/uzum.provider';
import type { PaymentProvider } from './providers/payment-provider';

type Tx = Prisma.TransactionClient;
const DAY = 86400_000;

export function addInterval(from: Date, interval: BillingInterval, times = 1): Date {
  const d = new Date(from);
  if (interval === 'month') d.setUTCMonth(d.getUTCMonth() + times);
  else d.setUTCFullYear(d.getUTCFullYear() + times);
  return d;
}

/** Daily value of a plan in tiyin, used to prorate prepaid upgrades. */
function dailyValue(planId: string, interval: BillingInterval) {
  return priceFor(planId as PlanId, interval, 'UZS') / (interval === 'month' ? 30 : 365);
}

/** Stripe API versions moved period fields onto items (2025-03 "basil"); read both shapes. */
function subPeriod(sub: Stripe.Subscription) {
  const item = sub.items?.data?.[0] as (Stripe.SubscriptionItem & { current_period_start?: number; current_period_end?: number }) | undefined;
  const legacy = sub as unknown as { current_period_start?: number; current_period_end?: number };
  const start = item?.current_period_start ?? legacy.current_period_start ?? sub.start_date;
  const end = item?.current_period_end ?? legacy.current_period_end ?? sub.start_date;
  return { start: new Date(start * 1000), end: new Date(end * 1000) };
}

function invoiceSubscriptionId(inv: Stripe.Invoice): string | null {
  const parent = (inv as unknown as { parent?: { subscription_details?: { subscription?: string | { id: string } } } }).parent;
  const s = parent?.subscription_details?.subscription ?? (inv as unknown as { subscription?: string | { id: string } }).subscription;
  if (!s) return null;
  return typeof s === 'string' ? s : s.id;
}

@Injectable()
export class BillingService {
  private log = new Logger(BillingService.name);
  private providers: Record<string, PaymentProvider>;

  constructor(
    private prisma: PrismaService,
    private quota: QuotaService,
    private mail: MailService,
    readonly stripe: StripeProvider,
    payme: PaymeProvider,
    click: ClickProvider,
    uzum: UzumProvider,
  ) {
    this.providers = { stripe, payme, click, uzum };
  }

  // ---------------- read models ----------------
  async plans() {
    const plans = await this.prisma.plan.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' } });
    return {
      plans: plans.map((p) => ({
        id: p.id,
        name: p.name,
        quotaBytes: Number(p.quotaBytes),
        prices: { month: { USD: p.priceUsdMonth, UZS: p.priceUzsMonth }, year: { USD: p.priceUsdYear, UZS: p.priceUzsYear } },
      })),
      providers: Object.entries(this.providers).map(([id, p]) => ({ id, currency: p.currency, recurring: p.recurring, available: p.available() })),
    };
  }

  async activeSubscription(userId: string, db: Tx = this.prisma) {
    return db.subscription.findFirst({ where: { userId, status: { in: ['ACTIVE', 'PAST_DUE'] } }, orderBy: { currentPeriodEnd: 'desc' } });
  }

  async status(userId: string) {
    const [user, sub, invoices] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: userId } }),
      this.activeSubscription(userId),
      this.prisma.invoice.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 50 }),
    ]);
    return {
      planId: user.planId,
      subscription: sub && {
        id: sub.id,
        provider: sub.provider,
        planId: sub.planId,
        interval: sub.interval,
        status: sub.status,
        currentPeriodEnd: sub.currentPeriodEnd.toISOString(),
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        recurring: sub.provider === 'STRIPE',
      },
      invoices: invoices.map((i) => ({
        id: i.id,
        number: i.number,
        amount: i.amount,
        currency: i.currency,
        display: formatMoney(i.amount, i.currency as 'USD' | 'UZS'),
        status: i.status,
        planId: i.planId,
        periodStart: i.periodStart.toISOString(),
        periodEnd: i.periodEnd.toISOString(),
        paidAt: i.paidAt?.toISOString() ?? null,
        hostedUrl: i.hostedUrl,
      })),
    };
  }

  // ---------------- checkout & plan changes ----------------
  async checkout(userId: string, planId: Exclude<PlanId, 'free'>, interval: BillingInterval, providerKey: string) {
    const provider = this.providers[providerKey];
    if (!provider) throw Errors.bad('Unknown payment provider');
    if (!provider.available()) throw new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'PROVIDER_UNAVAILABLE', `${provider.id} is not available yet`);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const sub = await this.activeSubscription(userId);
    if (sub?.provider === 'STRIPE' && provider.id === 'STRIPE') throw Errors.conflict('You already have a card subscription. Change plan instead.');
    if (sub?.provider === 'STRIPE' && provider.id !== 'STRIPE') throw Errors.conflict('Cancel your card subscription before paying with a local method.');
    if (sub && sub.provider !== 'STRIPE' && provider.id === 'STRIPE') throw Errors.conflict('Your prepaid plan is active. You can switch to card billing when it ends.');
    return provider.createCheckout({ user, planId, interval, returnUrl: `${config().WEB_ORIGIN}/billing` });
  }

  async changePlan(userId: string, planId: PlanId, interval: BillingInterval) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const sub = await this.activeSubscription(userId);
    if (!sub) {
      if (planId === FREE_PLAN_ID) return { ok: true };
      throw Errors.bad('No active subscription. Choose a plan to check out.');
    }
    if (planId === FREE_PLAN_ID) {
      // Cancel at period end: keep what they paid for.
      if (sub.provider === 'STRIPE' && sub.providerSubscriptionId) await this.stripe.cancelAtPeriodEnd(sub.providerSubscriptionId);
      await this.prisma.subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: true } });
      return { ok: true, effectiveAt: sub.currentPeriodEnd.toISOString() };
    }
    if (sub.provider !== 'STRIPE') throw Errors.bad('Prepaid plans change by buying a new plan; unused days are credited automatically.');
    const isUpgrade = getPlan(planId).quotaBytes > getPlan(user.planId).quotaBytes || (planId === user.planId && interval === 'year');
    const updated = await this.stripe.changeSubscription(sub.providerSubscriptionId!, planId, interval, isUpgrade);
    await this.syncStripeSubscription(updated);
    return { ok: true };
  }

  portal(userId: string) {
    return this.stripe.portal(userId, `${config().WEB_ORIGIN}/billing`);
  }

  // ---------------- prepaid (Payme / Click / Uzum) ----------------
  /**
   * Called inside the gateway's "perform" transaction. Extends or starts the
   * user's prepaid period. Upgrades convert the unused value of the old plan
   * into extra days on the new one (proration for prepaid).
   */
  async applyPrepaidOrder(orderId: string, db: Tx) {
    const order = await db.paymentOrder.findUniqueOrThrow({ where: { id: orderId } });
    if (order.status === 'PAID') return;
    const now = new Date();
    const current = await this.activeSubscription(order.userId, db);
    let start = now;
    let end = addInterval(now, order.interval);

    if (current && current.provider !== 'STRIPE') {
      if (current.planId === order.planId && current.interval === order.interval) {
        start = current.currentPeriodEnd > now ? current.currentPeriodStart : now;
        end = addInterval(current.currentPeriodEnd > now ? current.currentPeriodEnd : now, order.interval);
      } else {
        const remainingDays = Math.max(0, (current.currentPeriodEnd.getTime() - now.getTime()) / DAY);
        const credit = remainingDays * dailyValue(current.planId, current.interval);
        const extraDays = credit / dailyValue(order.planId, order.interval);
        end = new Date(addInterval(now, order.interval).getTime() + Math.floor(extraDays) * DAY);
      }
      await db.subscription.update({ where: { id: current.id }, data: { status: current.planId === order.planId && current.interval === order.interval ? 'ACTIVE' : 'CANCELED' } });
    }

    if (current && current.provider !== 'STRIPE' && current.planId === order.planId && current.interval === order.interval) {
      await db.subscription.update({ where: { id: current.id }, data: { currentPeriodStart: start, currentPeriodEnd: end, status: 'ACTIVE', cancelAtPeriodEnd: false } });
    } else {
      await db.subscription.create({
        data: { userId: order.userId, provider: order.provider, planId: order.planId, interval: order.interval, status: 'ACTIVE', currentPeriodStart: start, currentPeriodEnd: end },
      });
    }
    await db.paymentOrder.update({ where: { id: order.id }, data: { status: 'PAID', paidAt: now } });
    await this.createInvoice(db, {
      userId: order.userId,
      provider: order.provider,
      providerInvoiceId: `order:${order.id}`,
      amount: order.amount,
      currency: order.currency,
      planId: order.planId,
      interval: order.interval,
      periodStart: start,
      periodEnd: end,
      paidAt: now,
    });
  }

  /** Gateway refund after perform: void the period bought by this order. */
  async refundPrepaidOrder(orderId: string, db: Tx) {
    const order = await db.paymentOrder.findUniqueOrThrow({ where: { id: orderId } });
    if (order.status !== 'PAID') return;
    await db.paymentOrder.update({ where: { id: order.id }, data: { status: 'REFUNDED' } });
    await db.invoice.updateMany({ where: { providerInvoiceId: `order:${order.id}` }, data: { status: 'REFUNDED' } });
    const sub = await this.activeSubscription(order.userId, db);
    if (sub && sub.provider === order.provider && sub.planId === order.planId) {
      const shortened = addInterval(sub.currentPeriodEnd, order.interval, -1);
      const ended = shortened.getTime() <= Date.now();
      await db.subscription.update({ where: { id: sub.id }, data: ended ? { status: 'CANCELED', currentPeriodEnd: new Date() } : { currentPeriodEnd: shortened } });
    }
  }

  /** After a prepaid order changes state, align the user's plan + quota. */
  async afterPrepaidApplied(orderId: string) {
    const order = await this.prisma.paymentOrder.findUniqueOrThrow({ where: { id: orderId } });
    await this.syncUserPlan(order.userId);
  }

  /** Effective plan = active subscription's plan, else free. Applies quota rules. */
  async syncUserPlan(userId: string) {
    const sub = await this.activeSubscription(userId);
    const planId = sub && sub.status === 'ACTIVE' ? sub.planId : sub?.status === 'PAST_DUE' ? sub.planId : FREE_PLAN_ID;
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.planId !== planId) await this.quota.changePlan(userId, planId);
    if (sub?.status === 'ACTIVE') await this.quota.paymentRecovered(userId);
  }

  /** Daily: remind prepaid users 3 days before expiry; lapse expired periods into payment grace. */
  async sendRenewalReminders(now = new Date()) {
    let sent = 0;
    const soon = await this.prisma.subscription.findMany({
      where: { provider: { not: 'STRIPE' }, status: 'ACTIVE', cancelAtPeriodEnd: false, currentPeriodEnd: { gt: now, lte: new Date(now.getTime() + 3 * DAY) } },
      include: { user: true },
    });
    for (const s of soon) {
      const key = `renewal:${s.id}:${s.currentPeriodEnd.toISOString()}`;
      const created = await this.prisma.quotaNotice
        .create({ data: { userId: s.userId, kind: 'RENEWAL_REMINDER', cycleKey: key } })
        .then(() => true)
        .catch(() => false);
      if (!created) continue;
      await this.mail.send(s.user.email, 'renewal_reminder', s.user.locale, {
        plan: getPlan(s.planId).name,
        date: s.currentPeriodEnd.toISOString().slice(0, 10),
        url: `${config().WEB_ORIGIN}/billing`,
      });
      sent++;
    }
    const lapsed = await this.prisma.subscription.findMany({ where: { provider: { not: 'STRIPE' }, status: 'ACTIVE', currentPeriodEnd: { lte: now } } });
    for (const s of lapsed) {
      if (s.cancelAtPeriodEnd) {
        await this.prisma.subscription.update({ where: { id: s.id }, data: { status: 'CANCELED' } });
        await this.syncUserPlan(s.userId);
      } else {
        // Non-payment: 7-day grace at the current quota, then the quota engine downgrades to free.
        await this.prisma.subscription.update({ where: { id: s.id }, data: { status: 'PAST_DUE' } });
        await this.quota.paymentFailed(s.userId, now);
      }
    }
    return sent;
  }

  // ---------------- Stripe webhooks ----------------
  /**
   * Verify, de-duplicate and process a Stripe event. Returns false when the
   * event was already processed. Throws on processing failure so Stripe retries.
   */
  async handleStripeWebhook(rawBody: Buffer, signature: string | undefined): Promise<boolean> {
    const secret = config().STRIPE_WEBHOOK_SECRET;
    if (!secret || !signature) throw Errors.bad('Missing webhook signature');
    let event: Stripe.Event;
    try {
      event = this.stripe.stripe.webhooks.constructEvent(rawBody, signature, secret);
    } catch {
      webhookEvents.inc({ provider: 'stripe', type: 'unknown', result: 'bad_signature' });
      throw Errors.bad('Invalid webhook signature');
    }
    return this.processStripeEvent(event);
  }

  async processStripeEvent(event: Stripe.Event): Promise<boolean> {
    const existing = await this.prisma.webhookEvent.findUnique({ where: { provider_eventId: { provider: 'stripe', eventId: event.id } } });
    if (existing?.processedAt) {
      webhookEvents.inc({ provider: 'stripe', type: event.type, result: 'duplicate' });
      return false;
    }
    if (!existing) {
      await this.prisma.webhookEvent.create({ data: { provider: 'stripe', eventId: event.id, type: event.type } }).catch((e) => {
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
      });
    }
    try {
      await this.dispatchStripe(event);
      await this.prisma.webhookEvent.update({ where: { provider_eventId: { provider: 'stripe', eventId: event.id } }, data: { processedAt: new Date(), error: null } });
      webhookEvents.inc({ provider: 'stripe', type: event.type, result: 'ok' });
      return true;
    } catch (e) {
      await this.prisma.webhookEvent.update({ where: { provider_eventId: { provider: 'stripe', eventId: event.id } }, data: { error: String((e as Error).message).slice(0, 1000) } });
      webhookEvents.inc({ provider: 'stripe', type: event.type, result: 'error' });
      throw e;
    }
  }

  private async dispatchStripe(event: Stripe.Event) {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object as Stripe.Checkout.Session;
        if (s.mode === 'subscription' && s.subscription) {
          const subId = typeof s.subscription === 'string' ? s.subscription : s.subscription.id;
          await this.syncStripeSubscription(await this.stripe.stripe.subscriptions.retrieve(subId));
        }
        return;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        return this.syncStripeSubscription(event.data.object as Stripe.Subscription);
      case 'invoice.payment_succeeded':
      case 'invoice.paid':
        return this.stripeInvoicePaid(event.data.object as Stripe.Invoice);
      case 'invoice.payment_failed':
        return this.stripeInvoiceFailed(event.data.object as Stripe.Invoice);
      default:
        this.log.debug(`ignoring stripe event ${event.type}`);
    }
  }

  private async userForStripe(customer: string | Stripe.Customer | Stripe.DeletedCustomer | null, metadataUserId?: string) {
    const customerId = typeof customer === 'string' ? customer : customer?.id;
    const user =
      (customerId ? await this.prisma.user.findUnique({ where: { stripeCustomerId: customerId } }) : null) ??
      (metadataUserId ? await this.prisma.user.findUnique({ where: { id: metadataUserId } }) : null);
    if (!user) throw new Error(`No user for Stripe customer ${customerId}`);
    if (customerId && !user.stripeCustomerId) await this.prisma.user.update({ where: { id: user.id }, data: { stripeCustomerId: customerId } });
    return user;
  }

  /** Map a Stripe price id back to our plan + interval. */
  private async planForPrice(priceId: string | undefined, metadata: Stripe.Metadata) {
    if (priceId) {
      const p = await this.prisma.plan.findFirst({ where: { OR: [{ stripePriceMonthId: priceId }, { stripePriceYearId: priceId }] } });
      if (p) return { planId: p.id, interval: (p.stripePriceMonthId === priceId ? 'month' : 'year') as BillingInterval };
    }
    if (metadata.planId && PLANS.some((p) => p.id === metadata.planId)) return { planId: metadata.planId, interval: (metadata.interval === 'year' ? 'year' : 'month') as BillingInterval };
    throw new Error(`Unknown Stripe price ${priceId}`);
  }

  async syncStripeSubscription(sub: Stripe.Subscription) {
    const user = await this.userForStripe(sub.customer, sub.metadata?.userId);
    const { planId, interval } = await this.planForPrice(sub.items?.data?.[0]?.price?.id, sub.metadata ?? {});
    const { start, end } = subPeriod(sub);
    const status: Subscription['status'] | null =
      sub.status === 'active' || sub.status === 'trialing'
        ? 'ACTIVE'
        : sub.status === 'past_due' || sub.status === 'unpaid'
          ? 'PAST_DUE'
          : sub.status === 'canceled' || sub.status === 'incomplete_expired'
            ? 'CANCELED'
            : null; // incomplete / paused: wait for the next event
    if (!status) return;
    await this.prisma.subscription.upsert({
      where: { providerSubscriptionId: sub.id },
      create: { userId: user.id, provider: 'STRIPE', providerSubscriptionId: sub.id, planId, interval, status, currentPeriodStart: start, currentPeriodEnd: end, cancelAtPeriodEnd: sub.cancel_at_period_end },
      update: { planId, interval, status, currentPeriodStart: start, currentPeriodEnd: end, cancelAtPeriodEnd: sub.cancel_at_period_end },
    });
    if (status === 'CANCELED') {
      const other = await this.activeSubscription(user.id);
      await this.quota.changePlan(user.id, other?.planId ?? FREE_PLAN_ID, 'PLAN_DOWNGRADE');
    } else if (status === 'ACTIVE') {
      if (user.planId !== planId) await this.quota.changePlan(user.id, planId, 'PLAN_DOWNGRADE');
      await this.quota.paymentRecovered(user.id);
    }
    // PAST_DUE: quota handled by invoice.payment_failed (grace), plan stays.
  }

  private async stripeInvoicePaid(inv: Stripe.Invoice) {
    const user = await this.userForStripe(inv.customer, undefined);
    const line = inv.lines?.data?.[0] as (Stripe.InvoiceLineItem & { price?: { id: string }; pricing?: { price_details?: { price?: string } } }) | undefined;
    const priceId = line?.pricing?.price_details?.price ?? line?.price?.id;
    const { planId, interval } = await this.planForPrice(priceId, (line?.metadata as Stripe.Metadata) ?? {}).catch(() => ({ planId: user.planId, interval: 'month' as const }));
    await this.createInvoice(this.prisma, {
      userId: user.id,
      provider: 'STRIPE',
      providerInvoiceId: inv.id!,
      amount: inv.amount_paid,
      currency: (inv.currency ?? 'usd').toUpperCase(),
      planId,
      interval,
      periodStart: new Date((line?.period?.start ?? inv.period_start) * 1000),
      periodEnd: new Date((line?.period?.end ?? inv.period_end) * 1000),
      paidAt: new Date((inv.status_transitions?.paid_at ?? inv.created) * 1000),
      hostedUrl: inv.hosted_invoice_url ?? null,
    });
    const subId = invoiceSubscriptionId(inv);
    if (subId) await this.prisma.subscription.updateMany({ where: { providerSubscriptionId: subId, status: 'PAST_DUE' }, data: { status: 'ACTIVE' } });
    await this.quota.paymentRecovered(user.id);
  }

  private async stripeInvoiceFailed(inv: Stripe.Invoice) {
    const user = await this.userForStripe(inv.customer, undefined);
    const subId = invoiceSubscriptionId(inv);
    if (subId) await this.prisma.subscription.updateMany({ where: { providerSubscriptionId: subId }, data: { status: 'PAST_DUE' } });
    await this.quota.paymentFailed(user.id);
    const fresh = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    await this.mail.send(user.email, 'payment_failed', user.locale, {
      plan: getPlan(user.planId).name,
      date: (fresh.graceEndsAt ?? new Date()).toISOString().slice(0, 10),
      url: `${config().WEB_ORIGIN}/billing`,
    });
  }

  // ---------------- invoices ----------------
  async createInvoice(
    db: Tx,
    data: {
      userId: string;
      provider: PaymentProviderId;
      providerInvoiceId: string;
      amount: number;
      currency: string;
      planId: string;
      interval: BillingInterval;
      periodStart: Date;
      periodEnd: Date;
      paidAt: Date;
      hostedUrl?: string | null;
    },
  ) {
    const exists = await db.invoice.findUnique({ where: { providerInvoiceId: data.providerInvoiceId } });
    if (exists) return exists;
    const [{ n }] = await db.$queryRaw<{ n: bigint }[]>`SELECT nextval('"InvoiceNumberSeq"') AS n`;
    const number = `MC-${data.paidAt.getUTCFullYear()}-${String(n).padStart(6, '0')}`;
    return db.invoice.create({ data: { ...data, number, status: 'PAID' } });
  }
}
