import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { COUNT_LIMIT } from '../components/AccountDialog';
import {
  ACCOUNTS,
  APP_SETTINGS,
  importRecord,
  importsResponse,
  PRESETS,
  USER,
} from '../test/fixtures';
import {
  fail,
  mockFetch,
  ok,
  renderThemed,
  requests,
  requestUrls,
  Routes,
} from '../test/harness';
import { fmtWeekday } from '../format';
import { ThemeProvider } from '../theme';
import { Account, Transaction } from '../types';
import { OverviewScreen, WINDOW_TX_LIMIT } from './OverviewScreen';

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
 * so the two transaction reads this screen makes — the recent seven, then the chart's
 * window — are one entry. The fixture below is short enough and recent enough to be a
 * true answer to both.
 */

/** Newest first: the endpoint orders by date DESC, and the recent list trusts it. */
const txn = (date: string, amount: number, patch: Partial<Transaction> = {}): Transaction => ({
  id: `t-${date}-${amount}`,
  accountId: 'acc-1',
  provider: 'upload',
  currency: 'EUR',
  description: 'Row',
  category: 'other',
  transfer: false,
  transferManual: null,
  refund: false,
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

const OVERVIEW_ROUTES: Routes = {
  'GET /api/accounts': () => ok(ACCOUNTS),
  'GET /api/app-settings': () => ok(APP_SETTINGS),
  'GET /api/transactions': () => ok(TXS),
};

const onOpenTransactions = vi.fn();
const onOpenAnalytics = vi.fn();
const onPanelChange = vi.fn();

const screenAt = (importAsk: number, overviewAsk: number) => (
  <OverviewScreen
    user={USER}
    importAsk={importAsk}
    overviewAsk={overviewAsk}
    onOpenTransactions={onOpenTransactions}
    onOpenAnalytics={onOpenAnalytics}
    onPanelChange={onPanelChange}
  />
);

const mount = (routes: Routes = OVERVIEW_ROUTES, importAsk = 0) => {
  onOpenTransactions.mockClear();
  onOpenAnalytics.mockClear();
  onPanelChange.mockClear();
  mockFetch(routes);
  return renderThemed(screenAt(importAsk, 0));
};

/** The anchor for the rail: no tab exists until /api/accounts came back. */
const tab = (name: string) => screen.findByRole('button', { name });

/**
 * The anchor for everything under the rail. It arrives two requests later than the
 * tab does — the recent seven, and then the window they date — so a synchronous query
 * after `tab()` is a query run before the panel exists.
 */
const panel = (name: string) => screen.findByRole('region', { name });

const account = (patch: Partial<Account>): Account => ({
  id: 'acc-x',
  provider: 'upload',
  name: 'Account',
  currency: 'EUR',
  balance: 0,
  ...patch,
});

/** Everything already queued has run by the time a macrotask does. */
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

describe('the hero', () => {
  it('greets by name over today’s date', async () => {
    mount();
    expect(
      await screen.findByRole('heading', { name: `Welcome, ${USER.name}!` }),
    ).toBeInTheDocument();
    // the day this test runs on, formatted the one way fmtWeekday formats it — so the
    // assertion is that the line is drawn from a real clock, not that it says a date
    expect(screen.getByText(fmtWeekday(new Date()))).toBeInTheDocument();
  });

  it('carries neither the theme button nor the avatar, which are the bar’s now', async () => {
    mount();
    await panel('Sparkasse Giro');

    expect(screen.queryByRole('button', { name: /^Theme:/ })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: `Account: ${USER.email}` }),
    ).not.toBeInTheDocument();
  });

  it('opens the import panel when the navigation asks for it', async () => {
    mount({ ...OVERVIEW_ROUTES, 'GET /api/imports/presets': () => ok(PRESETS) }, 1);

    expect(await screen.findByRole('heading', { name: 'Import a statement' })).toBeInTheDocument();
  });

  it('tells the navigation which panel it is on, so the bar can mark it', async () => {
    // the bar cannot see this: Import is a section up there and a panel down here, and
    // without being told it marked Overview as the page over a full window of Import
    mount({ ...OVERVIEW_ROUTES, 'GET /api/imports/presets': () => ok(PRESETS) }, 1);
    await screen.findByRole('heading', { name: 'Import a statement' });

    expect(onPanelChange).toHaveBeenLastCalledWith('import');

    fireEvent.click(screen.getByRole('button', { name: '← Back to accounts' }));

    await panel('Sparkasse Giro');
    expect(onPanelChange).toHaveBeenLastCalledWith(null);
  });

  it('gives the dashboard back when the navigation asks for Overview', async () => {
    // the bar cannot do this by moving `tab`: the import panel IS this screen as far
    // as `tab` is concerned, so the click that asked to leave it changed nothing and
    // Import could be entered and never left
    const { rerender } = mount(
      { ...OVERVIEW_ROUTES, 'GET /api/imports/presets': () => ok(PRESETS) },
      1,
    );
    await screen.findByRole('heading', { name: 'Import a statement' });

    rerender(<ThemeProvider>{screenAt(1, 1)}</ThemeProvider>);

    expect(await panel('Sparkasse Giro')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Import a statement' })).not.toBeInTheDocument();
  });
});

describe('the tab rail', () => {
  it('gives each account a tab and keeps hidden ones off it', async () => {
    mount();

    expect(await tab('Sparkasse Giro')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Old DKB' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Show 1 hidden account/ })).toBeInTheDocument();
  });

  it('brings the hidden ones back onto the rail on request', async () => {
    mount();
    expect(await tab('Sparkasse Giro')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Show 1 hidden account/ }));

    expect(await tab('Old DKB')).toBeInTheDocument();
  });

  it('cuts a long name in the middle and keeps the whole one reachable', async () => {
    // the real shape of a default name: the account is named after the file, .pdf and
    // all, and everything that tells two of them apart is at the end
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

  it('carries the hidden switch as a pressed state, since it has no word on it', async () => {
    // the control is an icon on the band now: struck through while the hidden ones are
    // on the rail. `aria-pressed` is the whole of that fact for a reader who gets
    // neither the glyph nor the slash through it
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
    expect(within(card).getByText('1,234.50 EUR')).toBeInTheDocument();
    expect(
      within(card).getByRole('heading', { name: 'Sparkasse Giro' }),
    ).toBeInTheDocument();
  });
});

describe('income against expenses', () => {
  it('reads the month off the account’s own transactions', async () => {
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
    mount({
      ...OVERVIEW_ROUTES,
      'GET /api/transactions': () =>
        ok([txn('2026-08-04T00:00:00.000Z', 60, { refund: true, category: 'shopping' })]),
    });

    const flows = await panel('Income and expenses for Sparkasse Giro');
    expect(within(flows).getByText('+60 EUR')).toBeInTheDocument();
    expect(within(flows).queryByText(/−−/)).not.toBeInTheDocument();
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
    const before = requests().filter((r) => r === 'GET /api/transactions').length;

    fireEvent.click(screen.getByRole('button', { name: '3 months' }));

    // the chips are the only thing that moved: the months came out of a window already
    // fetched, and narrowing it is arithmetic rather than a request
    expect(await screen.findByRole('button', { name: '3 months', pressed: true })).toBeInTheDocument();
    expect(requests().filter((r) => r === 'GET /api/transactions')).toHaveLength(before);
  });
});

describe('spending by category', () => {
  /** The three rows the card names, as against the table under them, which has all. */
  const legend = (name = 'Biggest categories, Aug 2026') =>
    screen.findByRole('list', { name });

  it('breaks the month’s expenses down without asking the server for them', async () => {
    mount();
    await panel('Sparkasse Giro');
    const asked = requests().filter((r) => r === 'GET /api/transactions').length;

    const card = await panel('Spending by category, Aug 2026');
    // August spent 120 in Food and nothing else — the 300 to savings is a transfer and
    // is not spending, which is the same rule the Expenses figure above it follows
    const rows = within(await legend());
    expect(rows.getByText('Food')).toBeInTheDocument();
    expect(rows.getByText('100%')).toBeInTheDocument();
    // and the middle of the ring is that same Expenses figure
    expect(within(card).getByText('120')).toBeInTheDocument();
    // the window it is computed from was already in hand
    expect(requests().filter((r) => r === 'GET /api/transactions')).toHaveLength(asked);
  });

  it('carries every category in a table, not only the three it names', async () => {
    const many: Transaction[] = [
      txn('2026-08-04T00:00:00.000Z', -400, { category: 'housing' }),
      txn('2026-08-03T00:00:00.000Z', -300, { category: 'food' }),
      txn('2026-08-02T00:00:00.000Z', -200, { category: 'transport' }),
      txn('2026-08-01T00:00:00.000Z', -100, { category: 'health' }),
    ];
    mount({ ...OVERVIEW_ROUTES, 'GET /api/transactions': () => ok(many) });

    const card = await panel('Spending by category, Aug 2026');
    const rows = within(await legend());
    // the legend is the top three, and then the tail named as a tail — 100 of 1000
    expect(rows.getByText('1 more category')).toBeInTheDocument();
    expect(rows.getByText('10%')).toBeInTheDocument();
    expect(rows.queryByText('Health')).not.toBeInTheDocument();
    // the fourth one is not lost: the table beside the ring has all of them, which is
    // what a screen reader gets and what jsdom can see of a donut
    const table = within(card).getByRole('table', { name: /Spending by category/ });
    expect(within(table).getByRole('rowheader', { name: 'Health' })).toBeInTheDocument();
  });

  it('says so rather than drawing an empty ring when the month spent nothing', async () => {
    mount({
      ...OVERVIEW_ROUTES,
      'GET /api/transactions': () =>
        ok([txn('2026-08-04T00:00:00.000Z', 900, { category: 'salary' })]),
    });

    const card = await panel('Spending by category, Aug 2026');
    expect(within(card).getByText(/Nothing was spent out of this account/)).toBeInTheDocument();
    // the way out of the card is not part of the breakdown, and a month that spent
    // nothing is exactly when somebody goes looking at a wider range
    expect(within(card).getByRole('button', { name: 'All analytics →' })).toBeInTheDocument();
  });

  it('opens the Analytics screen from the foot of the card', async () => {
    mount();
    const card = await panel('Spending by category, Aug 2026');

    fireEvent.click(within(card).getByRole('button', { name: 'All analytics →' }));

    expect(onOpenAnalytics).toHaveBeenCalled();
  });
});

describe('switching tabs while a read is in flight', () => {
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

    // Slow's answer must not start Slow's second read, and must not reach `data`: an
    // id the render then rejects is no dashboard, no error and no reason to fetch
    // again — the effect's deps did not move, so the screen stays empty until the
    // reader clicks a third tab
    expect(requests().filter((r) => r === 'GET /api/transactions')).toHaveLength(3);
    expect(screen.getByRole('region', { name: 'Balance of Quick' })).toBeInTheDocument();
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

describe('a window that came back at its limit', () => {
  /**
   * The endpoint is `date DESC` with a bare limit and no cap of its own, so a response
   * exactly this long has dropped its far end — the oldest rows in the window, and with
   * them whole months the chart then draws no bar for.
   */
  const atLimit: Transaction[] = Array.from({ length: WINDOW_TX_LIMIT }, (_, i) =>
    txn(i % 2 === 0 ? '2026-08-10T00:00:00.000Z' : '2026-07-10T00:00:00.000Z', -1),
  );

  const mountTruncated = () => {
    let calls = 0;
    // the recent seven first, then the window: one path, so the ordinal tells them
    // apart. Only the second is at the limit — the first asked for seven.
    return mount({
      ...OVERVIEW_ROUTES,
      'GET /api/transactions': () => ok((calls += 1) === 1 ? TXS : atLimit),
    });
  };

  it('refuses the chart rather than drawing a total it cannot stand behind', async () => {
    mountTruncated();
    await panel('Sparkasse Giro');

    // the chart is the one place a cut window is invisible: it draws whatever survived
    // and looks exactly like a complete one
    expect(screen.getByText(/Nothing here is safe to read as a total/)).toBeInTheDocument();
  });

  it('shows no comparison it cannot stand behind, on either card', async () => {
    mountTruncated();
    await panel('Sparkasse Giro');

    // the month a percentage is measured against may be a part of a month, and the
    // balance's derived opening figure short by whatever was dropped — so neither the
    // balance card nor the flows card draws one. Asserted as the absence of a
    // percentage rather than of `.fig-delta`: what must not be on screen is the claim,
    // not the element that would carry it.
    const balance = await panel('Balance of Sparkasse Giro');
    const flows = await panel('Income and expenses for Sparkasse Giro');
    expect(within(balance).queryByText(/%/)).not.toBeInTheDocument();
    expect(within(flows).queryByText(/\d\.\d%/)).not.toBeInTheDocument();
    expect(
      screen.getByText(/no comparison with the month before is shown/),
    ).toBeInTheDocument();
    // the balance itself is the server's sum of every row and is not read off the
    // window, so it stays on screen
    expect(within(balance).getByText('1,234.50 EUR')).toBeInTheDocument();
  });

  it('still breaks the newest month down, which a cap at the far end cannot have cut', async () => {
    // the endpoint orders `date DESC`, so what a response at its limit dropped is the
    // OLDEST rows. The newest month is the one part of the window that survives whole,
    // and it is the only part the donut is about.
    mountTruncated();

    await panel('Spending by category, Aug 2026');
    const rows = within(await screen.findByRole('list', { name: /Biggest categories/ }));
    expect(rows.getByText('Other')).toBeInTheDocument();
    expect(rows.getByText('100%')).toBeInTheDocument();
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
    expect(within(list).getByText('transfer')).toBeInTheDocument();
    // a status column would have to invent one: a statement records what already happened
    expect(within(list).queryByText('Completed')).not.toBeInTheDocument();
    expect(within(list).queryByRole('columnheader', { name: 'Account' })).not.toBeInTheDocument();
    expect(within(list).queryByRole('columnheader', { name: 'Status' })).not.toBeInTheDocument();
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

    fireEvent.click(screen.getByRole('button', { name: 'All transactions →' }));

    expect(onOpenTransactions).toHaveBeenCalledWith('acc-1');
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
  });

  it('does not claim the accounts are empty when the request for them failed', async () => {
    mount({ ...OVERVIEW_ROUTES, 'GET /api/accounts': () => fail(500) });

    expect(await screen.findByText(/^Error:/)).toBeInTheDocument();
    // `accounts` was never loaded, so there is nothing to be empty
    expect(screen.queryByText(/Nothing here yet/)).not.toBeInTheDocument();
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
    fireEvent.click(await tab('Old DKB'));

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
    fireEvent.click(await tab('Old DKB'));
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
    fireEvent.click(await tab('Old DKB'));
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
    // and the honest part: this server has no endpoint for it, said before the click
    // rather than after it
    expect(screen.getByText(/no endpoint that deletes an account/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete permanently/ })).not.toBeInTheDocument();
  });

  it('will not print a count that is really the limit', async () => {
    let calls = 0;
    mount({
      ...OVERVIEW_ROUTES,
      'GET /api/imports': () => ok(importsResponse()),
      // the dashboard's two reads, then the dialog's count — which comes back exactly
      // as long as it asked for. The rows are never read, only counted, so they are
      // not built: what is under test is the length.
      'GET /api/transactions': () => {
        calls += 1;
        return ok(calls <= 2 ? TXS : new Array(COUNT_LIMIT).fill(null));
      },
    });
    const menu = await openMenu();

    fireEvent.click(within(menu).getByText('Delete'));

    // a number that is silently the limit is the one number this dialog must not print
    expect(await screen.findByText(`at least ${COUNT_LIMIT} transactions`)).toBeInTheDocument();
    expect(screen.getByText(/it is the limit and not the answer/)).toBeInTheDocument();
  });

  /**
   * The per-account view is per-account, and after row 66 that is the server's job:
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

    fireEvent.click(screen.getByRole('button', { name: 'Add more +' }));
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Cash' } });
    // the currency is not asked for: it is the workspace's base currency
    expect(screen.getByText(/base currency of this workspace/)).toHaveTextContent('EUR');
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await panel('Cash');
    // an equality, so what is asserted is the ABSENCE of a currency key: the client
    // no longer guesses one, and the server defaults it (row 65)
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
    expect(screen.queryByRole('button', { name: /Export my data/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Recurring payments/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^API:/)).not.toBeInTheDocument();
  });
});
