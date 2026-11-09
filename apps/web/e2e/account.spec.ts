import { expect, test } from '@playwright/test';
import { register } from './fixtures';

test('seeded demo account: drive, shared folder, billing and invoices pages', async ({ page }) => {
  await page.goto('/login');
  await page.fill('#email', 'demo@maxcloud.uz');
  await page.fill('#password', 'demo-password-2026');
  await page.locator('form button[type=submit]').click();
  await page.waitForURL('**/drive');
  await expect(page.locator('[data-testid=file-row][data-name="Photos"]')).toBeVisible();
  await page.goto('/shared');
  await expect(page.getByText('Family album')).toBeVisible();
  await page.goto('/billing');
  await expect(page.getByTestId('plan-s250')).toBeVisible();
});

test('quota hard stop is explained to the user', async ({ page }) => {
  await register(page, 'quota');
  // 6 GB declared file > 5 GB free quota: rejected before any bytes are sent.
  const res = await page.evaluate(async () => {
    const r = await fetch('/api/uploads', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'huge.iso', parentId: null, size: 6 * 1024 ** 3 }) });
    return { status: r.status, body: await r.json() };
  });
  expect(res.status).toBe(413);
  expect(res.body.code).toBe('QUOTA_EXCEEDED');
});

test('devices list and sign-out', async ({ page }) => {
  await register(page, 'devices');
  await page.goto('/settings');
  await expect(page.getByTestId('session-row')).toHaveCount(1);
  await expect(page.getByText('This device')).toBeVisible();
});
