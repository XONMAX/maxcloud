import { describe, expect, it } from 'vitest';
import { computeEconomics, DEFAULT_SCENARIO, storageCostPerMonth } from './economics';
import { GB, TB, priceFor, PLANS } from './plans';

describe('plans', () => {
  it('annual = 10 x monthly for every currency', () => {
    for (const p of PLANS) {
      expect(p.yearly.USD).toBe(p.monthly.USD * 10);
      expect(p.yearly.UZS).toBe(p.monthly.UZS * 10);
    }
    expect(priceFor('s1000', 'year', 'USD')).toBe(6990);
  });
});

describe('computeEconomics', () => {
  it('computes a single monthly tier exactly', () => {
    const r = computeEconomics({
      provider: 'b2',
      gatewayShare: { payme: 1 },
      freeUsers: 0,
      freeAvgStoredGB: 0,
      overheadFraction: 0,
      mix: [{ planId: 's100', interval: 'month', subscribers: 100, avgUtilization: 0.5 }],
    });
    const t = r.tiers[0];
    expect(t.revenue).toBe(149); // 100 x $1.49
    // 50 GB/user x 100 users = 5000 GB at $6.95/1024 per GB
    expect(t.storageCogs).toBeCloseTo((5000 * 6.95) / 1024, 2);
    expect(t.paymentFees).toBeCloseTo(149 * 0.02, 2);
    expect(t.alert).toBe(false);
  });

  it('flags Stripe monthly $0.99 as a money-loser because of the fixed $0.30 fee', () => {
    const r = computeEconomics({
      provider: 'b2',
      gatewayShare: { stripe: 1 },
      freeUsers: 0,
      freeAvgStoredGB: 0,
      mix: [{ planId: 's50', interval: 'month', subscribers: 10, avgUtilization: 0.9 }],
    });
    expect(r.tiers[0].alert).toBe(true);
    expect(r.alerts[0]).toMatch(/50 GB/);
  });

  it('amortizes annual payment fees over 12 months', () => {
    const base = { provider: 'b2' as const, gatewayShare: { stripe: 1 }, freeUsers: 0, freeAvgStoredGB: 0 };
    const m = computeEconomics({ ...base, mix: [{ planId: 's50', interval: 'month', subscribers: 1, avgUtilization: 0 }] });
    const y = computeEconomics({ ...base, mix: [{ planId: 's50', interval: 'year', subscribers: 1, avgUtilization: 0 }] });
    expect(y.tiers[0].paymentFees).toBeLessThan(m.tiers[0].paymentFees / 4); // $0.07 vs $0.35 per month
  });

  it('1 TB plan breaches 60% COGS on B2 near full utilization', () => {
    const r = computeEconomics({
      provider: 'b2',
      gatewayShare: { payme: 1 },
      freeUsers: 0,
      freeAvgStoredGB: 0,
      mix: [{ planId: 's1000', interval: 'month', subscribers: 10, avgUtilization: 0.7 }],
    });
    expect(r.tiers[0].alert).toBe(true);
    expect(r.tiers[0].breakEvenUtilization).toBeGreaterThan(0.5);
    expect(r.tiers[0].breakEvenUtilization).toBeLessThan(0.6);
  });

  it('rejects gateway shares that do not sum to 1', () => {
    expect(() => computeEconomics({ ...DEFAULT_SCENARIO, gatewayShare: { payme: 0.5 } })).toThrow();
  });

  it('default scenario is profitable', () => {
    const r = computeEconomics(DEFAULT_SCENARIO);
    expect(r.totals.grossMarginPct).toBeGreaterThan(40);
  });

  it('per-user storage cost', () => {
    expect(storageCostPerMonth(TB)).toBeCloseTo(6.95);
    expect(storageCostPerMonth(100 * GB)).toBeCloseTo(0.679, 2);
  });
});
