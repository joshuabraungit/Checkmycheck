import { useEffect, useMemo, useState } from 'react';
import { reconcile, STATUS_LABELS, type DealReconciliation, type DealStatus } from '../lib/calc';
import { reconciliationToCsv } from '../lib/csv';
import { formatDateLong, formatDateShort, isValidDate, todayLocal } from '../lib/dates';
import { DEMO_AS_OF } from '../lib/demo';
import { formatCents, type Dec } from '../lib/money';
import { useStore } from '../state';
import { DealDetail } from './DealDetail';
import { DealForm } from './DealForm';
import { InquiryDialog } from './InquiryDialog';
import { downloadText } from './ui';
import { SpreadsheetImportButton } from './SpreadsheetImport';

type SortKey = 'commission' | 'account' | 'expectedDate' | 'expected' | 'received' | 'difference' | 'status';

const STATUS_ORDER: DealStatus[] = ['not_received', 'partial', 'due_today', 'more_than_expected', 'matched', 'received_early', 'upcoming'];

/** Show a search box only once the list is long enough to need one. */
const SEARCH_THRESHOLD = 8;

export function StatusBadge({ status }: { status: DealStatus }) {
  return <span className={`badge badge-${status}`}>{STATUS_LABELS[status]}</span>;
}

/** Signed difference. Deals not yet due are shown in neutral text, since nothing is missing yet. */
export function SignedDifference({ cents, due = true }: { cents: Dec; due?: boolean }) {
  if (cents.isZero()) return <span className="num">$0.00</span>;
  const positive = cents.gt(0);
  const tone = !due ? 'diff-later' : positive ? 'diff-short' : 'diff-excess';
  return (
    <span className={`num diff ${tone}`}>
      {formatCents(cents, { signed: true })}
      <span className="sr-only">{!due && positive ? ' expected later' : positive ? ' still expected' : ' more than expected'}</span>
    </span>
  );
}

function compareRows(a: DealReconciliation, b: DealReconciliation, key: SortKey): number {
  switch (key) {
    case 'commission':
      return a.orderIndex - b.orderIndex;
    case 'account':
      return a.deal.account.localeCompare(b.deal.account, undefined, { sensitivity: 'base' }) || a.orderIndex - b.orderIndex;
    case 'expectedDate':
      return a.deal.expectedPaymentDate.localeCompare(b.deal.expectedPaymentDate) || a.orderIndex - b.orderIndex;
    case 'expected':
      return a.expectedCents.cmp(b.expectedCents) || a.orderIndex - b.orderIndex;
    case 'received':
      return a.receivedAsOfCents.cmp(b.receivedAsOfCents) || a.orderIndex - b.orderIndex;
    case 'difference':
      return a.differenceCents.cmp(b.differenceCents) || a.orderIndex - b.orderIndex;
    case 'status':
      return STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.orderIndex - b.orderIndex;
  }
}

function SortHeader({
  label,
  sortKey,
  current,
  desc,
  onSort,
  right = false,
}: {
  label: string;
  sortKey: SortKey;
  current: SortKey;
  desc: boolean;
  onSort: (key: SortKey) => void;
  right?: boolean;
}) {
  const active = current === sortKey;
  return (
    <th scope="col" className={right ? 'r' : undefined} aria-sort={active ? (desc ? 'descending' : 'ascending') : undefined}>
      <button type="button" className={`sort-btn${active ? ' active' : ''}`} onClick={() => onSort(sortKey)}>
        {label}
        <span aria-hidden="true" className="sort-arrow">
          {active ? (desc ? '↓' : '↑') : '↕'}
        </span>
      </button>
    </th>
  );
}

function plural(n: number, word: string) {
  return `${n} ${n === 1 ? word : `${word}s`}`;
}

interface Props {
  year: number;
  years: number[];
  onYear: (y: number) => void;
  asOf: string;
  onAsOf: (d: string) => void;
  onGoToPayments: () => void;
}

export function Dashboard({ year, years, onYear, asOf, onAsOf, onGoToPayments }: Props) {
  const { ws, mode } = useStore();
  const [search, setSearch] = useState('');
  const [reviewOnly, setReviewOnly] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('commission');
  const [sortDesc, setSortDesc] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [form, setForm] = useState<{ dealId?: string } | null>(null);
  const [inquiryOpen, setInquiryOpen] = useState(false);
  const [asOfDraft, setAsOfDraft] = useState(asOf);
  const [showDate, setShowDate] = useState(() => asOf !== todayLocal());
  useEffect(() => setAsOfDraft(asOf), [asOf]);

  const rec = useMemo(() => reconcile(ws, year, asOf), [ws, year, asOf]);
  const { summary } = rec;
  const plan = rec.plan!;

  const reviewRows = rec.rows.filter((r) => r.isDue && !r.differenceCents.isZero());
  const filtering = reviewOnly && reviewRows.length > 0;

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = rec.rows.filter((r) => {
      if (q && !r.deal.account.toLowerCase().includes(q) && !r.deal.reference.toLowerCase().includes(q)) return false;
      return !filtering || (r.isDue && !r.differenceCents.isZero());
    });
    const sorted = [...filtered].sort((a, b) => compareRows(a, b, sortKey));
    return sortDesc ? sorted.reverse() : sorted;
  }, [rec.rows, search, filtering, sortKey, sortDesc]);

  const detail = detailId ? rec.rows.find((r) => r.deal.id === detailId) ?? null : null;
  const asOfLabel = formatDateLong(asOf);
  const isToday = asOf === todayLocal();
  const diff = summary.differenceCents;
  const shortRows = reviewRows.filter((r) => r.differenceCents.gt(0));

  function commitAsOf(value: string) {
    setAsOfDraft(value);
    if (isValidDate(value)) onAsOf(value);
  }

  function onSort(key: SortKey) {
    if (key === sortKey) setSortDesc((d) => !d);
    else {
      setSortKey(key);
      setSortDesc(false);
    }
  }

  const amount = (
    <span className="num" data-testid="difference">
      {formatCents(diff.abs())}
    </span>
  );
  let headline;
  if (summary.dueDealCount === 0) headline = <>Nothing is due yet</>;
  else if (diff.gt(0)) headline = <>You may be owed {amount}</>;
  else if (diff.lt(0)) headline = <>You received {amount} more than expected</>;
  else if (reviewRows.length) headline = <>It nets out to {amount}, but some deals don’t match</>;
  else headline = <>Everything due has been paid</>;

  return (
    <section aria-labelledby="overview-title">
      <h1 id="overview-title" className="sr-only">
        Overview
      </h1>

      {summary.provisional && (
        <div className="notice notice-amber" role="status">
          <p>
            <strong>Match your payments to deals to finish the comparison.</strong> {formatCents(summary.unallocatedCents)} received by{' '}
            {asOfLabel} isn’t matched to deals yet, so the numbers below are provisional.
          </p>
          <button type="button" className="btn btn-small" onClick={onGoToPayments}>
            Match payments
          </button>
        </div>
      )}

      <div className={`hero panel${summary.dueDealCount && diff.gt(0) ? ' is-short' : ''}`}>
        <div className="hero-date">
          {years.length > 1 && (
            <>
              <label htmlFor="plan-year" className="sr-only">
                Plan year
              </label>
              <select id="plan-year" className="year-select" value={year} onChange={(e) => onYear(Number(e.target.value))}>
                {years.map((y) => (
                  <option key={y} value={y}>
                    {y} plan
                  </option>
                ))}
              </select>
            </>
          )}
          <span>
            {mode === 'demo' && asOf === DEMO_AS_OF ? `As of the example date, ${asOfLabel}` : isToday ? `As of today, ${asOfLabel}` : `As of ${asOfLabel}`}
          </span>
          {!showDate && (
            <button type="button" className="link-btn" onClick={() => setShowDate(true)}>
              Change date
            </button>
          )}
        </div>
        {showDate && (
          <div className="date-controls">
            <div className="control">
              <label htmlFor="as-of">As of</label>
              <input
                id="as-of"
                type="date"
                value={asOfDraft}
                onChange={(e) => commitAsOf(e.target.value)}
                onBlur={() => !isValidDate(asOfDraft) && setAsOfDraft(asOf)}
                aria-describedby="as-of-help"
              />
            </div>
            <p id="as-of-help" className="help">
              A commission expected after this date isn’t counted as missing.{' '}
              {!isToday && (
                <button type="button" className="link-btn" onClick={() => commitAsOf(todayLocal())}>
                  Use today
                </button>
              )}
            </p>
          </div>
        )}

        <h2 className="hero-title">
          {headline}
          {summary.provisional && <span className="tag">Provisional</span>}
        </h2>
        {summary.dueDealCount > 0 && (
          <p className="hero-sub">
            Expected{' '}
            <strong className="num" data-testid="expected-due">
              {formatCents(summary.expectedDueCents)}
            </strong>{' '}
            and received{' '}
            <strong className="num" data-testid="received-due">
              {formatCents(summary.receivedDueCents)}
            </strong>{' '}
            on {plural(summary.dueDealCount, 'deal')} due by {formatDateShort(asOf)}.
            {summary.expectedLaterCents.gt(0) && <> {formatCents(summary.expectedLaterCents)} more is expected later.</>}
          </p>
        )}

        {reviewRows.length > 0 && (
          <div className="explain" data-testid="difference-explainer">
            <h3 className="h3">{shortRows.length === reviewRows.length ? `Short on ${plural(reviewRows.length, 'deal')}` : 'Deals that don’t match'}</h3>
            <ul className="explain-list">
              {reviewRows.map((r) => (
                <li key={r.deal.id}>
                  <button type="button" className="link-btn" onClick={() => setDetailId(r.deal.id)}>
                    {r.deal.account}
                  </button>
                  : <SignedDifference cents={r.differenceCents} /> <span className="muted">({STATUS_LABELS[r.status].toLowerCase()})</span>
                </li>
              ))}
            </ul>
            <div className="actions">
              <button type="button" className="btn" onClick={() => setInquiryOpen(true)}>
                Draft a payroll question
              </button>
            </div>
          </div>
        )}
      </div>

      <details className="more-numbers">
        <summary>Show all the numbers</summary>
        <dl className="stats">
          <div>
            <dt>Expected later</dt>
            <dd className="num">{formatCents(summary.expectedLaterCents)}</dd>
          </div>
          <div>
            <dt>Received early toward future commissions</dt>
            <dd className="num">{formatCents(summary.receivedEarlyCents)}</dd>
          </div>
          <div>
            <dt>Unallocated payments</dt>
            <dd className="num">{formatCents(summary.unallocatedCents)}</dd>
          </div>
          <div>
            <dt>
              Payments received in {year} through {formatDateShort(asOf)}
            </dt>
            <dd className="num">{formatCents(summary.paymentsInYearCents)}</dd>
          </div>
          <div>
            <dt>Total still expected on due deals</dt>
            <dd className="num">{formatCents(summary.positiveDiscrepanciesCents)}</dd>
          </div>
          <div>
            <dt>Total excess receipts on due deals</dt>
            <dd className="num">{formatCents(summary.excessReceiptsCents)}</dd>
          </div>
        </dl>
        <p className="scope-note muted">
          The commission comparison follows deals in the {year} plan, wherever their payments land. The payment-year total follows actual
          payment dates, so a January payment for a December deal counts in the year it was paid. Shortfalls and excess receipts are totaled
          separately so one deal can’t hide another.
        </p>
      </details>

      <div className="section-head">
        <h2>Deals in {year}</h2>
        <div className="actions-inline">
          <button type="button" className="btn btn-primary" onClick={() => setForm({})}>
            Add deal
          </button>
          <SpreadsheetImportButton kind="deals" label="Import from spreadsheet" />
          <button
            type="button"
            className="btn"
            onClick={() => downloadText(`reconciliation-${year}-as-of-${asOf}.csv`, reconciliationToCsv(rec.rows, asOf, year))}
            disabled={!rec.rows.length}
          >
            Export report
          </button>
        </div>
      </div>

      {rec.rows.length === 0 ? (
        <div className="empty panel">
          <p>No deals in {year} yet. Add your first deal to see its expected commission, or import a CSV or Excel export from your CRM.</p>
        </div>
      ) : (
        <>
          {(reviewRows.length > 0 || rec.rows.length > SEARCH_THRESHOLD) && (
            <div className="table-tools">
              {reviewRows.length > 0 && (
                <div className="segmented" role="group" aria-label="Show">
                  <button type="button" aria-pressed={!filtering} onClick={() => setReviewOnly(false)}>
                    All deals ({rec.rows.length})
                  </button>
                  <button type="button" aria-pressed={filtering} onClick={() => setReviewOnly(true)}>
                    Needs review ({reviewRows.length})
                  </button>
                </div>
              )}
              {rec.rows.length > SEARCH_THRESHOLD && (
                <div className="search">
                  <label htmlFor="deal-search" className="sr-only">
                    Search accounts
                  </label>
                  <input id="deal-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search accounts" />
                </div>
              )}
            </div>
          )}
          {rows.length !== rec.rows.length && (
            <p className="muted small" aria-live="polite">
              Showing {rows.length} of {rec.rows.length} deals.
            </p>
          )}
          <table className="deal-table">
            <caption className="sr-only">
              Deals in {year} as of {asOfLabel}. Select a column heading to sort.
            </caption>
            <thead>
              <tr>
                <SortHeader label="Account" sortKey="account" current={sortKey} desc={sortDesc} onSort={onSort} />
                <SortHeader label="Due" sortKey="expectedDate" current={sortKey} desc={sortDesc} onSort={onSort} />
                <SortHeader label="Expected" sortKey="expected" current={sortKey} desc={sortDesc} onSort={onSort} right />
                <SortHeader label="Received" sortKey="received" current={sortKey} desc={sortDesc} onSort={onSort} right />
                <SortHeader label="Difference" sortKey="difference" current={sortKey} desc={sortDesc} onSort={onSort} right />
                <SortHeader label="Status" sortKey="status" current={sortKey} desc={sortDesc} onSort={onSort} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.deal.id} data-testid={`deal-row-${r.deal.account}`}>
                  <th scope="row" data-label="Account">
                    <button
                      type="button"
                      className="link-btn account-btn"
                      onClick={() => setDetailId(r.deal.id)}
                      aria-label={`${r.deal.account}, view calculation`}
                    >
                      {r.deal.account}
                    </button>
                    {r.deal.reference && <span className="muted small ref">{r.deal.reference}</span>}
                  </th>
                  <td data-label="Expected payment">{formatDateShort(r.deal.expectedPaymentDate)}</td>
                  <td data-label="Expected commission" className="r num">
                    {formatCents(r.expectedCents)}
                  </td>
                  <td data-label={`Received by ${formatDateShort(asOf)}`} className="r num">
                    {formatCents(r.receivedAsOfCents)}
                  </td>
                  <td data-label="Difference" className="r">
                    <SignedDifference cents={r.differenceCents} due={r.isDue} />
                  </td>
                  <td data-label="Status">
                    <StatusBadge status={r.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">
            Difference is expected commission minus what’s been received. Select an account to see its revenue, close date, and the math.
          </p>
        </>
      )}

      {detail && (
        <DealDetail
          row={detail}
          asOf={asOf}
          onClose={() => setDetailId(null)}
          onEdit={() => {
            setDetailId(null);
            setForm({ dealId: detail.deal.id });
          }}
        />
      )}
      {form && <DealForm dealId={form.dealId} defaultPlanId={plan.id} onClose={() => setForm(null)} />}
      {inquiryOpen && (
        <InquiryDialog rows={reviewRows} asOf={asOf} unallocatedCents={summary.unallocatedCents} onClose={() => setInquiryOpen(false)} />
      )}
    </section>
  );
}
