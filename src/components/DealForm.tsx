import { useState, type FormEvent } from 'react';
import { compareExpected, type ImpactSummary } from '../lib/calc';
import { centsToInput, parseMoneyInput } from '../lib/money';
import { OpError, saveDeal } from '../lib/ops';
import type { Workspace } from '../lib/types';
import { isValidDate, yearOf } from '../lib/dates';
import { hasVisibleText } from '../lib/validate';
import { useStore } from '../state';
import { DealImpact } from './DealImpact';
import { Field, FormError, Modal } from './ui';

export function DealForm({ dealId, defaultPlanId, onClose }: { dealId?: string; defaultPlanId: string; onClose: () => void }) {
  const { ws, commit } = useStore();
  const existing = dealId ? ws.deals.find((d) => d.id === dealId) : undefined;
  const [planId, setPlanId] = useState(existing?.planId ?? defaultPlanId);
  const [account, setAccount] = useState(existing?.account ?? '');
  const [reference, setReference] = useState(existing?.reference ?? '');
  const [revenue, setRevenue] = useState(existing ? centsToInput(existing.creditedRevenueCents) : '');
  const [closeDate, setCloseDate] = useState(existing?.closeDate ?? '');
  const [expectedDate, setExpectedDate] = useState(existing?.expectedPaymentDate ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ next: Workspace; impact: ImpactSummary } | null>(null);
  const [saving, setSaving] = useState(false);

  const plan = ws.plans.find((p) => p.id === planId);

  function validate(): Workspace | null {
    const errs: Record<string, string> = {};
    if (!hasVisibleText(account)) errs.account = 'Enter the account name.';
    const rev = parseMoneyInput(revenue, 'Credited revenue');
    if (!rev.ok) errs.revenue = rev.error;
    if (!isValidDate(closeDate)) errs.closeDate = 'Enter the close date.';
    else if (plan && yearOf(closeDate) !== plan.year) errs.closeDate = `Close date must be in ${plan.year} to count toward this plan.`;
    if (!isValidDate(expectedDate)) errs.expectedDate = 'Enter when you expect this commission to be paid.';
    else if (isValidDate(closeDate) && expectedDate < closeDate) errs.expectedDate = 'Expected payment date must be on or after the close date.';
    setErrors(errs);
    if (Object.keys(errs).length) {
      setFormError('Please fix the highlighted fields.');
      return null;
    }
    try {
      return saveDeal(ws, {
        id: existing?.id,
        planId,
        account,
        reference: reference.trim(),
        creditedRevenueCents: (rev as { value: string }).value,
        closeDate,
        expectedPaymentDate: expectedDate,
        notes,
      }).workspace;
    } catch (e) {
      setFormError(e instanceof OpError ? e.message : 'Something went wrong. Please try again.');
      return null;
    }
  }

  async function persist(next: Workspace) {
    setSaving(true);
    setFormError(null);
    try {
      await commit(next);
      onClose();
    } catch (e) {
      setFormError(`Not saved. ${(e as Error).message} Your entries are still here.`);
      setPending(null);
    } finally {
      setSaving(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const next = validate();
    if (!next) return;
    const planIds = [...new Set([planId, existing?.planId].filter(Boolean) as string[])];
    const editedIds = existing ? [existing.id] : [];
    const impact = compareExpected(ws, next, planIds, editedIds);
    if (impact.otherChangedDealIds.length > 0) {
      setPending({ next, impact });
      return;
    }
    void persist(next);
  }

  const title = existing ? `Edit ${existing.account}` : 'Add a deal';

  if (pending && plan) {
    return (
      <Modal title="Review the effect on other deals" onClose={() => setPending(null)} wide>
        <p>{existing ? 'This change' : 'Adding this deal'} affects deals that close after it.</p>
        <DealImpact before={ws} after={pending.next} impact={pending.impact} year={plan.year} />
        <FormError message={formError} />
        <div className="actions">
          <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void persist(pending.next)}>
            {saving ? 'Saving…' : 'Save deal'}
          </button>
          <button type="button" className="btn" onClick={() => setPending(null)}>
            Go back
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={title} onClose={onClose} wide>
      <form onSubmit={onSubmit} noValidate>
        <FormError message={formError} />
        <div className="form-grid">
          <Field label="Account name" error={errors.account}>
            {(p) => <input {...p} value={account} onChange={(e) => setAccount(e.target.value)} autoComplete="off" />}
          </Field>
          <Field
            label="Credited revenue ($)"
            error={errors.revenue}
            help="The amount your plan counts toward quota. This may differ from total contract value."
          >
            {(p) => <input {...p} inputMode="decimal" value={revenue} onChange={(e) => setRevenue(e.target.value)} placeholder="25000" />}
          </Field>
          {ws.plans.length > 1 && (
            <Field label="Plan year">
              {(p) => (
                <select {...p} value={planId} onChange={(e) => setPlanId(e.target.value)}>
                  {ws.plans.map((pl) => (
                    <option key={pl.id} value={pl.id}>
                      {pl.year}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          )}
          <Field label="Close date" error={errors.closeDate} help={plan ? `Must be in ${plan.year}.` : undefined}>
            {(p) => <input {...p} type="date" value={closeDate} onChange={(e) => setCloseDate(e.target.value)} />}
          </Field>
          <Field
            label="Expected payment date"
            error={errors.expectedDate}
            help="When you expect this commission to be paid. Not counted as missing until then."
          >
            {(p) => <input {...p} type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} />}
          </Field>
          <Field label="Employer deal reference (optional)">
            {(p) => <input {...p} value={reference} onChange={(e) => setReference(e.target.value)} autoComplete="off" />}
          </Field>
        </div>
        <Field label="Notes (optional)">{(p) => <textarea {...p} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field>
        <div className="actions">
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving…' : existing ? 'Save changes' : 'Add deal'}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
