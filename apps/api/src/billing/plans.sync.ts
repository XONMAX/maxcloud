import type { PrismaClient } from '@prisma/client';
import { PLANS } from '@maxcloud/shared';

/** Upsert the plan catalogue from @maxcloud/shared. Stripe price ids come from env (STRIPE_PRICE_<PLAN>_<MONTH|YEAR>). */
export async function syncPlans(prisma: PrismaClient) {
  for (const p of PLANS) {
    const env = (i: string) => process.env[`STRIPE_PRICE_${p.id.toUpperCase()}_${i}`] || null;
    const data = {
      name: p.name,
      quotaBytes: BigInt(p.quotaBytes),
      priceUsdMonth: p.monthly.USD,
      priceUsdYear: p.yearly.USD,
      priceUzsMonth: p.monthly.UZS,
      priceUzsYear: p.yearly.UZS,
      sortOrder: p.sortOrder,
      stripePriceMonthId: env('MONTH'),
      stripePriceYearId: env('YEAR'),
    };
    await prisma.plan.upsert({ where: { id: p.id }, create: { id: p.id, ...data }, update: data });
  }
}
