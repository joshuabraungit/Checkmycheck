import { calculateAll, type ImpactSummary } from '../lib/calc';
import { formatCents } from '../lib/money';
import type { Workspace } from '../lib/types';

/** Preview how an edit ripples through expected commissions for a plan year. */
export function DealImpact({
  before,
  after,
  impact,
  year,
}: {
  before: Workspace;
  after: Workspace;
  impact: ImpactSummary;
  year: number;
}) {
  const oldCalc = calculateAll(before);
  const newCalc = calculateAll(after);
  const delta = impact.newTotalCents.minus(impact.oldTotalCents);
  const n = impact.otherChangedDealIds.length;
  return (
    <div className="impact" role="region" aria-label="Effect of this change" data-testid="deal-impact">
      <p>
        {n === 0 ? (
          <>No other deals change.</>
        ) : (
          <>
            <strong>
              {n} other {n === 1 ? 'deal' : 'deals'}
            </strong>{' '}
            will get a different expected commission, because quota attainment builds up in close-date order.
          </>
        )}
      </p>
      <dl className="impact-grid">
        <div>
          <dt>Expected commission for {year}, now</dt>
          <dd className="num">{formatCents(impact.oldTotalCents)}</dd>
        </div>
        <div>
          <dt>After this change</dt>
          <dd className="num">{formatCents(impact.newTotalCents)}</dd>
        </div>
        <div>
          <dt>Change</dt>
          <dd className="num">{formatCents(delta, { signed: true })}</dd>
        </div>
      </dl>
      {n > 0 && (
        <ul className="impact-list">
          {impact.otherChangedDealIds.map((id) => {
            const o = oldCalc.get(id)!;
            const nw = newCalc.get(id)!;
            return (
              <li key={id}>
                {nw.deal.account}: <span className="num">{formatCents(o.expectedCents)}</span> →{' '}
                <span className="num">{formatCents(nw.expectedCents)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
