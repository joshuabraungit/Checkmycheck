/**
 * One drop zone for everything: CRM exports, trackers, statements, paystubs.
 * Each file (and each tab of a workbook) is classified as deals, payments,
 * or neither, and built into records using the same rules as the step-by-
 * step importers. Pure; reading files happens in the component.
 */
import { suggestMatches } from './autoMatch';
import { appendDeals, appendPayments, setPaymentAllocations } from './ops';
import { parsePaystubDates, type PaystubResult } from './pdfText';
import { sumCents } from './money';
import { formatDateShort } from './dates';
import {
  buildDeals, buildPayments, classifyTab, dateValues, detectDateOrder, DEFAULT_OPTIONS, parseFlexibleDate, type BuildResult, type DateOrder, type Mapping,
  type Sheet, type Tab,
} from './sheetImport';
import { newId, type Deal, type Payment, type Workspace } from './types';

export type DroppedFile =
  | { fileName: string; tabs: Tab[] }
  | { fileName: string; paystub: PaystubResult }
  | { fileName: string; error: string };

export type Source =
  | { kind: 'deals'; label: string; sheet: Sheet; mapping: Mapping; result: BuildResult<Deal> }
  | { kind: 'payments'; label: string; sheet: Sheet; mapping: Mapping; result: BuildResult<Payment> }
  | { kind: 'paystub'; label: string; payment: Payment | null; problem: string | null; paystub: PaystubResult }
  | { kind: 'ignored'; label: string; reason: string };

export interface DropOptions {
  dateOrder: DateOrder | null;
  expectedPaymentDays: number;
}

export interface DropAnalysis {
  sources: Source[];
  /** Numeric dates somewhere in the files could be month-first or day-first. */
  needsDateOrder: boolean;
}

function paystubReference(fileName: string): string {
  const base = fileName.replace(/\.pdf$/i, '');
  return /pay\s*stub/i.test(base) ? base : `Paystub ${base}`;
}

/** Same date and amount as a payment already recorded or already in this drop: treat as the same paycheck. */
function withoutSameDayAmount(r: BuildResult<Payment>, acc: Workspace): BuildResult<Payment> {
  const seen = new Set(acc.payments.map((p) => `${p.paymentDate}|${p.amountCents}`));
  const items: Payment[] = [];
  const skipped = [...r.skipped];
  r.items.forEach((p) => {
    const key = `${p.paymentDate}|${p.amountCents}`;
    if (seen.has(key)) skipped.push({ row: 0, reason: 'Same date and amount as a payment already added' });
    else {
      seen.add(key);
      items.push(p);
    }
  });
  return { ...r, items, skipped };
}

export function analyzeDrop(files: readonly DroppedFile[], ws: Workspace, opts: DropOptions): DropAnalysis {
  const classified: Array<{ label: string; kind: 'deals' | 'payments'; sheet: Sheet; mapping: Mapping }> = [];
  const sources: Source[] = [];
  const stubs: Array<{ label: string; fileName: string; paystub: PaystubResult }> = [];
  const order: Array<{ type: 'tab' | 'stub' | 'ignored'; index: number }> = [];

  for (const f of files) {
    if ('error' in f) {
      order.push({ type: 'ignored', index: sources.length });
      sources.push({ kind: 'ignored', label: f.fileName, reason: f.error });
    } else if ('paystub' in f) {
      order.push({ type: 'stub', index: stubs.length });
      stubs.push({ label: f.fileName, fileName: f.fileName, paystub: f.paystub });
    } else {
      const multi = f.tabs.length > 1;
      let found = false;
      for (const tab of f.tabs) {
        const label = multi ? `${f.fileName} › ${tab.name}` : f.fileName;
        const c = classifyTab(tab);
        if (!c) continue;
        found = true;
        order.push({ type: 'tab', index: classified.length });
        classified.push({ label, ...c });
      }
      if (!found) {
        order.push({ type: 'ignored', index: sources.length });
        sources.push({
          kind: 'ignored',
          label: f.fileName,
          reason: 'Couldn’t tell what this file holds. Deals need an account, an amount, and a close date; payments need a date and an amount.',
        });
      }
    }
  }

  // One day/month decision covers every file.
  const allDates = [
    ...classified.flatMap((c) => dateValues(c.kind, c.sheet, c.mapping)),
    ...stubs.map((s) => s.paystub.payDateRaw ?? ''),
  ];
  const detection = detectDateOrder(allDates);
  const dateOrder = detection.needsChoice ? opts.dateOrder : detection.order ?? opts.dateOrder;
  const needsDateOrder = detection.needsChoice && !opts.dateOrder;
  const buildOpts = { ...DEFAULT_OPTIONS, dateOrder, expectedPaymentDays: opts.expectedPaymentDays, skipExisting: true, skipOtherYears: true };

  // Build in order so later files see earlier ones (same-day order, duplicate checks).
  let acc = ws;
  const built: Source[] = classified.map((c) => {
    if (c.kind === 'deals') {
      const result = buildDeals(c.sheet, c.mapping, buildOpts, acc);
      if (!result.errors.length) acc = appendDeals(acc, result.items);
      return { kind: 'deals', label: c.label, sheet: c.sheet, mapping: c.mapping, result };
    }
    const built = buildPayments(c.sheet, c.mapping, buildOpts, acc);
    // A tracker's paystub log and the paystub PDFs describe the same paychecks; keep one copy.
    const result = withoutSameDayAmount(built, acc);
    if (!result.errors.length) acc = appendPayments(acc, result.items);
    return { kind: 'payments', label: c.label, sheet: c.sheet, mapping: c.mapping, result };
  });

  const stubDates = parsePaystubDates(stubs.map((s) => s.paystub.payDateRaw), dateOrder).dates;
  const stubSources: Source[] = stubs.map((s, i) => {
    const date = stubDates[i];
    const lines = s.paystub.commissionLines;
    const reference = paystubReference(s.fileName);
    let problem: string | null = null;
    let payment: Payment | null = null;
    if (!lines.length) problem = 'No commission line found on this paystub.';
    else if (!date) problem = needsDateOrder ? null : 'Couldn’t find the pay date.';
    if (lines.length && date) {
      const amountCents = sumCents(lines.map((l) => l.amountCents)).toFixed(0);
      const dup = acc.payments.some((p) => p.paymentDate === date && p.amountCents === amountCents);
      if (dup) problem = 'Already added.';
      else {
        payment = { id: newId(), paymentDate: date, amountCents, reference, notes: lines.map((l) => l.label).join(', ') };
        acc = appendPayments(acc, [payment]);
      }
    }
    return { kind: 'paystub', label: s.label, payment, problem, paystub: s.paystub };
  });

  const ordered = order.map((o) => (o.type === 'tab' ? built[o.index] : o.type === 'stub' ? stubSources[o.index] : sources[o.index]));
  return { sources: ordered, needsDateOrder };
}

/** Records a source would add, or nothing when the source has problems. */
export function sourceItems(s: Source): { deals: Deal[]; payments: Payment[] } {
  if (s.kind === 'deals' && !s.result.errors.length) return { deals: s.result.items, payments: [] };
  if (s.kind === 'payments' && !s.result.errors.length) return { deals: [], payments: s.result.items };
  if (s.kind === 'paystub' && s.payment) return { deals: [], payments: [s.payment] };
  return { deals: [], payments: [] };
}

/**
 * Add the chosen sources' records, then match payments to deals: every match
 * that adds up exactly and, unless turned off, the best guesses too. Best
 * guesses are listed so the person can check them.
 */
export function applyDrop(
  ws: Workspace,
  sources: readonly Source[],
  opts: { includeBestGuesses: boolean } = { includeBestGuesses: true },
): { workspace: Workspace; deals: number; payments: number; matched: number; guessed: Payment[]; unmatched: number } {
  const deals = sources.flatMap((s) => sourceItems(s).deals);
  const payments = sources.flatMap((s) => sourceItems(s).payments);
  let next = appendPayments(appendDeals(ws, deals), payments);
  const matches = suggestMatches(next);
  const applied = matches.filter((m) => m.kind === 'exact' || (opts.includeBestGuesses && m.kind === 'best_guess'));
  for (const m of applied) {
    next = setPaymentAllocations(next, m.payment.id, m.lines.map((l) => ({ dealId: l.deal.id, amountCents: l.amountCents.toFixed(0) })));
  }
  return {
    workspace: next,
    deals: deals.length,
    payments: payments.length,
    matched: applied.length,
    guessed: applied.filter((m) => m.kind === 'best_guess').map((m) => m.payment),
    unmatched: matches.length - applied.length,
  };
}

function plural(n: number, word: string): string {
  return `${n} ${n === 1 ? word : `${word}s`}`;
}

/** Something only the person can settle: ambiguous day/month dates, or rows that can't be read. */
export function needsDecision(a: DropAnalysis): boolean {
  return a.needsDateOrder || a.sources.some((s) => (s.kind === 'deals' || s.kind === 'payments') && s.result.errors.length > 0);
}

/** Plain-language summary of what a drop did. */
export function dropMessage(a: DropAnalysis, r: ReturnType<typeof applyDrop>, expectedPaymentDays: number): string {
  const what = [r.deals ? plural(r.deals, 'deal') : '', r.payments ? plural(r.payments, 'payment') : ''].filter(Boolean).join(' and ');
  const parts = [`Added ${what}.`];
  if (r.matched) parts.push(`Matched ${plural(r.matched, 'payment')} to deals.`);
  if (r.guessed.length) {
    const dates = r.guessed.map((p) => formatDateShort(p.paymentDate)).join(', ');
    parts.push(
      `${r.guessed.length === 1 ? 'One was a best guess' : `${r.guessed.length} were best guesses`} because the amounts didn’t add up exactly (${dates}), so check ${r.guessed.length === 1 ? 'it' : 'them'} under Details › Payments.`,
    );
  }
  if (r.unmatched) parts.push(`${plural(r.unmatched, 'payment')} still ${r.unmatched === 1 ? 'needs' : 'need'} matching.`);
  const estimated = a.sources.some((s) => s.kind === 'deals' && (s.mapping.expectedPaymentDate === null || s.mapping.expectedPaymentDate === undefined));
  if (estimated && r.deals) parts.push(`We assumed commission is paid about ${expectedPaymentDays} days after close; edit a deal if that’s off.`);
  const unused = a.sources.filter((s) => s.kind === 'ignored').map((s) => s.label);
  if (unused.length) parts.push(`Skipped ${unused.join(', ')} (couldn’t tell what ${unused.length === 1 ? 'it holds' : 'they hold'}).`);
  return parts.join(' ');
}

export type AutoDropResult =
  | { kind: 'review' }
  | { kind: 'nothing'; message: string }
  | { kind: 'applied'; workspace: Workspace; message: string };

/**
 * Add a drop without a review step when nothing needs deciding. Defaults:
 * commission paid about 30 days after close, best guesses on.
 */
export function autoDrop(files: readonly DroppedFile[], ws: Workspace, expectedPaymentDays = 30): AutoDropResult {
  const a = analyzeDrop(files, ws, { dateOrder: null, expectedPaymentDays });
  if (needsDecision(a)) return { kind: 'review' };
  const r = applyDrop(ws, a.sources);
  if (!r.deals && !r.payments) {
    const unused = a.sources.filter((s) => s.kind === 'ignored');
    return {
      kind: 'nothing',
      message: unused.length && unused.length === a.sources.length
        ? `Couldn’t tell what ${unused.length === 1 ? 'that file holds' : 'those files hold'}. Deals need an account, an amount, and a close date; paystubs need a commission line.`
        : 'Nothing new to add. Those deals and paychecks are already here.',
    };
  }
  return { kind: 'applied', workspace: r.workspace, message: dropMessage(a, r, expectedPaymentDays) };
}

/** Years of the deals' close dates, so the plan can be set up without asking. */
export function dealYears(files: readonly DroppedFile[]): number[] {
  const years = new Set<number>();
  for (const f of files) {
    if (!('tabs' in f)) continue;
    for (const tab of f.tabs) {
      const c = classifyTab(tab);
      if (!c || c.kind !== 'deals') continue;
      const col = c.mapping.closeDate;
      if (col === null || col === undefined) continue;
      for (const row of c.sheet.rows) {
        // Day/month order doesn't change the year.
        const p = parseFlexibleDate(row[col] ?? '', 'MDY');
        const q = p.ok ? p : parseFlexibleDate(row[col] ?? '', 'DMY');
        if (q.ok) years.add(Number(q.value.slice(0, 4)));
      }
    }
  }
  return [...years].sort((a, b) => a - b);
}
