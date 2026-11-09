import { HttpStatus, Injectable } from '@nestjs/common';
import { AppError } from '../../common/errors';
import type { CheckoutResult, PaymentProvider } from './payment-provider';

/**
 * Click (click.uz) — prepaid UZS.
 *
 * TODO(click): not implemented in the MVP; Payme was chosen first.
 * Reason: needs a Click merchant account (service_id, merchant_id, secret_key) to test
 * against. To implement:
 *   1. createCheckout: create PaymentOrder (provider CLICK) and redirect to
 *      https://my.click.uz/services/pay?service_id=..&merchant_id=..&amount=<sum>&transaction_param=<order.number>&return_url=..
 *   2. Add POST /billing/click/prepare and /billing/click/complete (SHOP-API). Verify
 *      sign_string = md5(click_trans_id + service_id + SECRET_KEY + merchant_trans_id
 *      [+ merchant_prepare_id for complete] + amount + action + sign_time), then reuse
 *      BillingService.applyPrepaidOrder() exactly like the Payme PerformTransaction path.
 */
@Injectable()
export class ClickProvider implements PaymentProvider {
  readonly id = 'CLICK' as const;
  readonly currency = 'UZS' as const;
  readonly recurring = false;
  available() {
    return false;
  }
  async createCheckout(): Promise<CheckoutResult> {
    throw new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'PROVIDER_UNAVAILABLE', 'Click payments are coming soon. Please use Payme or a card.');
  }
}
