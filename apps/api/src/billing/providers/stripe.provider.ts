import { HttpStatus, Injectable } from '@nestjs/common';
import Stripe from 'stripe';
import { PrismaService } from '../../common/prisma.service';
import { AppError } from '../../common/errors';
import { config } from '../../config';
import type { CheckoutRequest, CheckoutResult, PaymentProvider } from './payment-provider';

/**
 * Stripe Billing (USD, international cards). Note: Stripe does not onboard
 * Uzbekistan-registered businesses; this requires a foreign entity (see docs/BUSINESS_NOTES.md).
 */
@Injectable()
export class StripeProvider implements PaymentProvider {
  readonly id = 'STRIPE' as const;
  readonly currency = 'USD' as const;
  readonly recurring = true;
  private client: Stripe | null = null;

  constructor(private prisma: PrismaService) {}

  available() {
    return !!config().STRIPE_SECRET_KEY;
  }

  /** Lazily constructed so the app boots without Stripe keys. Tests replace it. */
  get stripe(): Stripe {
    if (!this.client) {
      const key = config().STRIPE_SECRET_KEY;
      if (!key) throw new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'PROVIDER_UNAVAILABLE', 'Card payments are not configured');
      this.client = new Stripe(key, { maxNetworkRetries: 2, appInfo: { name: 'MaxCloud' } });
    }
    return this.client;
  }
  set stripe(s: Stripe) {
    this.client = s;
  }

  async customerFor(userId: string): Promise<string> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.stripeCustomerId) return user.stripeCustomerId;
    const c = await this.stripe.customers.create({ email: user.email, name: user.name, metadata: { userId: user.id } }, { idempotencyKey: `customer-${user.id}` });
    await this.prisma.user.update({ where: { id: user.id }, data: { stripeCustomerId: c.id } });
    return c.id;
  }

  async priceId(planId: string, interval: 'month' | 'year') {
    const plan = await this.prisma.plan.findUniqueOrThrow({ where: { id: planId } });
    const price = interval === 'month' ? plan.stripePriceMonthId : plan.stripePriceYearId;
    if (!price) throw new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'PROVIDER_UNAVAILABLE', `No Stripe price configured for ${planId}/${interval} (run scripts/stripe-setup.ts)`);
    return price;
  }

  async createCheckout(req: CheckoutRequest): Promise<CheckoutResult> {
    const customer = await this.customerFor(req.user.id);
    const metadata = { userId: req.user.id, planId: req.planId, interval: req.interval };
    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      customer,
      client_reference_id: req.user.id,
      line_items: [{ price: await this.priceId(req.planId, req.interval), quantity: 1 }],
      success_url: `${req.returnUrl}?status=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.returnUrl}?status=cancelled`,
      allow_promotion_codes: true,
      automatic_tax: { enabled: false },
      subscription_data: { metadata },
      metadata,
    });
    if (!session.url) throw new Error('Stripe returned no checkout URL');
    return { url: session.url };
  }

  async portal(userId: string, returnUrl: string) {
    const customer = await this.customerFor(userId);
    const s = await this.stripe.billingPortal.sessions.create({ customer, return_url: returnUrl });
    return { url: s.url };
  }

  /**
   * Change an existing subscription's price.
   * Upgrade: charge the prorated difference immediately ('always_invoice').
   * Downgrade: credit the unused time to the next invoice ('create_prorations').
   */
  async changeSubscription(subscriptionId: string, planId: string, interval: 'month' | 'year', isUpgrade: boolean) {
    const sub = await this.stripe.subscriptions.retrieve(subscriptionId);
    const item = sub.items.data[0];
    return this.stripe.subscriptions.update(subscriptionId, {
      items: [{ id: item.id, price: await this.priceId(planId, interval) }],
      proration_behavior: isUpgrade ? 'always_invoice' : 'create_prorations',
      payment_behavior: isUpgrade ? 'error_if_incomplete' : 'allow_incomplete',
      cancel_at_period_end: false,
      metadata: { ...sub.metadata, planId, interval },
    });
  }

  cancelAtPeriodEnd(subscriptionId: string) {
    return this.stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
  }
}
