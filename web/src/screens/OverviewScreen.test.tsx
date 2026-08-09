import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
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
import { Account, AccountDeleted, Transaction } from '../types';
import { OverviewScreen, WINDOW_TX_LIMIT } from './OverviewScreen';

/**
 * The Overview dashboard: the tab rail, the three cards, the month chart and the last
 * transactions of the account on the tab. Everything about the workspace rather than
 * about one account moved to the Account screen and is asserted there.
 *
 * Two things this file cannot assert, both limits of the environment rather than gaps:
 * the chart itself — recharts measures a 0x0 box in jsdom — and anything about width,
 * so the narrow layout of the transactions table stays a manual check. The chart's
 * numbers are asserted through the table beside it, which is the same data and is what
 * a screen reader gets.
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
const onOpenAccount = vi.fn();

const mount = (routes: Routes = OVERVIEW_ROUTES, importAsk = 0) => {
  onOpenTransactions.mockClear();
  onOpenAccount.mockClear();
  mockFetch(routes);
  return renderThemed(
    <OverviewScreen
      user={USER}
      importAsk={importAsk}
      onOpenTransactions={onOpenTransactions}
      onOpenAccount={onOpenAccount}
    />,
  );
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

describe('the header', () => {
  it('greets by name and sends the avatar to the Account screen', async () => {
    mount();
    expect(
      await screen.findByRole('heading', { name: `Welcome, ${USER.name}!` }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: `Account: ${USER.email}` }));

    expect(onOpenAccount).toHaveBeenCalledTimes(1);
  });

  it('opens the import panel when the sidebar asks for it', async () => {
    mount({ ...OVERVIEW_ROUTES, 'GET /api/imports/presets': () => ok(PRESETS) }, 1);

    expect(await screen.findByRole('heading', { name: 'Import a statement' })).toBeInTheDocument();
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
});

describe('the three cards', () => {
  it('takes the balance from the account and the month from its transactions', async () => {
    mount();

    // the figures region, not the account panel around it: the chart's accessible
    // table repeats these numbers, and it is inside the panel
    const figures = await panel('Figures for Sparkasse Giro');
    expect(within(figures).getByText('1,234.50 EUR')).toBeInTheDocument();
    // August: 900 in, 120 out, and the 300 moved to savings is neither
    expect(within(figures).getAllByText('Aug 2026').length).toBeGreaterThan(0);
    expect(within(figures).getByText('+900 EUR')).toBeInTheDocument();
    expect(within(figures).getByText('−120 EUR')).toBeInTheDocument();
  });

  it('compares each figure with the month before it, and colours the two differently', async () => {
    mount();
    const figures = await panel('Figures for Sparkasse Giro');

    // July: nothing in, 60 out. August: 900 in, 120 out.
    // Income has no base to compare against (July's income was 0), so it says nothing
    // rather than printing an infinity dressed up as a percentage.
    const deltas = within(figures).getAllByText(/%$|%/);
    expect(deltas.length).toBeGreaterThan(0);
    // spending doubled, and spending going up is not good news
    const expense = within(figures).getByText('100.0%').closest('p');
    expect(expense).toHaveClass('is-bad');
  });

  it('names the month on the cards, which is the only place it is named', async () => {
    // uploading July and reading the screen in September must not read as August: the
    // prose that used to say so is gone, so the label under each figure carries it
    mount();
    const figures = await panel('Figures for Sparkasse Giro');
    expect(within(figures).getAllByText('Aug 2026').length).toBeGreaterThan(0);
    expect(within(figures).queryByText('Sep 2026')).not.toBeInTheDocument();
  });
});

describe('the month chart', () => {
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
    await panel('Figures for Quick');

    release(ok(TXS));
    await settle();

    // Slow's answer must not start Slow's second read, and must not reach `data`: an
    // id the render then rejects is no dashboard, no error and no reason to fetch
    // again — the effect's deps did not move, so the screen stays empty until the
    // reader clicks a third tab
    expect(requests().filter((r) => r === 'GET /api/transactions')).toHaveLength(3);
    expect(screen.getByRole('region', { name: 'Figures for Quick' })).toBeInTheDocument();
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
    await panel('Figures for Quick');

    release(fail(500));
    await settle();

    expect(screen.queryByText(/^Error:/)).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Figures for Quick' })).toBeInTheDocument();
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
    expect(screen.getByText(/the months below are incomplete/)).toBeInTheDocument();
  });

  it('shows no comparison it cannot stand behind', async () => {
    mountTruncated();
    const figures = await panel('Figures for Sparkasse Giro');

    // the month a percentage is measured against may be a part of a month, and the
    // balance's derived opening figure short by whatever was dropped
    expect(figures.querySelectorAll('.fig-delta')).toHaveLength(0);
    expect(
      screen.getByText(/no comparison with the month before them is shown/),
    ).toBeInTheDocument();
    // the balance itself is the server's sum of every row and is not read off the
    // window, so it stays on screen
    expect(within(figures).getByText('1,234.50 EUR')).toBeInTheDocument();
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

    expect(await panel('Figures for Old DKB')).toBeInTheDocument();
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
    // the same two rows after the server re-classified them: the surviving leg has no
    // partner left, so it stops being a transfer and starts counting as spending
    const REPAIRED = PAIRED.map((t) => ({ ...t, transfer: false }));
    let gone = false;
    mount({
      ...OVERVIEW_ROUTES,
      'GET /api/accounts': () => ok(gone ? [A] : [A, B]),
      'GET /api/transactions': () => ok(gone ? REPAIRED : PAIRED),
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
    fireEvent.click(await tab('Old DKB'));
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
