/**
 * The Goal screen's arithmetic, and no more of it than this page needs.
 *
 * Copied rather than imported, and deliberately: `backend/src/independence.ts`
 * lives in the other tree and behind a session, and this page has neither. What it
 * must not do is drift, so the names and the order of operations are the server's,
 * and every departure is written down below rather than left to be noticed.
 *
 * The one thing the landing adds is where the numbers come from. The app reads
 * them out of imported statements; here a visitor types three of them, and nothing
 * is sent anywhere to find that out — which is not a slogan on this page, it is
 * the reason the calculator is client-side in the first place.
 *
 * Departures from the server, all of them because a stranger has no data yet:
 *
 * - **Lifestyle mode, always.** The server picks `baseline` when the visitor has
 *   entered the line items of their own bare minimum. Nobody has entered anything
 *   here, so the base is the spending itself — which is exactly the branch
 *   `independence.ts` falls back to when the baseline table is empty.
 * - **Typed, not measured.** `avgSpend` is a median over a window of real months
 *   with one-offs amortised. One number in a box is a guess at that median, and
 *   the page says so rather than pretending the two are the same thing.
 */

/** `DEFAULT_SETTINGS.bufferPct` (backend/src/settings.ts). */
export const BUFFER_PCT = 10;

/** `DEFAULT_SETTINGS.hoursCapPerWeek` — the ceiling on side work. */
export const HOURS_CAP_PER_WEEK = 20;

export interface Money {
  /** what a month costs: the median the app would measure, guessed at */
  spend: number;
  /** income from your own sources — work, and only work */
  ownIncome: number;
  /** family, a stipend, a scholarship. Real money; not earnings */
  external: number;
  /** net hourly rate for side work, in the same currency */
  hourlyRate: number;
}

export interface Threshold {
  /** spending plus the buffer: what a month has to bring in to be safe */
  threshold: number;
  /** threshold minus own income, never negative */
  deficit: number;
  /** own income / spending. 1 is the line; above it is saving */
  selfSufficiency: number;
  /** the three widths of the bar, and they add up to `spend` */
  covered: { own: number; external: number; uncovered: number };
  /** how many MORE hours a month would close the shortfall */
  extraHoursPerMonth: number;
  /** what the whole threshold costs in hours, at that rate */
  totalHoursPerMonth: number;
  /** the monthly ceiling `HOURS_CAP_PER_WEEK` implies */
  capPerMonth: number;
  /** the threshold does not fit under the ceiling — side work alone will not do it */
  capExceeded: boolean;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function computeThreshold({ spend, ownIncome, external, hourlyRate }: Money): Threshold {
  const buffer = 1 + BUFFER_PCT / 100;
  const threshold = round2(spend * buffer);
  const deficit = round2(Math.max(0, threshold - ownIncome));

  // against spending and not against the threshold, exactly as the server divides
  // by `base` rather than by `threshold`: the buffer is a margin of safety, not
  // part of what living costs, and counting it would report everyone poorer than
  // they are
  const selfSufficiency = spend > 0 ? ownIncome / spend : 0;

  // The bar is what a month costs, filled in the order the money is actually
  // yours: what you earned first, then what somebody gave you, then the part
  // nothing covered. Filling it the other way round would draw help as the
  // foundation your own income sits on top of, which is the opposite of the
  // question this page asks.
  const own = Math.min(ownIncome, spend);
  const helped = Math.min(external, Math.max(0, spend - own));
  const covered = {
    own,
    external: helped,
    uncovered: round2(Math.max(0, spend - own - helped)),
  };

  const capPerMonth = round2((HOURS_CAP_PER_WEEK * 52) / 12);
  const totalHoursPerMonth = hourlyRate > 0 ? round2(threshold / hourlyRate) : 0;

  return {
    threshold,
    deficit,
    selfSufficiency,
    covered,
    extraHoursPerMonth: hourlyRate > 0 ? round2(deficit / hourlyRate) : 0,
    totalHoursPerMonth,
    capPerMonth,
    capExceeded: hourlyRate > 0 && totalHoursPerMonth > capPerMonth,
  };
}
