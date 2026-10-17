import type { DealReconciliation } from './calc';
import { formatDateLong, formatDateShort } from './dates';
import { D, formatCents, sumCents, type Dec } from './money';

export interface InquiryOptions {
  recipientName: string;
  senderName: string;
  asOf: string;
  rows: DealReconciliation[];
  unallocatedCents: Dec;
}

function line(r: DealReconciliation): string {
  const parts = [r.deal.account];
  if (r.deal.reference.trim()) parts.push(`ref ${r.deal.reference.trim()}`);
  parts.push(`expected payment ${formatDateShort(r.deal.expectedPaymentDate)}`);
  parts.push(`expected ${formatCents(r.expectedCents)}`);
  parts.push(`received ${formatCents(r.receivedAsOfCents)}`);
  const diff = r.differenceCents;
  parts.push(diff.gte(0) ? `difference ${formatCents(diff)}` : `received ${formatCents(diff.neg())} more than expected`);
  return `- ${parts.join(' / ')}`;
}

/** Deterministic, copyable message. Nothing is sent anywhere. */
export function buildInquiry(opts: InquiryOptions): string {
  const { rows } = opts;
  const recipient = opts.recipientName.trim() || '[name]';
  const sender = opts.senderName.trim() || '[your name]';
  const expected = sumCents(rows.map((r) => r.expectedCents));
  const received = sumCents(rows.map((r) => r.receivedAsOfCents));
  const net = expected.minus(received);
  const shortfalls = rows.filter((r) => r.differenceCents.gt(0));
  const excess = rows.filter((r) => r.differenceCents.lt(0));
  const out: string[] = [];

  out.push(`Hi ${recipient},`, '');
  out.push(`I’m reviewing my commission statement as of ${formatDateLong(opts.asOf)} and could use help reconciling a few items.`, '');

  if (shortfalls.length && excess.length) {
    out.push(
      `Based on the plan details I’ve entered, some deals show less received than I expected and others show more. ` +
        `Across the deals below I expected ${formatCents(expected)} and recorded ${formatCents(received)} in payments allocated to them, ` +
        `a net difference of ${formatCents(net, { signed: true })}.`,
      '',
      'Received less than expected:',
      ...shortfalls.map(line),
      '',
      'Received more than expected:',
      ...excess.map(line),
    );
  } else if (excess.length) {
    out.push(
      `Based on the plan details I’ve entered, I expected ${formatCents(expected)} across the deals below and recorded ` +
        `${formatCents(received)} in payments allocated to them, which is ${formatCents(net.neg())} more than I expected. ` +
        'I want to make sure these payments were applied correctly.',
      '',
      ...excess.map(line),
    );
  } else {
    out.push(
      `Based on the plan details I’ve entered, I expected ${formatCents(expected)} across the deals below and recorded ` +
        `${formatCents(received)} in payments allocated to them, leaving a difference of ${formatCents(net)}.`,
      '',
      ...shortfalls.map(line),
    );
  }
  out.push('');
  if (opts.unallocatedCents.gt(new D(0))) {
    out.push(
      `I also have ${formatCents(opts.unallocatedCents)} in payments I haven’t matched to specific deals yet, so this comparison may be incomplete.`,
      '',
    );
  }
  if (excess.length && !shortfalls.length) {
    out.push('Could you help me check whether these amounts belong to other deals, or whether there’s a crediting rule or timing detail I’m missing?');
  } else {
    out.push('Could you help me check whether I’m missing a payment, a crediting rule, or a timing detail?');
  }
  out.push('', 'Thanks,', sender);
  return out.join('\n');
}
