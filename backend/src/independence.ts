/**
 * The independence metric - an answer to "how much do I need to earn so that
 * nobody else has to help". Support is whatever somebody else gives you; which
 * money is which is the workspace's own answer, carried by each income source's
 * kind.
 *
 * TWO thresholds are computed, and both are returned - so there is something to
 * compare against:
 *   base = the bare minimum (goalMode: 'baseline', the default)
 *     The sum of baseline_items: housing, food, subscriptions, gym, barber...
 *     That is what it takes to simply live on your own. Holidays, a new PC and
 *     restaurants are not in it - that is the whole point of "self-sufficiency".
 *
 *   base = the median of spending (goalMode: 'lifestyle')
 *     The older formula: the median of monthly spending over the window (one-off
 *     purchases amortized). Keeps your current way of life whole, so it is bigger.
 *
 *   Own income        = sources with kind = own (salary, other, freelance...)
 *   Support           = sources with kind = external (a stipend, a scholarship, family...)
 *   Threshold         = base * (1 + buffer)
 *   Shortfall         = Threshold - Own income
 *   Self-sufficiency  = Own income / base
 *
 * The window is the last N WHOLE months: the current month isn't over and would
 * understate both spending and income. One-off large purchases (one_off, set
 * manually) are taken out of monthly spending, and instead each month gets 1/12 of
 * their yearly total - otherwise a single large electronics order inflates the median
 * of a random month, while "living lean" on a median without one-offs is self-deception.
 */
import { CategorySummary, MonthTotals } from './types';
import {
  BaselineItem,
  avgMonthlyByCategory,
  baselineTotal,
  currentBaseCurrency,
  listBaselineItems,
  summaryMonthlyTotals,
} from './db';
import { GoalMode, Settings, getSettings } from './settings';

export interface IndependenceMonth {
  /** YYYY-MM */
  month: string;
  /** the month's spending without one-offs, plus the one-off amortization */
  spend: number;
  ownIncome: number;
  /** help from external sources (kind = external) */
  external: number;
}

export interface Independence {
  baseCurrency: string;
  settings: Settings;
  /** [from, to] of the averaging window (whole months) */
  from: string;
  to: string;
  /** median monthly spending over the window (one-offs amortized) */
  avgSpend: number;
  /** one-off amortization: the sum of one_off over 12 months / 12 */
  oneOffMonthly: number;
  /** average own income (kind = own) over the window */
  ownIncomeAvg: number;
  /** average help from external sources (kind = external) over the window */
  externalAvg: number;
  /** the sum of the baseline minimum line items (before the buffer) */
  baselineSum: number;
  baselineItems: BaselineItem[];
  /** baseline minimum * (1 + buffer) */
  baselineThreshold: number;
  /** median spending * (1 + buffer) */
  lifestyleThreshold: number;
  /**
   * the mode the figures below were actually computed in, against settings.goalMode
   * which is the mode that was asked for - the two differ when the fallback fires
   */
  effectiveMode: GoalMode;
  /** the active threshold: baselineThreshold or lifestyleThreshold per effectiveMode */
  threshold: number;
  /** threshold minus own income (never negative) */
  deficit: number;
  /** own income / the active mode's base */
  selfSufficiency: number;
  months: IndependenceMonth[];
  /** what the threshold is made of: average monthly spending by category */
  byCategory: CategorySummary[];
  /** the shortfall expressed in side-work hours; null if no rate is set */
  hours: {
    hourlyRate: number;
    /** how many MORE hours a month are needed to close the shortfall */
    extraHoursPerMonth: number;
    /** how many hours a month the whole threshold would cost */
    totalHoursPerMonth: number;
    /** the monthly hours ceiling from hoursCapPerWeek */
    capPerMonth: number;
    /** the threshold doesn't fit under the ceiling - side work alone won't do it */
    capExceeded: boolean;
  } | null;
}

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const mean = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length;

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The first day of the month `delta` months from the month of date d (UTC). */
function monthStart(d: Date, delta: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + delta, 1));
}

export async function computeIndependence(now = new Date()): Promise<Independence> {
  const settings = await getSettings();

  // window - the last windowMonths whole months; amortization - 12 whole months
  const windowFrom = monthStart(now, -settings.windowMonths);
  const amortFrom = monthStart(now, -12);
  const to = new Date(monthStart(now, 0).getTime() - 1); // end of last month

  const fromIso = amortFrom.toISOString();
  const toIso = to.toISOString();
  const monthly = await summaryMonthlyTotals({ kind: 'workspace' }, fromIso, toIso);

  // one-off amortization: the 12-month total / 12, even with less than a year of data -
  // still divided by 12, so rare purchases don't spike on a short history
  const oneOffMonthly = round2(monthly.reduce((s, m) => s + m.expenseOneOff, 0) / 12);

  const windowFromKey = windowFrom.toISOString().slice(0, 7);
  const inWindow = (m: MonthTotals) => m.month >= windowFromKey;
  const months: IndependenceMonth[] = monthly.filter(inWindow).map((m) => ({
    month: m.month,
    spend: round2(m.expense - m.expenseOneOff + oneOffMonthly),
    ownIncome: m.incomeOwn,
    external: m.incomeExternal,
  }));

  const avgSpend = round2(median(months.map((m) => m.spend)));
  const ownIncomeAvg = round2(mean(months.map((m) => m.ownIncome)));
  const externalAvg = round2(mean(months.map((m) => m.external)));

  const buffer = 1 + settings.bufferPct / 100;
  const baselineItems = await listBaselineItems();
  const baselineSum = await baselineTotal();
  const baselineThreshold = round2(baselineSum * buffer);
  const lifestyleThreshold = round2(avgSpend * buffer);

  // The mode's base: both the threshold and self-sufficiency are computed from it.
  // If there are no minimum line items yet (empty table), baseline mode would give a
  // threshold of 0 - fall back to the median so the screen does not show "goal reached".
  const effectiveMode: GoalMode =
    settings.goalMode === 'baseline' && baselineSum > 0 ? 'baseline' : 'lifestyle';
  const useBaseline = effectiveMode === 'baseline';
  const base = useBaseline ? baselineSum : avgSpend;
  const threshold = useBaseline ? baselineThreshold : lifestyleThreshold;
  const deficit = round2(Math.max(0, threshold - ownIncomeAvg));
  const selfSufficiency = base > 0 ? round2(ownIncomeAvg / base) : 0;

  const byCategory = await avgMonthlyByCategory(
    windowFrom.toISOString(),
    toIso,
    Math.max(1, months.length),
  );
  if (oneOffMonthly > 0) {
    // pseudo-category "One-off (avg)" - the label comes from the client dictionary
    byCategory.push({ category: 'one-off-avg', total: oneOffMonthly });
    byCategory.sort((a, b) => b.total - a.total);
  }

  let hours: Independence['hours'] = null;
  if (settings.hourlyRate && settings.hourlyRate > 0) {
    const capPerMonth = round2((settings.hoursCapPerWeek * 52) / 12);
    const totalHoursPerMonth = round2(threshold / settings.hourlyRate);
    hours = {
      hourlyRate: settings.hourlyRate,
      extraHoursPerMonth: round2(deficit / settings.hourlyRate),
      totalHoursPerMonth,
      capPerMonth,
      capExceeded: totalHoursPerMonth > capPerMonth,
    };
  }

  return {
    baseCurrency: await currentBaseCurrency(),
    settings,
    from: windowFrom.toISOString().slice(0, 10),
    to: toIso.slice(0, 10),
    avgSpend,
    oneOffMonthly,
    ownIncomeAvg,
    externalAvg,
    baselineSum,
    baselineItems,
    baselineThreshold,
    lifestyleThreshold,
    effectiveMode,
    threshold,
    deficit,
    selfSufficiency,
    months,
    byCategory,
    hours,
  };
}
