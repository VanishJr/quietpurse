import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ACCOUNTS, INCOME_SOURCES, TRANSFER_RULES } from '../test/fixtures';
import { fail, mockFetch, ok, renderThemed, requestUrls, Routes } from '../test/harness';
import { Transaction } from '../types';
import { TransactionsScreen } from './TransactionsScreen';

/**
 * Item 16's first site: "No transactions in the selected period." over a period the
 * screen never read. The rows are file-local rather than in fixtures.ts because the
 * descriptions below are asserted on, and a fixture tuned to one file's assertions
 * is how the next row gets a surprise.
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
    transfer: false,
    transferManual: null,
    refund: false,
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
    transfer: false,
    transferManual: null,
    refund: false,
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
 * `categoryManual` is deliberately not defaulted: it is optional on the mirror, so a
 * row that omits it hides the "back to auto-detection" control and every assertion
 * about the two states would then be green by construction. Each case that cares says
 * which state it means.
 */
const row = (patch: Partial<Transaction> & { id: string }): Transaction => ({
  accountId: 'acc-1',
  provider: 'upload',
  amount: -12,
  currency: 'EUR',
  date: '2026-07-14',
  description: 'a row',
  category: 'other',
  transfer: false,
  transferManual: null,
  refund: false,
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
