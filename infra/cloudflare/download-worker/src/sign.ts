/**
 * Verifies download URLs signed by the API (apps/api/src/storage/storage.service.ts, DOWNLOAD_MODE=worker).
 * Signature = base64url(HMAC-SHA256(secret, `${key}\n${exp}\n${disposition}\n${contentType}`)).
 * WebCrypto only, so it runs in Workers and in Node 20+ (used by the API's tests).
 */
export interface SignedRequest {
  key: string;
  exp: number;
  disposition: string;
  contentType: string;
}

function b64url(buf: ArrayBuffer) {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sign(secret: string, r: SignedRequest) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`${r.key}\n${r.exp}\n${r.disposition}\n${r.contentType}`)));
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Parse + verify a request URL. Returns null when invalid or expired. */
export async function verify(url: URL, secret: string, nowSec = Math.floor(Date.now() / 1000)): Promise<SignedRequest | null> {
  const key = decodeURIComponent(url.pathname.slice(1));
  const exp = Number(url.searchParams.get('exp'));
  const disposition = url.searchParams.get('d') ?? '';
  const contentType = url.searchParams.get('ct') ?? '';
  const sig = url.searchParams.get('sig') ?? '';
  if (!key || !Number.isFinite(exp) || exp < nowSec || !/^[ut]\//.test(key)) return null;
  const expected = await sign(secret, { key, exp, disposition, contentType });
  return timingSafeEqual(expected, sig) ? { key, exp, disposition, contentType } : null;
}
