import { expect, test } from '@playwright/test';
import { makeFile, register, upload, waitUploaded } from './fixtures';

test('mobile web: sidebar menu, upload and storage meter', async ({ page }) => {
  await register(page, 'mobile');
  const f = makeFile('photo.jpg', 50_000);
  await upload(page, f.path);
  await waitUploaded(page, 'photo.jpg');
  await page.getByRole('button', { name: 'Menu' }).click();
  await expect(page.getByTestId('storage-meter').filter({ visible: true })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
});
