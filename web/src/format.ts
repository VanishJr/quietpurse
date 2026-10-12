import type { CalendarDay, Instant } from './types';

/**
 * Hand-rolled rather than Intl: the output is deliberately locale-independent, so
 * amounts and dates read the same everywhere.
 */

export function fmtMoney(n: number, currency?: string): string {
  const sign = n < 0 ? '−' : '';
  const [int, frac] = Math.abs(n).toFixed(2).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fracPart = frac === '00' ? '' : `.${frac}`;
  return `${sign}${grouped}${fracPart}${currency ? ' ' + currency : ''}`;
}

/** The importer's helper of the same name, written again on this side so the two sentences read alike. */
export const rowCount = (n: number): string => `${n} row${n === 1 ? '' : 's'}`;

export function fmtShort(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${sign}${Math.round(abs / 1000)}k`;
  if (abs >= 1_000) return `${sign}${(abs / 1000).toFixed(1)}k`;
  return `${sign}${Math.round(abs)}`;
}

/**
 * A chart's Y-axis upper bound: the smallest round number that is not below the
 * data's maximum. Here beside `fmtShort` because it is the same job — the axis — and
 * a second copy of it in a screen would drift.
 */
export function niceMax(max: number): number {
  if (max <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(max)));
  return Math.ceil(max / (pow / 2)) * (pow / 2);
}

export const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

const DAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];

/**
 * A real instant and not a calendar day, so `getDay`/`getDate` are the local ones on
 * purpose: this is today where the reader is, not a date off a statement, which goes
 * through `fmtDay` instead.
 */
export function fmtWeekday(d: Date): string {
  return `${DAYS[d.getDay()]}, ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;
}

/** Split on the string, never through `new Date('2026-07')`, for the reason `fmtDay` gives. */
export const fmtMonthKey = (month: string): string =>
  `${MONTHS_SHORT[Number(month.slice(5, 7)) - 1] ?? month.slice(5, 7)} ${month.slice(0, 4)}`;

export const fmtMonthTick = (month: string): string =>
  MONTHS_SHORT[Number(month.slice(5, 7)) - 1] ?? month.slice(5, 7);

/**
 * A long name cut in the middle, keeping both ends, with the cut marked.
 *
 * End-truncation is the usual answer and it is the wrong one here. An account named
 * after the statement it came from carries the filename, extension and all, and a
 * bank's export names are a `report_` prefix, a date and a time — everything that
 * distinguishes two of them is at the end. Cut from the right, every such account is
 * called `report_03-09-…`, which names none of them.
 *
 * `budget` is the whole result including the ellipsis, so the caller states the width
 * it has rather than a head and a tail it would have to add up itself. The head keeps
 * the odd character: a name is read from the left.
 */
export function truncateMiddle(text: string, budget: number): string {
  if (text.length <= budget) return text;
  // below three characters there is no room for a head, a tail and a mark, and a
  // bare "…" says less than the first letter does
  if (budget < 3) return text.slice(0, Math.max(0, budget));
  const keep = budget - 1;
  const head = Math.ceil(keep / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`;
}

export function fmtInstant(timestamp: Instant): string {
  const d = new Date(timestamp);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getFullYear()}`;
}

/**
 * Off the day's own ten characters, never through a `Date`: the stored
 * `2026-02-01T00:00:00.000Z` is UTC midnight, which reads back as the 31st west of UTC,
 * and a statement's late-evening time reads as the next day east of it.
 */
export const fmtDay = (day: CalendarDay): string => day.slice(0, 10).split('-').reverse().join('.');

/** YYYY-MM-DD in local time */
export function isoDay(d: Date): CalendarDay {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}` as CalendarDay;
}
