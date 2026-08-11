import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BUDGETS } from '../test/fixtures';
import { fail, mockFetch, ok, renderThemed, Routes } from '../test/harness';
import { MonthlySummary, Summary } from '../types';
import { AnalyticsScreen } from './AnalyticsScreen';

/**
 * Item 16's second site, and the first test in this suite to mount a chart: a
 * non-empty byCategory puts the donut on screen, and recharts measures a 0x0 box in
 * jsdom. Nothing below asserts anything about a chart — not a sector, not a bar, not
 * an axis. Every assertion here is text.
 *
 * The summaries are file-local: SUMMARY in fixtures.ts is served to the App test by
 * FIRST_PAINT_ROUTES and stays empty so that test mounts no chart.
 */

const EMPTY_MONTH = 'No expenses this month.';
const EMPTY_YEAR = 'No expenses this year.';

const MONTH: Summary = {
  scope: 'workspace',
  from: '2026-08-01',
  to: '2026-08-31',
  baseCurrency: 'EUR',
  totals: { expense: 420.5, income: 1800 },
  byCategory: [
    { category: 'food', total: 300.5 },
    { category: 'transport', total: 120 },
  ],
  incomeByCategory: [{ category: 'salary', total: 1800 }],
  incomeBySource: [],
};

const NOTHING_SPENT: Summary = {
  ...MONTH,
  totals: { expense: 0, income: 0 },
  byCategory: [],
  incomeByCategory: [],
};

const YEAR: Summary = {
  scope: 'workspace',
  from: '2026-01-01',
  to: '2026-12-31',
  baseCurrency: 'EUR',
  totals: { expense: 3600, income: 12000 },
  byCategory: [{ category: 'food', total: 3600 }],
  incomeByCategory: [{ category: 'salary', total: 12000 }],
  incomeBySource: [],
};

const NOTHING_SPENT_YEAR: Summary = {
  ...YEAR,
  totals: { expense: 0, income: 0 },
  byCategory: [],
  incomeByCategory: [],
};

const YEAR_MONTHS: MonthlySummary = {
  scope: 'workspace',
  from: '2026-01-01',
  to: '2026-12-31',
  baseCurrency: 'EUR',
  months: ['2026-01', '2026-02', '2026-03'].map((month) => ({
    month,
    expense: 1200,
    expenseOneOff: 0,
    income: 4000,
    incomeOwn: 4000,
    incomeExternal: 0,
  })),
};

/**
 * The default anchor is the current month, so isCurrentMonth is true and BudgetsBlock
 * mounts with the screen. Its route always answers 200: an error line of its own would
 * be indistinguishable from the summary's, which is what these tests are about.
 */
const ANALYTICS_ROUTES: Routes = {
  'GET /api/summary': () => ok(MONTH),
  'GET /api/budgets': () => ok(BUDGETS),
};

const mount = () => renderThemed(<AnalyticsScreen />);

/** Both total cards, which read "—" until a summary has actually been read. */
const dashes = () => screen.getAllByText('—');

describe('the analytics totals and the category breakdown', () => {
  it('renders the totals and the legend it was given', async () => {
    // the mirror: without it every absence asserted below passes for free
    mockFetch(ANALYTICS_ROUTES);
    mount();

    expect(await screen.findByText('420.50 EUR')).toBeInTheDocument();
    expect(screen.getByText('1,800 EUR')).toBeInTheDocument();
    expect(screen.getByText('Food')).toBeInTheDocument();
    expect(screen.queryByText(EMPTY_MONTH)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Error:/)).not.toBeInTheDocument();
  });

  it('says the month is empty when the month really is empty', async () => {
    // the mirror for the test below, and the reason "0 EUR" cannot be banned suite-wide:
    // a workspace that spent nothing prints it honestly
    mockFetch({ ...ANALYTICS_ROUTES, 'GET /api/summary': () => ok(NOTHING_SPENT) });
    mount();

    expect(await screen.findByText(EMPTY_MONTH)).toBeInTheDocument();
    expect(screen.queryAllByText('0 EUR')).toHaveLength(2);
    expect(screen.queryByText(/^Error:/)).not.toBeInTheDocument();
  });

  it('invents no totals and claims no empty month when the summary could not be read', async () => {
    mockFetch({
      ...ANALYTICS_ROUTES,
      'GET /api/summary': () => fail(500, { error: 'the summary could not be computed' }),
    });
    mount();

    // anchor: the refusal, which exists only once the request came back
    expect(await screen.findByText(/the summary could not be computed/)).toBeInTheDocument();
    // the two biggest numbers on the screen used to read 0 EUR under the period label
    expect(dashes()).toHaveLength(2);
    expect(screen.queryAllByText('0 EUR')).toHaveLength(0);
    expect(screen.queryByText(EMPTY_MONTH)).not.toBeInTheDocument();
  });
});

describe('the year range', () => {
  it('keeps no total on screen when the months behind it were refused', async () => {
    mockFetch({
      ...ANALYTICS_ROUTES,
      'GET /api/summary': () => ok(YEAR),
      'GET /api/summary/months': () =>
        fail(500, { error: 'the monthly breakdown is unavailable' }),
    });
    mount();
    expect(await screen.findByText('3,600 EUR')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Year' }));

    expect(await screen.findByText(/the monthly breakdown is unavailable/)).toBeInTheDocument();
    // a real total above twelve empty bars describes two different loads of the same year
    expect(dashes()).toHaveLength(2);
    expect(screen.queryByText(EMPTY_YEAR)).not.toBeInTheDocument();
  });

  it('renders the year when both halves of it came back', async () => {
    // the mirror for the test above: without it, "no empty sentence" would also hold
    // for a year range that renders nothing whatsoever
    mockFetch({
      ...ANALYTICS_ROUTES,
      'GET /api/summary': () => ok(YEAR),
      'GET /api/summary/months': () => ok(YEAR_MONTHS),
    });
    mount();
    expect(await screen.findByText('3,600 EUR')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Year' }));

    expect(await screen.findByText(/On average 1,200 EUR per month/)).toBeInTheDocument();
    expect(screen.queryByText(EMPTY_YEAR)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Error:/)).not.toBeInTheDocument();
  });

  it('says the year is empty when the year really is empty', async () => {
    // the mirror for the two tests above, which assert that sentence absent and would
    // both hold if emptyText lost its year branch and said "month" all year round
    let reads = 0;
    mockFetch({
      ...ANALYTICS_ROUTES,
      // keyOf drops the query string, so both ranges arrive on the one key
      'GET /api/summary': () => {
        reads += 1;
        return reads === 1 ? ok(MONTH) : ok(NOTHING_SPENT_YEAR);
      },
      'GET /api/summary/months': () => ok({ ...YEAR_MONTHS, months: [] }),
    });
    mount();
    expect(await screen.findByText('420.50 EUR')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Year' }));

    expect(await screen.findByText(EMPTY_YEAR)).toBeInTheDocument();
    expect(screen.queryByText(EMPTY_MONTH)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Error:/)).not.toBeInTheDocument();
  });
});
