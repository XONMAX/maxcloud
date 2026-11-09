# Launch checklist

Tick these off in order. ⛔ marks a blocker for taking money from real users.

## 0. Legal & company
- [ ] ⛔ **Data residency decision** (ARCHITECTURE.md §7) signed off by an Uzbek lawyer; update the Privacy Policy
  section accordingly.
- [ ] ⛔ Register the personal-data database with the State Personalisation Centre if your lawyer says it's required.
- [ ] ⛔ Terms, Privacy and DMCA pages (`apps/web/src/app/legal/*`) reviewed by a lawyer and translated (uz, ru).
- [ ] Legal entity details in env: `COMPANY_LEGAL_NAME`, `COMPANY_TIN`, `COMPANY_ADDRESS` (shown on invoice PDFs).
- [ ] Tax: VAT treatment for UZS sales (`PAYME_VAT_PERCENT`), IKPU/MXIK code for cloud storage
  (`PAYME_IKPU_CODE`) for fiscal receipts.
- [ ] Foreign entity for Stripe (Stripe doesn't onboard UZ companies), or launch with local gateways only.
- [ ] Abuse/DMCA mailbox (abuse@) monitored; repeat-infringer policy written down.

## 1. Payments
**Payme**
- [ ] Merchant account approved.
- [ ] Test the integration in the Payme sandbox (test.paycom.uz) using their checklist. Every method and error
  code must pass, including the 12 h timeout and cancel after perform.
- [ ] Set the endpoint `https://api.maxcloud.uz/billing/payme` and account field `order_id` in the cabinet.
- [ ] Production key in `PAYME_KEY`; `PAYME_CHECKOUT_URL=https://checkout.paycom.uz`.
- [ ] Cloudflare WAF rule: allow `/billing/payme` only from Payme's published IP ranges.

**Stripe**
- [ ] Activate account (business details, bank, statement descriptor `MAXCLOUD`).
- [ ] `STRIPE_SECRET_KEY=sk_live_… pnpm tsx scripts/stripe-setup.ts`, then set the printed
  `STRIPE_PRICE_*` env vars.
- [ ] Webhook endpoint `https://api.maxcloud.uz/billing/webhooks/stripe` with events
  `checkout.session.completed`, `customer.subscription.created|updated|deleted`, `invoice.paid`,
  `invoice.payment_succeeded`, `invoice.payment_failed`; secret in `STRIPE_WEBHOOK_SECRET`.
- [ ] Customer Portal configured: allow plan switching between MaxCloud prices, cancel at period end, update card.
- [ ] Smart Retries + dunning emails on; Radar rules for card testing.
- [ ] Test-mode run: subscribe, upgrade (prorated), failed card (`4000 0000 0000 0341`), recover, cancel.

**Click / Uzum** (post-launch): implement the TODO adapters (see `providers/*.provider.ts`).

## 2. Storage & CDN
- [ ] B2: private bucket (`eu-central-003`), default encryption SSE-B2, lifecycle "keep only last version".
  Create an application key scoped to the bucket.
- [ ] `pnpm tsx scripts/provision-bucket.ts` (CORS for the web origin and `tauri://localhost`).
- [ ] Cloudflare: zone `maxcloud.uz`, proxied DNS for `maxcloud.uz`, `api.`, `dl.`; SSL Full (strict);
  HSTS; minimum TLS 1.2.
- [ ] Deploy the download Worker: `cd infra/cloudflare/download-worker && wrangler secret put
  DOWNLOAD_SIGNING_SECRET B2_KEY_ID B2_APP_KEY && wrangler deploy`; API `DOWNLOAD_MODE=worker`.
- [ ] Verify the B2 → Cloudflare Bandwidth Alliance: B2's egress report should show ~0 billable after a day.
- [ ] Block `/metrics` at the edge (WAF rule), or scrape over the Fly private network only.

## 3. Infrastructure
- [ ] Postgres (managed) with daily snapshots + PITR (7 days minimum); restore drill done once.
- [ ] Redis with persistence (queues survive restarts).
- [ ] `fly deploy` api / worker / web / clamav (`infra/fly/*.fly.toml`); migrations run as the release command.
- [ ] Secrets set (see the `api.fly.toml` comment). Generate `JWT_SECRET`, `APP_ENCRYPTION_KEY` and
  `DOWNLOAD_SIGNING_SECRET` with `openssl rand -hex 32`. **Back up `APP_ENCRYPTION_KEY`**: losing it disables
  every user's 2FA.
- [ ] `trust proxy` hop count matches Cloudflare → Fly → Next → API. Check that `req.ip` is the client IP (the
  rate limiter depends on it); set Next to forward `CF-Connecting-IP`.
- [ ] SMTP provider with SPF, DKIM and DMARC on `maxcloud.uz` (`SMTP_URL`); test that a password-reset email lands
  in the inbox.

## 4. Backups & DR
- [ ] Postgres: provider snapshots + nightly `pg_dump` to a *second* provider (different account).
- [ ] B2: decide whether to replicate user files (B2 Cloud Replication to another region doubles storage cost;
  price this into the plans before enabling).
- [ ] Runbook: restore DB to a point in time; rotate leaked keys (JWT, B2, Payme, Stripe); disable all share
  links for one user.

## 5. Monitoring
- [ ] Sentry DSN for api, worker and web; alert on new issues.
- [ ] Uptime: `https://api.maxcloud.uz/health/ready` every minute; public status page `status.maxcloud.uz`.
- [ ] Prometheus/Grafana (Fly metrics or Grafana Cloud) with alerts on:
  - p95 latency > 500 ms;
  - 5xx rate > 1%;
  - `maxcloud_quota_drift_users > 0`;
  - `maxcloud_webhook_events_total{result="error"}` rising;
  - BullMQ failed jobs.
- [ ] Admin → Overview: COGS alert banner reviewed weekly (it fires when any tier's COGS exceeds 60% of revenue).

## 6. Security
- [ ] `pnpm audit`, `cargo audit`, container scan.
- [ ] Rate limits validated behind Cloudflare: real client IPs, not Cloudflare's.
- [ ] Admin accounts have 2FA on. Restrict `/admin` with Cloudflare Access as defence in depth.
- [ ] Pen-test the share-link flows: brute force, path escape, expired links.
- [ ] ClamAV signatures auto-update (freshclam in the container).

## 7. App stores
**iOS (App Store)**
- [ ] Apple Developer Program ($99/yr).
- [ ] **Sign in with Apple is required**, because Google sign-in is offered (already supported:
  `APPLE_CLIENT_ID`).
- [ ] Privacy nutrition labels: email, name, photos/files (user content), device ID (sessions); no tracking.
- [ ] Account deletion must be possible in the app (guideline 5.1.1(v)). The web flow exists
  (`/account/delete`); add a button in the mobile app settings.
- [ ] In-app purchase rules for selling storage (see BUSINESS.md "App store billing"); no external purchase links
  in the iOS app unless entitled.
- [ ] Background modes justification (photo backup); `NSPhotoLibraryUsageDescription` text in uz/ru/en.

**Android (Google Play)**
- [ ] Play Console ($25). Data safety form. Photo/video permission declaration (core functionality = backup).
- [ ] Target the latest API level; foreground-service type `dataSync` if uploads run as a foreground service.
- [ ] Play Billing or alternative billing decision.

**Desktop**
- [ ] Windows code-signing certificate (EV avoids SmartScreen warnings).
- [ ] macOS Developer ID + notarization.
- [ ] Linux AppImage/deb.
- [ ] Tauri updater keys.

## 8. DNS & email
- [ ] `maxcloud.uz` → web, `api.maxcloud.uz` → API, `dl.maxcloud.uz` → Worker route, `status.maxcloud.uz` →
  status page.
- [ ] MX + SPF + DKIM + DMARC (`p=quarantine` after a week of `p=none` monitoring).
- [ ] CAA record for your certificate authority.

## 9. Go-live
- [ ] Seed only the plan catalogue (no demo users!): plans are synced on API boot. Do **not** run `db:seed` in
  production.
- [ ] Create the first admin: register normally, then `UPDATE "User" SET role='ADMIN' WHERE email=…`.
- [ ] Smoke test on prod:
  - register, verify email, enable 2FA;
  - upload 1 GB, download it, share a link with a password;
  - pay 11,900 so'm with Payme; check the invoice PDF; refund in the Payme cabinet and confirm the plan reverts.
- [ ] Announce; watch Sentry, the queues and the COGS panel for 48 h.
