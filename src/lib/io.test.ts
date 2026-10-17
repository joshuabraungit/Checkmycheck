import { describe, expect, it } from 'vitest';
import { parseBackupJson, workspaceToBackupJson } from './backup';
import { reconcile } from './calc';
import {
  dealsToCsv, parseCsv, parseDealCsv, parsePaymentCsv, paymentsToCsv, protectCell, reconciliationToCsv, CsvSyntaxError,
  DEAL_COLUMNS,
} from './csv';
import { demoWorkspace, DEMO_AS_OF } from './demo';
import { buildInquiry } from './inquiry';
import { formatCents, parseMoneyInput, parsePercentInput } from './money';
import { plan, ws } from './testHelpers';
import { validateWorkspace } from './validate';

describe('19. CSV parsing and validation', () => {
  it('handles quotes, commas, escaped quotes, line breaks, CRLF, and BOM', () => {
    const text = '﻿a,b,c\r\n"x, y","say ""hi""","line1\nline2"\r\n1,,3';
    expect(parseCsv(text)).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'say "hi"', 'line1\nline2'],
      ['1', '', '3'],
    ]);
  });

  it('rejects malformed quoting', () => {
    expect(() => parseCsv('a\n"unterminated')).toThrow(CsvSyntaxError);
    expect(() => parseCsv('a\n"x"y')).toThrow(CsvSyntaxError);
  });

  const header = DEAL_COLUMNS.join(',');
  const p = plan({ year: 2026 });
  const base = ws({ plans: [p] });

  it('imports valid deals with generated ids and same-day order', () => {
    const csv = `${header}\n,2026,"Acme, Inc.",R1,"60,000.00",2026-01-10,2026-02-15,,"note with\nnewline"\n,2026,Acme,R2,500,2026-01-10,2026-02-15,,\n`;
    const r = parseDealCsv(csv, base);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items).toHaveLength(2);
    expect(r.items[0].account).toBe('Acme, Inc.');
    expect(r.items[0].creditedRevenueCents).toBe('6000000');
    expect(r.items[0].notes).toBe('note with\nnewline');
    expect(r.items.map((d) => d.sameDayOrder)).toEqual([0, 1]);
    // Same account name is not deduplicated.
    expect(r.items[1].account).toBe('Acme');
    expect(r.items[0].id).not.toBe(r.items[1].id);
  });

  it('reports row-specific errors and imports nothing when any row is invalid', () => {
    const csv = [
      header,
      ',2026,Good,,100,2026-01-10,2026-02-15,,',
      ',2025,No plan,,100,2025-01-10,2025-02-15,,',
      ',2026,  ,,100.123,2026-02-30,2026-01-01,x,',
    ].join('\n');
    const r = parseDealCsv(csv, base);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => e.row === 3 && /No plan exists/.test(e.message))).toBe(true);
    const row4 = r.errors.filter((e) => e.row === 4).map((e) => e.message).join(' | ');
    expect(row4).toMatch(/account is required/);
    expect(row4).toMatch(/two decimal places/);
    expect(row4).toMatch(/close_date/);
    expect(row4).toMatch(/same_day_order/);
    expect(r.errors.some((e) => e.row === 2)).toBe(false);
  });

  it('blocks existing ids instead of overwriting', () => {
    const first = parseDealCsv(`${header}\n,2026,A,,100,2026-01-10,2026-02-15,,`, base);
    if (!first.ok) throw new Error('expected ok');
    const withDeal = { ...base, deals: first.items };
    const again = parseDealCsv(dealsToCsv(withDeal), withDeal);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.errors[0].message).toMatch(/already exists/);
  });

  it('rejects missing or unknown columns', () => {
    const r = parseDealCsv('deal_id,account\n,x', base);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].message).toMatch(/Missing column/);
  });

  it('parses payment CSV and blocks bad rows', () => {
    const ok = parsePaymentCsv('payment_id,payment_date,gross_commission_usd,reference,notes\n,2026-02-15,6000,Feb,\n', base);
    expect(ok.ok && ok.items[0].amountCents).toBe('600000');
    const bad = parsePaymentCsv('payment_id,payment_date,gross_commission_usd,reference,notes\n,2026-02-15,0,Feb,\n', base);
    expect(bad.ok).toBe(false);
  });

  it('protects exported text against spreadsheet formulas and round-trips it', () => {
    expect(protectCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(protectCell('+1')).toBe("'+1");
    expect(protectCell('@cmd')).toBe("'@cmd");
    expect(protectCell('Acme')).toBe('Acme');
    const demo = demoWorkspace();
    demo.deals[0] = { ...demo.deals[0], account: '=HYPERLINK("x")', notes: '-danger, "quoted"' };
    const csv = dealsToCsv(demo);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    const fresh = { ...demo, deals: [] as typeof demo.deals, allocations: [] };
    const back = parseDealCsv(csv, fresh);
    expect(back.ok).toBe(true);
    if (back.ok) {
      expect(back.items.find((d) => d.id === demo.deals[0].id)?.account).toBe('=HYPERLINK("x")');
      expect(back.items.find((d) => d.id === demo.deals[0].id)?.notes).toBe('-danger, "quoted"');
    }
  });

  it('exports payments and reconciliation rows', () => {
    const demo = demoWorkspace();
    expect(paymentsToCsv(demo).split('\r\n')[1]).toMatch(/2026-02-15,6000.00,February statement,/);
    const rec = reconcile(demo, 2026, DEMO_AS_OF);
    const lines = reconciliationToCsv(rec.rows, DEMO_AS_OF, 2026).trim().split('\r\n');
    expect(lines).toHaveLength(5);
    expect(lines[2]).toContain('Beacon,2026-02-10,2026-03-15,50000.00,5500.00,5000.00,500.00,Partially received');
  });
});

describe('20. JSON backup and restore', () => {
  it('round-trips the workspace exactly, including ids and same-day order', () => {
    const demo = demoWorkspace();
    demo.deals[1] = { ...demo.deals[1], sameDayOrder: 7 };
    const r = parseBackupJson(workspaceToBackupJson(demo));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.preview.workspace).toEqual(demo);
      expect(r.preview.counts).toEqual({ plans: 1, deals: 4, payments: 2, allocations: 3 });
    }
  });

  it('rejects unsupported schema versions', () => {
    const data = JSON.parse(workspaceToBackupJson(demoWorkspace()));
    data.schemaVersion = 99;
    const r = parseBackupJson(JSON.stringify(data));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/Unsupported schema version/);
  });

  it('rejects dangling ids and impossible allocations', () => {
    const data = JSON.parse(workspaceToBackupJson(demoWorkspace()));
    data.allocations[0].dealId = '11111111-1111-4111-8111-111111111111';
    expect(parseBackupJson(JSON.stringify(data)).ok).toBe(false);

    const over = JSON.parse(workspaceToBackupJson(demoWorkspace()));
    over.allocations[0].amountCents = '600001';
    const r = parseBackupJson(JSON.stringify(over));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/more allocated/);

    const beforeClose = JSON.parse(workspaceToBackupJson(demoWorkspace()));
    beforeClose.payments[0].paymentDate = '2026-01-01';
    expect(parseBackupJson(JSON.stringify(beforeClose)).ok).toBe(false);

    const badDeal = JSON.parse(workspaceToBackupJson(demoWorkspace()));
    badDeal.deals[0].closeDate = '2025-12-31';
    expect(parseBackupJson(JSON.stringify(badDeal)).ok).toBe(false);
  });

  it('rejects non-JSON and foreign files', () => {
    expect(parseBackupJson('not json').ok).toBe(false);
    expect(parseBackupJson('{"app":"other","schemaVersion":1}').ok).toBe(false);
    expect(validateWorkspace([]).ok).toBe(false);
  });
});

describe('inputs and formatting', () => {
  it('parses money and percentages strictly', () => {
    expect(parseMoneyInput('$1,234.5')).toEqual({ ok: true, value: '123450' });
    expect(parseMoneyInput('1.234').ok).toBe(false);
    expect(parseMoneyInput('0').ok).toBe(false);
    expect(parseMoneyInput('-5').ok).toBe(false);
    expect(parseMoneyInput('999999999.99').ok).toBe(true);
    expect(parseMoneyInput('1000000000').ok).toBe(false);
    expect(parsePercentInput('10')).toEqual({ ok: true, value: '0.1' });
    expect(parsePercentInput('12.3456')).toEqual({ ok: true, value: '0.123456' });
    expect(parsePercentInput('12.34567').ok).toBe(false);
    expect(parsePercentInput('0').ok).toBe(false);
    expect(parsePercentInput('100').ok).toBe(true);
    expect(parsePercentInput('100.01').ok).toBe(false);
  });

  it('formats signed money', () => {
    expect(formatCents('55000')).toBe('$550.00');
    expect(formatCents('-5')).toBe('-$0.05');
    expect(formatCents('5', { signed: true })).toBe('+$0.05');
    expect(formatCents('123456789012345678901')).toBe('$1,234,567,890,123,456,789.01');
  });
});

describe('payroll inquiry', () => {
  const demo = demoWorkspace();
  const rec = reconcile(demo, 2026, DEMO_AS_OF);
  const due = rec.rows.filter((r) => r.isDue && !r.differenceCents.isZero());

  it('describes shortfalls with the template wording', () => {
    const text = buildInquiry({ recipientName: 'Sam', senderName: 'Jo', asOf: DEMO_AS_OF, rows: due, unallocatedCents: rec.summary.unallocatedCents });
    expect(text).toContain('Hi Sam,');
    expect(text).toContain('as of March 31, 2026');
    expect(text).toContain('I expected $8,500.00 across the deals below and recorded $7,950.00');
    expect(text).toContain('leaving a difference of $550.00');
    expect(text).toContain('- Beacon / ref EX-102 / expected payment Mar 15, 2026 / expected $5,500.00 / received $5,000.00 / difference $500.00');
    expect(text).not.toContain('may be incomplete');
    expect(text.trim().endsWith('Jo')).toBe(true);
  });

  it('lists both directions and a net difference when mixed, and notes unallocated money', () => {
    const shortRow = due[0];
    const excessRow = { ...due[1], receivedAsOfCents: due[1].expectedCents.plus(100), differenceCents: due[1].expectedCents.minus(due[1].expectedCents.plus(100)) };
    const text = buildInquiry({ recipientName: '', senderName: '', asOf: DEMO_AS_OF, rows: [shortRow, excessRow], unallocatedCents: shortRow.expectedCents });
    expect(text).toContain('Received less than expected:');
    expect(text).toContain('Received more than expected:');
    expect(text).toContain('net difference of');
    expect(text).toContain('may be incomplete');
    expect(text).toContain('Hi [name],');
  });
});
