# syntax=docker/dockerfile:1.7
# API + worker image (same image, different command).
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /repo

FROM base AS build
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter @maxcloud/api... --filter @maxcloud/shared
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @maxcloud/shared build && pnpm --filter @maxcloud/api build
RUN pnpm deploy --filter @maxcloud/api --prod --legacy /out && cp -r apps/api/dist apps/api/prisma /out/ \
 && cd /out && npx prisma generate

FROM node:22-bookworm-slim AS runtime
# ffmpeg + poppler for video/PDF thumbnails in the worker
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg poppler-utils ca-certificates openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Vercel's container runtime expects port 80 unless PORT is set; Fly/compose set PORT=4000 explicitly.
ENV NODE_ENV=production PORT=80
COPY --from=build /out /app
USER node
EXPOSE 80
# Migrations run as a release command (fly.toml) - not on every container start.
CMD ["node", "dist/main.js"]
