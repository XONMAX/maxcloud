import { describe, expect, it } from 'vitest';
import { effectiveLimit, evaluate, onQuotaChange, type QuotaSnapshot } from './quota-policy';

const GB = 1024 ** 3;
const DAY = 86400_000;
const T0 = new Date('2026-11-01T00:00:00Z');
const at = (days: number) => new Date(T0.getTime() + days * DAY);
const FREE = 5 * GB;

function snap(p: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
  return {
    state: 'ACTIVE',
    usedBytes: 0,
    quotaBytes: 100 * GB,
    graceQuotaBytes: null,
    graceReason: null,
    graceEndsAt: null,
    readOnlyAt: null,
    deletionScheduledAt: null,
    ...p,
  };
}

describe('onQuotaChange', () => {
  it('upgrade or downgrade that still fits stays ACTIVE', () => {
    const r = onQuotaChange(snap({ usedBytes: 40 * GB }), 50 * GB, 'PLAN_DOWNGRADE', T0);
    expect(r.next.state).toBe('ACTIVE');
    expect(r.next.quotaBytes).toBe(50 * GB);
    expect(r.actions).toEqual([]);
  });

  it('downgrade below usage starts a 7-day grace honouring the old quota', () => {
    const r = onQuotaChange(snap({ usedBytes: 80 * GB }), 50 * GB, 'PLAN_DOWNGRADE', T0);
    expect(r.next.state).toBe('GRACE');
    expect(r.next.graceQuotaBytes).toBe(100 * GB);
    expect(r.next.graceEndsAt).toEqual(at(7));
    expect(effectiveLimit(r.next)).toBe(100 * GB);
    expect(r.actions).toEqual([{ type: 'NOTIFY', kind: 'GRACE_STARTED', cycleKey: at(7).toISOString() }]);
  });

  it('a second downgrade during grace does not restart the clock', () => {
    const g = onQuotaChange(snap({ usedBytes: 80 * GB }), 50 * GB, 'PLAN_DOWNGRADE', T0).next;
    const r = onQuotaChange(g, FREE, 'PLAN_DOWNGRADE', at(3));
    expect(r.next.graceEndsAt).toEqual(at(7));
    expect(r.next.quotaBytes).toBe(FREE);
    expect(r.actions).toEqual([]);
  });

  it('upgrading out of grace or read-only clears everything', () => {
    const ro = snap({ state: 'READ_ONLY', usedBytes: 80 * GB, quotaBytes: 50 * GB, readOnlyAt: T0, deletionScheduledAt: at(30) });
    const r = onQuotaChange(ro, 250 * GB, 'PLAN_DOWNGRADE', at(1));
    expect(r.next).toMatchObject({ state: 'ACTIVE', readOnlyAt: null, deletionScheduledAt: null, quotaBytes: 250 * GB });
  });

  it('payment-failure grace survives a quota change until payment recovers', () => {
    const g = snap({ state: 'GRACE', graceReason: 'PAYMENT_FAILED', graceQuotaBytes: 100 * GB, graceEndsAt: at(7), usedBytes: 10 * GB });
    expect(onQuotaChange(g, 250 * GB, 'PLAN_DOWNGRADE', T0).next.state).toBe('GRACE');
  });
});

describe('evaluate', () => {
  it('ACTIVE is stable', () => {
    expect(evaluate(snap(), T0, FREE).actions).toEqual([]);
  });

  it('grace ends early when the user frees space', () => {
    const g = snap({ state: 'GRACE', graceReason: 'PLAN_DOWNGRADE', graceQuotaBytes: 100 * GB, graceEndsAt: at(7), usedBytes: 40 * GB, quotaBytes: 50 * GB });
    expect(evaluate(g, at(2), FREE).next.state).toBe('ACTIVE');
  });

  it('grace still running: no change', () => {
    const g = snap({ state: 'GRACE', graceReason: 'PLAN_DOWNGRADE', graceQuotaBytes: 100 * GB, graceEndsAt: at(7), usedBytes: 80 * GB, quotaBytes: 50 * GB });
    const r = evaluate(g, at(6.9), FREE);
    expect(r.next).toBe(g);
    expect(r.actions).toEqual([]);
  });

  it('grace expiry -> READ_ONLY with deletion in 30 days and the 30-day warning', () => {
    const g = snap({ state: 'GRACE', graceReason: 'PLAN_DOWNGRADE', graceQuotaBytes: 100 * GB, graceEndsAt: at(7), usedBytes: 80 * GB, quotaBytes: 50 * GB });
    const r = evaluate(g, at(7), FREE);
    expect(r.next.state).toBe('READ_ONLY');
    expect(r.next.deletionScheduledAt).toEqual(at(37));
    expect(effectiveLimit(r.next)).toBe(0);
    expect(r.actions.map((a) => (a.type === 'NOTIFY' ? a.kind : a.type))).toEqual(['READ_ONLY', 'DELETION_30']);
  });

  it('unpaid grace expiry downgrades to free; fits -> ACTIVE on free', () => {
    const g = snap({ state: 'GRACE', graceReason: 'PAYMENT_FAILED', graceQuotaBytes: 100 * GB, graceEndsAt: at(7), usedBytes: 3 * GB });
    const r = evaluate(g, at(7), FREE);
    expect(r.actions).toEqual([{ type: 'DOWNGRADE_TO_FREE' }]);
    expect(r.next).toMatchObject({ state: 'ACTIVE', quotaBytes: FREE });
  });

  it('unpaid grace expiry over the free quota -> downgrade + READ_ONLY', () => {
    const g = snap({ state: 'GRACE', graceReason: 'PAYMENT_FAILED', graceQuotaBytes: 100 * GB, graceEndsAt: at(7), usedBytes: 60 * GB });
    const r = evaluate(g, at(8), FREE);
    expect(r.actions[0]).toEqual({ type: 'DOWNGRADE_TO_FREE' });
    expect(r.next.state).toBe('READ_ONLY');
    expect(r.next.quotaBytes).toBe(FREE);
  });

  it('payment grace does not end just because usage fits', () => {
    const g = snap({ state: 'GRACE', graceReason: 'PAYMENT_FAILED', graceQuotaBytes: 100 * GB, graceEndsAt: at(7), usedBytes: 1 * GB });
    expect(evaluate(g, at(1), FREE).next.state).toBe('GRACE');
  });

  describe('read-only warnings', () => {
    const ro = snap({ state: 'READ_ONLY', usedBytes: 80 * GB, quotaBytes: 50 * GB, readOnlyAt: T0, deletionScheduledAt: at(30) });
    const kinds = (d: number) => evaluate(ro, at(d), FREE).actions.map((a) => (a.type === 'NOTIFY' ? a.kind : a.type));
    it('30-day warning window', () => expect(kinds(0)).toEqual(['DELETION_30']));
    it('nothing new mid-way (30-day notice already deduped by key)', () => expect(kinds(10)).toEqual(['DELETION_30']));
    it('7 days before', () => expect(kinds(23)).toEqual(['DELETION_7']));
    it('1 day before', () => expect(kinds(29)).toEqual(['DELETION_1']));
    it('deadline -> PENDING_DELETION + PURGE', () => {
      const r = evaluate(ro, at(30), FREE);
      expect(r.next.state).toBe('PENDING_DELETION');
      expect(r.actions).toEqual([{ type: 'PURGE' }]);
    });
    it('freeing space during read-only restores ACTIVE', () => {
      expect(evaluate({ ...ro, usedBytes: 49 * GB }, at(15), FREE).next.state).toBe('ACTIVE');
    });
    it('cycle key is stable so each warning is sent once', () => {
      const a = evaluate(ro, at(23), FREE).actions[0];
      const b = evaluate(ro, at(24), FREE).actions[0];
      expect(a).toEqual(b);
    });
  });

  it('PENDING_DELETION keeps purging until under quota, then ACTIVE', () => {
    const p = snap({ state: 'PENDING_DELETION', usedBytes: 60 * GB, quotaBytes: 50 * GB, deletionScheduledAt: T0 });
    expect(evaluate(p, at(1), FREE).actions).toEqual([{ type: 'PURGE' }]);
    expect(evaluate({ ...p, usedBytes: 50 * GB }, at(1), FREE).next.state).toBe('ACTIVE');
  });
});
