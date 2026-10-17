/** Integer cents stored as a decimal string, e.g. "600000" for $6,000.00. */
export type Cents = string;
/** Rate stored as a decimal fraction string, e.g. "0.10" for 10%. */
export type Rate = string;
/** Calendar date as YYYY-MM-DD with no time zone attached. */
export type DateOnly = string;

/**
 * One rate band. `fromAttainment` is where the band starts, as a fraction of
 * the period's quota ("0" for the first tier, "1" for 100%, "1.5" for 150%).
 */
export interface Tier {
  fromAttainment: Rate;
  rate: Rate;
}

/** Whether attainment is measured over the whole year or resets each quarter. */
export type QuotaPeriod = 'annual' | 'quarterly';

/**
 * How a higher tier pays. Marginal: only revenue inside the band earns its
 * rate. Retroactive: crossing into a band pays its rate on all revenue so far
 * in the period, with the catch-up carried by the crossing deal.
 */
export type TierMode = 'marginal' | 'retroactive';

export interface Plan {
  id: string;
  year: number;
  currency: 'USD';
  period: QuotaPeriod;
  /** One quota for an annual plan, four (Q1 to Q4) for a quarterly plan. */
  quotasCents: Cents[];
  /** Sorted by fromAttainment; the first tier starts at "0". */
  tiers: Tier[];
  tierMode: TierMode;
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

export const SCHEMA_VERSION = 2;

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
