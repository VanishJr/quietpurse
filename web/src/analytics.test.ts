import { describe, expect, it } from 'vitest';
import {
  boundsOf,
  compareShares,
  positiveShares,
  priorBoundsOf,
  rankingSeriesName,
  rangeDef,
  seriesFromMonths,
  shareFromSummary,
  suggestedTitle,
  ticksOf,
  SummarySplits,
} from './analytics';
import { AccountMonthTotals, Chart, ChartRange, MonthTotals } from './types';

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

/**
 * The other arm's month, built as the type the endpoint answers rather than as a
 * literal shaped for the assertion: `net` is a field of that payload, and the case
 * below is about the function not being able to read it.
 */
const accountMonth = (
  m: string,
  income: number,
  expense: number,
  net: number,
): AccountMonthTotals => ({ month: m, income, expense, net });

/** The three splits a share is drawn from, whichever arm of the endpoint answered. */
const splits = (patch: Partial<SummarySplits> = {}): SummarySplits => ({
  byCategory: [],
  incomeByCategory: [],
  incomeBySource: [],
  ...patch,
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
    const [workspace] = seriesFromMonths([month('2026-08', 1000, 1750)], ['2026-08'], 'month');
    expect(workspace.net).toBe(-750);

    /*
     * The account arm answers a month that carries a balance movement of its own: its
     * `net` is every row summed, transfers included, so that the months add up to the
     * balance printed beside them. 1,000 in, 400 spent and a 400 transfer out is 200 of
     * balance and 600 of bottom line, and a chart draws the second.
     */
    const [account] = seriesFromMonths(
      [accountMonth('2026-08', 1000, 400, 200)],
      ['2026-08'],
      'month',
    );
    expect(account.net).toBe(600);
  });

  it('adds in cents, so a column of hundredths does not accumulate a residue', () => {
    // the residue moved with the arithmetic — months onto a year tick, where it used to
    // be rows onto a month. Added as the doubles they arrive as, three of these are
    // 577.3499999999999
    const months = ['2026-01', '2026-02', '2026-03'].map((m) => month(m, 0, 192.45));
    const [point] = seriesFromMonths(months, ['2026'], 'year');
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
    seriesFromMonths([], ticksOf(rangeDef(range as ChartRange), AUG), 'month').map((p) => p.label);

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
  it('splits a period on the side that was asked for, sources included', () => {
    const summary = splits({
      byCategory: [
        { category: 'food', total: 100 },
        { category: 'transport', total: 40 },
      ],
      incomeByCategory: [{ category: 'salary', total: 900 }],
      incomeBySource: [{ source: 'src-1', label: 'Acme GmbH', kind: 'own', total: 900 }],
    });

    expect(shareFromSummary(summary, 'expense-categories')).toEqual([
      { key: 'food', label: 'Food', value: 100 },
      { key: 'transport', label: 'Transport', value: 40 },
    ]);
    expect(shareFromSummary(summary, 'income-categories')).toEqual([
      { key: 'salary', label: 'Salary', value: 900 },
    ]);
    // named out of the server's own catalogue rather than a category dictionary — and
    // answered for one account as readily as for every account together
    expect(shareFromSummary(summary, 'income-sources')).toEqual([
      { key: 'src-1', label: 'Acme GmbH', value: 900 },
    ]);
  });

  it('keeps a category a refund pushed negative, and keeps it out of the sectors', () => {
    // the purchase was in an earlier period and only the refund landed in this one, so
    // the figure the server answers for Shopping is below zero
    const shares = shareFromSummary(
      splits({
        byCategory: [
          { category: 'food', total: 20 },
          { category: 'shopping', total: -60 },
        ],
      }),
      'expense-categories',
    );

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
  const spec: Chart = {
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
