import { useMemo, useState } from 'react';
import { suggestMatches, type PaymentMatch } from '../lib/autoMatch';
import { formatDateShort } from '../lib/dates';
import { formatCents } from '../lib/money';
import { setPaymentAllocations } from '../lib/ops';
import { useStore } from '../state';
import { FormError, Modal } from './ui';

const KIND_LABEL: Record<PaymentMatch['kind'], string> = {
  exact: 'Adds up exactly',
  best_guess: 'Best guess',
  none: 'No likely deals',
};

function MatchDialog({ onClose, onDone }: { onClose: () => void; onDone: (message: string) => void }) {
  const { ws, commit } = useStore();
  const matches = useMemo(() => suggestMatches(ws), [ws]);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(matches.filter((m) => m.kind !== 'none').map((m) => m.payment.id)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const exact = matches.filter((m) => m.kind === 'exact').length;
  const guesses = matches.filter((m) => m.kind === 'best_guess').length;
  const none = matches.filter((m) => m.kind === 'none').length;
  const chosen = matches.filter((m) => picked.has(m.payment.id) && m.kind !== 'none');

  async function apply() {
    setSaving(true);
    setError(null);
    try {
      const next = chosen.reduce(
        (acc, m) => setPaymentAllocations(acc, m.payment.id, m.lines.map((l) => ({ dealId: l.deal.id, amountCents: l.amountCents.toFixed(0) }))),
        ws,
      );
      await commit(next);
      onDone(`Matched ${chosen.length} ${chosen.length === 1 ? 'payment' : 'payments'}. You can change any of them by editing the payment.`);
    } catch (e) {
      setError(`Not saved. ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title="Match payments to deals"
      onClose={onClose}
      wide
      description="For each unmatched payment, we looked for the deals whose commission was expected around that date and still has money outstanding. Uncheck anything that looks wrong."
    >
      {matches.length === 0 ? (
        <p>Every payment is already matched to deals.</p>
      ) : (
        <>
          <p className="import-summary" data-testid="match-summary">
            {exact > 0 && <>{exact} add up exactly</>}
            {exact > 0 && (guesses > 0 || none > 0) && ' · '}
            {guesses > 0 && <>{guesses} best {guesses === 1 ? 'guess' : 'guesses'}</>}
            {guesses > 0 && none > 0 && ' · '}
            {none > 0 && <>{none} with no likely deals</>}
          </p>
          <ul className="match-list">
            {matches.map((m) => {
              const id = `match-${m.payment.id}`;
              return (
                <li key={m.payment.id} className={`match-item match-${m.kind}`}>
                  <div className="check-row">
                    <input
                      id={id}
                      type="checkbox"
                      disabled={m.kind === 'none'}
                      checked={picked.has(m.payment.id) && m.kind !== 'none'}
                      onChange={(e) =>
                        setPicked((s) => {
                          const next = new Set(s);
                          if (e.target.checked) next.add(m.payment.id);
                          else next.delete(m.payment.id);
                          return next;
                        })
                      }
                    />
                    <label htmlFor={id}>
                      <strong>
                        {formatDateShort(m.payment.paymentDate)} · <span className="num">{formatCents(m.payment.amountCents)}</span>
                      </strong>
                      {m.payment.reference && <span className="muted"> · {m.payment.reference}</span>}{' '}
                      <span className={`badge badge-${m.kind === 'exact' ? 'matched' : m.kind === 'best_guess' ? 'partial' : 'upcoming'}`}>
                        {KIND_LABEL[m.kind]}
                      </span>
                    </label>
                  </div>
                  {m.lines.length > 0 && (
                    <ul className="match-lines">
                      {m.lines.map((l) => (
                        <li key={l.deal.id}>
                          {l.deal.account}: <span className="num">{formatCents(l.amountCents)}</span>
                          {l.amountCents.lt(l.outstandingCents) && (
                            <span className="muted">
                              {' '}
                              of <span className="num">{formatCents(l.outstandingCents)}</span> outstanding
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {m.kind === 'none' && (
                    <p className="muted small">No deals were expected around this date with money still outstanding. Match it by hand if it belongs to a deal.</p>
                  )}
                  {m.kind !== 'none' && m.leftoverCents.gt(0) && (
                    <p className="muted small">
                      <span className="num">{formatCents(m.leftoverCents)}</span> stays unallocated.
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="muted small">
            “Best guess” means no set of deals adds up to the payment exactly, so deals due closest to the payment date are filled first. Those
            are the payments most worth a look.
          </p>
        </>
      )}
      <FormError message={error} />
      <div className="actions">
        <button type="button" className="btn btn-primary" disabled={!chosen.length || saving} onClick={() => void apply()}>
          {saving ? 'Saving…' : `Match ${chosen.length} ${chosen.length === 1 ? 'payment' : 'payments'}`}
        </button>
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}

/** Opens the review of suggested payment-to-deal matches. */
export function AutoMatchButton({ className = 'btn btn-small btn-primary', label = 'Match automatically' }: { className?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        {label}
      </button>
      {status && (
        <span className="import-status success" role="status">
          {status}
        </span>
      )}
      {open && (
        <MatchDialog
          onClose={() => setOpen(false)}
          onDone={(m) => {
            setOpen(false);
            setStatus(m);
          }}
        />
      )}
    </>
  );
}
