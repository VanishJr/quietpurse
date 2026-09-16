import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ACCOUNTS, INCOME_SOURCES, TRANSFER_RULES } from '../test/fixtures';
import { fail, mockFetch, ok, renderThemed, requests, requestUrls, Routes } from '../test/harness';
import { IncomeSourceDef, Transaction, TransferRuleWithMatches } from '../types';
import { TransactionsScreen } from './TransactionsScreen';

/**
 * The first of the empty-versus-failed states: "No transactions in the selected period."
 * over a period the screen never read. The rows are file-local rather than in fixtures.ts
 * because the descriptions below are asserted on, and a fixture tuned to one file's
 * assertions is how the next change gets a surprise.
 */

const EMPTY = 'No transactions in the selected period.';

const ROWS: Transaction[] = [
  {
    id: 'tx-1',
    accountId: 'acc-1',
    provider: 'upload',
    amount: -42.5,
    currency: 'EUR',
    date: '2026-07-14',
    description: 'REWE Berlin',
    category: 'food',
    categoryManual: false,
    transfer: false,
    transferManual: null,
    refund: false,
    incomeSourceManual: false,
    recurring: false,
    oneOff: false,
  },
  {
    id: 'tx-2',
    accountId: 'acc-1',
    provider: 'upload',
    amount: -19,
    currency: 'EUR',
    date: '2026-07-15',
    description: 'BVG Ticket',
    category: 'transport',
    categoryManual: false,
    transfer: false,
    transferManual: null,
    refund: false,
    incomeSourceManual: false,
    recurring: false,
    oneOff: false,
  },
];

/** All four of the screen's mount requests, including in the tests where one fails. */
const TX_ROUTES: Routes = {
  'GET /api/accounts': () => ok(ACCOUNTS),
  'GET /api/income-sources': () => ok(INCOME_SOURCES),
  'GET /api/transfer-rules': () => ok(TRANSFER_RULES),
  'GET /api/transactions': () => ok(ROWS),
};

const mount = () => renderThemed(<TransactionsScreen />);

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

/**
 * The booleans default to `false`, what the server sends for a row nobody touched,
 * and `categoryManual` is the one that matters: `false` hides the "back to
 * auto-detection" control, so no case sees it unless it says `categoryManual: true`,
 * and an assertion about either state is never green by construction. Each case that
 * cares still says which state it means.
 */
const row = (patch: Partial<Transaction> & { id: string }): Transaction => ({
  accountId: 'acc-1',
  provider: 'upload',
  amount: -12,
  currency: 'EUR',
  date: '2026-07-14',
  description: 'a row',
  category: 'other',
  categoryManual: false,
  transfer: false,
  transferManual: null,
  refund: false,
  incomeSourceManual: false,
  recurring: false,
  oneOff: false,
  ...patch,
});

const ruleAnswer = (pattern: string, matches: number, overridden: number) => ({
  rule: { id: 7, pattern, category: 'food', createdAt: '2026-07-20T10:00:00.000Z' },
  matches,
  overridden,
});

const ruleChip = (label: string) =>
  screen.getByRole('button', {
    name: `${label}, every transaction whose description contains this text`,
  });

const openPicker = () =>
  fireEvent.click(
    screen.getByRole('button', { name: 'Change the category of transactions like this…' }),
  );

const typePattern = (value: string) =>
  fireEvent.change(screen.getByLabelText('Apply to transactions whose description contains'), {
    target: { value },
  });

describe('the transactions list', () => {
  it('renders the rows it was given', async () => {
    // the mirror: without it the two below would both pass against a screen that
    // renders nothing at all
    mockFetch(TX_ROUTES);
    mount();

    expect(await screen.findByText('REWE Berlin')).toBeInTheDocument();
    expect(screen.getByText('BVG Ticket')).toBeInTheDocument();
    expect(screen.queryByText(EMPTY)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Error:/)).not.toBeInTheDocument();
  });

  it('says the period is empty when the period really is empty', async () => {
    // the mirror for the test below: without it that one passes against a screen
    // that lost its empty state entirely
    mockFetch({ ...TX_ROUTES, 'GET /api/transactions': () => ok([]) });
    mount();

    expect(await screen.findByText(EMPTY)).toBeInTheDocument();
    expect(screen.queryByText(/^Error:/)).not.toBeInTheDocument();
  });

  it('does not call the period empty when the request for it failed', async () => {
    mockFetch({
      ...TX_ROUTES,
      'GET /api/transactions': () => fail(500, { error: 'the transaction store is unreachable' }),
    });
    mount();

    // anchor: the refusal, which exists only once the request came back
    expect(await screen.findByText(/the transaction store is unreachable/)).toBeInTheDocument();
    // `txs` was never loaded, so there is no period to be empty
    expect(screen.queryByText(EMPTY)).not.toBeInTheDocument();
  });

  it('drops the previous filter\'s rows when the reload after a filter change is refused', async () => {
    // keyOf discards the query string, so both loads land on one route key
    let reads = 0;
    mockFetch({
      ...TX_ROUTES,
      'GET /api/transactions': () => {
        reads += 1;
        return reads === 1
          ? ok(ROWS)
          : fail(500, { error: 'the transaction store is unreachable' });
      },
    });
    mount();
    expect(await screen.findByText('REWE Berlin')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Food' }));

    expect(await screen.findByText(/the transaction store is unreachable/)).toBeInTheDocument();
    // rows kept from before a refused reload sit under a chip they were never an
    // answer to: all-categories rows under "Food"
    expect(screen.queryByText('REWE Berlin')).not.toBeInTheDocument();
    expect(screen.queryByText('BVG Ticket')).not.toBeInTheDocument();
    expect(screen.queryByText(EMPTY)).not.toBeInTheDocument();
  });
});

describe('the window the screen asks for', () => {
  it('opens unbounded when the Overview sends the reader here', async () => {
    mockFetch(TX_ROUTES);
    renderThemed(<TransactionsScreen focus={{ accountId: 'acc-1', nonce: 1 }} />);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true'),
    );
    await settle();

    // "All transactions →" is what sent the reader here, so the request behind it
    // carries no lower bound - and the raise the backend's default 1000 needs
    const asked = requestUrls().filter((u) => u.includes('/api/transactions'));
    expect(asked[asked.length - 1]).not.toMatch(/[?&]from=/);
    expect(asked[asked.length - 1]).toMatch(/[?&]limit=5000/);
  });
});

describe('the account a row belongs to', () => {
  it('names it in every row, and stops once the Account chip names one', async () => {
    mockFetch({
      ...TX_ROUTES,
      'GET /api/transactions': () =>
        ok([
          row({ id: 'tx-1', description: 'REWE Berlin', accountId: 'acc-1' }),
          row({ id: 'tx-2', description: 'BVG Ticket', accountId: 'acc-2' }),
        ]),
    });
    mount();

    expect(await screen.findByText(/· Sparkasse Giro/)).toBeInTheDocument();
    expect(screen.getByText(/· Old DKB/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sparkasse Giro' }));
    await settle();

    // a column with one value in it is not a column, and the chip states that value
    expect(screen.queryByText(/· Sparkasse Giro/)).not.toBeInTheDocument();
    expect(screen.queryByText(/· Old DKB/)).not.toBeInTheDocument();
    expect(screen.getByText('REWE Berlin')).toBeInTheDocument();
  });

  it('prints no raw id for an account the screen does not have', async () => {
    mockFetch({
      ...TX_ROUTES,
      'GET /api/transactions': () =>
        ok([row({ id: 'tx-1', description: 'Ghost Row', accountId: 'acc-gone' })]),
    });
    mount();

    fireEvent.click(await screen.findByText('Ghost Row'));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    // both call sites at once: the row's sub-line and the sheet's meta line
    expect(screen.queryAllByText(/acc-gone/)).toHaveLength(0);
  });
});

describe('the category of one transaction', () => {
  it('reaches a row with no description at all', async () => {
    const blank = row({ id: 'tx-blank', description: '', category: 'other' });
    mockFetch({
      ...TX_ROUTES,
      'GET /api/transactions': () => ok([blank]),
      'PATCH /api/transactions/tx-blank/category': () =>
        ok({ ...blank, category: 'food', categoryManual: true }),
    });
    mount();

    fireEvent.click(await screen.findByText('(no description)'));
    fireEvent.click(screen.getByRole('button', { name: 'Food, this transaction only' }));
    await settle();

    // the wire, not the button: a rule can never reach this row, and the server
    // refuses one built on an empty pattern
    expect(requestUrls()).toContain('PATCH /api/transactions/tx-blank/category');
  });

  it('offers the way back to auto-detection only for a row set by hand', async () => {
    const auto = row({
      id: 'tx-auto',
      description: 'Auto Row',
      category: 'food',
      categoryManual: false,
    });
    const manual = row({
      id: 'tx-manual',
      description: 'Manual Row',
      category: 'food',
      categoryManual: true,
    });
    let sent: unknown;
    mockFetch({
      ...TX_ROUTES,
      'GET /api/transactions': () => ok([auto, manual]),
      'PATCH /api/transactions/tx-manual/category': (init) => {
        sent = JSON.parse(String(init?.body));
        return ok({ ...manual, category: 'shopping', categoryManual: false });
      },
    });
    mount();

    fireEvent.click(await screen.findByText('Auto Row'));
    expect(await screen.findByText(/This transaction only · auto-detected/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Category: back to auto-detection' }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    fireEvent.click(screen.getByText('Manual Row'));
    expect(await screen.findByText(/This transaction only · set manually/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Category: back to auto-detection' }));
    await settle();

    expect(sent).toEqual({ category: null });
  });

  it('reads the hint back from the answer, so pinning a category the row already has shows', async () => {
    const auto = row({
      id: 'tx-auto',
      description: 'Auto Row',
      category: 'food',
      categoryManual: false,
    });
    mockFetch({
      ...TX_ROUTES,
      'GET /api/transactions': () => ok([auto]),
      'PATCH /api/transactions/tx-auto/category': () => ok({ ...auto, categoryManual: true }),
    });
    mount();

    fireEvent.click(await screen.findByText('Auto Row'));
    expect(await screen.findByText(/This transaction only · auto-detected/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Food, this transaction only' }));

    expect(await screen.findByText(/This transaction only · set manually/)).toBeInTheDocument();
    // the pressed state is the only thing on this grid that says which category the
    // row carries, and it belongs to the grid that sets one row's category
    expect(screen.getByRole('button', { name: 'Food, this transaction only' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Shopping, this transaction only' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('drops a row that stopped answering the category chip, and the count agrees', async () => {
    const one = row({ id: 'tx-1', description: 'REWE Berlin', category: 'food' });
    const two = row({ id: 'tx-2', description: 'Edeka Mitte', category: 'food' });
    mockFetch({
      ...TX_ROUTES,
      'GET /api/transactions': () => ok([one, two]),
      'PATCH /api/transactions/tx-1/category': () =>
        ok({ ...one, category: 'transport', categoryManual: true }),
    });
    mount();
    await screen.findByText('REWE Berlin');
    fireEvent.click(screen.getByRole('button', { name: 'Food' }));
    await settle();

    fireEvent.click(screen.getByText('REWE Berlin'));
    fireEvent.click(screen.getByRole('button', { name: 'Transport, this transaction only' }));
    await settle();

    expect(screen.queryByText('REWE Berlin')).not.toBeInTheDocument();
    expect(screen.getByText('Edeka Mitte')).toBeInTheDocument();
    expect(screen.queryByText(EMPTY)).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Edeka Mitte'));
    openPicker();
    expect(screen.getByText(/Matches 1 of the 1 loaded transactions/)).toBeInTheDocument();
  });

  it('closes the sheet on the row it just dropped', async () => {
    const one = row({ id: 'tx-1', description: 'REWE Berlin', category: 'food' });
    mockFetch({
      ...TX_ROUTES,
      'GET /api/transactions': () => ok([one]),
      'PATCH /api/transactions/tx-1/category': () =>
        ok({ ...one, category: 'transport', categoryManual: true }),
    });
    mount();
    await screen.findByText('REWE Berlin');
    fireEvent.click(screen.getByRole('button', { name: 'Food' }));
    await settle();

    fireEvent.click(screen.getByText('REWE Berlin'));
    fireEvent.click(screen.getByRole('button', { name: 'Transport, this transaction only' }));
    await settle();

    // a sheet left open on a row the list no longer holds takes a second pick that
    // lands on nothing, and the row is then gone until a chip is touched
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText(EMPTY)).toBeInTheDocument();
  });

  it('leaves the list alone when the category chip moves while the write is in flight', async () => {
    const food = [row({ id: 'tx-1', description: 'REWE Berlin', category: 'food' })];
    // the row the PATCH is moving is in the answer to the reload: a server that
    // forgot the write it had just acknowledged makes a stale drop a no-op, and the
    // case then passes against the stale chip it exists to forbid
    const transport = [
      row({ id: 'tx-9', description: 'BVG Ticket', category: 'transport' }),
      row({ id: 'tx-1', description: 'REWE Berlin', category: 'transport', categoryManual: true }),
    ];
    let release: (r: Response) => void = () => {};
    let reads = 0;
    mockFetch({
      ...TX_ROUTES,
      'GET /api/transactions': () => {
        reads += 1;
        return ok(reads <= 2 ? food : transport);
      },
      'PATCH /api/transactions/tx-1/category': () =>
        new Promise<Response>((resolve) => (release = resolve)),
    });
    mount();
    await screen.findByText('REWE Berlin');
    fireEvent.click(screen.getByRole('button', { name: 'Food' }));
    await settle();

    fireEvent.click(screen.getByText('REWE Berlin'));
    fireEvent.click(screen.getByRole('button', { name: 'Transport, this transaction only' }));

    // the chip the handler was created under is not the chip the list now answers
    fireEvent.click(screen.getByRole('button', { name: 'Transport' }));
    expect(await screen.findByText('BVG Ticket')).toBeInTheDocument();

    release(ok({ ...food[0], category: 'transport', categoryManual: true }));
    await settle();

    expect(screen.getByText('BVG Ticket')).toBeInTheDocument();
    // the sheet is still open on it too, so the description is on screen twice
    expect(screen.getAllByText('REWE Berlin').length).toBeGreaterThan(0);
    expect(screen.queryByText(EMPTY)).not.toBeInTheDocument();
  });
});

describe('the category of a whole group', () => {
  it('leaves the caption on the screen after the sheet that made it has closed', async () => {
    mockFetch({
      ...TX_ROUTES,
      'POST /api/category-rules': () => ok(ruleAnswer('REWE', 15, 3)),
      'PATCH /api/transactions/tx-2/category': () =>
        ok({ ...ROWS[1], category: 'food', categoryManual: true }),
    });
    mount();

    fireEvent.click(await screen.findByText('REWE Berlin'));
    openPicker();
    typePattern('REWE');
    fireEvent.click(ruleChip('Food'));

    expect(
      await screen.findByText(/3 of them keep a category you set by hand/),
    ).toBeInTheDocument();
    // the sentence is composed from the answer to an operation that closes the sheet
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('BVG Ticket'));
    fireEvent.click(screen.getByRole('button', { name: 'Food, this transaction only' }));
    await settle();

    // and it goes the moment a hand-set category makes its count wrong: this row is
    // the fourth the rule could not move, and the sentence still says three
    expect(screen.queryByText(/keep a category you set by hand/)).not.toBeInTheDocument();
  });

  it('brings the caption into view, since the row that made it may be far down the list', async () => {
    mockFetch({
      ...TX_ROUTES,
      'POST /api/category-rules': () => ok(ruleAnswer('REWE', 15, 3)),
    });
    mount();

    fireEvent.click(await screen.findByText('REWE Berlin'));
    openPicker();
    typePattern('REWE');
    fireEvent.click(ruleChip('Food'));
    await screen.findByText(/3 of them keep a category you set by hand/);

    // which element was scrolled, not that something was: the caption sits above a
    // list the reader scrolled down through, so in a browser it lands off-screen
    const scrolled = vi.mocked(Element.prototype.scrollIntoView).mock.instances;
    expect(scrolled).toHaveLength(1);
    expect(scrolled[0]).toHaveTextContent('3 of them keep a category you set by hand');
  });

  it('scrolls nothing when a single row changes category', async () => {
    const one = row({ id: 'tx-1', description: 'REWE Berlin', category: 'food' });
    mockFetch({
      ...TX_ROUTES,
      'GET /api/transactions': () => ok([one]),
      'PATCH /api/transactions/tx-1/category': () =>
        ok({ ...one, category: 'shopping', categoryManual: true }),
    });
    mount();

    fireEvent.click(await screen.findByText('REWE Berlin'));
    fireEvent.click(screen.getByRole('button', { name: 'Shopping, this transaction only' }));
    await settle();

    // it writes no caption, so there is nothing to bring into view and the reader
    // keeps the place in the list they were working in
    expect(vi.mocked(Element.prototype.scrollIntoView)).not.toHaveBeenCalled();
  });

  it('keeps its two counts apart: the loaded rows and the whole workspace', async () => {
    mockFetch({
      ...TX_ROUTES,
      'GET /api/transactions': () =>
        ok([
          row({ id: 'tx-1', description: 'REWE Berlin', category: 'food' }),
          row({ id: 'tx-2', description: 'REWE Mitte', category: 'food' }),
          row({ id: 'tx-3', description: 'BVG Ticket', category: 'transport' }),
          row({ id: 'tx-4', description: 'Netflix', category: 'subscriptions' }),
        ]),
      'POST /api/category-rules': () => ok(ruleAnswer('REWE', 15, 3)),
    });
    mount();

    fireEvent.click(await screen.findByText('REWE Berlin'));
    openPicker();
    typePattern('REWE');

    // every number in this case differs from every other, so no assertion can pass by
    // reading the wrong one
    expect(screen.getByText(/Matches 2 of the 4 loaded transactions/)).toBeInTheDocument();
    // and no pressed state on this grid: it sets no row's category, and the honest
    // value would be the rule's, which this screen never asks the server for
    expect(ruleChip('Food')).not.toHaveAttribute('aria-pressed');

    fireEvent.click(ruleChip('Food'));

    const caption = await screen.findByText(/across every account/);
    expect(caption).toHaveTextContent('15 transactions match that text');
    expect(caption).toHaveTextContent('3 of them keep a category you set by hand');
    expect(caption).not.toHaveTextContent('loaded');
  });
});

/**
 * The sheet's other writes: the transfer flag, the one-off mark, the
 * income source and the transfer rule. Each case asserts the body the route received
 * and the effect on the screen with a presence anchor beside every absence.
 *
 * "Rule off with no rule sends nothing" is not a case: the switch is checked exactly
 * when a rule exists, so a click on an unchecked switch arrives as `checked: true`
 * and the control cannot produce that event.
 */

/** An expense the sheet offers every switch for, and an income it offers the sources for. */
const EXPENSE = row({ id: 'tx-1', description: 'REWE Berlin', amount: -42.5, category: 'food' });
const INCOME = row({
  id: 'tx-in',
  description: 'ZZ Income',
  amount: 100,
  category: 'other',
  incomeSource: 'other',
  incomeSourceManual: false,
});

/** A catalog of this file's own: the shared fixture is `[]`. */
const SOURCES: IncomeSourceDef[] = [
  { id: 'salary', label: 'Salary', kind: 'own', patterns: [], sort: 0, builtin: true },
  { id: 'family', label: 'Support', kind: 'external', patterns: [], sort: 1, builtin: true },
];

const RULE: TransferRuleWithMatches = {
  id: 7,
  description: 'REWE Berlin',
  accountId: 'acc-1',
  createdAt: '2026-07-20T10:00:00.000Z',
  matches: 3,
};

const transferSwitch = () => screen.getByRole('checkbox', { name: /Transfer between own accounts/ });
const ruleSwitch = () => screen.getByRole('checkbox', { name: /on this account/ });
const oneOffSwitch = () => screen.getByRole('checkbox', { name: /One-off large purchase/ });
/** Inside the sheet: the category filter above the list carries a chip of the same name. */
const sourceChip = (label: string) =>
  within(screen.getByRole('dialog')).getByRole('button', { name: label });

const openSheet = async (description: string) => {
  fireEvent.click(await screen.findByText(description));
  await screen.findByRole('dialog');
};

/** The body a handler received, parsed. */
const bodyOf = (init?: RequestInit): unknown => JSON.parse(String(init?.body));

describe('the transfer flag', () => {
  it('marks the row by hand, and back to auto-detection sends null', async () => {
    const sent: unknown[] = [];
    mockFetch({
      ...TX_ROUTES,
      'GET /api/transactions': () => ok([EXPENSE]),
      'PATCH /api/transactions/tx-1/transfer': (init) => {
        const { transfer } = bodyOf(init) as { transfer: boolean | null };
        sent.push({ transfer });
        return ok({ ...EXPENSE, transfer: transfer ?? false, transferManual: transfer });
      },
    });
    mount();
    await openSheet('REWE Berlin');
    expect(screen.getByText(/Counted as neither income nor expense · auto-detected/)).toBeInTheDocument();

    fireEvent.click(transferSwitch());

    // the badge is the answer replacing the row in the list; the hint, in the sheet
    expect(await screen.findByText('transfer')).toBeInTheDocument();
    expect(screen.getByText(/Counted as neither income nor expense · set manually/)).toBeInTheDocument();
    expect(transferSwitch()).toBeChecked();
    expect(sent).toEqual([{ transfer: true }]);

    fireEvent.click(screen.getByRole('button', { name: 'Back to auto-detection' }));

    await waitFor(() => expect(sent).toEqual([{ transfer: true }, { transfer: null }]));
    expect(await screen.findByText(/Counted as neither income nor expense · auto-detected/)).toBeInTheDocument();
    expect(screen.queryByText('transfer')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Back to auto-detection' })).toBeNull();
  });

  it('keeps the row and the sheet, and re-enables the switch, when the write is refused', async () => {
    mockFetch({
      ...TX_ROUTES,
      'GET /api/transactions': () => ok([EXPENSE]),
      'PATCH /api/transactions/tx-1/transfer': () =>
        fail(500, { error: 'the transfer flag could not be saved' }),
    });
    mount();
    await openSheet('REWE Berlin');

    fireEvent.click(transferSwitch());

    expect(await screen.findByText(/the transfer flag could not be saved/)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByText('transfer')).toBeNull();
    expect(transferSwitch()).not.toBeChecked();
    expect(transferSwitch()).toBeEnabled();
  });
});

describe('the one-off mark', () => {
  it('sets it', async () => {
    const sent: unknown[] = [];
    mockFetch({
      ...TX_ROUTES,
      'GET /api/transactions': () => ok([EXPENSE]),
      'PATCH /api/transactions/tx-1/one-off': (init) => {
        sent.push(bodyOf(init));
        return ok({ ...EXPENSE, oneOff: true });
      },
    });
    mount();
    await openSheet('REWE Berlin');
    expect(screen.queryByText('one-off')).toBeNull();

    fireEvent.click(oneOffSwitch());

    expect(await screen.findByText('one-off')).toBeInTheDocument();
    expect(oneOffSwitch()).toBeChecked();
    expect(sent).toEqual([{ oneOff: true }]);
  });

  /** Its own case: a handler sending a literal `true` is invisible to the one above. */
  it('clears it, and the row stays', async () => {
    const marked = { ...EXPENSE, oneOff: true };
    const sent: unknown[] = [];
    mockFetch({
      ...TX_ROUTES,
      'GET /api/transactions': () => ok([marked]),
      'PATCH /api/transactions/tx-1/one-off': (init) => {
        sent.push(bodyOf(init));
        return ok({ ...marked, oneOff: false });
      },
    });
    mount();
    await openSheet('REWE Berlin');
    expect(screen.getByText('one-off')).toBeInTheDocument();
    expect(oneOffSwitch()).toBeChecked();

    fireEvent.click(oneOffSwitch());

    await waitFor(() => expect(screen.queryByText('one-off')).toBeNull());
    expect(screen.getAllByText('REWE Berlin').length).toBeGreaterThan(0);
    expect(oneOffSwitch()).not.toBeChecked();
    expect(sent).toEqual([{ oneOff: false }]);
  });

  it('keeps the row and the sheet, and re-enables the switch, when the write is refused', async () => {
    mockFetch({
      ...TX_ROUTES,
      'GET /api/transactions': () => ok([EXPENSE]),
      'PATCH /api/transactions/tx-1/one-off': () =>
        fail(500, { error: 'the one-off mark could not be saved' }),
    });
    mount();
    await openSheet('REWE Berlin');

    fireEvent.click(oneOffSwitch());

    expect(await screen.findByText(/the one-off mark could not be saved/)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByText('one-off')).toBeNull();
    expect(oneOffSwitch()).not.toBeChecked();
    expect(oneOffSwitch()).toBeEnabled();
  });
});

describe('the income source', () => {
  it('marks the row with a chip, and back to auto-detection sends null', async () => {
    const sent: unknown[] = [];
    mockFetch({
      ...TX_ROUTES,
      'GET /api/income-sources': () => ok(SOURCES),
      'GET /api/transactions': () => ok([INCOME]),
      'PATCH /api/transactions/tx-in/source': (init) => {
        const { source } = bodyOf(init) as { source: string | null };
        sent.push({ source });
        return ok({ ...INCOME, incomeSource: source ?? 'other', incomeSourceManual: source !== null });
      },
    });
    mount();
    await openSheet('ZZ Income');
    await waitFor(() => expect(sourceChip('Salary')).toHaveAttribute('aria-pressed', 'false'));
    expect(screen.queryByRole('button', { name: 'Source: back to auto-detection' })).toBeNull();

    fireEvent.click(sourceChip('Salary'));

    await waitFor(() => expect(sourceChip('Salary')).toHaveAttribute('aria-pressed', 'true'));
    expect(sourceChip('Support')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText(/sources are added and renamed · set manually/)).toBeInTheDocument();
    expect(sent).toEqual([{ source: 'salary' }]);

    fireEvent.click(screen.getByRole('button', { name: 'Source: back to auto-detection' }));

    await waitFor(() => expect(sent).toEqual([{ source: 'salary' }, { source: null }]));
    await waitFor(() => expect(sourceChip('Salary')).toHaveAttribute('aria-pressed', 'false'));
    expect(screen.getByText(/sources are added and renamed · auto-detected/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Source: back to auto-detection' })).toBeNull();
  });

  it('keeps the row and the sheet, and re-enables the chips, when the write is refused', async () => {
    mockFetch({
      ...TX_ROUTES,
      'GET /api/income-sources': () => ok(SOURCES),
      'GET /api/transactions': () => ok([INCOME]),
      'PATCH /api/transactions/tx-in/source': () =>
        fail(500, { error: 'the income source could not be saved' }),
    });
    mount();
    await openSheet('ZZ Income');
    await waitFor(() => expect(sourceChip('Salary')).toBeInTheDocument());

    fireEvent.click(sourceChip('Salary'));

    expect(await screen.findByText(/the income source could not be saved/)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(sourceChip('Salary')).toHaveAttribute('aria-pressed', 'false');
    expect(sourceChip('Salary')).toBeEnabled();
    expect(screen.queryByText(/· set manually/)).toBeNull();
  });
});

describe('the transfer rule', () => {
  it('creates one from the row, re-reads the rules and the list, and closes the sheet', async () => {
    const sent: unknown[] = [];
    mockFetch({
      ...TX_ROUTES,
      'GET /api/transactions': () => ok([EXPENSE]),
      'POST /api/transfer-rules': (init) => {
        sent.push(bodyOf(init));
        return ok({ rule: RULE, matches: 1 });
      },
    });
    mount();
    await openSheet('REWE Berlin');
    expect(ruleSwitch()).not.toBeChecked();

    fireEvent.click(ruleSwitch());

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(sent).toEqual([{ txId: 'tx-1' }]);
    // the row is still there: the sheet closed, the list did not empty
    expect(screen.getByText('REWE Berlin')).toBeInTheDocument();
    expect(requests().filter((r) => r === 'GET /api/transfer-rules')).toHaveLength(2);
    expect(requests().filter((r) => r === 'GET /api/transactions')).toHaveLength(2);
  });

  it('deletes the rule the row already has', async () => {
    mockFetch({
      ...TX_ROUTES,
      'GET /api/transfer-rules': () => ok([RULE]),
      'GET /api/transactions': () => ok([EXPENSE]),
      'DELETE /api/transfer-rules/7': () => ok({ deleted: true }),
    });
    mount();
    await openSheet('REWE Berlin');
    await waitFor(() => expect(ruleSwitch()).toBeChecked());
    expect(screen.getByText('Rule on · transactions tagged: 3')).toBeInTheDocument();

    fireEvent.click(ruleSwitch());

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(requests()).toContain('DELETE /api/transfer-rules/7');
    expect(requests()).not.toContain('POST /api/transfer-rules');
    expect(screen.getByText('REWE Berlin')).toBeInTheDocument();
  });

  it('keeps the row and the sheet, and re-enables the switch, when the rule is refused', async () => {
    mockFetch({
      ...TX_ROUTES,
      'GET /api/transactions': () => ok([EXPENSE]),
      'POST /api/transfer-rules': () => fail(500, { error: 'the rule could not be saved' }),
    });
    mount();
    await openSheet('REWE Berlin');

    fireEvent.click(ruleSwitch());

    expect(await screen.findByText(/Error: the rule could not be saved/)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // the list row and the sheet's own heading: neither emptied nor closed
    expect(screen.getAllByText('REWE Berlin')).toHaveLength(2);
    expect(screen.queryByText('transfer')).toBeNull();
    expect(ruleSwitch()).not.toBeChecked();
    expect(ruleSwitch()).toBeEnabled();
    expect(requests().filter((r) => r === 'GET /api/transactions')).toHaveLength(1);
  });
});

describe('while a write is in flight', () => {
  it('disables every switch and chip in the sheet, and frees them when it lands', async () => {
    let release: (r: Response) => void = () => {};
    mockFetch({
      ...TX_ROUTES,
      'GET /api/transactions': () => ok([EXPENSE]),
      'PATCH /api/transactions/tx-1/transfer': () =>
        new Promise<Response>((resolve) => (release = resolve)),
    });
    mount();
    await openSheet('REWE Berlin');
    const foodChip = () => screen.getByRole('button', { name: 'Food, this transaction only' });
    expect(transferSwitch()).toBeEnabled();

    fireEvent.click(transferSwitch());

    expect(transferSwitch()).toBeDisabled();
    expect(ruleSwitch()).toBeDisabled();
    expect(oneOffSwitch()).toBeDisabled();
    expect(foodChip()).toBeDisabled();

    // "not a transfer, by hand": the row keeps every switch it had
    release(ok({ ...EXPENSE, transfer: false, transferManual: false }));

    await waitFor(() => expect(transferSwitch()).toBeEnabled());
    expect(ruleSwitch()).toBeEnabled();
    expect(oneOffSwitch()).toBeEnabled();
    expect(foodChip()).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Back to auto-detection' })).toBeEnabled();
  });
});
