import { describe, expect, it, beforeAll } from 'vitest';
import { resetConfig } from '../config';
import { StorageService } from './storage.service';
import { verify } from '../../../../infra/cloudflare/download-worker/src/sign';

/** The API signs, the Cloudflare Worker verifies: both sides must agree byte-for-byte. */
describe('download worker signatures', () => {
  beforeAll(() => {
    Object.assign(process.env, { DOWNLOAD_MODE: 'worker', DOWNLOAD_BASE_URL: 'https://dl.maxcloud.uz', DOWNLOAD_SIGNING_SECRET: 's3cr3t-for-tests' });
    resetConfig();
  });

  it('API-signed URL verifies in the worker; tampering or expiry fails', async () => {
    const storage = new StorageService();
    const url = new URL(await storage.downloadUrl('u/user1/ver1', 'Отчёт 2026.pdf', { inline: true, contentType: 'application/pdf' }));
    expect(url.host).toBe('dl.maxcloud.uz');
    const ok = await verify(url, 's3cr3t-for-tests');
    expect(ok).toMatchObject({ key: 'u/user1/ver1', contentType: 'application/pdf' });
    expect(ok!.disposition).toContain("filename*=UTF-8''%D0%9E%D1%82%D1%87%D1%91%D1%82%202026.pdf");

    const tampered = new URL(url);
    tampered.pathname = '/u/other-user/ver9';
    expect(await verify(tampered, 's3cr3t-for-tests')).toBeNull();
    expect(await verify(url, 'wrong-secret')).toBeNull();
    expect(await verify(url, 's3cr3t-for-tests', Math.floor(Date.now() / 1000) + 7200)).toBeNull();
  });
});
