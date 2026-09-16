import { describe, expect, it } from 'vitest';
import { tooltipPercent } from './chartTooltip';
import { selfSufficiencyBars } from './independence';
import { IndependenceMonth } from './types';

const month = (m: Partial<IndependenceMonth> & { month: string }): IndependenceMonth => ({
  spend: 0,
  ownIncome: 0,
  external: 0,
  ...m,
});

describe('the Goal screen’s month bars', () => {
  /*
   * The fixture is built FROM the bound: 3400 against a base of 1000 is 340%, well past
   * the 150% a bar is allowed to draw, so the two fields are different numbers here and
   * a test that read the wrong one could not stay green. A month that never approaches
   * the clamp asserts nothing about it.
   */
  it('draws the clamp and prints the true ratio, which are two different numbers', () => {
    const [bar] = selfSufficiencyBars([month({ month: '2026-03', ownIncome: 3400 })], true, 1000);
    expect(bar.drawn).toBe(150);
    expect(bar.actual).toBe(340);
    expect(tooltipPercent(bar.actual)).toBe('340%');
  });

  it('leaves a month under the clamp alone, where the two figures agree', () => {
    const [bar] = selfSufficiencyBars([month({ month: '2026-03', ownIncome: 820 })], true, 1000);
    expect(bar.drawn).toBe(82);
    expect(bar.actual).toBe(82);
    expect(bar.reached).toBe(false);
  });

  it('measures each month against its own spending when the mode is not the minimum', () => {
    const bars = selfSufficiencyBars(
      [
        month({ month: '2026-01', spend: 900, ownIncome: 900 }),
        month({ month: '2026-02', spend: 1800, ownIncome: 900 }),
      ],
      false,
      1000,
    );
    expect(bars.map((b) => b.actual)).toEqual([100, 50]);
    expect(bars.map((b) => b.reached)).toEqual([true, false]);
    expect(bars.map((b) => b.label)).toEqual(['Jan', 'Feb']);
  });

  /*
   * A month with no base is not 0% self-sufficient, and this pins what the screen does
   * today rather than endorsing it — it is a known gap, not this case's to close.
   */
  it('answers zero for a month with nothing to be a share of', () => {
    const [bar] = selfSufficiencyBars([month({ month: '2026-03', ownIncome: 500 })], false, 0);
    expect(bar).toMatchObject({ drawn: 0, actual: 0, reached: false });
  });
});
