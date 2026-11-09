/**
 * Pure quota lifecycle rules. No I/O: given a snapshot and "now", return the
 * next snapshot and the side effects to perform. Exhaustively unit tested
 * (quota-policy.test.ts) because this is where storage gets given away for free
 * or user data gets deleted by mistake.
 *
 *   ACTIVE ──(downgrade below usage | payment failed)──▶ GRACE (7 days)
 *   GRACE  ──(usage fits | payment recovered)──────────▶ ACTIVE
 *   GRACE  ──(7 days pass, still over)─────────────────▶ READ_ONLY (30 days, warnings at 30/7/1)
 *   READ_ONLY ──(usage fits)───────────────────────────▶ ACTIVE
 *   READ_ONLY ──(30 days pass)─────────────────────────▶ PENDING_DELETION ──(purge)──▶ ACTIVE
 *
 * During GRACE the *previous* quota is honoured, so a user who downgrades
 * (or whose card fails) isn't blocked mid-week.
 */
import { QUOTA_POLICY } from '@maxcloud/shared';

export type StorageStateT = 'ACTIVE' | 'GRACE' | 'READ_ONLY' | 'PENDING_DELETION';
export type GraceReasonT = 'PLAN_DOWNGRADE' | 'PAYMENT_FAILED';

export interface QuotaSnapshot {
  state: StorageStateT;
  usedBytes: number;
  quotaBytes: number;
  graceQuotaBytes: number | null;
  graceReason: GraceReasonT | null;
  graceEndsAt: Date | null;
  readOnlyAt: Date | null;
  deletionScheduledAt: Date | null;
}

export type NoticeKindT = 'GRACE_STARTED' | 'READ_ONLY' | 'DELETION_30' | 'DELETION_7' | 'DELETION_1';

export type QuotaAction =
  | { type: 'NOTIFY'; kind: NoticeKindT; cycleKey: string }
  | { type: 'DOWNGRADE_TO_FREE' }
  | { type: 'PURGE' };

const DAY = 86400_000;

function cleared(s: QuotaSnapshot): QuotaSnapshot {
  return { ...s, state: 'ACTIVE', graceQuotaBytes: null, graceReason: null, graceEndsAt: null, readOnlyAt: null, deletionScheduledAt: null };
}

function enterReadOnly(s: QuotaSnapshot, now: Date): { next: QuotaSnapshot; actions: QuotaAction[] } {
  const deletion = new Date(now.getTime() + QUOTA_POLICY.readOnlyDays * DAY);
  const key = deletion.toISOString();
  return {
    next: { ...s, state: 'READ_ONLY', graceQuotaBytes: null, graceEndsAt: null, readOnlyAt: now, deletionScheduledAt: deletion },
    actions: [
      { type: 'NOTIFY', kind: 'READ_ONLY', cycleKey: key },
      { type: 'NOTIFY', kind: 'DELETION_30', cycleKey: key },
    ],
  };
}

/** The quota (plan or override) changed — e.g. upgrade, downgrade, cancellation. */
export function onQuotaChange(s: QuotaSnapshot, newQuota: number, reason: GraceReasonT, now: Date): { next: QuotaSnapshot; actions: QuotaAction[] } {
  const base = { ...s, quotaBytes: newQuota };
  if (s.usedBytes <= newQuota) {
    // Fits. A payment-driven grace only ends when the payment recovers, not on a quota change.
    if (s.state === 'GRACE' && s.graceReason === 'PAYMENT_FAILED') return { next: base, actions: [] };
    return { next: cleared(base), actions: [] };
  }
  if (s.state === 'ACTIVE') {
    const graceEndsAt = new Date(now.getTime() + QUOTA_POLICY.graceDays * DAY);
    return {
      next: { ...base, state: 'GRACE', graceReason: reason, graceQuotaBytes: Math.max(s.quotaBytes, newQuota), graceEndsAt },
      actions: [{ type: 'NOTIFY', kind: 'GRACE_STARTED', cycleKey: graceEndsAt.toISOString() }],
    };
  }
  // Already in GRACE / READ_ONLY / PENDING_DELETION: keep the clock running, don't restart it.
  return { next: base, actions: [] };
}

/**
 * Time-driven transitions. `freeQuotaBytes` is the quota the user drops to
 * if a payment grace expires without recovery.
 */
export function evaluate(s: QuotaSnapshot, now: Date, freeQuotaBytes: number): { next: QuotaSnapshot; actions: QuotaAction[] } {
  switch (s.state) {
    case 'ACTIVE':
      return { next: s, actions: [] };

    case 'GRACE': {
      if (s.graceReason !== 'PAYMENT_FAILED' && s.usedBytes <= s.quotaBytes) return { next: cleared(s), actions: [] };
      if (!s.graceEndsAt || now < s.graceEndsAt) return { next: s, actions: [] };
      if (s.graceReason === 'PAYMENT_FAILED') {
        const downgraded = { ...s, quotaBytes: freeQuotaBytes };
        const actions: QuotaAction[] = [{ type: 'DOWNGRADE_TO_FREE' }];
        if (downgraded.usedBytes <= freeQuotaBytes) return { next: cleared(downgraded), actions };
        const ro = enterReadOnly({ ...downgraded, graceReason: 'PLAN_DOWNGRADE' }, now);
        return { next: ro.next, actions: [...actions, ...ro.actions] };
      }
      return enterReadOnly(s, now);
    }

    case 'READ_ONLY': {
      if (s.usedBytes <= s.quotaBytes) return { next: cleared(s), actions: [] };
      const del = s.deletionScheduledAt;
      if (!del) return enterReadOnly(s, now); // repair inconsistent row
      if (now >= del) return { next: { ...s, state: 'PENDING_DELETION' }, actions: [{ type: 'PURGE' }] };
      const daysLeft = (del.getTime() - now.getTime()) / DAY;
      // Most urgent applicable warning; QuotaNotice uniqueness makes each send once.
      const due = [...QUOTA_POLICY.deletionWarningDays].sort((a, b) => a - b).find((d) => daysLeft <= d);
      return { next: s, actions: due ? [{ type: 'NOTIFY', kind: `DELETION_${due}` as NoticeKindT, cycleKey: del.toISOString() }] : [] };
    }

    case 'PENDING_DELETION':
      if (s.usedBytes <= s.quotaBytes) return { next: cleared(s), actions: [] };
      return { next: s, actions: [{ type: 'PURGE' }] };
  }
}

/** Upload limit honoured right now (0 = writes blocked). */
export function effectiveLimit(s: QuotaSnapshot): number {
  if (s.state === 'READ_ONLY' || s.state === 'PENDING_DELETION') return 0;
  if (s.state === 'GRACE') return s.graceQuotaBytes ?? s.quotaBytes;
  return s.quotaBytes;
}
