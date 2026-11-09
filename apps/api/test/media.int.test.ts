import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, registerUser, type TestCtx } from './helpers';
import { uploadFile } from './upload-helpers';
import { MediaProcessor } from '../src/jobs/media.processor';
import { PrismaService } from '../src/common/prisma.service';
import { StorageService } from '../src/storage/storage.service';
import { resetConfig } from '../src/config';

let ctx: TestCtx;
let media: MediaProcessor;
let clamd: Server;
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

beforeAll(async () => {
  // Fake clamd speaking the INSTREAM protocol: flags the EICAR test string.
  clamd = createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.subarray(-4).readUInt32BE(0) === 0) {
        sock.end(buf.includes(Buffer.from('EICAR-STANDARD')) ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
      }
    });
  }).listen(0);
  await new Promise((r) => clamd.once('listening', r));
  process.env.CLAMAV_HOST = '127.0.0.1';
  process.env.CLAMAV_PORT = String((clamd.address() as { port: number }).port);
  resetConfig();
  ctx = await createTestApp();
  media = new MediaProcessor(ctx.app.get(PrismaService), ctx.app.get(StorageService));
});
afterAll(async () => {
  await ctx.app.close();
  clamd.close();
  delete process.env.CLAMAV_HOST;
  resetConfig();
});

async function pdf(): Promise<Buffer> {
  const doc = new PDFDocument();
  const chunks: Buffer[] = [];
  doc.on('data', (c) => chunks.push(c));
  doc.fontSize(40).text('MaxCloud invoice', 100, 100);
  doc.end();
  await new Promise((r) => doc.on('end', r));
  return Buffer.concat(chunks);
}

describe('media processing', () => {
  it('image -> webp thumbnail, clean scan, node.hasThumbnail', async () => {
    const u = await registerUser(ctx, 'img');
    const png = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#3366ff' } }).png().toBuffer();
    const f = await uploadFile(ctx, u, 'photo.png', png, null, { mimeType: 'image/png' });
    const node = await ctx.prisma.node.findUniqueOrThrow({ where: { id: f.body.id } });
    expect(await media.process(node.currentVersionId!)).toEqual({ scan: 'CLEAN', thumbnail: true });
    const t = await u.auth(ctx.http().get(`/files/${f.body.id}/thumbnail`)).expect(200);
    const meta = await sharp(Buffer.from(await (await fetch(t.body.url)).arrayBuffer())).metadata();
    expect(meta).toMatchObject({ format: 'webp', width: 320, height: 320 });
    const list = await u.auth(ctx.http().get('/files')).expect(200);
    expect(list.body.items[0].hasThumbnail).toBe(true);
  });

  it('video (ffmpeg) and PDF (pdftoppm) thumbnails', async () => {
    const u = await registerUser(ctx, 'vid');
    const dir = mkdtempSync(join(tmpdir(), 'mc-test-'));
    execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=640x360:rate=10', '-pix_fmt', 'yuv420p', join(dir, 'v.mp4')]);
    const v = await uploadFile(ctx, u, 'clip.mp4', readFileSync(join(dir, 'v.mp4')), null, { mimeType: 'video/mp4' });
    const p = await uploadFile(ctx, u, 'doc.pdf', await pdf(), null, { mimeType: 'application/pdf' });
    for (const id of [v.body.id, p.body.id]) {
      const n = await ctx.prisma.node.findUniqueOrThrow({ where: { id } });
      expect((await media.process(n.currentVersionId!)).thumbnail).toBe(true);
    }
  });

  it('EICAR is flagged INFECTED: download blocked, public links revoked', async () => {
    const u = await registerUser(ctx, 'virus');
    const f = await uploadFile(ctx, u, 'eicar.com', Buffer.from(EICAR));
    const link = await u.auth(ctx.http().post('/share-links')).send({ nodeId: f.body.id }).expect(201);
    const n = await ctx.prisma.node.findUniqueOrThrow({ where: { id: f.body.id } });
    expect((await media.process(n.currentVersionId!)).scan).toBe('INFECTED');
    const dl = await u.auth(ctx.http().get(`/files/${f.body.id}/download`)).expect(403);
    expect(dl.body.message).toMatch(/malware/);
    await ctx.http().get(`/public/shares/${link.body.token}`).expect(404);
  });
});
