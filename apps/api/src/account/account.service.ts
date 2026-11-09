import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { TokensService } from '../auth/tokens.service';
import { FilesService } from '../files/files.service';
import { StripeProvider } from '../billing/providers/stripe.provider';

export const ACCOUNT_DELETION_DELAY_DAYS = 7;

/**
 * GDPR-style rights (and Uzbekistan's personal-data law ZRU-547 equivalents):
 * access/portability (export) and erasure (delete with a 7-day undo window).
 */
@Injectable()
export class AccountService {
  private log = new Logger(AccountService.name);
  constructor(private prisma: PrismaService, private tokens: TokensService, private files: FilesService, private stripe: StripeProvider) {}

  /**
   * Machine-readable export of everything we hold about the user.
   * File *contents* are downloadable from the app per file/folder.
   * TODO(export-archive): build a background job that zips all file contents to a
   * temporary object and emails a 7-day link. Not in the MVP because zipping TBs in
   * the worker needs streaming multipart zip + egress planning; metadata export covers
   * the legal requirement, contents are already accessible to the user.
   */
  async export(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const [sessions, nodes, links, shares, subs, invoices, orders] = await Promise.all([
      this.prisma.session.findMany({ where: { userId }, select: { deviceName: true, ip: true, createdAt: true, lastUsedAt: true, revokedAt: true } }),
      this.prisma.node.findMany({ where: { ownerId: userId }, select: { id: true, parentId: true, type: true, name: true, size: true, mimeType: true, createdAt: true, updatedAt: true, deletedAt: true } }),
      this.prisma.shareLink.findMany({ where: { createdById: userId }, select: { nodeId: true, expiresAt: true, allowDownload: true, createdAt: true, revokedAt: true, downloadCount: true } }),
      this.prisma.folderShare.findMany({ where: { OR: [{ createdById: userId }, { granteeId: userId }] }, select: { nodeId: true, granteeId: true, role: true, createdAt: true } }),
      this.prisma.subscription.findMany({ where: { userId } }),
      this.prisma.invoice.findMany({ where: { userId } }),
      this.prisma.paymentOrder.findMany({ where: { userId } }),
    ]);
    return {
      exportedAt: new Date().toISOString(),
      profile: {
        email: user.email,
        name: user.name,
        locale: user.locale,
        createdAt: user.createdAt,
        emailVerifiedAt: user.emailVerifiedAt,
        twoFactorEnabled: !!user.totpEnabledAt,
        linkedLogins: { google: !!user.googleSub, apple: !!user.appleSub },
        planId: user.planId,
        quotaBytes: Number(user.quotaBytes),
        usedBytes: Number(user.usedBytes),
      },
      sessions,
      files: nodes.map((n) => ({ ...n, size: Number(n.size) })),
      shareLinks: links,
      folderShares: shares,
      subscriptions: subs,
      invoices,
      paymentOrders: orders,
    };
  }

  async requestDeletion(userId: string) {
    await this.prisma.user.update({ where: { id: userId }, data: { deletionRequestedAt: new Date() } });
    const subs = await this.prisma.subscription.findMany({ where: { userId, provider: 'STRIPE', status: { in: ['ACTIVE', 'PAST_DUE'] } } });
    for (const s of subs) if (s.providerSubscriptionId && this.stripe.available()) await this.stripe.cancelAtPeriodEnd(s.providerSubscriptionId);
    await this.tokens.revokeAll(userId);
    return { deletionAt: new Date(Date.now() + ACCOUNT_DELETION_DELAY_DAYS * 86400_000).toISOString() };
  }

  async cancelDeletion(userId: string) {
    await this.prisma.user.update({ where: { id: userId }, data: { deletionRequestedAt: null } });
    return { ok: true };
  }

  /** Worker: hard-delete accounts whose undo window passed. Invoices are kept (tax law) with the user anonymised. */
  async purgeDeletedAccounts(now = new Date()) {
    const cutoff = new Date(now.getTime() - ACCOUNT_DELETION_DELAY_DAYS * 86400_000);
    const users = await this.prisma.user.findMany({ where: { deletionRequestedAt: { lt: cutoff } }, select: { id: true } });
    for (const { id } of users) {
      const roots = await this.prisma.node.findMany({ where: { ownerId: id, parentId: null }, select: { id: true } });
      await this.files.purgeSubtrees(id, roots.map((r) => r.id));
      // Orphans whose parent belongs to someone else can't exist (moves are same-owner), but be thorough:
      const rest = await this.prisma.node.findMany({ where: { ownerId: id }, select: { id: true } });
      if (rest.length) await this.files.purgeSubtrees(id, rest.map((r) => r.id));
      await this.prisma.user.update({
        where: { id },
        data: {
          email: `deleted+${id}@deleted.maxcloud.uz`,
          name: 'Deleted user',
          passwordHash: null,
          googleSub: null,
          appleSub: null,
          totpSecretEnc: null,
          recoveryCodes: [],
          stripeCustomerId: null,
          deletionRequestedAt: null,
          storageState: 'ACTIVE',
          usedBytes: 0n,
        },
      });
      await this.prisma.session.deleteMany({ where: { userId: id } });
      await this.prisma.folderShare.deleteMany({ where: { granteeId: id } });
      await this.prisma.auditLog.create({ data: { userId: id, action: 'account.purged' } });
      this.log.warn(`account ${id} purged`);
    }
    return users.length;
  }
}
