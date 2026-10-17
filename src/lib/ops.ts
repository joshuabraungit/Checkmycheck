/**
 * Pure workspace mutations. Each returns a new workspace or throws an
 * OpError with a plain-language message. Nothing here is saved until the
 * caller persists the returned workspace.
 */
import { allocatedByPayment, sortDealsForCommission } from './calc';
import { formatDateShort, isValidDate, yearOf } from './dates';
import { D, MAX_INPUT_CENTS, formatCents, sumCents } from './money';
import { newId, type Allocation, type Cents, type Deal, type Payment, type Plan, type Workspace } from './types';
import { hasVisibleText, isValidRate } from './validate';

export class OpError extends Error {}

function fail(message: string): never {
  throw new OpError(message);
}

function assertPositiveCents(v: Cents, label: string) {
  if (!/^\d+$/.test(v) || new D(v).lte(0)) fail(`${label} must be greater than $0.`);
  if (new D(v).gt(MAX_INPUT_CENTS)) fail(`${label} can be at most $999,999,999.99.`);
}

export interface PlanInput {
  id?: string;
  year: number;
  annualQuotaCents: Cents;
  baseRate: string;
  acceleratorRate: string | null;
  notes: string;
}

export function savePlan(ws: Workspace, input: PlanInput): Workspace {
  if (!Number.isInteger(input.year) || input.year < 1900 || input.year > 2999) fail('Enter a valid calendar year.');
  assertPositiveCents(input.annualQuotaCents, 'Annual quota');
  if (!isValidRate(input.baseRate)) fail('Base rate must be greater than 0% and at most 100%.');
  if (input.acceleratorRate !== null) {
    if (!isValidRate(input.acceleratorRate)) fail('Accelerator rate must be greater than 0% and at most 100%.');
    if (new D(input.acceleratorRate).lt(input.baseRate)) fail('Accelerator rate must be at least the base rate.');
  }
  const clash = ws.plans.find((p) => p.year === input.year && p.id !== input.id);
  if (clash) fail(`There is already a plan for ${input.year}.`);

  if (input.id) {
    const existing = ws.plans.find((p) => p.id === input.id) ?? fail('That plan no longer exists.');
    if (existing.year !== input.year && ws.deals.some((d) => d.planId === existing.id)) {
      fail('The year cannot change while this plan has deals, because each deal closes within the plan year.');
    }
    const updated: Plan = { ...existing, ...input, id: existing.id, currency: 'USD' };
    return { ...ws, plans: ws.plans.map((p) => (p.id === existing.id ? updated : p)) };
  }
  const plan: Plan = { ...input, id: newId(), currency: 'USD' };
  return { ...ws, plans: [...ws.plans, plan].sort((a, b) => a.year - b.year) };
}

export function deletePlan(ws: Workspace, planId: string): Workspace {
  if (ws.deals.some((d) => d.planId === planId)) fail('Delete or move this plan’s deals before deleting the plan.');
  return { ...ws, plans: ws.plans.filter((p) => p.id !== planId) };
}

export interface DealInput {
  id?: string;
  planId: string;
  account: string;
  reference: string;
  creditedRevenueCents: Cents;
  closeDate: string;
  expectedPaymentDate: string;
  notes: string;
}

function nextSameDayOrder(deals: readonly Deal[], planId: string, closeDate: string, excludeId?: string): number {
  const sameDay = deals.filter((d) => d.planId === planId && d.closeDate === closeDate && d.id !== excludeId);
  return sameDay.length ? Math.max(...sameDay.map((d) => d.sameDayOrder)) + 1 : 0;
}

export function validateDealFields(ws: Workspace, input: DealInput): void {
  const plan = ws.plans.find((p) => p.id === input.planId) ?? fail('Choose a plan year for this deal.');
  if (!hasVisibleText(input.account)) fail('Account name is required.');
  assertPositiveCents(input.creditedRevenueCents, 'Credited revenue');
  if (!isValidDate(input.closeDate)) fail('Enter a valid close date.');
  if (yearOf(input.closeDate) !== plan.year) fail(`Close date must be in ${plan.year} to count toward this plan.`);
  if (!isValidDate(input.expectedPaymentDate)) fail('Enter a valid expected payment date.');
  if (input.expectedPaymentDate < input.closeDate) fail('Expected payment date must be on or after the close date.');
}

export function saveDeal(ws: Workspace, input: DealInput): { workspace: Workspace; dealId: string } {
  validateDealFields(ws, input);
  const account = input.account.trim();
  if (input.id) {
    const existing = ws.deals.find((d) => d.id === input.id) ?? fail('That deal no longer exists.');
    const moved = existing.closeDate !== input.closeDate || existing.planId !== input.planId;
    if (existing.closeDate !== input.closeDate) {
      const paymentsById = new Map(ws.payments.map((p) => [p.id, p]));
      const early = ws.allocations
        .filter((a) => a.dealId === existing.id)
        .map((a) => paymentsById.get(a.paymentId)!)
        .filter((p) => p.paymentDate < input.closeDate);
      if (early.length) {
        fail(
          `A payment dated ${formatDateShort(early[0].paymentDate)} is allocated to this deal. ` +
            'Remove that allocation before moving the close date after the payment date.',
        );
      }
    }
    const updated: Deal = {
      ...existing,
      ...input,
      id: existing.id,
      account,
      sameDayOrder: moved ? nextSameDayOrder(ws.deals, input.planId, input.closeDate, existing.id) : existing.sameDayOrder,
    };
    return { workspace: { ...ws, deals: ws.deals.map((d) => (d.id === existing.id ? updated : d)) }, dealId: existing.id };
  }
  const deal: Deal = {
    ...input,
    id: newId(),
    account,
    sameDayOrder: nextSameDayOrder(ws.deals, input.planId, input.closeDate),
  };
  return { workspace: { ...ws, deals: [...ws.deals, deal] }, dealId: deal.id };
}

/** Move a deal earlier (-1) or later (+1) among deals closing the same day. */
export function moveDealSameDay(ws: Workspace, dealId: string, direction: -1 | 1): Workspace {
  const deal = ws.deals.find((d) => d.id === dealId) ?? fail('That deal no longer exists.');
  const group = sortDealsForCommission(ws.deals.filter((d) => d.planId === deal.planId && d.closeDate === deal.closeDate));
  const idx = group.findIndex((d) => d.id === dealId);
  const target = idx + direction;
  if (target < 0 || target >= group.length) return ws;
  const reordered = [...group];
  [reordered[idx], reordered[target]] = [reordered[target], reordered[idx]];
  const newOrder = new Map(reordered.map((d, i) => [d.id, i]));
  return { ...ws, deals: ws.deals.map((d) => (newOrder.has(d.id) ? { ...d, sameDayOrder: newOrder.get(d.id)! } : d)) };
}

/**
 * Delete a deal and its allocations. The allocated money returns to the
 * source payments' unallocated balances; payments are never deleted here.
 */
export function deleteDeal(ws: Workspace, dealId: string): Workspace {
  if (!ws.deals.some((d) => d.id === dealId)) fail('That deal no longer exists.');
  return {
    ...ws,
    deals: ws.deals.filter((d) => d.id !== dealId),
    allocations: ws.allocations.filter((a) => a.dealId !== dealId),
  };
}

export interface PaymentInput {
  id?: string;
  paymentDate: string;
  amountCents: Cents;
  reference: string;
  notes: string;
}

export function savePayment(ws: Workspace, input: PaymentInput): { workspace: Workspace; paymentId: string } {
  if (!isValidDate(input.paymentDate)) fail('Enter a valid payment date.');
  assertPositiveCents(input.amountCents, 'Gross commission amount');
  if (input.id) {
    const existing = ws.payments.find((p) => p.id === input.id) ?? fail('That payment no longer exists.');
    const allocated = allocatedByPayment(ws).get(existing.id) ?? new D(0);
    if (new D(input.amountCents).lt(allocated)) {
      fail(
        `This payment has ${formatCents(allocated)} allocated to deals. ` +
          'Reduce those allocations before lowering the amount below that.',
      );
    }
    const dealsById = new Map(ws.deals.map((d) => [d.id, d]));
    const conflict = ws.allocations
      .filter((a) => a.paymentId === existing.id)
      .map((a) => dealsById.get(a.dealId)!)
      .find((d) => d.closeDate > input.paymentDate);
    if (conflict) {
      fail(
        `This payment is allocated to ${conflict.account}, which closes ${formatDateShort(conflict.closeDate)}. ` +
          'A payment cannot be dated before a deal it settles closes.',
      );
    }
    const updated: Payment = { ...existing, ...input, id: existing.id };
    return { workspace: { ...ws, payments: ws.payments.map((p) => (p.id === existing.id ? updated : p)) }, paymentId: existing.id };
  }
  const payment: Payment = { ...input, id: newId() };
  return { workspace: { ...ws, payments: [...ws.payments, payment] }, paymentId: payment.id };
}

export function deletePayment(ws: Workspace, paymentId: string): Workspace {
  if (!ws.payments.some((p) => p.id === paymentId)) fail('That payment no longer exists.');
  return {
    ...ws,
    payments: ws.payments.filter((p) => p.id !== paymentId),
    allocations: ws.allocations.filter((a) => a.paymentId !== paymentId),
  };
}

export interface AllocationEntry {
  dealId: string;
  amountCents: Cents;
}

/**
 * Replace all allocations for one payment. Allocations may exceed a deal's
 * expected commission (to surface excess receipts) but never the payment.
 */
export function setPaymentAllocations(ws: Workspace, paymentId: string, entries: AllocationEntry[]): Workspace {
  const payment = ws.payments.find((p) => p.id === paymentId) ?? fail('That payment no longer exists.');
  const dealsById = new Map(ws.deals.map((d) => [d.id, d]));
  const seen = new Set<string>();
  for (const e of entries) {
    const deal = dealsById.get(e.dealId) ?? fail('One of the selected deals no longer exists.');
    if (seen.has(e.dealId)) fail(`${deal.account} is listed more than once.`);
    seen.add(e.dealId);
    assertPositiveCents(e.amountCents, `Amount for ${deal.account}`);
    if (deal.closeDate > payment.paymentDate) {
      fail(`${deal.account} closes ${formatDateShort(deal.closeDate)}, after this payment's date. It cannot receive this payment.`);
    }
  }
  const total = sumCents(entries.map((e) => e.amountCents));
  if (total.gt(payment.amountCents)) {
    fail(`Allocations total ${formatCents(total)}, which is more than this payment's ${formatCents(payment.amountCents)}.`);
  }
  const existingByDeal = new Map(ws.allocations.filter((a) => a.paymentId === paymentId).map((a) => [a.dealId, a]));
  const replacements: Allocation[] = entries.map((e) => ({
    id: existingByDeal.get(e.dealId)?.id ?? newId(),
    paymentId,
    dealId: e.dealId,
    amountCents: e.amountCents,
  }));
  return { ...ws, allocations: [...ws.allocations.filter((a) => a.paymentId !== paymentId), ...replacements] };
}

export function appendDeals(ws: Workspace, deals: Deal[]): Workspace {
  return { ...ws, deals: [...ws.deals, ...deals] };
}

export function appendPayments(ws: Workspace, payments: Payment[]): Workspace {
  return { ...ws, payments: [...ws.payments, ...payments] };
}
