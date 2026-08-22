import { describe, expect, it } from 'vitest';
import {
  boundsOf,
  compareShares,
  positiveShares,
  priorBoundsOf,
  rankingSeriesName,
  rangeDef,
  seriesFromMonths,
  seriesFromTransactions,
  shareFromTransactions,
  suggestedTitle,
  ticksOf,
  ChartSpec,
  RangeKey,
} from './analytics';
import { MonthTotals, Transaction } from './types';

/**
 * The workspace's arithmetic, which is the half of it a screen test cannot reach:
 * recharts draws into a 0x0 box in jsdom, so what a chart is a picture OF has to be
 * asserted here or nowhere.
 *
 * `today` is an argument to every function under test, which is what makes this file
 * possible at all — a window that ends "at the month we are in" is untestable if the
 * month is read off the clock inside the sum.
 */

/** 15 August 2026. Local, which the unit project pins to UTC. */
const AUG = new Date(2026, 7, 15);

const month = (m: string, income: number, expense: number): MonthTotals => ({
  month: m,
  income,
  expense,
  expenseOneOff: 0,
  incomeOwn: income,
  incomeExternal: 0,
});

const tx = (over: Partial<Transaction>): Transaction => ({
  id: 't1',
  accountId: 'acc-1',
  provider: 'upload',
  amount: -10,
  currency: 'EUR',
  date: '2026-08-04',
  description: 'a row',
  category: 'food',
  transfer: false,
  transferManual: null,
  refund: false,
  ...over,
});

describe('the window a range asks for', () => {
  it('ends at the tick we are in, and counts back from it', () => {
    expect(ticksOf(rangeDef('3m'), AUG)).toEqual(['2026-06', '2026-07', '2026-08']);
    expect(ticksOf(rangeDef('3y'), AUG)).toEqual(['2024', '2025', '2026']);
  });

  it('covers whole calendar units, month ends included', () => {
    expect(boundsOf(rangeDef('3m'), AUG)).toEqual({ from: '2026-06-01', to: '2026-08-31' });
    expect(boundsOf(rangeDef('3y'), AUG)).toEqual({ from: '2024-01-01', to: '2026-12-31' });
    // day 0 of the next month, so February in a leap year is the 29th and not the 28th
    expect(boundsOf(rangeDef('3m'), new Date(2024, 1, 10)).to).toBe('2024-02-29');
  });

  it('puts the comparison window immediately before it, with no gap and no overlap', () => {
    expect(priorBoundsOf(rangeDef('3m'), AUG)).toEqual({
      from: '2026-03-01',
      to: '2026-05-31',
    });
    expect(priorBoundsOf(rangeDef('3y'), AUG)).toEqual({
      from: '2021-01-01',
      to: '2023-12-31',
    });
  });
});

describe('a series across ticks', () => {
  const ticks = ticksOf(rangeDef('3m'), AUG);

  it('folds the months it was given onto the ticks and zeroes the rest', () => {
    const points = seriesFromMonths([month('2026-08', 4000, 1200)], ticks, 'month');

    expect(points.map((p) => p.tick)).toEqual(ticks);
    expect(points.map((p) => p.expense)).toEqual([0, 0, 1200]);
    // a month with nothing in it is part of the answer here — the window is the one the
    // reader chose, not one derived from where the data happens to start
    expect(points[0].income).toBe(0);
  });

  it('sums a year grain out of the months under it', () => {
    const points = seriesFromMonths(
      [month('2026-01', 1000, 400), month('2026-07', 2000, 600)],
      ['2025', '2026'],
      'year',
    );

    expect(points.map((p) => p.income)).toEqual([0, 3000]);
    expect(points.map((p) => p.expense)).toEqual([0, 1000]);
  });

  it('reads net as income minus expenses, and never as the balance movement', () => {
    const [point] = seriesFromMonths([month('2026-08', 1000, 1750)], ['2026-08'], 'month');
    expect(point.net).toBe(-750);
  });

  it('applies the server rules to one account: transfers are neither, a refund subtracts', () => {
    const rows = [
      tx({ id: 'a', amount: -100 }),
      tx({ id: 'b', amount: 900, category: 'salary' }),
      // moved between the reader's own accounts: not income, not an expense
      tx({ id: 'c', amount: -500, transfer: true }),
      // comes in positive and comes off expenses rather than adding to income
      tx({ id: 'd', amount: 30, refund: true }),
    ];

    const [point] = seriesFromTransactions(rows, ['2026-08'], 'month');

    expect(point.income).toBe(900);
    expect(point.expense).toBe(70);
    expect(point.net).toBe(830);
  });

  it('adds in cents, so a column of hundredths does not accumulate a residue', () => {
    const rows = Array.from({ length: 3 }, (_, i) => tx({ id: `r${i}`, amount: -192.45 }));
    const [point] = seriesFromTransactions(rows, ['2026-08'], 'month');
    expect(point.expense).toBe(577.35);
  });
});

/**
 * What the axis prints, which is also what the tooltip does: recharts echoes back
 * whatever `XAxis dataKey` names, and the card carries no subtitle stating the window
 * any more. So a label that does not say which August it is has nothing behind it that
 * would.
 */
describe('the name a tick goes on the axis under', () => {
  const labels = (range: string): string[] =>
    seriesFromMonths([], ticksOf(rangeDef(range as RangeKey), AUG), 'month').map((p) => p.label);

  it('leaves the year off a window that is inside one', () => {
    expect(labels('3m')).toEqual(['Jun', 'Jul', 'Aug']);
  });

  it('puts it on once the window crosses one, which the default window does', () => {
    // twelve months back from August is the September before it: only a window ending
    // in December stays inside a single year
    const year = labels('12m');
    expect(year[0]).toBe('Sep 25');
    expect(year[year.length - 1]).toBe('Aug 26');
  });

  it('tells two Augusts apart on the range that holds two of them', () => {
    expect(labels('24m').filter((l) => l.startsWith('Aug'))).toEqual(['Aug 25', 'Aug 26']);
  });

  it('leaves a year tick as the year it already is', () => {
    const points = seriesFromMonths([], ['2025', '2026'], 'year');
    expect(points.map((p) => p.label)).toEqual(['2025', '2026']);
  });

  /* The hidden table under every plot prints `tick` and not `label` — see `ChartCard` —
     so the reader who gets no SVG was never given the ambiguous form to begin with. */
  it('keeps the tick itself whole, whatever the label does to it', () => {
    expect(labels('12m').length).toBe(12);
    expect(seriesFromMonths([], ticksOf(rangeDef('12m'), AUG), 'month')[0].tick).toBe('2025-09');
  });
});

describe('the parts of one period', () => {
  it('splits an account by category, on the side that was asked for', () => {
    const rows = [
      tx({ id: 'a', amount: -100, category: 'food' }),
      tx({ id: 'b', amount: -40, category: 'transport' }),
      tx({ id: 'c', amount: 900, category: 'salary' }),
      tx({ id: 'd', amount: -500, category: 'food', transfer: true }),
    ];

    expect(shareFromTransactions(rows, 'expense-categories')).toEqual([
      { key: 'food', label: 'Food', value: 100 },
      { key: 'transport', label: 'Transport', value: 40 },
    ]);
    expect(shareFromTransactions(rows, 'income-categories')).toEqual([
      { key: 'salary', label: 'Salary', value: 900 },
    ]);
  });

  it('keeps a category a refund pushed negative, and keeps it out of the sectors', () => {
    const rows = [
      tx({ id: 'a', amount: -20, category: 'food' }),
      // the purchase was in an earlier period; this period's Shopping is below zero
      tx({ id: 'b', amount: 60, category: 'shopping', refund: true }),
    ];

    const shares = shareFromTransactions(rows, 'expense-categories');
    expect(shares.map((s) => s.value)).toEqual([20, -60]);
    // a donut cannot draw a negative sector; a bar chart has a baseline and can
    expect(positiveShares(shares).map((s) => s.key)).toEqual(['food']);
  });

  it('carries a part that exists only in the earlier window into the comparison', () => {
    const rows = compareShares(
      [{ key: 'food', label: 'Food', value: 100 }],
      [
        { key: 'food', label: 'Food', value: 80 },
        { key: 'health', label: 'Health', value: 45 },
      ],
    );

    // that Health went to nothing is exactly what a reader opens this chart to see
    expect(rows).toEqual([
      { key: 'food', label: 'Food', now: 100, before: 80 },
      { key: 'health', label: 'Health', now: 0, before: 45 },
    ]);
  });
});

describe('what a chart is called', () => {
  const spec: ChartSpec = {
    id: 'c1',
    kind: 'line',
    title: '',
    accountId: null,
    metrics: ['income', 'expense'],
    breakdown: 'expense-categories',
    range: '6m',
  };

  it('names a series by its measures and a share by its split', () => {
    expect(suggestedTitle(spec)).toBe('Income and Expenses · 6 months');
    expect(suggestedTitle({ ...spec, kind: 'donut' })).toBe('Expenses by category · 6 months');
  });

  /*
   * The card carries no line spelling the spec out under the title any more, so which
   * account a chart is about is in the name or it is nowhere.
   */
  it('leads with the account when the chart is about one, and not otherwise', () => {
    expect(suggestedTitle({ ...spec, accountId: 'acc-1' }, 'Sparkasse Giro')).toBe(
      'Sparkasse Giro · Income and Expenses · 6 months',
    );
    // a name for an account this workspace does not have would be an invention
    expect(suggestedTitle({ ...spec, accountId: 'acc-1' }, null)).toBe(
      'Income and Expenses · 6 months',
    );
    // ...and "All accounts" is the ordinary case, which says nothing
    expect(suggestedTitle(spec, 'Sparkasse Giro')).toBe('Income and Expenses · 6 months');
  });

  /*
   * The ranking's bars have no measure of their own to be named by, and what a reader
   * sees when they point at one is this word. It is the same Income/Expenses the rest
   * of the file is named from and never a third one.
   */
  it('names a ranking’s bars for the side of the ledger its rows are', () => {
    expect(rankingSeriesName('expense-categories')).toBe('Expenses');
    expect(rankingSeriesName('income-categories')).toBe('Income');
    expect(rankingSeriesName('income-sources')).toBe('Income');
  });
});
