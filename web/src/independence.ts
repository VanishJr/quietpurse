import { MONTHS_SHORT } from './format';
import { IndependenceMonth } from './types';

/**
 * How high a bar is allowed to draw. One month far over the line would flatten every
 * other bar into the axis, and the shape of the year is what the chart is for.
 */
const DRAWN_MAX_PCT = 150;

export interface SelfSufficiencyBar {
  /** the bar's height, %, capped at `DRAWN_MAX_PCT` */
  drawn: number;
  /**
   * the same month's true ratio, %, uncapped — and the only one of the two that may be
   * printed. Clamping a height is a chart convention; a tooltip saying the cap of a
   * month that was far over it is a number the reader takes away and is wrong.
   */
  actual: number;
  label: string;
  reached: boolean;
}

/**
 * In minimum mode the base is the same across every month ("did I cover my own
 * minimum"); otherwise it is that month's own spending.
 */
export function selfSufficiencyBars(
  months: IndependenceMonth[],
  isBaseline: boolean,
  baselineSum: number,
): SelfSufficiencyBar[] {
  return months.map((m) => {
    const monthBase = isBaseline ? baselineSum : m.spend;
    const ratio = monthBase > 0 ? m.ownIncome / monthBase : 0;
    const actual = Math.round(ratio * 100);
    const monthIdx = parseInt(m.month.slice(5, 7), 10) - 1;
    return {
      drawn: Math.min(DRAWN_MAX_PCT, actual),
      actual,
      label: MONTHS_SHORT[monthIdx],
      reached: ratio >= 1,
    };
  });
}
