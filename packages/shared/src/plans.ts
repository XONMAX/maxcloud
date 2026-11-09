/**
 * Plan catalogue. This is the single source of truth used by the API seed,
 * the pricing page, and the unit-economics module.
 *
 * Quota unit: 1 GB = 1024^3 bytes (binary), which matches what phones and
 * desktop OSes report, so users never see "less than advertised".
 *
 * UZS prices: fixed price points (not live FX) derived from the CBU rate of
 * ~11,987 UZS/USD on 2026-11-07, rounded to the nearest x9,900. Local prices
 * are deliberately fixed so they don't change every day; review them quarterly
 * (see docs/LAUNCH_CHECKLIST.md).
 */

export const GB = 1024 ** 3;
export const TB = 1024 * GB;

export type PlanId = 'free' | 's50' | 's100' | 's250' | 's500' | 's1000';
export type BillingInterval = 'month' | 'year';
export type Currency = 'USD' | 'UZS';

export interface PlanDef {
  id: PlanId;
  name: string;
  quotaBytes: number;
  /** Monthly price in minor units (USD cents, UZS tiyin = 1/100 sum). */
  monthly: Record<Currency, number>;
  /** Annual price in minor units: always 10 x monthly (2 months free). */
  yearly: Record<Currency, number>;
  sortOrder: number;
}

function plan(id: PlanId, name: string, gb: number, usdCents: number, uzsSum: number, sortOrder: number): PlanDef {
  const monthly = { USD: usdCents, UZS: uzsSum * 100 };
  return {
    id,
    name,
    quotaBytes: gb * GB,
    monthly,
    yearly: { USD: monthly.USD * 10, UZS: monthly.UZS * 10 },
    sortOrder,
  };
}

export const PLANS: readonly PlanDef[] = [
  plan('free', 'Free', 5, 0, 0, 0),
  plan('s50', '50 GB', 50, 99, 11_900, 1),
  plan('s100', '100 GB', 100, 149, 17_900, 2),
  plan('s250', '250 GB', 250, 249, 29_900, 3),
  plan('s500', '500 GB', 500, 399, 47_900, 4),
  plan('s1000', '1 TB', 1024, 699, 83_900, 5),
] as const;

export const FREE_PLAN_ID: PlanId = 'free';

export function getPlan(id: string): PlanDef {
  const p = PLANS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown plan: ${id}`);
  return p;
}

export function priceFor(planId: PlanId, interval: BillingInterval, currency: Currency): number {
  const p = getPlan(planId);
  return interval === 'month' ? p.monthly[currency] : p.yearly[currency];
}

/** Lifecycle constants for the quota engine (feature 4). */
export const QUOTA_POLICY = {
  graceDays: 7,
  /** Days an account stays read-only before over-quota data is purged. */
  readOnlyDays: 30,
  /** Deletion warning emails are sent this many days before the purge date. */
  deletionWarningDays: [30, 7, 1] as const,
  trashRetentionDays: 30,
  maxVersions: 10,
} as const;
