import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';

export function makeFile(name: string, bytes: number) {
  const dir = mkdtempSync(join(tmpdir(), 'mc-e2e-'));
  const path = join(dir, name);
  const data = randomBytes(bytes);
  writeFileSync(path, data);
  return { path, sha: createHash('sha256').update(data).digest('hex') };
}

export const sha256File = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

export async function register(page: Page, tag: string) {
  const email = `${tag}.${Date.now()}@e2e.maxcloud.uz`;
  const password = 'e2e password 2026';
  await page.goto('/register');
  await page.fill('#name', `E2E ${tag}`);
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.getByRole('button', { name: /Ro'yxatdan|Create account|Создать/ }).first().click();
  await page.waitForURL('**/drive');
  return { email, password };
}

export async function upload(page: Page, path: string) {
  await page.setInputFiles('[data-testid=file-input]', path);
}

export async function waitUploaded(page: Page, name: string, timeout = 90_000) {
  await expect(page.locator('[data-testid=upload-row][data-state=done]').filter({ hasText: name })).toBeVisible({ timeout });
  await expect(page.locator(`[data-testid=file-row][data-name="${name}"]`)).toBeVisible();
}

export async function rowAction(page: Page, name: string, action: string) {
  await page.getByRole('button', { name: `Actions for ${name}` }).click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}

/** Throttle / cut the network with CDP (Chromium) so uploads are slow enough to interrupt. */
export async function network(page: Page, opts: { offline?: boolean; uploadBytesPerSec?: number }) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: !!opts.offline,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: opts.uploadBytesPerSec ?? -1,
  });
  return cdp;
}
