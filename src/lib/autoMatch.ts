/**
 * Suggest which deals each unmatched payment paid for.
 *
 * Payroll usually pays several deals in one lump. For each payment with no
 * allocations yet, look at deals whose commission was expected around the
 * payment date and still has money outstanding:
 *
 * 1. Exact: a set of deals whose outstanding amounts add up to the payment
 *    to the cent. When several sets work, the one with expected payment
 *    dates closest to the payment date wins.
 * 2. Best guess: otherwise, fill the deals that were due by the payment
 *    date, closest to it first (this pay cycle before older catch-up),
 *    until the money runs out. Whatever doesn't fit is
 *    left unallocated, and a deal that only partly fits is paid partly.
 *
 * Payments are processed in date order so earlier payments settle deals
 * before later ones are considered. Nothing here is saved; the person
 * reviews every suggestion first.
 */
import { calculateAll, compareDealsForCommission } from './calc';
import { daysBetween } from './dates';
import { D, type Dec } from './money';
import type { Deal, Payment, Workspace } from './types';

/** How far an expected payment date can be from the actual payment date to count as a candidate. */
export const DAYS_LATE = 120;
export const DAYS_EARLY = 45;
const MAX_CANDIDATES = 18;
const SEARCH_LIMIT = 200_000;

export type MatchKind = 'exact' | 'best_guess' | 'none';

export interface MatchLine {
  deal: Deal;
  amountCents: Dec;
  /** What the deal still had outstanding before this payment. */
  outstandingCents: Dec;
}

export interface PaymentMatch {
  payment: Payment;
  kind: MatchKind;
  lines: MatchLine[];
  /** Money from this payment the suggestion leaves unallocated. */
  leftoverCents: Dec;
}

interface Candidate {
  deal: Deal;
  outstanding: Dec;
  distance: number;
}

/** Smallest-total-distance set of candidates whose outstanding sums exactly to target. */
function exactSubset(cands: Candidate[], target: Dec): Candidate[] | null {
  let best: Candidate[] | null = null;
  let bestScore = Infinity;
  let visited = 0;
  const chosen: Candidate[] = [];
  // Suffix sums let us stop early when the rest can't reach the target.
  const suffix: Dec[] = new Array(cands.length + 1);
  suffix[cands.length] = new D(0);
  for (let i = cands.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1].plus(cands[i].outstanding);

  function walk(i: number, sum: Dec, score: number) {
    if (++visited > SEARCH_LIMIT) return;
    if (sum.eq(target)) {
      if (score < bestScore || (score === bestScore && best && chosen.length < best.length)) {
        best = [...chosen];
        bestScore = score;
      }
      return;
    }
    if (i >= cands.length || score >= bestScore || sum.plus(suffix[i]).lt(target)) return;
    const c = cands[i];
    const next = sum.plus(c.outstanding);
    if (next.lte(target)) {
      chosen.push(c);
      walk(i + 1, next, score + c.distance + 1);
      chosen.pop();
    }
    walk(i + 1, sum, score);
  }
  walk(0, new D(0), 0);
  return best;
}

export function suggestMatches(ws: Workspace): PaymentMatch[] {
  const calcs = calculateAll(ws);
  const outstanding = new Map<string, Dec>();
  for (const [id, c] of calcs) outstanding.set(id, c.expectedCents);
  const allocatedPaymentIds = new Set<string>();
  for (const a of ws.allocations) {
    outstanding.set(a.dealId, (outstanding.get(a.dealId) ?? new D(0)).minus(a.amountCents));
    allocatedPaymentIds.add(a.paymentId);
  }

  const payments = ws.payments
    .filter((p) => !allocatedPaymentIds.has(p.id))
    .sort((a, b) => a.paymentDate.localeCompare(b.paymentDate) || a.id.localeCompare(b.id));

  return payments.map((payment) => {
    const amount = new D(payment.amountCents);
    const cands: Candidate[] = ws.deals
      .filter((d) => d.closeDate <= payment.paymentDate && (outstanding.get(d.id) ?? new D(0)).gt(0))
      .map((d) => ({ deal: d, outstanding: outstanding.get(d.id)!, distance: daysBetween(d.expectedPaymentDate, payment.paymentDate) }))
      .filter((c) => c.distance >= -DAYS_EARLY && c.distance <= DAYS_LATE)
      .sort((a, b) => Math.abs(a.distance) - Math.abs(b.distance) || compareDealsForCommission(a.deal, b.deal))
      .slice(0, MAX_CANDIDATES)
      .map((c) => ({ ...c, distance: Math.abs(c.distance) }));

    let lines: MatchLine[] = [];
    let kind: MatchKind = 'none';
    const exact = cands.length ? exactSubset(cands, amount) : null;
    if (exact) {
      kind = 'exact';
      lines = exact
        .sort((a, b) => compareDealsForCommission(a.deal, b.deal))
        .map((c) => ({ deal: c.deal, amountCents: c.outstanding, outstandingCents: c.outstanding }));
    } else {
      // Fill this pay cycle first: deals due by the payment date, closest to it first, then anything paid early.
      const due = cands.filter((c) => c.deal.expectedPaymentDate <= payment.paymentDate);
      const pool = due.length ? due : cands;
      let left = amount;
      for (const c of pool) {
        if (left.lte(0)) break;
        const take = D.min(c.outstanding, left);
        lines.push({ deal: c.deal, amountCents: take, outstandingCents: c.outstanding });
        left = left.minus(take);
      }
      if (lines.length) kind = 'best_guess';
    }

    for (const l of lines) outstanding.set(l.deal.id, outstanding.get(l.deal.id)!.minus(l.amountCents));
    const used = lines.reduce((acc, l) => acc.plus(l.amountCents), new D(0));
    return { payment, kind, lines, leftoverCents: amount.minus(used) };
  });
}
