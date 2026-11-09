import { expect, test } from '@playwright/test';
import { makeFile, network, register, rowAction, sha256File, upload, waitUploaded } from './fixtures';

test.describe('upload / download / share', () => {
  test('upload, preview, download (byte-identical), rename, trash and restore', async ({ page }) => {
    await register(page, 'files');
    const f = makeFile('report.txt', 300_000);
    await upload(page, f.path);
    await waitUploaded(page, 'report.txt');
    await expect(page.getByTestId('storage-meter')).toContainText('293');

    const [download] = await Promise.all([page.waitForEvent('download'), rowAction(page, 'report.txt', 'Download')]);
    expect(download.suggestedFilename()).toBe('report.txt');
    expect(sha256File(await download.path())).toBe(f.sha);

    await rowAction(page, 'report.txt', 'Rename');
    await page.getByRole('dialog').getByLabel('Name').fill('final report.txt');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('[data-testid=file-row][data-name="final report.txt"]')).toBeVisible();

    await rowAction(page, 'final report.txt', 'Move to Trash');
    await expect(page.locator('[data-testid=file-row]')).toHaveCount(0);
    await page.goto('/trash');
    await page.getByRole('button', { name: /Restore/ }).click();
    await page.goto('/drive');
    await expect(page.locator('[data-testid=file-row][data-name="final report.txt"]')).toBeVisible();
  });

  test('resumes an upload after the network drops mid-transfer', async ({ page, context }) => {
    await register(page, 'resume');
    const f = makeFile('backup.bin', 40 * 1024 * 1024); // 5 parts of 8 MiB
    await network(page, { uploadBytesPerSec: 6 * 1024 * 1024 }); // slow enough to interrupt
    await upload(page, f.path);
    // wait until some parts are stored, then cut the network mid-transfer
    await expect(page.getByTestId('upload-row')).toContainText(/(\d{2}\.\d|[89]\.\d) MB of 40/, { timeout: 60_000 });
    await context.setOffline(true);
    await expect(page.getByTestId('upload-row')).toHaveAttribute('data-state', 'paused-offline', { timeout: 30_000 });
    await page.waitForTimeout(2000);
    await context.setOffline(false);
    await network(page, {});
    await waitUploaded(page, 'backup.bin');
    const [download] = await Promise.all([page.waitForEvent('download'), rowAction(page, 'backup.bin', 'Download')]);
    expect(sha256File(await download.path())).toBe(f.sha);
  });

  test('password-protected share link works for an anonymous visitor', async ({ page, browser }) => {
    await register(page, 'share');
    const f = makeFile('wedding.mp4', 120_000);
    await upload(page, f.path);
    await waitUploaded(page, 'wedding.mp4');
    await rowAction(page, 'wedding.mp4', 'Share');
    await page.getByLabel('Password (optional)').fill('toy2026');
    await page.getByRole('button', { name: /Create link/ }).click();
    const url = await page.getByTestId('share-links').locator('code').first().textContent();
    expect(url).toMatch(/\/s\//);

    const anon = await browser.newContext();
    const visitor = await anon.newPage();
    await visitor.goto(url!);
    await expect(visitor.getByText('Password required')).toBeVisible();
    await visitor.getByLabel('Link password').fill('wrong');
    await visitor.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(visitor.getByText(/Wrong password/)).toBeVisible();
    await visitor.getByLabel('Link password').fill('toy2026');
    await visitor.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(visitor.getByTestId('share-title')).toHaveText('wedding.mp4');
    const [download] = await Promise.all([visitor.waitForEvent('download'), visitor.getByRole('button', { name: /Download/ }).click()]);
    expect(sha256File(await download.path())).toBe(f.sha);
    await anon.close();
  });

  test('folders, move and search', async ({ page }) => {
    await register(page, 'folders');
    await page.getByRole('button', { name: /Yangi papka|New folder/ }).click();
    await page.getByRole('dialog').getByLabel('Name').fill('Photos');
    await page.getByRole('button', { name: 'Save' }).click();
    const f = makeFile('IMG_0001.jpg', 5000);
    await upload(page, f.path);
    await waitUploaded(page, 'IMG_0001.jpg');
    await rowAction(page, 'IMG_0001.jpg', 'Move');
    await page.getByRole('dialog').getByRole('button', { name: 'Photos', exact: true }).click();
    await page.getByRole('button', { name: 'Move here' }).click();
    await expect(page.locator('[data-testid=file-row][data-name="IMG_0001.jpg"]')).toHaveCount(0);
    await page.getByRole('searchbox').or(page.getByPlaceholder(/qidirish|Search|Поиск/)).fill('img_0001');
    await expect(page.locator('[data-testid=file-row][data-name="IMG_0001.jpg"]')).toBeVisible();
  });
});
