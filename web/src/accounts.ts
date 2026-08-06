/**
 * What one account's transactions add up to.
 *
 * Every figure on the Overview dashboard is per-account, and the API has no
 * per-account arithmetic: `/api/summary` and `/api/summary/months` take a date range
 * and nothing else, and they sum the whole workspace. So this module does on the
 * client what the server would do in SQL, over the rows `/api/transactions` already
 * answers for one account.
 *
 * That is a mirror, and a mirror drifts. `REDESIGN-BACK-DEBT.md` carries the row that
 * deletes it — an `accountId` on those two endpoints — and until then the rules below
 * are written against `summaryTotals` and `summaryMonthlyTotals` in
 * `backend/src/db/index.ts` and must move when they do.
 *
 * Two differences from the server's version, both deliberate:
 *
 *  - **The account's own currency, not the base one.** The server sums
 *    `base_amount_cents`, because it is adding accounts that do not share a currency.
 *    One account has one currency, so there is nothing to convert and nothing to lose
 *    to a missing rate — and it puts Balance, Income and Expense in the same unit,
 *    which is the whole premise of the line explaining why they do not reconcile.
 *  - **No `base_amount IS NOT NULL` filter.** That filter exists because a row with no
 *    rate cannot be added to rows in another currency. Here it would silently drop a
 *    real transaction from its own account's total.
 */
import { Transaction } from './types';

/** The windows the month chart offers. The toggle renders this array, in this order. */
export const MONTH_WINDOWS = [3, 6, 12] as const;

export type MonthWindow = (typeof MONTH_WINDOWS)[number];

/**
 * The longest window, and therefore how far back a screen has to fetch before it can
 * draw any of them. Read off the array so that adding a window cannot leave the fetch
 * one step short of the toggle.
 */
export const LONGEST_WINDOW: MonthWindow = MONTH_WINDOWS[MONTH_WINDOWS.length - 1];

/** One calendar month of one account, in that account's currency. */
export interface MonthTotal {
  /** YYYY-MM */
  month: string;
  income: number;
  expense: number;
  /**
   * What the balance moved by in this month — every row summed, transfers included.
   * It is a different question from income minus expenses and has to be counted
   * separately: `recalcAccountBalanceFromTransactions` sums `amount_cents` with no
   * transfer filter, so this is the only figure the balance can be compared against.
   */
  net: number;
}

export interface Totals {
  income: number;
  expense: number;
  net: number;
}

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
 * So every sum below is accumulated in cents and divided once at the end, and every
 * comparison is made in cents. Nothing here is allowed to add two doubles that came
 * from integers and keep the residue.
 */
const toCents = (amount: number): number => Math.round(amount * 100);

/** YYYY-MM shifted by whole months; `delta` may be negative. */
export function shiftMonth(month: string, delta: number): string {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7)) - 1 + delta;
  const shifted = new Date(Date.UTC(year, index, 1));
  return shifted.toISOString().slice(0, 7);
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
 * Income and expense over a set of transactions, by the server's rules:
 * transfers between the user's own accounts are neither, and a refund subtracts from
 * expenses in the period the refund landed rather than adding to income.
 *
 * A refund can therefore push a month's expense figure negative, and that is the
 * honest number — the purchase it reverses was in an earlier month.
 */
export function totals(txs: Transaction[]): Totals {
  let income = 0;
  let expense = 0;
  let net = 0;
  for (const t of txs) {
    const cents = toCents(t.amount);
    net += cents;
    if (t.transfer) continue;
    if (cents < 0 || t.refund) expense += -cents;
    else if (cents > 0) income += cents;
  }
  return { income: income / 100, expense: expense / 100, net: net / 100 };
}

/**
 * The account's months, newest last, ending at the newest month it has anything in —
 * not at the current month.
 *
 * Anchoring on the data rather than on today is what keeps a window from being mostly
 * empty for the reason the user is least able to fix: somebody who has uploaded July
 * and is looking at the screen in August wants July at the right-hand edge, not an
 * empty August bar with July pushed off-centre.
 *
 * The range never starts before the account's own first month, so an account with one
 * month of history answers one bucket for every window. It is not padded with zeroes:
 * a bar for a month that predates the first statement is a claim that nothing happened
 * then, and nothing here knows that.
 *
 * Gaps *inside* the range are kept, because those are real — a month between two
 * months of statements with nothing in it is a month with nothing in it.
 *
 * A month holding only transfers counts as a month with data. It totals 0/0, and the
 * bar is flat, but dropping it would move the anchor and silently reshape the window.
 */
export function monthlyTotals(txs: Transaction[], window: number): MonthTotal[] {
  const seen = new Map<string, Transaction[]>();
  for (const t of txs) {
    const key = monthOf(t.date);
    const bucket = seen.get(key);
    if (bucket) bucket.push(t);
    else seen.set(key, [t]);
  }
  if (seen.size === 0) return [];

  const keys = [...seen.keys()].sort();
  const last = keys[keys.length - 1];
  const wanted = shiftMonth(last, -(window - 1));
  const first = keys[0] > wanted ? keys[0] : wanted;

  return monthRange(first, last).map((month) => ({
    month,
    ...totals(seen.get(month) ?? []),
  }));
}

/**
 * The month the three headline figures are about: the newest one the account has
 * anything in. null when it has nothing at all, which is a state the screen has to
 * render rather than a zero it can print.
 */
export const latestMonth = (months: MonthTotal[]): MonthTotal | null =>
  months.length > 0 ? months[months.length - 1] : null;

/**
 * The month before it, which is what a "from last month" figure compares against.
 * null when the account has only ever had one month — and then no comparison is
 * shown at all, rather than one against a zero nobody recorded.
 */
export const priorMonth = (months: MonthTotal[]): MonthTotal | null =>
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
 * balance less this month's net movement.
 *
 * An account whose whole history is one month therefore opened at zero, and gets no
 * percentage at all — which is the common case for a new user and the one that used to
 * print seventeen digits.
 */
export function balanceChange(balance: number, month: MonthTotal | null): number | null {
  if (!month) return null;
  return percentChange(balance, balance - month.net);
}

/**
 * Currencies among the account's transactions that are not the account's own, sorted
 * and deduplicated.
 *
 * Normally empty: an account has one currency and an import into it carries that
 * currency. When it is not, the totals above are adding two units together and the
 * screen has to say so rather than print a number with one currency code after it.
 *
 * It sees only the rows it is handed, which is the fetched window. `account.balance` is
 * the server's sum over the whole history, so a foreign row older than the window — or
 * one dropped by a truncated fetch — is added into the balance without anything here
 * noticing. Answering that needs the account currencies the endpoint does not report;
 * it is the same `accountId` on the summary endpoints that `REDESIGN-BACK-DEBT.md`
 * already asks for.
 */
export function foreignCurrencies(txs: Transaction[], accountCurrency: string): string[] {
  const found = new Set<string>();
  for (const t of txs) if (t.currency !== accountCurrency) found.add(t.currency);
  return [...found].sort();
}
