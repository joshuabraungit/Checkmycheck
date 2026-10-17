import { useEffect, useMemo, useRef, useState } from 'react';
import { Dashboard } from './components/Dashboard';
import { DataView } from './components/DataView';
import { PaymentsView } from './components/PaymentsView';
import { PlanSetup, PlansView } from './components/PlansView';
import { Welcome } from './components/Welcome';
import { DEMO_AS_OF } from './lib/demo';
import { formatDateLong, todayLocal, yearOf } from './lib/dates';
import { useStore, type SaveState } from './state';

export type View = 'overview' | 'payments' | 'plans' | 'data';

const VIEWS: Array<{ id: View; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'payments', label: 'Payments' },
];

const SETTINGS: Array<{ id: View; label: string }> = [
  { id: 'plans', label: 'Commission plan' },
  { id: 'data', label: 'Backup & files' },
];

/** Small disclosure menu for the set-and-forget screens. */
function SettingsMenu({ view, onPick }: { view: View; onPick: (v: View) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        ref.current?.querySelector<HTMLButtonElement>('.settings-btn')?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const current = SETTINGS.some((s) => s.id === view);
  return (
    <div className="settings" ref={ref}>
      <button
        type="button"
        className={`btn btn-small btn-quiet settings-btn${current ? ' active' : ''}`}
        aria-expanded={open}
        aria-controls="settings-menu"
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden="true" className="settings-icon">
          ⚙
        </span>
        <span className="settings-label">Settings</span> <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <ul id="settings-menu" className="settings-menu">
          {SETTINGS.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                aria-current={view === s.id ? 'page' : undefined}
                onClick={() => {
                  setOpen(false);
                  onPick(s.id);
                }}
              >
                {s.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SaveIndicator({ state, error }: { state: SaveState; error: string | null }) {
  let text = '';
  if (state === 'saving') text = 'Saving…';
  else if (state === 'saved') text = 'Saved';
  else if (state === 'failed') text = 'Save failed';
  return (
    <span className={`save-indicator save-${state}`} role="status" aria-live="polite" title={error ?? undefined}>
      {text}
    </span>
  );
}

/** Pick the plan year that best fits the as-of date. */
function defaultYear(years: number[], asOf: string): number | null {
  if (!years.length) return null;
  const y = yearOf(asOf);
  if (years.includes(y)) return y;
  const earlier = years.filter((x) => x <= y);
  return earlier.length ? Math.max(...earlier) : Math.min(...years);
}

export default function App() {
  const store = useStore();
  const { ws, mode, loading, loadError } = store;
  const [view, setView] = useState<View>('overview');
  const [starting, setStarting] = useState(false);
  const [asOf, setAsOf] = useState(() => (mode === 'demo' ? DEMO_AS_OF : todayLocal()));
  const [year, setYear] = useState<number | null>(null);

  useEffect(() => {
    setAsOf(mode === 'demo' ? DEMO_AS_OF : todayLocal());
    setYear(null);
    setView('overview');
    setStarting(false);
  }, [mode]);

  const years = useMemo(() => ws.plans.map((p) => p.year).sort((a, b) => a - b), [ws.plans]);
  const selectedYear = year !== null && years.includes(year) ? year : defaultYear(years, asOf);

  if (loading) {
    return (
      <div className="app-loading" role="status" aria-live="polite">
        Loading your tracker…
      </div>
    );
  }

  if (loadError) {
    return (
      <main className="page narrow">
        <h1>We couldn’t open your saved data</h1>
        <p role="alert">{loadError}</p>
        <p>Your browser may be blocking storage for this site, for example in some private browsing modes.</p>
        {mode === 'demo' && (
          <button type="button" className="btn" onClick={() => void store.exitDemo()}>
            Back to my tracker
          </button>
        )}
      </main>
    );
  }

  const isEmpty = !ws.plans.length && !ws.deals.length && !ws.payments.length;
  const showWelcome = mode === 'personal' && isEmpty && !starting;

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              ✓
            </span>
            Check My Check
          </div>
          <div className="topbar-right">
            <SaveIndicator state={store.saveState} error={store.saveError} />
            {!showWelcome && ws.plans.length > 0 && <SettingsMenu view={view} onPick={setView} />}
            {mode === 'demo' ? (
              <button type="button" className="btn btn-small" onClick={() => void store.exitDemo()}>
                Exit example
              </button>
            ) : (
              !showWelcome && (
                <button type="button" className="btn btn-small btn-quiet" onClick={() => void store.enterDemo()}>
                  View example
                </button>
              )
            )}
          </div>
        </div>
      </header>

      {mode === 'demo' && (
        <div className="demo-banner" role="note">
          <strong>Example workspace.</strong> These are sample numbers, kept separate from your own records. Changes here never touch your
          tracker. Example date: {formatDateLong(DEMO_AS_OF)}.
        </div>
      )}
      {store.saveState === 'failed' && store.saveError && (
        <div className="save-error-banner" role="alert">
          Save failed: {store.saveError}
        </div>
      )}
      {store.syncNotice && (
        <div className="sync-banner" role="status">
          {store.syncNotice}{' '}
          <button type="button" className="link-btn" onClick={store.dismissSyncNotice}>
            Dismiss
          </button>
        </div>
      )}

      {showWelcome ? (
        <main id="main" className="page">
          <Welcome onStart={() => setStarting(true)} onDemo={() => void store.enterDemo()} />
        </main>
      ) : !ws.plans.length ? (
        <main id="main" className="page narrow">
          <PlanSetup onDone={() => setView('overview')} onCancel={isEmpty ? () => setStarting(false) : undefined} />
        </main>
      ) : (
        <>
          <nav className="tabs" aria-label="Sections">
            <div className="tabs-inner">
              {VIEWS.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  className={`tab${view === v.id ? ' active' : ''}`}
                  aria-current={view === v.id ? 'page' : undefined}
                  onClick={() => setView(v.id)}
                >
                  {v.label}
                </button>
              ))}
            </div>
          </nav>
          <main id="main" className="page">
            {view === 'overview' && selectedYear !== null && (
              <Dashboard
                year={selectedYear}
                years={years}
                onYear={setYear}
                asOf={asOf}
                onAsOf={setAsOf}
                onGoToPayments={() => setView('payments')}
              />
            )}
            {view === 'payments' && <PaymentsView />}
            {view === 'plans' && <PlansView />}
            {view === 'data' && selectedYear !== null && <DataView year={selectedYear} asOf={asOf} />}
          </main>
        </>
      )}
      <footer className="footer">
        <p>
          Your data stays in this browser. Clearing site data removes it, so export a backup to keep a separate copy. Check My Check compares
          the numbers you enter; it isn’t payroll, legal, or tax advice.
        </p>
      </footer>
    </div>
  );
}
