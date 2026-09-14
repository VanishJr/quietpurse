/**
 * Money and date formatting.
 *
 * Hand-rolled rather than Intl: the output is deliberately locale-independent, so
 * amounts and dates read the same everywhere (grouping with commas, dd.mm.yyyy).
 */

export function fmtMoney(n: number, currency?: string): string {
  const sign = n < 0 ? '−' : '';
  const [int, frac] = Math.abs(n).toFixed(2).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fracPart = frac === '00' ? '' : `.${frac}`;
  return `${sign}${grouped}${fracPart}${currency ? ' ' + currency : ''}`;
}

/**
 * "1 row" / "2 rows". The backend solves the same problem in `statement.ts`, on the
 * other side of a wire neither side can import across, and this is that helper's shape
 * verbatim so the two sentences read alike.
 */
export const rowCount = (n: number): string => `${n} row${n === 1 ? '' : 's'}`;

/** Compact, for chart axes: 950 → "950", 1,200 → "1.2k", 30,500 → "31k", 1,200,000 → "1.2M". */
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
 * because two screens now draw bars and a second copy of it would drift.
 */
export function niceMax(max: number): number {
  if (max <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(max)));
  return Math.ceil(max / (pow / 2)) * (pow / 2);
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Short month names — X-axis labels in the yearly chart. */
export const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export function fmtMonth(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

const DAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];

/**
 * "Friday, 7 Aug 2026" — the line over the greeting.
 *
 * A real instant and not a calendar day, so `getDay`/`getDate` are the local ones on
 * purpose: this is today where the reader is, not a date off a statement. Everything
 * that formats a YYYY-MM-DD goes through `fmtDay` instead, for the reason written
 * there.
 */
export function fmtWeekday(d: Date): string {
  return `${DAYS[d.getDay()]}, ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * A YYYY-MM as "Jul 2026". Split on the string, never through `new Date('2026-07')`,
 * for the reason `fmtDay` gives: that is UTC midnight, and it reads back as June for
 * anybody west of UTC.
 */
export const fmtMonthKey = (month: string): string =>
  `${MONTHS_SHORT[Number(month.slice(5, 7)) - 1] ?? month.slice(5, 7)} ${month.slice(0, 4)}`;

/** Just the month, for a chart axis where the range is stated above it. */
export const fmtMonthTick = (month: string): string =>
  MONTHS_SHORT[Number(month.slice(5, 7)) - 1] ?? month.slice(5, 7);

/**
 * A long name cut in the middle, keeping both ends, with the cut marked.
 *
 * End-truncation is the usual answer and it is the wrong one here. An account's
 * default name is the statement's filename, extension and all — the real ones are a
 * `report_` prefix, a date and a time, and everything that distinguishes two of them is
 * at the end. Cut from the right, every account a bank exports is called
 * `report_03-09-…`, which names none of them.
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

export function fmtDate(iso: string): string {
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getFullYear()}`;
}

/**
 * dd.mm.yyyy from a plain YYYY-MM-DD. Not fmtDate: `new Date('2026-02-01')` is UTC
 * midnight, which reads back as the 31st for anyone west of UTC - and these are
 * calendar days off a bank statement, so that would be wrong every time, not
 * occasionally. A calendar date is split on the string and never turned into an
 * instant; fmtDate stays right for a real timestamp.
 */
export const fmtDay = (isoDay: string): string => isoDay.split('-').reverse().join('.');

/** YYYY-MM-DD in local time */
export function isoDay(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}
