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

type SortKey = 'commission' | 'account' | 'revenue' | 'close' | 'expectedDate' | 'expected' | 'received' | 'difference' | 'status';

const SORT_LABELS: Record<SortKey, string> = {
  commission: 'Commission order',
  account: 'Account',
  revenue: 'Credited revenue',
  close: 'Close date',
  expectedDate: 'Expected payment date',
  expected: 'Expected commission',
  received: 'Received',
  difference: 'Difference',
  status: 'Status',
};

const STATUS_ORDER: DealStatus[] = ['not_received', 'partial', 'due_today', 'more_than_expected', 'matched', 'received_early', 'upcoming'];

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
    case 'revenue':
      return a.revenueCents.cmp(b.revenueCents) || a.orderIndex - b.orderIndex;
    case 'close':
      return a.orderIndex - b.orderIndex;
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
  const [statusFilter, setStatusFilter] = useState<DealStatus | 'all' | 'review'>('all');
  const [sortKey, setSortKey] = useState<SortKey>('commission');
  const [sortDesc, setSortDesc] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [form, setForm] = useState<{ dealId?: string } | null>(null);
  const [inquiryOpen, setInquiryOpen] = useState(false);
  const [asOfDraft, setAsOfDraft] = useState(asOf);
  useEffect(() => setAsOfDraft(asOf), [asOf]);

  const rec = useMemo(() => reconcile(ws, year, asOf), [ws, year, asOf]);
  const { summary } = rec;
  const plan = rec.plan!;

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = rec.rows.filter((r) => {
      if (q && !r.deal.account.toLowerCase().includes(q) && !r.deal.reference.toLowerCase().includes(q)) return false;
      if (statusFilter === 'all') return true;
      if (statusFilter === 'review') return r.isDue && !r.differenceCents.isZero();
      return r.status === statusFilter;
    });
    const sorted = [...filtered].sort((a, b) => compareRows(a, b, sortKey));
    return sortDesc ? sorted.reverse() : sorted;
  }, [rec.rows, search, statusFilter, sortKey, sortDesc]);

  const reviewRows = rec.rows.filter((r) => r.isDue && !r.differenceCents.isZero());
  const detail = detailId ? rec.rows.find((r) => r.deal.id === detailId) ?? null : null;
  const asOfLabel = formatDateLong(asOf);
  const isToday = asOf === todayLocal();

  function commitAsOf(value: string) {
    setAsOfDraft(value);
    if (isValidDate(value)) onAsOf(value);
  }

  return (
    <section aria-labelledby="overview-title">
      <h1 id="overview-title" className="sr-only">
        Overview
      </h1>
      <div className="controls panel">
        <div className="control">
          <label htmlFor="plan-year">Plan year</label>
          <select id="plan-year" value={year} onChange={(e) => onYear(Number(e.target.value))}>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
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
        <div className="control control-help">
          <p id="as-of-help" className="help">
            {mode === 'demo' && asOf === DEMO_AS_OF ? (
              <>
                <strong>Example date:</strong> {asOfLabel}.{' '}
              </>
            ) : isToday ? (
              <>Showing today, {asOfLabel}. </>
            ) : (
              <>Showing {asOfLabel}. </>
            )}
            A commission expected after this date isn’t counted as missing.
          </p>
          {!isToday && (
            <button type="button" className="link-btn" onClick={() => commitAsOf(todayLocal())}>
              Use today
            </button>
          )}
        </div>
      </div>

      {summary.provisional && (
        <div className="notice notice-amber" role="status">
          <p>
            <strong>Allocate payments to finish the comparison.</strong> {formatCents(summary.unallocatedCents)} in payments received by{' '}
            {asOfLabel} isn’t matched to deals yet. Until it is, the comparison below is provisional. We don’t subtract unallocated money
            from any deal.
          </p>
          <button type="button" className="btn btn-small" onClick={onGoToPayments}>
            Allocate payments
          </button>
        </div>
      )}

      <div className="cards" aria-label="Summary">
        <div className="card">
          <h2 className="card-label">Expected by {asOfLabel}</h2>
          <p className="card-value num" data-testid="expected-due">
            {formatCents(summary.expectedDueCents)}
          </p>
          <p className="card-note">
            {summary.dueDealCount} {summary.dueDealCount === 1 ? 'deal' : 'deals'} with an expected payment date on or before this date
          </p>
        </div>
        <div className="card">
          <h2 className="card-label">Received toward that amount</h2>
          <p className="card-value num" data-testid="received-due">
            {formatCents(summary.receivedDueCents)}
          </p>
          <p className="card-note">Payments received by this date and allocated to those deals</p>
        </div>
        <div className={`card card-diff${summary.differenceCents.gt(0) ? ' is-short' : summary.differenceCents.lt(0) ? ' is-excess' : ''}`}>
          <h2 className="card-label">
            Difference to review {summary.provisional && <span className="tag">Provisional</span>}
          </h2>
          <p className="card-value num" data-testid="difference">
            {formatCents(summary.differenceCents, { signed: summary.differenceCents.lt(0) })}
          </p>
          <p className="card-note">
            {summary.differenceCents.gt(0)
              ? 'Expected but not yet matched by payments'
              : summary.differenceCents.lt(0)
                ? 'More received than expected'
                : reviewRows.length
                  ? 'Nets to zero, but some deals differ'
                  : 'Everything due is matched'}
          </p>
        </div>
      </div>

      {reviewRows.length > 0 && (
        <div className="explain panel" data-testid="difference-explainer">
          <h2 className="h3">What makes up the difference</h2>
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

      <div className="section-head">
        <h2>Deals in {year}</h2>
        <div className="actions-inline">
          <button type="button" className="btn btn-primary" onClick={() => setForm({})}>
            Add deal
          </button>
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
          <p>No deals in {year} yet. Add your first deal to see its expected commission.</p>
        </div>
      ) : (
        <>
          <div className="table-tools">
            <div className="control">
              <label htmlFor="deal-search">Search accounts</label>
              <input id="deal-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Account or reference" />
            </div>
            <div className="control">
              <label htmlFor="status-filter">Status</label>
              <select id="status-filter" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}>
                <option value="all">All deals</option>
                <option value="review">Needs review</option>
                {(Object.keys(STATUS_LABELS) as DealStatus[]).map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
            <div className="control">
              <label htmlFor="sort-by">Sort by</label>
              <div className="sort-row">
                <select id="sort-by" value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
                  {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
                    <option key={k} value={k}>
                      {SORT_LABELS[k]}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => setSortDesc((d) => !d)}
                  aria-label={sortDesc ? 'Sorted descending. Switch to ascending' : 'Sorted ascending. Switch to descending'}
                >
                  {sortDesc ? '↓ Desc' : '↑ Asc'}
                </button>
              </div>
            </div>
          </div>
          <p className="muted small" aria-live="polite">
            Showing {rows.length} of {rec.rows.length} deals.
          </p>
          <table className="deal-table">
            <caption className="sr-only">Deals in {year} as of {asOfLabel}</caption>
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col" className="r">
                  Credited revenue
                </th>
                <th scope="col">Close date</th>
                <th scope="col">Expected payment</th>
                <th scope="col" className="r">
                  Expected commission
                </th>
                <th scope="col" className="r">
                  Received by {formatDateShort(asOf)}
                </th>
                <th scope="col" className="r">
                  Difference
                </th>
                <th scope="col">Status</th>
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
                  <td data-label="Credited revenue" className="r num">
                    {formatCents(r.revenueCents)}
                  </td>
                  <td data-label="Close date">{formatDateShort(r.deal.closeDate)}</td>
                  <td data-label="Expected payment">{formatDateShort(r.deal.expectedPaymentDate)}</td>
                  <td data-label="Expected commission" className="r num">
                    {formatCents(r.expectedCents)}
                  </td>
                  <td data-label="Received" className="r num">
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
            Difference is expected commission minus payments received by the as-of date. A plus sign means money still expected; a minus sign
            means more was received than expected.
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
