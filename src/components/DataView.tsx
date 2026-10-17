import { useRef, useState, type ChangeEvent } from 'react';
import { parseBackupJson, workspaceToBackupJson, type BackupPreview } from '../lib/backup';
import { reconcile } from '../lib/calc';
import {
  allocationsToCsv, dealsToCsv, dealTemplateCsv, paymentsToCsv, paymentTemplateCsv, reconciliationToCsv,
} from '../lib/csv';
import { formatDateShort, todayLocal } from '../lib/dates';
import { useStore } from '../state';
import { SpreadsheetImportButton } from './SpreadsheetImport';
import { downloadText, FormError, Modal } from './ui';

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

export function DataView({ year, asOf }: { year: number; asOf: string }) {
  const { ws, commit, mode } = useStore();
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
          <h2 className="h3">Deals</h2>
          <p className="muted">Import a CSV or Excel file, like a CRM export or your own tracker. You’ll match its columns before anything is saved. Deals you already have are skipped, never overwritten.</p>
          <div className="actions-inline">
            <button type="button" className="btn" onClick={() => downloadText(`${prefix}-deals-${stamp}.csv`, dealsToCsv(ws))} disabled={!ws.deals.length}>
              Export deals
            </button>
            <SpreadsheetImportButton kind="deals" label="Import deals…" />
            <button type="button" className="btn btn-quiet" onClick={() => downloadText('deals-template.csv', dealTemplateCsv())}>
              Template
            </button>
          </div>
        </article>

        <article className="panel">
          <h2 className="h3">Payments</h2>
          <p className="muted">Import payment lines from a CSV or Excel commission statement. Imported payments start unallocated; match them to deals afterward on the Payments tab.</p>
          <div className="actions-inline">
            <button type="button" className="btn" onClick={() => downloadText(`${prefix}-payments-${stamp}.csv`, paymentsToCsv(ws))} disabled={!ws.payments.length}>
              Export payments
            </button>
            <SpreadsheetImportButton kind="payments" label="Import payments…" />
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
