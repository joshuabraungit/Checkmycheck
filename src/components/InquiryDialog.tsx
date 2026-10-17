import { useMemo, useState } from 'react';
import type { DealReconciliation } from '../lib/calc';
import { buildInquiry } from '../lib/inquiry';
import { formatCents, type Dec } from '../lib/money';
import { SignedDifference } from './Dashboard';
import { copyText, Modal } from './ui';

const NAME_KEY = 'cmc-sender-name';

function readName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

export function InquiryDialog({
  rows,
  asOf,
  unallocatedCents,
  onClose,
}: {
  rows: DealReconciliation[];
  asOf: string;
  unallocatedCents: Dec;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(rows.map((r) => r.deal.id)));
  const [recipient, setRecipient] = useState('');
  const [sender, setSender] = useState(readName);
  const [copyState, setCopyState] = useState<'idle' | 'confirm' | 'copied' | 'failed'>('idle');
  const hasUnallocated = unallocatedCents.gt(0);

  const chosen = rows.filter((r) => selected.has(r.deal.id));
  const text = useMemo(
    () => (chosen.length ? buildInquiry({ recipientName: recipient, senderName: sender, asOf, rows: chosen, unallocatedCents }) : ''),
    [chosen, recipient, sender, asOf, unallocatedCents],
  );

  async function doCopy() {
    try {
      localStorage.setItem(NAME_KEY, sender);
    } catch {
      /* convenience only */
    }
    setCopyState((await copyText(text)) ? 'copied' : 'failed');
  }

  function toggle(id: string) {
    setCopyState('idle');
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <Modal
      title="Draft a payroll question"
      onClose={onClose}
      wide
      description="Pick the deals to ask about. The message is a starting point to copy into your own email or chat. Nothing is sent from here."
    >
      <fieldset className="pick-list">
        <legend>Deals that need a closer look</legend>
        {rows.map((r) => (
          <div className="check-row" key={r.deal.id}>
            <input id={`inq-${r.deal.id}`} type="checkbox" checked={selected.has(r.deal.id)} onChange={() => toggle(r.deal.id)} />
            <label htmlFor={`inq-${r.deal.id}`}>
              {r.deal.account} <SignedDifference cents={r.differenceCents} />
            </label>
          </div>
        ))}
      </fieldset>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="inq-recipient">Who it’s for</label>
          <input id="inq-recipient" value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="e.g. Sam in payroll" />
        </div>
        <div className="field">
          <label htmlFor="inq-sender">Your name</label>
          <input id="inq-sender" value={sender} onChange={(e) => setSender(e.target.value)} autoComplete="name" />
        </div>
      </div>
      {hasUnallocated && (
        <div className="notice notice-amber" role="note">
          <p>
            {formatCents(unallocatedCents)} in payments isn’t allocated to deals yet, so this comparison may be incomplete. The message says so.
          </p>
        </div>
      )}
      <div className="field">
        <label htmlFor="inq-text">Message preview</label>
        <textarea id="inq-text" className="inquiry-text" readOnly rows={14} value={text} data-testid="inquiry-text" />
      </div>
      {copyState === 'confirm' ? (
        <div className="notice notice-amber" role="alert">
          <p>Some payments are still unallocated. You may want to allocate them first so the message is accurate.</p>
          <div className="actions-inline">
            <button type="button" className="btn btn-primary" onClick={() => void doCopy()}>
              Copy anyway
            </button>
            <button type="button" className="btn" onClick={() => setCopyState('idle')}>
              Not yet
            </button>
          </div>
        </div>
      ) : (
        <div className="actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!chosen.length}
            onClick={() => (hasUnallocated ? setCopyState('confirm') : void doCopy())}
          >
            Copy message
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          <span role="status" aria-live="polite" className="copy-status">
            {copyState === 'copied' && 'Copied to clipboard.'}
            {copyState === 'failed' && 'Couldn’t copy automatically. Select the text above and copy it.'}
          </span>
        </div>
      )}
    </Modal>
  );
}
