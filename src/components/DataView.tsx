import { useRef, useState, type ChangeEvent } from 'react';
import { parseBackupJson, workspaceToBackupJson, type BackupPreview } from '../lib/backup';
import { reconcile } from '../lib/calc';
import {
  allocationsToCsv, dealsToCsv, dealTemplateCsv, parseDealCsv, parsePaymentCsv, paymentsToCsv, paymentTemplateCsv,
  reconciliationToCsv, type RowError,
} from '../lib/csv';
import { formatDateShort, todayLocal } from '../lib/dates';
import { formatCents, sumCents } from '../lib/money';
import { appendDeals, appendPayments } from '../lib/ops';
import type { Deal, Payment } from '../lib/types';
import { useStore } from '../state';
import { downloadText, FormError, Modal } from './ui';

function ErrorList({ errors }: { errors: RowError[] }) {
  return (
    <div className="form-error" role="alert">
      <p>
        <strong>Nothing was imported.</strong> Fix these {errors.length === 1 ? 'problem' : 'problems'} in the file and try again:
      </p>
      <ul className="error-list">
        {errors.slice(0, 50).map((e, i) => (
          <li key={i}>
            {e.row > 0 ? `Row ${e.row}: ` : ''}
            {e.message}
          </li>
        ))}
      </ul>
      {errors.length > 50 && <p>…and {errors.length - 50} more.</p>}
    </div>
  );
}

function FilePicker({ id, label, accept, onText }: { id: string; label: string; accept: string; onText: (text: string, name: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  async function onChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    if (ref.current) ref.current.value = '';
    onText(text, file.name);
  }
  return (
    <div className="file-picker">
      <label htmlFor={id} className="btn">
        {label}
      </label>
      <input ref={ref} id={id} type="file" accept={accept} className="visually-hidden-file" onChange={(e) => void onChange(e)} />
    </div>
  );
}

type ImportState =
  | { kind: 'deals'; ok: true; items: Deal[]; fileName: string }
  | { kind: 'payments'; ok: true; items: Payment[]; fileName: string }
  | { kind: 'deals' | 'payments'; ok: false; errors: RowError[]; fileName: string };

export function DataView({ year, asOf }: { year: number; asOf: string }) {
  const { ws, commit, mode } = useStore();
  const [importState, setImportState] = useState<ImportState | null>(null);
  const [restore, setRestore] = useState<{ preview: BackupPreview; fileName: string } | null>(null);
  const [restoreErrors, setRestoreErrors] = useState<string[] | null>(null);
  const [restoreConfirmed, setRestoreConfirmed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const stamp = todayLocal();
  const prefix = mode === 'demo' ? 'check-my-check-EXAMPLE' : 'check-my-check';

  function exportBackup() {
    downloadText(`${prefix}-backup-${stamp}.json`, workspaceToBackupJson(ws), 'application/json');
  }

  async function confirmImport() {
    if (!importState || !importState.ok) return;
    setSaving(true);
    setError(null);
    try {
      const next = importState.kind === 'deals' ? appendDeals(ws, importState.items) : appendPayments(ws, importState.items);
      await commit(next);
      setMessage(`Imported ${importState.items.length} ${importState.kind}.`);
      setImportState(null);
    } catch (e) {
      setError(`Not imported. ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  async function confirmRestore() {
    if (!restore) return;
    setSaving(true);
    setError(null);
    try {
      await commit(restore.preview.workspace);
      setMessage(`Restored the backup from ${restore.fileName}.`);
      setRestore(null);
    } catch (e) {
      setError(`Not restored. ${(e as Error).message} Your current data is unchanged.`);
    } finally {
      setSaving(false);
    }
  }

  const rec = reconcile(ws, year, asOf);

  return (
    <section>
      <h1>Backup &amp; files</h1>
      <div className="notice" role="note">
        <p>
          Everything you enter is stored only in this browser on this device. Clearing browser data, using a private window, or switching
          browsers means it won’t be there. Export a backup regularly and keep it somewhere safe.
        </p>
      </div>
      {message && (
        <p className="success" role="status">
          {message}
        </p>
      )}
      <FormError message={error} />

      <div className="data-grid">
        <article className="panel">
          <h2 className="h3">Full backup</h2>
          <p className="muted">One file with your plans, deals, payments, and allocations. Use it to restore everything later.</p>
          <div className="actions-inline">
            <button type="button" className="btn btn-primary" onClick={exportBackup}>
              Export backup
            </button>
            <FilePicker
              id="restore-file"
              label="Restore from backup…"
              accept=".json,application/json"
              onText={(text, fileName) => {
                setMessage(null);
                const result = parseBackupJson(text);
                setRestoreConfirmed(false);
                if (result.ok) {
                  setRestoreErrors(null);
                  setRestore({ preview: result.preview, fileName });
                } else {
                  setRestore(null);
                  setRestoreErrors(result.errors);
                }
              }}
            />
          </div>
          {restoreErrors && (
            <div className="form-error" role="alert">
              <p>
                <strong>This backup can’t be restored.</strong> Your current data is unchanged.
              </p>
              <ul className="error-list">
                {restoreErrors.slice(0, 20).map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          )}
        </article>

        <article className="panel">
          <h2 className="h3">Deals (CSV)</h2>
          <p className="muted">Import adds new deals to existing plan years. Rows with an existing deal ID are blocked, not overwritten.</p>
          <div className="actions-inline">
            <button type="button" className="btn" onClick={() => downloadText(`${prefix}-deals-${stamp}.csv`, dealsToCsv(ws))} disabled={!ws.deals.length}>
              Export deals
            </button>
            <FilePicker
              id="deal-csv"
              label="Import deals…"
              accept=".csv,text/csv"
              onText={(text, fileName) => {
                setMessage(null);
                const r = parseDealCsv(text, ws);
                setImportState(r.ok ? { kind: 'deals', ok: true, items: r.items, fileName } : { kind: 'deals', ok: false, errors: r.errors, fileName });
              }}
            />
            <button type="button" className="btn btn-quiet" onClick={() => downloadText('deals-template.csv', dealTemplateCsv())}>
              Template
            </button>
          </div>
        </article>

        <article className="panel">
          <h2 className="h3">Payments (CSV)</h2>
          <p className="muted">Imported payments start unallocated. Match them to deals afterward on the Payments tab.</p>
          <div className="actions-inline">
            <button type="button" className="btn" onClick={() => downloadText(`${prefix}-payments-${stamp}.csv`, paymentsToCsv(ws))} disabled={!ws.payments.length}>
              Export payments
            </button>
            <FilePicker
              id="payment-csv"
              label="Import payments…"
              accept=".csv,text/csv"
              onText={(text, fileName) => {
                setMessage(null);
                const r = parsePaymentCsv(text, ws);
                setImportState(
                  r.ok ? { kind: 'payments', ok: true, items: r.items, fileName } : { kind: 'payments', ok: false, errors: r.errors, fileName },
                );
              }}
            />
            <button type="button" className="btn btn-quiet" onClick={() => downloadText('payments-template.csv', paymentTemplateCsv())}>
              Template
            </button>
          </div>
        </article>

        <article className="panel">
          <h2 className="h3">Reports (CSV)</h2>
          <p className="muted">
            Reconciliation uses the {year} plan as of {formatDateShort(asOf)} (change these on the Overview).
          </p>
          <div className="actions-inline">
            <button
              type="button"
              className="btn"
              onClick={() => downloadText(`${prefix}-reconciliation-${year}-as-of-${asOf}.csv`, reconciliationToCsv(rec.rows, asOf, year))}
            >
              Export reconciliation
            </button>
            <button type="button" className="btn" onClick={() => downloadText(`${prefix}-allocations-${stamp}.csv`, allocationsToCsv(ws))} disabled={!ws.allocations.length}>
              Export allocations
            </button>
          </div>
        </article>
      </div>

      {importState && (
        <Modal title={`Import ${importState.kind} from ${importState.fileName}`} onClose={() => setImportState(null)} wide>
          {!importState.ok ? (
            <>
              <ErrorList errors={importState.errors} />
              <div className="actions">
                <button type="button" className="btn" onClick={() => setImportState(null)}>
                  Close
                </button>
              </div>
            </>
          ) : (
            <>
              <p>
                {importState.items.length} {importState.kind} ready to import. Nothing is saved until you confirm.
              </p>
              {importState.kind === 'payments' && (
                <p className="notice notice-amber">
                  Imported payments start unallocated. After importing, open each one on the Payments tab and match it to the deals it paid for.
                </p>
              )}
              <div className="preview-wrap">
                <table className="preview-table">
                  {importState.kind === 'deals' ? (
                    <>
                      <thead>
                        <tr>
                          <th scope="col">Account</th>
                          <th scope="col" className="r">Credited revenue</th>
                          <th scope="col">Close</th>
                          <th scope="col">Expected payment</th>
                        </tr>
                      </thead>
                      <tbody>
                        {importState.items.slice(0, 100).map((d) => (
                          <tr key={d.id}>
                            <td>{d.account}</td>
                            <td className="r num">{formatCents(d.creditedRevenueCents)}</td>
                            <td>{formatDateShort(d.closeDate)}</td>
                            <td>{formatDateShort(d.expectedPaymentDate)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </>
                  ) : (
                    <>
                      <thead>
                        <tr>
                          <th scope="col">Date</th>
                          <th scope="col" className="r">Amount</th>
                          <th scope="col">Reference</th>
                        </tr>
                      </thead>
                      <tbody>
                        {importState.items.slice(0, 100).map((p) => (
                          <tr key={p.id}>
                            <td>{formatDateShort(p.paymentDate)}</td>
                            <td className="r num">{formatCents(p.amountCents)}</td>
                            <td>{p.reference}</td>
                          </tr>
                        ))}
                      </tbody>
                    </>
                  )}
                </table>
              </div>
              {importState.kind === 'payments' && (
                <p className="muted">
                  Total: {formatCents(sumCents(importState.items.map((p) => p.amountCents)))}
                </p>
              )}
              <FormError message={error} />
              <div className="actions">
                <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void confirmImport()}>
                  Import {importState.items.length} {importState.kind}
                </button>
                <button type="button" className="btn" onClick={() => setImportState(null)}>
                  Cancel
                </button>
              </div>
            </>
          )}
        </Modal>
      )}

      {restore && (
        <Modal title="Restore this backup?" onClose={() => setRestore(null)} wide>
          <p>
            <strong>{restore.fileName}</strong>
            {restore.preview.exportedAt ? ` (exported ${restore.preview.exportedAt.slice(0, 10)})` : ''} contains:
          </p>
          <dl className="impact-grid">
            <div>
              <dt>Plans</dt>
              <dd className="num">{restore.preview.counts.plans}</dd>
            </div>
            <div>
              <dt>Deals</dt>
              <dd className="num">{restore.preview.counts.deals}</dd>
            </div>
            <div>
              <dt>Payments</dt>
              <dd className="num">{restore.preview.counts.payments}</dd>
            </div>
            <div>
              <dt>Allocations</dt>
              <dd className="num">{restore.preview.counts.allocations}</dd>
            </div>
          </dl>
          <div className="notice notice-amber">
            <p>
              Restoring replaces everything currently in {mode === 'demo' ? 'this example workspace' : 'your tracker'} ({ws.plans.length} plans,{' '}
              {ws.deals.length} deals, {ws.payments.length} payments). Save a copy of your current data first if you might want it back.
            </p>
            <button type="button" className="btn btn-small" onClick={exportBackup}>
              Download current data first
            </button>
          </div>
          <div className="check-row">
            <input id="restore-confirm" type="checkbox" checked={restoreConfirmed} onChange={(e) => setRestoreConfirmed(e.target.checked)} />
            <label htmlFor="restore-confirm">Replace my current data with this backup</label>
          </div>
          <FormError message={error} />
          <div className="actions">
            <button type="button" className="btn btn-danger" disabled={!restoreConfirmed || saving} onClick={() => void confirmRestore()}>
              Restore backup
            </button>
            <button type="button" className="btn" onClick={() => setRestore(null)} data-autofocus>
              Cancel
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
