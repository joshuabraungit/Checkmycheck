import { useState, type FormEvent } from 'react';
import { D, parseMoneyInput, parsePercentInput } from '../lib/money';
import { OpError, savePlan } from '../lib/ops';
import type { Workspace } from '../lib/types';
import { useStore } from '../state';
import { Field, FormError } from './ui';

const UNSUPPORTED = [
  'Split commissions',
  'Commission caps',
  'More than one higher rate (tiers)',
  'A higher rate that applies back to the first dollar',
  'Quarterly quotas',
  'Draws, ramps, SPIFFs, or bonuses',
  'Clawbacks or negative adjustments',
  'Plan changes partway through the year',
];

function listYears(years: number[]): string {
  if (years.length <= 1) return String(years[0]);
  return `${years.slice(0, -1).join(', ')} and ${years[years.length - 1]}`;
}

/**
 * The three numbers we can't read from files. The year comes from the deals'
 * close dates; the same plan is set up for each year found.
 */
export function QuickPlan({
  years,
  hasFiles,
  onSaved,
  onBack,
}: {
  years: number[];
  hasFiles: boolean;
  /** Called with the workspace that now has plans, after it's saved. */
  onSaved: (planned: Workspace) => Promise<void>;
  onBack: () => void;
}) {
  const { ws } = useStore();
  const [quota, setQuota] = useState('');
  const [base, setBase] = useState('');
  const [accel, setAccel] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const errs: Record<string, string> = {};
    const q = parseMoneyInput(quota, 'Annual quota');
    if (!q.ok) errs.quota = q.error;
    const b = parsePercentInput(base, 'Commission rate');
    if (!b.ok) errs.base = b.error;
    let a: string | null = null;
    if (accel.trim()) {
      const parsed = parsePercentInput(accel, 'Rate above quota');
      if (!parsed.ok) errs.accel = parsed.error;
      else if (b.ok && new D(parsed.value).lt(b.value)) errs.accel = 'The rate above quota should be at least your regular rate.';
      else a = parsed.value;
    }
    setErrors(errs);
    if (Object.keys(errs).length) return;
    let next = ws;
    try {
      for (const year of years) {
        next = savePlan(next, {
          year,
          annualQuotaCents: (q as { value: string }).value,
          baseRate: (b as { value: string }).value,
          acceleratorRate: a,
          notes: '',
        });
      }
    } catch (err) {
      setFormError(err instanceof OpError ? err.message : 'Something went wrong. Please try again.');
      return;
    }
    setSaving(true);
    try {
      await onSaved(next);
    } catch (err) {
      setFormError(`Not saved. ${(err as Error).message} Your entries are still here.`);
      setSaving(false);
    }
  }

  return (
    <section className="quick-plan panel">
      <h1>Three quick questions about your plan</h1>
      <p className="muted">
        {hasFiles ? 'Your files are ready. ' : ''}These are on your comp plan document. We’ll use them for {listYears(years)}.
      </p>
      <form onSubmit={(e) => void onSubmit(e)} noValidate>
        <FormError message={formError} />
        <Field label="What’s your annual quota? ($)" error={errors.quota} help="The deal amount you need to close in the year.">
          {(p) => <input {...p} inputMode="decimal" value={quota} onChange={(e) => setQuota(e.target.value)} placeholder="800,000" />}
        </Field>
        <Field label="What % of each deal do you earn? (%)" error={errors.base}>
          {(p) => <input {...p} inputMode="decimal" value={base} onChange={(e) => setBase(e.target.value)} placeholder="10" />}
        </Field>
        <Field
          label="Higher % once you pass quota? (optional)"
          error={errors.accel}
          help="Only the part of each deal above quota earns this. Leave blank if your rate doesn’t change."
        >
          {(p) => <input {...p} inputMode="decimal" value={accel} onChange={(e) => setAccel(e.target.value)} placeholder="15" />}
        </Field>
        <details className="plan-fit">
          <summary>Works for one rate, plus an optional higher rate above quota. Splits, caps, tiers, or clawbacks?</summary>
          <p>These aren’t supported yet, so if your plan has any of them, the numbers won’t be exact:</p>
          <ul>
            {UNSUPPORTED.map((u) => (
              <li key={u}>{u}</li>
            ))}
          </ul>
        </details>
        <div className="actions">
          <button type="submit" className="btn btn-dark btn-large" disabled={saving}>
            {saving ? 'Checking…' : hasFiles ? 'Show my answer →' : 'Continue →'}
          </button>
          <button type="button" className="link-btn" onClick={onBack}>
            Back
          </button>
        </div>
      </form>
    </section>
  );
}
