# Deploying on Vercel (services)

`vercel.json` defines one project with two services:

| Service | Root | Runtime | Public path |
|---|---|---|---|
| `web` | `apps/web` | Next.js | `/(.*)` (catch-all) |
| `api` | `apps/api` | container (`apps/api/Dockerfile`) | `/api/(.*)` |

- The api service receives the **original** path (`/api/auth/login`). When `VERCEL` is set, the API mounts every
  route under `API_BASE_PATH=/api`; locally and on Fly the prefix stays empty. The browser always calls
  same-origin `/api/...`, so auth cookies stay first-party.
- No bindings: no service calls another server-side. The web app's local `/api` proxy (`next.config.ts`) is
  switched off on Vercel, where the top-level rewrite routes `/api` before Next.js sees it.
- Webhook URLs on Vercel: `https://<domain>/api/billing/webhooks/stripe` and `https://<domain>/api/billing/payme`.
- Set project environment variables from `apps/api/.env.example` (DATABASE_URL, REDIS_URL, S3_*, JWT_SECRET,
  APP_ENCRYPTION_KEY, WEB_ORIGIN=https://<domain>, …). Postgres, Redis and S3/B2 are external services.
- Container port: the Dockerfile defaults to `PORT=80` (Vercel's default); Fly and compose override it with 4000.

Not covered by this config (see the open questions in the PR/commit):
- The **worker** (`node dist/worker.js`) runs thumbnails, virus scans, the quota lifecycle and purges. It's a
  long-running queue consumer, so it belongs in Vercel **Daemons** (beta, production only) or stays on Fly.
- **ClamAV** (clamd) needs ~2 GB RAM and a TCP port: keep it on Fly, or leave `CLAMAV_HOST` unset (scans SKIPPED).
- Container build context: the Dockerfile copies `packages/shared` from the repo root. If Vercel builds with
  `apps/api` as the context, the build fails and the Dockerfile needs restructuring.
