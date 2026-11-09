import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type Node } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { QUOTA_POLICY, formatBytes, type FileKind } from '@maxcloud/shared';
import { PrismaService } from '../common/prisma.service';
import { Errors } from '../common/errors';
import { toNodeDto } from '../common/serialize';
import { StorageService } from '../storage/storage.service';
import { QuotaService } from '../quota/quota.service';
import { MailService } from '../mail/mail.service';
import { AccessService, type Role } from './access.service';

export interface ListOptions {
  parentId?: string;
  cursor?: string;
  limit: number;
  sort: 'name' | 'updatedAt' | 'size';
}

function escapeLike(s: string) {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

@Injectable()
export class FilesService {
  private log = new Logger(FilesService.name);
  constructor(
    private prisma: PrismaService,
    private access: AccessService,
    private storage: StorageService,
    private quota: QuotaService,
    private mail: MailService,
  ) {}

  // ---------------- listing ----------------
  async list(userId: string, o: ListOptions) {
    let role: Role = 'OWNER';
    let where: Prisma.NodeWhereInput;
    let breadcrumbs: { id: string; name: string }[] = [];
    if (o.parentId) {
      const r = await this.access.resolve(userId, o.parentId, 'VIEWER');
      if (r.node.type !== 'FOLDER') throw Errors.bad('Not a folder');
      role = r.role;
      where = { parentId: o.parentId, deletedAt: null };
      breadcrumbs = await this.breadcrumbs(userId, o.parentId, role);
    } else {
      where = { ownerId: userId, parentId: null, deletedAt: null };
    }
    const orderBy: Prisma.NodeOrderByWithRelationInput[] =
      o.sort === 'name' ? [{ type: 'asc' }, { name: 'asc' }, { id: 'asc' }] : [{ type: 'asc' }, { [o.sort]: 'desc' }, { id: 'desc' }];
    const rows = await this.prisma.node.findMany({
      where,
      orderBy,
      take: o.limit + 1,
      ...(o.cursor ? { cursor: { id: o.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > o.limit;
    const items = hasMore ? rows.slice(0, o.limit) : rows;
    return { items: items.map(toNodeDto), nextCursor: hasMore ? items[items.length - 1].id : null, role, breadcrumbs };
  }

  /** Breadcrumbs; grantees only see the path from the folder shared with them. */
  private async breadcrumbs(userId: string, nodeId: string, role: Role) {
    const path = await this.access.path(nodeId);
    if (role === 'OWNER') return path.map(({ id, name }) => ({ id, name }));
    const shares = await this.prisma.folderShare.findMany({ where: { granteeId: userId, nodeId: { in: path.map((p) => p.id) } }, select: { nodeId: true } });
    const idx = path.findIndex((p) => shares.some((s) => s.nodeId === p.id));
    return path.slice(Math.max(0, idx)).map(({ id, name }) => ({ id, name }));
  }

  async get(userId: string, nodeId: string) {
    const { node, role } = await this.access.resolve(userId, nodeId, 'VIEWER');
    return { node: toNodeDto(node), role };
  }

  async search(userId: string, q: string, kind: FileKind | undefined, limit: number) {
    const pattern = `%${escapeLike(q.toLowerCase())}%`;
    const ids = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Node"
      WHERE "ownerId" = ${userId} AND "deletedAt" IS NULL
        AND lower(name) LIKE ${pattern}
        ${kind ? Prisma.sql`AND kind = ${kind}` : Prisma.empty}
      ORDER BY "updatedAt" DESC
      LIMIT ${limit}`;
    const nodes = await this.prisma.node.findMany({ where: { id: { in: ids.map((r) => r.id) } } });
    const order = new Map(ids.map((r, i) => [r.id, i]));
    return { items: nodes.sort((a, b) => order.get(a.id)! - order.get(b.id)!).map(toNodeDto) };
  }

  async sharedWithMe(userId: string) {
    const shares = await this.prisma.folderShare.findMany({
      where: { granteeId: userId, node: { deletedAt: null } },
      include: { node: { include: { owner: { select: { name: true, email: true } } } } },
      orderBy: { createdAt: 'desc' },
    });
    return {
      items: shares.map((s) => ({ ...toNodeDto(s.node), role: s.role, sharedBy: { name: s.node.owner.name, email: s.node.owner.email } })),
    };
  }

  // ---------------- mutations ----------------
  async createFolder(userId: string, name: string, parentId: string | null) {
    let ownerId = userId;
    if (parentId) {
      const { node } = await this.access.resolve(userId, parentId, 'EDITOR');
      if (node.type !== 'FOLDER') throw Errors.bad('Parent is not a folder');
      ownerId = node.ownerId;
    }
    await this.quota.assertWritable(ownerId);
    const folder = await this.prisma.node.create({ data: { ownerId, parentId, type: 'FOLDER', name } });
    return toNodeDto(folder);
  }

  async rename(userId: string, nodeId: string, name: string) {
    const { node } = await this.access.resolve(userId, nodeId, 'EDITOR');
    await this.quota.assertWritable(node.ownerId);
    return toNodeDto(await this.prisma.node.update({ where: { id: nodeId }, data: { name } }));
  }

  async move(userId: string, nodeId: string, parentId: string | null) {
    const { node, role } = await this.access.resolve(userId, nodeId, 'EDITOR');
    await this.quota.assertWritable(node.ownerId);
    if (parentId) {
      const target = await this.access.resolve(userId, parentId, 'EDITOR');
      if (target.node.type !== 'FOLDER') throw Errors.bad('Target is not a folder');
      // Bytes are billed to the owner, so items can't hop between accounts.
      if (target.node.ownerId !== node.ownerId) throw Errors.bad('Items can only be moved within the same owner\'s storage');
      if (node.type === 'FOLDER' && (await this.access.isWithin(parentId, nodeId))) throw Errors.bad('A folder cannot be moved into itself');
    } else if (role !== 'OWNER') {
      throw Errors.forbidden('Only the owner can move items to their root');
    }
    return toNodeDto(await this.prisma.node.update({ where: { id: nodeId }, data: { parentId } }));
  }

  /** Soft delete: node + live descendants move to Trash as one batch (30-day recovery). */
  async trash(userId: string, nodeId: string) {
    const { node } = await this.access.resolve(userId, nodeId, 'EDITOR');
    const batch = randomUUID();
    const now = new Date();
    await this.prisma.$executeRaw`
      WITH RECURSIVE sub AS (
        SELECT id FROM "Node" WHERE id = ${node.id}
        UNION ALL
        SELECT n.id FROM "Node" n JOIN sub s ON n."parentId" = s.id WHERE n."deletedAt" IS NULL
      )
      UPDATE "Node" SET "deletedAt" = ${now}, "trashBatchId" = ${batch}, "trashRoot" = (id = ${node.id})
      WHERE id IN (SELECT id FROM sub) AND "deletedAt" IS NULL`;
    return { ok: true, trashBatchId: batch };
  }

  async listTrash(userId: string) {
    const items = await this.prisma.node.findMany({ where: { ownerId: userId, trashRoot: true, deletedAt: { not: null } }, orderBy: { deletedAt: 'desc' }, take: 1000 });
    return {
      items: items.map((n) => ({ ...toNodeDto(n), purgeAt: new Date(n.deletedAt!.getTime() + QUOTA_POLICY.trashRetentionDays * 86400_000).toISOString() })),
    };
  }

  async restore(userId: string, nodeId: string) {
    const { node } = await this.access.resolve(userId, nodeId, 'OWNER', { allowDeleted: true });
    if (!node.deletedAt || !node.trashRoot || !node.trashBatchId) throw Errors.bad('Item is not in Trash');
    let parentId = node.parentId;
    if (parentId) {
      const parent = await this.prisma.node.findUnique({ where: { id: parentId } });
      if (!parent || parent.deletedAt) parentId = null; // original folder is gone: restore to root
    }
    const name = await this.freeName(node.ownerId, parentId, node.name);
    await this.prisma.$transaction([
      this.prisma.node.update({ where: { id: node.id }, data: { parentId, name } }),
      this.prisma.node.updateMany({ where: { trashBatchId: node.trashBatchId }, data: { deletedAt: null, trashBatchId: null, trashRoot: false } }),
    ]);
    return toNodeDto(await this.prisma.node.findUniqueOrThrow({ where: { id: node.id } }));
  }

  /** First "name", "name (1)", ... not taken by a live sibling. */
  private async freeName(ownerId: string, parentId: string | null, name: string) {
    const dot = name.lastIndexOf('.');
    const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    for (let i = 0; i < 1000; i++) {
      const candidate = i === 0 ? name : `${base} (${i})${ext}`;
      const clash = await this.prisma.node.findFirst({ where: { ownerId, parentId, deletedAt: null, name: { equals: candidate, mode: 'insensitive' } }, select: { id: true } });
      if (!clash) return candidate;
    }
    return `${base} (${randomUUID().slice(0, 8)})${ext}`;
  }

  async deleteForever(userId: string, nodeId: string) {
    const { node } = await this.access.resolve(userId, nodeId, 'OWNER', { allowDeleted: true });
    if (!node.deletedAt) throw Errors.bad('Move the item to Trash first');
    return this.purgeSubtrees(node.ownerId, [node.id]);
  }

  async emptyTrash(userId: string) {
    const roots = await this.prisma.node.findMany({ where: { ownerId: userId, trashRoot: true, deletedAt: { not: null } }, select: { id: true } });
    return this.purgeSubtrees(userId, roots.map((r) => r.id));
  }

  /**
   * Permanently delete nodes and everything under them: DB rows, storage
   * objects and their bytes from the owner's usage. DB first (inside one
   * transaction with the usage update), then storage; a storage failure leaves
   * an orphan object that the reconcile job reports, never a user charged for
   * data they deleted.
   */
  async purgeSubtrees(ownerId: string, rootIds: string[]) {
    if (!rootIds.length) return { purgedNodes: 0, freedBytes: 0 };
    const nodes = await this.prisma.$queryRaw<{ id: string }[]>`
      WITH RECURSIVE sub AS (
        SELECT id FROM "Node" WHERE id = ANY(${rootIds}) AND "ownerId" = ${ownerId}
        UNION ALL
        SELECT n.id FROM "Node" n JOIN sub s ON n."parentId" = s.id
      ) SELECT DISTINCT id FROM sub`;
    const ids = nodes.map((n) => n.id);
    const versions = await this.prisma.fileVersion.findMany({ where: { nodeId: { in: ids } }, select: { storageKey: true, thumbnailKey: true, size: true } });
    const freed = versions.reduce((a, v) => a + Number(v.size), 0);
    await this.prisma.$transaction(async (tx) => {
      // Break the currentVersion FK first, then delete roots (children + versions cascade).
      await tx.node.updateMany({ where: { id: { in: ids } }, data: { currentVersionId: null } });
      await tx.node.deleteMany({ where: { id: { in: rootIds }, ownerId } });
      await this.quota.free(ownerId, freed, tx);
    });
    await this.deleteObjects(versions.flatMap((v) => [v.storageKey, ...(v.thumbnailKey ? [v.thumbnailKey] : [])]));
    return { purgedNodes: ids.length, freedBytes: freed };
  }

  private async deleteObjects(keys: string[]) {
    try {
      await this.storage.deleteMany(keys);
    } catch (e) {
      this.log.error(`storage delete failed for ${keys.length} keys: ${(e as Error).message}`);
    }
  }

  // ---------------- versions ----------------
  async versions(userId: string, nodeId: string) {
    const { node } = await this.access.resolve(userId, nodeId, 'VIEWER');
    const versions = await this.prisma.fileVersion.findMany({ where: { nodeId }, orderBy: { createdAt: 'desc' } });
    return {
      items: versions.map((v) => ({
        id: v.id,
        size: Number(v.size),
        createdAt: v.createdAt.toISOString(),
        current: v.id === node.currentVersionId,
        scanStatus: v.scanStatus,
      })),
    };
  }

  async restoreVersion(userId: string, nodeId: string, versionId: string) {
    const { node } = await this.access.resolve(userId, nodeId, 'EDITOR');
    await this.quota.assertWritable(node.ownerId);
    const v = await this.prisma.fileVersion.findFirst({ where: { id: versionId, nodeId } });
    if (!v) throw Errors.notFound('Version');
    return toNodeDto(
      await this.prisma.node.update({ where: { id: nodeId }, data: { currentVersionId: v.id, size: v.size, mimeType: v.mimeType, hasThumbnail: !!v.thumbnailKey, sha256: v.sha256 } }),
    );
  }

  async deleteVersion(userId: string, nodeId: string, versionId: string) {
    const { node } = await this.access.resolve(userId, nodeId, 'OWNER');
    if (node.currentVersionId === versionId) throw Errors.bad('The current version cannot be deleted; delete the file instead');
    const v = await this.prisma.fileVersion.findFirst({ where: { id: versionId, nodeId } });
    if (!v) throw Errors.notFound('Version');
    await this.dropVersions(node.ownerId, nodeId, [v]);
    return { ok: true };
  }

  /** Keep at most QUOTA_POLICY.maxVersions per file, never dropping the current one. */
  async pruneVersions(nodeId: string) {
    const node = await this.prisma.node.findUniqueOrThrow({ where: { id: nodeId } });
    const all = await this.prisma.fileVersion.findMany({ where: { nodeId }, orderBy: { createdAt: 'desc' } });
    const excess = all.length - QUOTA_POLICY.maxVersions;
    if (excess <= 0) return 0;
    const drop = all.filter((v) => v.id !== node.currentVersionId).slice(-excess);
    await this.dropVersions(node.ownerId, nodeId, drop);
    return drop.length;
  }

  private async dropVersions(ownerId: string, nodeId: string, versions: { id: string; size: bigint; storageKey: string; thumbnailKey: string | null }[]) {
    if (!versions.length) return;
    const freed = versions.reduce((a, v) => a + Number(v.size), 0);
    await this.prisma.$transaction(async (tx) => {
      await tx.fileVersion.deleteMany({ where: { id: { in: versions.map((v) => v.id) } } });
      await tx.node.update({ where: { id: nodeId }, data: { versionCount: { decrement: versions.length } } });
      await this.quota.free(ownerId, freed, tx);
    });
    await this.deleteObjects(versions.flatMap((v) => [v.storageKey, ...(v.thumbnailKey ? [v.thumbnailKey] : [])]));
  }

  // ---------------- download / preview ----------------
  async downloadUrl(userId: string, nodeId: string, inline: boolean) {
    const { node } = await this.access.resolve(userId, nodeId, 'VIEWER');
    return this.urlForNode(node, inline);
  }

  async urlForNode(node: Node, inline: boolean) {
    if (node.type !== 'FILE' || !node.currentVersionId) throw Errors.bad('Folders cannot be downloaded directly');
    const v = await this.prisma.fileVersion.findUniqueOrThrow({ where: { id: node.currentVersionId } });
    if (v.scanStatus === 'INFECTED') throw Errors.forbidden('This file was flagged as malware and cannot be downloaded');
    // Inline preview only for types browsers render safely; never inline HTML/SVG (stored XSS via storage origin).
    const safeInline = inline && /^(image\/(png|jpe?g|gif|webp|avif|heic)|video\/|audio\/|application\/pdf|text\/plain)/.test(v.mimeType);
    return { url: await this.storage.downloadUrl(v.storageKey, node.name, { inline: safeInline, contentType: safeInline ? v.mimeType : undefined }), expiresIn: 3600 };
  }

  async thumbnailUrl(userId: string, nodeId: string) {
    const { node } = await this.access.resolve(userId, nodeId, 'VIEWER');
    return this.thumbForNode(node);
  }

  async thumbForNode(node: Node) {
    if (!node.currentVersionId) throw Errors.notFound('Thumbnail');
    const v = await this.prisma.fileVersion.findUniqueOrThrow({ where: { id: node.currentVersionId } });
    if (!v.thumbnailKey) throw Errors.notFound('Thumbnail');
    return { url: await this.storage.downloadUrl(v.thumbnailKey, 'thumb.webp', { inline: true, contentType: 'image/webp', expiresIn: 6 * 3600 }) };
  }

  // ---------------- trash retention & over-quota purge (worker) ----------------
  async purgeExpiredTrash(now = new Date()) {
    const cutoff = new Date(now.getTime() - QUOTA_POLICY.trashRetentionDays * 86400_000);
    let total = 0;
    for (;;) {
      const roots = await this.prisma.node.findMany({ where: { trashRoot: true, deletedAt: { lt: cutoff } }, select: { id: true, ownerId: true }, take: 200 });
      if (!roots.length) break;
      const byOwner = new Map<string, string[]>();
      for (const r of roots) byOwner.set(r.ownerId, [...(byOwner.get(r.ownerId) ?? []), r.id]);
      for (const [owner, ids] of byOwner) total += (await this.purgeSubtrees(owner, ids)).purgedNodes;
    }
    return total;
  }

  /**
   * Deadline reached in READ_ONLY: delete data until the account fits its quota.
   * Order (least valuable first): Trash -> old versions (oldest first) -> newest files.
   * Newest-first keeps long-held data (old photos) — the most painful to lose.
   */
  async purgeOverQuota(userId: string) {
    const over = async () => {
      const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
      return { over: Number(u.usedBytes) - Number(u.quotaBytes), user: u };
    };
    const start = await over();
    if (start.user.storageState !== 'PENDING_DELETION' || start.over <= 0) return { deletedFiles: 0, freedBytes: 0 };
    let freed = (await this.emptyTrash(userId)).freedBytes;
    let deletedFiles = 0;

    let state = await over();
    while (state.over > 0) {
      const old = await this.prisma.$queryRaw<{ id: string; nodeId: string; size: bigint; storageKey: string; thumbnailKey: string | null }[]>`
        SELECT v.id, v."nodeId", v.size, v."storageKey", v."thumbnailKey" FROM "FileVersion" v JOIN "Node" n ON n.id = v."nodeId"
        WHERE n."ownerId" = ${userId} AND (n."currentVersionId" IS NULL OR n."currentVersionId" <> v.id)
        ORDER BY v."createdAt" ASC LIMIT 200`;
      if (!old.length) break;
      for (const v of old) {
        await this.dropVersions(userId, v.nodeId, [v]);
        freed += Number(v.size);
      }
      state = await over();
    }
    while (state.over > 0) {
      const files = await this.prisma.node.findMany({ where: { ownerId: userId, type: 'FILE', deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 50 });
      if (!files.length) break;
      let remaining = state.over;
      const batch: string[] = [];
      for (const f of files) {
        if (remaining <= 0) break;
        batch.push(f.id);
        remaining -= Number(f.size);
      }
      const r = await this.purgeSubtrees(userId, batch);
      freed += r.freedBytes;
      deletedFiles += batch.length;
      state = await over();
    }
    await this.quota.tick(userId);
    const u = state.user;
    const cycle = u.deletionScheduledAt?.toISOString() ?? new Date().toISOString();
    await this.quota.notifyOnce(u, 'PURGED', cycle, () => this.mail.send(u.email, 'purged', u.locale, { count: deletedFiles, bytes: formatBytes(freed) }));
    this.log.warn(`purged ${deletedFiles} files (${freed} bytes) for over-quota user ${userId}`);
    return { deletedFiles, freedBytes: freed };
  }
}
