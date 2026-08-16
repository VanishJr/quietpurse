import { describe, expect, it } from 'vitest';
import {
  balanceChange,
  latestMonth,
  LONGEST_WINDOW,
  monthEnd,
  MONTH_WINDOWS,
  monthOf,
  monthRange,
  percentChange,
  priorMonth,
  shiftMonth,
  windowMonths,
} from './accounts';
import { AccountMonthTotals } from './types';

/**
 * One month as `/api/summary/months` answers it, named by what the test is about.
 * The server sends only the months that have rows; everything below is about what the
 * client does with that.
 */
const month = (
  key: string,
  patch: Partial<Omit<AccountMonthTotals, 'month'>> = {},
): AccountMonthTotals => ({ month: key, income: 0, expense: 0, net: 0, ...patch });

describe('the month arithmetic', () => {
  it('takes the month off the string', () => {
    expect(monthOf('2026-07-05T23:30:00.000Z')).toBe('2026-07');
    expect(monthOf('2026-01-01')).toBe('2026-01');
  });

  it('shifts across a year boundary in both directions', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2025-12', 1)).toBe('2026-01');
    expect(shiftMonth('2026-08', -11)).toBe('2025-09');
  });

  it('fills a range inclusively, gaps and all', () => {
    expect(monthRange('2026-05', '2026-08')).toEqual(['2026-05', '2026-06', '2026-07', '2026-08']);
    expect(monthRange('2026-07', '2026-07')).toEqual(['2026-07']);
  });

  it('offers a longest window the fetch can be sized from', () => {
    expect(LONGEST_WINDOW).toBe(Math.max(...MONTH_WINDOWS));
  });

  /**
   * The expectation is built out of the month key it is about, which is the whole
   * point: a `to` short by one day drops the last day of the month out of every figure
   * on the screen, and a case that named some other month's last day would be green
   * against an implementation that never approached the boundary.
   */
  it.each([
    ['2026-08', 31],
    ['2026-09', 30],
    ['2026-12', 31],
    ['2024-02', 29],
  ])('ends %s on day %i, in UTC rather than wherever the reader is', (key, day) => {
    expect(monthEnd(key)).toBe(`${key}-${day}`);
  });
});

describe('windowMonths', () => {
  const july = month('2026-07', { expense: 60, net: -60 });
  const august = month('2026-08', { income: 900, net: 900 });

  it('ends at the newest month with data, not at the current month', () => {
    // somebody who uploaded July and is looking at the screen in September wants July
    // at the right-hand edge, not two empty months with July pushed off-centre
    const months = windowMonths([july], 3);
    expect(months.map((m) => m.month)).toEqual(['2026-07']);
  });

  it('never starts before the first month the account has', () => {
    const months = windowMonths([july, august], 12);
    expect(months.map((m) => m.month)).toEqual(['2026-07', '2026-08']);
  });

  it('keeps a gap inside the range, because an empty month is a fact', () => {
    // the server answers only the months that have rows, so this filling is the
    // client's alone — and it is what makes `priorMonth` the adjacent month
    const months = windowMonths([month('2026-05', { expense: 10, net: -10 }), august], 12);
    expect(months.map((m) => m.month)).toEqual(['2026-05', '2026-06', '2026-07', '2026-08']);
    expect(months[1]).toEqual({ month: '2026-06', income: 0, expense: 0, net: 0 });
  });

  it('cuts the range to the window from the newest end', () => {
    const rows = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05'].map((m) =>
      month(m, { expense: 10, net: -10 }),
    );
    expect(windowMonths(rows, 3).map((m) => m.month)).toEqual(['2026-03', '2026-04', '2026-05']);
  });

  it('keeps a month that holds nothing but transfers', () => {
    // dropping it would move the anchor and quietly reshape the window. It reaches the
    // client at all because `net` carries no transfer filter on the server either.
    const months = windowMonths([july, month('2026-08', { net: -300 })], 12);
    expect(months.map((m) => m.month)).toEqual(['2026-07', '2026-08']);
    expect(months[1]).toEqual({ month: '2026-08', income: 0, expense: 0, net: -300 });
  });

  it('answers nothing for an account with nothing in it', () => {
    expect(windowMonths([], 12)).toEqual([]);
    expect(latestMonth([])).toBeNull();
  });

  it('names the newest month as the one the headline figures are about', () => {
    expect(latestMonth(windowMonths([july, august], 12))).toEqual({
      month: '2026-08',
      income: 900,
      expense: 0,
      net: 900,
    });
  });
});

describe('the comparisons on the three cards', () => {
  it('refuses to put a percentage on a rise from nothing', () => {
    // going from nothing to something is not a percentage, and printing one puts a
    // number on screen whose size means nothing
    expect(percentChange(900, 0)).toBeNull();
    expect(percentChange(0, 0)).toBeNull();
  });

  it('measures against the size of the base, in both directions', () => {
    expect(percentChange(120, 60)).toBe(100);
    expect(percentChange(30, 60)).toBe(-50);
  });

  it('names the month a comparison is against, and nothing when there is none', () => {
    const months = windowMonths(
      [month('2026-07', { expense: 60, net: -60 }), month('2026-08', { expense: 120, net: -120 })],
      12,
    );
    expect(priorMonth(months)?.month).toBe('2026-07');
    expect(priorMonth(months.slice(1))).toBeNull();
  });

  it('compares against the adjacent month of the window and not the answer’s', () => {
    // the server skips a month with no rows, so an implementation reading its array
    // straight through compares August with May and says "vs May" — or worse, says
    // "vs Jun" over May's figures
    const months = windowMonths(
      [month('2026-05', { expense: 60, net: -60 }), month('2026-07', { expense: 120, net: -120 })],
      12,
    );
    expect(priorMonth(months)).toEqual({ month: '2026-06', income: 0, expense: 0, net: 0 });
  });

  it('derives the balance it started the month with rather than remembering one', () => {
    // no history of the balance is stored anywhere, but the balance IS the sum of
    // every row — so what it was before this month is today's balance less the month
    const months = windowMonths([month('2026-08', { income: 100, net: 100 })], 12);
    // 1100 now, +100 over August, so it opened at 1000
    expect(balanceChange(1100, latestMonth(months))).toBeCloseTo(10);
    expect(balanceChange(1100, null)).toBeNull();
  });

  it('counts a transfer in the balance, which is the one place it belongs', () => {
    // it is neither income nor an expense and it still moves the money, which is why
    // `net` is taken from the body rather than rebuilt as income − expense
    const months = windowMonths([month('2026-08', { net: -300 })], 12);
    expect(latestMonth(months)).toEqual({
      month: '2026-08',
      income: 0,
      expense: 0,
      net: -300,
    });
    expect(balanceChange(700, latestMonth(months))).toBeCloseTo(-30);
  });
});

describe('money is counted in cents, not in doubles', () => {
  it('rounds to cents before deciding whether there is a base at all', () => {
    // The defect this pins, from a real account: one month of history, so the balance
    // before it was exactly zero — balance minus the month's net. As doubles that
    // subtraction can leave a residue near 1e-16 instead, and the percentage taken
    // against it rendered as 103138588731900000.0%. Rounding first is what makes the
    // null branch reachable exactly where it is needed.
    expect(percentChange(900, 0.1 + 0.2 - 0.3)).toBeNull();
  });

  it('answers no percentage when the account opened the month at zero', () => {
    const months = windowMonths([month('2026-08', { income: 1, net: 1 })], 12);
    expect(balanceChange(1, latestMonth(months))).toBeNull();
  });

  it('still answers a percentage when there really is a base', () => {
    const months = windowMonths([month('2026-08', { income: 100, net: 100 })], 12);
    expect(balanceChange(1100, latestMonth(months))).toBeCloseTo(10);
  });
});
