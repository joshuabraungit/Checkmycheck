import { describe, expect, it } from 'vitest';
import { reconcile } from './calc';
import { parseCsv } from './csv';
import { analyzeDrop, applyDrop, type DroppedFile } from './dropImport';
import { classifyTab } from './sheetImport';
import { plan, ws } from './testHelpers';

const tracker: DroppedFile = {
  fileName: 'tracker.xlsx',
  tabs: [
    {
      name: 'Deals',
      rows: parseCsv(
        [
          '2026 Commission Tracker,,,,,',
          ',,,,,',
          'Opportunity ID,Account Name,Close Date,ARR,Est. Commission,Expected Payout Date',
          'OPP-1,Acme,2026-01-20,60000,6000,2026-02-15',
          'OPP-2,Beacon,2026-02-03,30000,3000,2026-03-15',
          'OPP-3,Cedar,2026-02-25,20000,2000,2026-03-15',
          'Total,,,110000,11000,',
        ].join('\n'),
      ),
    },
    { name: 'Paystub Log', rows: parseCsv('Pay Date,Pay Period,Gross Commission,Net Pay (after tax)\n2026-02-13,Jan,6000,4100\n') },
    { name: 'Monthly Totals', rows: parseCsv('Month,Closed ARR,Attainment\nJan 2026,60000,60%\n') },
    { name: 'Read Me', rows: parseCsv('How to use this tracker\n') },
  ],
};

const marchStub: DroppedFile = {
  fileName: 'paystub-2026-03-13.pdf',
  paystub: { payDateRaw: '03/13/2026', commissionLines: [{ label: 'Commission', amountCents: '550000' }], negativeLabels: [] },
};

describe('classifyTab', () => {
  it('tells deals tabs from payment tabs and ignores the rest', () => {
    const [deals, pays, totals, readme] = (tracker as { tabs: Parameters<typeof classifyTab>[0][] }).tabs.map(classifyTab);
    expect(deals?.kind).toBe('deals');
    expect(pays?.kind).toBe('payments');
    expect(totals).toBeNull();
    expect(readme).toBeNull();
  });
});

describe('analyzeDrop and applyDrop', () => {
  const base = ws({ plans: [plan()] });

  it('reads a whole tracker plus a paystub in one go and matches what adds up', () => {
    const a = analyzeDrop([tracker, marchStub], base, { dateOrder: null, expectedPaymentDays: 30 });
    expect(a.needsDateOrder).toBe(false);
    expect(a.sources.map((s) => [s.kind, s.label])).toEqual([
      ['deals', 'tracker.xlsx › Deals'],
      ['payments', 'tracker.xlsx › Paystub Log'],
      ['paystub', 'paystub-2026-03-13.pdf'],
    ]);
    const applied = applyDrop(base, a.sources);
    expect(applied).toMatchObject({ deals: 3, payments: 2, matched: 2, guessed: [], unmatched: 0 });
    const r = reconcile(applied.workspace, 2026, '2026-03-31');
    // Cedar crosses the $100k quota: $10k x 10% + $10k x 15% = $2,500. Feb paid Acme, March paid Beacon + Cedar.
    expect(r.summary.differenceCents.toFixed(0)).toBe('0');
    expect(r.summary.provisional).toBe(false);
  });

  it('skips what is already there when the same files are dropped again', () => {
    const first = applyDrop(base, analyzeDrop([tracker, marchStub], base, { dateOrder: null, expectedPaymentDays: 30 }).sources).workspace;
    const again = analyzeDrop([tracker, marchStub], first, { dateOrder: null, expectedPaymentDays: 30 });
    const applied = applyDrop(first, again.sources);
    expect(applied.deals).toBe(0);
    expect(applied.payments).toBe(0);
    const stub = again.sources.find((s) => s.kind === 'paystub');
    expect(stub && stub.kind === 'paystub' && stub.problem).toBe('Already added.');
  });

  it('asks about day/month order once for all files, and reports files it can’t use', () => {
    const ambiguous: DroppedFile = { fileName: 'deals.csv', tabs: [{ name: 'deals.csv', rows: parseCsv('Account,Amount,Close Date\nA,100,01/02/2026\n') }] };
    const junk: DroppedFile = { fileName: 'notes.csv', tabs: [{ name: 'notes.csv', rows: parseCsv('Thing,Other\nx,y\n') }] };
    const scanned: DroppedFile = { fileName: 'scan.pdf', error: 'No text to read.' };
    const a = analyzeDrop([ambiguous, junk, scanned], base, { dateOrder: null, expectedPaymentDays: 30 });
    expect(a.needsDateOrder).toBe(true);
    expect(a.sources.map((s) => s.kind)).toEqual(['deals', 'ignored', 'ignored']);
    const b = analyzeDrop([ambiguous], base, { dateOrder: 'DMY', expectedPaymentDays: 30 });
    const deals = b.sources[0];
    expect(deals.kind === 'deals' && deals.result.items[0].closeDate).toBe('2026-02-01');
  });

  it('leaves out a source with row problems but keeps the others', () => {
    const bad: DroppedFile = { fileName: 'bad.csv', tabs: [{ name: 'bad.csv', rows: parseCsv('Account,Amount,Close Date\nA,TBD,2026-01-10\n') }] };
    const a = analyzeDrop([bad, marchStub], base, { dateOrder: null, expectedPaymentDays: 30 });
    const applied = applyDrop(base, a.sources);
    expect(applied.deals).toBe(0);
    expect(applied.payments).toBe(1);
  });
});

describe('duplicate paychecks across files', () => {
  it('keeps one copy when a tracker’s paystub log and a paystub PDF describe the same paycheck', () => {
    const base = ws({ plans: [plan()] });
    const febStub: DroppedFile = {
      fileName: 'feb.pdf',
      paystub: { payDateRaw: '02/13/2026', commissionLines: [{ label: 'Commission', amountCents: '600000' }], negativeLabels: [] },
    };
    const a = analyzeDrop([tracker, febStub, marchStub], base, { dateOrder: null, expectedPaymentDays: 30 });
    const applied = applyDrop(base, a.sources);
    expect(applied.payments).toBe(2);
    const stub = a.sources.find((s) => s.label === 'feb.pdf');
    expect(stub?.kind === 'paystub' && stub.problem).toBe('Already added.');
  });
});

describe('best guesses on drop', () => {
  it('applies best guesses by default and lists them, or leaves them unmatched when turned off', () => {
    const base = ws({ plans: [plan()] });
    const short: DroppedFile = {
      fileName: 'mar.pdf',
      paystub: { payDateRaw: '03/13/2026', commissionLines: [{ label: 'Commission', amountCents: '500000' }], negativeLabels: [] },
    };
    const a = analyzeDrop([tracker, short], base, { dateOrder: null, expectedPaymentDays: 30 });
    const on = applyDrop(base, a.sources);
    expect(on.matched).toBe(2);
    expect(on.guessed.map((p) => p.paymentDate)).toEqual(['2026-03-13']);
    const off = applyDrop(base, a.sources, { includeBestGuesses: false });
    expect(off.matched).toBe(1);
    expect(off.unmatched).toBe(1);
  });
});
