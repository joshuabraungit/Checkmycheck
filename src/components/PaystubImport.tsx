import { useMemo, useState } from 'react';
import { formatDateLong, isValidDate } from '../lib/dates';
import { centsToInput, formatCents, parseMoneyInput, sumCents } from '../lib/money';
import { appendPayments } from '../lib/ops';
import { groupLines, parsePaystubDates, type PaystubResult, type PdfLine } from '../lib/pdfText';
import type { DateOrder } from '../lib/sheetImport';
import { newId, type Payment } from '../lib/types';
import { useStore } from '../state';
import { FormError, Modal } from './ui';

export interface Paystub {
  fileName: string;
  result: PaystubResult;
}

export class PdfReadError extends Error {}

/** Read a PDF's text as lines. Scanned (image-only) PDFs have no text to read. */
export async function readPdfLines(file: File): Promise<PdfLine[]> {
  let items;
  try {
    const { readPdfText } = await import('../lib/readPdf');
    items = await readPdfText(await file.arrayBuffer());
  } catch {
    throw new PdfReadError(`${file.name} couldn’t be opened as a PDF. If it’s password protected, save an unlocked copy and try again.`);
  }
  if (!items.some((i) => i.str.trim())) {
    throw new PdfReadError(
      `${file.name} looks like a scanned image, so there’s no text to read. Try downloading the PDF from your payroll portal instead of scanning it, or enter the payment by hand.`,
    );
  }
  return groupLines(items);
}

function baseName(name: string): string {
  return name.replace(/\.pdf$/i, '');
}

/** Review the commission found on one or more paystubs, fix anything, and import as payments. */
export function PaystubDialog({ stubs, onClose, onDone }: { stubs: Paystub[]; onClose: () => void; onDone: (m: string) => void }) {
  const { ws, commit } = useStore();
  const [order, setOrder] = useState<DateOrder | null>(null);
  const parsedDates = useMemo(() => parsePaystubDates(stubs.map((s) => s.result.payDateRaw), order), [stubs, order]);
  const [dateEdits, setDateEdits] = useState<Record<number, string>>({});
  const [amounts, setAmounts] = useState<string[]>(() =>
    stubs.map((s) => (s.result.commissionLines.length ? centsToInput(sumCents(s.result.commissionLines.map((l) => l.amountCents)).toFixed(0)) : '')),
  );
  const [excluded, setExcluded] = useState<Set<number>>(() => new Set(stubs.flatMap((s, i) => (s.result.commissionLines.length ? [] : [i]))));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rows = stubs.map((s, i) => {
    const date = dateEdits[i] ?? parsedDates.dates[i] ?? '';
    const money = parseMoneyInput(amounts[i] ?? '', 'Amount');
    const reference = /pay\s*stub/i.test(s.fileName) ? baseName(s.fileName) : `Paystub ${baseName(s.fileName)}`;
    const duplicate =
      isValidDate(date) &&
      money.ok &&
      ws.payments.some((p) => p.paymentDate === date && p.amountCents === money.value && p.reference.trim().toLowerCase() === reference.toLowerCase());
    const problem = !isValidDate(date) ? 'Enter the pay date.' : !money.ok ? money.error : duplicate ? 'You already imported this paystub.' : null;
    return { stub: s, date, money, reference, duplicate, problem, included: !excluded.has(i) };
  });
  const needsOrder = parsedDates.needsChoice && !order && stubs.some((_, i) => !dateEdits[i]);
  const chosen = rows.filter((r) => r.included);
  const blocked = needsOrder || !chosen.length || chosen.some((r) => r.problem);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const payments: Payment[] = chosen.map((r) => ({
        id: newId(),
        paymentDate: r.date,
        amountCents: (r.money as { value: string }).value,
        reference: r.reference,
        notes: r.stub.result.commissionLines.map((l) => `${l.label}: ${formatCents(l.amountCents)}`).join('; '),
      }));
      await commit(appendPayments(ws, payments));
      onDone(`Imported ${payments.length} ${payments.length === 1 ? 'payment' : 'payments'} from paystubs.`);
    } catch (e) {
      setError(`Not imported. ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={stubs.length === 1 ? 'Import commission from a paystub' : `Import commission from ${stubs.length} paystubs`}
      onClose={onClose}
      wide
      description="We read the pay date and the current-period commission lines. Salary, taxes, and year-to-date totals are left out. Check each one before importing."
    >
      {parsedDates.needsChoice && (
        <fieldset className={`date-order${needsOrder ? ' has-error' : ''}`}>
          <legend>Some pay dates could be read two ways. How should we read 03/01/2026?</legend>
          <div className="check-row">
            <input type="radio" id="stub-mdy" name="stub-order" checked={order === 'MDY'} onChange={() => setOrder('MDY')} />
            <label htmlFor="stub-mdy">March 1 (month first, US style)</label>
          </div>
          <div className="check-row">
            <input type="radio" id="stub-dmy" name="stub-order" checked={order === 'DMY'} onChange={() => setOrder('DMY')} />
            <label htmlFor="stub-dmy">January 3 (day first)</label>
          </div>
        </fieldset>
      )}
      <ul className="stub-list">
        {rows.map((r, i) => {
          const noCommission = !r.stub.result.commissionLines.length;
          return (
            <li key={i} className="stub-item" data-testid="paystub-row">
              <div className="check-row">
                <input
                  id={`stub-${i}`}
                  type="checkbox"
                  checked={r.included}
                  onChange={(e) =>
                    setExcluded((s) => {
                      const next = new Set(s);
                      if (e.target.checked) next.delete(i);
                      else next.add(i);
                      return next;
                    })
                  }
                />
                <label htmlFor={`stub-${i}`}>
                  <strong>{r.stub.fileName}</strong>
                </label>
              </div>
              {noCommission ? (
                <p className="muted small">
                  No commission line found on this paystub. If there should be one, enter the amount below and include it.
                </p>
              ) : (
                <p className="muted small">
                  Found {r.stub.result.commissionLines.map((l) => `${l.label} ${formatCents(l.amountCents)}`).join(', ')}
                  {r.stub.result.payDateRaw ? ` · pay date printed as “${r.stub.result.payDateRaw}”` : ''}.
                </p>
              )}
              {r.stub.result.negativeLabels.length > 0 && (
                <p className="notice notice-amber small">
                  Also found a negative commission line ({r.stub.result.negativeLabels.join(', ')}). Clawbacks and reversals aren’t
                  supported, so it isn’t included. Worth asking payroll about.
                </p>
              )}
              <div className="stub-fields">
                <div className="field">
                  <label htmlFor={`stub-date-${i}`}>Pay date</label>
                  <input
                    id={`stub-date-${i}`}
                    type="date"
                    value={r.date}
                    onChange={(e) => setDateEdits((d) => ({ ...d, [i]: e.target.value }))}
                  />
                </div>
                <div className="field">
                  <label htmlFor={`stub-amt-${i}`}>Gross commission ($)</label>
                  <input
                    id={`stub-amt-${i}`}
                    inputMode="decimal"
                    value={amounts[i]}
                    onChange={(e) => setAmounts((a) => a.map((v, j) => (j === i ? e.target.value : v)))}
                  />
                </div>
              </div>
              {r.included && r.problem && <p className="field-error">{r.problem}</p>}
              {r.included && !r.problem && (
                <p className="small">
                  Will import <span className="num">{formatCents((r.money as { value: string }).value)}</span> paid {formatDateLong(r.date)}.
                </p>
              )}
            </li>
          );
        })}
      </ul>
      <p className="muted small">Imported payments start unmatched. Use “Match automatically” on the Payments tab afterward.</p>
      <FormError message={error} />
      <div className="actions">
        <button type="button" className="btn btn-primary" disabled={blocked || saving} onClick={() => void save()}>
          {saving ? 'Importing…' : `Import ${chosen.length} ${chosen.length === 1 ? 'payment' : 'payments'}`}
        </button>
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
