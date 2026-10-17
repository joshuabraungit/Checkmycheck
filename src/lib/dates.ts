import type { DateOnly } from './types';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True when the string is a real calendar date in YYYY-MM-DD form. */
export function isValidDate(value: unknown): value is DateOnly {
  if (typeof value !== 'string') return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1900 || y > 2999 || mo < 1 || mo > 12 || d < 1) return false;
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d <= daysInMonth;
}

/** Today's date in the browser's local time zone. */
export function todayLocal(now: Date = new Date()): DateOnly {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function yearOf(date: DateOnly): number {
  return Number(date.slice(0, 4));
}

/** Date-only strings compare correctly as plain strings. */
export function compareDates(a: DateOnly, b: DateOnly): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const SHORT_MONTHS = MONTHS.map((m) => m.slice(0, 3));

/** "2026-03-31" -> "March 31, 2026" without touching time zones. */
export function formatDateLong(date: DateOnly): string {
  if (!isValidDate(date)) return date;
  const [y, m, d] = date.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

/** "2026-03-31" -> "Mar 31, 2026" */
export function formatDateShort(date: DateOnly): string {
  if (!isValidDate(date)) return date;
  const [y, m, d] = date.split('-').map(Number);
  return `${SHORT_MONTHS[m - 1]} ${d}, ${y}`;
}

/** "March 31" for compact labels. */
export function formatMonthDay(date: DateOnly): string {
  if (!isValidDate(date)) return date;
  const [, m, d] = date.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}
