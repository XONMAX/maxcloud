import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type User } from '@prisma/client';
import { FREE_PLAN_ID, QUOTA_POLICY, formatBytes, getPlan } from '@maxcloud/shared';
import { PrismaService } from '../common/prisma.service';
import { Errors } from '../common/errors';
import { quotaRejections } from '../common/metrics';
import { MailService } from '../mail/mail.service';
import { config } from '../config';
import { evaluate, onQuotaChange, type QuotaAction, type QuotaSnapshot } from './quota-policy';

type Tx = Prisma.TransactionClient;

/**
 * Quota engine (feature 4).
 *
 * Accounting model:
 *   usedBytes     = sum of sizes of every stored FileVersion (incl. trash + old versions)
 *   reservedBytes = sum of declared sizes of in-flight uploads
 *   An upload may start only if used + reserved + size <= limit, enforced by a
 *   single conditional UPDATE so concurrent uploads cannot overshoot (hard stop).
 *
 * Lifecycle (pure rules in quota-policy.ts):
 *   ACTIVE -> GRACE (7 days, old quota honoured) -> READ_ONLY (30 days) -> PENDING_DELETION -> purge -> ACTIVE
 */
@Injectable()
export class QuotaService {
  private log = new Logger(QuotaService.name);
  constructor(private prisma: PrismaService, private mail: MailService) {}

  /** Atomically reserve bytes for an upload. Throws QUOTA_EXCEEDED / ACCOUNT_READ_ONLY. */
  async reserve(userId: string, bytes: number, tx: Tx = this.prisma) {
    const rows = await tx.$executeRaw`
      UPDATE "User" SET "reservedBytes" = "reservedBytes" + ${BigInt(bytes)}
      WHERE id = ${userId}
        AND "storageState" IN ('ACTIVE', 'GRACE')
        AND "usedBytes" + "reservedBytes" + ${BigInt(bytes)} <=
            CASE WHEN "storageState" = 'GRACE' THEN COALESCE("graceQuotaBytes", "quotaBytes") ELSE "quotaBytes" END`;
    if (rows === 1) return;
    quotaRejections.inc();
    const u = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    if (u.storageState === 'READ_ONLY' || u.storageState === 'PENDING_DELETION') throw Errors.readOnly();
    const limit = Number(u.storageState === 'GRACE' ? (u.graceQuotaBytes ?? u.quotaBytes) : u.quotaBytes);
    throw Errors.quota(bytes, Math.max(0, limit - Number(u.usedBytes) - Number(u.reservedBytes)));
  }

  /** Move a reservation into usage once the object is verified in storage. */
  async commit(userId: string, reserved: number, actual: number, tx: Tx) {
    await tx.$executeRaw`
      UPDATE "User" SET "reservedBytes" = GREATEST(0, "reservedBytes" - ${BigInt(reserved)}),
                        "usedBytes" = "usedBytes" + ${BigInt(actual)}
      WHERE id = ${userId}`;
  }

  async release(userId: string, reserved: number, tx: Tx = this.prisma) {
    await tx.$executeRaw`UPDATE "User" SET "reservedBytes" = GREATEST(0, "reservedBytes" - ${BigInt(reserved)}) WHERE id = ${userId}`;
  }

  /** Called whenever stored bytes are freed (purge, version prune). */
  async free(userId: string, bytes: number, tx: Tx = this.prisma) {
    if (bytes <= 0) return;
    await tx.$executeRaw`UPDATE "User" SET "usedBytes" = GREATEST(0, "usedBytes" - ${BigInt(bytes)}) WHERE id = ${userId}`;
  }

  /** Non-upload writes (create folder, rename, move) are blocked when read-only. Deletes are always allowed. */
  async assertWritable(userId: string) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { storageState: true } });
    if (u.storageState === 'READ_ONLY' || u.storageState === 'PENDING_DELETION') throw Errors.readOnly();
  }

  static snapshot(u: User): QuotaSnapshot {
    return {
      state: u.storageState,
      usedBytes: Number(u.usedBytes),
      quotaBytes: Number(u.quotaBytes),
      graceQuotaBytes: u.graceQuotaBytes === null ? null : Number(u.graceQuotaBytes),
      graceReason: u.graceReason,
      graceEndsAt: u.graceEndsAt,
      readOnlyAt: u.readOnlyAt,
      deletionScheduledAt: u.deletionScheduledAt,
    };
  }

  /** Effective quota for a plan, honouring an admin override. */
  static quotaFor(planId: string, override: bigint | null) {
    return override ?? BigInt(getPlan(planId).quotaBytes);
  }

  /**
   * Apply a plan change (upgrade, downgrade, cancellation, admin override).
   * Downgrading below current usage starts the 7-day grace period.
   */
  async changePlan(userId: string, planId: string, reason: 'PLAN_DOWNGRADE' | 'PAYMENT_FAILED' = 'PLAN_DOWNGRADE', now = new Date()) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const newQuota = Number(QuotaService.quotaFor(planId, u.quotaOverrideBytes));
    const { next, actions } = onQuotaChange(QuotaService.snapshot(u), newQuota, reason, now);
    await this.prisma.user.update({ where: { id: userId }, data: { planId, quotaBytes: BigInt(newQuota), ...this.toData(next) } });
    await this.runActions(u, actions, next);
  }

  async setOverride(userId: string, quotaBytes: number | null, now = new Date()) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const override = quotaBytes === null ? null : BigInt(quotaBytes);
    const newQuota = Number(QuotaService.quotaFor(u.planId, override));
    const { next, actions } = onQuotaChange(QuotaService.snapshot(u), newQuota, 'PLAN_DOWNGRADE', now);
    await this.prisma.user.update({ where: { id: userId }, data: { quotaOverrideBytes: override, quotaBytes: BigInt(newQuota), ...this.toData(next) } });
    await this.runActions(u, actions, next);
  }

  /** Payment failed: keep current quota for the grace period. */
  async paymentFailed(userId: string, now = new Date()) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (u.storageState !== 'ACTIVE') return;
    const graceEndsAt = new Date(now.getTime() + QUOTA_POLICY.graceDays * 86400_000);
    await this.prisma.user.update({
      where: { id: userId },
      data: { storageState: 'GRACE', graceReason: 'PAYMENT_FAILED', graceQuotaBytes: u.quotaBytes, graceEndsAt },
    });
  }

  /** Payment recovered: leave grace if it was payment-driven. */
  async paymentRecovered(userId: string) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (u.graceReason !== 'PAYMENT_FAILED') return;
    const fits = Number(u.usedBytes) <= Number(u.quotaBytes);
    await this.prisma.user.update({
      where: { id: userId },
      data: fits
        ? { storageState: 'ACTIVE', graceReason: null, graceQuotaBytes: null, graceEndsAt: null, readOnlyAt: null, deletionScheduledAt: null }
        : { graceReason: 'PLAN_DOWNGRADE' },
    });
  }

  /** Periodic tick for one user (run by the maintenance worker). Returns actions taken. */
  async tick(userId: string, now = new Date()): Promise<QuotaAction[]> {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const freeQuota = Number(QuotaService.quotaFor(FREE_PLAN_ID, u.quotaOverrideBytes));
    const { next, actions } = evaluate(QuotaService.snapshot(u), now, freeQuota);
    const downgrade = actions.some((a) => a.type === 'DOWNGRADE_TO_FREE');
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { ...this.toData(next), ...(downgrade ? { planId: FREE_PLAN_ID, quotaBytes: BigInt(freeQuota) } : {}) },
      });
      if (downgrade) await tx.subscription.updateMany({ where: { userId, status: { in: ['ACTIVE', 'PAST_DUE'] } }, data: { status: 'EXPIRED' } });
    });
    await this.runActions(u, actions, next);
    return actions;
  }

  private toData(s: QuotaSnapshot) {
    return {
      storageState: s.state,
      graceReason: s.graceReason,
      graceQuotaBytes: s.graceQuotaBytes === null ? null : BigInt(s.graceQuotaBytes),
      graceEndsAt: s.graceEndsAt,
      readOnlyAt: s.readOnlyAt,
      deletionScheduledAt: s.deletionScheduledAt,
    };
  }

  /** Send notices exactly once per (user, kind, cycle) using the QuotaNotice unique key. */
  async notifyOnce(user: Pick<User, 'id' | 'email' | 'locale'>, kind: 'GRACE_STARTED' | 'READ_ONLY' | 'DELETION_30' | 'DELETION_7' | 'DELETION_1' | 'PURGED', cycleKey: string, send: () => Promise<void>) {
    try {
      await this.prisma.quotaNotice.create({ data: { userId: user.id, kind, cycleKey } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return false;
      throw e;
    }
    await send();
    return true;
  }

  private async runActions(u: User, actions: QuotaAction[], next: Partial<QuotaSnapshot>) {
    const url = `${config().WEB_ORIGIN}/billing`;
    const d = (x: Date | null | undefined) => (x ? x.toISOString().slice(0, 10) : '');
    for (const a of actions) {
      if (a.type === 'NOTIFY') {
        const cycle = a.cycleKey;
        const vars = { used: formatBytes(Number(u.usedBytes)), quota: formatBytes(Number(next.quotaBytes ?? u.quotaBytes)), url };
        if (a.kind === 'GRACE_STARTED') await this.notifyOnce(u, a.kind, cycle, () => this.mail.send(u.email, 'grace_started', u.locale, { ...vars, date: d(next.graceEndsAt) }));
        else if (a.kind === 'READ_ONLY') await this.notifyOnce(u, a.kind, cycle, () => this.mail.send(u.email, 'read_only', u.locale, { ...vars, date: d(next.deletionScheduledAt) }));
        else {
          const days = a.kind === 'DELETION_30' ? 30 : a.kind === 'DELETION_7' ? 7 : 1;
          await this.notifyOnce(u, a.kind, cycle, () => this.mail.send(u.email, 'deletion_warning', u.locale, { days, date: d(next.deletionScheduledAt), url }));
        }
      }
      if (a.type === 'PURGE') this.log.warn(`user ${u.id} reached deletion date; purge job will run`);
    }
  }
}
