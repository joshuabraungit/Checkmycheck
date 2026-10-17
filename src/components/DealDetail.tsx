import { useState } from 'react';
import { compareExpected, sortDealsForCommission, type DealReconciliation } from '../lib/calc';
import { formatDateLong, formatDateShort } from '../lib/dates';
import { formatCents, formatPercent, sumCents } from '../lib/money';
import { deleteDeal, moveDealSameDay } from '../lib/ops';
import type { Workspace } from '../lib/types';
import { useStore } from '../state';
import { SignedDifference, StatusBadge } from './Dashboard';
import { DealImpact } from './DealImpact';
import { FormError, Modal } from './ui';

type Pending = { kind: 'delete' | 'move'; next: Workspace; label: string };

export function DealDetail({ row, asOf, onClose, onEdit }: { row: DealReconciliation; asOf: string; onClose: () => void; onEdit: () => void }) {
  const { ws, commit } = useStore();
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { deal, plan } = row;

  const sameDay = sortDealsForCommission(ws.deals.filter((d) => d.planId === deal.planId && d.closeDate === deal.closeDate));
  const sameDayIndex = sameDay.findIndex((d) => d.id === deal.id);
  const allocatedTotal = sumCents(row.allocations.map((a) => a.allocation.amountCents));
  const notYetCounted = row.allocations.filter((a) => !a.counted);

  async function confirm() {
    if (!pending) return;
    setSaving(true);
    setError(null);
    try {
      await commit(pending.next);
      if (pending.kind === 'delete') onClose();
      setPending(null);
    } catch (e) {
      setError(`Not saved. ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  if (pending) {
    const impact = compareExpected(ws, pending.next, [plan.id], [deal.id]);
    const sourcePayments = new Set(row.allocations.map((a) => a.payment.id)).size;
    return (
      <Modal title={pending.kind === 'delete' ? `Delete ${deal.account}?` : 'Change same-day order?'} onClose={() => setPending(null)} wide>
        {pending.kind === 'delete' ? (
          <>
            <p>Deleting this deal can’t be undone. Here’s what happens:</p>
            <ul>
              <li>Expected commissions for the rest of {plan.year} are recalculated without it.</li>
              {row.allocations.length > 0 ? (
                <li>
                  {formatCents(allocatedTotal)} allocated to it returns to the unallocated balance of {sourcePayments}{' '}
                  {sourcePayments === 1 ? 'payment' : 'payments'}. The payments themselves stay.
                </li>
              ) : (
                <li>No payments are allocated to it, so no payments are affected.</li>
              )}
            </ul>
          </>
        ) : (
          <p>{pending.label}</p>
        )}
        <DealImpact before={ws} after={pending.next} impact={impact} year={plan.year} />
        <FormError message={error} />
        <div className="actions">
          <button type="button" className={`btn ${pending.kind === 'delete' ? 'btn-danger' : 'btn-primary'}`} disabled={saving} onClick={() => void confirm()}>
            {pending.kind === 'delete' ? 'Delete deal' : 'Save new order'}
          </button>
          <button type="button" className="btn" onClick={() => setPending(null)} data-autofocus>
            Cancel
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={deal.account} onClose={onClose} wide>
      <div className="detail-head">
        <StatusBadge status={row.status} />
        <span className="muted">As of {formatDateLong(asOf)}</span>
      </div>
      <dl className="kv">
        {deal.reference && (
          <div>
            <dt>Employer deal reference</dt>
            <dd>{deal.reference}</dd>
          </div>
        )}
        <div>
          <dt>Credited revenue</dt>
          <dd className="num">{formatCents(row.revenueCents)}</dd>
        </div>
        <div>
          <dt>Close date</dt>
          <dd>{formatDateLong(deal.closeDate)}</dd>
        </div>
        <div>
          <dt>Expected payment date</dt>
          <dd>{formatDateLong(deal.expectedPaymentDate)}</dd>
        </div>
      </dl>
      {deal.notes && <p className="notes">{deal.notes}</p>}

      <h3>How the expected commission is calculated</h3>
      <table className="calc-table">
        <tbody>
          <tr>
            <th scope="row">Credited revenue in {plan.year} before this deal</th>
            <td className="num r">{formatCents(row.cumulativeBeforeCents)}</td>
          </tr>
          <tr>
            <th scope="row">Credited revenue after this deal</th>
            <td className="num r">{formatCents(row.cumulativeAfterCents)}</td>
          </tr>
          <tr>
            <th scope="row">Annual quota</th>
            <td className="num r">{formatCents(plan.annualQuotaCents)}</td>
          </tr>
          <tr>
            <th scope="row">
              Revenue at the base rate ({formatCents(row.basePortionCents)} × {formatPercent(plan.baseRate)})
            </th>
            <td className="num r">{formatCents(row.baseComponentRounded)}</td>
          </tr>
          <tr>
            <th scope="row">
              {plan.acceleratorRate ? (
                <>
                  Revenue at the accelerator rate ({formatCents(row.acceleratedPortionCents)} × {formatPercent(plan.acceleratorRate)})
                </>
              ) : (
                <>Revenue at an accelerator rate (this plan has none)</>
              )}
            </th>
            <td className="num r">{formatCents(row.acceleratedComponentRounded)}</td>
          </tr>
          <tr className="total-row">
            <th scope="row">Expected commission</th>
            <td className="num r">{formatCents(row.expectedCents)}</td>
          </tr>
        </tbody>
      </table>
      {!row.roundingAdjustmentCents.isZero() && (
        <p className="muted small" data-testid="rounding-note">
          The two parts above are each shown rounded to the cent. The commission is rounded once, on the unrounded total, so it differs from
          their sum by {formatCents(row.roundingAdjustmentCents.abs())}.
        </p>
      )}

      <h3>Payments allocated to this deal</h3>
      {row.allocations.length === 0 ? (
        <p className="muted">No payments are allocated to this deal yet. Allocate from the Payments section.</p>
      ) : (
        <table className="calc-table">
          <tbody>
            {row.allocations.map((a) => (
              <tr key={a.allocation.id}>
                <th scope="row">
                  {formatDateShort(a.payment.paymentDate)}
                  {a.payment.reference && <span className="muted"> · {a.payment.reference}</span>}
                  {!a.counted && <span className="tag">After as-of date, not counted yet</span>}
                </th>
                <td className="num r">{formatCents(a.allocation.amountCents)}</td>
              </tr>
            ))}
            <tr className="total-row">
              <th scope="row">Received by {formatDateShort(asOf)}</th>
              <td className="num r">{formatCents(row.receivedAsOfCents)}</td>
            </tr>
          </tbody>
        </table>
      )}
      {notYetCounted.length > 0 && (
        <p className="muted small">Payments dated after the as-of date are listed but not counted in the difference.</p>
      )}
      <p className="remaining">
        Remaining difference: <SignedDifference cents={row.differenceCents} due={row.isDue} />{' '}
        <span className="muted small">
          {row.differenceCents.gt(0) ? (row.isDue ? '(still expected)' : '(expected later)') : row.differenceCents.lt(0) ? '(more received than expected)' : '(matched)'}
        </span>
      </p>
      {!row.isDue && <p className="muted small">This commission isn’t expected until {formatDateLong(deal.expectedPaymentDate)}, so it isn’t counted as missing yet.</p>}

      {sameDay.length > 1 && (
        <div className="same-day">
          <h3>Same-day order</h3>
          <p className="muted small">
            For deals closing on the same date, order can change which deal receives accelerator credit. This deal is{' '}
            {sameDayIndex + 1} of {sameDay.length} on {formatDateShort(deal.closeDate)}.
          </p>
          <div className="actions-inline">
            <button
              type="button"
              className="btn btn-small"
              disabled={sameDayIndex === 0}
              onClick={() =>
                setPending({ kind: 'move', next: moveDealSameDay(ws, deal.id, -1), label: `Move ${deal.account} earlier among deals closing ${formatDateShort(deal.closeDate)}.` })
              }
            >
              Move earlier
            </button>
            <button
              type="button"
              className="btn btn-small"
              disabled={sameDayIndex === sameDay.length - 1}
              onClick={() =>
                setPending({ kind: 'move', next: moveDealSameDay(ws, deal.id, 1), label: `Move ${deal.account} later among deals closing ${formatDateShort(deal.closeDate)}.` })
              }
            >
              Move later
            </button>
          </div>
        </div>
      )}

      <FormError message={error} />
      <div className="actions">
        <button type="button" className="btn btn-primary" onClick={onEdit}>
          Edit deal
        </button>
        <button type="button" className="btn btn-quiet" onClick={() => setPending({ kind: 'delete', next: deleteDeal(ws, deal.id), label: '' })}>
          Delete deal
        </button>
      </div>
    </Modal>
  );
}
