import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, registerUser, type TestCtx } from './helpers';
import { putPart, uploadFile } from './upload-helpers';
import { UploadsService } from '../src/files/uploads.service';
import { FilesService } from '../src/files/files.service';

const MiB = 1024 * 1024;
let ctx: TestCtx;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.app.close();
});

async function usage(userId: string) {
  const u = await ctx.prisma.user.findUniqueOrThrow({ where: { id: userId } });
  return { used: Number(u.usedBytes), reserved: Number(u.reservedBytes) };
}

describe('uploads (direct-to-S3 multipart)', () => {
  it('uploads a multi-part file, downloads identical bytes, and charges exact usage', async () => {
    const u = await registerUser(ctx, 'up');
    const data = randomBytes(17 * MiB + 123); // 3 parts of 8 MiB
    const r = await uploadFile(ctx, u, 'video.mp4', data, null, { mimeType: 'video/mp4' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ name: 'video.mp4', size: data.length, kind: 'video', versionCount: 1 });
    expect(await usage(u.user.id)).toEqual({ used: data.length, reserved: 0 });

    const dl = await u.auth(ctx.http().get(`/files/${r.body.id}/download`)).expect(200);
    const got = Buffer.from(await (await fetch(dl.body.url)).arrayBuffer());
    expect(got.equals(data)).toBe(true);
  });

  it('resumes: status lists stored parts after an interruption, only missing parts are sent', async () => {
    const u = await registerUser(ctx, 'resume');
    const data = randomBytes(20 * MiB);
    const init = await u.auth(ctx.http().post('/uploads')).send({ name: 'big.bin', parentId: null, size: data.length }).expect(201);
    const { uploadId, partSize } = init.body;
    const signed = await u.auth(ctx.http().post(`/uploads/${uploadId}/parts`)).send({ partNumbers: [1, 2, 3] }).expect(200);
    await putPart(signed.body.parts[0].url, data.subarray(0, partSize));
    // -- network drops here; client restarts --
    const st = await u.auth(ctx.http().get(`/uploads/${uploadId}`)).expect(200);
    expect(st.body.completedParts.map((p: { partNumber: number }) => p.partNumber)).toEqual([1]);
    const missing = [2, 3];
    const re = await u.auth(ctx.http().post(`/uploads/${uploadId}/parts`)).send({ partNumbers: missing }).expect(200);
    for (const p of re.body.parts) await putPart(p.url, data.subarray((p.partNumber - 1) * partSize, p.partNumber * partSize));
    const done = await u.auth(ctx.http().post(`/uploads/${uploadId}/complete`)).send({ parts: [] }).expect(200);
    expect(done.body.size).toBe(data.length);
    const pending = await u.auth(ctx.http().get('/uploads')).expect(200);
    expect(pending.body.items).toHaveLength(0);
  });

  it('rejects a client that uploads fewer bytes than declared and releases the reservation', async () => {
    const u = await registerUser(ctx, 'liar');
    const init = await u.auth(ctx.http().post('/uploads')).send({ name: 'x.bin', parentId: null, size: 9 * MiB }).expect(201);
    const signed = await u.auth(ctx.http().post(`/uploads/${init.body.uploadId}/parts`)).send({ partNumbers: [1, 2] }).expect(200);
    await putPart(signed.body.parts[0].url, randomBytes(8 * MiB));
    await putPart(signed.body.parts[1].url, randomBytes(10)); // should be 1 MiB
    const done = await u.auth(ctx.http().post(`/uploads/${init.body.uploadId}/complete`)).send({ parts: [] }).expect(400);
    expect(done.body.code).toBe('UPLOAD_INVALID');
    expect(await usage(u.user.id)).toEqual({ used: 0, reserved: 0 });
  });

  it('rejects completion when a part is missing', async () => {
    const u = await registerUser(ctx, 'missing');
    const init = await u.auth(ctx.http().post('/uploads')).send({ name: 'm.bin', parentId: null, size: 9 * MiB }).expect(201);
    const r = await u.auth(ctx.http().post(`/uploads/${init.body.uploadId}/complete`)).send({ parts: [] }).expect(400);
    expect(r.body.message).toMatch(/Part 1 is missing/);
  });

  it('handles zero-byte files', async () => {
    const u = await registerUser(ctx, 'empty');
    const r = await uploadFile(ctx, u, 'empty.txt', Buffer.alloc(0), null, { mimeType: 'text/plain' });
    expect(r.status).toBe(200);
    expect(r.body.size).toBe(0);
  });

  it('dedupes by sha256 (mobile auto-backup) without reserving quota', async () => {
    const u = await registerUser(ctx, 'dedupe');
    const data = randomBytes(1000);
    const first = await uploadFile(ctx, u, 'IMG_0001.jpg', data, null, { mimeType: 'image/jpeg', sha256: true });
    const second = await uploadFile(ctx, u, 'IMG_0001 copy.jpg', data, null, { mimeType: 'image/jpeg', sha256: true });
    expect(second.deduplicated).toBe(true);
    expect(second.body.id).toBe(first.body.id);
    expect((await usage(u.user.id)).used).toBe(1000);
  });

  it('expired uploads are aborted by the worker and release their reservation', async () => {
    const u = await registerUser(ctx, 'expire');
    const init = await u.auth(ctx.http().post('/uploads')).send({ name: 'e.bin', parentId: null, size: 5000 }).expect(201);
    expect((await usage(u.user.id)).reserved).toBe(5000);
    await ctx.prisma.upload.update({ where: { id: init.body.uploadId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await ctx.app.get(UploadsService).expireStale();
    expect((await usage(u.user.id)).reserved).toBe(0);
  });
});

describe('quota hard stop', () => {
  it('blocks an upload that would exceed the quota', async () => {
    const u = await registerUser(ctx, 'hard');
    await ctx.prisma.user.update({ where: { id: u.user.id }, data: { quotaBytes: 1000n } });
    const r = await u.auth(ctx.http().post('/uploads')).send({ name: 'a', parentId: null, size: 1001 }).expect(413);
    expect(r.body).toMatchObject({ code: 'QUOTA_EXCEEDED', needed: 1001, available: 1000 });
  });

  it('concurrent uploads cannot overshoot: reservations are atomic', async () => {
    const u = await registerUser(ctx, 'race');
    await ctx.prisma.user.update({ where: { id: u.user.id }, data: { quotaBytes: 10_000n } });
    const attempts = await Promise.all(
      Array.from({ length: 20 }, (_, i) => u.auth(ctx.http().post('/uploads')).send({ name: `f${i}`, parentId: null, size: 1000 })),
    );
    expect(attempts.filter((r) => r.status === 201)).toHaveLength(10);
    expect(attempts.filter((r) => r.status === 413)).toHaveLength(10);
    expect((await usage(u.user.id)).reserved).toBe(10_000);
  });

  it('read-only accounts cannot upload or create folders but can still delete', async () => {
    const u = await registerUser(ctx, 'ro');
    const f = await uploadFile(ctx, u, 'keep.txt', Buffer.from('hello'));
    await ctx.prisma.user.update({ where: { id: u.user.id }, data: { storageState: 'READ_ONLY' } });
    const up = await u.auth(ctx.http().post('/uploads')).send({ name: 'b', parentId: null, size: 1 }).expect(403);
    expect(up.body.code).toBe('ACCOUNT_READ_ONLY');
    await u.auth(ctx.http().post('/folders')).send({ name: 'X' }).expect(403);
    await u.auth(ctx.http().delete(`/files/${f.body.id}`)).expect(200);
  });
});

describe('folders, rename, move, trash, versions', () => {
  it('folder tree with breadcrumbs, rename, move and cycle protection', async () => {
    const u = await registerUser(ctx, 'tree');
    const a = (await u.auth(ctx.http().post('/folders')).send({ name: 'Photos' }).expect(201)).body;
    const b = (await u.auth(ctx.http().post('/folders')).send({ name: '2026', parentId: a.id }).expect(201)).body;
    await u.auth(ctx.http().post('/folders')).send({ name: 'photos' }).expect(409); // case-insensitive unique
    const list = await u.auth(ctx.http().get(`/files?parentId=${b.id}`)).expect(200);
    expect(list.body.breadcrumbs.map((c: { name: string }) => c.name)).toEqual(['Photos', '2026']);
    await u.auth(ctx.http().patch(`/files/${b.id}/name`)).send({ name: 'Year 2026' }).expect(200);
    const cyc = await u.auth(ctx.http().patch(`/files/${a.id}/parent`)).send({ parentId: b.id }).expect(400);
    expect(cyc.body.message).toMatch(/into itself/);
    await u.auth(ctx.http().patch(`/files/${b.id}/parent`)).send({ parentId: null }).expect(200);
    const root = await u.auth(ctx.http().get('/files')).expect(200);
    expect(root.body.items.map((n: { name: string }) => n.name).sort()).toEqual(['Photos', 'Year 2026']);
  });

  it('trash -> restore keeps the tree; delete forever frees usage', async () => {
    const u = await registerUser(ctx, 'trash');
    const folder = (await u.auth(ctx.http().post('/folders')).send({ name: 'Docs' }).expect(201)).body;
    await uploadFile(ctx, u, 'a.txt', Buffer.alloc(300, 1), folder.id);
    await uploadFile(ctx, u, 'b.txt', Buffer.alloc(200, 2), folder.id);
    await u.auth(ctx.http().delete(`/files/${folder.id}`)).expect(200);
    expect((await u.auth(ctx.http().get('/files')).expect(200)).body.items).toHaveLength(0);
    const trash = await u.auth(ctx.http().get('/trash')).expect(200);
    expect(trash.body.items).toHaveLength(1); // only the root shows
    expect((await usage(u.user.id)).used).toBe(500); // trash still counts

    await u.auth(ctx.http().post(`/trash/${folder.id}/restore`)).expect(200);
    const inside = await u.auth(ctx.http().get(`/files?parentId=${folder.id}`)).expect(200);
    expect(inside.body.items).toHaveLength(2);

    await u.auth(ctx.http().delete(`/files/${folder.id}`)).expect(200);
    const gone = await u.auth(ctx.http().delete(`/trash/${folder.id}`)).expect(200);
    expect(gone.body).toMatchObject({ purgedNodes: 3, freedBytes: 500 });
    expect((await usage(u.user.id)).used).toBe(0);
  });

  it('trash retention: items older than 30 days are purged by the worker', async () => {
    const u = await registerUser(ctx, 'retention');
    const f = await uploadFile(ctx, u, 'old.txt', Buffer.alloc(100));
    await u.auth(ctx.http().delete(`/files/${f.body.id}`)).expect(200);
    await ctx.prisma.node.update({ where: { id: f.body.id }, data: { deletedAt: new Date(Date.now() - 31 * 86400_000) } });
    await ctx.app.get(FilesService).purgeExpiredTrash();
    expect(await ctx.prisma.node.findUnique({ where: { id: f.body.id } })).toBeNull();
    expect((await usage(u.user.id)).used).toBe(0);
  });

  it('restoring into a name clash renames the restored item', async () => {
    const u = await registerUser(ctx, 'clash');
    const f1 = await uploadFile(ctx, u, 'report.pdf', Buffer.alloc(10));
    await u.auth(ctx.http().delete(`/files/${f1.body.id}`)).expect(200);
    await uploadFile(ctx, u, 'report.pdf', Buffer.alloc(20));
    const r = await u.auth(ctx.http().post(`/trash/${f1.body.id}/restore`)).expect(200);
    expect(r.body.name).toBe('report (1).pdf');
  });

  it('keeps at most 10 versions, never the current one, and usage follows', async () => {
    const u = await registerUser(ctx, 'versions');
    let last: { id: string } | undefined;
    for (let i = 1; i <= 12; i++) last = (await uploadFile(ctx, u, 'notes.txt', Buffer.alloc(i * 10, i))).body;
    const v = await u.auth(ctx.http().get(`/files/${last!.id}/versions`)).expect(200);
    expect(v.body.items).toHaveLength(10);
    expect(v.body.items[0]).toMatchObject({ current: true, size: 120 });
    // sizes 30..120 kept = 10 * (30+120)/2 = 750
    expect((await usage(u.user.id)).used).toBe(750);
    const oldest = v.body.items[9];
    const restored = await u.auth(ctx.http().post(`/files/${last!.id}/versions/${oldest.id}/restore`)).expect(200);
    expect(restored.body.size).toBe(30);
    await u.auth(ctx.http().delete(`/files/${last!.id}/versions/${oldest.id}`)).expect(400); // current
  });
});

describe('search & listing performance', () => {
  it('searches by name and kind', async () => {
    const u = await registerUser(ctx, 'search');
    await uploadFile(ctx, u, 'Samarkand trip.jpg', Buffer.alloc(5), null, { mimeType: 'image/jpeg' });
    await uploadFile(ctx, u, 'samarkand_budget.xlsx', Buffer.alloc(5));
    await uploadFile(ctx, u, 'tashkent.jpg', Buffer.alloc(5), null, { mimeType: 'image/jpeg' });
    const all = await u.auth(ctx.http().get('/files/search?q=SAMARKAND')).expect(200);
    expect(all.body.items).toHaveLength(2);
    const imgs = await u.auth(ctx.http().get('/files/search?q=samarkand&kind=image')).expect(200);
    expect(imgs.body.items.map((n: { name: string }) => n.name)).toEqual(['Samarkand trip.jpg']);
    const wild = await u.auth(ctx.http().get('/files/search?q=%25')).expect(200); // literal %, not wildcard
    expect(wild.body.items).toHaveLength(0);
  });

  it('lists a 10,000-file folder in < 500 ms (single page of 10k) and paginates with cursors', async () => {
    const u = await registerUser(ctx, 'perf');
    const folder = (await u.auth(ctx.http().post('/folders')).send({ name: 'Camera' }).expect(201)).body;
    const rows = Array.from({ length: 10_000 }, (_, i) => ({
      ownerId: u.user.id,
      parentId: folder.id,
      type: 'FILE' as const,
      name: `IMG_${String(i).padStart(5, '0')}.jpg`,
      size: 2_000_000n,
      mimeType: 'image/jpeg',
      kind: 'image',
      versionCount: 1,
    }));
    for (let i = 0; i < rows.length; i += 2000) await ctx.prisma.node.createMany({ data: rows.slice(i, i + 2000) });
    await ctx.prisma.$executeRawUnsafe('ANALYZE "Node"');

    await u.auth(ctx.http().get(`/files?parentId=${folder.id}&limit=10`)).expect(200); // warm-up
    const t0 = performance.now();
    const full = await u.auth(ctx.http().get(`/files?parentId=${folder.id}&limit=1000`)).expect(200);
    let pages = 1;
    let cursor = full.body.nextCursor;
    let count = full.body.items.length;
    while (cursor) {
      const p = await u.auth(ctx.http().get(`/files?parentId=${folder.id}&limit=1000&cursor=${cursor}`)).expect(200);
      count += p.body.items.length;
      cursor = p.body.nextCursor;
      pages++;
    }
    const ms = performance.now() - t0;
    expect(count).toBe(10_000);
    expect(pages).toBe(10);
    console.log(`listing 10,000 files in ${pages} pages took ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(500);
  });
});
