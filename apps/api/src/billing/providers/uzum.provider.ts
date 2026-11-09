import { HttpStatus, Injectable } from '@nestjs/common';
import { AppError } from '../../common/errors';
import type { CheckoutResult, PaymentProvider } from './payment-provider';

/**
 * Uzum Bank checkout — prepaid UZS.
 *
 * TODO(uzum): not implemented in the MVP; Payme was chosen first.
 * Reason: Uzum's merchant API docs are issued under the merchant agreement. With them:
 *   1. createCheckout: register the order with Uzum's checkout API, redirect to the returned payment URL.
 *   2. Add a webhook controller for Uzum's check/create/confirm/reverse callbacks; on confirm call
 *      BillingService.applyPrepaidOrder(), on reverse call BillingService.refundPrepaidOrder().
 */
@Injectable()
export class UzumProvider implements PaymentProvider {
  readonly id = 'UZUM' as const;
  readonly currency = 'UZS' as const;
  readonly recurring = false;
  available() {
    return false;
  }
  async createCheckout(): Promise<CheckoutResult> {
    throw new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'PROVIDER_UNAVAILABLE', 'Uzum payments are coming soon. Please use Payme or a card.');
  }
}
