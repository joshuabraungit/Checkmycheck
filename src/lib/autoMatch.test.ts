import { describe, expect, it } from 'vitest';
import { suggestMatches, type PaymentMatch } from './autoMatch';
import { reconcile } from './calc';
import { setPaymentAllocations } from './ops';
import { deal, payment, plan, ws } from './testHelpers';
import type { Workspace } from './types';

function nextMonth15(date: string): string {
  const [y, m] = date.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-15`;
}

/** The sample rep tracker: $800k quota, 10% base, 15% above quota, paid the 15th of the month after close. */
function sampleTracker(): Workspace {
  const p = plan({ annualQuotaCents: '80000000' });
  const rows: Array<[string, number, string]> = [
    ['Northwind', 48000, '2026-01-22'],
    ['Bluebird', 36000, '2026-02-11'],
    ['Copperline', 72000, '2026-02-27'],
    ['Harbor', 54000, '2026-03-18'],
    ['Summit', 30000, '2026-03-31'],
    ['Lakeside', 96000, '2026-04-24'],
    ['Pinecrest', 42000, '2026-05-14'],
    ['Atlas', 120000, '2026-06-26'],
    ['Meridian', 60000, '2026-06-30'],
    ['Quarry', 84000, '2026-07-29'],
    ['Redwood', 66000, '2026-08-20'],
    ['Sterling', 110000, '2026-09-17'],
    ['Tidewater', 45000, '2026-09-30'],
    ['Vantage', 38000, '2026-10-09'],
  ];
  const deals = rows.map(([account, arr, close]) => deal(p, arr, close, { account, expectedPaymentDate: nextMonth15(close) }));
  const pays: Array<[string, string]> = [
    ['2026-02-13', '480000'],
    ['2026-03-13', '1080000'],
    ['2026-04-15', '540000'],
    ['2026-05-15', '1260000'],
    ['2026-06-15', '420000'],
    ['2026-07-15', '1500000'],
    ['2026-08-14', '840000'],
    ['2026-09-15', '600000'],
    ['2026-10-15', '1865000'],
  ];
  return ws({ plans: [p], deals, payments: pays.map(([d, c]) => payment(d, c)) });
}

function describeMatch(m: PaymentMatch) {
  return {
    date: m.payment.paymentDate,
    kind: m.kind,
    lines: m.lines.map((l) => `${l.deal.account}:${l.amountCents.toFixed(0)}`),
    leftover: m.leftoverCents.toFixed(0),
  };
}

function apply(w: Workspace, matches: PaymentMatch[]): Workspace {
  return matches.reduce(
    (acc, m) => setPaymentAllocations(acc, m.payment.id, m.lines.map((l) => ({ dealId: l.deal.id, amountCents: l.amountCents.toFixed(0) }))),
    w,
  );
}

describe('suggestMatches', () => {
  it('matches a year of lump-sum paychecks to the deals they paid for', () => {
    const w = sampleTracker();
    const matches = suggestMatches(w);
    expect(matches.map(describeMatch)).toEqual([
      { date: '2026-02-13', kind: 'exact', lines: ['Northwind:480000'], leftover: '0' },
      { date: '2026-03-13', kind: 'exact', lines: ['Bluebird:360000', 'Copperline:720000'], leftover: '0' },
      // Summit (due Apr 15) wasn't in this check; only Harbor adds up.
      { date: '2026-04-15', kind: 'exact', lines: ['Harbor:540000'], leftover: '0' },
      // ...and turns up a month late alongside Lakeside.
      { date: '2026-05-15', kind: 'exact', lines: ['Summit:300000', 'Lakeside:960000'], leftover: '0' },
      { date: '2026-06-15', kind: 'exact', lines: ['Pinecrest:420000'], leftover: '0' },
      // $15,000 doesn't add up to any set of deals: Atlas is paid in full, Meridian only partly.
      { date: '2026-07-15', kind: 'best_guess', lines: ['Atlas:1200000', 'Meridian:300000'], leftover: '0' },
      { date: '2026-08-14', kind: 'exact', lines: ['Quarry:840000'], leftover: '0' },
      { date: '2026-09-15', kind: 'best_guess', lines: ['Redwood:600000'], leftover: '0' },
      // Sterling crosses quota: $92k x 10% + $18k x 15% = $11,900, plus Tidewater $6,750.
      { date: '2026-10-15', kind: 'exact', lines: ['Sterling:1190000', 'Tidewater:675000'], leftover: '0' },
    ]);
    const r = reconcile(apply(w, matches), 2026, '2026-10-17');
    expect(r.summary.differenceCents.toFixed(0)).toBe('360000');
    expect(r.summary.provisional).toBe(false);
    expect(r.rows.filter((x) => x.isDue && x.differenceCents.gt(0)).map((x) => x.deal.account)).toEqual(['Meridian', 'Redwood']);
  });

  it('prefers the set of deals expected closest to the payment date', () => {
    const p = plan({ acceleratorRate: null });
    const old = deal(p, 10000, '2026-01-05', { account: 'Old', expectedPaymentDate: '2026-02-15' });
    const recent = deal(p, 10000, '2026-02-05', { account: 'Recent', expectedPaymentDate: '2026-03-15' });
    const pay = payment('2026-03-15', '100000');
    const [m] = suggestMatches(ws({ plans: [p], deals: [old, recent], payments: [pay] }));
    expect(m.kind).toBe('exact');
    expect(m.lines.map((l) => l.deal.account)).toEqual(['Recent']);
  });

  it('handles early payments, leftovers, and never allocates to deals that close later', () => {
    const p = plan({ acceleratorRate: null });
    const a = deal(p, 10000, '2026-03-01', { account: 'A', expectedPaymentDate: '2026-04-15' });
    const later = deal(p, 10000, '2026-03-20', { account: 'Later', expectedPaymentDate: '2026-04-30' });
    // Paid before the expected date and before Later even closed, with $250 extra.
    const pay = payment('2026-03-10', '125000');
    const [m] = suggestMatches(ws({ plans: [p], deals: [a, later], payments: [pay] }));
    expect(m.kind).toBe('best_guess');
    expect(m.lines.map((l) => `${l.deal.account}:${l.amountCents.toFixed(0)}`)).toEqual(['A:100000']);
    expect(m.leftoverCents.toFixed(0)).toBe('25000');
  });

  it('skips payments that already have allocations and counts them against deals', () => {
    const p = plan({ acceleratorRate: null });
    const a = deal(p, 10000, '2026-01-05', { account: 'A', expectedPaymentDate: '2026-02-15' });
    const b = deal(p, 10000, '2026-01-06', { account: 'B', expectedPaymentDate: '2026-02-15' });
    const done = payment('2026-02-15', '100000');
    const fresh = payment('2026-02-16', '100000');
    let w = ws({ plans: [p], deals: [a, b], payments: [done, fresh] });
    w = setPaymentAllocations(w, done.id, [{ dealId: a.id, amountCents: '100000' }]);
    const matches = suggestMatches(w);
    expect(matches).toHaveLength(1);
    expect(matches[0].lines.map((l) => l.deal.account)).toEqual(['B']);
  });

  it('reports payments with no likely deals', () => {
    const p = plan();
    const far = deal(p, 10000, '2026-01-05', { expectedPaymentDate: '2026-02-15' });
    const [m] = suggestMatches(ws({ plans: [p], deals: [far], payments: [payment('2026-12-01', '5000')] }));
    expect(m.kind).toBe('none');
    expect(m.leftoverCents.toFixed(0)).toBe('5000');
  });

  it('stays fast with many candidate deals', () => {
    const p = plan({ acceleratorRate: null });
    const deals = Array.from({ length: 60 }, (_, i) => deal(p, 1000 + i, '2026-01-05', { expectedPaymentDate: '2026-02-15' }));
    const start = Date.now();
    suggestMatches(ws({ plans: [p], deals, payments: [payment('2026-02-15', '1')] }));
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
