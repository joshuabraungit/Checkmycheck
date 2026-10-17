import { useId, useRef, useState, type DragEvent } from 'react';

/** A paystub with one commission line circled, and a question tag. Decorative. */
function PaystubArt() {
  return (
    <svg className="landing-art" viewBox="0 0 240 200" role="presentation" aria-hidden="true">
      <rect x="28" y="16" width="184" height="168" rx="12" fill="var(--surface)" stroke="var(--border)" strokeWidth="2" />
      <rect x="48" y="38" width="96" height="10" rx="3" fill="var(--text)" />
      <rect x="48" y="62" width="144" height="7" rx="3" fill="var(--border)" />
      <rect x="48" y="78" width="120" height="7" rx="3" fill="var(--border)" />
      <rect x="48" y="102" width="70" height="8" rx="3" fill="var(--muted)" />
      <rect x="150" y="102" width="42" height="8" rx="3" fill="var(--muted)" />
      <ellipse cx="120" cy="106" rx="86" ry="17" fill="none" stroke="var(--amber)" strokeWidth="3" />
      <rect x="48" y="126" width="132" height="7" rx="3" fill="var(--border)" />
      <rect x="52" y="148" width="132" height="24" rx="12" fill="var(--amber-soft)" stroke="var(--amber-border)" strokeWidth="1.5" />
      <text x="118" y="164" textAnchor="middle" fontSize="11" fontWeight="600" fill="var(--amber)" fontFamily="system-ui, sans-serif">
        ? Ask about Meridian
      </text>
    </svg>
  );
}

export function Landing({
  onFiles,
  onManual,
  onDemo,
  busy,
  message,
}: {
  onFiles: (files: File[]) => void;
  onManual: () => void;
  onDemo: () => void;
  busy: boolean;
  message: string | null;
}) {
  const inputId = useId();
  const ref = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    const list = Array.from(e.dataTransfer.files);
    if (list.length) onFiles(list);
  }

  return (
    <section
      className={`landing panel${dragging ? ' is-dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <div className="landing-copy">
        <h1>
          You closed the deal.
          <br />
          Did you get paid for it?
        </h1>
        <p className="lead">
          Drop in your deals and paystubs. We’ll check every commission against your plan and show you which deals came up short.
        </p>
        <span className="file-picker">
          <label htmlFor={inputId} className="btn btn-dark btn-large" aria-disabled={busy || undefined}>
            {busy ? 'Reading your files…' : 'Check my commission →'}
          </label>
          <input
            ref={ref}
            id={inputId}
            type="file"
            multiple
            accept=".csv,.xlsx,.pdf,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="visually-hidden-file"
            data-testid="landing-files"
            onChange={(e) => {
              const list = Array.from(e.target.files ?? []);
              if (ref.current) ref.current.value = '';
              if (list.length) onFiles(list);
            }}
          />
        </span>
        {message && (
          <p className="form-error" role="alert">
            {message}
          </p>
        )}
        <p className="landing-need">
          You’ll need your closed deals (a CRM export or your own spreadsheet) and your paystub PDFs. Don’t have them handy?{' '}
          <button type="button" className="link-btn strong-link" onClick={onDemo}>
            Try an example →
          </button>
        </p>
        <p className="landing-fine muted small">
          <span aria-hidden="true">🔒 </span>Your files never leave your browser.{' '}
          <button type="button" className="link-btn" onClick={onManual}>
            Prefer typing? Enter deals by hand
          </button>
        </p>
      </div>
      <PaystubArt />
    </section>
  );
}
