import type { DealReconciliation } from './calc';
import { STATUS_LABELS } from './calc';
import { isValidDate, yearOf } from './dates';
import { centsToDollarString, parseMoneyInput } from './money';
import { newId, type Deal, type Payment, type Workspace } from './types';
import { hasVisibleText, isUuid } from './validate';

export const DEAL_COLUMNS = [
  'deal_id', 'plan_year', 'account', 'reference', 'credited_revenue_usd',
  'close_date', 'expected_payment_date', 'same_day_order', 'notes',
] as const;
export const PAYMENT_COLUMNS = ['payment_id', 'payment_date', 'gross_commission_usd', 'reference', 'notes'] as const;
export const ALLOCATION_COLUMNS = ['allocation_id', 'payment_id', 'deal_id', 'amount_usd'] as const;
export const RECONCILIATION_COLUMNS = [
  'as_of_date', 'plan_year', 'deal_id', 'account', 'close_date', 'expected_payment_date',
  'credited_revenue_usd', 'expected_commission_usd', 'received_as_of_usd', 'signed_difference_usd', 'status',
] as const;

// ---------- Parsing ----------

export class CsvSyntaxError extends Error {}

/** RFC 4180 style parser: quoted fields, escaped quotes, commas and line breaks inside quotes. */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let fieldStarted = false;
  let line = 1;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
          const next = src[i + 1];
          if (next !== undefined && next !== ',' && next !== '\n' && next !== '\r') {
            throw new CsvSyntaxError(`Line ${line}: unexpected text after a closing quote.`);
          }
        }
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (fieldStarted && field !== '') throw new CsvSyntaxError(`Line ${line}: a quote appears in the middle of a field.`);
      inQuotes = true;
      fieldStarted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
      fieldStarted = false;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      fieldStarted = false;
      line++;
    } else {
      field += ch;
      fieldStarted = true;
    }
  }
  if (inQuotes) throw new CsvSyntaxError('The file ends inside a quoted field. Check for a missing closing quote.');
  if (fieldStarted || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const FORMULA_START = /^[=+\-@\t\r]/;

/** Prefix text that a spreadsheet would treat as a formula. */
export function protectCell(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

/** Undo protectCell on import so exported files round-trip cleanly. */
export function unprotectCell(value: string): string {
  return value.startsWith("'") && FORMULA_START.test(value.slice(1)) ? value.slice(1) : value;
}

function quote(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Build CSV text. Text cells are protected against formula injection. */
export function toCsv(header: readonly string[], rows: Array<Array<string | { raw: string }>>): string {
  const lines = [header.map(quote).join(',')];
  for (const r of rows) {
    lines.push(r.map((cell) => quote(typeof cell === 'string' ? protectCell(cell) : cell.raw)).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

const raw = (s: string | number) => ({ raw: String(s) });

export interface RowError {
  /** 1-based row number in the file, counting the header as row 1. */
  row: number;
  message: string;
}

type TableResult = { ok: true; records: Array<{ row: number; values: Record<string, string> }> } | { ok: false; errors: RowError[] };

function readTable(text: string, columns: readonly string[]): TableResult {
  let rows: string[][];
  try {
    rows = parseCsv(text);
  } catch (e) {
    return { ok: false, errors: [{ row: 0, message: (e as Error).message }] };
  }
  if (rows.length === 0) return { ok: false, errors: [{ row: 0, message: 'The file is empty.' }] };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const missing = columns.filter((c) => !header.includes(c));
  const unknown = header.filter((h) => !columns.includes(h));
  const errors: RowError[] = [];
  if (missing.length) errors.push({ row: 1, message: `Missing column(s): ${missing.join(', ')}.` });
  if (unknown.length) errors.push({ row: 1, message: `Unrecognized column(s): ${unknown.join(', ')}.` });
  if (new Set(header).size !== header.length) errors.push({ row: 1, message: 'A column name appears more than once.' });
  if (errors.length) return { ok: false, errors };
  const records: Array<{ row: number; values: Record<string, string> }> = [];
  rows.slice(1).forEach((cells, i) => {
    const rowNum = i + 2;
    if (cells.every((c) => c.trim() === '')) return;
    if (cells.length !== header.length) {
      errors.push({ row: rowNum, message: `Expected ${header.length} fields but found ${cells.length}.` });
      return;
    }
    const values: Record<string, string> = {};
    header.forEach((h, idx) => (values[h] = unprotectCell(cells[idx])));
    records.push({ row: rowNum, values });
  });
  if (errors.length) return { ok: false, errors };
  if (records.length === 0) return { ok: false, errors: [{ row: 0, message: 'The file has a header but no data rows.' }] };
  return { ok: true, records };
}

function allIds(ws: Workspace): Set<string> {
  return new Set([
    ...ws.plans.map((p) => p.id),
    ...ws.deals.map((d) => d.id),
    ...ws.payments.map((p) => p.id),
    ...ws.allocations.map((a) => a.id),
  ]);
}

export type ImportResult<T> = { ok: true; items: T[] } | { ok: false; errors: RowError[] };

/** Parse and validate a deal CSV. All rows must be valid or nothing is imported. */
export function parseDealCsv(text: string, ws: Workspace): ImportResult<Deal> {
  const table = readTable(text, DEAL_COLUMNS);
  if (!table.ok) return table;
  const errors: RowError[] = [];
  const existingIds = allIds(ws);
  const fileIds = new Set<string>();
  const deals: Deal[] = [];
  const nextOrder = new Map<string, number>();
  for (const d of ws.deals) {
    const key = `${d.planId}|${d.closeDate}`;
    nextOrder.set(key, Math.max(nextOrder.get(key) ?? 0, d.sameDayOrder + 1));
  }
  const pendingAuto: Array<{ deal: Deal; key: string }> = [];

  for (const { row, values: v } of table.records) {
    const rowErrors: string[] = [];
    let id = v.deal_id.trim();
    if (id === '') id = newId();
    else if (!isUuid(id)) rowErrors.push('deal_id must be blank or a UUID.');
    else if (existingIds.has(id)) rowErrors.push(`deal_id ${id} already exists. Import is blocked rather than overwriting it.`);
    else if (fileIds.has(id)) rowErrors.push(`deal_id ${id} appears more than once in this file.`);
    fileIds.add(id);

    const yearText = v.plan_year.trim();
    const plan = /^\d{4}$/.test(yearText) ? ws.plans.find((p) => p.year === Number(yearText)) : undefined;
    if (!plan) rowErrors.push(`No plan exists for year "${yearText}". Create the plan first.`);

    const account = v.account.trim();
    if (!hasVisibleText(account)) rowErrors.push('account is required.');

    const revenue = parseMoneyInput(v.credited_revenue_usd, 'credited_revenue_usd');
    if (!revenue.ok) rowErrors.push(revenue.error);

    const closeDate = v.close_date.trim();
    const expectedDate = v.expected_payment_date.trim();
    if (!isValidDate(closeDate)) rowErrors.push('close_date must be a real date in YYYY-MM-DD form.');
    else if (plan && yearOf(closeDate) !== plan.year) rowErrors.push(`close_date must be in ${plan.year}.`);
    if (!isValidDate(expectedDate)) rowErrors.push('expected_payment_date must be a real date in YYYY-MM-DD form.');
    else if (isValidDate(closeDate) && expectedDate < closeDate) rowErrors.push('expected_payment_date must be on or after close_date.');

    const orderText = v.same_day_order.trim();
    let order: number | null = null;
    if (orderText !== '') {
      if (!/^\d{1,9}$/.test(orderText)) rowErrors.push('same_day_order must be blank or a whole number of 0 or more.');
      else order = Number(orderText);
    }

    if (rowErrors.length) {
      rowErrors.forEach((message) => errors.push({ row, message }));
      continue;
    }
    const deal: Deal = {
      id,
      planId: plan!.id,
      account,
      reference: v.reference.trim(),
      creditedRevenueCents: (revenue as { value: string }).value,
      closeDate,
      expectedPaymentDate: expectedDate,
      sameDayOrder: order ?? 0,
      notes: v.notes,
    };
    const key = `${deal.planId}|${deal.closeDate}`;
    if (order === null) pendingAuto.push({ deal, key });
    else nextOrder.set(key, Math.max(nextOrder.get(key) ?? 0, order + 1));
    deals.push(deal);
  }
  if (errors.length) return { ok: false, errors };
  // Blank same_day_order values go after everything already on that date, in file order.
  for (const { deal, key } of pendingAuto) {
    const n = nextOrder.get(key) ?? 0;
    deal.sameDayOrder = n;
    nextOrder.set(key, n + 1);
  }
  return { ok: true, items: deals };
}

/** Parse and validate a payment CSV. Imported payments start unallocated. */
export function parsePaymentCsv(text: string, ws: Workspace): ImportResult<Payment> {
  const table = readTable(text, PAYMENT_COLUMNS);
  if (!table.ok) return table;
  const errors: RowError[] = [];
  const existingIds = allIds(ws);
  const fileIds = new Set<string>();
  const payments: Payment[] = [];
  for (const { row, values: v } of table.records) {
    const rowErrors: string[] = [];
    let id = v.payment_id.trim();
    if (id === '') id = newId();
    else if (!isUuid(id)) rowErrors.push('payment_id must be blank or a UUID.');
    else if (existingIds.has(id)) rowErrors.push(`payment_id ${id} already exists. Import is blocked rather than overwriting it.`);
    else if (fileIds.has(id)) rowErrors.push(`payment_id ${id} appears more than once in this file.`);
    fileIds.add(id);
    const date = v.payment_date.trim();
    if (!isValidDate(date)) rowErrors.push('payment_date must be a real date in YYYY-MM-DD form.');
    const amount = parseMoneyInput(v.gross_commission_usd, 'gross_commission_usd');
    if (!amount.ok) rowErrors.push(amount.error);
    if (rowErrors.length) {
      rowErrors.forEach((message) => errors.push({ row, message }));
      continue;
    }
    payments.push({ id, paymentDate: date, amountCents: (amount as { value: string }).value, reference: v.reference.trim(), notes: v.notes });
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, items: payments };
}

// ---------- Exports ----------

export function dealsToCsv(ws: Workspace): string {
  const years = new Map(ws.plans.map((p) => [p.id, p.year]));
  const deals = [...ws.deals].sort((a, b) =>
    a.closeDate !== b.closeDate ? (a.closeDate < b.closeDate ? -1 : 1) : a.sameDayOrder - b.sameDayOrder || a.id.localeCompare(b.id),
  );
  return toCsv(
    DEAL_COLUMNS,
    deals.map((d) => [
      raw(d.id), raw(years.get(d.planId)!), d.account, d.reference, raw(centsToDollarString(d.creditedRevenueCents)),
      raw(d.closeDate), raw(d.expectedPaymentDate), raw(d.sameDayOrder), d.notes,
    ]),
  );
}

export function paymentsToCsv(ws: Workspace): string {
  const payments = [...ws.payments].sort((a, b) => a.paymentDate.localeCompare(b.paymentDate) || a.id.localeCompare(b.id));
  return toCsv(
    PAYMENT_COLUMNS,
    payments.map((p) => [raw(p.id), raw(p.paymentDate), raw(centsToDollarString(p.amountCents)), p.reference, p.notes]),
  );
}

export function allocationsToCsv(ws: Workspace): string {
  return toCsv(
    ALLOCATION_COLUMNS,
    ws.allocations.map((a) => [raw(a.id), raw(a.paymentId), raw(a.dealId), raw(centsToDollarString(a.amountCents))]),
  );
}

export function reconciliationToCsv(rows: DealReconciliation[], asOf: string, planYear: number): string {
  return toCsv(
    RECONCILIATION_COLUMNS,
    rows.map((r) => [
      raw(asOf), raw(planYear), raw(r.deal.id), r.deal.account, raw(r.deal.closeDate), raw(r.deal.expectedPaymentDate),
      raw(centsToDollarString(r.revenueCents)), raw(centsToDollarString(r.expectedCents)),
      raw(centsToDollarString(r.receivedAsOfCents)), raw(centsToDollarString(r.differenceCents)), STATUS_LABELS[r.status],
    ]),
  );
}

export function dealTemplateCsv(): string {
  return toCsv(DEAL_COLUMNS, [
    [raw(''), raw('2026'), 'Example Co', 'OPP-1234', raw('25000.00'), raw('2026-04-10'), raw('2026-05-15'), raw(''), 'Optional note'],
  ]);
}

export function paymentTemplateCsv(): string {
  return toCsv(PAYMENT_COLUMNS, [[raw(''), raw('2026-05-15'), raw('2500.00'), 'May statement', 'Optional note']]);
}
