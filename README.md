# MaxCloud

Cloud storage for phones and PCs, aimed at Uzbekistan: a cheaper Google One / iCloud+ built on wholesale S3
storage (Backblaze B2 by default) with Cloudflare in front for free egress.

| Plan | USD / month | so'm / month | Yearly |
|---|---|---|---|
| Free | 5 GB | — | — |
| 50 GB | $0.99 | 11 900 | 10 × monthly (2 months free) |
| 100 GB | $1.49 | 17 900 | 10 × monthly |
| 250 GB | $2.49 | 29 900 | 10 × monthly |
| 500 GB | $3.99 | 47 900 | 10 × monthly |
| 1 TB | $6.99 | 83 900 | 10 × monthly |

Payments go through Payme (UZS, prepaid periods) and Stripe (USD, recurring subscriptions). Click and Uzum sit
behind the same `PaymentProvider` interface as typed TODO adapters.

## Quick start

Requirements: Node 22+, pnpm 10, Docker. Without Docker, run Postgres 16, Redis 7 and any S3 server on
`:7070` yourself; the script tells you what it expects.

```bash
pnpm dev:setup
```

```bash
pnpm dev
```

`pnpm dev:setup` starts Postgres, Redis, S3 and Mailpit, writes `.env`, installs dependencies, runs migrations
and seeds demo data. `pnpm dev` then starts the API (:4000), the worker and the web app (:3000) with hot reload.

| | |
|---|---|
| Web | http://localhost:3000 |
| Demo user | `demo@maxcloud.uz` / `demo-password-2026` (100 GB plan, photos, a folder shared by the family account) |
| Admin | `admin@maxcloud.uz` / `admin-password-2026` → `/admin` |
| Public link | http://localhost:3000/s/demo-samarkand-album |
| Emails | Mailpit http://localhost:8025 (or the API console when SMTP is unset) |

## Tests

Unit and integration tests (shared, API against real Postgres/Redis/S3, desktop Rust):

```bash
pnpm test
```

Playwright end-to-end tests (upload, download, share, resume after network loss, mobile viewport):

```bash
pnpm e2e
```

Run the desktop sync engine between two simulated PCs (needs the API running):

```bash
scripts/desktop-sync-smoke.sh
```

Unit economics for the default scenario, or for a JSON scenario file:

```bash
pnpm economics
```

## Layout

```
apps/api        NestJS + Prisma API and BullMQ worker (thumbnails, ClamAV, quota lifecycle, purges)
apps/web        Next.js 15 + Tailwind + shadcn/ui, PWA; Playwright E2E in apps/web/e2e
apps/mobile     Flutter app: auth, files, camera-roll auto-backup     (not compiled here: no Flutter SDK)
apps/desktop    Rust sync-core + sync-agent (tested) and Tauri shell  (Tauri not compiled here: no WebKitGTK)
packages/shared plan catalogue, zod API schemas, unit-economics model
infra/          Fly.io, Cloudflare download Worker, ClamAV, Postgres init
docs/           ARCHITECTURE.md (diagrams, ERD, decisions), openapi.json, BUSINESS.md, LAUNCH_CHECKLIST.md
```

## Before launch, read these
- **Data residency** (docs/ARCHITECTURE.md §7). Uzbekistan's ZRU-547 art. 27-1 requires citizens' personal data
  to be stored in-country. The B2/Fly deployment doesn't satisfy it as-is.
- **Stripe** doesn't onboard Uzbek companies; card billing needs a foreign entity (docs/BUSINESS.md).
- **Margins**: Stripe fees on $0.99 monthly plans and heavy 1 TB annual users are where money leaks
  (docs/BUSINESS.md).
- docs/LAUNCH_CHECKLIST.md covers app stores, Stripe go-live, Payme sandbox certification, backups, DNS and
  monitoring.
