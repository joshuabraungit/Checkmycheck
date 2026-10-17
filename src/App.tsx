import { useEffect, useMemo, useRef, useState } from 'react';
import { Dashboard } from './components/Dashboard';
import { DataView } from './components/DataView';
import { PaymentsView } from './components/PaymentsView';
import { DropReview, readDropped } from './components/DropZone';
import { Landing } from './components/Landing';
import { PlansView } from './components/PlansView';
import { QuickPlan } from './components/QuickPlan';
import { autoDrop, dealYears, type DroppedFile } from './lib/dropImport';
import type { Workspace } from './lib/types';
import { DEMO_AS_OF } from './lib/demo';
import { formatDateLong, todayLocal, yearOf } from './lib/dates';
import { useStore, type SaveState } from './state';

export type View = 'overview' | 'payments' | 'plans' | 'data';

/** A one-line result shown above the answer, optionally undoable. */
export interface Flash {
  text: string;
  undoTo?: Workspace;
}

const SETTINGS: Array<{ id: View; label: string }> = [
  { id: 'payments', label: 'Payments' },
  { id: 'plans', label: 'Commission plan' },
  { id: 'data', label: 'Backup & files' },
];

/** Small disclosure menu for the set-and-forget screens. */
function SettingsMenu({ view, onPick, onExample }: { view: View; onPick: (v: View) => void; onExample?: () => void }) {
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
        <span className="settings-label">Details</span> <span aria-hidden="true">▾</span>
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
          {onExample && (
            <li>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onExample();
                }}
              >
                See an example
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/** Quiet unless something is happening: "Saved" shows briefly, failures stay. */
function SaveIndicator({ state, error }: { state: SaveState; error: string | null }) {
  const [fresh, setFresh] = useState(false);
  useEffect(() => {
    if (state !== 'saved') return;
    setFresh(true);
    const t = setTimeout(() => setFresh(false), 2500);
    return () => clearTimeout(t);
  }, [state, error]);
  let text = '';
  if (state === 'saving') text = 'Saving…';
  else if (state === 'saved' && fresh) text = 'Saved';
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
  const [stage, setStage] = useState<'landing' | 'plan'>('landing');
  const [pendingFiles, setPendingFiles] = useState<DroppedFile[] | null>(null);
  const [reviewFiles, setReviewFiles] = useState<DroppedFile[] | null>(null);
  const [reading, setReading] = useState(false);
  const [landingMessage, setLandingMessage] = useState<string | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [asOf, setAsOf] = useState(() => (mode === 'demo' ? DEMO_AS_OF : todayLocal()));
  const [year, setYear] = useState<number | null>(null);

  useEffect(() => {
    setAsOf(mode === 'demo' ? DEMO_AS_OF : todayLocal());
    setYear(null);
    setView('overview');
    setStage('landing');
    setPendingFiles(null);
    setFlash(null);
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
  const showWelcome = mode === 'personal' && isEmpty && stage === 'landing';

  async function takeLandingFiles(list: File[]) {
    setLandingMessage(null);
    setReading(true);
    try {
      const read = await Promise.all(list.map(readDropped));
      const usable = read.filter((f) => !('error' in f));
      if (!usable.length) {
        setLandingMessage(read.map((f) => ('error' in f ? f.error : '')).find(Boolean) ?? 'Those files couldn’t be read.');
        return;
      }
      setPendingFiles(read);
      setStage('plan');
    } finally {
      setReading(false);
    }
  }

  /** Save the new plan, then add whatever was dropped on the landing page. */
  async function finishPlan(planned: Workspace) {
    const files = pendingFiles;
    if (!files) {
      await store.commit(planned);
      return;
    }
    const auto = autoDrop(files, planned);
    if (auto.kind === 'applied') {
      await store.commit(auto.workspace);
      setFlash({ text: auto.message, undoTo: planned });
    } else {
      await store.commit(planned);
      if (auto.kind === 'review') setReviewFiles(files);
      else setFlash({ text: auto.message });
    }
    setPendingFiles(null);
    setView('overview');
  }

  async function undo(to: Workspace) {
    try {
      await store.commit(to);
      setFlash({ text: 'Undone.' });
    } catch (e) {
      setFlash({ text: `Couldn’t undo. ${(e as Error).message}` });
    }
  }

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
            <span className="brand-name">Check My Check</span>
          </div>
          <div className="topbar-right">
            <SaveIndicator state={store.saveState} error={store.saveError} />
            {!showWelcome && ws.plans.length > 0 && (
              <SettingsMenu view={view} onPick={setView} onExample={mode === 'personal' ? () => void store.enterDemo() : undefined} />
            )}
            {mode === 'demo' && (
              <button type="button" className="btn btn-small" onClick={() => void store.exitDemo()}>
                Exit example
              </button>
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
          <Landing
            onFiles={(list) => void takeLandingFiles(list)}
            onManual={() => {
              setPendingFiles(null);
              setStage('plan');
            }}
            onDemo={() => void store.enterDemo()}
            busy={reading}
            message={landingMessage}
          />
        </main>
      ) : !ws.plans.length ? (
        <main id="main" className="page narrow">
          <QuickPlan
            years={pendingFiles && dealYears(pendingFiles).length ? dealYears(pendingFiles) : [yearOf(todayLocal())]}
            hasFiles={!!pendingFiles}
            onSaved={finishPlan}
            onBack={() => {
              setPendingFiles(null);
              setStage('landing');
            }}
          />
        </main>
      ) : (
        <>
          <main id="main" className="page">
            {view !== 'overview' && (
              <button type="button" className="link-btn back-link" onClick={() => setView('overview')}>
                ← Back to summary
              </button>
            )}
            {view === 'overview' && selectedYear !== null && (
              <Dashboard
                year={selectedYear}
                years={years}
                onYear={setYear}
                asOf={asOf}
                onAsOf={setAsOf}
                onGoToPayments={() => setView('payments')}
                flash={flash}
                onFlash={setFlash}
                onUndo={(to) => void undo(to)}
              />
            )}
            {view === 'payments' && <PaymentsView />}
            {view === 'plans' && <PlansView />}
            {view === 'data' && selectedYear !== null && <DataView year={selectedYear} asOf={asOf} />}
          </main>
        </>
      )}
      {reviewFiles && (
        <DropReview
          files={reviewFiles}
          onClose={() => setReviewFiles(null)}
          onDone={(text, undoTo) => {
            setReviewFiles(null);
            setFlash({ text, undoTo });
          }}
        />
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
