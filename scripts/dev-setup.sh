#!/usr/bin/env bash
# One-command local setup: infra (Docker), env files, deps, migrations, seed data.
#   pnpm dev:setup        then        pnpm dev
set -euo pipefail
cd "$(dirname "$0")/.."
say() { printf '\n\033[1;34m▸ %s\033[0m\n' "$*"; }

say "Infrastructure (Postgres, Redis, S3, Mailpit)"
if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
  docker compose up -d postgres redis s3 mailpit
  until docker compose exec -T postgres pg_isready -U maxcloud >/dev/null 2>&1; do sleep 1; done
  # The DB init script only runs on a fresh volume; make sure the test DB exists either way.
  docker compose exec -T postgres psql -U maxcloud -tc "SELECT 1 FROM pg_database WHERE datname='maxcloud_test'" | grep -q 1 \
    || docker compose exec -T postgres createdb -U maxcloud maxcloud_test
  SMTP=smtp://localhost:1025
else
  echo "Docker not available. Expecting these on localhost instead:"
  echo "  Postgres 16 :5432 (user/pass/db maxcloud, plus db maxcloud_test), Redis :6379, an S3 server :7070"
  echo "  (S3 without Docker: go install github.com/versity/versitygw/cmd/versitygw@latest &&"
  echo "   versitygw --access maxcloud --secret maxcloud-dev-secret --port :7070 posix ./.dev-data/s3)"
  pg_isready -h localhost -p 5432 >/dev/null || { echo "Postgres not reachable"; exit 1; }
  redis-cli ping >/dev/null || { echo "Redis not reachable"; exit 1; }
  curl -s -o /dev/null localhost:7070 || { echo "S3 server not reachable on :7070"; exit 1; }
  SMTP=
fi

say "Environment files"
[ -f apps/api/.env ] || { cp apps/api/.env.example apps/api/.env; sed -i.bak "s#^SMTP_URL=.*#SMTP_URL=${SMTP}#" apps/api/.env && rm -f apps/api/.env.bak; }
# Fresh random secrets for this machine (dev only).
if grep -q 'dev-only-jwt-secret' apps/api/.env; then
  sed -i.bak "s#^JWT_SECRET=.*#JWT_SECRET=$(openssl rand -hex 32)#; s#^APP_ENCRYPTION_KEY=.*#APP_ENCRYPTION_KEY=$(openssl rand -hex 32)#" apps/api/.env && rm -f apps/api/.env.bak
fi

say "Dependencies"
pnpm install
pnpm --filter @maxcloud/shared build

say "Database migrations + seed (demo data)"
( cd apps/api && npx prisma generate >/dev/null && npx prisma migrate deploy && set -a && . ./.env && set +a && npx tsx prisma/seed.ts )

cat <<'MSG'

Done. Start everything with:   pnpm dev
  Web     http://localhost:3000   (demo@maxcloud.uz / demo-password-2026, admin@maxcloud.uz / admin-password-2026)
  API     http://localhost:4000   (OpenAPI: docs/openapi.json)
  Mail    http://localhost:8025   (Mailpit, when using Docker)
  Shared  http://localhost:3000/s/demo-samarkand-album
Tests: pnpm test (unit + integration)   ·   pnpm e2e (Playwright)
MSG
