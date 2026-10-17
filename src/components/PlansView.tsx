import { useState, type FormEvent } from 'react';
import { calculatePlan, compareExpected, type ImpactSummary } from '../lib/calc';
import { centsToInput, D, formatCents, formatPercent, normalizeRate, parseMoneyInput, parsePercentInput, rateToPercentString, sumCents } from '../lib/money';
import { deletePlan, OpError, savePlan } from '../lib/ops';
import type { Plan, QuotaPeriod, Tier, TierMode, Workspace } from '../lib/types';
import { MAX_TIERS } from '../lib/validate';
import { useStore } from '../state';
import { Field, FormError, Modal } from './ui';

export const PLAN_CONFIRMATION = 'My plan uses the credited revenue entered here, with the quota and rates above.';

export function PlanLimitations() {
  return (
    <div className="limitations">
      <h3>What this version supports</h3>
      <p>
        One plan per calendar year with an annual quota or four quarterly quotas, and one or more commission rates that step up as you pass a
        percentage of quota. Higher rates can apply only above each threshold, or retroactively to everything in the period.
      </p>
      <p>If your plan includes any of these, the numbers here won’t match it, so please don’t rely on them:</p>
      <ul className="limitation-list">
        <li>Split commissions</li>
        <li>Commission caps</li>
        <li>Recoverable draws</li>
        <li>Ramp compensation</li>
        <li>SPIFFs or bonuses</li>
        <li>Clawbacks or negative revenue adjustments</li>
        <li>Plan changes partway through the year</li>
        <li>Quarterly quotas with annual accelerators</li>
      </ul>
      <p className="muted">
        Salary and OTE aren’t needed. Commission rates come straight from your plan document, not from your pay targets.
      </p>
    </div>
  );
}

/** "10%, 15% from 100% of quota" plus how higher tiers pay. */
export function describeTiers(plan: Pick<Plan, 'tiers' | 'tierMode'>): string {
  const text = plan.tiers
    .map((t, i) => (i === 0 ? formatPercent(t.rate) : `${formatPercent(t.rate)} from ${rateToPercentString(t.fromAttainment)}% of quota`))
    .join(', ');
  return plan.tiers.length > 1 ? `${text} (${plan.tierMode === 'retroactive' ? 'retroactive' : 'marginal'})` : text;
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

interface TierDraft {
  /** Percent of quota, as typed (the first tier is fixed at 0). */
  from: string;
  /** Percent rate, as typed. */
  rate: string;
}

const QUARTERS = ['Q1', 'Q2', 'Q3', 'Q4'];

export function PlanForm({ existing, onSaved, onCancel, submitLabel }: PlanFormProps) {
  const { ws, commit } = useStore();
  const [year, setYear] = useState(existing ? String(existing.year) : String(new Date().getFullYear()));
  const [period, setPeriod] = useState<QuotaPeriod>(existing?.period ?? 'annual');
  const [annualQuota, setAnnualQuota] = useState(existing?.period === 'annual' ? centsToInput(existing.quotasCents[0]) : '');
  const [quarterQuotas, setQuarterQuotas] = useState<string[]>(
    existing?.period === 'quarterly' ? existing.quotasCents.map(centsToInput) : ['', '', '', ''],
  );
  const [tiers, setTiers] = useState<TierDraft[]>(
    existing
      ? existing.tiers.map((t) => ({ from: rateToPercentString(t.fromAttainment), rate: rateToPercentString(t.rate) }))
      : [
          { from: '0', rate: '' },
          { from: '100', rate: '' },
        ],
  );
  const [tierMode, setTierMode] = useState<TierMode>(existing?.tierMode ?? 'marginal');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [confirmed, setConfirmed] = useState(Boolean(existing));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ next: Workspace; impact: ImpactSummary } | null>(null);
  const [saving, setSaving] = useState(false);

  const dealCount = existing ? ws.deals.filter((d) => d.planId === existing.id).length : 0;
  const periodWord = period === 'quarterly' ? 'quarter' : 'year';

  function setTier(i: number, patch: Partial<TierDraft>) {
    setTiers((ts) => ts.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  }

  function addTier() {
    setTiers((ts) => {
      const last = ts.length > 1 ? Number(ts[ts.length - 1].from) : 0;
      const next = Number.isFinite(last) && last > 0 ? last + 50 : 100;
      return [...ts, { from: String(next), rate: '' }];
    });
  }

  function build(): Workspace | null {
    const errs: Record<string, string> = {};
    const y = Number(year);
    if (!/^\d{4}$/.test(year.trim())) errs.year = 'Enter a four-digit year, like 2026.';
    const quotasCents: string[] = [];
    if (period === 'annual') {
      const q = parseMoneyInput(annualQuota, 'Annual quota');
      if (!q.ok) errs.quota = q.error;
      else quotasCents.push(q.value);
    } else {
      quarterQuotas.forEach((raw, i) => {
        const q = parseMoneyInput(raw, `${QUARTERS[i]} quota`);
        if (!q.ok) errs[`quota${i}`] = q.error;
        else quotasCents.push(q.value);
      });
    }
    const parsedTiers: Tier[] = [];
    const rates: Array<string | null> = [];
    tiers.forEach((t, i) => {
      const r = parsePercentInput(t.rate, i === 0 ? 'Base commission rate' : `Tier ${i + 1} rate`);
      if (!r.ok) errs[`rate${i}`] = r.error;
      let from = '0.0';
      if (i > 0) {
        const cleaned = t.from.trim().replace(/%$/, '').trim();
        if (!/^\d+(\.\d{1,4})?$/.test(cleaned) || Number(cleaned) <= 0 || Number(cleaned) > 10000) {
          errs[`from${i}`] = 'Enter a percentage of quota greater than 0, like 100 or 150.';
        } else {
          from = normalizeRate(new D(cleaned).div(100));
          if (i > 1 && Number(cleaned) <= Number(tiers[i - 1].from)) errs[`from${i}`] = 'Each tier must start higher than the one before it.';
        }
      }
      rates.push(r.ok ? r.value : null);
      if (r.ok) {
        const prev = i > 0 ? rates[i - 1] : null;
        if (prev !== null && new D(r.value).lt(prev)) {
          errs[`rate${i}`] = 'Each tier’s rate must be at least the rate before it.';
        }
        parsedTiers.push({ fromAttainment: from, rate: r.value });
      }
    });
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
        period,
        quotasCents,
        tiers: parsedTiers,
        tierMode: parsedTiers.length > 1 ? tierMode : 'marginal',
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
      </div>

      <fieldset className="choice-group">
        <legend>Quota is measured</legend>
        <label className="check-row">
          <input type="radio" name="period" checked={period === 'annual'} onChange={() => setPeriod('annual')} />
          Over the whole year
        </label>
        <label className="check-row">
          <input type="radio" name="period" checked={period === 'quarterly'} onChange={() => setPeriod('quarterly')} />
          Each quarter (attainment starts over every quarter)
        </label>
      </fieldset>
      {period === 'annual' ? (
        <Field label="Annual quota (credited revenue, $)" error={errors.quota} help="The credited revenue you need to reach for the year.">
          {(p) => <input {...p} inputMode="decimal" value={annualQuota} onChange={(e) => setAnnualQuota(e.target.value)} placeholder="100000" />}
        </Field>
      ) : (
        <div className="form-grid quarter-grid">
          {QUARTERS.map((q, i) => (
            <Field key={q} label={`${q} quota ($)`} error={errors[`quota${i}`]}>
              {(p) => (
                <input
                  {...p}
                  inputMode="decimal"
                  value={quarterQuotas[i]}
                  onChange={(e) => {
                    const v = e.target.value;
                    setQuarterQuotas((qs) => qs.map((x, j) => (j === i ? v : x)));
                  }}
                  placeholder="25000"
                />
              )}
            </Field>
          ))}
        </div>
      )}

      <h3 className="tiers-title">Commission rates</h3>
      <ol className="tier-list">
        {tiers.map((t, i) => (
          <li key={i} className="tier-row">
            {i === 0 ? (
              <Field label="Base commission rate (%)" error={errors.rate0} help="Paid from the first dollar of credited revenue.">
                {(p) => <input {...p} inputMode="decimal" value={t.rate} onChange={(e) => setTier(0, { rate: e.target.value })} placeholder="10" />}
              </Field>
            ) : (
              <>
                <Field label={`Tier ${i + 1} starts at (% of quota)`} error={errors[`from${i}`]}>
                  {(p) => <input {...p} inputMode="decimal" value={t.from} onChange={(e) => setTier(i, { from: e.target.value })} placeholder="100" />}
                </Field>
                <Field label={`Tier ${i + 1} rate (%)`} error={errors[`rate${i}`]}>
                  {(p) => <input {...p} inputMode="decimal" value={t.rate} onChange={(e) => setTier(i, { rate: e.target.value })} placeholder="15" />}
                </Field>
                <button type="button" className="btn btn-small btn-quiet tier-remove" onClick={() => setTiers((ts) => ts.filter((_, j) => j !== i))}>
                  Remove<span className="sr-only"> tier {i + 1}</span>
                </button>
              </>
            )}
          </li>
        ))}
      </ol>
      {tiers.length < MAX_TIERS && (
        <button type="button" className="btn btn-small" onClick={addTier}>
          {tiers.length === 1 ? 'Add a higher rate above a % of quota' : 'Add another tier'}
        </button>
      )}
      {tiers.length > 1 && (
        <fieldset className="choice-group">
          <legend>When you pass a tier, the higher rate applies to</legend>
          <label className="check-row">
            <input type="radio" name="tier-mode" checked={tierMode === 'marginal'} onChange={() => setTierMode('marginal')} />
            Only the revenue above that point
          </label>
          <label className="check-row">
            <input type="radio" name="tier-mode" checked={tierMode === 'retroactive'} onChange={() => setTierMode('retroactive')} />
            All revenue so far in the {periodWord} (retroactive). The catch-up shows on the deal that crosses the line.
          </label>
        </fieldset>
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
      <p className="muted">One plan per calendar year. Quota attainment starts over each January 1, or each quarter on a quarterly plan.</p>
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
                  <dt>{p.period === 'quarterly' ? 'Quarterly quotas' : 'Annual quota'}</dt>
                  <dd className="num">{p.quotasCents.map((q) => formatCents(q)).join(' · ')}</dd>
                </div>
                <div>
                  <dt>Rates</dt>
                  <dd>{describeTiers(p)}</dd>
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
