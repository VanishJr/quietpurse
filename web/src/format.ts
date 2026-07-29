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

/** Compact, for chart axes: 950 → "950", 1,200 → "1.2k", 30,500 → "31k", 1,200,000 → "1.2M". */
export function fmtShort(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${sign}${Math.round(abs / 1000)}k`;
  if (abs >= 1_000) return `${sign}${(abs / 1000).toFixed(1)}k`;
  return `${sign}${Math.round(abs)}`;
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

export function fmtDate(iso: string): string {
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getFullYear()}`;
}

/** YYYY-MM-DD in local time */
export function isoDay(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}
