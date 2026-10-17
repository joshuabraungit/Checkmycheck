/**
 * Pure commission calculation and reconciliation.
 *
 * All money is handled as integer cents using decimal arithmetic. Nothing in
 * this module touches the DOM, storage, or the current time.
 */
import { D, roundHalfUp, sumCents, type Dec } from './money';
import type { Allocation, DateOnly, Deal, Payment, Plan, Workspace } from './types';

/** The part of one deal's revenue that falls inside one tier's band. */
export interface TierSlice {
  tierIndex: number;
  rate: Dec;
  revenueCents: Dec;
  /** Unrounded commission for this slice (may contain fractional cents). */
  exact: Dec;
  /** Rounded for display only. */
  rounded: Dec;
}

/**
 * Retroactive plans only: the catch-up owed on earlier revenue in the period
 * when this deal moves attainment into a higher tier.
 */
export interface TrueUp {
  priorRevenueCents: Dec;
  fromRate: Dec;
  toRate: Dec;
  exact: Dec;
  rounded: Dec;
}

export interface DealCalc {
  deal: Deal;
  plan: Plan;
  /** Position of the deal in commission order within its plan (0-based). */
  orderIndex: number;
  /** 0 for an annual plan; 0 to 3 (Q1 to Q4) for a quarterly plan. */
  periodIndex: number;
  periodQuotaCents: Dec;
  revenueCents: Dec;
  /** Credited revenue in this deal's period before and after it. */
  cumulativeBeforeCents: Dec;
  cumulativeAfterCents: Dec;
  /** This deal's own revenue, by tier. Only slices with revenue are listed. */
  slices: TierSlice[];
  trueUp: TrueUp | null;
  /** Final expected commission, rounded once per deal. */
  expectedCents: Dec;
  /** expected - sum of the rounded parts. Usually 0, sometimes +/- 1 cent. */
  roundingAdjustmentCents: Dec;
}

/** Commission order: close date, then same-day order, then id as a stable tie-breaker. */
export function compareDealsForCommission(a: Deal, b: Deal): number {
  if (a.closeDate !== b.closeDate) return a.closeDate < b.closeDate ? -1 : 1;
  if (a.sameDayOrder !== b.sameDayOrder) return a.sameDayOrder - b.sameDayOrder;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function sortDealsForCommission(deals: readonly Deal[]): Deal[] {
  return [...deals].sort(compareDealsForCommission);
}

/** Which quota period a close date falls in: always 0 for annual plans, else the quarter (0 to 3). */
export function periodIndexFor(plan: Plan, closeDate: DateOnly): number {
  return plan.period === 'quarterly' ? Math.floor((Number(closeDate.slice(5, 7)) - 1) / 3) : 0;
}

export function periodLabel(plan: Plan, periodIndex: number): string {
  return plan.period === 'quarterly' ? `Q${periodIndex + 1} ${plan.year}` : String(plan.year);
}

/** Index of the tier in effect at an attainment level (credited revenue so far). At a threshold, the higher tier applies. */
function tierIndexAt(starts: Dec[], attained: Dec): number {
  let idx = 0;
  for (let i = 1; i < starts.length; i++) if (attained.gte(starts[i])) idx = i;
  return idx;
}

/** Calculate expected commission for every deal in one plan, in commission order. */
export function calculatePlan(plan: Plan, allDeals: readonly Deal[]): DealCalc[] {
  const deals = sortDealsForCommission(allDeals.filter((d) => d.planId === plan.id));
  const rates = plan.tiers.map((t) => new D(t.rate));
  const cumulative = plan.quotasCents.map(() => new D(0));
  return deals.map((deal, orderIndex) => {
    const periodIndex = periodIndexFor(plan, deal.closeDate);
    const quota = new D(plan.quotasCents[periodIndex]);
    // Where each tier's band starts, in credited revenue for this period.
    const starts = plan.tiers.map((t) => quota.times(t.fromAttainment));
    const revenue = new D(deal.creditedRevenueCents);
    const before = cumulative[periodIndex];
    const after = before.plus(revenue);
    cumulative[periodIndex] = after;

    const slices: TierSlice[] = [];
    let trueUp: TrueUp | null = null;
    if (plan.tierMode === 'marginal') {
      for (let i = 0; i < starts.length; i++) {
        const lo = D.max(before, starts[i]);
        const hi = i + 1 < starts.length ? D.min(after, starts[i + 1]) : after;
        const part = hi.minus(lo);
        if (part.lte(0)) continue;
        const exact = part.times(rates[i]);
        slices.push({ tierIndex: i, rate: rates[i], revenueCents: part, exact, rounded: roundHalfUp(exact) });
      }
    } else {
      const fromIdx = tierIndexAt(starts, before);
      const toIdx = tierIndexAt(starts, after);
      const exact = revenue.times(rates[toIdx]);
      slices.push({ tierIndex: toIdx, rate: rates[toIdx], revenueCents: revenue, exact, rounded: roundHalfUp(exact) });
      if (toIdx !== fromIdx && before.gt(0)) {
        const lift = rates[toIdx].minus(rates[fromIdx]);
        const upExact = before.times(lift);
        trueUp = { priorRevenueCents: before, fromRate: rates[fromIdx], toRate: rates[toIdx], exact: upExact, rounded: roundHalfUp(upExact) };
      }
    }
    if (slices.length === 0) {
      slices.push({ tierIndex: 0, rate: rates[0], revenueCents: new D(0), exact: new D(0), rounded: new D(0) });
    }
    const exactTotal = sumCents(slices.map((x) => x.exact)).plus(trueUp?.exact ?? 0);
    const expected = roundHalfUp(exactTotal);
    const roundedParts = sumCents(slices.map((x) => x.rounded)).plus(trueUp?.rounded ?? 0);
    return {
      deal,
      plan,
      orderIndex,
      periodIndex,
      periodQuotaCents: quota,
      revenueCents: revenue,
      cumulativeBeforeCents: before,
      cumulativeAfterCents: after,
      slices,
      trueUp,
      expectedCents: expected,
      roundingAdjustmentCents: expected.minus(roundedParts),
    };
  });
}

/** Expected commissions for every deal in the workspace, keyed by deal id. */
export function calculateAll(ws: Workspace): Map<string, DealCalc> {
  const out = new Map<string, DealCalc>();
  for (const plan of ws.plans) {
    for (const calc of calculatePlan(plan, ws.deals)) out.set(calc.deal.id, calc);
  }
  return out;
}

export function planTotalExpected(plan: Plan, deals: readonly Deal[]): Dec {
  return sumCents(calculatePlan(plan, deals).map((c) => c.expectedCents));
}

export type DealStatus =
  | 'upcoming'
  | 'received_early'
  | 'due_today'
  | 'not_received'
  | 'partial'
  | 'matched'
  | 'more_than_expected';

export const STATUS_LABELS: Record<DealStatus, string> = {
  upcoming: 'Upcoming',
  received_early: 'Received early',
  due_today: 'Due today',
  not_received: 'Not received',
  partial: 'Partially received',
  matched: 'Matched',
  more_than_expected: 'More than expected',
};

export interface AllocationView {
  allocation: Allocation;
  payment: Payment;
  /** True when the payment date is on or before the as-of date. */
  counted: boolean;
}

export interface DealReconciliation extends DealCalc {
  allocations: AllocationView[];
  receivedAsOfCents: Dec;
  /** expected - receivedAsOf. Positive: still expected. Negative: more received. */
  differenceCents: Dec;
  isDue: boolean;
  status: DealStatus;
}

export function dealStatus(expectedPaymentDate: DateOnly, asOf: DateOnly, expected: Dec, received: Dec): DealStatus {
  if (expectedPaymentDate > asOf) return received.gt(0) ? 'received_early' : 'upcoming';
  if (received.isZero()) return expectedPaymentDate === asOf ? 'due_today' : 'not_received';
  const cmp = received.cmp(expected);
  if (cmp < 0) return 'partial';
  if (cmp === 0) return 'matched';
  return 'more_than_expected';
}

export interface ReconciliationSummary {
  planYear: number;
  asOf: DateOnly;
  /** A. Expected commissions for due deals (expected payment date <= as-of). */
  expectedDueCents: Dec;
  /** B. Allocated payments received on or before as-of toward due deals. */
  receivedDueCents: Dec;
  /** C. A - B, signed. */
  differenceCents: Dec;
  /** Expected commissions for deals whose expected payment date is after as-of. */
  expectedLaterCents: Dec;
  /** Payments received on or before as-of, allocated to deals not yet due. */
  receivedEarlyCents: Dec;
  /** Unallocated balances of all payments received on or before as-of. */
  unallocatedCents: Dec;
  /** Payments whose payment date falls in the plan year and on or before as-of. */
  paymentsInYearCents: Dec;
  /** Sum of positive differences on due deals. */
  positiveDiscrepanciesCents: Dec;
  /** Sum of negative differences on due deals, as a positive number. */
  excessReceiptsCents: Dec;
  dueDealCount: number;
  laterDealCount: number;
  /** True while unallocated money exists, so the comparison is incomplete. */
  provisional: boolean;
}

export interface Reconciliation {
  plan: Plan | null;
  rows: DealReconciliation[];
  summary: ReconciliationSummary;
}

/** Total allocated per payment id. */
export function allocatedByPayment(ws: Pick<Workspace, 'allocations'>): Map<string, Dec> {
  const totals = new Map<string, Dec>();
  for (const a of ws.allocations) {
    totals.set(a.paymentId, (totals.get(a.paymentId) ?? new D(0)).plus(a.amountCents));
  }
  return totals;
}

export function unallocatedForPayment(ws: Pick<Workspace, 'allocations'>, payment: Payment): Dec {
  const allocated = allocatedByPayment(ws).get(payment.id) ?? new D(0);
  return new D(payment.amountCents).minus(allocated);
}

/**
 * Calculate the full plan, then apply payment-date and expected-payment-date
 * filters to produce the reconciliation as of a date.
 */
export function reconcile(ws: Workspace, planYear: number, asOf: DateOnly): Reconciliation {
  const plan = ws.plans.find((p) => p.year === planYear) ?? null;
  const calcs = plan ? calculatePlan(plan, ws.deals) : [];
  const paymentsById = new Map(ws.payments.map((p) => [p.id, p]));
  const allocsByDeal = new Map<string, Allocation[]>();
  for (const a of ws.allocations) {
    const list = allocsByDeal.get(a.dealId) ?? [];
    list.push(a);
    allocsByDeal.set(a.dealId, list);
  }

  const zero = new D(0);
  let expectedDue = zero;
  let receivedDue = zero;
  let expectedLater = zero;
  let receivedEarly = zero;
  let positive = zero;
  let excess = zero;
  let dueCount = 0;
  let laterCount = 0;

  const rows: DealReconciliation[] = calcs.map((calc) => {
    const allocations: AllocationView[] = (allocsByDeal.get(calc.deal.id) ?? [])
      .map((allocation) => {
        const payment = paymentsById.get(allocation.paymentId)!;
        return { allocation, payment, counted: payment.paymentDate <= asOf };
      })
      .sort((a, b) =>
        a.payment.paymentDate === b.payment.paymentDate
          ? a.allocation.id.localeCompare(b.allocation.id)
          : a.payment.paymentDate < b.payment.paymentDate ? -1 : 1,
      );
    const received = sumCents(allocations.filter((v) => v.counted).map((v) => v.allocation.amountCents));
    const difference = calc.expectedCents.minus(received);
    const isDue = calc.deal.expectedPaymentDate <= asOf;
    if (isDue) {
      dueCount++;
      expectedDue = expectedDue.plus(calc.expectedCents);
      receivedDue = receivedDue.plus(received);
      if (difference.gt(0)) positive = positive.plus(difference);
      if (difference.lt(0)) excess = excess.plus(difference.neg());
    } else {
      laterCount++;
      expectedLater = expectedLater.plus(calc.expectedCents);
      receivedEarly = receivedEarly.plus(received);
    }
    return {
      ...calc,
      allocations,
      receivedAsOfCents: received,
      differenceCents: difference,
      isDue,
      status: dealStatus(calc.deal.expectedPaymentDate, asOf, calc.expectedCents, received),
    };
  });

  const allocated = allocatedByPayment(ws);
  let unallocated = zero;
  let paymentsInYear = zero;
  for (const p of ws.payments) {
    if (p.paymentDate > asOf) continue;
    unallocated = unallocated.plus(new D(p.amountCents).minus(allocated.get(p.id) ?? zero));
    if (Number(p.paymentDate.slice(0, 4)) === planYear) paymentsInYear = paymentsInYear.plus(p.amountCents);
  }

  return {
    plan,
    rows,
    summary: {
      planYear,
      asOf,
      expectedDueCents: expectedDue,
      receivedDueCents: receivedDue,
      differenceCents: expectedDue.minus(receivedDue),
      expectedLaterCents: expectedLater,
      receivedEarlyCents: receivedEarly,
      unallocatedCents: unallocated,
      paymentsInYearCents: paymentsInYear,
      positiveDiscrepanciesCents: positive,
      excessReceiptsCents: excess,
      dueDealCount: dueCount,
      laterDealCount: laterCount,
      provisional: unallocated.gt(0),
    },
  };
}

export interface ImpactSummary {
  oldTotalCents: Dec;
  newTotalCents: Dec;
  /** Deals (that exist in both versions) whose expected commission changed. */
  changedDealIds: string[];
  /** Changed deals other than the ones the user directly edited. */
  otherChangedDealIds: string[];
}

/**
 * Compare expected commissions for a plan year across two workspace versions.
 * Used to preview edits that ripple through later deals.
 */
export function compareExpected(
  before: Workspace,
  after: Workspace,
  planIds: readonly string[],
  directlyEditedDealIds: readonly string[] = [],
): ImpactSummary {
  const oldCalc = calculateAll(before);
  const newCalc = calculateAll(after);
  const inPlans = (c: DealCalc) => planIds.includes(c.plan.id);
  const oldTotal = sumCents([...oldCalc.values()].filter(inPlans).map((c) => c.expectedCents));
  const newTotal = sumCents([...newCalc.values()].filter(inPlans).map((c) => c.expectedCents));
  const changed: string[] = [];
  for (const [id, n] of newCalc) {
    if (!inPlans(n)) continue;
    const o = oldCalc.get(id);
    if (o && !o.expectedCents.eq(n.expectedCents)) changed.push(id);
  }
  return {
    oldTotalCents: oldTotal,
    newTotalCents: newTotal,
    changedDealIds: changed,
    otherChangedDealIds: changed.filter((id) => !directlyEditedDealIds.includes(id)),
  };
}

/**
 * Suggest how a payment splits across deals: oldest expected payment date
 * first, each deal filled up to what other payments haven't covered yet.
 * Only deals already due by the payment date get a suggestion; anything left
 * over stays unallocated rather than being guessed onto future deals.
 */
export function suggestAllocations(
  ws: Workspace,
  paymentDate: DateOnly,
  amountCents: Dec,
  excludePaymentId?: string,
): Map<string, Dec> {
  const calcs = calculateAll(ws);
  const fromOthers = new Map<string, Dec>();
  for (const a of ws.allocations) {
    if (a.paymentId === excludePaymentId) continue;
    fromOthers.set(a.dealId, (fromOthers.get(a.dealId) ?? new D(0)).plus(a.amountCents));
  }
  const due = sortDealsForCommission(ws.deals.filter((d) => d.expectedPaymentDate <= paymentDate)).sort((a, b) =>
    a.expectedPaymentDate.localeCompare(b.expectedPaymentDate),
  );
  const result = new Map<string, Dec>();
  let left = amountCents;
  for (const d of due) {
    if (left.lte(0)) break;
    const outstanding = calcs.get(d.id)!.expectedCents.minus(fromOthers.get(d.id) ?? 0);
    if (outstanding.lte(0)) continue;
    const take = D.min(outstanding, left);
    result.set(d.id, take);
    left = left.minus(take);
  }
  return result;
}
