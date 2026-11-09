/**
 * Unit economics model (deliverable 4).
 *
 * Pure function: given a tier mix and cost assumptions, compute monthly
 * revenue, storage COGS, payment fees and margin per tier and in total.
 * All money is in USD (float dollars) — UZS revenue is converted with `fxUzsPerUsd`.
 *
 * Every default below is an ASSUMPTION with a source date; override them
 * in the admin panel or CLI. Re-verify vendor prices before launch.
 */
import { GB, PLANS, type PlanId, type BillingInterval, TB } from './plans';

export interface StorageProviderPricing {
  id: 'b2' | 'r2' | 'wasabi';
  /** USD per TB-month (TB = 1024 GB here, a conservative upper bound). */
  perTBMonth: number;
  /** Minimum billable storage per account (Wasabi bills 1 TB minimum). */
  minBillableTB: number;
  /** Deleted data is billed until this many days after upload (Wasabi: 90). */
  minRetentionDays: number;
  /** USD per GB of egress if it is NOT routed through Cloudflare. */
  egressPerGB: number;
}

/** Prices as of 2026-11 (B2 raised PAYG to $6.95/TB on 2026-05-01). */
export const STORAGE_PROVIDERS: Record<StorageProviderPricing['id'], StorageProviderPricing> = {
  b2: { id: 'b2', perTBMonth: 6.95, minBillableTB: 0, minRetentionDays: 0, egressPerGB: 0.01 },
  r2: { id: 'r2', perTBMonth: 15.36, minBillableTB: 0, minRetentionDays: 0, egressPerGB: 0 },
  wasabi: { id: 'wasabi', perTBMonth: 6.99, minBillableTB: 1, minRetentionDays: 90, egressPerGB: 0 },
};

export interface PaymentFeeModel {
  /** Percentage of the charge, e.g. 0.029 */
  pct: number;
  /** Fixed fee per charge, USD */
  fixed: number;
}

export const PAYMENT_FEES = {
  /** Stripe standard card + 1.5% international card + 1% FX conversion (most UZ cards are foreign to Stripe). */
  stripe: { pct: 0.029 + 0.015 + 0.01, fixed: 0.3 },
  /** Payme merchant acquiring — ASSUMPTION 2.0%; public figures range 0.99–2.69%. Confirm in your merchant contract. */
  payme: { pct: 0.02, fixed: 0 },
  click: { pct: 0.02, fixed: 0 },
} satisfies Record<string, PaymentFeeModel>;

export type Gateway = keyof typeof PAYMENT_FEES;

export interface TierMixEntry {
  planId: PlanId;
  interval: BillingInterval;
  subscribers: number;
  /** Average fraction of quota actually stored (consumer clouds sit around 0.25-0.5). */
  avgUtilization: number;
}

export interface EconomicsInput {
  mix: TierMixEntry[];
  provider: StorageProviderPricing['id'];
  /** Share of revenue collected via each gateway; must sum to 1. */
  gatewayShare: Partial<Record<Gateway, number>>;
  /** Free users and their average stored GB (pure cost). */
  freeUsers: number;
  freeAvgStoredGB: number;
  /** Extra stored bytes from trash + versions as a fraction of live data (default 0.08). */
  overheadFraction?: number;
  /** Fraction of stored data downloaded per month that is NOT behind Cloudflare (should be 0). */
  uncachedEgressFraction?: number;
  /** COGS alert threshold as fraction of revenue (spec: 0.6). */
  cogsAlertRatio?: number;
}

export interface TierResult {
  planId: PlanId;
  interval: BillingInterval;
  subscribers: number;
  revenue: number;
  storedTB: number;
  storageCogs: number;
  egressCogs: number;
  paymentFees: number;
  /** storage + egress + payment fees */
  totalCogs: number;
  grossMargin: number;
  grossMarginPct: number;
  cogsRatio: number;
  alert: boolean;
  /** Utilization at which this tier's COGS hits the alert ratio. */
  breakEvenUtilization: number;
}

export interface EconomicsResult {
  tiers: TierResult[];
  free: { users: number; storedTB: number; storageCogs: number };
  totals: {
    revenue: number;
    storageCogs: number;
    egressCogs: number;
    paymentFees: number;
    totalCogs: number;
    grossMargin: number;
    grossMarginPct: number;
    arpu: number;
  };
  alerts: string[];
}

function round(n: number, d = 2) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

/** Blended per-charge fee given gateway share. Annual plans are charged once a year. */
function feePerCharge(chargeUsd: number, share: EconomicsInput['gatewayShare']): number {
  let fee = 0;
  for (const [gw, s] of Object.entries(share) as [Gateway, number][]) {
    const m = PAYMENT_FEES[gw];
    fee += s * (chargeUsd * m.pct + m.fixed);
  }
  return fee;
}

export function computeEconomics(input: EconomicsInput): EconomicsResult {
  const provider = STORAGE_PROVIDERS[input.provider];
  const overhead = input.overheadFraction ?? 0.08;
  const uncached = input.uncachedEgressFraction ?? 0;
  const alertRatio = input.cogsAlertRatio ?? 0.6;
  const shareSum = Object.values(input.gatewayShare).reduce((a, b) => a + (b ?? 0), 0);
  if (Math.abs(shareSum - 1) > 1e-6) throw new Error(`gatewayShare must sum to 1 (got ${shareSum})`);

  const perGBMonth = provider.perTBMonth / 1024;
  const alerts: string[] = [];

  const tiers: TierResult[] = input.mix.map((m) => {
    const plan = PLANS.find((p) => p.id === m.planId)!;
    const quotaGB = plan.quotaBytes / GB;
    const chargeUsd = (m.interval === 'month' ? plan.monthly.USD : plan.yearly.USD) / 100;
    const monthlyRevenuePerSub = m.interval === 'month' ? chargeUsd : chargeUsd / 12;
    const feePerSubMonth = m.interval === 'month' ? feePerCharge(chargeUsd, input.gatewayShare) : feePerCharge(chargeUsd, input.gatewayShare) / 12;

    const storedGBPerSub = quotaGB * m.avgUtilization * (1 + overhead);
    const storageCostPerSub = storedGBPerSub * perGBMonth;
    const egressCostPerSub = storedGBPerSub * uncached * provider.egressPerGB;

    const revenue = monthlyRevenuePerSub * m.subscribers;
    const storageCogs = storageCostPerSub * m.subscribers;
    const egressCogs = egressCostPerSub * m.subscribers;
    const paymentFees = feePerSubMonth * m.subscribers;
    const totalCogs = storageCogs + egressCogs + paymentFees;
    const grossMargin = revenue - totalCogs;
    const cogsRatio = revenue > 0 ? totalCogs / revenue : 0;

    // utilization u where (quota*u*(1+oh)*perGB + egress + fee)/rev = alertRatio
    const perUnitUtilCost = quotaGB * (1 + overhead) * (perGBMonth + uncached * provider.egressPerGB);
    const breakEvenUtilization = perUnitUtilCost > 0 ? Math.max(0, (alertRatio * monthlyRevenuePerSub - feePerSubMonth) / perUnitUtilCost) : Infinity;

    const alert = m.subscribers > 0 && cogsRatio > alertRatio;
    if (alert) {
      alerts.push(
        `${plan.name} (${m.interval}): COGS ${(cogsRatio * 100).toFixed(1)}% of revenue exceeds ${(alertRatio * 100).toFixed(0)}% ` +
          `(fees ${round((paymentFees / revenue) * 100, 1)}%, storage ${round((storageCogs / revenue) * 100, 1)}%).`,
      );
    }
    return {
      planId: m.planId,
      interval: m.interval,
      subscribers: m.subscribers,
      revenue: round(revenue),
      storedTB: round((storedGBPerSub * m.subscribers) / 1024, 3),
      storageCogs: round(storageCogs),
      egressCogs: round(egressCogs),
      paymentFees: round(paymentFees),
      totalCogs: round(totalCogs),
      grossMargin: round(grossMargin),
      grossMarginPct: round(revenue > 0 ? (grossMargin / revenue) * 100 : 0, 1),
      cogsRatio: round(cogsRatio, 4),
      alert,
      breakEvenUtilization: round(breakEvenUtilization, 3),
    };
  });

  const freeStoredGB = input.freeUsers * input.freeAvgStoredGB * (1 + overhead);
  const freeCogs = Math.max(freeStoredGB / 1024, provider.minBillableTB) * provider.perTBMonth * (freeStoredGB > 0 ? 1 : 0);
  const free = { users: input.freeUsers, storedTB: round(freeStoredGB / 1024, 3), storageCogs: round(freeCogs) };

  const sum = (k: keyof TierResult) => tiers.reduce((a, t) => a + (t[k] as number), 0);
  const revenue = sum('revenue');
  const storageCogs = sum('storageCogs') + free.storageCogs;
  const egressCogs = sum('egressCogs');
  const paymentFees = sum('paymentFees');
  const totalCogs = storageCogs + egressCogs + paymentFees;
  const paying = tiers.reduce((a, t) => a + t.subscribers, 0);

  if (provider.minBillableTB > 0) {
    const totalTB = tiers.reduce((a, t) => a + t.storedTB, 0) + free.storedTB;
    if (totalTB < provider.minBillableTB) alerts.push(`${provider.id}: stored ${totalTB.toFixed(2)} TB is below the ${provider.minBillableTB} TB billing minimum.`);
  }
  if (revenue > 0 && totalCogs / revenue > alertRatio) alerts.push(`Blended COGS ${((totalCogs / revenue) * 100).toFixed(1)}% exceeds ${alertRatio * 100}%.`);

  return {
    tiers,
    free,
    totals: {
      revenue: round(revenue),
      storageCogs: round(storageCogs),
      egressCogs: round(egressCogs),
      paymentFees: round(paymentFees),
      totalCogs: round(totalCogs),
      grossMargin: round(revenue - totalCogs),
      grossMarginPct: round(revenue > 0 ? ((revenue - totalCogs) / revenue) * 100 : 0, 1),
      arpu: round(paying > 0 ? revenue / paying : 0),
    },
    alerts,
  };
}

/** Actual storage cost for a single user's stored bytes (used by admin per-user view). */
export function storageCostPerMonth(bytes: number, provider: StorageProviderPricing['id'] = 'b2'): number {
  return (bytes / TB) * STORAGE_PROVIDERS[provider].perTBMonth;
}

/** A realistic launch scenario used as the default in admin + CLI. */
export const DEFAULT_SCENARIO: EconomicsInput = {
  provider: 'b2',
  gatewayShare: { payme: 0.7, click: 0.1, stripe: 0.2 },
  freeUsers: 20_000,
  freeAvgStoredGB: 1.5,
  mix: [
    { planId: 's50', interval: 'month', subscribers: 1200, avgUtilization: 0.45 },
    { planId: 's50', interval: 'year', subscribers: 400, avgUtilization: 0.45 },
    { planId: 's100', interval: 'month', subscribers: 700, avgUtilization: 0.4 },
    { planId: 's100', interval: 'year', subscribers: 250, avgUtilization: 0.4 },
    { planId: 's250', interval: 'month', subscribers: 300, avgUtilization: 0.35 },
    { planId: 's250', interval: 'year', subscribers: 120, avgUtilization: 0.35 },
    { planId: 's500', interval: 'month', subscribers: 120, avgUtilization: 0.35 },
    { planId: 's500', interval: 'year', subscribers: 50, avgUtilization: 0.35 },
    { planId: 's1000', interval: 'month', subscribers: 60, avgUtilization: 0.4 },
    { planId: 's1000', interval: 'year', subscribers: 25, avgUtilization: 0.4 },
  ],
};
