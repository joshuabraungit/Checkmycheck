import { useId, useMemo, useRef, useState, type DragEvent } from 'react';
import { analyzeDrop, applyDrop, autoDrop, dropMessage, sourceItems, type DroppedFile, type Source } from '../lib/dropImport';
import type { Workspace } from '../lib/types';
import { formatDateLong } from '../lib/dates';
import { formatCents, sumCents } from '../lib/money';
import { extractPaystub, linesToRows } from '../lib/pdfText';
import { isExcelFile, isPdfFile, readSpreadsheetFile } from '../lib/readSpreadsheet';
import type { DateOrder } from '../lib/sheetImport';
import { useStore } from '../state';
import { readPdfLines } from './PaystubImport';
import { FormError, Modal } from './ui';

export async function readDropped(file: File): Promise<DroppedFile> {
  try {
    if (isPdfFile(file.name)) {
      const lines = await readPdfLines(file);
      const paystub = extractPaystub(lines);
      if (paystub.commissionLines.length) return { fileName: file.name, paystub };
      return { fileName: file.name, tabs: [{ name: file.name, rows: linesToRows(lines) }] };
    }
    if (isExcelFile(file.name) || /\.(csv|xls)$/i.test(file.name)) {
      const { tabs } = await readSpreadsheetFile(file);
      return { fileName: file.name, tabs };
    }
    return { fileName: file.name, error: 'Only CSV, Excel (.xlsx), and PDF files can be added.' };
  } catch (e) {
    return { fileName: file.name, error: (e as Error).message || 'This file couldn’t be read.' };
  }
}

function shortReason(reason: string): string {
  if (/total/i.test(reason)) return 'totals row';
  if (/no plan/i.test(reason)) return 'year without a plan';
  if (/already|same date/i.test(reason)) return 'already added';
  return 'other';
}

function plural(n: number, word: string): string {
  return `${n} ${n === 1 ? word : `${word}s`}`;
}

function SourceSummary({ s }: { s: Source }) {
  if (s.kind === 'ignored') return <p className="muted small">{s.reason}</p>;
  if (s.kind === 'paystub') {
    if (s.payment) {
      return (
        <p className="small">
          Commission <span className="num">{formatCents(s.payment.amountCents)}</span> paid {formatDateLong(s.payment.paymentDate)}
          {s.paystub.negativeLabels.length > 0 && (
            <span className="muted"> · a negative line ({s.paystub.negativeLabels.join(', ')}) was left out</span>
          )}
        </p>
      );
    }
    return <p className="muted small">{s.problem ?? 'Waiting for the date question above.'}</p>;
  }
  const r = s.result;
  if (r.errors.length) {
    const rows = new Set(r.errors.map((e) => e.row)).size;
    return (
      <div className="small">
        <p className="field-error">
          Not added: {plural(rows, 'row')} {rows === 1 ? 'has' : 'have'} a problem. Fix {rows === 1 ? 'it' : 'them'} in the file and drop it again.
        </p>
        <ul className="error-list">
          {r.errors.slice(0, 5).map((e, i) => (
            <li key={i}>
              Row {e.row}: {e.message}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  const items = r.items as Array<{ amountCents?: string }>;
  const total = s.kind === 'payments' ? sumCents(items.map((p) => p.amountCents!)) : null;
  return (
    <p className="small">
      {s.kind === 'deals' ? plural(r.items.length, 'deal') : plural(r.items.length, 'payment')}
      {total && total.gt(0) && (
        <>
          , <span className="num">{formatCents(total)}</span> total
        </>
      )}
      {r.skipped.length > 0 && (
        <span className="muted">
          {' '}
          · {r.skipped.length} skipped ({[...new Set(r.skipped.map((x) => shortReason(x.reason)))].join(', ')})
        </span>
      )}
    </p>
  );
}

export function DropReview({
  files,
  onClose,
  onDone,
}: {
  files: DroppedFile[];
  onClose: () => void;
  onDone: (m: string, undoTo: Workspace) => void;
}) {
  const { ws, commit } = useStore();
  const [dateOrder, setDateOrder] = useState<DateOrder | null>(null);
  const [daysText, setDaysText] = useState('30');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bestGuesses, setBestGuesses] = useState(true);
  const days = /^\d{1,3}$/.test(daysText.trim()) ? Number(daysText) : null;
  const analysis = useMemo(() => analyzeDrop(files, ws, { dateOrder, expectedPaymentDays: days ?? 30 }), [files, ws, dateOrder, days]);
  // Keep the day/month question on screen once asked, so the answer can be changed.
  const [askOrder] = useState(() => analyzeDrop(files, ws, { dateOrder: null, expectedPaymentDays: 30 }).needsDateOrder);
  const deals = analysis.sources.flatMap((s) => sourceItems(s).deals).length;
  const payments = analysis.sources.flatMap((s) => sourceItems(s).payments).length;
  const estimatesDates = analysis.sources.some(
    (s) => s.kind === 'deals' && (s.mapping.expectedPaymentDate === null || s.mapping.expectedPaymentDate === undefined),
  );
  const blocked = analysis.needsDateOrder || (estimatesDates && days === null) || deals + payments === 0;

  const dupStubs = analysis.sources.filter((s) => s.kind === 'paystub' && s.problem === 'Already added.');
  const shown = analysis.sources.filter((s) => !dupStubs.includes(s));
  const what = [deals ? plural(deals, 'deal') : '', payments ? plural(payments, 'payment') : ''].filter(Boolean).join(' and ');

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const result = applyDrop(ws, analysis.sources, { includeBestGuesses: bestGuesses });
      await commit(result.workspace);
      onDone(dropMessage(analysis, result, days ?? 30), ws);
    } catch (e) {
      setError(`Nothing was added. ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="Here’s what we found" onClose={onClose} wide>
      <ul className="source-list" data-testid="drop-sources">
        {shown.map((s, i) => (
          <li key={i} className={`source source-${s.kind}`}>
            <p className="source-head">
              <span className={`badge badge-${s.kind === 'ignored' ? 'upcoming' : 'matched'}`}>
                {s.kind === 'deals' ? 'Deals' : s.kind === 'payments' ? 'Payments' : s.kind === 'paystub' ? 'Paystub' : 'Not used'}
              </span>{' '}
              <strong>{s.label}</strong>
            </p>
            <SourceSummary s={s} />
          </li>
        ))}
        {dupStubs.length > 0 && (
          <li className="source source-ignored">
            <p className="source-head">
              <span className="badge badge-upcoming">Already have</span>{' '}
              <strong>{plural(dupStubs.length, 'paystub')}</strong>
            </p>
            <p className="muted small">Same paychecks as in your other files or already added, so they’re skipped: {dupStubs.map((d) => d.label).join(', ')}.</p>
          </li>
        )}
      </ul>

      {askOrder && (
        <fieldset className={`date-order${dateOrder ? '' : ' has-error'}`}>
          <legend>Some dates could be read two ways. How should we read 01/02/2026?</legend>
          <div className="check-row">
            <input type="radio" id="drop-mdy" name="drop-order" checked={dateOrder === 'MDY'} onChange={() => setDateOrder('MDY')} />
            <label htmlFor="drop-mdy">January 2 (month first, US style)</label>
          </div>
          <div className="check-row">
            <input type="radio" id="drop-dmy" name="drop-order" checked={dateOrder === 'DMY'} onChange={() => setDateOrder('DMY')} />
            <label htmlFor="drop-dmy">February 1 (day first)</label>
          </div>
        </fieldset>
      )}

      {estimatesDates && (
        <div className={`field${days === null ? ' has-error' : ''}`}>
          <label htmlFor="drop-days">Commission is usually paid this many days after close</label>
          <p className="help" id="drop-days-help">
            Your deals file doesn’t say when each commission should be paid, so we estimate it. A commission isn’t counted as missing until then.
          </p>
          <input
            id="drop-days"
            className="input-short"
            inputMode="numeric"
            value={daysText}
            onChange={(e) => setDaysText(e.target.value)}
            aria-describedby="drop-days-help"
          />
        </div>
      )}

      {payments > 0 && (
        <div className="check-row">
          <input id="drop-guesses" type="checkbox" checked={bestGuesses} onChange={(e) => setBestGuesses(e.target.checked)} />
          <label htmlFor="drop-guesses">
            When a payment doesn’t add up exactly to any deals, make a best guess (the deals due closest to its date) and tell me which ones to
            check.
          </label>
        </div>
      )}
      <p className="muted small">Nothing is saved until you click below, and everything stays in this browser.</p>
      <FormError message={error} />
      <div className="actions">
        <button type="button" className="btn btn-primary" disabled={blocked || saving} onClick={() => void save()} data-testid="drop-confirm">
          {saving ? 'Adding…' : deals + payments ? `Add ${what}` : 'Nothing new to add'}
        </button>
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}

/**
 * One place to add everything: drag files in or choose them. Works out what
 * each file is, shows one review, and matches what adds up.
 */
export function DropZone({
  compact = false,
  onAdded,
}: {
  compact?: boolean;
  onAdded: (message: string, undoTo?: Workspace) => void;
}) {
  const { ws, commit } = useStore();
  const inputId = useId();
  const ref = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<DroppedFile[] | null>(null);

  async function take(list: File[]) {
    if (!list.length) return;
    setBusy(true);
    try {
      const read = await Promise.all(list.map(readDropped));
      // Only stop to ask when there's something to decide.
      const auto = autoDrop(read, ws);
      if (auto.kind === 'review') setFiles(read);
      else if (auto.kind === 'nothing') onAdded(auto.message);
      else {
        await commit(auto.workspace);
        onAdded(auto.message, ws);
      }
    } catch (e) {
      onAdded(`Nothing was added. ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    void take(Array.from(e.dataTransfer.files));
  }

  return (
    <div
      className={`dropzone${compact ? ' dropzone-compact' : ''}${dragging ? ' is-dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {compact ? (
        <p className="dropzone-title">
          <strong>Got a new paystub?</strong> <span className="muted">Drop it here, or</span>
        </p>
      ) : (
        <>
          <p className="dropzone-title">Drop your deals and paystubs here</p>
          <p className="muted">A CRM export or your own spreadsheet, plus your paystub PDFs. As many as you like at once.</p>
        </>
      )}
      <span className="file-picker">
        <label htmlFor={inputId} className={`btn ${compact ? 'btn-small' : 'btn-primary'}`} aria-disabled={busy || undefined}>
          {busy ? 'Reading files…' : compact ? 'Add files' : 'Choose files'}
        </label>
        <input
          ref={ref}
          id={inputId}
          type="file"
          multiple
          accept=".csv,.xlsx,.pdf,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="visually-hidden-file"
          data-testid="drop-files"
          onChange={(e) => {
            const list = Array.from(e.target.files ?? []);
            if (ref.current) ref.current.value = '';
            void take(list);
          }}
        />
      </span>
      {files && (
        <DropReview
          files={files}
          onClose={() => setFiles(null)}
          onDone={(m, undoTo) => {
            setFiles(null);
            onAdded(m, undoTo);
          }}
        />
      )}
    </div>
  );
}
