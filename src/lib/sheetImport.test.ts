import { describe, expect, it } from 'vitest';
import { parseCsv } from './csv';
import { cellToText } from './readSpreadsheet';
import {
  buildDeals, buildPayments, buildSheet, DEFAULT_OPTIONS, detectDateOrder, guessMapping, headerSignature, parseFlexibleDate,
  parseFlexibleMoney, type Sheet,
} from './sheetImport';
import { plan, ws } from './testHelpers';

function sheetFrom(csv: string): Sheet {
  const s = buildSheet(parseCsv(csv));
  if ('error' in s) throw new Error(s.error);
  return s;
}

describe('buildSheet', () => {
  it('skips title rows and blank lines above the header and keeps original row numbers', () => {
    const s = sheetFrom('Commission statement Q1,,\n,,\nAccount,Amount,Close Date\n\nAcme,100,2026-01-10\n');
    expect(s.headers).toEqual(['Account', 'Amount', 'Close Date']);
    expect(s.headerRowNumber).toBe(3);
    expect(s.rows).toEqual([['Acme', '100', '2026-01-10']]);
    expect(s.rowNumbers).toEqual([5]);
  });

  it('names blank and duplicate headers', () => {
    const s = sheetFrom('Amount,,Amount\n1,2,3\n');
    expect(s.headers).toEqual(['Amount', 'Column B', 'Amount (2)']);
  });

  it('reports files with no header or no data', () => {
    expect('error' in buildSheet(parseCsv('1,2\n3,4\n'))).toBe(true);
    expect('error' in buildSheet(parseCsv('Account,Amount\n'))).toBe(true);
  });
});

describe('guessMapping', () => {
  it('maps a typical Salesforce opportunity export', () => {
    const headers = ['Opportunity Owner', 'Account Name', 'Opportunity Name', 'Stage', 'Amount', 'Close Date', 'Opportunity ID'];
    const m = guessMapping('deals', headers);
    expect(headers[m.account!]).toBe('Account Name');
    expect(headers[m.revenue!]).toBe('Amount');
    expect(headers[m.closeDate!]).toBe('Close Date');
    expect(headers[m.reference!]).toBe('Opportunity ID');
    expect(m.expectedPaymentDate).toBeNull();
  });

  it('prefers credited or ACV columns over generic amount and never maps a commission column to revenue', () => {
    const headers = ['Customer', 'Commission ($)', 'Amount', 'ACV (USD)', 'Closed Won Date'];
    const m = guessMapping('deals', headers);
    expect(headers[m.revenue!]).toBe('ACV (USD)');
    expect(headers[m.account!]).toBe('Customer');
    expect(headers[m.closeDate!]).toBe('Closed Won Date');
  });

  it('maps our own export format', () => {
    const headers = ['deal_id', 'plan_year', 'account', 'reference', 'credited_revenue_usd', 'close_date', 'expected_payment_date', 'same_day_order', 'notes'];
    const m = guessMapping('deals', headers);
    expect(headers[m.revenue!]).toBe('credited_revenue_usd');
    expect(headers[m.expectedPaymentDate!]).toBe('expected_payment_date');
    expect(headers[m.account!]).toBe('account');
  });

  it('maps a payroll statement', () => {
    const headers = ['Pay Date', 'Earnings Type', 'Gross Commission', 'Net Pay', 'Statement'];
    const m = guessMapping('payments', headers);
    expect(headers[m.paymentDate!]).toBe('Pay Date');
    expect(headers[m.amount!]).toBe('Gross Commission');
    expect(headers[m.reference!]).toBe('Statement');
  });

  it('builds a stable signature for remembering mappings', () => {
    expect(headerSignature('deals', ['Account Name', 'Amount ($)'])).toBe(headerSignature('deals', ['account name', 'AMOUNT']));
  });
});

describe('parseFlexibleDate', () => {
  it('reads common spellings', () => {
    const cases: Array<[string, string]> = [
      ['2026-01-10', '2026-01-10'],
      ['2026-01-10T00:00:00Z', '2026-01-10'],
      ['2026/1/10', '2026-01-10'],
      ['1/30/2026', '2026-01-30'],
      ['30/1/2026', '2026-01-30'],
      ['1/30/26', '2026-01-30'],
      ['Jan 10, 2026', '2026-01-10'],
      ['January 10 2026', '2026-01-10'],
      ['Sept. 3, 2026', '2026-09-03'],
      ['10 Jan 2026', '2026-01-10'],
      ['10-Jan-26', '2026-01-10'],
      ['5/5/2026', '2026-05-05'],
    ];
    for (const [raw, expected] of cases) {
      const r = parseFlexibleDate(raw, null);
      expect(r, raw).toEqual({ ok: true, value: expected });
    }
  });

  it('flags ambiguous numeric dates instead of guessing, and uses the chosen order', () => {
    const r = parseFlexibleDate('01/02/2026', null);
    expect(r.ok).toBe(false);
    expect(r.ambiguous).toBe(true);
    expect(parseFlexibleDate('01/02/2026', 'MDY')).toEqual({ ok: true, value: '2026-01-02' });
    expect(parseFlexibleDate('01/02/2026', 'DMY')).toEqual({ ok: true, value: '2026-02-01' });
  });

  it('rejects impossible or unrecognized dates', () => {
    expect(parseFlexibleDate('2/30/2026', 'MDY').ok).toBe(false);
    expect(parseFlexibleDate('Q1 2026', null).ok).toBe(false);
    expect(parseFlexibleDate('', null).ok).toBe(false);
  });

  it('detects day/month order from the data', () => {
    expect(detectDateOrder(['1/30/2026', '2/3/2026'])).toEqual({ order: 'MDY', needsChoice: false });
    expect(detectDateOrder(['30/1/2026', '2/3/2026'])).toEqual({ order: 'DMY', needsChoice: false });
    expect(detectDateOrder(['1/2/2026', '3/4/2026'])).toEqual({ order: null, needsChoice: true });
    expect(detectDateOrder(['2026-01-02', 'Jan 3, 2026', '5/5/2026'])).toEqual({ order: null, needsChoice: false });
    expect(detectDateOrder(['30/1/2026', '1/30/2026'])).toEqual({ order: null, needsChoice: true });
  });
});

describe('parseFlexibleMoney', () => {
  it('reads export-style money exactly', () => {
    expect(parseFlexibleMoney('$60,000.00', 'Amount')).toEqual({ ok: true, value: '6000000' });
    expect(parseFlexibleMoney('USD 1,250.5', 'Amount')).toEqual({ ok: true, value: '125050' });
    expect(parseFlexibleMoney('1234.5600000000001', 'Amount')).toEqual({ ok: true, value: '123456' });
    expect(parseFlexibleMoney('1.5e3', 'Amount')).toEqual({ ok: true, value: '150000' });
  });

  it('rejects negatives, real extra precision, text, and zero', () => {
    expect(parseFlexibleMoney('(500.00)', 'Amount').ok).toBe(false);
    expect(parseFlexibleMoney('-500', 'Amount').ok).toBe(false);
    expect(parseFlexibleMoney('$-500', 'Amount').ok).toBe(false);
    expect(parseFlexibleMoney('10.125', 'Amount').ok).toBe(false);
    expect(parseFlexibleMoney('TBD', 'Amount').ok).toBe(false);
    expect(parseFlexibleMoney('0', 'Amount').ok).toBe(false);
  });
});

describe('buildDeals', () => {
  const p26 = plan({ year: 2026 });
  const base = ws({ plans: [p26] });
  const crm = [
    'Account Name,Amount,Close Date,Opportunity ID',
    'Acme,"$60,000.00",1/10/2026,OPP-1',
    'Beacon,50000,Feb 10 2026,OPP-2',
    'Total,"$110,000.00",,',
  ].join('\n');
  const us = { ...DEFAULT_OPTIONS, dateOrder: 'MDY' as const };

  it('imports a CRM export, fills expected payment dates, and skips totals rows', () => {
    const sheet = sheetFrom(crm);
    const r = buildDeals(sheet, guessMapping('deals', sheet.headers), us, base);
    expect(r.errors).toEqual([]);
    expect(r.items.map((d) => [d.account, d.creditedRevenueCents, d.closeDate, d.expectedPaymentDate, d.reference])).toEqual([
      ['Acme', '6000000', '2026-01-10', '2026-02-09', 'OPP-1'],
      ['Beacon', '5000000', '2026-02-10', '2026-03-12', 'OPP-2'],
    ]);
    expect(r.skipped).toEqual([{ row: 4, reason: 'Looks like a totals row' }]);
    expect(r.items.every((d) => d.planId === p26.id)).toBe(true);
  });

  it('skips deals already imported by reference so a monthly re-export is safe', () => {
    const sheet = sheetFrom(crm);
    const first = buildDeals(sheet, guessMapping('deals', sheet.headers), us, base);
    const after = { ...base, deals: first.items.slice(0, 1) };
    const again = buildDeals(sheet, guessMapping('deals', sheet.headers), us, after);
    expect(again.items.map((d) => d.account)).toEqual(['Beacon']);
    expect(again.skipped.map((s) => s.row)).toEqual([2, 4]);
    // Turning the option off imports it again.
    const all = buildDeals(sheet, guessMapping('deals', sheet.headers), { ...us, skipExisting: false }, after);
    expect(all.items).toHaveLength(2);
  });

  it('reports row-level problems with spreadsheet row numbers and requires required columns', () => {
    const sheet = sheetFrom('Account,Amount,Close Date\nAcme,abc,2026-01-10\n,100,2026-13-01\nOld,100,2025-06-01\n');
    const r = buildDeals(sheet, guessMapping('deals', sheet.headers), DEFAULT_OPTIONS, base);
    expect(r.items).toEqual([]);
    expect(r.errors.find((e) => e.row === 2)?.message).toMatch(/isn’t a number/);
    expect(r.errors.filter((e) => e.row === 3).map((e) => e.message).join(' ')).toMatch(/Account name is blank.*Close date/);
    expect(r.errors.find((e) => e.row === 4)?.message).toMatch(/no 2025 plan/);
    const skipYears = buildDeals(sheet, guessMapping('deals', sheet.headers), { ...DEFAULT_OPTIONS, skipOtherYears: true }, base);
    expect(skipYears.skipped.map((s) => s.row)).toEqual([4]);

    const noRevenue = buildDeals(sheet, { account: 0, revenue: null, closeDate: 2 }, DEFAULT_OPTIONS, base);
    expect(noRevenue.missingFields).toEqual(['Credited revenue']);
  });

  it('needs a day/month choice for ambiguous dates and uses it once given', () => {
    const sheet = sheetFrom('Account,Amount,Close Date\nAcme,100,01/02/2026\nBeacon,100,03/04/2026\n');
    const map = guessMapping('deals', sheet.headers);
    expect(buildDeals(sheet, map, DEFAULT_OPTIONS, base).errors).toHaveLength(2);
    const dmy = buildDeals(sheet, map, { ...DEFAULT_OPTIONS, dateOrder: 'DMY' }, base);
    expect(dmy.items.map((d) => d.closeDate)).toEqual(['2026-02-01', '2026-04-03']);
  });

  it('keeps expected payment dates from the file and checks them', () => {
    const sheet = sheetFrom('Account,Amount,Close Date,Payout Date\nA,100,2026-01-10,2026-02-15\nB,100,2026-03-10,2026-03-01\nC,100,2026-03-10,\n');
    const r = buildDeals(sheet, guessMapping('deals', sheet.headers), { ...DEFAULT_OPTIONS, expectedPaymentDays: 45 }, base);
    expect(r.errors).toEqual([{ row: 3, message: 'Expected payment date is before the close date' }]);
    const ok = buildDeals(sheetFrom('Account,Amount,Close Date,Payout Date\nA,100,2026-01-10,2026-02-15\nC,100,2026-03-10,\n'), guessMapping('deals', ['Account', 'Amount', 'Close Date', 'Payout Date']), { ...DEFAULT_OPTIONS, expectedPaymentDays: 45 }, base);
    expect(ok.items.map((d) => d.expectedPaymentDate)).toEqual(['2026-02-15', '2026-04-24']);
  });

  it('gives same-day deals sequential order after existing ones', () => {
    const existing = { ...base, deals: [{ id: crypto.randomUUID(), planId: p26.id, account: 'X', reference: '', creditedRevenueCents: '100', closeDate: '2026-01-10', expectedPaymentDate: '2026-02-10', sameDayOrder: 4, notes: '' }] };
    const sheet = sheetFrom('Account,Amount,Close Date\nA,1,2026-01-10\nB,1,2026-01-10\n');
    const r = buildDeals(sheet, guessMapping('deals', sheet.headers), DEFAULT_OPTIONS, existing);
    expect(r.items.map((d) => d.sameDayOrder)).toEqual([5, 6]);
  });
});

describe('buildPayments', () => {
  const base = ws({ plans: [plan()] });
  it('imports a statement and skips exact repeats of existing payments', () => {
    const sheet = sheetFrom('Pay Date,Gross Commission,Net Pay,Statement\n2026-02-15,"$6,000.00","$4,100.00",Feb\n03/15/2026,7950,5400,Mar\n');
    const map = guessMapping('payments', sheet.headers);
    const r = buildPayments(sheet, map, DEFAULT_OPTIONS, base);
    expect(r.errors).toEqual([]);
    expect(r.items.map((p) => [p.paymentDate, p.amountCents, p.reference])).toEqual([
      ['2026-02-15', '600000', 'Feb'],
      ['2026-03-15', '795000', 'Mar'],
    ]);
    const again = buildPayments(sheet, map, DEFAULT_OPTIONS, { ...base, payments: r.items.slice(0, 1) });
    expect(again.items).toHaveLength(1);
    expect(again.skipped).toHaveLength(1);
  });
});

describe('cellToText', () => {
  it('turns Excel date cells into calendar dates without shifting the day', () => {
    expect(cellToText(new Date(Date.UTC(2026, 0, 10)))).toBe('2026-01-10');
    expect(cellToText(new Date(Date.UTC(2026, 11, 31, 23, 59)))).toBe('2026-12-31');
    expect(cellToText('60000.1')).toBe('60000.1');
    expect(cellToText(null)).toBe('');
  });
});
