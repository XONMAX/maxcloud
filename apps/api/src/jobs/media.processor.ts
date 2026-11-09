import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { PrismaService } from '../common/prisma.service';
import { StorageService } from '../storage/storage.service';
import { config } from '../config';
import { clamScan } from './clamav';

const run = promisify(execFile);
const THUMB = 320;
/** Don't download giant files just for a thumbnail. */
const MAX_THUMB_SOURCE = 500 * 1024 * 1024;

async function hasBinary(bin: string) {
  try {
    await run('which', [bin]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Post-upload processing for one FileVersion:
 *  1. virus scan (ClamAV) — INFECTED versions can't be downloaded or shared
 *  2. thumbnail: images via sharp, video via ffmpeg (frame at 1s), PDF via pdftoppm (page 1)
 * Runs in the worker process; file bytes flow storage -> worker, never via the API.
 */
@Injectable()
export class MediaProcessor {
  private log = new Logger(MediaProcessor.name);
  private bins: Promise<{ ffmpeg: boolean; pdftoppm: boolean }> = Promise.all([hasBinary('ffmpeg'), hasBinary('pdftoppm')]).then(([ffmpeg, pdftoppm]) => ({ ffmpeg, pdftoppm }));

  constructor(private prisma: PrismaService, private storage: StorageService) {}

  async process(versionId: string) {
    const v = await this.prisma.fileVersion.findUnique({ where: { id: versionId }, include: { node: true } });
    if (!v) return { skipped: 'version deleted' };
    // Server-side content hash (browser uploads don't send one) so sync clients can compare files.
    if (!v.sha256) {
      const sha256 = await this.hash(v.storageKey);
      await this.prisma.fileVersion.update({ where: { id: v.id }, data: { sha256 } });
      await this.prisma.node.updateMany({ where: { id: v.nodeId, currentVersionId: v.id }, data: { sha256 } });
    }
    const scan = await this.scan(v.storageKey);
    await this.prisma.fileVersion.update({ where: { id: v.id }, data: { scanStatus: scan } });
    if (scan === 'INFECTED') {
      // Kill public links to the file; owner still sees it flagged in the UI.
      await this.prisma.shareLink.updateMany({ where: { nodeId: v.nodeId, revokedAt: null }, data: { revokedAt: new Date() } });
      return { scan };
    }
    const thumb = Number(v.size) <= MAX_THUMB_SOURCE ? await this.thumbnail(v.storageKey, v.mimeType) : null;
    if (thumb) {
      const key = `t/${v.node.ownerId}/${v.id}.webp`;
      await this.storage.put(key, thumb, 'image/webp');
      await this.prisma.fileVersion.update({ where: { id: v.id }, data: { thumbnailKey: key } });
      await this.prisma.node.updateMany({ where: { id: v.nodeId, currentVersionId: v.id }, data: { hasThumbnail: true } });
    }
    return { scan, thumbnail: !!thumb };
  }

  private async hash(key: string): Promise<string> {
    const h = createHash('sha256');
    for await (const chunk of await this.storage.getStream(key)) h.update(chunk as Buffer);
    return h.digest('hex');
  }

  private async scan(key: string): Promise<'CLEAN' | 'INFECTED' | 'SKIPPED'> {
    const c = config();
    if (!c.CLAMAV_HOST) return 'SKIPPED';
    const r = await clamScan(c.CLAMAV_HOST, c.CLAMAV_PORT, await this.storage.getStream(key));
    if (r.status === 'INFECTED') this.log.warn(`malware ${r.signature} in ${key}`);
    return r.status;
  }

  async thumbnail(key: string, mime: string): Promise<Buffer | null> {
    const bins = await this.bins;
    const isImage = mime.startsWith('image/') && !mime.includes('svg');
    const isVideo = mime.startsWith('video/') && bins.ffmpeg;
    const isPdf = mime === 'application/pdf' && bins.pdftoppm;
    if (!isImage && !isVideo && !isPdf) return null;
    const dir = await mkdtemp(join(tmpdir(), 'mc-thumb-'));
    try {
      const src = join(dir, 'src');
      await pipeline(await this.storage.getStream(key), createWriteStream(src));
      let still = src;
      if (isVideo) {
        still = join(dir, 'frame.png');
        // -ss before -i = fast seek; fall back to first frame for clips < 1s.
        await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', '1', '-i', src, '-frames:v', '1', '-y', still]).catch(() =>
          run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', src, '-frames:v', '1', '-y', still]),
        );
      } else if (isPdf) {
        await run('pdftoppm', ['-png', '-f', '1', '-l', '1', '-scale-to', String(THUMB * 2), '-singlefile', src, join(dir, 'page')]);
        still = join(dir, 'page.png');
      }
      return await sharp(await readFile(still), { failOn: 'none', limitInputPixels: 268_402_689 })
        .rotate()
        .resize(THUMB, THUMB, { fit: 'cover', withoutEnlargement: true })
        .webp({ quality: 72 })
        .toBuffer();
    } catch (e) {
      this.log.warn(`thumbnail failed for ${key} (${mime}): ${(e as Error).message}`);
      return null;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
