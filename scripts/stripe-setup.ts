/**
 * Creates (idempotently) Stripe products + prices for every paid plan and prints the
 * env vars to set (STRIPE_PRICE_<PLAN>_<MONTH|YEAR>). Run with a test key first:
 *   STRIPE_SECRET_KEY=sk_test_... pnpm tsx scripts/stripe-setup.ts
 */
import Stripe from 'stripe';
import { PLANS } from '../packages/shared/src/plans';

async function main() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('Set STRIPE_SECRET_KEY');
  const stripe = new Stripe(key);
  const lines: string[] = [];
  for (const p of PLANS.filter((x) => x.id !== 'free')) {
    const productId = `maxcloud_${p.id}`;
    const product = await stripe.products.retrieve(productId).catch(() => stripe.products.create({ id: productId, name: `MaxCloud ${p.name}`, metadata: { planId: p.id } }));
    for (const interval of ['month', 'year'] as const) {
      const lookup = `maxcloud_${p.id}_${interval}_v1`;
      const existing = await stripe.prices.list({ lookup_keys: [lookup], limit: 1 });
      const price =
        existing.data[0] ??
        (await stripe.prices.create({
          product: product.id,
          currency: 'usd',
          unit_amount: interval === 'month' ? p.monthly.USD : p.yearly.USD,
          recurring: { interval },
          lookup_key: lookup,
          metadata: { planId: p.id, interval },
        }));
      lines.push(`STRIPE_PRICE_${p.id.toUpperCase()}_${interval.toUpperCase()}=${price.id}`);
    }
  }
  console.log(lines.join('\n'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
