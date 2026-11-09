import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { quotaDrift } from '../common/metrics';
import { FilesService } from '../files/files.service';
import { UploadsService } from '../files/uploads.service';
import { QuotaService } from '../quota/quota.service';
import { BillingService } from '../billing/billing.service';
import { AccountService } from '../account/account.service';
import type { MaintenanceJob } from './queue.service';

/** Repeatable housekeeping jobs; schedules are registered in worker.ts. */
@Injectable()
export class MaintenanceProcessor {
  private log = new Logger(MaintenanceProcessor.name);
  constructor(
    private prisma: PrismaService,
    private files: FilesService,
    private uploads: UploadsService,
    private quota: QuotaService,
    private billing: BillingService,
    private account: AccountService,
  ) {}

  async run(job: MaintenanceJob) {
    switch (job.kind) {
      case 'quota-tick':
        return this.quotaTick();
      case 'purge-trash':
        return { purged: await this.files.purgeExpiredTrash() };
      case 'expire-uploads':
        return { aborted: await this.uploads.expireStale() };
      case 'reconcile-usage':
        return this.reconcile();
      case 'purge-over-quota':
        return this.files.purgeOverQuota(job.userId);
      case 'renewal-reminders':
        return { sent: await this.billing.sendRenewalReminders() };
      case 'delete-accounts':
        return { deleted: await this.account.purgeDeletedAccounts() };
    }
  }

  /** Advance every non-ACTIVE account through the lifecycle and purge those past their deadline. */
  async quotaTick(now = new Date()) {
    const users = await this.prisma.user.findMany({ where: { storageState: { not: 'ACTIVE' } }, select: { id: true } });
    let purged = 0;
    for (const { id } of users) {
      const actions = await this.quota.tick(id, now);
      if (actions.some((a) => a.type === 'PURGE')) {
        await this.files.purgeOverQuota(id);
        purged++;
      }
    }
    return { evaluated: users.length, purged };
  }

  /**
   * Money-leak guard: recompute usage from FileVersion rows and compare with the
   * running counters. Fixes drift (and reports it in metrics + logs).
   */
  async reconcile() {
    const drift = await this.prisma.$queryRaw<{ id: string; used: bigint; actual: bigint }[]>`
      SELECT u.id, u."usedBytes" AS used, COALESCE(SUM(v.size), 0)::bigint AS actual
      FROM "User" u
      LEFT JOIN "Node" n ON n."ownerId" = u.id
      LEFT JOIN "FileVersion" v ON v."nodeId" = n.id
      GROUP BY u.id
      HAVING u."usedBytes" <> COALESCE(SUM(v.size), 0)`;
    for (const d of drift) {
      this.log.error(`usage drift user=${d.id} counter=${d.used} actual=${d.actual}`);
      await this.prisma.user.update({ where: { id: d.id }, data: { usedBytes: d.actual } });
    }
    // Stale reservations: no pending upload but reservedBytes > 0.
    await this.prisma.$executeRaw`
      UPDATE "User" u SET "reservedBytes" = COALESCE(p.s, 0)
      FROM (SELECT u2.id, (SELECT SUM(size) FROM "Upload" up WHERE up."ownerId" = u2.id AND up.status = 'PENDING') AS s FROM "User" u2) p
      WHERE p.id = u.id AND u."reservedBytes" <> COALESCE(p.s, 0)`;
    quotaDrift.set(drift.length);
    return { drifted: drift.length };
  }
}
