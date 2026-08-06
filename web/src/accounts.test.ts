import { describe, expect, it } from 'vitest';
import {
  balanceChange,
  foreignCurrencies,
  latestMonth,
  LONGEST_WINDOW,
  monthlyTotals,
  MONTH_WINDOWS,
  monthOf,
  monthRange,
  percentChange,
  priorMonth,
  shiftMonth,
  totals,
} from './accounts';
import { Transaction } from './types';

/** One row, named by what the test is about. Everything else is a plausible default. */
const tx = (patch: Partial<Transaction> & { date: string; amount: number }): Transaction => ({
  id: `t-${patch.date}-${patch.amount}`,
  accountId: 'acc-1',
  provider: 'upload',
  currency: 'EUR',
  description: 'row',
  category: 'other',
  transfer: false,
  transferManual: null,
  refund: false,
  ...patch,
});

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
});

describe('totals', () => {
  it('leaves transfers out of both sides', () => {
    // the whole reason Balance is not Income − Expense, and the line on the screen
    // that says so is only true if this holds
    const rows = [
      tx({ date: '2026-07-01', amount: -500, transfer: true }),
      tx({ date: '2026-07-02', amount: 500, transfer: true }),
      tx({ date: '2026-07-03', amount: -20 }),
    ];
    expect(totals(rows)).toEqual({ income: 0, expense: 20, net: -20 });
  });

  it('subtracts a refund from expenses instead of adding it to income', () => {
    const rows = [
      tx({ date: '2026-07-01', amount: -100 }),
      tx({ date: '2026-07-09', amount: 30, refund: true }),
    ];
    expect(totals(rows)).toEqual({ income: 0, expense: 70, net: -70 });
  });

  it('lets a month of refunds go negative rather than inventing income', () => {
    // the purchase was in June, the refund landed in July: July really did spend −40
    expect(totals([tx({ date: '2026-07-09', amount: 40, refund: true })])).toEqual({
      income: 0,
      expense: -40,
      net: 40,
    });
  });

  it('counts a zero-amount row as neither', () => {
    expect(totals([tx({ date: '2026-07-01', amount: 0 })])).toEqual({
      income: 0,
      expense: 0,
      net: 0,
    });
  });
});

describe('monthlyTotals', () => {
  const july = tx({ date: '2026-07-04', amount: -60 });
  const august = tx({ date: '2026-08-04', amount: 900 });

  it('ends at the newest month with data, not at the current month', () => {
    // somebody who uploaded July and is looking at the screen in September wants July
    // at the right-hand edge, not two empty months with July pushed off-centre
    const months = monthlyTotals([july], 3);
    expect(months.map((m) => m.month)).toEqual(['2026-07']);
  });

  it('never starts before the first month the account has', () => {
    const months = monthlyTotals([july, august], 12);
    expect(months.map((m) => m.month)).toEqual(['2026-07', '2026-08']);
  });

  it('keeps a gap inside the range, because an empty month is a fact', () => {
    const months = monthlyTotals([tx({ date: '2026-05-04', amount: -10 }), august], 12);
    expect(months.map((m) => m.month)).toEqual(['2026-05', '2026-06', '2026-07', '2026-08']);
    expect(months[1]).toEqual({ month: '2026-06', income: 0, expense: 0, net: 0 });
  });

  it('cuts the range to the window from the newest end', () => {
    const rows = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05'].map((m) =>
      tx({ date: `${m}-15`, amount: -10 }),
    );
    expect(monthlyTotals(rows, 3).map((m) => m.month)).toEqual(['2026-03', '2026-04', '2026-05']);
  });

  it('keeps a month that holds nothing but transfers', () => {
    // dropping it would move the anchor and quietly reshape the window
    const months = monthlyTotals(
      [july, tx({ date: '2026-08-02', amount: -300, transfer: true })],
      12,
    );
    expect(months.map((m) => m.month)).toEqual(['2026-07', '2026-08']);
    expect(months[1]).toEqual({ month: '2026-08', income: 0, expense: 0, net: -300 });
  });

  it('answers nothing for an account with nothing in it', () => {
    expect(monthlyTotals([], 12)).toEqual([]);
    expect(latestMonth([])).toBeNull();
  });

  it('names the newest month as the one the headline figures are about', () => {
    expect(latestMonth(monthlyTotals([july, august], 12))).toEqual({
      month: '2026-08',
      income: 900,
      expense: 0,
      net: 900,
    });
  });
});

describe('foreignCurrencies', () => {
  it('is empty for the ordinary account', () => {
    expect(foreignCurrencies([tx({ date: '2026-07-01', amount: -10 })], 'EUR')).toEqual([]);
  });

  it('names what does not belong, so the screen can stop adding two units together', () => {
    const rows = [
      tx({ date: '2026-07-01', amount: -10, currency: 'USD' }),
      tx({ date: '2026-07-02', amount: -10, currency: 'PLN' }),
      tx({ date: '2026-07-03', amount: -10, currency: 'USD' }),
    ];
    expect(foreignCurrencies(rows, 'EUR')).toEqual(['PLN', 'USD']);
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
    const months = monthlyTotals(
      [tx({ date: '2026-07-04', amount: -60 }), tx({ date: '2026-08-04', amount: -120 })],
      12,
    );
    expect(priorMonth(months)?.month).toBe('2026-07');
    expect(priorMonth(months.slice(1))).toBeNull();
  });

  it('derives the balance it started the month with rather than remembering one', () => {
    // no history of the balance is stored anywhere, but the balance IS the sum of
    // every row — so what it was before this month is today's balance less the month
    const months = monthlyTotals([tx({ date: '2026-08-04', amount: 100 })], 12);
    // 1100 now, +100 over August, so it opened at 1000
    expect(balanceChange(1100, latestMonth(months))).toBeCloseTo(10);
    expect(balanceChange(1100, null)).toBeNull();
  });

  it('counts a transfer in the balance, which is the one place it belongs', () => {
    // it is neither income nor an expense and it still moves the money
    const months = monthlyTotals([tx({ date: '2026-08-02', amount: -300, transfer: true })], 12);
    expect(latestMonth(months)).toEqual({
      month: '2026-08',
      income: 0,
      expense: 0,
      net: -300,
    });
  });
});

describe('money is counted in cents, not in doubles', () => {
  /** Ten of these added as doubles is 0.9999999999999999, not 1. */
  const tenth = (day: number) =>
    tx({ date: `2026-07-${String(day).padStart(2, '0')}`, amount: 0.1 });

  it('sums to the number a person would write', () => {
    const rows = Array.from({ length: 10 }, (_, i) => tenth(i + 1));
    const sum = totals(rows);
    expect(sum.income).toBe(1);
    expect(sum.net).toBe(1);
  });

  it('answers no percentage when the account opened the month at zero', () => {
    // The defect this pins, from a real account: one month of history, so the balance
    // before it was exactly zero — balance minus the month's net. As doubles that
    // subtraction leaves a residue near 1e-16 instead, and the percentage taken
    // against it rendered as 103138588731900000.0%.
    const months = monthlyTotals(
      Array.from({ length: 10 }, (_, i) => tenth(i + 1)),
      12,
    );
    expect(balanceChange(1, latestMonth(months))).toBeNull();
  });

  it('still answers a percentage when there really is a base', () => {
    const months = monthlyTotals([tx({ date: '2026-08-04', amount: 100 })], 12);
    expect(balanceChange(1100, latestMonth(months))).toBeCloseTo(10);
  });
});
