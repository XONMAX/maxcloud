# Deploying on Vercel (services)

`vercel.json` defines one project with two services:

| Service | Root | Runtime | Public path |
|---|---|---|---|
| `web` | `apps/web` | Next.js | `/(.*)` (catch-all) |
| `api` | `.` (repo root) | container (`entrypoint: apps/api/Dockerfile`) | `/api/(.*)` |

- The api service receives the **original** path (`/api/auth/login`). When `VERCEL` is set, the API mounts every
  route under `API_BASE_PATH=/api`; locally and on Fly the prefix stays empty. The browser always calls
  same-origin `/api/...`, so auth cookies stay first-party.
- No bindings: no service calls another server-side. The web app's local `/api` proxy (`next.config.ts`) is
  switched off on Vercel, where the top-level rewrite routes `/api` before Next.js sees it.
- Webhook URLs on Vercel: `https://<domain>/api/billing/webhooks/stripe` and `https://<domain>/api/billing/payme`.
- Set project environment variables from `apps/api/.env.example` (DATABASE_URL, REDIS_URL, S3_*, JWT_SECRET,
  APP_ENCRYPTION_KEY, WEB_ORIGIN=https://<domain>, …). Postgres, Redis and S3/B2 are external services.
- Container port: the Dockerfile defaults to `PORT=80` (Vercel's default); Fly and compose override it with 4000.
- Build context: Vercel builds a container with the service `root` as the Docker context. The API needs the
  workspace package `packages/shared`, so the api service's root is the repo root and `entrypoint` points at
  `apps/api/Dockerfile` (a root of `apps/api` fails with `stat: "/pnpm-workspace.yaml": no such file`).
- Migrations: Vercel has no release step. Set `RUN_MIGRATIONS=true` in the project env and the container runs
  `prisma migrate deploy` before starting (advisory-locked, safe with several instances). This adds ~1–2 s to
  cold starts; alternatively run migrations from CI and leave it unset.

Not covered by this config (see the open questions in the PR/commit):
- The **worker** (`node dist/worker.js`) runs thumbnails, virus scans, the quota lifecycle and purges. It's a
  long-running queue consumer, so it belongs in Vercel **Daemons** (beta, production only) or stays on Fly.
- **ClamAV** (clamd) needs ~2 GB RAM and a TCP port: keep it on Fly, or leave `CLAMAV_HOST` unset (scans SKIPPED).
