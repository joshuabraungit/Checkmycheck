import { describe, expect, it } from 'vitest';
import { extractPaystub, groupLines, lineCells, linesToRows, parsePaystubDates, type PdfTextItem } from './pdfText';
import { buildSheet } from './sheetImport';

/** Lay out text the way a PDF does: each string at an x position, rows going down the page. */
function page(rows: Array<Array<[number, string]>>, pageNo = 1, top = 700, step = 14): PdfTextItem[] {
  return rows.flatMap((cells, r) => cells.map(([x, str]) => ({ str, x, y: top - r * step, width: str.length * 5, page: pageNo })));
}

describe('groupLines and cells', () => {
  it('groups items on the same baseline and splits cells on gaps', () => {
    const items = page([
      [[50, 'Account'], [200, 'Amount'], [300, 'Close'], [328, 'Date']],
      [[50, 'Acme'], [72, 'Inc.'], [200, '$60,000.00'], [300, '01/30/2026']],
    ]);
    const lines = groupLines([...items].reverse());
    expect(lines).toHaveLength(2);
    expect(lineCells(lines[0]).map((c) => c.text)).toEqual(['Account', 'Amount', 'Close Date']);
    expect(lineCells(lines[1]).map((c) => c.text)).toEqual(['Acme Inc.', '$60,000.00', '01/30/2026']);
  });

  it('turns a multi-page statement into rows the importer can read, skipping repeated headers', () => {
    const header: Array<[number, string]> = [[50, 'Account'], [200, 'ARR'], [300, 'Close Date']];
    const items = [
      ...page([[[50, 'Q1 statement']], header, [[50, 'Acme'], [200, '60000'], [300, '2026-01-30']]], 1),
      ...page([header, [[50, 'Beacon'], [200, '50000'], [300, '2026-02-10']]], 2),
    ];
    const sheet = buildSheet(linesToRows(groupLines(items)));
    if ('error' in sheet) throw new Error(sheet.error);
    expect(sheet.headers).toEqual(['Account', 'ARR', 'Close Date']);
    expect(sheet.rows.map((r) => r[0])).toEqual(['Acme', 'Beacon']);
  });
});

describe('extractPaystub', () => {
  it('reads the pay date and current-period commission from an earnings table', () => {
    const items = page([
      [[50, 'ACME CORP'], [400, 'Earnings Statement']],
      [[50, 'Pay Period: 01/01/2026 - 01/31/2026'], [400, 'Pay Date: 02/13/2026']],
      [[50, 'Earnings'], [200, 'Rate'], [260, 'Hours'], [330, 'Current'], [420, 'YTD']],
      [[50, 'Regular Salary'], [330, '5,000.00'], [420, '10,000.00']],
      [[50, 'Commission'], [330, '4,800.00'], [420, '4,800.00']],
      [[50, 'Commission Adj'], [330, '200.00'], [420, '200.00']],
      [[50, 'Commission Clawback'], [330, '(150.00)'], [420, '(150.00)']],
      [[50, 'Commission Rate'], [330, '10.00']],
      [[50, 'Gross Pay'], [330, '10,000.00'], [420, '15,000.00']],
      [[50, 'Net Pay'], [330, '6,900.00']],
    ]);
    const r = extractPaystub(groupLines(items));
    expect(r.payDateRaw).toBe('02/13/2026');
    expect(r.commissionLines).toEqual([
      { label: 'Commission', amountCents: '480000' },
      { label: 'Commission Adj', amountCents: '20000' },
    ]);
    expect(r.negativeLabels).toEqual(['Commission Clawback']);
  });

  it('handles a stacked pay date and no column headers', () => {
    const items = page([
      [[50, 'Check Date'], [200, 'Pay Period']],
      [[50, 'Mar 13, 2026'], [200, 'Feb 2026']],
      [[50, 'Sales Commission'], [300, '10,800.00'], [400, '15,600.00']],
      [[50, 'Commissions'], [300, '1,000.00']],
    ]);
    const r = extractPaystub(groupLines(items));
    expect(r.payDateRaw).toBe('Mar 13, 2026');
    expect(r.commissionLines.map((l) => l.amountCents)).toEqual(['1080000', '100000']);
  });

  it('finds nothing on a document without commission lines', () => {
    const r = extractPaystub(groupLines(page([[[50, 'Invoice']], [[50, 'Total'], [300, '99.00']]])));
    expect(r.commissionLines).toEqual([]);
    expect(r.payDateRaw).toBeNull();
  });

  it('settles day/month order across several paystubs', () => {
    expect(parsePaystubDates(['02/13/2026', '03/01/2026'], null)).toEqual({ needsChoice: false, dates: ['2026-02-13', '2026-03-01'] });
    const amb = parsePaystubDates(['03/01/2026', '04/01/2026'], null);
    expect(amb.needsChoice).toBe(true);
    expect(amb.dates).toEqual([null, null]);
    expect(parsePaystubDates(['03/01/2026'], 'DMY').dates).toEqual(['2026-01-03']);
  });
});
