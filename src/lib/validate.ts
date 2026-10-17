import { isValidDate, yearOf } from './dates';
import { D, MAX_INPUT_CENTS } from './money';
import { SCHEMA_VERSION, type Allocation, type Deal, type Payment, type Plan, type Tier, type Workspace } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CENTS_RE = /^\d+$/;
const RATE_RE = /^\d+(\.\d+)?$/;

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

/** Account names must contain visible text, not just whitespace or invisible characters. */
export function hasVisibleText(v: string): boolean {
  return /[^\s​-‍⁠﻿]/u.test(v);
}

function isPositiveCents(v: unknown, max = MAX_INPUT_CENTS): v is string {
  return typeof v === 'string' && CENTS_RE.test(v) && new D(v).gt(0) && new D(v).lte(max);
}

/** Rate fraction in (0, 1] with at most 6 decimal places (4 decimal places as a percentage). */
export function isValidRate(v: unknown): v is string {
  if (typeof v !== 'string' || !RATE_RE.test(v)) return false;
  const d = new D(v);
  return d.gt(0) && d.lte(1) && d.decimalPlaces() <= 6;
}

/** Tier threshold as a fraction of quota: 0 up to 100 (10,000%), at most 6 decimal places. */
function isValidThreshold(v: unknown): v is string {
  if (typeof v !== 'string' || !RATE_RE.test(v)) return false;
  const d = new D(v);
  return d.gte(0) && d.lte(100) && d.decimalPlaces() <= 6;
}

export const MAX_TIERS = 10;

/**
 * Plain-language problems with a plan's quota and tier settings, or an empty
 * list. Shared by the editor and by workspace validation so they can't drift.
 */
export function planShapeProblems(p: { period: unknown; quotasCents: unknown; tiers: unknown; tierMode: unknown }): string[] {
  const problems: string[] = [];
  if (p.period !== 'annual' && p.period !== 'quarterly') problems.push('Quota period must be annual or quarterly.');
  const expectedQuotas = p.period === 'quarterly' ? 4 : 1;
  if (!Array.isArray(p.quotasCents) || p.quotasCents.length !== expectedQuotas) {
    problems.push(p.period === 'quarterly' ? 'A quarterly plan needs a quota for each of the four quarters.' : 'An annual plan needs one quota.');
  } else if (!p.quotasCents.every((q) => isPositiveCents(q))) {
    problems.push('Each quota must be greater than $0 and at most $999,999,999.99.');
  }
  if (p.tierMode !== 'marginal' && p.tierMode !== 'retroactive') problems.push('Tier mode must be marginal or retroactive.');
  if (!Array.isArray(p.tiers) || p.tiers.length === 0) {
    problems.push('A plan needs at least one commission rate.');
    return problems;
  }
  if (p.tiers.length > MAX_TIERS) problems.push(`A plan can have at most ${MAX_TIERS} tiers.`);
  const tiers = p.tiers as unknown[];
  if (!tiers.every((t) => isObject(t) && isValidThreshold(t.fromAttainment) && isValidRate(t.rate))) {
    problems.push('Each tier needs a starting point between 0% and 10,000% of quota and a rate greater than 0% and at most 100%.');
    return problems;
  }
  const valid = tiers as Tier[];
  if (!new D(valid[0].fromAttainment).isZero()) problems.push('The first tier must start at 0% of quota.');
  for (let i = 1; i < valid.length; i++) {
    if (new D(valid[i].fromAttainment).lte(valid[i - 1].fromAttainment)) {
      problems.push('Each tier must start at a higher percentage of quota than the one before it.');
      break;
    }
  }
  for (let i = 1; i < valid.length; i++) {
    if (new D(valid[i].rate).lt(valid[i - 1].rate)) {
      problems.push('Each tier’s rate must be at least the rate of the tier before it.');
      break;
    }
  }
  return problems;
}

/**
 * Upgrade older saved data to the current schema. Version 1 plans had one
 * annual quota, a base rate, and an optional marginal accelerator, which map
 * exactly onto an annual, marginal plan with one or two tiers.
 */
export function migrateWorkspace(raw: unknown): unknown {
  if (!isObject(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.plans)) return raw;
  const plans = raw.plans.map((p) => {
    if (!isObject(p)) return p;
    const { annualQuotaCents, baseRate, acceleratorRate, ...rest } = p;
    const tiers: Array<{ fromAttainment: unknown; rate: unknown }> = [{ fromAttainment: '0.0', rate: baseRate }];
    if (acceleratorRate !== null && acceleratorRate !== undefined) tiers.push({ fromAttainment: '1.0', rate: acceleratorRate });
    return { ...rest, period: 'annual', quotasCents: [annualQuotaCents], tiers, tierMode: 'marginal' };
  });
  return { ...raw, schemaVersion: 2, plans };
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export type ValidationResult = { ok: true; workspace: Workspace } | { ok: false; errors: string[] };

/**
 * Validate a full workspace: field types, ranges, uniqueness, and every
 * relationship between plans, deals, payments, and allocations.
 * Returns a cleaned copy containing only known fields.
 */
export function validateWorkspace(input: unknown): ValidationResult {
  const raw = migrateWorkspace(input);
  const errors: string[] = [];
  if (!isObject(raw)) return { ok: false, errors: ['The file does not contain a workspace object.'] };
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    return {
      ok: false,
      errors: [`Unsupported schema version ${JSON.stringify(raw.schemaVersion)}. This app reads version ${SCHEMA_VERSION}.`],
    };
  }
  for (const key of ['plans', 'deals', 'payments', 'allocations'] as const) {
    if (!Array.isArray(raw[key])) errors.push(`"${key}" must be a list.`);
  }
  if (errors.length) return { ok: false, errors };

  const seenIds = new Set<string>();
  const checkId = (id: unknown, where: string): id is string => {
    if (!isUuid(id)) {
      errors.push(`${where}: id must be a UUID.`);
      return false;
    }
    if (seenIds.has(id)) {
      errors.push(`${where}: id ${id} is used more than once.`);
      return false;
    }
    seenIds.add(id);
    return true;
  };

  const plans: Plan[] = [];
  const years = new Set<number>();
  (raw.plans as unknown[]).forEach((p, i) => {
    const where = `Plan ${i + 1}`;
    if (!isObject(p)) return void errors.push(`${where}: not an object.`);
    const before = errors.length;
    checkId(p.id, where);
    if (!Number.isInteger(p.year) || (p.year as number) < 1900 || (p.year as number) > 2999) errors.push(`${where}: year is invalid.`);
    else if (years.has(p.year as number)) errors.push(`${where}: there is already a plan for ${p.year}.`);
    if (p.currency !== 'USD') errors.push(`${where}: currency must be USD.`);
    for (const problem of planShapeProblems(p as Parameters<typeof planShapeProblems>[0])) errors.push(`${where}: ${problem}`);
    if (!isString(p.notes)) errors.push(`${where}: notes must be text.`);
    if (errors.length === before) {
      years.add(p.year as number);
      plans.push({
        id: p.id as string,
        year: p.year as number,
        currency: 'USD',
        period: p.period as Plan['period'],
        quotasCents: [...(p.quotasCents as string[])],
        tiers: (p.tiers as Tier[]).map((t) => ({ fromAttainment: t.fromAttainment, rate: t.rate })),
        tierMode: p.tierMode as Plan['tierMode'],
        notes: p.notes as string,
      });
    }
  });
  const plansById = new Map(plans.map((p) => [p.id, p]));

  const deals: Deal[] = [];
  (raw.deals as unknown[]).forEach((d, i) => {
    const where = `Deal ${i + 1}`;
    if (!isObject(d)) return void errors.push(`${where}: not an object.`);
    const before = errors.length;
    checkId(d.id, where);
    const plan = isString(d.planId) ? plansById.get(d.planId) : undefined;
    if (!plan) errors.push(`${where}: refers to a plan that does not exist.`);
    if (!isString(d.account) || !hasVisibleText(d.account)) errors.push(`${where}: account name is required.`);
    if (!isString(d.reference)) errors.push(`${where}: reference must be text.`);
    if (!isPositiveCents(d.creditedRevenueCents)) errors.push(`${where}: credited revenue must be a positive amount in cents.`);
    if (!isValidDate(d.closeDate)) errors.push(`${where}: close date is invalid.`);
    else if (plan && yearOf(d.closeDate) !== plan.year) errors.push(`${where}: close date must be in ${plan.year}.`);
    if (!isValidDate(d.expectedPaymentDate)) errors.push(`${where}: expected payment date is invalid.`);
    else if (isValidDate(d.closeDate) && d.expectedPaymentDate < d.closeDate) {
      errors.push(`${where}: expected payment date is before the close date.`);
    }
    if (!Number.isSafeInteger(d.sameDayOrder)) errors.push(`${where}: same-day order must be a whole number.`);
    if (!isString(d.notes)) errors.push(`${where}: notes must be text.`);
    if (errors.length === before) {
      deals.push({
        id: d.id as string,
        planId: d.planId as string,
        account: d.account as string,
        reference: d.reference as string,
        creditedRevenueCents: d.creditedRevenueCents as string,
        closeDate: d.closeDate as string,
        expectedPaymentDate: d.expectedPaymentDate as string,
        sameDayOrder: d.sameDayOrder as number,
        notes: d.notes as string,
      });
    }
  });
  const dealsById = new Map(deals.map((d) => [d.id, d]));

  const payments: Payment[] = [];
  (raw.payments as unknown[]).forEach((p, i) => {
    const where = `Payment ${i + 1}`;
    if (!isObject(p)) return void errors.push(`${where}: not an object.`);
    const before = errors.length;
    checkId(p.id, where);
    if (!isValidDate(p.paymentDate)) errors.push(`${where}: payment date is invalid.`);
    if (!isPositiveCents(p.amountCents)) errors.push(`${where}: amount must be a positive amount in cents.`);
    if (!isString(p.reference)) errors.push(`${where}: reference must be text.`);
    if (!isString(p.notes)) errors.push(`${where}: notes must be text.`);
    if (errors.length === before) {
      payments.push({
        id: p.id as string,
        paymentDate: p.paymentDate as string,
        amountCents: p.amountCents as string,
        reference: p.reference as string,
        notes: p.notes as string,
      });
    }
  });
  const paymentsById = new Map(payments.map((p) => [p.id, p]));

  const allocations: Allocation[] = [];
  const allocatedPerPayment = new Map<string, InstanceType<typeof D>>();
  (raw.allocations as unknown[]).forEach((a, i) => {
    const where = `Allocation ${i + 1}`;
    if (!isObject(a)) return void errors.push(`${where}: not an object.`);
    const before = errors.length;
    checkId(a.id, where);
    const payment = isString(a.paymentId) ? paymentsById.get(a.paymentId) : undefined;
    const deal = isString(a.dealId) ? dealsById.get(a.dealId) : undefined;
    if (!payment) errors.push(`${where}: refers to a payment that does not exist.`);
    if (!deal) errors.push(`${where}: refers to a deal that does not exist.`);
    // Allocation totals are bounded by the payment amount, not the single-input limit.
    if (!isPositiveCents(a.amountCents, new D(Infinity))) errors.push(`${where}: amount must be a positive amount in cents.`);
    if (payment && deal && deal.closeDate > payment.paymentDate) {
      errors.push(`${where}: a payment on ${payment.paymentDate} cannot settle a deal that closes on ${deal.closeDate}.`);
    }
    if (errors.length === before && payment) {
      allocatedPerPayment.set(payment.id, (allocatedPerPayment.get(payment.id) ?? new D(0)).plus(a.amountCents as string));
      allocations.push({
        id: a.id as string,
        paymentId: a.paymentId as string,
        dealId: a.dealId as string,
        amountCents: a.amountCents as string,
      });
    }
  });
  for (const [paymentId, total] of allocatedPerPayment) {
    const payment = paymentsById.get(paymentId)!;
    if (total.gt(payment.amountCents)) {
      errors.push(`Payment ${paymentId} has more allocated (${total.toFixed(0)} cents) than its amount (${payment.amountCents} cents).`);
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, workspace: { schemaVersion: SCHEMA_VERSION, plans, deals, payments, allocations } };
}
