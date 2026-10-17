/** Integer cents stored as a decimal string, e.g. "600000" for $6,000.00. */
export type Cents = string;
/** Rate stored as a decimal fraction string, e.g. "0.10" for 10%. */
export type Rate = string;
/** Calendar date as YYYY-MM-DD with no time zone attached. */
export type DateOnly = string;

export interface Plan {
  id: string;
  year: number;
  currency: 'USD';
  annualQuotaCents: Cents;
  baseRate: Rate;
  acceleratorRate: Rate | null;
  notes: string;
}

export interface Deal {
  id: string;
  planId: string;
  account: string;
  reference: string;
  creditedRevenueCents: Cents;
  closeDate: DateOnly;
  expectedPaymentDate: DateOnly;
  sameDayOrder: number;
  notes: string;
}

export interface Payment {
  id: string;
  paymentDate: DateOnly;
  amountCents: Cents;
  reference: string;
  notes: string;
}

export interface Allocation {
  id: string;
  paymentId: string;
  dealId: string;
  amountCents: Cents;
}

export const SCHEMA_VERSION = 1;

export interface Workspace {
  schemaVersion: number;
  plans: Plan[];
  deals: Deal[];
  payments: Payment[];
  allocations: Allocation[];
}

export function emptyWorkspace(): Workspace {
  return { schemaVersion: SCHEMA_VERSION, plans: [], deals: [], payments: [], allocations: [] };
}

export function newId(): string {
  return crypto.randomUUID();
}
