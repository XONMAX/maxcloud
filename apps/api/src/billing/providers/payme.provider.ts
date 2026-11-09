import { HttpStatus, Injectable, Logger, forwardRef, Inject } from '@nestjs/common';
import { priceFor } from '@maxcloud/shared';
import type { PaymentOrder, PaymeTransaction } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { AppError } from '../../common/errors';
import { safeEqual } from '../../common/crypto';
import { config } from '../../config';
import { BillingService } from '../billing.service';
import type { CheckoutRequest, CheckoutResult, PaymentProvider } from './payment-provider';

/** Payme Merchant API error codes (https://developer.help.paycom.uz). */
export const PaymeErr = {
  AUTH: -32504,
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  WRONG_AMOUNT: -31001,
  TX_NOT_FOUND: -31003,
  CANNOT_CANCEL: -31007,
  CANNOT_PERFORM: -31008,
  ORDER_NOT_FOUND: -31050,
  ORDER_BUSY: -31051,
  ORDER_NOT_PAYABLE: -31052,
  INTERNAL: -32400,
} as const;

const MESSAGES: Record<number, { uz: string; ru: string; en: string }> = {
  [PaymeErr.AUTH]: { uz: 'Ruxsat yo\'q', ru: 'Недостаточно привилегий', en: 'Insufficient privileges' },
  [PaymeErr.PARSE]: { uz: 'JSON xato', ru: 'Ошибка парсинга JSON', en: 'Parse error' },
  [PaymeErr.INVALID_REQUEST]: { uz: 'Noto\'g\'ri so\'rov', ru: 'Неверный запрос', en: 'Invalid request' },
  [PaymeErr.METHOD_NOT_FOUND]: { uz: 'Metod topilmadi', ru: 'Метод не найден', en: 'Method not found' },
  [PaymeErr.WRONG_AMOUNT]: { uz: 'Noto\'g\'ri summa', ru: 'Неверная сумма', en: 'Wrong amount' },
  [PaymeErr.TX_NOT_FOUND]: { uz: 'Tranzaksiya topilmadi', ru: 'Транзакция не найдена', en: 'Transaction not found' },
  [PaymeErr.CANNOT_CANCEL]: { uz: 'Bekor qilib bo\'lmaydi', ru: 'Невозможно отменить', en: 'Cannot cancel' },
  [PaymeErr.CANNOT_PERFORM]: { uz: 'Bajarib bo\'lmaydi', ru: 'Невозможно выполнить операцию', en: 'Cannot perform operation' },
  [PaymeErr.ORDER_NOT_FOUND]: { uz: 'Buyurtma topilmadi', ru: 'Заказ не найден', en: 'Order not found' },
  [PaymeErr.ORDER_BUSY]: { uz: 'Buyurtma to\'lanmoqda', ru: 'Заказ ожидает оплаты', en: 'Order is being paid' },
  [PaymeErr.ORDER_NOT_PAYABLE]: { uz: 'Buyurtmani to\'lab bo\'lmaydi', ru: 'Заказ нельзя оплатить', en: 'Order cannot be paid' },
  [PaymeErr.INTERNAL]: { uz: 'Ichki xato', ru: 'Внутренняя ошибка', en: 'Internal error' },
};

export class PaymeError extends Error {
  constructor(public code: number, public data?: string) {
    super(MESSAGES[code]?.en ?? 'Error');
  }
}

/** Created transactions not performed within 12 hours are cancelled (reason 4 = timeout). */
export const PAYME_TIMEOUT_MS = 12 * 3600_000;

interface RpcRequest {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

@Injectable()
export class PaymeProvider implements PaymentProvider {
  private log = new Logger(PaymeProvider.name);
  readonly id = 'PAYME' as const;
  readonly currency = 'UZS' as const;
  readonly recurring = false;

  constructor(private prisma: PrismaService, @Inject(forwardRef(() => BillingService)) private billing: BillingService) {}

  available() {
    return !!config().PAYME_MERCHANT_ID && !!config().PAYME_KEY;
  }

  async createCheckout(req: CheckoutRequest): Promise<CheckoutResult> {
    const c = config();
    if (!this.available()) throw new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'PROVIDER_UNAVAILABLE', 'Payme is not configured');
    const amount = priceFor(req.planId, req.interval, 'UZS'); // tiyin
    const order = await this.prisma.paymentOrder.create({
      data: { userId: req.user.id, provider: 'PAYME', planId: req.planId, interval: req.interval, amount, currency: 'UZS' },
    });
    const lang = ['uz', 'ru', 'en'].includes(req.user.locale) ? req.user.locale : 'uz';
    const params = `m=${c.PAYME_MERCHANT_ID};ac.order_id=${order.number};a=${amount};c=${req.returnUrl}?order=${order.id};l=${lang}`;
    return { url: `${c.PAYME_CHECKOUT_URL}/${Buffer.from(params).toString('base64')}`, orderId: order.id };
  }

  /** Basic auth: "Paycom:<key>". Constant-time comparison. */
  authorized(header: string | undefined) {
    const key = config().PAYME_KEY;
    if (!key || !header?.startsWith('Basic ')) return false;
    const decoded = Buffer.from(header.slice(6), 'base64').toString();
    return safeEqual(decoded, `Paycom:${key}`);
  }

  /** JSON-RPC entry point. Always answers HTTP 200 with result or error, as Payme expects. */
  async handle(authHeader: string | undefined, body: unknown) {
    const req = (body ?? {}) as RpcRequest;
    const id = req.id ?? null;
    try {
      if (!this.authorized(authHeader)) throw new PaymeError(PaymeErr.AUTH);
      if (typeof req.method !== 'string' || typeof req.params !== 'object' || !req.params) throw new PaymeError(PaymeErr.INVALID_REQUEST);
      const result = await this.dispatch(req.method, req.params);
      return { jsonrpc: '2.0', id, result };
    } catch (e) {
      if (e instanceof PaymeError) return { jsonrpc: '2.0', id, error: { code: e.code, message: MESSAGES[e.code], data: e.data } };
      this.log.error(`Payme ${req.method} failed: ${(e as Error).stack}`);
      return { jsonrpc: '2.0', id, error: { code: PaymeErr.INTERNAL, message: MESSAGES[PaymeErr.INTERNAL] } };
    }
  }

  private dispatch(method: string, p: Record<string, unknown>) {
    switch (method) {
      case 'CheckPerformTransaction':
        return this.checkPerform(p);
      case 'CreateTransaction':
        return this.create(p);
      case 'PerformTransaction':
        return this.perform(p);
      case 'CancelTransaction':
        return this.cancel(p);
      case 'CheckTransaction':
        return this.check(p);
      case 'GetStatement':
        return this.statement(p);
      default:
        // ChangePassword is intentionally unsupported: the key lives in the secret store, rotate it there.
        throw new PaymeError(PaymeErr.METHOD_NOT_FOUND, method);
    }
  }

  private async orderFor(p: Record<string, unknown>): Promise<PaymentOrder> {
    const account = p.account as { order_id?: string | number } | undefined;
    const number = Number(account?.order_id);
    if (!Number.isInteger(number) || number <= 0) throw new PaymeError(PaymeErr.ORDER_NOT_FOUND, 'order_id');
    const order = await this.prisma.paymentOrder.findUnique({ where: { number } });
    if (!order || order.provider !== 'PAYME') throw new PaymeError(PaymeErr.ORDER_NOT_FOUND, 'order_id');
    return order;
  }

  private validate(order: PaymentOrder, amount: unknown) {
    if (order.status !== 'PENDING') throw new PaymeError(PaymeErr.ORDER_NOT_PAYABLE, 'order_id');
    if (Number(amount) !== order.amount) throw new PaymeError(PaymeErr.WRONG_AMOUNT);
  }

  private async checkPerform(p: Record<string, unknown>) {
    const order = await this.orderFor(p);
    this.validate(order, p.amount);
    const plan = await this.prisma.plan.findUniqueOrThrow({ where: { id: order.planId } });
    // "detail" enables fiscal receipts (OFD). IKPU/MXIK code must be set from your tax registration.
    return {
      allow: true,
      detail: {
        receipt_type: 0,
        items: [
          {
            title: `MaxCloud ${plan.name} (${order.interval === 'month' ? '1 oy' : '1 yil'})`,
            price: order.amount,
            count: 1,
            code: process.env.PAYME_IKPU_CODE ?? '',
            package_code: process.env.PAYME_PACKAGE_CODE ?? '',
            vat_percent: Number(process.env.PAYME_VAT_PERCENT ?? 12),
          },
        ],
      },
    };
  }

  private txView(tx: PaymeTransaction) {
    return {
      create_time: Number(tx.createTime),
      perform_time: Number(tx.performTime),
      cancel_time: Number(tx.cancelTime),
      transaction: tx.id,
      state: tx.state,
      reason: tx.reason,
    };
  }

  private async expireIfTimedOut(tx: PaymeTransaction): Promise<PaymeTransaction> {
    if (tx.state === 1 && Date.now() - Number(tx.createTime) > PAYME_TIMEOUT_MS) {
      return this.prisma.$transaction(async (db) => {
        await db.paymentOrder.update({ where: { id: tx.orderId }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
        return db.paymeTransaction.update({ where: { id: tx.id }, data: { state: -1, reason: 4, cancelTime: BigInt(Date.now()) } });
      });
    }
    return tx;
  }

  private async create(p: Record<string, unknown>) {
    const paymeId = String(p.id ?? '');
    if (!paymeId) throw new PaymeError(PaymeErr.INVALID_REQUEST);
    const existing = await this.prisma.paymeTransaction.findUnique({ where: { paymeId } });
    if (existing) {
      const tx = await this.expireIfTimedOut(existing);
      if (tx.state !== 1) throw new PaymeError(PaymeErr.CANNOT_PERFORM);
      return { create_time: Number(tx.createTime), transaction: tx.id, state: tx.state };
    }
    const order = await this.orderFor(p);
    this.validate(order, p.amount);
    const active = await this.prisma.paymeTransaction.findFirst({ where: { orderId: order.id, state: 1 } });
    if (active) throw new PaymeError(PaymeErr.ORDER_BUSY, 'order_id');
    const tx = await this.prisma.paymeTransaction.create({
      data: { paymeId, orderId: order.id, amount: order.amount, state: 1, paymeTime: BigInt(Number(p.time) || Date.now()), createTime: BigInt(Date.now()) },
    });
    return { create_time: Number(tx.createTime), transaction: tx.id, state: tx.state };
  }

  private async perform(p: Record<string, unknown>) {
    const found = await this.prisma.paymeTransaction.findUnique({ where: { paymeId: String(p.id ?? '') } });
    if (!found) throw new PaymeError(PaymeErr.TX_NOT_FOUND);
    const tx = await this.expireIfTimedOut(found);
    if (tx.state === 2) return { transaction: tx.id, perform_time: Number(tx.performTime), state: 2 };
    if (tx.state !== 1) throw new PaymeError(PaymeErr.CANNOT_PERFORM);
    const performed = await this.prisma.$transaction(async (db) => {
      // Conditional update: two concurrent Perform calls can't both apply the order.
      const claimed = await db.paymeTransaction.updateMany({ where: { id: tx.id, state: 1 }, data: { state: 2, performTime: BigInt(Date.now()) } });
      if (claimed.count !== 1) return db.paymeTransaction.findUniqueOrThrow({ where: { id: tx.id } });
      await this.billing.applyPrepaidOrder(tx.orderId, db);
      return db.paymeTransaction.findUniqueOrThrow({ where: { id: tx.id } });
    });
    await this.billing.afterPrepaidApplied(tx.orderId);
    return { transaction: performed.id, perform_time: Number(performed.performTime), state: performed.state };
  }

  private async cancel(p: Record<string, unknown>) {
    const tx = await this.prisma.paymeTransaction.findUnique({ where: { paymeId: String(p.id ?? '') } });
    if (!tx) throw new PaymeError(PaymeErr.TX_NOT_FOUND);
    const reason = Number(p.reason) || null;
    if (tx.state === 1) {
      const r = await this.prisma.$transaction(async (db) => {
        await db.paymentOrder.update({ where: { id: tx.orderId }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
        return db.paymeTransaction.update({ where: { id: tx.id }, data: { state: -1, reason, cancelTime: BigInt(Date.now()) } });
      });
      return { transaction: r.id, cancel_time: Number(r.cancelTime), state: r.state };
    }
    if (tx.state === 2) {
      // Refund after delivery: we allow it and take back the paid period.
      const r = await this.prisma.$transaction(async (db) => {
        await this.billing.refundPrepaidOrder(tx.orderId, db);
        return db.paymeTransaction.update({ where: { id: tx.id }, data: { state: -2, reason, cancelTime: BigInt(Date.now()) } });
      });
      await this.billing.afterPrepaidApplied(tx.orderId);
      return { transaction: r.id, cancel_time: Number(r.cancelTime), state: r.state };
    }
    return { transaction: tx.id, cancel_time: Number(tx.cancelTime), state: tx.state };
  }

  private async check(p: Record<string, unknown>) {
    const tx = await this.prisma.paymeTransaction.findUnique({ where: { paymeId: String(p.id ?? '') } });
    if (!tx) throw new PaymeError(PaymeErr.TX_NOT_FOUND);
    return this.txView(await this.expireIfTimedOut(tx));
  }

  private async statement(p: Record<string, unknown>) {
    const from = BigInt(Number(p.from) || 0);
    const to = BigInt(Number(p.to) || 0);
    const txs = await this.prisma.paymeTransaction.findMany({ where: { paymeTime: { gte: from, lte: to } }, include: { order: true }, orderBy: { paymeTime: 'asc' } });
    return {
      transactions: txs.map((tx) => ({
        id: tx.paymeId,
        time: Number(tx.paymeTime),
        amount: tx.amount,
        account: { order_id: String(tx.order.number) },
        ...this.txView(tx),
      })),
    };
  }
}
