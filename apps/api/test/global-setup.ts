import { execSync } from 'node:child_process';

/** Apply migrations to the dedicated test database (non-destructive; tests isolate data with unique users). */
export default function setup() {
  const url = process.env.DATABASE_URL ?? 'postgresql://maxcloud:maxcloud@localhost:5432/maxcloud_test';
  if (!url.includes('test')) throw new Error('DATABASE_URL must point to a test database');
  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    stdio: 'pipe',
  });
}
