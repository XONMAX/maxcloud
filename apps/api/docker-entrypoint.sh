#!/bin/sh
# Container start: optionally migrate, then run the API (default) or the worker (`sh ./docker-entrypoint.sh worker`).
set -e
if [ "$RUN_MIGRATIONS" = "true" ]; then
  # prisma migrate deploy takes a Postgres advisory lock, so concurrent instances are safe.
  ./node_modules/.bin/prisma migrate deploy
fi
if [ "$1" = "worker" ]; then exec node dist/worker.js; fi
exec node dist/main.js
