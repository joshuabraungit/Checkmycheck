import { useState, type FormEvent } from 'react';
import { calculatePlan, compareExpected, type ImpactSummary } from '../lib/calc';
import { centsToInput, formatCents, sumCents, formatPercent, parseMoneyInput, parsePercentInput, rateToPercentString } from '../lib/money';
import { deletePlan, OpError, savePlan } from '../lib/ops';
import type { Plan, Workspace } from '../lib/types';
import { useStore } from '../state';
import { Field, FormError, Modal } from './ui';

export const PLAN_CONFIRMATION = 'My plan uses the credited revenue entered here and a marginal accelerator above an annual quota.';

export function PlanLimitations() {
  return (
    <div className="limitations">
      <h3>What this version supports</h3>
      <p>
        One plan per calendar year: a commission percentage on credited revenue, plus an optional higher percentage that applies only to
        revenue above your annual quota.
      </p>
      <p>If your plan includes any of these, the numbers here won’t match it, so please don’t rely on them:</p>
      <ul className="limitation-list">
        <li>Retroactive accelerators (higher rate applied back to the first dollar)</li>
        <li>More than one accelerator tier</li>
        <li>Quarterly quota resets</li>
        <li>Split commissions</li>
        <li>Commission caps</li>
        <li>Recoverable draws</li>
        <li>Ramp compensation</li>
        <li>SPIFFs or bonuses</li>
        <li>Clawbacks or negative revenue adjustments</li>
        <li>Plan changes partway through the year</li>
      </ul>
      <p className="muted">
        Salary and OTE aren’t needed. Commission rates come straight from your plan document, not from your pay targets.
      </p>
    </div>
  );
}

function ImpactReview({ impact, year, dealCount }: { impact: ImpactSummary; year: number; dealCount: number }) {
  const delta = impact.newTotalCents.minus(impact.oldTotalCents);
  return (
    <div className="impact" role="region" aria-label="Effect of this change">
      <h3>Before you save</h3>
      <dl className="impact-grid">
        <div>
          <dt>Expected commission for {year}, now</dt>
          <dd className="num">{formatCents(impact.oldTotalCents)}</dd>
        </div>
        <div>
          <dt>After this change</dt>
          <dd className="num">{formatCents(impact.newTotalCents)}</dd>
        </div>
        <div>
          <dt>Change</dt>
          <dd className="num">{formatCents(delta, { signed: true })}</dd>
        </div>
        <div>
          <dt>Deals with a different expected commission</dt>
          <dd className="num">
            {impact.changedDealIds.length} of {dealCount}
          </dd>
        </div>
      </dl>
      <p className="muted">This version applies one plan to the entire calendar year. It does not model midyear plan changes.</p>
    </div>
  );
}

interface PlanFormProps {
  existing?: Plan;
  onSaved: () => void;
  onCancel?: () => void;
  submitLabel?: string;
}

export function PlanForm({ existing, onSaved, onCancel, submitLabel }: PlanFormProps) {
  const { ws, commit } = useStore();
  const [year, setYear] = useState(existing ? String(existing.year) : String(new Date().getFullYear()));
  const [quota, setQuota] = useState(existing ? centsToInput(existing.annualQuotaCents) : '');
  const [base, setBase] = useState(existing ? rateToPercentString(existing.baseRate) : '');
  const [hasAccel, setHasAccel] = useState(existing ? existing.acceleratorRate !== null : true);
  const [accel, setAccel] = useState(existing?.acceleratorRate ? rateToPercentString(existing.acceleratorRate) : '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [confirmed, setConfirmed] = useState(Boolean(existing));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ next: Workspace; impact: ImpactSummary } | null>(null);
  const [saving, setSaving] = useState(false);

  const dealCount = existing ? ws.deals.filter((d) => d.planId === existing.id).length : 0;

  function build(): Workspace | null {
    const errs: Record<string, string> = {};
    const y = Number(year);
    if (!/^\d{4}$/.test(year.trim())) errs.year = 'Enter a four-digit year, like 2026.';
    const q = parseMoneyInput(quota, 'Annual quota');
    if (!q.ok) errs.quota = q.error;
    const b = parsePercentInput(base, 'Base commission rate');
    if (!b.ok) errs.base = b.error;
    let a: string | null = null;
    if (hasAccel) {
      const parsed = parsePercentInput(accel, 'Accelerator rate');
      if (!parsed.ok) errs.accel = parsed.error;
      else {
        a = parsed.value;
        if (b.ok && Number(parsed.value) < Number(b.value)) errs.accel = 'Accelerator rate must be at least the base rate.';
      }
    }
    if (!confirmed) errs.confirm = 'Please confirm your plan works this way, or check the list of unsupported features above.';
    setErrors(errs);
    if (Object.keys(errs).length) {
      setFormError('Please fix the highlighted fields.');
      return null;
    }
    try {
      return savePlan(ws, {
        id: existing?.id,
        year: y,
        annualQuotaCents: (q as { value: string }).value,
        baseRate: (b as { value: string }).value,
        acceleratorRate: a,
        notes,
      });
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
      onSaved();
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
    const next = build();
    if (!next) return;
    if (existing && dealCount > 0) {
      setPending({ next, impact: compareExpected(ws, next, [existing.id]) });
      return;
    }
    void persist(next);
  }

  if (pending && existing) {
    return (
      <div>
        <ImpactReview impact={pending.impact} year={existing.year} dealCount={dealCount} />
        <FormError message={formError} />
        <div className="actions">
          <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void persist(pending.next)}>
            Save plan changes
          </button>
          <button type="button" className="btn" onClick={() => setPending(null)}>
            Go back
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <FormError message={formError} />
      <div className="form-grid">
        <Field label="Calendar year" error={errors.year} help={existing && dealCount ? 'The year is fixed once deals are added.' : undefined}>
          {(p) => (
            <input {...p} inputMode="numeric" value={year} disabled={Boolean(existing && dealCount)} onChange={(e) => setYear(e.target.value)} />
          )}
        </Field>
        <Field label="Currency">{(p) => <input {...p} value="USD" disabled readOnly />}</Field>
        <Field label="Annual quota (credited revenue, $)" error={errors.quota} help="The credited revenue you need to reach for the year.">
          {(p) => <input {...p} inputMode="decimal" value={quota} onChange={(e) => setQuota(e.target.value)} placeholder="100000" />}
        </Field>
        <Field label="Base commission rate (%)" error={errors.base} help="Paid on credited revenue up to quota.">
          {(p) => <input {...p} inputMode="decimal" value={base} onChange={(e) => setBase(e.target.value)} placeholder="10" />}
        </Field>
      </div>
      <div className="check-row">
        <input id="has-accel" type="checkbox" checked={hasAccel} onChange={(e) => setHasAccel(e.target.checked)} />
        <label htmlFor="has-accel">My plan pays a higher rate on revenue above quota</label>
      </div>
      {hasAccel && (
        <Field label="Accelerator rate (%)" error={errors.accel} help="Paid only on the credited revenue above your annual quota.">
          {(p) => <input {...p} inputMode="decimal" value={accel} onChange={(e) => setAccel(e.target.value)} placeholder="15" />}
        </Field>
      )}
      <Field label="Notes (optional)">{(p) => <textarea {...p} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field>

      <PlanLimitations />

      <div className={`check-row confirm-row${errors.confirm ? ' has-error' : ''}`}>
        <input
          id="plan-confirm"
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          aria-describedby={errors.confirm ? 'plan-confirm-err' : undefined}
          aria-invalid={errors.confirm ? true : undefined}
        />
        <label htmlFor="plan-confirm">{PLAN_CONFIRMATION}</label>
      </div>
      {errors.confirm && (
        <p id="plan-confirm-err" className="field-error">
          {errors.confirm}
        </p>
      )}
      {existing && <p className="muted">This version applies one plan to the entire calendar year. It does not model midyear plan changes.</p>}
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? 'Saving…' : submitLabel ?? (existing ? 'Review changes' : 'Save plan')}
        </button>
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

export function PlanSetup({ onDone, onCancel }: { onDone: () => void; onCancel?: () => void }) {
  return (
    <section>
      <h1>Set up your commission plan</h1>
      <p className="lead">Enter the numbers from your plan document for one calendar year. You can add other years later.</p>
      <div className="panel">
        <PlanForm onSaved={onDone} onCancel={onCancel} submitLabel="Save plan and continue" />
      </div>
    </section>
  );
}

export function PlansView() {
  const { ws, commit } = useStore();
  const [editing, setEditing] = useState<Plan | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <section>
      <div className="section-head">
        <h1>Commission plan</h1>
        <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
          Add a plan year
        </button>
      </div>
      <p className="muted">One plan per calendar year. Quota attainment starts over each January 1.</p>
      <FormError message={error} />
      <div className="plan-list">
        {ws.plans.map((p) => {
          const calcs = calculatePlan(p, ws.deals);
          const total = sumCents(calcs.map((c) => c.expectedCents));
          return (
            <article key={p.id} className="panel plan-card">
              <h2>{p.year} plan</h2>
              <dl className="kv">
                <div>
                  <dt>Annual quota</dt>
                  <dd className="num">{formatCents(p.annualQuotaCents)}</dd>
                </div>
                <div>
                  <dt>Base rate</dt>
                  <dd className="num">{formatPercent(p.baseRate)}</dd>
                </div>
                <div>
                  <dt>Above quota</dt>
                  <dd className="num">{p.acceleratorRate ? formatPercent(p.acceleratorRate) : 'No accelerator'}</dd>
                </div>
                <div>
                  <dt>Deals</dt>
                  <dd className="num">{calcs.length}</dd>
                </div>
                <div>
                  <dt>Expected commission, all deals</dt>
                  <dd className="num">{formatCents(total)}</dd>
                </div>
              </dl>
              {p.notes && <p className="notes">{p.notes}</p>}
              <div className="actions">
                <button type="button" className="btn" onClick={() => setEditing(p)}>
                  Edit {p.year} plan
                </button>
                {calcs.length === 0 && (
                  <button type="button" className="btn btn-quiet" onClick={() => setDeleting(p)}>
                    Delete
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {editing && (
        <Modal title={editing === 'new' ? 'Add a plan year' : `Edit ${editing.year} plan`} onClose={() => setEditing(null)} wide>
          <PlanForm existing={editing === 'new' ? undefined : editing} onSaved={() => setEditing(null)} onCancel={() => setEditing(null)} />
        </Modal>
      )}
      {deleting && (
        <Modal title={`Delete the ${deleting.year} plan?`} onClose={() => setDeleting(null)}>
          <p>This plan has no deals. Deleting it can’t be undone, but you can add it again later.</p>
          <div className="actions">
            <button
              type="button"
              className="btn btn-danger"
              onClick={async () => {
                try {
                  await commit(deletePlan(ws, deleting.id));
                  setDeleting(null);
                } catch (e) {
                  setError((e as Error).message);
                  setDeleting(null);
                }
              }}
            >
              Delete plan
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
