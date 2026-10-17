import { SCHEMA_VERSION, type Workspace } from './types';

export const DEMO_AS_OF = '2026-03-31';

// Fixed IDs keep the example deterministic across visits and in tests.
const PLAN = '00000000-0000-4000-8000-000000002026';
const ACME = '00000000-0000-4000-8000-00000000a001';
const BEACON = '00000000-0000-4000-8000-00000000a002';
const CEDAR = '00000000-0000-4000-8000-00000000a003';
const DELTA = '00000000-0000-4000-8000-00000000a004';
const PAY_FEB = '00000000-0000-4000-8000-00000000b001';
const PAY_MAR = '00000000-0000-4000-8000-00000000b002';

export function demoWorkspace(): Workspace {
  return {
    schemaVersion: SCHEMA_VERSION,
    plans: [
      {
        id: PLAN,
        year: 2026,
        currency: 'USD',
        period: 'annual',
        quotasCents: ['10000000'],
        tiers: [
          { fromAttainment: '0.0', rate: '0.10' },
          { fromAttainment: '1.0', rate: '0.15' },
        ],
        tierMode: 'marginal',
        notes: 'Example plan: 10% base, 15% on credited revenue above a $100,000 annual quota.',
      },
    ],
    deals: [
      { id: ACME, planId: PLAN, account: 'Acme', reference: 'EX-101', creditedRevenueCents: '6000000', closeDate: '2026-01-10', expectedPaymentDate: '2026-02-15', sameDayOrder: 0, notes: '' },
      { id: BEACON, planId: PLAN, account: 'Beacon', reference: 'EX-102', creditedRevenueCents: '5000000', closeDate: '2026-02-10', expectedPaymentDate: '2026-03-15', sameDayOrder: 0, notes: 'Crosses quota: $40,000 at 10% and $10,000 at 15%.' },
      { id: CEDAR, planId: PLAN, account: 'Cedar', reference: 'EX-103', creditedRevenueCents: '2000000', closeDate: '2026-02-20', expectedPaymentDate: '2026-03-15', sameDayOrder: 0, notes: '' },
      { id: DELTA, planId: PLAN, account: 'Delta', reference: 'EX-104', creditedRevenueCents: '1000000', closeDate: '2026-03-20', expectedPaymentDate: '2026-04-15', sameDayOrder: 0, notes: '' },
    ],
    payments: [
      { id: PAY_FEB, paymentDate: '2026-02-15', amountCents: '600000', reference: 'February statement', notes: '' },
      { id: PAY_MAR, paymentDate: '2026-03-15', amountCents: '795000', reference: 'March statement', notes: '' },
    ],
    allocations: [
      { id: '00000000-0000-4000-8000-00000000c001', paymentId: PAY_FEB, dealId: ACME, amountCents: '600000' },
      { id: '00000000-0000-4000-8000-00000000c002', paymentId: PAY_MAR, dealId: BEACON, amountCents: '500000' },
      { id: '00000000-0000-4000-8000-00000000c003', paymentId: PAY_MAR, dealId: CEDAR, amountCents: '295000' },
    ],
  };
}
