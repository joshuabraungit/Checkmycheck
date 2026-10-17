import { describe, expect, it } from 'vitest';
import { calculatePlan, compareExpected, reconcile, suggestAllocations } from './calc';
import { D } from './money';
import { demoWorkspace, DEMO_AS_OF } from './demo';
import { deleteDeal, moveDealSameDay, OpError, saveDeal, setPaymentAllocations, savePayment } from './ops';
import { deal, payment, plan, ws } from './testHelpers';

const s = (d: { toFixed: (n: number) => string }) => d.toFixed(0);

describe('expected commission', () => {
  it('1. below quota earns only the base rate', () => {
    const p = plan();
    const [c] = calculatePlan(p, [deal(p, 40000, '2026-02-01')]);
    expect(s(c.basePortionCents)).toBe('4000000');
    expect(s(c.acceleratedPortionCents)).toBe('0');
    expect(s(c.expectedCents)).toBe('400000'); // $4,000
  });

  it('2. a deal crossing quota splits at the quota line', () => {
    const p = plan();
    const first = deal(p, 60000, '2026-01-10');
    const crossing = deal(p, 50000, '2026-02-10');
    const [, c] = calculatePlan(p, [first, crossing]);
    expect(s(c.cumulativeBeforeCents)).toBe('6000000');
    expect(s(c.cumulativeAfterCents)).toBe('11000000');
    expect(s(c.basePortionCents)).toBe('4000000');
    expect(s(c.acceleratedPortionCents)).toBe('1000000');
    expect(s(c.baseComponentRounded)).toBe('400000');
    expect(s(c.acceleratedComponentRounded)).toBe('150000');
    expect(s(c.expectedCents)).toBe('550000'); // $5,500
  });

  it('3. a deal entirely above quota earns only the accelerator', () => {
    const p = plan();
    const [, c] = calculatePlan(p, [deal(p, 120000, '2026-01-10'), deal(p, 10000, '2026-02-10')]);
    expect(s(c.basePortionCents)).toBe('0');
    expect(s(c.expectedCents)).toBe('150000');
  });

  it('4. hitting quota exactly keeps the deal at base; the next dollar accelerates', () => {
    const p = plan();
    const [a, b] = calculatePlan(p, [deal(p, 100000, '2026-01-10'), deal(p, 1, '2026-01-11')]);
    expect(s(a.acceleratedPortionCents)).toBe('0');
    expect(s(a.expectedCents)).toBe('1000000');
    expect(s(b.basePortionCents)).toBe('0');
    expect(s(b.expectedCents)).toBe('15'); // $1 at 15%
  });

  it('5. with the accelerator disabled every dollar earns base', () => {
    const p = plan({ acceleratorRate: null });
    const [, c] = calculatePlan(p, [deal(p, 90000, '2026-01-10'), deal(p, 50000, '2026-02-10')]);
    expect(s(c.acceleratedPortionCents)).toBe('0');
    expect(s(c.expectedCents)).toBe('500000');
  });

  it('6. same-day deals follow same-day order, then id', () => {
    const p = plan();
    const a = deal(p, 60000, '2026-03-01', { id: 'ffffffff-0000-4000-8000-000000000000', sameDayOrder: 0 });
    const b = deal(p, 60000, '2026-03-01', { id: '00000000-0000-4000-8000-000000000001', sameDayOrder: 1 });
    let calcs = calculatePlan(p, [b, a]);
    expect(calcs.map((c) => c.deal.id)).toEqual([a.id, b.id]);
    expect(s(calcs[0].expectedCents)).toBe('600000');
    expect(s(calcs[1].expectedCents)).toBe('700000'); // 40k*10% + 20k*15%

    // Equal order falls back to id.
    calcs = calculatePlan(p, [{ ...a, sameDayOrder: 0 }, { ...b, sameDayOrder: 0 }]);
    expect(calcs.map((c) => c.deal.id)).toEqual([b.id, a.id]);

    // Reordering moves accelerator credit and is captured by the impact preview.
    const before = ws({ plans: [p], deals: [a, b] });
    const after = moveDealSameDay(before, b.id, -1);
    const order = calculatePlan(p, after.deals).map((c) => c.deal.id);
    expect(order).toEqual([b.id, a.id]);
    const impact = compareExpected(before, after, [p.id]);
    expect(impact.changedDealIds.sort()).toEqual([a.id, b.id].sort());
    expect(s(impact.oldTotalCents)).toBe(s(impact.newTotalCents));
  });

  it('7. editing an earlier deal recalculates later deals', () => {
    const p = plan();
    const early = deal(p, 50000, '2026-01-10');
    const late = deal(p, 60000, '2026-05-10');
    const before = ws({ plans: [p], deals: [early, late] });
    expect(s(calculatePlan(p, before.deals)[1].expectedCents)).toBe('650000'); // 50k*10% + 10k*15%
    const { workspace: after } = saveDeal(before, { ...early, creditedRevenueCents: '7000000' });
    const lateCalc = calculatePlan(p, after.deals)[1];
    expect(s(lateCalc.basePortionCents)).toBe('3000000');
    expect(s(lateCalc.expectedCents)).toBe('750000'); // 30k*10% + 30k*15%
    const impact = compareExpected(before, after, [p.id], [early.id]);
    expect(impact.otherChangedDealIds).toEqual([late.id]);
    expect(s(impact.oldTotalCents)).toBe('1150000');
    expect(s(impact.newTotalCents)).toBe('1450000');
  });

  it('8. rounds fractional cents half up once per deal and reports any display adjustment', () => {
    const p = plan({ annualQuotaCents: '10', baseRate: '0.125', acceleratorRate: '0.135' });
    // R = $0.13 -> 13 cents, C = 0. base portion 10c*0.125 = 1.25c, accel 3c*0.135 = 0.405c => 1.655 -> 2
    const [c] = calculatePlan(p, [deal(p, '0.13', '2026-01-01')]);
    expect(c.expectedCents.toFixed(0)).toBe('2');
    expect(c.baseComponentRounded.toFixed(0)).toBe('1');
    expect(c.acceleratedComponentRounded.toFixed(0)).toBe('0');
    expect(c.roundingAdjustmentCents.toFixed(0)).toBe('1');

    // Exactly half a cent rounds up.
    const p2 = plan({ baseRate: '0.05', acceleratorRate: null });
    const [half] = calculatePlan(p2, [deal(p2, '0.01', '2026-01-01')]); // 1c * 5% = 0.05c
    expect(half.expectedCents.toFixed(0)).toBe('0');
    const [half2] = calculatePlan(p2, [deal(p2, '0.10', '2026-01-01')]); // 10c * 5% = 0.5c -> 1
    expect(half2.expectedCents.toFixed(0)).toBe('1');

    // No float drift: 0.1 + 0.2 style values.
    const p3 = plan({ baseRate: '0.07', acceleratorRate: null });
    const [f] = calculatePlan(p3, [deal(p3, '1234567.89', '2026-01-01')]);
    expect(f.expectedCents.toFixed(0)).toBe('8641975'); // 123456789 * 0.07 = 8641975.23
  });

  it('keeps arbitrary precision for very large totals', () => {
    const p = plan({ annualQuotaCents: '99999999999', baseRate: '1', acceleratorRate: null });
    const deals = Array.from({ length: 200 }, (_, i) => deal(p, '999999999.99', `2026-01-${String((i % 28) + 1).padStart(2, '0')}`));
    const total = calculatePlan(p, deals).reduce((acc, c) => acc + BigInt(c.expectedCents.toFixed(0)), 0n);
    expect(total.toString()).toBe((99999999999n * 200n).toString());
  });

  it('resets quota attainment each calendar year', () => {
    const p25 = plan({ year: 2025 });
    const p26 = plan({ year: 2026 });
    const w = ws({ plans: [p25, p26], deals: [deal(p25, 150000, '2025-06-01'), deal(p26, 50000, '2026-01-05')] });
    const r = reconcile(w, 2026, '2026-12-31');
    expect(s(r.rows[0].cumulativeBeforeCents)).toBe('0');
    expect(s(r.rows[0].expectedCents)).toBe('500000');
  });
});

describe('reconciliation', () => {
  function setup() {
    const p = plan();
    const due = deal(p, 10000, '2026-01-10', { expectedPaymentDate: '2026-02-15' }); // $1,000
    const later = deal(p, 20000, '2026-02-01', { expectedPaymentDate: '2026-04-15' }); // $2,000
    return { p, due, later, base: ws({ plans: [p], deals: [due, later] }) };
  }

  it('9. future expected commissions are excluded from due totals', () => {
    const { base } = setup();
    const r = reconcile(base, 2026, '2026-03-31');
    expect(s(r.summary.expectedDueCents)).toBe('100000');
    expect(s(r.summary.expectedLaterCents)).toBe('200000');
    expect(r.rows.map((x) => x.status)).toEqual(['not_received', 'upcoming']);
    // Due today has its own status.
    expect(reconcile(base, 2026, '2026-02-15').rows[0].status).toBe('due_today');
  });

  it('10. payments dated after the as-of date are not counted as received', () => {
    const { base, due } = setup();
    const pay = payment('2026-04-02', '100000');
    let w = { ...base, payments: [pay] };
    w = setPaymentAllocations(w, pay.id, [{ dealId: due.id, amountCents: '100000' }]);
    const r = reconcile(w, 2026, '2026-03-31');
    expect(s(r.rows[0].receivedAsOfCents)).toBe('0');
    expect(s(r.summary.differenceCents)).toBe('100000');
    expect(s(r.summary.paymentsInYearCents)).toBe('0');
    expect(s(r.summary.unallocatedCents)).toBe('0');
    expect(s(reconcile(w, 2026, '2026-04-02').rows[0].receivedAsOfCents)).toBe('100000');
  });

  it('11. handles partial and multiple payments toward one deal', () => {
    const { base, due } = setup();
    const p1 = payment('2026-02-15', '40000');
    const p2 = payment('2026-03-01', '50000');
    let w = { ...base, payments: [p1, p2] };
    w = setPaymentAllocations(w, p1.id, [{ dealId: due.id, amountCents: '40000' }]);
    let r = reconcile(w, 2026, '2026-03-31');
    expect(r.rows[0].status).toBe('partial');
    expect(s(r.rows[0].differenceCents)).toBe('60000');
    w = setPaymentAllocations(w, p2.id, [{ dealId: due.id, amountCents: '50000' }]);
    r = reconcile(w, 2026, '2026-03-31');
    expect(s(r.rows[0].receivedAsOfCents)).toBe('90000');
    expect(r.rows[0].allocations).toHaveLength(2);
    expect(r.rows[0].status).toBe('partial');
  });

  it('12. allocations above expected show as excess receipts', () => {
    const { base, due } = setup();
    const pay = payment('2026-02-15', '120000');
    const w = setPaymentAllocations({ ...base, payments: [pay] }, pay.id, [{ dealId: due.id, amountCents: '120000' }]);
    const r = reconcile(w, 2026, '2026-03-31');
    expect(r.rows[0].status).toBe('more_than_expected');
    expect(s(r.rows[0].differenceCents)).toBe('-20000');
    expect(s(r.summary.excessReceiptsCents)).toBe('20000');
    expect(s(r.summary.differenceCents)).toBe('-20000');
  });

  it('13. unallocated money stays separate and marks the comparison provisional', () => {
    const { base } = setup();
    const w = { ...base, payments: [payment('2026-02-15', '100000')] };
    const r = reconcile(w, 2026, '2026-03-31');
    expect(s(r.summary.unallocatedCents)).toBe('100000');
    expect(s(r.summary.receivedDueCents)).toBe('0');
    expect(s(r.summary.differenceCents)).toBe('100000');
    expect(r.summary.provisional).toBe(true);
  });

  it('14. early payments stay separate from due totals', () => {
    const { base, later } = setup();
    const pay = payment('2026-03-01', '200000');
    const w = setPaymentAllocations({ ...base, payments: [pay] }, pay.id, [{ dealId: later.id, amountCents: '200000' }]);
    const r = reconcile(w, 2026, '2026-03-31');
    expect(r.rows[1].status).toBe('received_early');
    expect(s(r.summary.receivedEarlyCents)).toBe('200000');
    expect(s(r.summary.receivedDueCents)).toBe('0');
    expect(s(r.summary.differenceCents)).toBe('100000');
    expect(r.summary.provisional).toBe(false);
  });

  it('15. blocks allocating more than the payment', () => {
    const { base, due, later } = setup();
    const pay = payment('2026-03-01', '100000');
    const w = { ...base, payments: [pay] };
    expect(() =>
      setPaymentAllocations(w, pay.id, [
        { dealId: due.id, amountCents: '60000' },
        { dealId: later.id, amountCents: '40001' },
      ]),
    ).toThrow(OpError);
    expect(() => setPaymentAllocations(w, pay.id, [{ dealId: due.id, amountCents: '100000' }])).not.toThrow();
  });

  it('blocks allocating to a deal that closes after the payment date and allows early payments', () => {
    const { base, later } = setup();
    const tooEarly = payment('2026-01-15', '1000');
    expect(() => setPaymentAllocations({ ...base, payments: [tooEarly] }, tooEarly.id, [{ dealId: later.id, amountCents: '1000' }])).toThrow(
      /closes/,
    );
    const beforeExpected = payment('2026-02-01', '1000');
    expect(() =>
      setPaymentAllocations({ ...base, payments: [beforeExpected] }, beforeExpected.id, [{ dealId: later.id, amountCents: '1000' }]),
    ).not.toThrow();
  });

  it('blocks payment edits below the allocated amount or before an allocated deal closes', () => {
    const { base, due } = setup();
    const pay = payment('2026-02-15', '100000');
    const w = setPaymentAllocations({ ...base, payments: [pay] }, pay.id, [{ dealId: due.id, amountCents: '80000' }]);
    expect(() => savePayment(w, { ...pay, amountCents: '79999' })).toThrow(/allocated/);
    expect(() => savePayment(w, { ...pay, amountCents: '80000' })).not.toThrow();
    expect(() => savePayment(w, { ...pay, paymentDate: '2026-01-01' })).toThrow(/closes/);
  });

  it('16. deleting a deal returns its allocations to unallocated money', () => {
    const { base, due, later } = setup();
    const pay = payment('2026-03-01', '300000');
    let w = setPaymentAllocations({ ...base, payments: [pay] }, pay.id, [
      { dealId: due.id, amountCents: '100000' },
      { dealId: later.id, amountCents: '200000' },
    ]);
    expect(s(reconcile(w, 2026, '2026-03-31').summary.unallocatedCents)).toBe('0');
    w = deleteDeal(w, due.id);
    expect(w.payments).toHaveLength(1);
    expect(w.allocations).toHaveLength(1);
    const r = reconcile(w, 2026, '2026-03-31');
    expect(s(r.summary.unallocatedCents)).toBe('100000');
    // Later deal now gets base rate on its full revenue (it was always under quota) - unchanged here.
    expect(s(r.rows[0].expectedCents)).toBe('200000');
  });

  it('17. a January payment can settle a prior-year deal without counting toward next year', () => {
    const p26 = plan({ year: 2026 });
    const p27 = plan({ year: 2027 });
    const dec = deal(p26, 30000, '2026-12-15', { expectedPaymentDate: '2027-01-15' });
    const jan = deal(p27, 10000, '2027-01-05', { expectedPaymentDate: '2027-02-15' });
    const pay = payment('2027-01-15', '300000');
    const w = setPaymentAllocations(ws({ plans: [p26, p27], deals: [dec, jan], payments: [pay] }), pay.id, [
      { dealId: dec.id, amountCents: '300000' },
    ]);
    const r26 = reconcile(w, 2026, '2027-01-31');
    expect(r26.rows[0].status).toBe('matched');
    expect(s(r26.summary.paymentsInYearCents)).toBe('0'); // payment-year total follows payment dates
    const r27 = reconcile(w, 2027, '2027-01-31');
    expect(s(r27.rows[0].cumulativeBeforeCents)).toBe('0');
    expect(s(r27.summary.paymentsInYearCents)).toBe('300000');
    expect(s(r27.summary.receivedDueCents)).toBe('0');
  });

  it('18. shortfalls and excess receipts stay visible when they net to zero', () => {
    const p = plan();
    const a = deal(p, 10000, '2026-01-10', { expectedPaymentDate: '2026-02-01' }); // $1,000
    const b = deal(p, 10000, '2026-01-11', { expectedPaymentDate: '2026-02-01' }); // $1,000
    const pay = payment('2026-02-01', '200000');
    const w = setPaymentAllocations(ws({ plans: [p], deals: [a, b], payments: [pay] }), pay.id, [
      { dealId: a.id, amountCents: '50000' },
      { dealId: b.id, amountCents: '150000' },
    ]);
    const r = reconcile(w, 2026, '2026-03-31');
    expect(s(r.summary.differenceCents)).toBe('0');
    expect(s(r.summary.positiveDiscrepanciesCents)).toBe('50000');
    expect(s(r.summary.excessReceiptsCents)).toBe('50000');
    expect(r.rows.map((x) => x.status)).toEqual(['partial', 'more_than_expected']);
  });
});

describe('demo workspace', () => {
  it('21. matches the documented totals exactly', () => {
    const r = reconcile(demoWorkspace(), 2026, DEMO_AS_OF);
    expect(s(r.summary.expectedDueCents)).toBe('1450000');
    expect(s(r.summary.receivedDueCents)).toBe('1395000');
    expect(s(r.summary.differenceCents)).toBe('55000');
    expect(s(r.summary.expectedLaterCents)).toBe('150000');
    expect(s(r.summary.unallocatedCents)).toBe('0');
    expect(r.summary.provisional).toBe(false);
    const byAccount = Object.fromEntries(r.rows.map((row) => [row.deal.account, row]));
    expect(s(byAccount.Acme.expectedCents)).toBe('600000');
    expect(s(byAccount.Beacon.expectedCents)).toBe('550000');
    expect(s(byAccount.Cedar.expectedCents)).toBe('300000');
    expect(s(byAccount.Delta.expectedCents)).toBe('150000');
    expect(s(byAccount.Beacon.differenceCents)).toBe('50000');
    expect(s(byAccount.Cedar.differenceCents)).toBe('5000');
    expect(byAccount.Acme.status).toBe('matched');
    expect(byAccount.Delta.status).toBe('upcoming');
  });
});

describe('suggested allocations', () => {
  it('fills the oldest due deals first and leaves the rest unallocated', () => {
    const p = plan();
    const acme = deal(p, 60000, '2026-01-10', { expectedPaymentDate: '2026-02-15' });
    const beacon = deal(p, 50000, '2026-02-10', { expectedPaymentDate: '2026-03-15' });
    const later = deal(p, 5000, '2026-03-01', { expectedPaymentDate: '2026-04-15' });
    const w = ws({ plans: [p], deals: [beacon, later, acme] });
    const out = suggestAllocations(w, '2026-03-15', new D('1200000'));
    expect(s(out.get(acme.id)!)).toBe('600000');
    expect(s(out.get(beacon.id)!)).toBe('550000');
    expect(out.has(later.id)).toBe(false); // not due yet; $500 stays unallocated
  });

  it('skips what other payments already covered, but not the payment being edited', () => {
    const p = plan();
    const acme = deal(p, 60000, '2026-01-10', { expectedPaymentDate: '2026-02-15' });
    const beacon = deal(p, 50000, '2026-02-10', { expectedPaymentDate: '2026-03-15' });
    const feb = payment('2026-02-15', '400000');
    const mar = payment('2026-03-15', '500000');
    const w = ws({
      plans: [p],
      deals: [acme, beacon],
      payments: [feb, mar],
      allocations: [
        { id: 'a1', paymentId: feb.id, dealId: acme.id, amountCents: '400000' },
        { id: 'a2', paymentId: mar.id, dealId: acme.id, amountCents: '200000' },
      ],
    });
    const out = suggestAllocations(w, '2026-03-15', new D('500000'), mar.id);
    expect(s(out.get(acme.id)!)).toBe('200000');
    expect(s(out.get(beacon.id)!)).toBe('300000');
  });
});
