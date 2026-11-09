import { Injectable, Logger } from '@nestjs/common';
import { createId } from './ids';
import { fileKind, type UploadSessionDto } from '@maxcloud/shared';
import type { Upload } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { Errors } from '../common/errors';
import { toNodeDto } from '../common/serialize';
import { uploadBytes, uploadsCompleted } from '../common/metrics';
import { StorageService } from '../storage/storage.service';
import { QuotaService } from '../quota/quota.service';
import { QueueService } from '../jobs/queue.service';
import { AccessService } from './access.service';
import { FilesService } from './files.service';

const MiB = 1024 * 1024;
/** 8 MiB parts: small enough to retry cheaply on mobile, B2/S3 minimum is 5 MiB. Max 10,000 parts. */
export function partSizeFor(size: number) {
  const min = 8 * MiB;
  const needed = Math.ceil(size / 10_000);
  return Math.max(min, Math.ceil(needed / MiB) * MiB);
}
const UPLOAD_TTL_MS = 24 * 3600_000;

/**
 * Resumable, direct-to-storage uploads (S3 multipart):
 *  1. POST /uploads            -> reserve quota, create multipart upload
 *  2. POST /uploads/:id/parts  -> presigned PUT URLs (client PUTs bytes straight to S3)
 *  3. GET  /uploads/:id        -> parts already stored (resume after network loss/reload)
 *  4. POST /uploads/:id/complete -> server verifies every part with ListParts + HeadObject, then commits usage
 * The API never sees file bytes.
 */
@Injectable()
export class UploadsService {
  private log = new Logger(UploadsService.name);
  constructor(
    private prisma: PrismaService,
    private storage: StorageService,
    private quota: QuotaService,
    private access: AccessService,
    private files: FilesService,
    private queues: QueueService,
  ) {}

  private async ownerFor(userId: string, parentId: string | null) {
    if (!parentId) return userId;
    const { node } = await this.access.resolve(userId, parentId, 'EDITOR');
    if (node.type !== 'FOLDER') throw Errors.bad('Parent is not a folder');
    return node.ownerId;
  }

  private partCount(u: Pick<Upload, 'size' | 'partSize'>) {
    return Math.max(1, Math.ceil(Number(u.size) / u.partSize));
  }

  private session(u: Upload, completedParts: UploadSessionDto['completedParts'] = []): UploadSessionDto {
    return { uploadId: u.id, partSize: u.partSize, partCount: this.partCount(u), expiresAt: u.expiresAt.toISOString(), completedParts, deduplicatedNode: null };
  }

  async init(userId: string, input: { name: string; parentId: string | null; size: number; mimeType: string; sha256?: string; dedupe?: boolean }): Promise<UploadSessionDto> {
    const ownerId = await this.ownerFor(userId, input.parentId);
    const existing = await this.prisma.node.findFirst({
      where: { ownerId, parentId: input.parentId, deletedAt: null, name: { equals: input.name, mode: 'insensitive' } },
    });
    if (existing?.type === 'FOLDER') throw Errors.conflict('A folder with this name already exists here');

    // Dedupe (mobile auto-backup): identical content already stored for this owner -> no upload needed.
    if (input.sha256 && input.dedupe) {
      const dup = await this.prisma.node.findFirst({ where: { ownerId, deletedAt: null, type: 'FILE', sha256: input.sha256, size: BigInt(input.size) } });
      if (dup) {
        return { uploadId: '', partSize: 0, partCount: 0, expiresAt: new Date().toISOString(), completedParts: [], deduplicatedNode: toNodeDto(dup) };
      }
    }

    await this.quota.reserve(ownerId, input.size);
    const versionId = createId();
    const storageKey = `u/${ownerId}/${versionId}`;
    try {
      const partSize = partSizeFor(input.size);
      const s3UploadId = await this.storage.createMultipart(storageKey, input.mimeType);
      const upload = await this.prisma.upload.create({
        data: {
          ownerId,
          uploaderId: userId,
          s3UploadId,
          storageKey,
          versionId,
          name: input.name,
          parentId: input.parentId,
          size: BigInt(input.size),
          partSize,
          mimeType: input.mimeType,
          sha256: input.sha256,
          expiresAt: new Date(Date.now() + UPLOAD_TTL_MS),
        },
      });
      return this.session(upload);
    } catch (e) {
      await this.quota.release(ownerId, input.size);
      throw e;
    }
  }

  private async load(userId: string, uploadId: string) {
    const u = await this.prisma.upload.findUnique({ where: { id: uploadId } });
    if (!u || u.uploaderId !== userId) throw Errors.notFound('Upload');
    if (u.status !== 'PENDING') throw Errors.bad(`Upload is ${u.status.toLowerCase()}`, 'UPLOAD_INVALID');
    if (u.expiresAt < new Date()) throw Errors.bad('Upload expired, start again', 'UPLOAD_INVALID');
    return u;
  }

  async presignParts(userId: string, uploadId: string, partNumbers: number[]) {
    const u = await this.load(userId, uploadId);
    const count = this.partCount(u);
    if (partNumbers.some((n) => n > count)) throw Errors.bad(`Part numbers must be between 1 and ${count}`);
    const urls = await Promise.all(partNumbers.map(async (n) => ({ partNumber: n, url: await this.storage.presignPart(u.storageKey, u.s3UploadId, n) })));
    return { parts: urls };
  }

  async status(userId: string, uploadId: string): Promise<UploadSessionDto> {
    const u = await this.load(userId, uploadId);
    const parts = await this.storage.listParts(u.storageKey, u.s3UploadId);
    return this.session(
      u,
      parts.map((p) => ({ partNumber: p.PartNumber!, etag: p.ETag!, size: Number(p.Size ?? 0) })),
    );
  }

  /** Pending uploads of this user (lets a reloaded tab resume). */
  async listPending(userId: string) {
    const ups = await this.prisma.upload.findMany({ where: { uploaderId: userId, status: 'PENDING', expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' }, take: 100 });
    return { items: ups.map((u) => ({ ...this.session(u), name: u.name, size: Number(u.size), parentId: u.parentId })) };
  }

  async complete(userId: string, uploadId: string, clientParts: { partNumber: number; etag: string }[]) {
    const u = await this.load(userId, uploadId);
    const declared = Number(u.size);
    const count = this.partCount(u);

    if (declared === 0) {
      // Empty files: S3 multipart needs >=1 part; write a zero-byte object server-side instead.
      await this.storage.abortMultipart(u.storageKey, u.s3UploadId);
      await this.storage.put(u.storageKey, Buffer.alloc(0), u.mimeType);
    } else {
      // Never trust the client: compare with what storage actually holds.
      const stored = await this.storage.listParts(u.storageKey, u.s3UploadId);
      const byNum = new Map(stored.map((p) => [p.PartNumber!, p]));
      let total = 0;
      for (let n = 1; n <= count; n++) {
        const p = byNum.get(n);
        if (!p) throw Errors.bad(`Part ${n} is missing`, 'UPLOAD_INVALID');
        const size = Number(p.Size ?? 0);
        const expected = n < count ? u.partSize : declared - u.partSize * (count - 1);
        if (size !== expected) return this.reject(u, `Part ${n} has ${size} bytes, expected ${expected}`);
        const claimed = clientParts.find((c) => c.partNumber === n);
        if (claimed && claimed.etag.replace(/"/g, '') !== String(p.ETag).replace(/"/g, '')) throw Errors.bad(`Part ${n} ETag mismatch`, 'UPLOAD_INVALID');
        total += size;
      }
      if (byNum.size > count) return this.reject(u, 'Unexpected extra parts');
      if (total !== declared) return this.reject(u, `Uploaded ${total} bytes, declared ${declared}`);
      await this.storage.completeMultipart(
        u.storageKey,
        u.s3UploadId,
        [...byNum.values()].map((p) => ({ partNumber: p.PartNumber!, etag: p.ETag! })),
      );
    }
    const head = await this.storage.head(u.storageKey);
    if (!head || head.size !== declared) return this.reject(u, 'Stored object size mismatch', true);

    const kind = fileKind(u.mimeType, u.name);
    const node = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.upload.updateMany({ where: { id: u.id, status: 'PENDING' }, data: { status: 'COMPLETED', completedAt: new Date() } });
      if (claimed.count !== 1) throw Errors.bad('Upload already completed', 'UPLOAD_INVALID');
      await this.quota.commit(u.ownerId, declared, declared, tx);

      const existing = await tx.node.findFirst({
        where: { ownerId: u.ownerId, parentId: u.parentId, deletedAt: null, name: { equals: u.name, mode: 'insensitive' }, type: 'FILE' },
      });
      const nodeId = existing?.id ?? createId();
      if (!existing) {
        await tx.node.create({ data: { id: nodeId, ownerId: u.ownerId, parentId: u.parentId, type: 'FILE', name: u.name, mimeType: u.mimeType, kind } });
      }
      await tx.fileVersion.create({
        data: { id: u.versionId, nodeId, storageKey: u.storageKey, size: u.size, sha256: u.sha256, mimeType: u.mimeType, uploadedById: u.uploaderId },
      });
      return tx.node.update({
        where: { id: nodeId },
        data: { currentVersionId: u.versionId, size: u.size, mimeType: u.mimeType, kind, sha256: u.sha256, hasThumbnail: false, versionCount: { increment: 1 } },
      });
    });

    uploadsCompleted.inc();
    uploadBytes.inc(declared);
    await this.files.pruneVersions(node.id);
    await this.queues.enqueueMedia(u.versionId).catch((e) => this.log.error(`enqueue media failed: ${e.message}`));
    return toNodeDto(await this.prisma.node.findUniqueOrThrow({ where: { id: node.id } }));
  }

  private async reject(u: Upload, reason: string, objectWritten = false): Promise<never> {
    this.log.warn(`upload ${u.id} rejected: ${reason}`);
    await this.cancel(u, objectWritten);
    throw Errors.bad(reason, 'UPLOAD_INVALID');
  }

  private async cancel(u: Upload, objectWritten = false) {
    const res = await this.prisma.upload.updateMany({ where: { id: u.id, status: 'PENDING' }, data: { status: 'ABORTED' } });
    if (res.count !== 1) return;
    await this.quota.release(u.ownerId, Number(u.size));
    await this.storage.abortMultipart(u.storageKey, u.s3UploadId);
    if (objectWritten) await this.storage.deleteMany([u.storageKey]);
  }

  async abort(userId: string, uploadId: string) {
    const u = await this.prisma.upload.findUnique({ where: { id: uploadId } });
    if (!u || u.uploaderId !== userId) throw Errors.notFound('Upload');
    await this.cancel(u);
    return { ok: true };
  }

  /** Worker: abort expired uploads so reservations (and B2 storage of orphan parts) are released. */
  async expireStale(now = new Date()) {
    const stale = await this.prisma.upload.findMany({ where: { status: 'PENDING', expiresAt: { lt: now } }, take: 500 });
    for (const u of stale) await this.cancel(u);
    return stale.length;
  }
}
