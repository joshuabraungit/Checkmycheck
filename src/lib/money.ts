import Decimal from 'decimal.js';
import type { Cents, Rate } from './types';

/** Isolated Decimal constructor so app settings never leak into other code. */
export const D = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_HALF_UP });
export type Dec = InstanceType<typeof D>;

export const MAX_INPUT_CENTS = new D('99999999999'); // $999,999,999.99

export function cents(value: Cents | number | Dec): Dec {
  return new D(value);
}

export function sumCents(values: Iterable<Cents | Dec>): Dec {
  let total = new D(0);
  for (const v of values) total = total.plus(v);
  return total;
}

/** Round half up (away from zero for positive values) to whole cents. */
export function roundHalfUp(value: Dec): Dec {
  return value.toDecimalPlaces(0, D.ROUND_HALF_UP);
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Parse a user-entered dollar amount (e.g. "1,234.5" or "$1234.50") into integer cents.
 * Must be positive, at most two decimal places, and no more than $999,999,999.99.
 */
export function parseMoneyInput(raw: string, label = 'Amount'): ParseResult<Cents> {
  const cleaned = raw.trim().replace(/^\$/, '').replace(/,/g, '').trim();
  if (cleaned === '') return { ok: false, error: `${label} is required.` };
  if (!/^\d+(\.\d*)?$|^\.\d+$/.test(cleaned)) {
    return { ok: false, error: `${label} must be a number, like 1250.00.` };
  }
  const [, frac = ''] = cleaned.split('.');
  if (frac.length > 2) return { ok: false, error: `${label} can have at most two decimal places.` };
  const value = new D(cleaned).times(100);
  if (value.lte(0)) return { ok: false, error: `${label} must be greater than $0.` };
  if (value.gt(MAX_INPUT_CENTS)) return { ok: false, error: `${label} can be at most $999,999,999.99.` };
  return { ok: true, value: value.toFixed(0) };
}

/** Parse a percentage like "10" or "12.5%" into a rate fraction string like "0.1". */
export function parsePercentInput(raw: string, label = 'Rate'): ParseResult<Rate> {
  const cleaned = raw.trim().replace(/%$/, '').trim();
  if (cleaned === '') return { ok: false, error: `${label} is required.` };
  if (!/^\d+(\.\d*)?$|^\.\d+$/.test(cleaned)) {
    return { ok: false, error: `${label} must be a number, like 10 or 12.5.` };
  }
  const [, frac = ''] = cleaned.split('.');
  if (frac.length > 4) return { ok: false, error: `${label} can have at most four decimal places.` };
  const pct = new D(cleaned);
  if (pct.lte(0)) return { ok: false, error: `${label} must be greater than 0%.` };
  if (pct.gt(100)) return { ok: false, error: `${label} can be at most 100%.` };
  return { ok: true, value: normalizeRate(pct.div(100)) };
}

export function normalizeRate(rate: Dec): Rate {
  const s = rate.toFixed();
  return s.includes('.') ? s : `${s}.0`;
}

/** "0.125" -> "12.5" */
export function rateToPercentString(rate: Rate): string {
  return new D(rate).times(100).toFixed();
}

const groupFormatter = new Intl.NumberFormat('en-US');

/** Format cents as "$1,234.56" (or "-$1,234.56"). Works for arbitrarily large values. */
export function formatCents(value: Cents | Dec, opts: { signed?: boolean } = {}): string {
  const d = new D(value);
  const neg = d.isNegative() && !d.isZero();
  const abs = d.abs();
  const whole = abs.div(100).floor();
  const frac = abs.minus(whole.times(100)).toFixed(0).padStart(2, '0');
  const wholeStr = whole.lte(Number.MAX_SAFE_INTEGER)
    ? groupFormatter.format(whole.toNumber())
    : whole.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = `$${wholeStr}.${frac}`;
  if (neg) return `-${body}`;
  if (opts.signed && d.gt(0)) return `+${body}`;
  return body;
}

/** Cents to plain dollars string for CSV, e.g. "6000.00". */
export function centsToDollarString(value: Cents | Dec): string {
  return new D(value).div(100).toFixed(2);
}

/** Cents to the form-input representation, e.g. "6000" or "6000.5" -> "6000.50". */
export function centsToInput(value: Cents): string {
  const d = new D(value).div(100);
  return d.isInteger() ? d.toFixed(0) : d.toFixed(2);
}

export function formatPercent(rate: Rate): string {
  return `${rateToPercentString(rate)}%`;
}
