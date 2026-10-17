import { useMemo, useState, type FormEvent } from 'react';
import { allocatedByPayment, calculateAll, sortDealsForCommission, suggestAllocations } from '../lib/calc';
import { formatDateLong, formatDateShort, isValidDate, todayLocal } from '../lib/dates';
import { centsToInput, D, formatCents, parseMoneyInput, sumCents } from '../lib/money';
import { deletePayment, OpError, savePayment, setPaymentAllocations } from '../lib/ops';
import type { Payment } from '../lib/types';
import { useStore } from '../state';
import { Field, FormError, Modal } from './ui';
import { SpreadsheetImportButton } from './SpreadsheetImport';

/**
 * Record or edit a payment and split it across deals in one step. For a new
 * payment the split is suggested (oldest due deals first) until the person
 * edits an amount themselves.
 */
function PaymentForm({ payment, onClose }: { payment?: Payment; onClose: () => void }) {
  const { ws, commit } = useStore();
  const [date, setDate] = useState(payment?.paymentDate ?? todayLocal());
  const [amount, setAmount] = useState(payment ? centsToInput(payment.amountCents) : '');
  const [reference, setReference] = useState(payment?.reference ?? '');
  const [notes, setNotes] = useState(payment?.notes ?? '');
  const [edited, setEdited] = useState<Record<string, string> | null>(() => {
    const existing = payment ? ws.allocations.filter((a) => a.paymentId === payment.id) : [];
    return existing.length ? Object.fromEntries(existing.map((a) => [a.dealId, centsToInput(a.amountCents)])) : null;
  });
  const [notesOpen] = useState(() => !!payment?.notes);
  const [filter, setFilter] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const calcs = useMemo(() => calculateAll(ws), [ws]);
  const plansById = new Map(ws.plans.map((p) => [p.id, p]));
  const dateOk = isValidDate(date);
  const parsedAmount = parseMoneyInput(amount, 'Gross commission amount');
  const amountKey = parsedAmount.ok ? parsedAmount.value : '0';
  const amountCents = new D(amountKey);

  // Until the person types a deal amount, show the suggested split.
  const suggested = useMemo(
    () => (edited || !dateOk ? null : suggestAllocations(ws, date, new D(amountKey), payment?.id)),
    [edited, dateOk, ws, date, amountKey, payment?.id],
  );
  const amounts: Record<string, string> =
    edited ?? Object.fromEntries([...(suggested ?? new Map())].map(([id, cents]) => [id, centsToInput(cents.toFixed(0))]));

  const eligible = dateOk ? sortDealsForCommission(ws.deals.filter((d) => d.closeDate <= date)).reverse() : [];
  const eligibleIds = new Set(eligible.map((d) => d.id));
  const ineligibleCount = ws.deals.length - eligible.length;
  const q = filter.trim().toLowerCase();
  const shown = eligible.filter((d) => !q || d.account.toLowerCase().includes(q) || d.reference.toLowerCase().includes(q) || amounts[d.id]);

  const fromOthers = new Map<string, InstanceType<typeof D>>();
  for (const a of ws.allocations) {
    if (a.paymentId === payment?.id) continue;
    fromOthers.set(a.dealId, (fromOthers.get(a.dealId) ?? new D(0)).plus(a.amountCents));
  }

  const parsed = Object.entries(amounts)
    .filter(([dealId, v]) => eligibleIds.has(dealId) && v.trim() !== '')
    .map(([dealId, v]) => ({ dealId, result: parseMoneyInput(v, 'Amount') }));
  const invalid = parsed.filter((p) => !p.result.ok);
  const total = sumCents(parsed.filter((p) => p.result.ok).map((p) => (p.result as { value: string }).value));
  const remaining = amountCents.minus(total);
  const over = remaining.lt(0);

  function setDealAmount(dealId: string, value: string) {
    setEdited({ ...amounts, [dealId]: value });
  }

  function fill(dealId: string) {
    const current = amounts[dealId] ? parseMoneyInput(amounts[dealId]) : null;
    const currentCents = current && current.ok ? new D(current.value) : new D(0);
    const outstanding = D.max(calcs.get(dealId)!.expectedCents.minus(fromOthers.get(dealId) ?? 0), 0);
    const value = D.min(outstanding, remaining.plus(currentCents));
    setDealAmount(dealId, value.gt(0) ? centsToInput(value.toFixed(0)) : '');
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const errs: Record<string, string> = {};
    if (!dateOk) errs.date = 'Enter the date the payment was made.';
    if (!parsedAmount.ok) errs.amount = parsedAmount.error;
    setErrors(errs);
    if (Object.keys(errs).length) {
      setFormError('Please fix the highlighted fields.');
      return;
    }
    if (invalid.length) {
      const deal = ws.deals.find((d) => d.id === invalid[0].dealId)!;
      setFormError(`${deal.account}: ${(invalid[0].result as { error: string }).error}`);
      return;
    }
    let next;
    try {
      // Clear this payment's old split first so a lower amount or earlier date can be saved with its new split.
      const cleared = payment ? setPaymentAllocations(ws, payment.id, []) : ws;
      const saved = savePayment(cleared, {
        id: payment?.id,
        paymentDate: date,
        amountCents: parsedAmount.ok ? parsedAmount.value : '0',
        reference: reference.trim(),
        notes,
      });
      next = setPaymentAllocations(
        saved.workspace,
        saved.paymentId,
        parsed.map((p) => ({ dealId: p.dealId, amountCents: (p.result as { value: string }).value })),
      );
    } catch (err) {
      setFormError(err instanceof OpError ? err.message : 'Something went wrong. Please try again.');
      return;
    }
    setSaving(true);
    try {
      await commit(next);
      onClose();
    } catch (err) {
      setFormError(`Not saved. ${(err as Error).message} Your entries are still here.`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={payment ? 'Edit payment' : 'Record a payment'} onClose={onClose} wide>
      <form onSubmit={onSubmit} noValidate>
        <FormError message={formError} />
        <div className="form-grid">
          <Field label="Payment date" error={errors.date}>
            {(p) => <input {...p} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}
          </Field>
          <Field label="Gross commission amount ($)" error={errors.amount} help="Before taxes or deductions, without base salary.">
            {(p) => <input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="2500" />}
          </Field>
        </div>
        <Field label="Statement or reference (optional)">
          {(p) => <input {...p} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. March commission statement" />}
        </Field>
        <details className="more-fields" open={notesOpen}>
          <summary>Add a note</summary>
          <Field label="Notes (optional)">{(p) => <textarea {...p} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field>
        </details>

        <h3 className="split-title">Which deals did this pay for?</h3>
        {ws.deals.length === 0 ? (
          <p className="muted">Add deals on the Overview to match payments to them. You can still save this payment now.</p>
        ) : eligible.length === 0 ? (
          <p className="muted">No deals close on or before this payment date yet.</p>
        ) : (
          <>
            <p className="muted small">
              {edited
                ? 'Adjust the amounts if the statement split it differently. Anything left stays unallocated.'
                : 'We filled in the oldest unpaid deals first. Adjust the amounts if the statement split it differently.'}
              {ineligibleCount > 0 && ` Deals that close after ${formatDateLong(date)} can’t receive this payment (${ineligibleCount} not shown).`}
            </p>
            <div className="alloc-summary" aria-live="polite">
              <div>
                <span className="muted">Payment</span> <strong className="num">{formatCents(amountCents)}</strong>
              </div>
              <div>
                <span className="muted">Matched to deals</span> <strong className="num">{formatCents(total)}</strong>
              </div>
              <div className={over ? 'over' : ''}>
                <span className="muted">{over ? 'Over by' : 'Left unallocated'}</span>{' '}
                <strong className="num" data-testid="alloc-remaining">
                  {formatCents(remaining.abs())}
                </strong>
              </div>
            </div>
            {over && (
              <p className="field-error" role="alert">
                Allocations can’t add up to more than the payment. Reduce an amount to continue.
              </p>
            )}
            {eligible.length > 6 && (
              <div className="field">
                <label htmlFor="alloc-filter">Find a deal</label>
                <input id="alloc-filter" type="search" value={filter} onChange={(e) => setFilter(e.target.value)} />
              </div>
            )}
            <ul className="alloc-list">
              {shown.map((d) => {
                const calc = calcs.get(d.id)!;
                const others = fromOthers.get(d.id) ?? new D(0);
                const inputId = `alloc-${d.id}`;
                return (
                  <li key={d.id} className="alloc-item">
                    <div className="alloc-info">
                      <label htmlFor={inputId} className="alloc-name">
                        {d.account}
                        {d.reference && <span className="muted small"> · {d.reference}</span>}
                      </label>
                      <span className="muted small">
                        {plansById.get(d.planId)?.year} plan · expected {formatCents(calc.expectedCents)}, due {formatDateShort(d.expectedPaymentDate)}
                        {others.gt(0) && <> · {formatCents(others)} from other payments</>}
                      </span>
                    </div>
                    <div className="alloc-input">
                      <span aria-hidden="true">$</span>
                      <input
                        id={inputId}
                        inputMode="decimal"
                        value={amounts[d.id] ?? ''}
                        onChange={(e) => setDealAmount(d.id, e.target.value)}
                        placeholder="0.00"
                      />
                      <button type="button" className="btn btn-small" onClick={() => fill(d.id)} aria-label={`Fill remaining for ${d.account}`}>
                        Fill
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        <div className="actions">
          <button type="submit" className="btn btn-primary" disabled={saving || over}>
            {saving ? 'Saving…' : payment ? 'Save changes' : 'Save payment'}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function PaymentsView() {
  const { ws, commit } = useStore();
  const [form, setForm] = useState<{ payment?: Payment } | null>(null);
  const [deleting, setDeleting] = useState<Payment | null>(null);
  const [error, setError] = useState<string | null>(null);

  const allocated = allocatedByPayment(ws);
  const dealsById = new Map(ws.deals.map((d) => [d.id, d]));
  const payments = [...ws.payments].sort((a, b) => b.paymentDate.localeCompare(a.paymentDate) || a.id.localeCompare(b.id));
  const totalUnallocated = sumCents(payments.map((p) => new D(p.amountCents).minus(allocated.get(p.id) ?? 0)));

  return (
    <section>
      <div className="section-head">
        <h1>Payments</h1>
        <div className="actions-inline">
          <button type="button" className="btn btn-primary" onClick={() => setForm({})}>
            Record payment
          </button>
          <SpreadsheetImportButton kind="payments" label="Import statement" />
        </div>
      </div>
      {totalUnallocated.gt(0) && (
        <div className="notice notice-amber" role="status">
          <p>
            <strong>{formatCents(totalUnallocated)} isn’t matched to deals yet.</strong> Edit a payment to say which deals it paid for.
          </p>
        </div>
      )}
      <FormError message={error} />
      {payments.length === 0 ? (
        <div className="empty panel">
          <p>No payments recorded yet. Record each commission payment as gross commission, before taxes or deductions.</p>
        </div>
      ) : (
        <ul className="payment-list">
          {payments.map((p) => {
            const alloc = allocated.get(p.id) ?? new D(0);
            const unalloc = new D(p.amountCents).minus(alloc);
            const allocs = ws.allocations.filter((a) => a.paymentId === p.id);
            return (
              <li key={p.id} className="panel payment-card" data-testid="payment-card">
                <div className="payment-head">
                  <div>
                    <h2 className="h3">
                      {formatDateLong(p.paymentDate)} · <span className="num">{formatCents(p.amountCents)}</span>
                    </h2>
                    {p.reference && <p className="muted">{p.reference}</p>}
                  </div>
                  <span className={`badge ${unalloc.gt(0) ? 'badge-partial' : 'badge-matched'}`}>
                    {unalloc.gt(0) ? `${formatCents(unalloc)} unallocated` : 'Fully allocated'}
                  </span>
                </div>
                {allocs.length > 0 && (
                  <ul className="alloc-mini">
                    {allocs.map((a) => (
                      <li key={a.id}>
                        {dealsById.get(a.dealId)?.account}: <span className="num">{formatCents(a.amountCents)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {p.notes && <p className="notes">{p.notes}</p>}
                <div className="actions-inline">
                  <button type="button" className={`btn btn-small${unalloc.gt(0) ? ' btn-primary' : ''}`} onClick={() => setForm({ payment: p })}>
                    {unalloc.gt(0) ? 'Match to deals' : 'Edit'}
                    <span className="sr-only"> payment from {formatDateLong(p.paymentDate)}</span>
                  </button>
                  <button type="button" className="btn btn-small btn-quiet" onClick={() => setDeleting(p)}>
                    Delete<span className="sr-only"> payment from {formatDateLong(p.paymentDate)}</span>
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {form && <PaymentForm payment={form.payment} onClose={() => setForm(null)} />}
      {deleting && (
        <Modal title="Delete this payment?" onClose={() => setDeleting(null)}>
          <p>
            The {formatCents(deleting.amountCents)} payment from {formatDateLong(deleting.paymentDate)} will be removed.
            {(allocated.get(deleting.id) ?? new D(0)).gt(0)
              ? ` Its ${formatCents(allocated.get(deleting.id)!)} in allocations will be removed too, and the affected deals will show less received.`
              : ''}{' '}
            This can’t be undone.
          </p>
          <div className="actions">
            <button
              type="button"
              className="btn btn-danger"
              onClick={async () => {
                setError(null);
                try {
                  await commit(deletePayment(ws, deleting.id));
                } catch (e) {
                  setError(`Not deleted. ${(e as Error).message}`);
                }
                setDeleting(null);
              }}
            >
              Delete payment
            </button>
            <button type="button" className="btn" onClick={() => setDeleting(null)} data-autofocus>
              Keep it
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
