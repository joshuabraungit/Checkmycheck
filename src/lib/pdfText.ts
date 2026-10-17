/**
 * Turn positioned PDF text into lines and cells, and pull commission
 * payments out of paystubs. Pure functions; the PDF reading itself lives in
 * readPdf.ts so the heavy PDF library loads only when needed.
 *
 * PDF coordinates put y = 0 at the bottom of the page, so lines read from
 * the largest y down.
 */
import { detectDateOrder, parseFlexibleDate, parseFlexibleMoney, type DateOrder } from './sheetImport';

export interface PdfTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  page: number;
}

export interface PdfLine {
  page: number;
  y: number;
  items: PdfTextItem[];
}

const SAME_LINE = 3;
const CELL_GAP = 8;

export function groupLines(items: readonly PdfTextItem[]): PdfLine[] {
  const sorted = items
    .filter((i) => i.str.trim() !== '')
    .sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  const lines: PdfLine[] = [];
  for (const item of sorted) {
    const last = lines[lines.length - 1];
    if (last && last.page === item.page && Math.abs(last.y - item.y) <= SAME_LINE) last.items.push(item);
    else lines.push({ page: item.page, y: item.y, items: [item] });
  }
  for (const l of lines) l.items.sort((a, b) => a.x - b.x);
  return lines;
}

/** Split a line into cells wherever there's a visible gap between pieces of text. */
export function lineCells(line: PdfLine): Array<{ text: string; x: number; right: number }> {
  const cells: Array<{ text: string; x: number; right: number }> = [];
  for (const item of line.items) {
    const last = cells[cells.length - 1];
    const right = item.x + item.width;
    if (last && item.x - last.right <= CELL_GAP) {
      const space = item.x - last.right > 1 && !last.text.endsWith(' ') && !item.str.startsWith(' ') ? ' ' : '';
      last.text += space + item.str;
      last.right = Math.max(last.right, right);
    } else {
      cells.push({ text: item.str, x: item.x, right });
    }
  }
  return cells.map((c) => ({ ...c, text: c.text.trim() })).filter((c) => c.text !== '');
}

export function lineText(line: PdfLine): string {
  return lineCells(line).map((c) => c.text).join('  ');
}

/** Rows of cells for table-style PDFs (statements, reports), ready for the spreadsheet importer. */
export function linesToRows(lines: readonly PdfLine[]): string[][] {
  const rows: string[][] = [];
  let page = lines[0]?.page;
  for (const l of lines) {
    if (l.page !== page) {
      rows.push([]);
      page = l.page;
    }
    rows.push(lineCells(l).map((c) => c.text));
  }
  return rows;
}

// ---------- Paystubs ----------

const DATE_TOKEN = /(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})/;
const PAY_DATE_LABEL = /\b(pay|check|payment|deposit|advice)\s*date\b/i;
const MONEY_CELL = /^\(?-?\s*\$?\s*\d{1,3}(,\d{3})*\.\d{2}\)?$|^\(?-?\s*\$?\s*\d+\.\d{2}\)?$/;
const COMMISSION_LABEL = /commiss/i;
const NOT_A_PAYOUT = /\b(rate|ytd|year[\s-]*to[\s-]*date|quota|plan|%)/i;

export interface PaystubLine {
  label: string;
  amountCents: string;
}

export interface PaystubResult {
  /** Raw pay date text as printed, if found. */
  payDateRaw: string | null;
  commissionLines: PaystubLine[];
  /** Labels of commission lines that were negative (clawbacks, reversals). They aren't imported. */
  negativeLabels: string[];
}

function firstDate(text: string): string | null {
  const m = DATE_TOKEN.exec(text);
  return m ? m[1] : null;
}

function findPayDate(lines: readonly PdfLine[]): string | null {
  for (let i = 0; i < lines.length; i++) {
    const cells = lineCells(lines[i]);
    const idx = cells.findIndex((c) => PAY_DATE_LABEL.test(c.text));
    if (idx === -1) continue;
    // Same cell ("Pay Date: 02/13/2026") or the cells right after it.
    const after = cells[idx].text.replace(/^.*?date\s*:?/i, '');
    const inline = firstDate(after) ?? cells.slice(idx + 1, idx + 3).map((c) => firstDate(c.text)).find(Boolean) ?? null;
    if (inline) return inline;
    // Stacked layout: label above the value.
    const label = cells[idx];
    for (const below of lines.slice(i + 1, i + 3)) {
      if (below.page !== lines[i].page) break;
      const hit = lineCells(below).find((c) => c.right >= label.x - 40 && c.x <= label.right + 40 && firstDate(c.text));
      if (hit) return firstDate(hit.text);
    }
  }
  return null;
}

function moneyValue(cell: string): { negative: boolean; text: string } {
  const negative = /^\(.*\)$/.test(cell) || /^-/.test(cell.replace(/[\s$]/g, ''));
  return { negative, text: cell.replace(/[()\-\s]/g, '') };
}

/**
 * Find the pay date and the current-period commission earnings on a paystub.
 * Uses the "Current"/"This Period" column when the earnings table has one;
 * otherwise, on a line with both a current and a year-to-date amount, the
 * year-to-date figure is the last one.
 */
export function extractPaystub(lines: readonly PdfLine[]): PaystubResult {
  const commissionLines: PaystubLine[] = [];
  const negativeLabels: string[] = [];
  let currentX: number | null = null;
  let currentPage = -1;

  for (const line of lines) {
    const cells = lineCells(line);
    const header = cells.find((c) => /^(current|this period|current period|amount)$/i.test(c.text));
    if (header && cells.some((c) => /^(ytd|year[\s-]*to[\s-]*date|ytd amount)$/i.test(c.text))) {
      currentX = (header.x + header.right) / 2;
      currentPage = line.page;
      continue;
    }
    const label = cells[0]?.text ?? '';
    if (!COMMISSION_LABEL.test(label) || NOT_A_PAYOUT.test(label)) continue;
    const money = cells.slice(1).filter((c) => MONEY_CELL.test(c.text));
    if (!money.length) continue;
    let pick = money.length >= 2 ? money[money.length - 2] : money[0];
    if (currentX !== null && currentPage === line.page) {
      pick = money.reduce((best, c) => (Math.abs((c.x + c.right) / 2 - currentX!) < Math.abs((best.x + best.right) / 2 - currentX!) ? c : best));
    }
    const { negative, text } = moneyValue(pick.text);
    if (negative) {
      negativeLabels.push(label);
      continue;
    }
    const parsed = parseFlexibleMoney(text, 'Amount');
    if (parsed.ok) commissionLines.push({ label, amountCents: parsed.value });
  }
  return { payDateRaw: findPayDate(lines), commissionLines, negativeLabels };
}

/** Decide day/month order across several paystubs' dates and parse them. */
export function parsePaystubDates(raws: readonly (string | null)[], chosen: DateOrder | null) {
  const detection = detectDateOrder(raws.filter((r): r is string => !!r));
  const order = detection.needsChoice ? chosen : detection.order ?? chosen;
  return {
    needsChoice: detection.needsChoice,
    dates: raws.map((r) => {
      if (!r) return null;
      const p = parseFlexibleDate(r, order);
      return p.ok ? p.value : null;
    }),
  };
}
