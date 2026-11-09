# MaxCloud — unit economics & business notes

All numbers come from the unit-economics module (`packages/shared/src/economics.ts`). It's a pure function: give
it a tier mix and it returns revenue, storage COGS, payment fees and margin per tier, with the 60% COGS alert.
- Run the default scenario: `pnpm --filter @maxcloud/shared economics`
- Run your own: `pnpm --filter @maxcloud/shared economics my-scenario.json` (same shape as `DEFAULT_SCENARIO`)
- The admin panel shows the same metrics from **live** data (`/admin` → Overview) and accepts scenarios at
  `POST /admin/economics`.

## Assumptions (check each before launch)
| Input | Value | Source / note |
|---|---|---|
| B2 storage | $6.95 / TB-month | Backblaze PAYG since 2026-05-01; API transactions free |
| R2 storage | $0.015 / GB-month | Cloudflare list price |
| Wasabi | $6.99 / TB-month, 1 TB min, 90-day min retention | Wasabi list price |
| Stripe fee | 2.9% + $0.30, +1.5% international card, +1% currency conversion | almost every Uzbek card is "international" to a foreign Stripe account |
| Payme / Click fee | 2.0% | **Assumption.** Public figures range from 0.99% to 2.69%; get your contract rate |
| FX | 11,987 UZS/USD | Central Bank of Uzbekistan rate, 2026-11-07; UZS prices are fixed price points, review quarterly |
| Overhead | +8% stored bytes | Trash and old versions (we bill them to quota, but they still cost us) |
| Utilization | 35–45% of quota | Typical for consumer clouds; **the biggest driver of margin, so watch it in admin** |

## UZS price list (fixed price points, ≈ USD × 11,987, rounded to …900)
| Plan | USD / month | so'm / month | so'm / year (10×) |
|---|---|---|---|
| 50 GB | $0.99 | 11,900 | 119,000 |
| 100 GB | $1.49 | 17,900 | 179,000 |
| 250 GB | $2.49 | 29,900 | 299,000 |
| 500 GB | $3.99 | 47,900 | 479,000 |
| 1 TB | $6.99 | 83,900 | 839,000 |

## Results

### Margin by tier and gateway (40% average utilization, B2)
| Tier | Payme monthly | Payme yearly | Stripe monthly | Stripe yearly | COGS hits 60% at utilization (Payme, monthly / yearly) |
|---|---|---|---|---|---|
| 50 GB | 83% | 80% | **50%** (fees = 36% of revenue) | 74% | never / never |
| 100 GB | 78% | 74% | 55% | 69% | never / 98% |
| 250 GB | 69% | 63% | 53% | 58% | 79% / 66% |
| 500 GB | 61% | 54% | 50% | 50% | 63% / 53% |
| 1 TB | 55% | **47%** | 47% | **43%** | **54% / 45%** |

### Launch scenario (`DEFAULT_SCENARIO`: 3,225 paying, 20,000 free, gateway mix 70/10/20)
| | USD / month |
|---|---|
| Revenue (monthly-normalised) | $5,078 |
| Storage COGS (paid + free) | $1,505 (free tier: $220) |
| Payment fees | $283 |
| **Gross margin** | **$3,289 (64.8%)** |
| ARPU | $1.57 |

## What the numbers say
1. **Large annual plans are where margin gets thin.**
   - The 1 TB annual plan costs $0.58/month per user (10 months' price spread over 12). It crosses the 60% COGS
     alert at **45% average utilization**; heavy 1 TB users (80%+) are loss-making.
   - Mitigations, in order:
     - (a) keep the alert on and watch real utilization in admin;
     - (b) price 1 TB annual at 11 months instead of 10;
     - (c) negotiate B2 committed-use pricing once you pass ~200 TB;
     - (d) a fair-use clause, already covered by the "no public file-hosting" rule in the Terms.
2. **Stripe is expensive for small tickets.** The fixed $0.30 fee is 30% of a $0.99 charge. Offer the 50 GB and
   100 GB plans through Stripe **yearly only** (or set a $2.49 minimum for monthly card billing). Local gateways
   (~2%) should be the default payment button in Uzbekistan.
3. **The free tier is cheap but not free.** 20,000 users storing 1.5 GB each cost about $220/month (4% of
   revenue). Inactive free accounts (no sign-in for 12 months) should get a 30-day "we'll delete your files"
   notice. The quota engine's deletion flow can be reused for that.
4. **R2 would halve gross margin** (65% → 29%). B2 behind Cloudflare gives free egress anyway.

## Stripe availability
**Stripe doesn't onboard businesses registered in Uzbekistan.** Card billing in USD needs a foreign entity:
- a US LLC via Stripe Atlas (~$500 + registered agent);
- a UAE free-zone company;
- an Estonian OÜ (via e-Residency).

That entity becomes the merchant of record for USD card sales, with tax implications to review. Until then, run
Payme (and Click/Uzum later) only. The code handles a missing Stripe key: the card option shows as unavailable.

## App store billing
Selling storage *inside* the iOS app requires Apple In-App Purchase, at a 15% commission (Small Business Program)
or 30%. Options:
- **(a)** the iOS app is a "reader"-style companion with no purchase UI; users subscribe on the web;
- **(b)** add StoreKit products priced about 18% higher. This would be a new `PaymentProvider` (`APPLE`) fed by
  App Store Server Notifications.

Google Play has similar rules. In some regions Play also allows alternative billing with a ~4% lower fee.
