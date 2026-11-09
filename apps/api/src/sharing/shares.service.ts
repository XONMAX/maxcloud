import { HttpStatus, Injectable } from '@nestjs/common';
import type { Node, ShareLink } from '@prisma/client';
import argon2 from 'argon2';
import { SignJWT, jwtVerify } from 'jose';
import { PrismaService } from '../common/prisma.service';
import { AppError, Errors } from '../common/errors';
import { randomToken } from '../common/crypto';
import { jwtKey } from '../common/auth.guard';
import { toNodeDto } from '../common/serialize';
import { config } from '../config';
import { AccessService } from '../files/access.service';
import { FilesService } from '../files/files.service';
import { MailService } from '../mail/mail.service';

function linkDto(l: ShareLink) {
  return {
    id: l.id,
    token: l.token,
    url: `${config().WEB_ORIGIN}/s/${l.token}`,
    nodeId: l.nodeId,
    hasPassword: !!l.passwordHash,
    expiresAt: l.expiresAt?.toISOString() ?? null,
    allowDownload: l.allowDownload,
    createdAt: l.createdAt.toISOString(),
    downloadCount: l.downloadCount,
  };
}

const SHARE_TOKEN_TTL = '2h';

@Injectable()
export class SharesService {
  constructor(private prisma: PrismaService, private access: AccessService, private files: FilesService, private mail: MailService) {}

  // ---------------- public links (owner side) ----------------
  async createLink(userId: string, input: { nodeId: string; password?: string; expiresAt?: string; allowDownload: boolean }) {
    await this.access.resolve(userId, input.nodeId, 'EDITOR');
    if (input.expiresAt && new Date(input.expiresAt) <= new Date()) throw Errors.bad('Expiry must be in the future');
    const link = await this.prisma.shareLink.create({
      data: {
        token: randomToken(16),
        nodeId: input.nodeId,
        createdById: userId,
        passwordHash: input.password ? await argon2.hash(input.password, { type: argon2.argon2id }) : null,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        allowDownload: input.allowDownload,
      },
    });
    return linkDto(link);
  }

  async listLinks(userId: string, nodeId?: string) {
    if (nodeId) await this.access.resolve(userId, nodeId, 'EDITOR');
    const links = await this.prisma.shareLink.findMany({
      where: { revokedAt: null, ...(nodeId ? { nodeId } : { createdById: userId }) },
      include: { node: { select: { name: true, type: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return { items: links.map((l) => ({ ...linkDto(l), nodeName: l.node.name, nodeType: l.node.type })) };
  }

  async revokeLink(userId: string, linkId: string) {
    const link = await this.prisma.shareLink.findUnique({ where: { id: linkId } });
    if (!link) throw Errors.notFound('Link');
    if (link.createdById !== userId) await this.access.resolve(userId, link.nodeId, 'OWNER');
    await this.prisma.shareLink.update({ where: { id: linkId }, data: { revokedAt: new Date() } });
    return { ok: true };
  }

  // ---------------- public links (visitor side) ----------------
  private async loadLink(token: string) {
    const link = await this.prisma.shareLink.findUnique({ where: { token }, include: { node: true, createdBy: { select: { name: true } } } });
    if (!link || link.revokedAt || link.node.deletedAt) throw Errors.notFound('Link');
    if (link.expiresAt && link.expiresAt < new Date()) throw new AppError(HttpStatus.GONE, 'LINK_EXPIRED', 'This link has expired');
    return link;
  }

  /** Short-lived JWT proving the visitor entered the link password. */
  private async issueShareToken(linkId: string) {
    return new SignJWT({ scope: 'share' }).setProtectedHeader({ alg: 'HS256' }).setSubject(linkId).setAudience('maxcloud-share').setExpirationTime(SHARE_TOKEN_TTL).sign(jwtKey());
  }

  private async unlocked(link: ShareLink, shareToken?: string) {
    if (!link.passwordHash) return true;
    if (!shareToken) return false;
    try {
      const { payload } = await jwtVerify(shareToken, jwtKey(), { audience: 'maxcloud-share' });
      return payload.sub === link.id;
    } catch {
      return false;
    }
  }

  private async requireUnlocked(token: string, shareToken?: string) {
    const link = await this.loadLink(token);
    if (!(await this.unlocked(link, shareToken))) throw new AppError(HttpStatus.UNAUTHORIZED, 'PASSWORD_REQUIRED', 'This link is password protected');
    return link;
  }

  async meta(token: string, shareToken?: string) {
    const link = await this.loadLink(token);
    const ok = await this.unlocked(link, shareToken);
    if (!ok) return { requiresPassword: true, unlocked: false };
    return {
      requiresPassword: !!link.passwordHash,
      unlocked: true,
      allowDownload: link.allowDownload,
      expiresAt: link.expiresAt?.toISOString() ?? null,
      sharedBy: link.createdBy.name,
      node: toNodeDto(link.node),
    };
  }

  async unlock(token: string, password: string) {
    const link = await this.loadLink(token);
    if (!link.passwordHash) return { shareToken: await this.issueShareToken(link.id) };
    if (!(await argon2.verify(link.passwordHash, password))) throw new AppError(HttpStatus.UNAUTHORIZED, 'INVALID_CREDENTIALS', 'Wrong password');
    return { shareToken: await this.issueShareToken(link.id), linkId: link.id };
  }

  /** Resolve a node inside the shared item; defaults to the shared item itself. */
  private async nodeInLink(link: ShareLink & { node: Node }, nodeId?: string) {
    if (!nodeId || nodeId === link.nodeId) return link.node;
    const node = await this.prisma.node.findUnique({ where: { id: nodeId } });
    if (!node || node.deletedAt || !(await this.access.isWithin(node.id, link.nodeId))) throw Errors.notFound('File');
    return node;
  }

  async listFolder(token: string, shareToken: string | undefined, parentId?: string) {
    const link = await this.requireUnlocked(token, shareToken);
    const folder = await this.nodeInLink(link, parentId);
    if (folder.type !== 'FOLDER') throw Errors.bad('Not a folder');
    const items = await this.prisma.node.findMany({ where: { parentId: folder.id, deletedAt: null }, orderBy: [{ type: 'asc' }, { name: 'asc' }], take: 5000 });
    const path = await this.access.path(folder.id);
    const start = path.findIndex((p) => p.id === link.nodeId);
    return { folder: toNodeDto(folder), breadcrumbs: path.slice(start).map(({ id, name }) => ({ id, name })), items: items.map(toNodeDto) };
  }

  async download(token: string, shareToken: string | undefined, nodeId: string | undefined, inline: boolean) {
    const link = await this.requireUnlocked(token, shareToken);
    if (!inline && !link.allowDownload) throw Errors.forbidden('The owner disabled downloads for this link');
    const node = await this.nodeInLink(link, nodeId);
    const r = await this.files.urlForNode(node, inline);
    if (!inline) await this.prisma.shareLink.update({ where: { id: link.id }, data: { downloadCount: { increment: 1 } } });
    return r;
  }

  async thumbnail(token: string, shareToken: string | undefined, nodeId?: string) {
    const link = await this.requireUnlocked(token, shareToken);
    return this.files.thumbForNode(await this.nodeInLink(link, nodeId));
  }

  // ---------------- shared folders between users ----------------
  async shareFolder(userId: string, folderId: string, email: string, role: 'VIEWER' | 'EDITOR') {
    const { node } = await this.access.resolve(userId, folderId, 'OWNER');
    if (node.type !== 'FOLDER') throw Errors.bad('Only folders can be shared with people; use a link for files');
    const grantee = await this.prisma.user.findUnique({ where: { email } });
    // TODO(invites): email an invite to people without an account. Needs an Invite table + signup hook; out of MVP scope.
    if (!grantee) throw Errors.notFound('MaxCloud account with this email');
    if (grantee.id === userId) throw Errors.bad('You already own this folder');
    const share = await this.prisma.folderShare.upsert({
      where: { nodeId_granteeId: { nodeId: folderId, granteeId: grantee.id } },
      create: { nodeId: folderId, granteeId: grantee.id, role, createdById: userId },
      update: { role },
    });
    const owner = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    await this.mail.send(grantee.email, 'folder_shared', grantee.locale, {
      from: owner.name,
      folder: node.name,
      role: role === 'EDITOR' ? 'can edit' : 'can view',
      url: `${config().WEB_ORIGIN}/drive?folder=${folderId}`,
    });
    return { id: share.id, role: share.role, grantee: { id: grantee.id, email: grantee.email, name: grantee.name } };
  }

  async listFolderShares(userId: string, folderId: string) {
    await this.access.resolve(userId, folderId, 'OWNER');
    const shares = await this.prisma.folderShare.findMany({ where: { nodeId: folderId }, include: { grantee: { select: { id: true, email: true, name: true } } } });
    return { items: shares.map((s) => ({ id: s.id, role: s.role, grantee: s.grantee, createdAt: s.createdAt.toISOString() })) };
  }

  /** Owner removes someone, or a grantee leaves. */
  async removeFolderShare(userId: string, folderId: string, granteeId: string) {
    const node = await this.prisma.node.findUnique({ where: { id: folderId } });
    if (!node) throw Errors.notFound('Folder');
    if (node.ownerId !== userId && granteeId !== userId) throw Errors.notFound('Folder');
    await this.prisma.folderShare.deleteMany({ where: { nodeId: folderId, granteeId } });
    return { ok: true };
  }
}
