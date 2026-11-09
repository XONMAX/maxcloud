import { defineConfig, devices } from '@playwright/test';

/**
 * E2E against the real stack: web (Next) + API (Nest) + Postgres + Redis + S3.
 * `pnpm dev:setup` (or docker compose up) must have started Postgres, Redis and the S3 server.
 * The servers below are started automatically unless already running. If you start the API yourself,
 * run it with RATE_LIMIT_DISABLED=true (the suite registers many accounts from 127.0.0.1).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'off',
    acceptDownloads: true,
    ...(process.env.CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.CHROMIUM_PATH } } : {}),
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, testIgnore: /mobile\.spec\.ts/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /mobile\.spec\.ts/ },
  ],
  webServer: [
    { command: 'RATE_LIMIT_DISABLED=true pnpm --filter @maxcloud/api dev', // many signups from one IP url: 'http://localhost:4000/health', reuseExistingServer: true, timeout: 120_000, cwd: '../..' },
    { command: 'pnpm --filter @maxcloud/web dev', url: 'http://localhost:3000/login', reuseExistingServer: true, timeout: 120_000, cwd: '../..' },
  ],
});
