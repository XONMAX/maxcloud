import type { BillingInterval, PlanId } from '@maxcloud/shared';
import type { PaymentProviderId, Prisma, User } from '@prisma/client';

export interface CheckoutRequest {
  user: User;
  planId: Exclude<PlanId, 'free'>;
  interval: BillingInterval;
  returnUrl: string;
}

export interface CheckoutResult {
  /** Where to send the browser (hosted checkout page). */
  url: string;
  /** Local order id for prepaid gateways. */
  orderId?: string;
}

/**
 * Every gateway sits behind this interface. Two families:
 *  - recurring (Stripe): the gateway owns the subscription and renews it; we mirror it via webhooks.
 *  - prepaid (Payme, Click, Uzum): the user buys a month or a year; we own the period and send
 *    renewal reminders. Uzbek card rails (Uzcard/Humo) don't support merchant-initiated
 *    recurring charges without a separate card-token agreement, so prepaid is the safe default.
 */
export interface PaymentProvider {
  readonly id: PaymentProviderId;
  readonly currency: 'USD' | 'UZS';
  readonly recurring: boolean;
  /** Configured with credentials? */
  available(): boolean;
  createCheckout(req: CheckoutRequest): Promise<CheckoutResult>;
}

/**
 * What prepaid gateways need from billing. Injected by token (implemented by
 * BillingService) so providers don't import BillingService (circular import).
 */
export const PREPAID_LEDGER = Symbol('PREPAID_LEDGER');
export interface PrepaidLedger {
  applyPrepaidOrder(orderId: string, db: Prisma.TransactionClient): Promise<void>;
  refundPrepaidOrder(orderId: string, db: Prisma.TransactionClient): Promise<void>;
  afterPrepaidApplied(orderId: string): Promise<void>;
}
