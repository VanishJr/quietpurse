/**
 * The month arithmetic the Overview owns, and the cents rule that goes with it.
 *
 * This module used to be the arithmetic itself: `/api/summary` and `/api/summary/months`
 * summed the whole workspace and nothing else, so the screen fetched one account's
 * transactions and did in the client what the server would have done in SQL. That
 * mirror is gone — both endpoints take an `accountId` and answer that account's own
 * figures, in its own currency.
 *
 * What is left is the half the server deliberately does not do. It answers only the
 * months that HAVE rows (048 D5), so the anchoring, the window and the interior gaps
 * are the caller's: see `windowMonths`, which is where the whole of that rule lives and
 * the one thing here no type can hold.
 *
 * And the cents rule stays, because every figure still arrives as a double that came
 * from an integer — the server divides `*_cents` by a hundred on the way out — and
 * anything that adds or subtracts two of them keeps the residue. `SpendingByCategory`
 * takes a remainder off three of them, which is why `toCents` is exported.
 */
import { AccountMonthTotals } from './types';

/** The windows the month chart offers. The toggle renders this array, in this order. */
export const MONTH_WINDOWS = [3, 6, 12] as const;

export type MonthWindow = (typeof MONTH_WINDOWS)[number];

/**
 * The longest window, and therefore how far back a screen has to fetch before it can
 * draw any of them. Read off the array so that adding a window cannot leave the fetch
 * one step short of the toggle.
 */
export const LONGEST_WINDOW: MonthWindow = MONTH_WINDOWS[MONTH_WINDOWS.length - 1];

/**
 * The month a transaction belongs to, taken off the string rather than through
 * `new Date()` — same reason `fmtDay` exists in format.ts. The server buckets with
 * `SUBSTR(date, 1, 7)` over the stored ISO string, and anything that goes via a local
 * `Date` disagrees with it for everybody west of UTC on the first of the month.
 */
export const monthOf = (isoDate: string): string => isoDate.slice(0, 7);

/**
 * Money, as the integer it actually is.
 *
 * Every amount in this client came off `*_cents` on the server and was divided by a
 * hundred on the way out, so `192.45` is a double that is near 192.45 and not equal to
 * it. Add a few hundred of those and the error is visible: the balance minus the
 * month's net movement, which is exactly zero in cents, came out as 2e-13 — and a
 * percentage taken against that base printed as 103138588731900000.0%.
 *
 * So every comparison below is made in cents. Nothing here is allowed to subtract two
 * doubles that came from integers and keep the residue.
 *
 * Exported because the rule does not stop at this module: anything that adds or
 * subtracts the figures the API sends — `SpendingByCategory` takes a remainder off
 * them — is adding the same doubles and has to do it the same way.
 */
export const toCents = (amount: number): number => Math.round(amount * 100);

/** YYYY-MM shifted by whole months; `delta` may be negative. */
export function shiftMonth(month: string, delta: number): string {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7)) - 1 + delta;
  const shifted = new Date(Date.UTC(year, index, 1));
  return shifted.toISOString().slice(0, 7);
}

/**
 * The last calendar day of a YYYY-MM, as YYYY-MM-DD.
 *
 * In UTC from the month key and never `new Date(y, m, 0)` with local getters, which is
 * a day out for half the planet. The endpoints pad a `to` to the end of the day it
 * names, so a `to` short by one drops the last day of the month out of the donut, the
 * two flow figures and the newest point of the chart at once — silently, because a
 * month missing its last day still looks like a month.
 */
export function monthEnd(month: string): string {
  const year = Number(month.slice(0, 4));
  // 1-based, so this is next month's 0-based index — day 0 of it is this month's last
  const next = Number(month.slice(5, 7));
  return new Date(Date.UTC(year, next, 0)).toISOString().slice(0, 10);
}

/** Every YYYY-MM from `first` to `last` inclusive. Months with nothing in them included. */
export function monthRange(first: string, last: string): string[] {
  const out: string[] = [];
  for (let m = first; m <= last; m = shiftMonth(m, 1)) {
    out.push(m);
    // a range built from two months that are not both YYYY-MM would not terminate
    if (out.length > 1200) break;
  }
  return out;
}

/**
 * The window the chart draws, oldest first: the account's months as the server
 * answered them, anchored, cut to `window`, and with the holes filled in.
 *
 * The server answers only the months that have rows, so all four rules below are the
 * client's alone:
 *
 *  - The newest bucket is the newest month WITH DATA, not the current month. Anchoring
 *    on the data rather than on today is what keeps a window from being mostly empty
 *    for the reason the user is least able to fix: somebody who has uploaded July and
 *    is looking at the screen in August wants July at the right-hand edge, not an empty
 *    August bar with July pushed off-centre.
 *  - The range never starts before the account's own first month, so an account with
 *    one month of history answers one bucket for every window. It is not padded with
 *    zeroes at the far end: a bar for a month that predates the first statement is a
 *    claim that nothing happened then, and nothing here knows that.
 *  - Gaps INSIDE the range are materialised as 0/0/0, because those are real — a month
 *    between two months of statements with nothing in it is a month with nothing in it.
 *    This is also what makes `priorMonth` adjacency: without it, "vs Jul" on an account
 *    with a quiet June silently becomes a comparison against May.
 *  - A month holding only transfers is a month with data. It totals 0/0 and the bar is
 *    flat, but it is in the array the server sent — `net` carries no transfer filter —
 *    and dropping it would move the anchor and quietly reshape the window.
 */
export function windowMonths(
  months: AccountMonthTotals[],
  window: number,
): AccountMonthTotals[] {
  if (months.length === 0) return [];

  const byMonth = new Map(months.map((m) => [m.month, m]));
  const keys = [...byMonth.keys()].sort();
  const last = keys[keys.length - 1];
  const wanted = shiftMonth(last, -(window - 1));
  const first = keys[0] > wanted ? keys[0] : wanted;

  return monthRange(first, last).map(
    (month) => byMonth.get(month) ?? { month, income: 0, expense: 0, net: 0 },
  );
}

/**
 * The month the three headline figures are about: the newest one the account has
 * anything in. null when it has nothing at all, which is a state the screen has to
 * render rather than a zero it can print.
 */
export const latestMonth = (months: AccountMonthTotals[]): AccountMonthTotals | null =>
  months.length > 0 ? months[months.length - 1] : null;

/**
 * The month before it, which is what a "from last month" figure compares against.
 * null when the account has only ever had one month — and then no comparison is
 * shown at all, rather than one against a zero nobody recorded.
 *
 * Adjacency in the FILLED array and never "the previous element of the server's
 * answer": the server skips a month with no rows, so reading its array directly makes
 * a quiet June invisible and points "vs" at May with nothing on screen saying so.
 */
export const priorMonth = (months: AccountMonthTotals[]): AccountMonthTotals | null =>
  months.length > 1 ? months[months.length - 2] : null;

/**
 * How far `now` is above `before`, as a percentage — or null when the question has
 * no answer.
 *
 * A base of zero is the null case and not "infinity" or "100%": going from nothing to
 * something is not a percentage, and printing one puts a number on the screen whose
 * size means nothing. The caller renders no comparison at all rather than a
 * meaningless one.
 *
 * Both arguments are money and both are rounded to cents before anything is decided,
 * which is what makes "a base of zero" a test that can actually be passed — see
 * `toCents`. Without it a base that is zero to the last cent is some tiny residue
 * instead, and the null branch is unreachable exactly where it is needed.
 */
export function percentChange(now: number, before: number): number | null {
  const base = toCents(before);
  // `=== 0` also catches -0, which is what Math.round returns for a small negative
  if (base === 0) return null;
  return ((toCents(now) - base) / Math.abs(base)) * 100;
}

/**
 * What the balance moved by across `month`, as a percentage of where it started.
 *
 * Derived rather than remembered: no history of the balance is stored anywhere, but
 * the balance IS the sum of every row, so the balance before this month is today's
 * balance less this month's net movement. `net` and nothing else — it is the one
 * figure summed the way the balance is, transfers included.
 *
 * An account whose whole history is one month therefore opened at zero, and gets no
 * percentage at all — which is the common case for a new user and the one that used to
 * print seventeen digits.
 */
export function balanceChange(balance: number, month: AccountMonthTotals | null): number | null {
  if (!month) return null;
  return percentChange(balance, balance - month.net);
}
