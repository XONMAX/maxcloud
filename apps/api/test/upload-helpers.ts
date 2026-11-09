import { createHash } from 'node:crypto';
import type { TestCtx } from './helpers';
import type { registerUser } from './helpers';

type U = Awaited<ReturnType<typeof registerUser>>;

/** PUT one part straight to storage via its presigned URL (what browsers/mobile do). */
export async function putPart(url: string, body: Buffer): Promise<string> {
  const res = await fetch(url, { method: 'PUT', body: new Uint8Array(body) });
  if (!res.ok) throw new Error(`PUT part failed ${res.status}: ${await res.text()}`);
  return res.headers.get('etag')!;
}

export async function uploadFile(ctx: TestCtx, u: U, name: string, data: Buffer, parentId: string | null = null, opts: { mimeType?: string; sha256?: boolean } = {}) {
  const init = await u
    .auth(ctx.http().post('/uploads'))
    .send({ name, parentId, size: data.length, mimeType: opts.mimeType ?? 'application/octet-stream', sha256: opts.sha256 ? createHash('sha256').update(data).digest('hex') : undefined });
  if (init.status !== 201) return { status: init.status, body: init.body };
  if (init.body.deduplicatedNode) return { status: 200, body: init.body.deduplicatedNode, deduplicated: true };
  const { uploadId, partSize, partCount } = init.body;
  const parts: { partNumber: number; etag: string }[] = [];
  if (data.length > 0) {
    const nums = Array.from({ length: partCount }, (_, i) => i + 1);
    const signed = await u.auth(ctx.http().post(`/uploads/${uploadId}/parts`)).send({ partNumbers: nums }).expect(200);
    for (const p of signed.body.parts) {
      const chunk = data.subarray((p.partNumber - 1) * partSize, p.partNumber * partSize);
      parts.push({ partNumber: p.partNumber, etag: await putPart(p.url, chunk) });
    }
  }
  const done = await u.auth(ctx.http().post(`/uploads/${uploadId}/complete`)).send({ parts });
  return { status: done.status, body: done.body, uploadId };
}
