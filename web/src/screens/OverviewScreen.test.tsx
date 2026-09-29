import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { COUNT_LIMIT } from '../components/AccountDialog';
import { RECENT_LIMIT } from '../components/RecentTransactions';
import {
  ACCOUNTS,
  accountMonths,
  accountSummary,
  APP_SETTINGS,
  importRecord,
  importsResponse,
  PRESETS,
  summaryResult,
  SUMMARY,
} from '../test/fixtures';
import {
  askedFor,
  fail,
  mockFetch,
  ok,
  renderThemed,
  requests,
  requestUrls,
  Routes,
} from '../test/harness';
import { fmtWeekday } from '../format';
import {
  Account,
  AccountDeleted,
  AccountMonthlySummary,
  AccountMonthTotals,
  AccountSummary,
  Transaction,
} from '../types';
import { setUrl } from '../url';
import { OverviewScreen } from './OverviewScreen';

/**
 * The Overview dashboard: the tab rail on the hero, and the four cells under it —
 * balance, income against expenses, spending by category, and the last transactions of
 * the account on the tab. Everything about the workspace rather than about one account
 * moved to the Account screen and is asserted there; the theme button and the avatar
 * moved to the navigation bar and are asserted in App.test.tsx.
 *
 * Two things this file cannot assert, both limits of the environment rather than gaps:
 * the two charts themselves — recharts measures a 0x0 box in jsdom — and anything about
 * width, so the narrow layout of the transactions table stays a manual check. Both
 * charts' numbers are asserted through the table beside each, which is the same data
 * and is what a screen reader gets.
 *
 * Note on the route table: the harness keys on method and path and discards the query,
 * so a handler is given the URL as its second argument. The two summary bodies below
 * are built from it — the account they answer for and the window they cover are the
 * ones that were asked for, which is both what api.ts insists on and what makes a
 * request for the wrong month show up as a card labelled with it.
 */

/** Newest first: the endpoint orders by date DESC, and the recent list trusts it. */
const txn = (date: string, amount: number, patch: Partial<Transaction> = {}): Transaction => ({
  id: `t-${date}-${amount}`,
  accountId: 'acc-1',
  provider: 'upload',
  currency: 'EUR',
  description: 'Row',
  category: 'other',
  categoryManual: false,
  transfer: false,
  transferManual: null,
  refund: false,
  incomeSourceManual: false,
  recurring: false,
  oneOff: false,
  date,
  amount,
  ...patch,
});

const TXS: Transaction[] = [
  txn('2026-08-04T00:00:00.000Z', 900, { description: 'ACME payroll', category: 'salary' }),
  txn('2026-08-03T00:00:00.000Z', -120, { description: 'Rewe', category: 'food' }),
  txn('2026-08-02T00:00:00.000Z', -300, { description: 'To savings', transfer: true }),
  txn('2026-07-20T00:00:00.000Z', -60, { description: 'Netflix', category: 'subscriptions' }),
];

/** The window the request named, so a body cannot claim a month nobody asked about. */
const asked = (url = '') => {
  const q = new URL(url, 'http://localhost').searchParams;
  return { from: q.get('from') ?? '', to: q.get('to') ?? '' };
};

/**
 * What the server would answer for TXS above, transcribed once: July is the one −60
 * row, August is +900 salary and −120 food with the −300 transfer out of both sides
 * and inside `net`. Those are the figures every assertion in this file was written
 * against when the screen added the rows up itself.
 */
const MONTHS: AccountMonthTotals[] = [
  { month: '2026-07', income: 0, expense: 60, net: -60 },
  { month: '2026-08', income: 900, expense: 120, net: 480 },
];

const monthsBody = (
  url?: string,
  months = MONTHS,
  patch: Partial<AccountMonthlySummary> = {},
): AccountMonthlySummary => accountMonths(askedFor(url), { ...asked(url), months, ...patch });

const summaryBody = (url?: string, patch: Partial<AccountSummary> = {}): AccountSummary =>
  accountSummary(askedFor(url), {
    ...asked(url),
    totals: { income: 900, expense: 120 },
    byCategory: [{ category: 'food', total: 120 }],
    incomeByCategory: [{ category: 'salary', total: 900 }],
    ...patch,
  });

const OVERVIEW_ROUTES: Routes = {
  'GET /api/accounts': () => ok(ACCOUNTS),
  'GET /api/app-settings': () => ok(APP_SETTINGS),
  'GET /api/transactions': () => ok(TXS),
  'GET /api/summary': (_init, url) => ok(summaryBody(url)),
  'GET /api/summary/months': (_init, url) => ok(monthsBody(url)),
};

const onOpenTransactions = vi.fn();
const onOpenAnalytics = vi.fn();

const theScreen = (
  <OverviewScreen
    onOpenTransactions={onOpenTransactions}
    onOpenAnalytics={onOpenAnalytics}
  />
);

/**
 * `at` is the URL the screen is arriving on, which is how the navigation asks it for
 * anything now: `?panel=import` was a counter prop, and `?account=` was a setter the
 * rail called. setup.ts puts the URL back to `/` between tests, so what is passed here
 * is the whole of what a test arrives with.
 */
const mount = (routes: Routes = OVERVIEW_ROUTES, at = '/') => {
  onOpenTransactions.mockClear();
  onOpenAnalytics.mockClear();
  window.history.replaceState(null, '', at);
  mockFetch(routes);
  return renderThemed(theScreen);
};

/** What the URL says now, for the assertions that are about the URL. */
const param = (key: string): string | null =>
  new URLSearchParams(window.location.search).get(key);

/** The anchor for the rail: no tab exists until /api/accounts came back. */
const tab = (name: string) => screen.findByRole('button', { name });

/**
 * The anchor for everything under the rail. It arrives three requests later than the
 * tab does — the recent seven, and then the two summaries they anchor — so a
 * synchronous query after `tab()` is a query run before the panel exists.
 */
const panel = (name: string) => screen.findByRole('region', { name });

const account = (patch: Partial<Account>): Account => ({
  id: 'acc-x',
  provider: 'upload',
  name: 'Account',
  currency: 'EUR',
  balance: 0,
  hidden: false,
  ...patch,
});

/** Everything already queued has run by the time a macrotask does. */
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

describe('the page heading', () => {
  it('names the page under today’s date', async () => {
    mount();
    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
    // the day this test runs on, formatted the one way fmtWeekday formats it — so the
    // assertion is that the line is drawn from a real clock, not that it says a date
    expect(screen.getByText(fmtWeekday(new Date()))).toBeInTheDocument();
  });

  it('leaves the theme choices and Settings navigation to the shell', async () => {
    mount();
    await panel('Sparkasse Giro');

    expect(screen.queryByRole('group', { name: 'Theme' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
  });

  it('opens the import panel for a URL that names it', async () => {
    mount({ ...OVERVIEW_ROUTES, 'GET /api/imports/presets': () => ok(PRESETS) }, '/?panel=import');

    const heading = await screen.findByRole('heading', { name: 'Import a statement' });
    expect(heading).toBeInTheDocument();
    expect(heading.closest('.import-page')).toBeInTheDocument();
    expect(heading.closest('.screen-inner')).toBeNull();
  });

  it('drops the panel from the URL on the way out, which is what the bar reads', async () => {
    // the bar cannot see this any other way: Import is a section up there and a panel
    // down here, so without it the bar marked Overview as the page over a full window
    // of Import. It was a callback, and a callback fired from a passive effect — one
    // frame late, every time — where this is the same fact in a place both can read.
    mount({ ...OVERVIEW_ROUTES, 'GET /api/imports/presets': () => ok(PRESETS) }, '/?panel=import');
    await screen.findByRole('heading', { name: 'Import a statement' });

    fireEvent.click(screen.getByRole('button', { name: '← Back to accounts' }));

    await panel('Sparkasse Giro');
    expect(param('panel')).toBeNull();
  });

  it('gives the dashboard back when the navigation drops the panel', async () => {
    // the bar could not do this by moving `tab`: the import panel IS this screen as far
    // as `tab` is concerned, so the click that asked to leave it changed nothing and
    // Import could be entered and never left. It took a counter of its own to fix, and
    // now it is the same write every other destination in the bar makes.
    mount({ ...OVERVIEW_ROUTES, 'GET /api/imports/presets': () => ok(PRESETS) }, '/?panel=import');
    await screen.findByRole('heading', { name: 'Import a statement' });

    act(() => setUrl({ panel: null }));

    expect(await panel('Sparkasse Giro')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Import a statement' })).not.toBeInTheDocument();
  });
});

describe('the URL', () => {
  it('opens on the account it names rather than on the first one', async () => {
    // the point of the whole parameter: a link to an account is a link to that account
    // in somebody else's window, and a reload is a link to yourself
    mount(OVERVIEW_ROUTES, '/?account=acc-1');

    expect(await panel('Balance of Sparkasse Giro')).toBeInTheDocument();
  });

  it('falls back to the first account when the URL names one that is not there', async () => {
    // deleted, hidden, or from somebody else's Finto — all the same case, and none of
    // them is a reason to paint a rail with no tab marked and nothing underneath it
    mount(OVERVIEW_ROUTES, '/?account=acc-does-not-exist');

    expect(await panel('Balance of Sparkasse Giro')).toBeInTheDocument();
  });

  it('names the account on the rail once one is chosen', async () => {
    mount();
    await panel('Sparkasse Giro');
    // nothing was chosen, so nothing is claimed: `?screen=overview` with no account is
    // a true URL, and writing today's first account into it hands out a link that goes
    // stale on the next upload
    expect(param('account')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Show 1 hidden account/ }));
    fireEvent.click(await tab('Old DKB (hidden)'));

    expect(param('account')).toBe('acc-2');
  });

  it('answers Back by putting the account it was on back on screen', async () => {
    mount();
    await panel('Balance of Sparkasse Giro');

    fireEvent.click(screen.getByRole('button', { name: /Show 1 hidden account/ }));
    fireEvent.click(await tab('Old DKB (hidden)'));
    expect(param('account')).toBe('acc-2');

    // what the browser's own control does to this screen, and nothing here answered it
    // before: every one of these was a `useState` the window had no way to reach
    act(() => window.history.back());

    await waitFor(() => expect(param('account')).toBeNull());
    expect(await panel('Balance of Sparkasse Giro')).toBeInTheDocument();
  });
});

describe('the tab rail', () => {
  it('gives each account a tab and keeps hidden ones off it', async () => {
    mount();

    expect(await tab('Sparkasse Giro')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Old DKB/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Show 1 hidden account/ })).toBeInTheDocument();
  });

  it('brings the hidden ones back onto the rail on request', async () => {
    mount();
    expect(await tab('Sparkasse Giro')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Show 1 hidden account/ }));

    expect(await tab('Old DKB (hidden)')).toBeInTheDocument();
  });

  it('carries the hidden badge in the tab’s own name and not only in its markup', async () => {
    // `aria-label` REPLACES the content of the button rather than adding to it, so the
    // badge inside was in the tree and out of the name: the one tab that is on the rail
    // only because the reader asked for the hidden ones sounded exactly like the two
    // that were never off it
    mount();
    expect(await tab('Sparkasse Giro')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Show 1 hidden account/ }));

    const hidden = await tab('Old DKB (hidden)');
    expect(hidden).toHaveTextContent('hidden');
    // and the account that is not hidden is not renamed on the way past
    expect(screen.getByRole('button', { name: 'Sparkasse Giro' })).toBeInTheDocument();
  });

  it('cuts a long name in the middle and keeps the whole one reachable', async () => {
    // the shape of a name that came out of a filename: .pdf and all, and everything
    // that tells two of them apart is at the end
    const long = 'report_03-09-2026_11-22-33.pdf';
    mount({
      ...OVERVIEW_ROUTES,
      'GET /api/accounts': () => ok([account({ id: 'acc-1', name: long })]),
    });

    // the accessible name is the whole thing, which is also what `title` carries
    const control = await tab(long);
    // ...and what is painted is not
    expect(control.textContent).not.toContain(long);
    expect(control.textContent).toContain('…');
    expect(control).toHaveAttribute('title', long);
  });

  it('pages when there are more accounts than fit a line, and follows the selection', async () => {
    const four = ['A', 'B', 'C', 'D'].map((n, i) =>
      account({ id: `acc-${i + 1}`, name: `Account ${n}` }),
    );
    mount({ ...OVERVIEW_ROUTES, 'GET /api/accounts': () => ok(four) });

    await panel('Account A');
    // three to a line: the fourth is behind the arrow
    expect(screen.queryByRole('button', { name: 'Account D' })).not.toBeInTheDocument();
    expect(screen.getByText(/4 accounts/)).toHaveTextContent('1 of 2');

    fireEvent.click(screen.getByRole('button', { name: 'Next accounts' }));

    expect(await tab('Account D')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Account A' })).not.toBeInTheDocument();
  });

  it('says nothing about paging with one line of accounts', async () => {
    mount();
    expect(await tab('Sparkasse Giro')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next accounts' })).not.toBeInTheDocument();
  });

  it('carries the hidden switch as a pressed state', async () => {
    // the icon is struck through while the hidden ones are on the rail: `aria-pressed`
    // is the whole of that fact for a reader who gets neither the glyph nor the slash
    mount();
    const toggle = await screen.findByRole('button', { name: 'Show 1 hidden account' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(toggle);

    const pressed = await screen.findByRole('button', { name: /^Hide 1 hidden account/ });
    expect(pressed).toHaveAttribute('aria-pressed', 'true');
  });

  it('draws no hidden switch for a workspace that has hidden nothing', async () => {
    mount({
      ...OVERVIEW_ROUTES,
      'GET /api/accounts': () => ok([account({ id: 'acc-1', name: 'Only one' })]),
    });
    await panel('Only one');

    expect(screen.queryByRole('button', { name: /hidden account/ })).not.toBeInTheDocument();
  });
});

describe('the balance card', () => {
  it('takes the balance from the account, and the account’s own name for a heading', async () => {
    mount();

    const card = await panel('Balance of Sparkasse Giro');
    expect(within(card).getByText('1,234.50', { exact: false })).toBeInTheDocument();
    expect(
      within(card).getByText('Sparkasse Giro'),
    ).toBeInTheDocument();
  });
});

describe('income against expenses', () => {
  it('reads the month off the account’s own figures', async () => {
    mount();

    // the flows region, not the account panel around it: the chart's accessible table
    // repeats these numbers, and it is inside that region too
    const flows = await panel('Income and expenses for Sparkasse Giro');
    // August: 900 in, 120 out, and the 300 moved to savings is neither
    expect(within(flows).getByText('+900 EUR')).toBeInTheDocument();
    expect(within(flows).getByText('−120 EUR')).toBeInTheDocument();
  });

  it('does not print two minus signs for a month the refunds outweighed', async () => {
    // a refund for a purchase made in an earlier month is honestly negative spending,
    // and "−" written in front of it read as "−−60 EUR"
    const refunded: AccountMonthTotals[] = [
      { month: '2026-08', income: 0, expense: -60, net: 60 },
    ];
    mount({
      ...OVERVIEW_ROUTES,
      'GET /api/transactions': () =>
        ok([txn('2026-08-04T00:00:00.000Z', 60, { refund: true, category: 'shopping' })]),
      'GET /api/summary/months': (_init, url) => ok(monthsBody(url, refunded)),
      'GET /api/summary': (_init, url) =>
        ok(
          summaryBody(url, {
            totals: { income: 0, expense: -60 },
            byCategory: [{ category: 'shopping', total: -60 }],
            incomeByCategory: [],
          }),
        ),
    });

    const flows = await panel('Income and expenses for Sparkasse Giro');
    expect(within(flows).getByText('+60 EUR')).toBeInTheDocument();
    expect(within(flows).queryByText(/−−/)).not.toBeInTheDocument();
    const spending = await panel('Spending by category, Aug 2026');
    expect(within(spending).getByText('Net refunds in Aug 2026 exceed spending.')).toBeInTheDocument();
    const total = within(spending).getByRole('rowheader', { name: 'Total' }).closest('tr');
    expect(total).toHaveTextContent('−60 EUR');
  });

  it('compares each figure with the month before it, and colours the two differently', async () => {
    mount();
    const flows = await panel('Income and expenses for Sparkasse Giro');

    // July: nothing in, 60 out. August: 900 in, 120 out.
    // Income has no base to compare against (July's income was 0), so it says nothing
    // rather than printing an infinity dressed up as a percentage.
    expect(within(flows).queryAllByText(/%/).length).toBeGreaterThan(0);
    // Spending doubled. The direction is asserted through the text of the whole line
    // rather than through the class that colours it: the text is what a screen reader
    // is given — the arrow beside it is `aria-hidden` and the figure is unsigned — and
    // a colour is not an assertion at all.
    const expense = within(flows).getByText('100.0%').closest('p');
    expect(expense).toHaveTextContent('up 100.0%');
    expect(expense).toHaveTextContent('vs Jul');
  });

  it('names the month on the figures, which is the only place it is named', async () => {
    // uploading July and reading the screen in September must not read as August: the
    // prose that used to say so is gone, so the label under each figure carries it
    mount();
    const flows = await panel('Income and expenses for Sparkasse Giro');
    expect(within(flows).getAllByText('Aug 2026').length).toBeGreaterThan(0);
    expect(within(flows).queryByText('Sep 2026')).not.toBeInTheDocument();
  });

  it('carries the same numbers beside the drawing, which jsdom cannot see', async () => {
    mount();
    await panel('Sparkasse Giro');

    const table = screen.getByRole('table', { name: /Income and expenses by month/ });
    expect(within(table).getByRole('rowheader', { name: 'Jul 2026' })).toBeInTheDocument();
    expect(within(table).getByRole('rowheader', { name: 'Aug 2026' })).toBeInTheDocument();
  });

  it('says which months these are rather than apologising for the rest', async () => {
    // a six-month view of two months is not explained in a sentence any more; the range
    // beside the heading is what says what is being looked at
    mount();
    await panel('Sparkasse Giro');

    expect(screen.getByText('Jul 2026 – Aug 2026')).toBeInTheDocument();
    expect(screen.queryByText(/everything this account has/)).not.toBeInTheDocument();
  });

  it('narrows the window without asking the server again', async () => {
    mount();
    await panel('Sparkasse Giro');
    const before = requests();

    fireEvent.click(screen.getByRole('button', { name: '3M' }));

    // the chips are the only thing that moved: the longest window is fetched once and
    // 3 and 6 are cuts of it, so narrowing is arithmetic rather than a request. The
    // whole list and not the transaction reads alone — the request this toggle would
    // tempt somebody into making is a summary one.
    expect(await screen.findByRole('button', { name: '3M', pressed: true })).toBeInTheDocument();
    expect(requests()).toEqual(before);
  });

  it('refuses on an account holding a second unit, in both the claims it can make', async () => {
    // the endpoint's list is all time and the figures beside it are one window, so this
    // sentence carries two claims of unequal strength and each is asserted: the balance
    // adds the foreign rows in and IS wrong, while a figure here is wrong only if one of
    // them falls in a month it covers — which the client was not told and says so. The
    // second half is the one a later edit flattens into the first, and the absence of
    // the paragraph is green against a card that never draws it, so this asserts text.
    // Its scope is asserted with it: the donut's total sums the same unconverted rows
    // and carries no sentence of its own, so narrowing this one to the card it sits on
    // takes the donut out of coverage without turning anything red.
    mount({
      ...OVERVIEW_ROUTES,
      'GET /api/summary/months': (_init, url) =>
        ok(monthsBody(url, MONTHS, { otherCurrencies: ['USD'] })),
    });

    const flows = await panel('Income and expenses for Sparkasse Giro');
    expect(flows).toHaveTextContent('This account holds transactions in USD, not EUR');
    expect(flows).toHaveTextContent(
      "The account's balance adds them in as though they were EUR, so it is wrong",
    );
    expect(flows).toHaveTextContent(
      'So is any other figure on this screen covering a month one of them falls in',
    );
    expect(flows).toHaveTextContent(/nothing here knows which months those are/);
  });
});

describe('spending by category', () => {
  /** The three rows the card names, as against the table under them, which has all. */
  const legend = (name = 'Biggest categories, Aug 2026') =>
    screen.findByRole('list', { name });

  it('breaks the month’s expenses down, and agrees with the card beside it', async () => {
    mount();

    const card = await panel('Spending by category, Aug 2026');
    // August spent 120 in Food and nothing else — the 300 to savings is a transfer and
    // is not spending, which is the same rule the Expenses figure above it follows
    const rows = within(await legend());
    expect(rows.getByText('Food')).toBeInTheDocument();
    expect(rows.getByText('120 EUR')).toBeInTheDocument();
    // the middle of the ring is `totals.expense` off the body this breakdown came
    // from, and the flows card's figure is the same month out of the months body: two
    // requests, one number, and the screen would be contradicting itself if not
    expect(within(card).getByText('120')).toBeInTheDocument();
    const flows = await panel('Income and expenses for Sparkasse Giro');
    expect(within(flows).getByText('−120 EUR')).toBeInTheDocument();
  });

  it('carries every category in a table, not only the three it names', async () => {
    const many: AccountSummary['byCategory'] = [
      { category: 'housing', total: 400 },
      { category: 'food', total: 300 },
      { category: 'transport', total: 200 },
      { category: 'health', total: 100 },
    ];
    mount({
      ...OVERVIEW_ROUTES,
      'GET /api/summary': (_init, url) =>
        ok(summaryBody(url, { totals: { income: 0, expense: 1000 }, byCategory: many })),
      'GET /api/summary/months': (_init, url) =>
        ok(monthsBody(url, [{ month: '2026-08', income: 0, expense: 1000, net: -1000 }])),
    });

    const card = await panel('Spending by category, Aug 2026');
    const rows = within(await legend());
    // the legend is the top three, and then the tail named as a tail — 100 of 1000
    expect(rows.getByText('Other · 1 category')).toBeInTheDocument();
    expect(rows.getByText('100 EUR')).toBeInTheDocument();
    expect(rows.queryByText('Health')).not.toBeInTheDocument();
    // the fourth one is not lost: the table beside the ring has all of them, which is
    // what a screen reader gets and what jsdom can see of a donut
    const table = within(card).getByRole('table', { name: /Spending by category/ });
    expect(within(table).getByRole('rowheader', { name: 'Health' })).toBeInTheDocument();
  });

  it('says so rather than drawing an empty ring when the month spent nothing', async () => {
    mount({
      ...OVERVIEW_ROUTES,
      'GET /api/summary': (_init, url) =>
        ok(summaryBody(url, { totals: { income: 900, expense: 0 }, byCategory: [] })),
      'GET /api/summary/months': (_init, url) =>
        ok(monthsBody(url, [{ month: '2026-08', income: 900, expense: 0, net: 900 }])),
    });

    const card = await panel('Spending by category, Aug 2026');
    expect(within(card).getByText(/Nothing was spent out of this account/)).toBeInTheDocument();
    // the way out of the card is not part of the breakdown, and a month that spent
    // nothing is exactly when somebody goes looking at a wider range
    const more = within(card).getByRole('button', { name: 'All analytics' });
    // the arrow is a picture of the verb and is read as a word — it stays on screen and
    // stays out of the name, which is what the name above being the bare phrase asserts
    expect(more).toHaveTextContent('↗');
  });

  it('keeps the net figures in the legend and says so when a refund is inside them', async () => {
    // two in the tail, one of them a refund that exactly offsets the other: the tail's
    // legend row is the server's net remainder, and the ring — which jsdom cannot see —
    // draws the cash that was spent; `categories.test.ts` pins that half on the same fixture
    const refunds: AccountSummary['byCategory'] = [
      { category: 'food', total: 100 },
      { category: 'health', total: 50 },
      { category: 'shopping', total: 30 },
      { category: 'cash', total: 20 },
      { category: 'travel', total: -20 },
    ];
    mount({
      ...OVERVIEW_ROUTES,
      'GET /api/summary': (_init, url) =>
        ok(summaryBody(url, { totals: { income: 0, expense: 180 }, byCategory: refunds })),
      'GET /api/summary/months': (_init, url) =>
        ok(monthsBody(url, [{ month: '2026-08', income: 0, expense: 180, net: -180 }])),
    });

    const card = await panel('Spending by category, Aug 2026');
    expect(
      within(card).getByText('Total includes net refunds; the ring shows positive spending.'),
    ).toBeInTheDocument();
    const tail = within(await legend()).getByText('Other · 2 categories').closest('li');
    expect(tail).toHaveTextContent('0 EUR');
    expect(within(card).getByText('180')).toBeInTheDocument();
  });

  it('gives the figure in the middle of the ring to the table beside it', async () => {
    // `.donut-center` is inside the container the donut is hidden by — it is painted over
    // a drawing that has to be hidden as one piece — so the biggest number on the card
    // was the one thing on it a screen reader was never given. The table that stands in
    // for the ring had all twelve categories and no total.
    mount();

    const card = await panel('Spending by category, Aug 2026');
    const table = within(card).getByRole('table', { name: /Spending by category/ });
    const total = within(table).getByRole('rowheader', { name: 'Total' }).closest('tr');
    expect(total).toHaveTextContent('120 EUR');
    // and it is the same figure the ring prints, which is the Expenses figure off the
    // card beside it rather than the sum of the sectors — see the header of the component
    expect(within(card).getByText('120')).toBeInTheDocument();
  });

  it('opens the Analytics screen from the foot of the card', async () => {
    mount();
    const card = await panel('Spending by category, Aug 2026');

    fireEvent.click(within(card).getByRole('button', { name: 'All analytics' }));

    expect(onOpenAnalytics).toHaveBeenCalled();
  });
});

describe('switching tabs while a read is in flight', () => {
  it('announces loading without painting a zero balance', async () => {
    let release: (r: Response) => void = () => {};
    mount({
      ...OVERVIEW_ROUTES,
      'GET /api/transactions': () => new Promise<Response>((resolve) => (release = resolve)),
    });
    await tab('Sparkasse Giro');
    expect(screen.getByRole('status')).toHaveTextContent('Loading your account');
    expect(screen.queryByRole('region', { name: 'Balance of Sparkasse Giro' })).toBeNull();
    release(ok(TXS));
    await panel('Balance of Sparkasse Giro');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('drops a pre-revision answer after reclassification starts a newer read', async () => {
    let releaseOld: (response: Response) => void = () => {};
    let reads = 0;
    window.history.replaceState(null, '', '/');
    mockFetch({
      ...OVERVIEW_ROUTES,
      'GET /api/transactions': () => {
        reads += 1;
        if (reads === 1) {
          return new Promise<Response>((resolve) => {
            releaseOld = resolve;
          });
        }
        return ok(TXS);
      },
    });
    const Host = () => {
      const [revision, setRevision] = useState(0);
      return (
        <>
          <button onClick={() => setRevision((value) => value + 1)}>Reclassify</button>
          <OverviewScreen
            onOpenTransactions={onOpenTransactions}
            onOpenAnalytics={onOpenAnalytics}
            dataRevision={revision}
          />
        </>
      );
    };
    renderThemed(<Host />);

    await waitFor(() => expect(reads).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: 'Reclassify' }));
    await panel('Balance of Sparkasse Giro');

    releaseOld(ok([txn('2026-09-01T00:00:00.000Z', 50)]));
    await settle();

    expect(requests().filter((request) => request === 'GET /api/transactions')).toHaveLength(2);
    expect(requests().filter((request) => request === 'GET /api/summary')).toHaveLength(1);
    expect(screen.getByRole('region', { name: 'Balance of Sparkasse Giro' })).toBeVisible();
  });

  it('drops the answer for the tab the reader left', async () => {
    const two = [account({ id: 'acc-1', name: 'Slow' }), account({ id: 'acc-2', name: 'Quick' })];
    let release: (r: Response) => void = () => {};
    let calls = 0;
    mount({
      ...OVERVIEW_ROUTES,
      'GET /api/accounts': () => ok(two),
      // the route table keys on the path and discards the query, so which account a
      // read is for is its ordinal. The first is Slow's, and it does not come back
      // until this test lets it.
      'GET /api/transactions': () => {
        calls += 1;
        if (calls === 1) return new Promise<Response>((resolve) => (release = resolve));
        return ok(TXS);
      },
    });

    fireEvent.click(await tab('Quick'));
    await panel('Balance of Quick');

    release(ok(TXS));
    await settle();

    // Slow's answer must not start Slow's summaries, and must not reach `data`: an
    // id the render then rejects is no dashboard, no error and no reason to fetch
    // again — the effect's deps did not move, so the screen stays empty until the
    // reader clicks a third tab. Two recent reads, one for each tab, and one pair of
    // summaries — Quick's.
    expect(requests().filter((r) => r === 'GET /api/transactions')).toHaveLength(2);
    expect(requests().filter((r) => r === 'GET /api/summary')).toHaveLength(1);
    expect(requests().filter((r) => r === 'GET /api/summary/months')).toHaveLength(1);
    expect(screen.getByRole('region', { name: 'Balance of Quick' })).toBeInTheDocument();
    expect(screen.queryByText(/^Error:/)).not.toBeInTheDocument();
  });

  it('drops the figures for the tab the reader left, even once its recent list had landed', async () => {
    const two = [account({ id: 'acc-1', name: 'Slow' }), account({ id: 'acc-2', name: 'Quick' })];
    let release: (r: Response) => void = () => {};
    let slowAsked = '';
    let calls = 0;
    mount({
      ...OVERVIEW_ROUTES,
      'GET /api/accounts': () => ok(two),
      // both recent lists come back at once; the summary that does not is the first
      // one asked for, which is Slow's, and its window is kept for the answer below
      'GET /api/summary': (_init, url) => {
        calls += 1;
        if (calls === 1) {
          slowAsked = url ?? '';
          return new Promise<Response>((resolve) => (release = resolve));
        }
        return ok(summaryBody(url));
      },
    });

    // the switch happens after Slow's recent list landed and its summaries were asked
    // for — the case above holds the other window, before the recent list comes back
    await waitFor(() => expect(requests().filter((r) => r === 'GET /api/summary')).toHaveLength(1));
    fireEvent.click(await tab('Quick'));
    await panel('Balance of Quick');

    release(ok(summaryBody(slowAsked)));
    await settle();

    // both summaries were answered; only Quick's is on screen
    expect(requests().filter((r) => r === 'GET /api/summary')).toHaveLength(2);
    expect(screen.getByRole('region', { name: 'Balance of Quick' })).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText(/^Error:/)).not.toBeInTheDocument();
  });

  it('does not paint the abandoned tab’s refusal over the account that loaded', async () => {
    const two = [account({ id: 'acc-1', name: 'Slow' }), account({ id: 'acc-2', name: 'Quick' })];
    let release: (r: Response) => void = () => {};
    let calls = 0;
    mount({
      ...OVERVIEW_ROUTES,
      'GET /api/accounts': () => ok(two),
      'GET /api/transactions': () => {
        calls += 1;
        if (calls === 1) return new Promise<Response>((resolve) => (release = resolve));
        return ok(TXS);
      },
    });

    fireEvent.click(await tab('Quick'));
    await panel('Balance of Quick');

    release(fail(500));
    await settle();

    expect(screen.queryByText(/^Error:/)).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Balance of Quick' })).toBeInTheDocument();
  });
});

describe('what the dashboard asks the server for', () => {
  it('reads the recent list and the two summaries of this account, and nothing else', async () => {
    mount();
    await panel('Sparkasse Giro');

    // the whole list and in order, so the window fetch this row deleted comes back as
    // a fourth entry rather than as a screen that is merely slower than it was
    expect(requests()).toEqual([
      'GET /api/accounts',
      'GET /api/app-settings',
      'GET /api/transactions',
      'GET /api/summary',
      'GET /api/summary/months',
    ]);
    // and the transaction read is still the seven for the list under the cards
    expect(requestUrls()).toContain(
      `GET /api/transactions?accountId=acc-1&limit=${RECENT_LIMIT}`,
    );
  });

  it('names the account on both summary requests', async () => {
    mount(OVERVIEW_ROUTES, '/?account=acc-1');
    await panel('Sparkasse Giro');

    // requests() cannot see this — keyOf drops the query — and the failure it guards
    // against is silent: an id that never reaches the wire is answered with the whole
    // workspace's money, printed under this account's name and currency code
    const summaries = requestUrls().filter((u) => u.includes('/api/summary'));
    expect(summaries).toHaveLength(2);
    for (const url of summaries) expect(url).toContain('accountId=acc-1');
  });

  it('asks for the whole of the newest month, its last day included', async () => {
    mount();
    await panel('Sparkasse Giro');

    // `to` is inclusive of the day it names, and August has 31 of them: one day short
    // drops the 31st out of the donut, out of both figures and off the end of the
    // chart at once, and every one of them still looks like a month
    expect(requestUrls()).toContain(
      'GET /api/summary?accountId=acc-1&from=2026-08-01&to=2026-08-31',
    );
    expect(requestUrls()).toContain(
      'GET /api/summary/months?accountId=acc-1&from=2025-09-01&to=2026-08-31',
    );
  });

  it('refuses rather than printing every account’s money under one account’s name', async () => {
    mount({
      // what a query-builder edit that drops the accountId produces: 200, a body of
      // the right shape for the OTHER arm, and every figure in the base currency
      ...OVERVIEW_ROUTES,
      'GET /api/summary': () => ok(SUMMARY),
    });
    await tab('Sparkasse Giro');

    const error = await screen.findByText(/^Error:/);
    expect(error).toHaveTextContent(/over every account/);
    // the dashboard's own refusal, under a rail that loaded — not a blank screen
    expect(
      screen.queryByRole('region', { name: 'Income and expenses for Sparkasse Giro' }),
    ).not.toBeInTheDocument();
    expect(await tab('Sparkasse Giro')).toBeInTheDocument();
  });
});

describe('a month the account has nothing in', () => {
  /** The server answers only the months that HAVE rows, so June is simply absent. */
  const GAP: AccountMonthTotals[] = [
    { month: '2026-05', income: 0, expense: 60, net: -60 },
    { month: '2026-07', income: 0, expense: 120, net: -120 },
  ];

  const mountGap = () =>
    mount({
      ...OVERVIEW_ROUTES,
      'GET /api/transactions': () =>
        ok([txn('2026-07-20T00:00:00.000Z', -120, { category: 'food' })]),
      'GET /api/summary/months': (_init, url) => ok(monthsBody(url, GAP)),
      'GET /api/summary': (_init, url) =>
        ok(
          summaryBody(url, {
            totals: { income: 0, expense: 120 },
            byCategory: [{ category: 'food', total: 120 }],
            incomeByCategory: [],
          }),
        ),
    });

  it('draws the empty month and compares the newest against it, not against May', async () => {
    mountGap();
    const flows = await panel('Income and expenses for Sparkasse Giro');

    // three points and not two
    const table = within(flows).getByRole('table', { name: /Income and expenses by month/ });
    expect(within(table).getAllByRole('rowheader').map((r) => r.textContent)).toEqual([
      'May 2026',
      'Jun 2026',
      'Jul 2026',
    ]);
    // June spent nothing, so there is no base and no percentage at all. An
    // implementation reading the server's array straight through compares July with
    // May instead and prints "up 100.0% vs May" — right-looking, two calendar months
    // out, and with nothing on screen saying so.
    expect(within(flows).queryByText(/\d\.\d%/)).not.toBeInTheDocument();
    expect(within(flows).queryByText(/vs May/)).not.toBeInTheDocument();
  });
});

describe('the recent transactions', () => {
  it('lists them without an account column and without a status it does not have', async () => {
    mount();

    const list = await panel('Recent transactions in Sparkasse Giro');
    expect(within(list).getByText('ACME payroll')).toBeInTheDocument();
    // the category, which is a column of its own and not part of the description
    expect(within(list).getByText('Salary')).toBeInTheDocument();
    expect(within(list).getByText('+900 EUR')).toBeInTheDocument();
    // the transfer is on the list and marked, because it is what the figures above left out
    expect(within(list).getByText('To savings')).toBeInTheDocument();
    expect(within(list).getByText('Transfer')).toBeInTheDocument();
    // a status column would have to invent one: a statement records what already happened
    expect(within(list).queryByText('Completed')).not.toBeInTheDocument();
    expect(within(list).queryByRole('columnheader', { name: 'Account' })).not.toBeInTheDocument();
    expect(within(list).queryByRole('columnheader', { name: 'Status' })).not.toBeInTheDocument();
  });

  it('keeps the category alongside every transaction flag', async () => {
    mount({
      ...OVERVIEW_ROUTES,
      'GET /api/transactions': () => ok([
        txn('2026-08-04T00:00:00.000Z', 60, {
          description: 'Returned purchase', category: 'shopping',
          transfer: true, refund: true, oneOff: true,
        }),
      ]),
    });
    const list = await panel('Recent transactions in Sparkasse Giro');
    const row = within(list).getByText('Returned purchase').closest('tr')!;
    for (const text of ['Shopping', 'Transfer', 'Refund', 'One-off']) {
      expect(within(row).getByText(text)).toBeInTheDocument();
    }
  });

  it('keeps every cell in its own column', async () => {
    // `display: flex` on a <td> takes it out of the table, and CSS fixup then wraps it
    // together with its adjacent non-cell siblings into ONE anonymous cell — which put
    // the category underneath the description while the headers stayed put. The layout
    // lives on a span inside each cell now, and the row has four of them.
    mount();
    const list = await panel('Recent transactions in Sparkasse Giro');

    const row = within(list).getByText('ACME payroll').closest('tr');
    expect(row).not.toBeNull();
    expect(row!.querySelectorAll('td')).toHaveLength(4);
    expect(row!.querySelector('.tx-cat')).toHaveTextContent('Salary');
    expect(row!.querySelector('.tx-desc')).not.toHaveTextContent('Salary');
  });

  it('hands the account to the Transactions screen rather than navigating blind', async () => {
    mount();
    await panel('Recent transactions in Sparkasse Giro');

    const all = screen.getByRole('button', { name: 'See all' });
    // the name is the bare phrase; the arrow is still painted on it
    expect(all).toHaveTextContent('↗');

    fireEvent.click(all);

    expect(onOpenTransactions).toHaveBeenCalledWith('acc-1');
  });

  it('keeps the disc out of what is read aloud', async () => {
    // the disc carries the first letter of the description that is printed immediately
    // to its right: it identifies a row at a glance and says nothing a reader of the
    // cell is not already told
    mount();
    const list = await panel('Recent transactions in Sparkasse Giro');

    const row = within(list).getByText('ACME payroll').closest('tr');
    expect(row).not.toBeNull();
    expect(row!.querySelector('.tx-mark')).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('the empty states', () => {
  it('makes the upload the point of the screen when there is no account at all', async () => {
    mount({
      ...OVERVIEW_ROUTES,
      'GET /api/accounts': () => ok([]),
      'GET /api/imports/presets': () => ok(PRESETS),
    });

    // the tail as well as the opening: this is the first sentence a new user reads
    // about what to upload
    expect(await screen.findByText(/Export a statement from your bank/)).toHaveTextContent(/\.pdf/);
    expect(screen.queryByText(/^Error:/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Import a statement/ }));
    expect(await screen.findByRole('heading', { name: 'Import a statement' })).toBeInTheDocument();
    // the list is empty, so the import panel opens straight onto its create arm — and
    // this sentence is the only thing that fails if baseCurrency stops crossing the
    // mount, which it has to because that screen creates the account itself now
    expect(
      screen.getByText(new RegExp(`It will hold amounts in ${APP_SETTINGS.baseCurrency}`)),
    ).toBeInTheDocument();
  });

  it('reloads the accounts when the import screen creates one', async () => {
    const { container } = mount({
      ...OVERVIEW_ROUTES,
      'GET /api/accounts': () => ok([]),
      'GET /api/imports/presets': () => ok(PRESETS),
      'POST /api/accounts': () => ok(account({ id: 'acc-9', name: 'Girokonto' }), 201),
      'POST /api/imports': () => ok(summaryResult()),
    });

    fireEvent.click(await screen.findByRole('button', { name: /Import a statement/ }));
    // the list is empty, so the panel opens straight onto its create arm
    fireEvent.change(await screen.findByPlaceholderText('Sparkasse Giro'), {
      target: { value: 'Girokonto' },
    });
    // hidden and unlabelled, so no RTL query reaches it
    fireEvent.change(container.querySelector('input[type=file]') as HTMLInputElement, {
      target: {
        files: [new File(['date;amount\n2026-06-01;-10'], 'statement.csv', { type: 'text/csv' })],
      },
    });
    await screen.findByRole('button', { name: 'Choose another CSV, Excel or PDF statement file' });

    // the reload is the observable, and the request count is how it is read: the panel
    // replaces this screen while it is open, so the rail the created account has to
    // reach is not mounted here to be asserted about. Nothing else on this path asks
    // for the list again — the create arm appends its account to its own copy — so the
    // second GET is onAccountCreated and nothing else.
    const accountLoads = () => requests().filter((r) => r === 'GET /api/accounts').length;
    const before = accountLoads();

    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() => expect(accountLoads()).toBe(before + 1));
  });

  it('does not claim the accounts are empty when the request for them failed', async () => {
    mount({ ...OVERVIEW_ROUTES, 'GET /api/accounts': () => fail(500) });

    expect(await screen.findByText(/^Error:/)).toBeInTheDocument();
    // `accounts` was never loaded, so there is nothing to be empty
    expect(screen.queryByText(/Nothing here yet/)).not.toBeInTheDocument();
  });

  /**
   * Both refusals appear only once a request has come back — which is a moment nothing
   * about the page moving marks, and on this screen there is nothing else on the page to
   * be found by looking. `closest` and not a document query: AccountTabs renders a polite
   * region on this same screen, so a document query would pass with the sentence sitting
   * outside every one of them.
   */
  it('puts the rail’s refusal in a live region', async () => {
    mount({ ...OVERVIEW_ROUTES, 'GET /api/accounts': () => fail(500) });

    const error = await screen.findByText(/^Error:/);
    expect(error.closest('[aria-live="polite"]')).not.toBeNull();
  });

  it('puts the dashboard’s own refusal in one too, under the rail that loaded', async () => {
    mount({ ...OVERVIEW_ROUTES, 'GET /api/transactions': () => fail(500) });
    await tab('Sparkasse Giro');

    const error = await screen.findByText(/^Error:/);
    expect(error.closest('[aria-live="polite"]')).not.toBeNull();
  });

  it('says the account is empty rather than that the app is, when it is', async () => {
    mount({
      ...OVERVIEW_ROUTES,
      'GET /api/accounts': () => ok([account({ id: 'acc-1', name: 'Cash' })]),
      'GET /api/transactions': () => ok([]),
      'GET /api/imports/presets': () => ok(PRESETS),
    });
    await panel('Cash');

    expect(screen.getByText(/Nothing has been loaded into Cash/)).toBeInTheDocument();
    // and the tab is still there: the account exists, it is the data that does not
    expect(await tab('Cash')).toBeInTheDocument();
    expect(screen.queryByText(/Nothing here yet/)).not.toBeInTheDocument();
  });

  it('keeps the way out of Hidden on the panel, which is the only one there is', async () => {
    mount();
    await panel('Sparkasse Giro');

    fireEvent.click(screen.getByRole('button', { name: /Show 1 hidden account/ }));
    fireEvent.click(await tab('Old DKB (hidden)'));

    // the ⋮ is on the balance card, and a hidden account draws no balance card — so
    // this panel carries the same control under the same name. Without it the panel's
    // own instruction pointed at a menu that was nowhere on the page, and the account
    // could not be brought back from anywhere in the app
    expect(
      await screen.findByRole('button', { name: 'Account menu: Old DKB' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unhide this account' })).toBeInTheDocument();
  });

  it('closes the unhide step instead of opening a menu nobody came through', async () => {
    mount();
    await panel('Sparkasse Giro');

    fireEvent.click(screen.getByRole('button', { name: /Show 1 hidden account/ }));
    fireEvent.click(await tab('Old DKB (hidden)'));
    fireEvent.click(await screen.findByRole('button', { name: 'Unhide this account' }));

    // the step was opened AT, not stepped into, so there is nothing behind it — and the
    // button says Cancel rather than Back to mean it
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unhide this account' })).toBeInTheDocument();
  });

  it('brings a hidden account back, and its dashboard follows', async () => {
    mount({
      ...OVERVIEW_ROUTES,
      'PATCH /api/accounts/acc-2': () => ok({ ...ACCOUNTS[1], hidden: false }),
    });
    await panel('Sparkasse Giro');

    fireEvent.click(screen.getByRole('button', { name: /Show 1 hidden account/ }));
    fireEvent.click(await tab('Old DKB (hidden)'));
    fireEvent.click(await screen.findByRole('button', { name: 'Unhide this account' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Unhide' }));

    expect(await panel('Balance of Old DKB')).toBeInTheDocument();
  });

  it('offers a way back when every account is hidden', async () => {
    mount({
      ...OVERVIEW_ROUTES,
      'GET /api/accounts': () => ok(ACCOUNTS.map((a) => ({ ...a, hidden: true }))),
    });

    expect(await screen.findByText(/Every account you have is hidden/)).toBeInTheDocument();
    // "no accounts yet" over accounts the user hid is the same untruth as over accounts
    // that never loaded
    expect(screen.queryByText(/Nothing here yet/)).not.toBeInTheDocument();
  });
});

describe('the account menu', () => {
  const openMenu = async () => {
    await panel('Sparkasse Giro');
    // it is on the balance card, not on the tab: a tab is a name, so that three of
    // them fit a line without the row becoming a control panel
    fireEvent.click(screen.getByRole('button', { name: 'Account menu: Sparkasse Giro' }));
    return screen.findByRole('dialog');
  };

  it('offers the four items and shows the whole name', async () => {
    mount();
    const menu = await openMenu();

    expect(within(menu).getByText('Rename')).toBeInTheDocument();
    expect(within(menu).getByText('Import history')).toBeInTheDocument();
    expect(within(menu).getByText('Hide')).toBeInTheDocument();
    expect(within(menu).getByText('Delete')).toBeInTheDocument();
  });

  it('renames the account and the tab follows', async () => {
    mount({
      ...OVERVIEW_ROUTES,
      'PATCH /api/accounts/acc-1': () => ok({ ...ACCOUNTS[0], name: 'Sparkasse' }),
    });
    const menu = await openMenu();

    fireEvent.click(within(menu).getByText('Rename'));
    const field = await screen.findByLabelText('Name');
    // prefilled with the whole name, which is the point: this is where a name that came
    // out of a filename gets shortened
    expect((field as HTMLInputElement).value).toBe('Sparkasse Giro');

    fireEvent.change(field, { target: { value: 'Sparkasse' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }));

    expect(await tab('Sparkasse')).toBeInTheDocument();
  });

  it('shows the server refusal instead of pretending the rename landed', async () => {
    mount({
      ...OVERVIEW_ROUTES,
      'PATCH /api/accounts/acc-1': () =>
        fail(409, { error: 'an account called "Old DKB" already has that name' }),
    });
    const menu = await openMenu();

    fireEvent.click(within(menu).getByText('Rename'));
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Old DKB' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/already has that name/)).toBeInTheDocument();
    expect(await tab('Sparkasse Giro')).toBeInTheDocument();
  });

  it('steps back to the menu from a step that was opened out of it', async () => {
    mount();
    const menu = await openMenu();

    fireEvent.click(within(menu).getByText('Hide'));
    fireEvent.click(await screen.findByRole('button', { name: 'Back' }));

    // the four items again: this one really does have something behind it
    expect(await screen.findByText('Import history')).toBeInTheDocument();
  });

  it('tells hiding and deleting apart in what each one says', async () => {
    mount();
    const menu = await openMenu();

    fireEvent.click(within(menu).getByText('Hide'));
    // the whole difference: hiding takes it off the screen and destroys nothing
    expect(await screen.findByText(/nothing is deleted/)).toBeInTheDocument();
  });

  it('hides the account, and the rail drops it', async () => {
    mount({
      ...OVERVIEW_ROUTES,
      'PATCH /api/accounts/acc-1': () => ok({ ...ACCOUNTS[0], hidden: true }),
    });
    const menu = await openMenu();

    fireEvent.click(within(menu).getByText('Hide'));
    fireEvent.click(await screen.findByRole('button', { name: 'Hide' }));

    expect(await screen.findByText(/Every account you have is hidden/)).toBeInTheDocument();
  });

  it('names what deleting would destroy before offering anything', async () => {
    mount({
      ...OVERVIEW_ROUTES,
      'GET /api/imports': () =>
        ok(
          importsResponse([
            importRecord(),
            importRecord({ id: 'imp-2', documentAvailable: false }),
          ]),
        ),
    });
    const menu = await openMenu();

    fireEvent.click(within(menu).getByText('Delete'));

    // the counts, and each one is read from somewhere rather than guessed
    expect(await screen.findByText('4 transactions')).toBeInTheDocument();
    expect(screen.getByText('2 imports')).toBeInTheDocument();
    expect(screen.getByText('1 uploaded file')).toBeInTheDocument();
    // the wall this replaced said the server had no endpoint for it. It has one now,
    // and the control is here — behind the account's name rather than behind nothing
    expect(screen.queryByText(/no endpoint that deletes an account/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete permanently' })).toBeDisabled();
    // the one consequence to another account, said where it is still actionable
    expect(screen.getByText(/stops counting as a transfer/)).toBeInTheDocument();
  });

  it('will not print a count that is really the limit', async () => {
    mount({
      ...OVERVIEW_ROUTES,
      'GET /api/imports': () => ok(importsResponse()),
      // the dashboard's recent seven against the dialog's count, told apart by the
      // limit each asks for rather than by their ordinal — the ordinal was one number
      // that moved when the dashboard stopped making a second read. The counted rows
      // are never looked at, only measured, so they are not built.
      'GET /api/transactions': (_init, url) =>
        ok(
          url?.includes(`limit=${COUNT_LIMIT}`) ? new Array(COUNT_LIMIT).fill(null) : TXS,
        ),
    });
    const menu = await openMenu();

    fireEvent.click(within(menu).getByText('Delete'));

    // a number that is silently the limit is the one number this dialog must not print
    expect(await screen.findByText(`at least ${COUNT_LIMIT} transactions`)).toBeInTheDocument();
    expect(screen.getByText(/it is the limit and not the answer/)).toBeInTheDocument();
  });

  /**
   * The per-account view is per-account, and that is the server's job:
   * the assertion is what the screen ASKED for, not what it kept. Asserting the
   * render instead would be a tautology — a mock answering one row proving that one
   * row appears — and the client re-filtering is what ImportHistory's own suite
   * refuses.
   */
  it('opens the imports of this account and not of the workspace', async () => {
    mount({ ...OVERVIEW_ROUTES, 'GET /api/imports': () => ok(importsResponse()) });
    const menu = await openMenu();

    fireEvent.click(within(menu).getByText('Import history'));

    expect(await screen.findByRole('heading', { name: 'Import history' })).toBeInTheDocument();
    expect(requestUrls()).toContain('GET /api/imports?accountId=acc-1');
    expect(requestUrls()).not.toContain('GET /api/imports');
  });
});

describe('deleting an account', () => {
  /** The route's own answer, declared with the client's type so a fourth key is a tsc error. */
  const DESTROYED: AccountDeleted = { deleted: true, transactions: 12, imports: 3, documents: 2 };

  /**
   * A preview that could not have produced any of the numbers above, and vice versa.
   * Every figure in the sentence is therefore evidence about where it was read.
   */
  const PREVIEW = importsResponse([importRecord()], {
    imports: 137,
    documents: 90,
    transactions: 4021,
  });

  const openDelete = async (name: string) => {
    fireEvent.click(await screen.findByRole('button', { name: `Account menu: ${name}` }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByText('Delete'));
  };

  const confirmDelete = async (name: string) => {
    fireEvent.change(await screen.findByLabelText(/to confirm/), { target: { value: name } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
  };

  it('drops the account from the rail and names what the server destroyed', async () => {
    const other = account({ id: 'acc-3', name: 'Cash' });
    let list: Account[] = [ACCOUNTS[0], other];
    mount({
      ...OVERVIEW_ROUTES,
      'GET /api/accounts': () => ok(list),
      'GET /api/imports': () => ok(PREVIEW),
      'DELETE /api/accounts/acc-1': () => {
        list = [other];
        return ok(DESTROYED);
      },
    });
    await panel('Sparkasse Giro');

    await openDelete('Sparkasse Giro');
    await confirmDelete('Sparkasse Giro');

    const notice = await screen.findByText(/Sparkasse Giro was deleted/);
    // the response's three numbers and none of the preview's: the panel hands over the
    // parsed body, and the preview it counted from never crosses that callback
    expect(notice).toHaveTextContent('12 transactions, 3 imports and 2 uploaded files');
    expect(notice).not.toHaveTextContent('137');
    expect(notice).not.toHaveTextContent('90');
    expect(notice).not.toHaveTextContent('4021');
    // Sheet restores focus to nothing when it closes, so the sentence is the only thing
    // that reports the most destructive action in the app. `closest` and not a document
    // query: AccountTabs renders a polite region on this same screen, and a document
    // query would pass with the notice sitting outside every one of them.
    expect(notice.closest('[aria-live="polite"]')).not.toBeNull();
    expect(await tab('Cash')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sparkasse Giro' })).toBeNull();
  });

  /**
   * The money-shaped one. Deleting a whole account breaks every transfer pair one of
   * whose legs was in it, so the SURVIVING account's figures move — and nothing on the
   * screen would say so.
   */
  it('re-reads the surviving account, whose transfers the delete un-paired', async () => {
    const A = account({ id: 'acc-1', name: 'Sparkasse Giro' });
    const B = account({ id: 'acc-2', name: 'Savings' });
    const PAIRED = [
      txn('2026-08-03T00:00:00.000Z', -120, { description: 'Rewe', category: 'food' }),
      txn('2026-08-02T00:00:00.000Z', -300, { description: 'To savings', transfer: true }),
    ];
    // the same month after the server re-classified those rows: the surviving leg has
    // no partner left, so it stops being a transfer and starts counting as spending.
    // `net` does not move — a transfer was always inside it.
    const augustSpent = (spent: number): AccountMonthTotals[] => [
      { month: '2026-08', income: 0, expense: spent, net: -420 },
    ];
    let gone = false;
    mount({
      ...OVERVIEW_ROUTES,
      'GET /api/accounts': () => ok(gone ? [A] : [A, B]),
      'GET /api/transactions': () => ok(PAIRED),
      'GET /api/summary/months': (_init, url) =>
        ok(monthsBody(url, augustSpent(gone ? 420 : 120))),
      'GET /api/summary': (_init, url) =>
        ok(
          summaryBody(url, {
            totals: { income: 0, expense: gone ? 420 : 120 },
            byCategory: [{ category: 'food', total: gone ? 420 : 120 }],
            incomeByCategory: [],
          }),
        ),
      'GET /api/imports': () => ok(importsResponse([])),
      'DELETE /api/accounts/acc-2': () => {
        gone = true;
        return ok(DESTROYED);
      },
    });
    const august = () => within(screen.getByRole('row', { name: /Aug 2026/ }));

    await panel('Sparkasse Giro');
    // 120 and not 420: the 300 is a transfer while the account it went to exists
    expect(august().getByText('120 EUR')).toBeInTheDocument();

    fireEvent.click(await tab('Savings'));
    await openDelete('Savings');
    await confirmDelete('Savings');
    await screen.findByText(/Savings was deleted/);

    await waitFor(() => expect(august().getByText('420 EUR')).toBeInTheDocument());
    // and the list is the server's, not the old one with a row filtered out of it
    expect(requests().filter((r) => r === 'GET /api/accounts')).toHaveLength(2);
  });

  it('leaves the empty state behind when the last account goes', async () => {
    let list: Account[] = [ACCOUNTS[0]];
    mount({
      ...OVERVIEW_ROUTES,
      'GET /api/accounts': () => ok(list),
      'GET /api/imports': () => ok(importsResponse()),
      'DELETE /api/accounts/acc-1': () => {
        list = [];
        return ok(DESTROYED);
      },
    });
    await panel('Sparkasse Giro');

    await openDelete('Sparkasse Giro');
    await confirmDelete('Sparkasse Giro');

    // the screen a new user gets, rather than a rail with nothing under it
    expect(await screen.findByText(/Nothing here yet/)).toBeInTheDocument();
    expect(screen.getByText(/Sparkasse Giro was deleted/)).toBeInTheDocument();
  });

  /** The other arm of the sentence, and the only one whose numbers are not printed. */
  it('says an empty account held nothing rather than counting three zeros', async () => {
    let list: Account[] = [ACCOUNTS[0]];
    mount({
      ...OVERVIEW_ROUTES,
      'GET /api/accounts': () => ok(list),
      'GET /api/imports': () => ok(importsResponse()),
      'DELETE /api/accounts/acc-1': () => {
        list = [];
        return ok({
          deleted: true,
          transactions: 0,
          imports: 0,
          documents: 0,
        } satisfies AccountDeleted);
      },
    });
    await panel('Sparkasse Giro');

    await openDelete('Sparkasse Giro');
    await confirmDelete('Sparkasse Giro');

    expect(
      await screen.findByText(
        /Sparkasse Giro was deleted\. It held no transactions, no imports and no uploaded files\./,
      ),
    ).toBeInTheDocument();
  });

  it('deletes a hidden account through the panel that is its only menu', async () => {
    let list: Account[] = ACCOUNTS;
    mount({
      ...OVERVIEW_ROUTES,
      'GET /api/accounts': () => ok(list),
      // no GET /api/transactions for the preview: a hidden account's rows are filtered
      // out of that endpoint, so the panel counts from the import totals instead
      'GET /api/imports': () => ok(PREVIEW),
      'DELETE /api/accounts/acc-2': () => {
        list = [ACCOUNTS[0]];
        return ok({
          deleted: true,
          transactions: 1,
          imports: 1,
          documents: 1,
        } satisfies AccountDeleted);
      },
    });
    await panel('Sparkasse Giro');

    fireEvent.click(screen.getByRole('button', { name: /Show 1 hidden account/ }));
    fireEvent.click(await tab('Old DKB (hidden)'));
    await openDelete('Old DKB');
    await confirmDelete('Old DKB');

    // each count singular on its own, so a mixed sentence still reads
    expect(
      await screen.findByText(/Old DKB was deleted — 1 transaction, 1 import and 1 uploaded file/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /hidden account/ })).toBeNull();
  });

  it('clears the sentence when the next account’s panel opens', async () => {
    const other = account({ id: 'acc-3', name: 'Cash' });
    let list: Account[] = [ACCOUNTS[0], other];
    mount({
      ...OVERVIEW_ROUTES,
      'GET /api/accounts': () => ok(list),
      'GET /api/imports': () => ok(PREVIEW),
      'DELETE /api/accounts/acc-1': () => {
        list = [other];
        return ok(DESTROYED);
      },
    });
    await panel('Sparkasse Giro');

    await openDelete('Sparkasse Giro');
    await confirmDelete('Sparkasse Giro');
    await screen.findByText(/Sparkasse Giro was deleted/);

    fireEvent.click(await screen.findByRole('button', { name: 'Account menu: Cash' }));

    // a sentence about the account that is gone, standing over the panel of one that
    // is not, is a sentence about the wrong account
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByText(/Sparkasse Giro was deleted/)).toBeNull();
  });
});

describe('adding an account', () => {
  it('asks for a name and nothing else, then selects what came back', async () => {
    const created = account({ id: 'acc-3', name: 'Cash' });
    let list: Account[] = [ACCOUNTS[0]];
    let sent: unknown = null;
    mount({
      ...OVERVIEW_ROUTES,
      'GET /api/accounts': () => ok(list),
      'POST /api/accounts': (init) => {
        sent = init?.body ? JSON.parse(String(init.body)) : null;
        list = [...list, created];
        return ok(created, 201);
      },
      'GET /api/transactions': () => ok([]),
    });
    await panel('Sparkasse Giro');

    fireEvent.click(screen.getByRole('button', { name: 'Add account' }));
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Cash' } });
    // the currency is not asked for: it is the workspace's base currency
    expect(screen.getByText(/your base currency/)).toHaveTextContent('EUR');
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await panel('Cash');
    // an equality, so what is asserted is the ABSENCE of a currency key: the client
    // no longer guesses one, and the server defaults it
    expect(sent).toEqual({ name: 'Cash' });
    expect(await tab('Cash')).toBeInTheDocument();
    expect(screen.getByText(/Nothing has been loaded into Cash/)).toBeInTheDocument();
  });
});

describe('what left this screen', () => {
  it('carries no workspace settings, no export and no identity form', async () => {
    mount();
    await panel('Sparkasse Giro');

    // all four moved to the Account screen, in order, and are asserted there
    expect(screen.queryByLabelText('Base currency')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Export backup/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Recurring payments/)).not.toBeInTheDocument();
    expect(screen.queryByText(/local REST API/)).not.toBeInTheDocument();
  });
});
