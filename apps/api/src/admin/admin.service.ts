import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { GB, PAYMENT_FEES, PLANS, STORAGE_PROVIDERS, computeEconomics, storageCostPerMonth, type EconomicsInput, type Gateway } from '@maxcloud/shared';
import { PrismaService } from '../common/prisma.service';
import { Errors } from '../common/errors';
import { config } from '../config';
import { QuotaService } from '../quota/quota.service';

const FX = () => Number(process.env.FX_UZS_PER_USD ?? 11987);
const providerId = () => (config().STORAGE_PROVIDER === 'local' ? 'b2' : config().STORAGE_PROVIDER) as keyof typeof STORAGE_PROVIDERS;
const GATEWAY: Record<string, Gateway> = { STRIPE: 'stripe', PAYME: 'payme', CLICK: 'click', UZUM: 'payme' };

@Injectable()
export class AdminService {
  constructor(private prisma: PrismaService, private quota: QuotaService) {}

  /**
   * Live unit economics from real data: per tier revenue (monthly-normalised, USD),
   * actual stored bytes -> storage COGS at the configured provider's price,
   * payment fees by actual gateway mix; alert when COGS > COGS_ALERT_RATIO of revenue.
   */
  async overview() {
    const alertRatio = config().COGS_ALERT_RATIO;
    const provider = providerId();
    const perTB = STORAGE_PROVIDERS[provider].perTBMonth;

    const [userCount, subs, storedByPlan, invoices30] = await Promise.all([
      this.prisma.user.count({ where: { deletionRequestedAt: null } }),
      this.prisma.subscription.findMany({ where: { status: { in: ['ACTIVE', 'PAST_DUE'] } }, select: { planId: true, interval: true, provider: true, userId: true } }),
      this.prisma.$queryRaw<{ planId: string; users: bigint; used: bigint }[]>`SELECT "planId", COUNT(*)::bigint AS users, COALESCE(SUM("usedBytes"),0)::bigint AS used FROM "User" GROUP BY "planId"`,
      this.prisma.$queryRaw<{ currency: string; total: bigint }[]>`SELECT currency, SUM(amount)::bigint AS total FROM "Invoice" WHERE status = 'PAID' AND "paidAt" > now() - interval '30 days' GROUP BY currency`,
    ]);

    const tiers = PLANS.filter((p) => p.id !== 'free').map((p) => {
      const tierSubs = subs.filter((s) => s.planId === p.id);
      let revenue = 0;
      let fees = 0;
      for (const s of tierSubs) {
        const local = s.provider !== 'STRIPE';
        const charge = local ? (s.interval === 'month' ? p.monthly.UZS : p.yearly.UZS) / 100 / FX() : (s.interval === 'month' ? p.monthly.USD : p.yearly.USD) / 100;
        const months = s.interval === 'month' ? 1 : 12;
        const fee = PAYMENT_FEES[GATEWAY[s.provider]];
        revenue += charge / months;
        fees += (charge * fee.pct + fee.fixed) / months;
      }
      const row = storedByPlan.find((r) => r.planId === p.id);
      const used = Number(row?.used ?? 0);
      const storage = (used / (1024 * GB)) * perTB;
      const cogs = storage + fees;
      const ratio = revenue > 0 ? cogs / revenue : null;
      return {
        planId: p.id,
        name: p.name,
        subscribers: tierSubs.length,
        users: Number(row?.users ?? 0),
        revenue: round(revenue),
        storedGB: round(used / GB, 1),
        avgUtilization: tierSubs.length ? round(used / (tierSubs.length * p.quotaBytes), 3) : 0,
        storageCogs: round(storage),
        paymentFees: round(fees),
        cogsRatio: ratio === null ? null : round(ratio, 3),
        alert: ratio !== null && ratio > alertRatio,
        /** Users on this plan without a paying subscription (admin overrides, comped, seeded). */
        compedUsers: Math.max(0, Number(row?.users ?? 0) - tierSubs.length),
      };
    });
    const free = storedByPlan.find((r) => r.planId === 'free');
    const freeCost = (Number(free?.used ?? 0) / (1024 * GB)) * perTB;
    const revenue = tiers.reduce((a, t) => a + t.revenue, 0);
    const cogs = tiers.reduce((a, t) => a + t.storageCogs + t.paymentFees, 0) + freeCost;
    const alerts = tiers.filter((t) => t.alert).map((t) => `${t.name}: COGS ${(t.cogsRatio! * 100).toFixed(1)}% of revenue > ${alertRatio * 100}%`);
    const comped = tiers.filter((t) => t.compedUsers > 0 && t.subscribers === 0 && t.storageCogs > 0);
    const notices = comped.map((t) => `${t.name}: ${t.compedUsers} user(s) without a paying subscription cost ${t.storageCogs.toFixed(2)} USD/month`);
    if (revenue > 0 && cogs / revenue > alertRatio) alerts.push(`Blended COGS ${((cogs / revenue) * 100).toFixed(1)}% > ${alertRatio * 100}%`);

    return {
      provider,
      pricePerTBMonth: perTB,
      fxUzsPerUsd: FX(),
      users: userCount,
      payingUsers: new Set(subs.map((s) => s.userId)).size,
      mrrUsd: round(revenue),
      cogsUsd: round(cogs),
      grossMarginPct: revenue > 0 ? round(((revenue - cogs) / revenue) * 100, 1) : null,
      freeTier: { users: Number(free?.users ?? 0), storedGB: round(Number(free?.used ?? 0) / GB, 1), costUsd: round(freeCost) },
      revenue30d: invoices30.map((r) => ({ currency: r.currency, total: Number(r.total) })),
      tiers,
      alerts,
      notices,
    };
  }

  /** Scenario planning with the shared unit-economics module. */
  economics(input: EconomicsInput) {
    return computeEconomics({ ...input, cogsAlertRatio: input.cogsAlertRatio ?? config().COGS_ALERT_RATIO });
  }

  async users(q: string, cursor: string | undefined, limit = 50) {
    const where: Prisma.UserWhereInput = q ? { OR: [{ email: { contains: q, mode: 'insensitive' } }, { name: { contains: q, mode: 'insensitive' } }] } : {};
    const rows = await this.prisma.user.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    const page = rows.slice(0, limit);
    return {
      items: page.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        planId: u.planId,
        quotaBytes: Number(u.quotaBytes),
        quotaOverride: u.quotaOverrideBytes === null ? null : Number(u.quotaOverrideBytes),
        usedBytes: Number(u.usedBytes),
        storageCostUsd: round(storageCostPerMonth(Number(u.usedBytes), providerId()), 4),
        storageState: u.storageState,
        createdAt: u.createdAt.toISOString(),
      })),
      nextCursor: rows.length > limit ? page[page.length - 1].id : null,
    };
  }

  async overrideQuota(actorId: string, userId: string, quotaBytes: number | null, reason: string) {
    const before = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!before) throw Errors.notFound('User');
    await this.quota.setOverride(userId, quotaBytes);
    await this.prisma.auditLog.create({
      data: { actorId, userId, action: 'quota.override', meta: { from: before.quotaOverrideBytes?.toString() ?? null, to: quotaBytes, reason } },
    });
    return { ok: true };
  }

  async abuseReports(status?: 'OPEN' | 'ACTIONED' | 'REJECTED') {
    const items = await this.prisma.abuseReport.findMany({ where: status ? { status } : {}, orderBy: { createdAt: 'desc' }, take: 200 });
    return { items };
  }

  /** Action: revoke every public link to the reported item and move it to the owner's Trash. */
  async resolveAbuse(actorId: string, id: string, action: 'ACTIONED' | 'REJECTED', resolution: string) {
    const r = await this.prisma.abuseReport.findUnique({ where: { id } });
    if (!r) throw Errors.notFound('Report');
    if (action === 'ACTIONED' && r.nodeId) {
      await this.prisma.shareLink.updateMany({ where: { nodeId: r.nodeId, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.prisma.node.updateMany({ where: { id: r.nodeId, deletedAt: null }, data: { deletedAt: new Date(), trashRoot: true, trashBatchId: `abuse-${r.id}` } });
    }
    await this.prisma.abuseReport.update({ where: { id }, data: { status: action, resolution, resolvedAt: new Date() } });
    await this.prisma.auditLog.create({ data: { actorId, action: `abuse.${action.toLowerCase()}`, meta: { reportId: id, nodeId: r.nodeId, resolution } } });
    return { ok: true };
  }
}

function round(n: number, d = 2) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
