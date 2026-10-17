import { newId, SCHEMA_VERSION, type Deal, type Payment, type Plan, type Workspace } from './types';

/** Build a plan with dollar-friendly inputs (test-only helper). */
export function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: newId(),
    year: 2026,
    currency: 'USD',
    period: 'annual',
    quotasCents: ['10000000'], // $100,000
    tiers: [
      { fromAttainment: '0.0', rate: '0.10' },
      { fromAttainment: '1.0', rate: '0.15' },
    ],
    tierMode: 'marginal',
    notes: '',
    ...overrides,
  };
}

let counter = 0;
export function deal(p: Plan, revenueDollars: number | string, closeDate: string, overrides: Partial<Deal> = {}): Deal {
  counter++;
  return {
    id: newId(),
    planId: p.id,
    account: `Deal ${counter}`,
    reference: '',
    creditedRevenueCents: String(BigInt(Math.round(Number(revenueDollars) * 100))),
    closeDate,
    expectedPaymentDate: closeDate,
    sameDayOrder: 0,
    notes: '',
    ...overrides,
  };
}

export function payment(date: string, cents: string, overrides: Partial<Payment> = {}): Payment {
  return { id: newId(), paymentDate: date, amountCents: cents, reference: '', notes: '', ...overrides };
}

export function ws(parts: Partial<Workspace>): Workspace {
  return { schemaVersion: SCHEMA_VERSION, plans: [], deals: [], payments: [], allocations: [], ...parts };
}

/** Annual marginal plan with a single rate and no accelerator. */
export function flatPlan(rate: string, overrides: Partial<Plan> = {}): Plan {
  return plan({ tiers: [{ fromAttainment: '0.0', rate }], ...overrides });
}
