# syntax=docker/dockerfile:1.7
# API + worker image (same image, different command). BUILD CONTEXT = REPO ROOT:
#   docker build -f apps/api/Dockerfile .        (Vercel: service root "." + entrypoint apps/api/Dockerfile)
# The API depends on the workspace package packages/shared, so the context must include it.
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/* \
 && corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter "@maxcloud/api..."
COPY packages/shared packages/shared
COPY apps/api apps/api
# shared -> dist, then prisma generate + tsc (apps/api "build" script)
RUN pnpm --filter @maxcloud/shared build && pnpm --filter @maxcloud/api build

FROM node:22-bookworm-slim AS runtime
# ffmpeg + poppler for video/PDF thumbnails in the worker; openssl for Prisma
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg poppler-utils ca-certificates openssl && rm -rf /var/lib/apt/lists/*
# Keep the workspace layout: node_modules are pnpm symlinks into /repo/node_modules/.pnpm.
COPY --from=build /repo /repo
WORKDIR /repo/apps/api
# Vercel's container runtime expects port 80 unless PORT is set; Fly/compose set PORT=4000 explicitly.
ENV NODE_ENV=production PORT=80
USER node
EXPOSE 80
# RUN_MIGRATIONS=true applies pending Prisma migrations before start (use where there's no release step, e.g. Vercel).
CMD ["sh", "./docker-entrypoint.sh"]
