/**
 * Flexible spreadsheet import: take rows from any CSV or Excel export
 * (CRM reports, commission statements, personal trackers), match columns
 * to fields, and turn them into deals or payments.
 *
 * Pure and independent of the DOM. The whole file must pass before
 * anything is imported; rows are only ever skipped for reasons the user
 * can see and switch off.
 */
import { isValidDate, yearOf } from './dates';
import { D, parseMoneyInput, type ParseResult } from './money';
import { newId, type Deal, type Payment, type Workspace } from './types';
import { hasVisibleText } from './validate';
import type { RowError } from './csv';

export type ImportKind = 'deals' | 'payments';

/** A rectangular sheet of text cells. rowNumbers[i] is the 1-based row in the original file. */
export interface Sheet {
  headers: string[];
  rows: string[][];
  rowNumbers: number[];
  /** Rows above the header row that were ignored (titles, blank lines). */
  headerRowNumber: number;
}

export type DealField = 'account' | 'revenue' | 'closeDate' | 'expectedPaymentDate' | 'reference' | 'notes';
export type PaymentField = 'paymentDate' | 'amount' | 'reference' | 'notes';
export type Field = DealField | PaymentField;

export interface FieldDef {
  key: Field;
  label: string;
  required: boolean;
  /** Normalized header names, best match first. */
  synonyms: string[];
  /** Headers containing any of these words never match this field. */
  exclude?: string[];
}

export const DEAL_FIELDS: FieldDef[] = [
  {
    key: 'account',
    label: 'Account name',
    required: true,
    synonyms: ['account', 'account name', 'customer', 'customer name', 'company', 'company name', 'client', 'client name', 'opportunity name', 'opportunity', 'deal name', 'deal', 'name'],
    exclude: ['id', 'owner', 'rep', 'type', 'date'],
  },
  {
    key: 'revenue',
    label: 'Credited revenue',
    required: true,
    synonyms: ['credited revenue', 'credited amount', 'quota credit', 'commissionable amount', 'commissionable revenue', 'acv', 'arr', 'new arr', 'net new arr', 'bookings', 'booking amount', 'amount', 'deal amount', 'opportunity amount', 'deal value', 'revenue', 'tcv', 'total contract value', 'contract value', 'value'],
    exclude: ['commission', 'rate', 'percent', 'pct', 'paid', 'payout', 'date', 'id'],
  },
  {
    key: 'closeDate',
    label: 'Close date',
    required: true,
    synonyms: ['close date', 'closed date', 'closed won date', 'close won date', 'won date', 'date closed', 'booking date', 'booked date', 'signed date', 'contract signed date', 'close'],
  },
  {
    key: 'expectedPaymentDate',
    label: 'Expected payment date',
    required: false,
    synonyms: ['expected payment date', 'expected pay date', 'expected payout date', 'commission payment date', 'payout date', 'pay date', 'payment date', 'commission date'],
  },
  {
    key: 'reference',
    label: 'Deal reference or ID',
    required: false,
    synonyms: ['deal id', 'opportunity id', 'opp id', 'record id', 'reference', 'ref', 'salesforce id', 'crm id', 'id', 'deal reference', 'opportunity number', 'order number', 'invoice number'],
    exclude: ['owner', 'account id'],
  },
  {
    key: 'notes',
    label: 'Notes',
    required: false,
    synonyms: ['notes', 'note', 'description', 'comments', 'comment', 'memo'],
  },
];

export const PAYMENT_FIELDS: FieldDef[] = [
  {
    key: 'paymentDate',
    label: 'Payment date',
    required: true,
    synonyms: ['payment date', 'pay date', 'paid date', 'date paid', 'check date', 'payout date', 'deposit date', 'pay period end', 'period end', 'date'],
  },
  {
    key: 'amount',
    label: 'Gross commission',
    required: true,
    synonyms: ['gross commission', 'commission paid', 'commission amount', 'commissions', 'commission', 'gross payout', 'payout amount', 'payout', 'amount paid', 'paid', 'gross amount', 'gross', 'amount', 'total'],
    exclude: ['rate', 'percent', 'pct', 'revenue', 'deal amount', 'opportunity amount', 'net', 'date', 'id', 'quota'],
  },
  {
    key: 'reference',
    label: 'Statement or reference',
    required: false,
    synonyms: ['statement', 'statement id', 'reference', 'ref', 'period', 'pay period', 'payment id', 'check number', 'memo', 'description'],
  },
  {
    key: 'notes',
    label: 'Notes',
    required: false,
    synonyms: ['notes', 'note', 'comments', 'comment'],
  },
];

export function fieldsFor(kind: ImportKind): FieldDef[] {
  return kind === 'deals' ? DEAL_FIELDS : PAYMENT_FIELDS;
}

/** Column index for each field, or null when the file has no such column. */
export type Mapping = Partial<Record<Field, number | null>>;

// ---------- Building a sheet from raw rows ----------

const TOTAL_ROW = /^(grand\s+)?(sub)?totals?\b/i;

function isBlankRow(row: readonly string[]): boolean {
  return row.every((c) => c.trim() === '');
}

function looksLikeHeader(row: readonly string[]): boolean {
  const filled = row.map((c) => c.trim()).filter(Boolean);
  if (filled.length < 2) return false;
  // Header cells are labels: not money, not dates, not plain numbers.
  return filled.every((c) => !/^[\s$€£(+-]*[\d.,]+\)?$/.test(c) && !/^\d{4}-\d{2}-\d{2}/.test(c));
}

/**
 * Find the header row (skipping title lines above it), drop blank rows,
 * and pad every row to the header width.
 */
export function buildSheet(raw: string[][]): Sheet | { error: string } {
  const scanLimit = Math.min(raw.length, 15);
  let headerIdx = -1;
  for (let i = 0; i < scanLimit; i++) {
    if (looksLikeHeader(raw[i])) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    return { error: 'Couldn’t find a header row. The first rows of the file should include column names like “Account” and “Amount”.' };
  }
  const width = Math.max(...raw.slice(headerIdx).map((r) => r.length));
  const seen = new Map<string, number>();
  const headers = Array.from({ length: width }, (_, i) => {
    const base = (raw[headerIdx][i] ?? '').trim() || `Column ${columnLetter(i)}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n > 1 ? `${base} (${n})` : base;
  });
  const rows: string[][] = [];
  const rowNumbers: number[] = [];
  for (let i = headerIdx + 1; i < raw.length; i++) {
    if (isBlankRow(raw[i])) continue;
    rows.push(Array.from({ length: width }, (_, c) => (raw[i][c] ?? '').trim()));
    rowNumbers.push(i + 1);
  }
  if (!rows.length) return { error: 'The file has column names but no rows of data under them.' };
  return { headers, rows, rowNumbers, headerRowNumber: headerIdx + 1 };
}

export function columnLetter(index: number): string {
  let s = '';
  let n = index + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ---------- Column matching ----------

export function normalizeHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/\(usd\)|\busd\b|\$/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreHeader(field: FieldDef, header: string): number {
  const h = normalizeHeader(header);
  if (!h) return 0;
  const words = ` ${h} `;
  if (field.exclude?.some((x) => words.includes(` ${x} `))) return 0;
  let best = 0;
  field.synonyms.forEach((syn, idx) => {
    if (h === syn) best = Math.max(best, 1000 - idx);
    else if (words.includes(` ${syn} `)) best = Math.max(best, 500 - idx * 2 - (h.length - syn.length));
  });
  return best;
}

/** Guess which column holds each field. Each column is used at most once. */
export function guessMapping(kind: ImportKind, headers: readonly string[]): Mapping {
  const fields = fieldsFor(kind);
  const candidates: Array<{ field: Field; col: number; score: number }> = [];
  for (const f of fields) {
    headers.forEach((h, col) => {
      const score = scoreHeader(f, h);
      if (score > 0) candidates.push({ field: f.key, col, score });
    });
  }
  candidates.sort((a, b) => b.score - a.score || a.col - b.col);
  const mapping: Mapping = {};
  const used = new Set<number>();
  for (const c of candidates) {
    if (mapping[c.field] !== undefined || used.has(c.col)) continue;
    mapping[c.field] = c.col;
    used.add(c.col);
  }
  for (const f of fields) if (mapping[f.key] === undefined) mapping[f.key] = null;
  return mapping;
}

/** One tab of a workbook (a CSV is a single tab). */
export interface Tab {
  name: string;
  rows: string[][];
}

/**
 * Pick the tab that looks most like the data being imported: required
 * fields count most, and exact column names beat partial matches.
 */
export function pickTab(kind: ImportKind, tabs: readonly Tab[]): number {
  let best = 0;
  let bestScore = -1;
  tabs.forEach((tab, i) => {
    const sheet = buildSheet(tab.rows);
    if ('error' in sheet) return;
    const mapping = guessMapping(kind, sheet.headers);
    let score = 0;
    for (const f of fieldsFor(kind)) {
      const col = mapping[f.key];
      if (col === null || col === undefined) continue;
      score += scoreHeader(f, sheet.headers[col]) * (f.required ? 10 : 1);
    }
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return best;
}

/** Signature of a file's columns, used to remember the user's mapping for next time. */
export function headerSignature(kind: ImportKind, headers: readonly string[]): string {
  return `${kind}:${headers.map(normalizeHeader).join('|')}`;
}

// ---------- Value parsing ----------

export type DateOrder = 'MDY' | 'DMY';

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function monthFromName(name: string): number | null {
  const key = name.toLowerCase().replace(/\.$/, '');
  if (MONTHS[key]) return MONTHS[key];
  const short = key.slice(0, 3);
  const full = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const idx = full.indexOf(key);
  if (idx >= 0) return idx + 1;
  return key.length >= 3 && MONTHS[short] && full[MONTHS[short] - 1].startsWith(key) ? MONTHS[short] : null;
}

function iso(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function fullYear(y: string): number {
  return y.length === 2 ? 2000 + Number(y) : Number(y);
}

const NUMERIC_DMY = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?:[ T].*)?$/;

/**
 * Parse common date spellings into YYYY-MM-DD. Numeric dates like 01/02/2026
 * need a day/month order; without one they are reported as ambiguous.
 */
export function parseFlexibleDate(raw: string, order: DateOrder | null): ParseResult<string> & { ambiguous?: boolean } {
  const s = raw.trim();
  if (!s) return { ok: false, error: 'is blank' };
  let m: RegExpExecArray | null;
  let y: number, mo: number, d: number;

  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/.exec(s))) {
    [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  } else if ((m = NUMERIC_DMY.exec(s))) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    y = fullYear(m[3]);
    if (a > 12 && b <= 12) [d, mo] = [a, b];
    else if (b > 12 && a <= 12) [mo, d] = [a, b];
    else if (a === b) [mo, d] = [a, b];
    else if (order === 'DMY') [d, mo] = [a, b];
    else if (order === 'MDY') [mo, d] = [a, b];
    else return { ok: false, error: `“${s}” could be day/month or month/day`, ambiguous: true };
  } else if ((m = /^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i.exec(s))) {
    const month = monthFromName(m[1]);
    if (!month) return { ok: false, error: `“${s}” isn’t a date we recognize` };
    [y, mo, d] = [Number(m[3]), month, Number(m[2])];
  } else if ((m = /^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([a-z]+)\.?,?[\s-]+(\d{2}|\d{4})$/i.exec(s))) {
    const month = monthFromName(m[2]);
    if (!month) return { ok: false, error: `“${s}” isn’t a date we recognize` };
    [y, mo, d] = [fullYear(m[3]), month, Number(m[1])];
  } else {
    return { ok: false, error: `“${s}” isn’t a date we recognize` };
  }
  const value = iso(y, mo, d);
  if (!isValidDate(value)) return { ok: false, error: `“${s}” isn’t a real calendar date` };
  return { ok: true, value };
}

/**
 * Look at numeric dates in the file to decide day/month order.
 * Returns the order the data proves, or needsChoice when it can't tell.
 */
export function detectDateOrder(values: Iterable<string>): { order: DateOrder | null; needsChoice: boolean } {
  let mdy = false;
  let dmy = false;
  let ambiguous = false;
  for (const v of values) {
    const m = NUMERIC_DMY.exec(v.trim());
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 12 && b <= 12) dmy = true;
    else if (b > 12 && a <= 12) mdy = true;
    else if (a !== b) ambiguous = true;
  }
  if (mdy && !dmy) return { order: 'MDY', needsChoice: false };
  if (dmy && !mdy) return { order: 'DMY', needsChoice: false };
  if (mdy && dmy) return { order: null, needsChoice: true };
  return { order: null, needsChoice: ambiguous };
}

/**
 * Parse money as it appears in exports: "$60,000.00", "60000", "USD 1,250.5".
 * Spreadsheet float noise (e.g. 1234.5600000001) is rounded; real extra
 * precision is rejected rather than guessed at.
 */
export function parseFlexibleMoney(raw: string, label: string): ParseResult<string> {
  let s = raw.trim();
  if (!s) return { ok: false, error: `${label} is blank` };
  if (/^\(.*\)$/.test(s) || /^-/.test(s.replace(/^[$\s]+|usd\s*/gi, ''))) {
    return { ok: false, error: `${label} “${raw.trim()}” is negative. Only positive amounts can be imported` };
  }
  s = s.replace(/usd|us\$|\$|\s/gi, '').replace(/,/g, '');
  if (!/^\d*\.?\d+(e[+-]?\d+)?$/i.test(s)) return { ok: false, error: `${label} “${raw.trim()}” isn’t a number` };
  let dec = new D(s);
  if (dec.decimalPlaces() > 2) {
    const rounded = dec.toDecimalPlaces(2);
    if (dec.minus(rounded).abs().gt('0.000001')) {
      return { ok: false, error: `${label} “${raw.trim()}” has more than two decimal places` };
    }
    dec = rounded;
  }
  const parsed = parseMoneyInput(dec.toFixed(), label);
  return parsed.ok ? parsed : { ok: false, error: parsed.error.replace(/\.$/, '') };
}

// ---------- Building records ----------

export interface ImportOptions {
  dateOrder: DateOrder | null;
  /** For deals: expected payment = close date + this many days when the column is missing or blank. */
  expectedPaymentDays: number;
  /** Skip rows that look already imported (same reference, or same date/amount/reference for payments). */
  skipExisting: boolean;
  /** For deals: skip rows whose close date falls in a year with no plan, instead of failing. */
  skipOtherYears: boolean;
}

export const DEFAULT_OPTIONS: ImportOptions = {
  dateOrder: null,
  expectedPaymentDays: 30,
  skipExisting: true,
  skipOtherYears: false,
};

export interface SkippedRow {
  row: number;
  reason: string;
}

export interface BuildResult<T> {
  items: T[];
  skipped: SkippedRow[];
  errors: RowError[];
  /** Fields the user still has to map before anything can import. */
  missingFields: string[];
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

function cell(row: readonly string[], col: number | null | undefined): string {
  return col === null || col === undefined ? '' : (row[col] ?? '').trim();
}

function isTotalRow(row: readonly string[]): boolean {
  const first = row.find((c) => c.trim() !== '');
  return first !== undefined && TOTAL_ROW.test(first.trim());
}

function missing(kind: ImportKind, mapping: Mapping): string[] {
  return fieldsFor(kind)
    .filter((f) => f.required && (mapping[f.key] === null || mapping[f.key] === undefined))
    .map((f) => f.label);
}

export function buildDeals(sheet: Sheet, mapping: Mapping, opts: ImportOptions, ws: Workspace): BuildResult<Deal> {
  const missingFields = missing('deals', mapping);
  if (missingFields.length) return { items: [], skipped: [], errors: [], missingFields };
  const errors: RowError[] = [];
  const skipped: SkippedRow[] = [];
  const items: Deal[] = [];
  const plansByYear = new Map(ws.plans.map((p) => [p.year, p]));
  const existingRefs = new Set(ws.deals.map((d) => d.reference.trim().toLowerCase()).filter(Boolean));
  const nextOrder = new Map<string, number>();
  for (const d of ws.deals) {
    const key = `${d.planId}|${d.closeDate}`;
    nextOrder.set(key, Math.max(nextOrder.get(key) ?? 0, d.sameDayOrder + 1));
  }

  sheet.rows.forEach((row, i) => {
    const rowNum = sheet.rowNumbers[i];
    if (isTotalRow(row)) return void skipped.push({ row: rowNum, reason: 'Looks like a totals row' });
    const rowErrors: string[] = [];
    const account = cell(row, mapping.account);
    const reference = cell(row, mapping.reference);
    if (!hasVisibleText(account)) rowErrors.push('Account name is blank');
    const revenue = parseFlexibleMoney(cell(row, mapping.revenue), 'Credited revenue');
    if (!revenue.ok) rowErrors.push(revenue.error);
    const close = parseFlexibleDate(cell(row, mapping.closeDate), opts.dateOrder);
    if (!close.ok) rowErrors.push(`Close date ${close.error}`);

    let expected: string | null = null;
    const expectedRaw = cell(row, mapping.expectedPaymentDate);
    if (expectedRaw) {
      const e = parseFlexibleDate(expectedRaw, opts.dateOrder);
      if (e.ok) expected = e.value;
      else rowErrors.push(`Expected payment date ${e.error}`);
    } else if (close.ok) {
      expected = addDays(close.value, opts.expectedPaymentDays);
    }

    let plan = undefined as (typeof ws.plans)[number] | undefined;
    if (close.ok) {
      plan = plansByYear.get(yearOf(close.value));
      if (!plan) {
        if (opts.skipOtherYears && !rowErrors.length) {
          return void skipped.push({ row: rowNum, reason: `Closed in ${yearOf(close.value)}, which has no plan` });
        }
        rowErrors.push(`Closed in ${yearOf(close.value)}, but there’s no ${yearOf(close.value)} plan`);
      }
      if (expected && expected < close.value) rowErrors.push('Expected payment date is before the close date');
    }

    if (opts.skipExisting && reference && existingRefs.has(reference.toLowerCase()) && !rowErrors.length) {
      return void skipped.push({ row: rowNum, reason: `Already have a deal with reference ${reference}` });
    }
    if (rowErrors.length) {
      rowErrors.forEach((message) => errors.push({ row: rowNum, message }));
      return;
    }
    const closeDate = (close as { value: string }).value;
    const key = `${plan!.id}|${closeDate}`;
    const order = nextOrder.get(key) ?? 0;
    nextOrder.set(key, order + 1);
    items.push({
      id: newId(),
      planId: plan!.id,
      account: account.trim(),
      reference,
      creditedRevenueCents: (revenue as { value: string }).value,
      closeDate,
      expectedPaymentDate: expected!,
      sameDayOrder: order,
      notes: cell(row, mapping.notes),
    });
  });
  return { items, skipped, errors, missingFields };
}

export function buildPayments(sheet: Sheet, mapping: Mapping, opts: ImportOptions, ws: Workspace): BuildResult<Payment> {
  const missingFields = missing('payments', mapping);
  if (missingFields.length) return { items: [], skipped: [], errors: [], missingFields };
  const errors: RowError[] = [];
  const skipped: SkippedRow[] = [];
  const items: Payment[] = [];
  const key = (date: string, cents: string, ref: string) => `${date}|${cents}|${ref.trim().toLowerCase()}`;
  const existing = new Set(ws.payments.map((p) => key(p.paymentDate, p.amountCents, p.reference)));

  sheet.rows.forEach((row, i) => {
    const rowNum = sheet.rowNumbers[i];
    if (isTotalRow(row)) return void skipped.push({ row: rowNum, reason: 'Looks like a totals row' });
    const rowErrors: string[] = [];
    const date = parseFlexibleDate(cell(row, mapping.paymentDate), opts.dateOrder);
    if (!date.ok) rowErrors.push(`Payment date ${date.error}`);
    const amount = parseFlexibleMoney(cell(row, mapping.amount), 'Amount');
    if (!amount.ok) rowErrors.push(amount.error);
    const reference = cell(row, mapping.reference);
    if (rowErrors.length) {
      rowErrors.forEach((message) => errors.push({ row: rowNum, message }));
      return;
    }
    const p: Payment = {
      id: newId(),
      paymentDate: (date as { value: string }).value,
      amountCents: (amount as { value: string }).value,
      reference,
      notes: cell(row, mapping.notes),
    };
    if (opts.skipExisting && existing.has(key(p.paymentDate, p.amountCents, p.reference))) {
      return void skipped.push({ row: rowNum, reason: 'Same date, amount, and reference as a payment you already have' });
    }
    items.push(p);
  });
  return { items, skipped, errors, missingFields };
}

/** Every raw value in the mapped date columns, for day/month detection. */
export function dateValues(kind: ImportKind, sheet: Sheet, mapping: Mapping): string[] {
  const cols = (kind === 'deals' ? [mapping.closeDate, mapping.expectedPaymentDate] : [mapping.paymentDate]).filter(
    (c): c is number => c !== null && c !== undefined,
  );
  return sheet.rows.flatMap((r) => cols.map((c) => r[c] ?? ''));
}
