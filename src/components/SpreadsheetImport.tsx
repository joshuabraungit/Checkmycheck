import { useId, useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
  DEAL_COLUMNS, PAYMENT_COLUMNS, parseDealCsv, parsePaymentCsv, type ImportResult, type RowError,
} from '../lib/csv';
import { formatDateShort } from '../lib/dates';
import { formatCents, sumCents } from '../lib/money';
import { appendDeals, appendPayments } from '../lib/ops';
import { readSpreadsheetFile } from '../lib/readSpreadsheet';
import {
  buildDeals, buildPayments, buildSheet, columnLetter, DEFAULT_OPTIONS, dateValues, detectDateOrder, fieldsFor, guessMapping,
  headerSignature, pickTab, type DateOrder, type Field, type ImportKind, type ImportOptions, type Mapping, type Sheet, type Tab,
} from '../lib/sheetImport';
import type { Deal, Payment, Workspace } from '../lib/types';
import { useStore } from '../state';
import { FormError, Modal } from './ui';

const ACCEPT = '.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MEMORY_PREFIX = 'cmc-import:';

interface Remembered {
  columns: Partial<Record<Field, string | null>>;
  options: ImportOptions;
}

function recall(kind: ImportKind, sheet: Sheet): { mapping: Mapping; options: ImportOptions } | null {
  try {
    const raw = localStorage.getItem(MEMORY_PREFIX + headerSignature(kind, sheet.headers));
    if (!raw) return null;
    const saved = JSON.parse(raw) as Remembered;
    const mapping: Mapping = {};
    for (const f of fieldsFor(kind)) {
      const name = saved.columns[f.key];
      const idx = name ? sheet.headers.indexOf(name) : -1;
      mapping[f.key] = idx >= 0 ? idx : null;
    }
    return { mapping, options: { ...DEFAULT_OPTIONS, ...saved.options } };
  } catch {
    return null;
  }
}

function remember(kind: ImportKind, sheet: Sheet, mapping: Mapping, options: ImportOptions) {
  try {
    const columns: Remembered['columns'] = {};
    for (const f of fieldsFor(kind)) {
      const idx = mapping[f.key];
      columns[f.key] = idx === null || idx === undefined ? null : sheet.headers[idx];
    }
    localStorage.setItem(MEMORY_PREFIX + headerSignature(kind, sheet.headers), JSON.stringify({ columns, options }));
  } catch {
    /* remembering is a convenience only */
  }
}

function isOwnFormat(kind: ImportKind, rows: string[][]): boolean {
  const header = rows[0]?.map((h) => h.trim().toLowerCase()) ?? [];
  const expected: readonly string[] = kind === 'deals' ? DEAL_COLUMNS : PAYMENT_COLUMNS;
  return header.length === expected.length && expected.every((c) => header.includes(c));
}

function ProblemList({ errors, heading }: { errors: RowError[]; heading: string }) {
  return (
    <div className="form-error" role="alert">
      <p>
        <strong>{heading}</strong>
      </p>
      <ul className="error-list">
        {errors.slice(0, 30).map((e, i) => (
          <li key={i}>
            {e.row > 0 ? `Row ${e.row}: ` : ''}
            {e.message}
          </li>
        ))}
      </ul>
      {errors.length > 30 && <p>…and {errors.length - 30} more.</p>}
    </div>
  );
}

function DealPreview({ items }: { items: Deal[] }) {
  return (
    <div className="preview-wrap">
      <table className="preview-table">
        <thead>
          <tr>
            <th scope="col">Account</th>
            <th scope="col" className="r">
              Credited revenue
            </th>
            <th scope="col">Close</th>
            <th scope="col">Expected payment</th>
          </tr>
        </thead>
        <tbody>
          {items.slice(0, 100).map((d) => (
            <tr key={d.id}>
              <td>{d.account}</td>
              <td className="r num">{formatCents(d.creditedRevenueCents)}</td>
              <td>{formatDateShort(d.closeDate)}</td>
              <td>{formatDateShort(d.expectedPaymentDate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PaymentPreview({ items }: { items: Payment[] }) {
  return (
    <>
      <div className="preview-wrap">
        <table className="preview-table">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col" className="r">
                Amount
              </th>
              <th scope="col">Reference</th>
            </tr>
          </thead>
          <tbody>
            {items.slice(0, 100).map((p) => (
              <tr key={p.id}>
                <td>{formatDateShort(p.paymentDate)}</td>
                <td className="r num">{formatCents(p.amountCents)}</td>
                <td>{p.reference}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">Total: {formatCents(sumCents(items.map((p) => p.amountCents)))}</p>
    </>
  );
}

function useImportCommit(kind: ImportKind, onDone: (message: string) => void) {
  const { ws, commit } = useStore();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(items: Deal[] | Payment[], before?: () => void) {
    setSaving(true);
    setError(null);
    try {
      const next: Workspace = kind === 'deals' ? appendDeals(ws, items as Deal[]) : appendPayments(ws, items as Payment[]);
      await commit(next);
      before?.();
      onDone(`Imported ${items.length} ${items.length === 1 ? kind.slice(0, -1) : kind}.`);
    } catch (e) {
      setError(`Not imported. ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }
  return { ws, saving, error, save };
}

/** Import for files in this app's own export format (keeps IDs and same-day order). */
function OwnFormatDialog({
  kind, fileName, result, onClose, onDone,
}: { kind: ImportKind; fileName: string; result: ImportResult<Deal | Payment>; onClose: () => void; onDone: (m: string) => void }) {
  const { saving, error, save } = useImportCommit(kind, onDone);
  return (
    <Modal title={`Import ${kind} from ${fileName}`} onClose={onClose} wide>
      {!result.ok ? (
        <>
          <ProblemList errors={result.errors} heading="Nothing was imported. Fix these problems in the file and try again:" />
          <div className="actions">
            <button type="button" className="btn" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      ) : (
        <>
          <p>
            This file is in Check My Check’s own format. {result.items.length} {kind} ready to import, with their IDs kept. Nothing is saved
            until you confirm.
          </p>
          {kind === 'payments' && <p className="notice notice-amber">Imported payments start unallocated. Match them to deals afterward.</p>}
          {kind === 'deals' ? <DealPreview items={result.items as Deal[]} /> : <PaymentPreview items={result.items as Payment[]} />}
          <FormError message={error} />
          <div className="actions">
            <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void save(result.items as Deal[] | Payment[])}>
              Import {result.items.length} {kind}
            </button>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

function sampleFor(sheet: Sheet, col: number): string {
  const v = sheet.rows.find((r) => r[col]?.trim())?.[col] ?? '';
  return v.length > 24 ? `${v.slice(0, 23)}…` : v;
}

/** Match columns, settle ambiguous dates, preview, and import one tab. */
function MappingBody({
  kind, fileName, sheet, onClose, onDone,
}: { kind: ImportKind; fileName: string; sheet: Sheet; onClose: () => void; onDone: (m: string) => void }) {
  const { ws, saving, error, save } = useImportCommit(kind, onDone);
  const remembered = useMemo(() => recall(kind, sheet), [kind, sheet]);
  const [mapping, setMapping] = useState<Mapping>(() => remembered?.mapping ?? guessMapping(kind, sheet.headers));
  const [options, setOptions] = useState<ImportOptions>(() => remembered?.options ?? DEFAULT_OPTIONS);
  const [daysText, setDaysText] = useState(String(options.expectedPaymentDays));
  const idBase = useId();
  const fields = fieldsFor(kind);

  const detection = useMemo(() => detectDateOrder(dateValues(kind, sheet, mapping)), [kind, sheet, mapping]);
  const dateOrder: DateOrder | null = detection.needsChoice ? options.dateOrder : detection.order ?? options.dateOrder;
  const days = /^\d{1,3}$/.test(daysText.trim()) ? Number(daysText) : null;
  const effective: ImportOptions = { ...options, dateOrder, expectedPaymentDays: days ?? 0 };

  const result = useMemo(
    () => (kind === 'deals' ? buildDeals(sheet, mapping, effective, ws) : buildPayments(sheet, mapping, effective, ws)),
    [kind, sheet, mapping, effective.dateOrder, effective.expectedPaymentDays, effective.skipExisting, effective.skipOtherYears, ws],
  );
  const needsOrder = detection.needsChoice && !options.dateOrder;
  const daysInvalid = kind === 'deals' && days === null;
  const blocked = result.missingFields.length > 0 || needsOrder || daysInvalid || result.errors.length > 0 || result.items.length === 0;
  const noun = kind === 'deals' ? 'deal' : 'payment';
  const plural = (n: number) => `${n} ${n === 1 ? noun : `${noun}s`}`;

  function setField(field: Field, value: string) {
    setMapping((m) => {
      const next = { ...m };
      const col = value === '' ? null : Number(value);
      // A column feeds one field; picking it here clears it elsewhere.
      if (col !== null) for (const f of fields) if (next[f.key] === col) next[f.key] = null;
      next[field] = col;
      return next;
    });
  }

  return (
    <>
      <p className="muted">
        <strong>{fileName}</strong>: {sheet.rows.length} {sheet.rows.length === 1 ? 'row' : 'rows'}
        {sheet.headerRowNumber > 1 ? `, using row ${sheet.headerRowNumber} for column names` : ''}.{' '}
        {remembered ? 'We used the column choices from your last import of this layout.' : 'We matched the columns we could. Check them below.'}
      </p>

      <fieldset className="map-fields">
        <legend>Match your columns</legend>
        {fields.map((f) => {
          const id = `${idBase}-${f.key}`;
          const unmappedRequired = f.required && (mapping[f.key] === null || mapping[f.key] === undefined);
          return (
            <div className={`map-row${unmappedRequired ? ' has-error' : ''}`} key={f.key}>
              <label htmlFor={id}>
                {f.label}
                {f.required ? <span className="req"> (required)</span> : <span className="muted"> (optional)</span>}
              </label>
              <select id={id} value={mapping[f.key] ?? ''} onChange={(e) => setField(f.key, e.target.value)} aria-invalid={unmappedRequired || undefined}>
                <option value="">{f.required ? 'Choose a column…' : 'Not in this file'}</option>
                {sheet.headers.map((h, i) => {
                  const sample = sampleFor(sheet, i);
                  return (
                    <option key={i} value={i}>
                      {columnLetter(i)}: {h}
                      {sample ? ` (e.g. ${sample})` : ''}
                    </option>
                  );
                })}
              </select>
            </div>
          );
        })}
      </fieldset>

      {kind === 'deals' && (
        <div className={`field${daysInvalid ? ' has-error' : ''}`}>
          <label htmlFor={`${idBase}-days`}>
            {mapping.expectedPaymentDate === null || mapping.expectedPaymentDate === undefined
              ? 'Expected payment date: days after close'
              : 'When the expected payment date is blank: days after close'}
          </label>
          <p className="help" id={`${idBase}-days-help`}>
            Your file doesn’t always say when each commission should be paid, so we estimate it from the close date. You can edit any deal later.
          </p>
          <input
            id={`${idBase}-days`}
            className="input-short"
            inputMode="numeric"
            value={daysText}
            onChange={(e) => {
              setDaysText(e.target.value);
              if (/^\d{1,3}$/.test(e.target.value.trim())) setOptions((o) => ({ ...o, expectedPaymentDays: Number(e.target.value) }));
            }}
            aria-describedby={`${idBase}-days-help`}
            aria-invalid={daysInvalid || undefined}
          />
          {daysInvalid && <p className="field-error">Enter a whole number of days, like 30.</p>}
        </div>
      )}

      {detection.needsChoice && (
        <fieldset className={`date-order${needsOrder ? ' has-error' : ''}`}>
          <legend>Some dates could be read two ways. How should we read 01/02/2026?</legend>
          <div className="check-row">
            <input
              type="radio"
              id={`${idBase}-mdy`}
              name={`${idBase}-order`}
              checked={options.dateOrder === 'MDY'}
              onChange={() => setOptions((o) => ({ ...o, dateOrder: 'MDY' }))}
            />
            <label htmlFor={`${idBase}-mdy`}>January 2 (month first, US style)</label>
          </div>
          <div className="check-row">
            <input
              type="radio"
              id={`${idBase}-dmy`}
              name={`${idBase}-order`}
              checked={options.dateOrder === 'DMY'}
              onChange={() => setOptions((o) => ({ ...o, dateOrder: 'DMY' }))}
            />
            <label htmlFor={`${idBase}-dmy`}>February 1 (day first)</label>
          </div>
        </fieldset>
      )}

      <div className="import-options">
        <div className="check-row">
          <input
            id={`${idBase}-skip-existing`}
            type="checkbox"
            checked={options.skipExisting}
            onChange={(e) => setOptions((o) => ({ ...o, skipExisting: e.target.checked }))}
          />
          <label htmlFor={`${idBase}-skip-existing`}>
            {kind === 'deals'
              ? 'Skip deals I already have (same reference or ID)'
              : 'Skip payments I already have (same date, amount, and reference)'}
          </label>
        </div>
        {kind === 'deals' && (
          <div className="check-row">
            <input
              id={`${idBase}-skip-years`}
              type="checkbox"
              checked={options.skipOtherYears}
              onChange={(e) => setOptions((o) => ({ ...o, skipOtherYears: e.target.checked }))}
            />
            <label htmlFor={`${idBase}-skip-years`}>Skip deals that closed in a year without a plan</label>
          </div>
        )}
      </div>

      <div className="import-summary" role="status" aria-live="polite" data-testid="import-summary">
        {result.missingFields.length > 0 ? (
          <p>Choose a column for: {result.missingFields.join(', ')}.</p>
        ) : needsOrder ? (
          <p>Choose how to read dates like 01/02/2026 to see the preview.</p>
        ) : (
          <p>
            <strong>{plural(result.items.length)} ready</strong>
            {result.skipped.length > 0 && <> · {result.skipped.length} skipped</>}
            {result.errors.length > 0 && (
              <>
                {' '}
                · <span className="diff-short">{new Set(result.errors.map((e) => e.row)).size} with problems</span>
              </>
            )}
          </p>
        )}
      </div>

      {!result.missingFields.length && !needsOrder && result.errors.length > 0 && (
        <ProblemList
          errors={result.errors}
          heading="Fix these rows in the file, change a column above, or turn on a skip option. Nothing imports until every row is OK."
        />
      )}
      {result.skipped.length > 0 && (
        <details className="skipped">
          <summary>See skipped rows</summary>
          <ul className="error-list">
            {result.skipped.slice(0, 50).map((s) => (
              <li key={s.row}>
                Row {s.row}: {s.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
      {result.items.length > 0 && !needsOrder && (
        <>
          {kind === 'deals' ? <DealPreview items={result.items as Deal[]} /> : <PaymentPreview items={result.items as Payment[]} />}
          {kind === 'payments' && (
            <p className="notice notice-amber">Imported payments start unallocated. Match each one to the deals it paid for afterward.</p>
          )}
        </>
      )}

      <FormError message={error} />
      <div className="actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={blocked || saving}
          onClick={() => void save(result.items as Deal[] | Payment[], () => remember(kind, sheet, mapping, effective))}
        >
          {saving ? 'Importing…' : `Import ${plural(result.items.length)}`}
        </button>
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </>
  );
}

/** Tab picker around the column matching. Switching tabs starts matching fresh for that tab. */
function MappingDialog({
  kind, fileName, tabs, onClose, onDone,
}: { kind: ImportKind; fileName: string; tabs: Tab[]; onClose: () => void; onDone: (m: string) => void }) {
  const [tab, setTab] = useState(() => pickTab(kind, tabs));
  const tabId = useId();
  const built = useMemo(() => buildSheet(tabs[tab].rows), [tabs, tab]);
  return (
    <Modal title={`Import ${kind} from a spreadsheet`} onClose={onClose} wide>
      {tabs.length > 1 && (
        <div className="field">
          <label htmlFor={tabId}>Which tab has your {kind}?</label>
          <p className="help" id={`${tabId}-help`}>
            This file has {tabs.length} tabs. We picked the one that looks most like {kind}.
          </p>
          <select id={tabId} value={tab} onChange={(e) => setTab(Number(e.target.value))} aria-describedby={`${tabId}-help`}>
            {tabs.map((t, i) => (
              <option key={i} value={i}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {'error' in built ? (
        <>
          <p className="form-error" role="alert">
            {tabs.length > 1 ? `The “${tabs[tab].name}” tab can’t be imported. ` : ''}
            {built.error}
          </p>
          <div className="actions">
            <button type="button" className="btn" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      ) : (
        <MappingBody key={tab} kind={kind} fileName={fileName} sheet={built} onClose={onClose} onDone={onDone} />
      )}
    </Modal>
  );
}

type Opened =
  | { mode: 'own'; fileName: string; result: ImportResult<Deal | Payment> }
  | { mode: 'map'; fileName: string; tabs: Tab[] }
  | { mode: 'error'; fileName: string; message: string };

/**
 * A button that opens a CSV or Excel file and walks through importing it.
 * Files in this app's own export format keep their IDs; anything else goes
 * through column matching.
 */
export function SpreadsheetImportButton({ kind, label, className = 'btn' }: { kind: ImportKind; label: string; className?: string }) {
  const { ws } = useStore();
  const inputId = useId();
  const ref = useRef<HTMLInputElement>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [reading, setReading] = useState(false);

  async function onChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (ref.current) ref.current.value = '';
    if (!file) return;
    setStatus(null);
    setReading(true);
    try {
      const { tabs, text } = await readSpreadsheetFile(file);
      if (text !== null && isOwnFormat(kind, tabs[0].rows)) {
        const result = kind === 'deals' ? parseDealCsv(text, ws) : parsePaymentCsv(text, ws);
        setOpened({ mode: 'own', fileName: file.name, result });
        return;
      }
      const usable = tabs.filter((t) => !('error' in buildSheet(t.rows)));
      if (!usable.length) {
        const first = buildSheet(tabs[0].rows);
        setOpened({ mode: 'error', fileName: file.name, message: 'error' in first ? first.error : 'This file couldn’t be read.' });
      } else {
        setOpened({ mode: 'map', fileName: file.name, tabs: usable });
      }
    } catch (err) {
      setOpened({ mode: 'error', fileName: file.name, message: (err as Error).message || 'This file couldn’t be read.' });
    } finally {
      setReading(false);
    }
  }

  const close = () => setOpened(null);
  const done = (message: string) => {
    setOpened(null);
    setStatus(message);
  };

  return (
    <span className="import-button">
      <span className="file-picker">
        <label htmlFor={inputId} className={className} aria-disabled={reading || undefined}>
          {reading ? 'Reading file…' : label}
        </label>
        <input
          ref={ref}
          id={inputId}
          type="file"
          accept={ACCEPT}
          className="visually-hidden-file"
          data-testid={`import-${kind}`}
          onChange={(e) => void onChange(e)}
        />
      </span>
      {status && (
        <span className="import-status success" role="status">
          {status}
        </span>
      )}
      {opened?.mode === 'own' && <OwnFormatDialog kind={kind} fileName={opened.fileName} result={opened.result} onClose={close} onDone={done} />}
      {opened?.mode === 'map' && <MappingDialog kind={kind} fileName={opened.fileName} tabs={opened.tabs} onClose={close} onDone={done} />}
      {opened?.mode === 'error' && (
        <Modal title={`Couldn’t import ${opened.fileName}`} onClose={close}>
          <p role="alert">{opened.message}</p>
          <p className="muted">CSV and Excel (.xlsx) files work. The first rows should include column names.</p>
          <div className="actions">
            <button type="button" className="btn" onClick={close}>
              Close
            </button>
          </div>
        </Modal>
      )}
    </span>
  );
}
