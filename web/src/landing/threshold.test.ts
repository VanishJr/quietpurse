import { describe, expect, it } from 'vitest';
import { BUFFER_PCT, computeThreshold, HOURS_CAP_PER_WEEK } from './threshold';

/**
 * The landing's calculator runs the Goal screen's arithmetic on numbers a visitor
 * typed. Copied code drifts, and a marketing page quietly disagreeing with the
 * product it is selling is worse than one that says nothing — so what is pinned
 * here is the arithmetic itself, against `backend/src/independence.ts` as it stood
 * when this was written.
 */

const money = (over: Partial<Parameters<typeof computeThreshold>[0]> = {}) =>
  computeThreshold({ spend: 1000, ownIncome: 600, external: 300, hourlyRate: 12, ...over });

describe('the threshold', () => {
  it('is spending plus the buffer, not spending', () => {
    expect(BUFFER_PCT).toBe(10);
    expect(money().threshold).toBe(1100);
  });

  it('takes the shortfall from the threshold, so the buffer is part of what is missing', () => {
    // 1100 - 600. The margin of safety is a thing you have to earn too
    expect(money().deficit).toBe(500);
  });

  it('never reports a negative shortfall', () => {
    expect(money({ ownIncome: 5000 }).deficit).toBe(0);
  });
});

describe('self-sufficiency', () => {
  it('is measured against spending and not against the threshold', () => {
    // 600/1000, not 600/1100: counting the buffer would report everyone poorer
    // than they are, and the server divides by `base` for the same reason
    expect(money().selfSufficiency).toBeCloseTo(0.6);
  });

  it('passes 1 when own income covers the month, whatever help also arrived', () => {
    expect(money({ ownIncome: 1200, external: 800 }).selfSufficiency).toBeCloseTo(1.2);
  });

  it('counts none of the help, which is the whole point of it', () => {
    const alone = money({ ownIncome: 600, external: 0 });
    const helped = money({ ownIncome: 600, external: 400 });
    expect(helped.selfSufficiency).toBe(alone.selfSufficiency);
  });

  it('is 0 rather than a division by zero when nothing has been typed', () => {
    expect(money({ spend: 0, ownIncome: 0, external: 0 }).selfSufficiency).toBe(0);
  });
});

describe('the bar, which has to add up to the month', () => {
  it('fills with what was earned first and what was given second', () => {
    // the other order draws help as the foundation own income sits on top of
    expect(money().covered).toEqual({ own: 600, external: 300, uncovered: 100 });
  });

  it('never draws more than the month costs', () => {
    const { covered } = money({ ownIncome: 900, external: 900 });
    expect(covered.own + covered.external + covered.uncovered).toBe(1000);
    expect(covered.external).toBe(100);
  });

  it('leaves the whole month uncovered when nothing came in', () => {
    expect(money({ ownIncome: 0, external: 0 }).covered).toEqual({
      own: 0,
      external: 0,
      uncovered: 1000,
    });
  });
});

describe('the same shortfall in hours', () => {
  it('is the shortfall over the rate, and the ceiling is the week times 52 over 12', () => {
    expect(HOURS_CAP_PER_WEEK).toBe(20);
    expect(money().extraHoursPerMonth).toBeCloseTo(500 / 12, 2);
    expect(money().capPerMonth).toBeCloseTo(86.67, 2);
  });

  it('says when the whole threshold will not fit under the ceiling', () => {
    // 1100 at 5/hour is 220 hours a month against a ceiling of 86.67: the answer
    // is not "work more", and a screen that only printed the hours would imply it
    expect(money({ hourlyRate: 5 }).capExceeded).toBe(true);
    expect(money({ hourlyRate: 20 }).capExceeded).toBe(false);
  });

  it('reports no hours at all rather than dividing by a rate nobody gave', () => {
    const none = money({ hourlyRate: 0 });
    expect(none.extraHoursPerMonth).toBe(0);
    expect(none.totalHoursPerMonth).toBe(0);
    expect(none.capExceeded).toBe(false);
  });
});
