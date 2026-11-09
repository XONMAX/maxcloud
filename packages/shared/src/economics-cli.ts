/* Usage: pnpm --filter @maxcloud/shared economics [scenario.json]
 * Prints the unit-economics table for the default (or given) scenario. */
import { readFileSync } from 'node:fs';
import { computeEconomics, DEFAULT_SCENARIO, type EconomicsInput } from './economics';

const file = process.argv[2];
const input: EconomicsInput = file ? JSON.parse(readFileSync(file, 'utf8')) : DEFAULT_SCENARIO;
const r = computeEconomics(input);
console.table(
  r.tiers.map((t) => ({
    tier: `${t.planId}/${t.interval}`,
    subs: t.subscribers,
    revenue: t.revenue,
    storage: t.storageCogs,
    fees: t.paymentFees,
    margin: t.grossMargin,
    'margin%': t.grossMarginPct,
    'cogs%': +(t.cogsRatio * 100).toFixed(1),
    'alert@util': t.breakEvenUtilization,
    alert: t.alert ? 'YES' : '',
  })),
);
console.log('Free tier:', r.free);
console.log('Totals (USD/month):', r.totals);
if (r.alerts.length) console.log('ALERTS:\n - ' + r.alerts.join('\n - '));
