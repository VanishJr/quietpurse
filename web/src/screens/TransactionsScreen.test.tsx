import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { ACCOUNTS, day, INCOME_SOURCES, txDate } from '../test/fixtures';
import { fail, mockFetch, ok, renderThemed, requests, requestUrls, Routes } from '../test/harness';
import { IncomeSourceDef, Transaction, CategoryRulePreview, TransferRulePreview, TransferRuleWithMatches } from '../types';
import { TransactionsScreen } from './TransactionsScreen';
import { setUrl } from '../url';

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
    date: txDate('2026-07-14'),
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
    date: txDate('2026-07-15'),
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

const TX_ROUTES: Routes = {
  'GET /api/accounts': () => ok(ACCOUNTS),
  'GET /api/income-sources': () => ok(INCOME_SOURCES),
  'GET /api/transactions': () => ok(ROWS),
};

const mount = () => renderThemed(<TransactionsScreen />);

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const chooseFilter = (label: string, value: string) =>
  fireEvent.change(screen.getByRole('combobox', { name: label }), { target: { value } });
/** The list's titles in the order they are on screen; the sheet's heading is not a row. */
const titles = (): string[] =>
  Array.from(document.querySelectorAll('.row .row-title')).map((el) => el.textContent ?? '');

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
  date: txDate('2026-07-14'),
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

describe('the transactions list', () => {
  it('announces initial and filtered loads without showing old rows or claiming empty data', async () => {
    let resolve!: (response: Response) => void;
    mockFetch({ ...TX_ROUTES, 'GET /api/transactions': () => new Promise<Response>((done) => { resolve = done; }) });
    mount();
    expect(screen.getByRole('status')).toHaveTextContent('Loading transactions…');
    expect(screen.queryByText(EMPTY)).toBeNull();
    await act(async () => resolve(ok(ROWS)));
    await screen.findByText('REWE Berlin');
    expect(screen.queryByText('Loading transactions…')).toBeNull();
    chooseFilter('Category', 'food');
    expect(screen.getByRole('status')).toHaveTextContent('Loading transactions…');
    expect(titles()).toEqual([]);
    expect(screen.queryByText(EMPTY)).toBeNull();
    await act(async () => resolve(fail(503, { error: 'Filtered read refused' })));
    expect(await screen.findByRole('alert')).toHaveTextContent('Filtered read refused');
    expect(screen.queryByText('Loading transactions…')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry transactions' }));
    expect(screen.getByRole('status')).toHaveTextContent('Loading transactions…');
    await act(async () => resolve(ok([])));
    expect(await screen.findByText(EMPTY)).toBeInTheDocument();
  });

  it('keeps signed refunds and transfers neutral while identifying ordinary income independently', async () => {
    mockFetch({ ...TX_ROUTES, 'GET /api/transactions': () => ok([
      row({ id: 'income', description: 'Pay', amount: 1250 }),
      row({ id: 'refund', description: 'Returned purchase', amount: 42.5, refund: true }),
      row({ id: 'transfer', description: 'Own transfer', amount: 200, transfer: true }),
    ]) });
    mount();
    const income = await screen.findByRole('button', { name: /Pay/ });
    const refund = screen.getByRole('button', { name: /Returned purchase/ });
    const transfer = screen.getByRole('button', { name: /Own transfer/ });
    expect(income.querySelector('.row-value')).toHaveClass('transaction-value--income');
    expect(refund.querySelector('.row-value')).not.toHaveClass('transaction-value--income');
    expect(transfer.querySelector('.row-value')).not.toHaveClass('transaction-value--income');
    expect(refund).toHaveTextContent('refund');
    expect(refund).toHaveTextContent('+42.50 EUR');
    expect(transfer).toHaveTextContent('transfer');
    expect(transfer).toHaveTextContent('+200 EUR');
  });

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

  it('colours the dot of a row whose category is a prototype key like any unknown one', async () => {
    mockFetch({
      ...TX_ROUTES,
      'GET /api/transactions': () => ok([row({ id: 'tx-proto', description: 'Proto row', category: '__proto__' })]),
    });
    mount();
    await screen.findByText('Proto row');
    // a plain lookup answers Object.prototype here, and React paints that as no colour
    expect(document.querySelector<HTMLElement>('.row .dot')?.style.background).toBeTruthy();
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

    chooseFilter('Category', 'food');

    expect(await screen.findByText(/the transaction store is unreachable/)).toBeInTheDocument();
    // rows kept from before a refused reload sit under a filter they were never an
    // answer to: all-categories rows under "Food"
    expect(screen.queryByText('REWE Berlin')).not.toBeInTheDocument();
    expect(screen.queryByText('BVG Ticket')).not.toBeInTheDocument();
    expect(screen.queryByText(EMPTY)).not.toBeInTheDocument();
  });
});

describe('the window the screen asks for', () => {
  it('does not repeat the selected account beside its selector', async () => {
    mockFetch(TX_ROUTES);
    mount();
    await screen.findByRole('option', { name: ACCOUNTS[0].name });
    chooseFilter('Account', ACCOUNTS[0].id);
    expect(screen.getByRole('combobox', { name: 'Account' })).not.toHaveAttribute('aria-describedby');
    expect(document.querySelector('.transaction-filter .native-field__help')).toBeNull();
  });

  it('keeps the existing choices and sends each selected filter to the API', async () => {
    mockFetch(TX_ROUTES);
    mount();
    await screen.findByText('REWE Berlin');

    expect(screen.getByRole('combobox', { name: 'Period' })).toHaveValue('30d');
    expect(screen.getByRole('combobox', { name: 'Account' })).toHaveValue('all');
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveValue('all');
    expect(within(screen.getByRole('combobox', { name: 'Period' })).getAllByRole('option'))
      .toHaveLength(4);

    const latestQuery = () => new URL(
      requestUrls().filter((url) => url.startsWith('GET /api/transactions?')).at(-1)!.slice(4),
      'http://localhost',
    ).searchParams;

    chooseFilter('Period', '7d');
    await settle();
    expect(latestQuery().has('from')).toBe(true);
    expect(latestQuery().has('to')).toBe(true);
    expect(latestQuery().has('limit')).toBe(false);

    chooseFilter('Account', 'acc-1');
    await settle();
    expect(latestQuery().get('accountId')).toBe('acc-1');

    chooseFilter('Category', 'food');
    await settle();
    expect(latestQuery().get('category')).toBe('food');
  });

  it('opens unbounded when the Overview sends the reader here', async () => {
    mockFetch(TX_ROUTES);
    renderThemed(<TransactionsScreen focus={{ accountId: 'acc-1', nonce: 1 }} />);

    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Period' })).toHaveValue('all'),
    );
    expect(screen.getByRole('combobox', { name: 'Account' })).toHaveValue('acc-1');
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveValue('all');
    await settle();

    // "All transactions →" is what sent the reader here, so the request behind it
    // carries no lower bound - and the raise the backend's default 1000 needs
    const asked = requestUrls().filter((u) => u.includes('/api/transactions'));
    expect(asked[asked.length - 1]).not.toMatch(/[?&]from=/);
    expect(asked[asked.length - 1]).toMatch(/[?&]limit=5000/);
  });
});

describe('the account a row belongs to', () => {
  it('shows a hidden account when it is the active filter', async () => {
    mockFetch(TX_ROUTES);
    renderThemed(<TransactionsScreen focus={{ accountId: 'acc-2', nonce: 1 }} />);

    expect(await screen.findByRole('option', { name: 'Old DKB' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Account' })).toHaveValue('acc-2');
    const asked = requestUrls().filter((url) => url.startsWith('GET /api/transactions?'));
    expect(asked.at(-1)).toMatch(/[?&]accountId=acc-2/);

    chooseFilter('Account', 'all');
    expect(screen.queryByRole('option', { name: 'Old DKB' })).toBeNull();
  });

  it('names it in every row, and stops once the Account filter names one', async () => {
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

    chooseFilter('Account', 'acc-1');
    await settle();

    // a column with one value in it is not a column, and the filter states that value
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

  it('drops a row that stopped answering the category filter', async () => {
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
    chooseFilter('Category', 'food');
    await settle();

    fireEvent.click(screen.getByText('REWE Berlin'));
    fireEvent.click(screen.getByRole('button', { name: 'Transport, this transaction only' }));
    await settle();

    expect(screen.getAllByText('REWE Berlin')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'REWE Berlin' })).toBeInTheDocument();
    expect(screen.getByText('Edeka Mitte')).toBeInTheDocument();
    expect(screen.queryByText(EMPTY)).not.toBeInTheDocument();

  });

  it('keeps the card open to apply the new category to similar transactions under an old category filter', async () => {
    const one = row({ id: 'tx-1', description: 'REWE Berlin', category: 'food' });
    mockFetch({
      ...TX_ROUTES,
      'GET /api/transactions': () => ok([one]),
      'PATCH /api/transactions/tx-1/category': (init) =>
        ok({ ...one, category: JSON.parse(String(init?.body)).category, categoryManual: true }),
    });
    mount();
    await screen.findByText('REWE Berlin');
    chooseFilter('Category', 'food');
    await settle();

    fireEvent.click(screen.getByText('REWE Berlin'));
    fireEvent.click(screen.getByRole('button', { name: 'Transport, this transaction only' }));
    await settle();

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Transport, this transaction only' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Apply to similar transactions' })).toBeEnabled();
    expect(screen.getByText(EMPTY)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Food, this transaction only' }));
    await waitFor(() => expect(screen.queryByText(EMPTY)).toBeNull());
    expect(screen.getAllByText('REWE Berlin')).toHaveLength(2);
  });

  it('puts a row that comes back to the filter where its date belongs, not at the foot', async () => {
    const newest = row({ id: 'tx-new', description: 'Lidl Nord', date: txDate('2026-07-20'), category: 'food' });
    const middle = row({ id: 'tx-mid', description: 'REWE Berlin', date: txDate('2026-07-17'), category: 'food' });
    const oldest = row({ id: 'tx-old', description: 'Edeka Mitte', date: txDate('2026-07-14'), category: 'food' });
    mockFetch({
      ...TX_ROUTES,
      'GET /api/transactions': () => ok([newest, middle, oldest]),
      'PATCH /api/transactions/tx-mid/category': (init) =>
        ok({ ...middle, category: JSON.parse(String(init?.body)).category, categoryManual: true }),
    });
    mount();
    await screen.findByText('REWE Berlin');
    chooseFilter('Category', 'food');
    await settle();

    fireEvent.click(screen.getByText('REWE Berlin'));
    fireEvent.click(screen.getByRole('button', { name: 'Transport, this transaction only' }));
    await waitFor(() => expect(titles()).toEqual(['Lidl Nord', 'Edeka Mitte']));

    // back into the filter between the two that stayed: the list is date DESC and a row
    // spliced back in is not the newest, so neither the foot nor the head is its place
    fireEvent.click(screen.getByRole('button', { name: 'Food, this transaction only' }));
    await waitFor(() => expect(titles()).toEqual(['Lidl Nord', 'REWE Berlin', 'Edeka Mitte']));
  });

  it('leaves the list alone when the category filter moves while the write is in flight', async () => {
    const food = [row({ id: 'tx-1', description: 'REWE Berlin', category: 'food' })];
    // the row the PATCH is moving is in the answer to the reload: a server that
    // forgot the write it had just acknowledged makes a stale drop a no-op, and the
    // case then passes against the stale filter it exists to forbid
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
    chooseFilter('Category', 'food');
    await settle();

    fireEvent.click(screen.getByText('REWE Berlin'));
    fireEvent.click(screen.getByRole('button', { name: 'Transport, this transaction only' }));

    // the filter the handler was created under is not the filter the list now answers
    chooseFilter('Category', 'transport');
    expect(await screen.findByText('BVG Ticket')).toBeInTheDocument();

    release(ok({ ...food[0], category: 'transport', categoryManual: true }));
    await settle();

    expect(screen.getByText('BVG Ticket')).toBeInTheDocument();
    // the sheet is still open on it too, so the description is on screen twice
    expect(screen.getAllByText('REWE Berlin').length).toBeGreaterThan(0);
    expect(screen.queryByText(EMPTY)).not.toBeInTheDocument();
  });
});

const CATEGORY_PREVIEW: CategoryRulePreview = {
  pattern: 'REWE Berlin', transactions: [ROWS[0], { ...ROWS[0], id: 'older', date: txDate('2025-01-01'), accountId: 'acc-2', categoryManual: true }],
  matches: 2, overridden: 1, activeRule: null, otherRules: [], previewToken: 'c'.repeat(64),
};
const CATEGORY_ROUTES: Routes = {
  ...TX_ROUTES,
  'POST /api/category-rules/preview': () => ok(CATEGORY_PREVIEW),
  'GET /api/transactions/tx-1': () => ok(ROWS[0]),
};
const openCategoryPreview = async () => {
  fireEvent.click(await screen.findByText('REWE Berlin'));
  fireEvent.click(screen.getByRole('button', { name: 'Apply to similar transactions' }));
  await screen.findByText('2 transactions match');
};
const applyCategoryRule = () => screen.getByRole('button', { name: 'Apply Food' });

describe('category rules with a preview', () => {
  it('guards unapplied pattern changes even after preview, and an undone edit dismisses directly', async () => {
    mockFetch({ ...CATEGORY_ROUTES, 'POST /api/category-rules/preview': (init) => ok({
      ...CATEGORY_PREVIEW, pattern: JSON.parse(String(init?.body)).pattern,
    }) });
    mount();
    await openCategoryPreview();
    const input = screen.getByRole('textbox', { name: 'Description contains' });
    input.focus();
    fireEvent.change(input, { target: { value: 'REWE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh preview' }));
    await waitFor(() => expect(applyCategoryRule()).not.toHaveAttribute('aria-disabled', 'true'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(input).toHaveFocus();
    expect(input).toHaveValue('REWE');
    fireEvent.change(input, { target: { value: 'REWE Berlin' } });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(requests()).not.toContain('POST /api/category-rules');
  });

  const partialRuleCases = [false, true].flatMap((remove) => [false, true].flatMap((writeSucceeds) =>
    (['escape', 'navigation'] as const).map((leave) => ({ remove, writeSucceeds, leave }))));

  it.each(partialRuleCases)('keeps rule draft truth after remove=$remove, committed=$writeSucceeds, leave=$leave', async ({ remove, writeSucceeds, leave }) => {
    const mutation = remove ? 'DELETE /api/category-rules/7' : 'POST /api/category-rules';
    mockFetch({ ...CATEGORY_ROUTES,
      'POST /api/category-rules/preview': (init) => ok({
        ...CATEGORY_PREVIEW,
        pattern: JSON.parse(String(init?.body)).pattern,
        activeRule: remove ? ruleAnswer('REWE', 2, 1).rule : null,
      }),
      [mutation]: () => writeSucceeds ? ok(remove ? { deleted: true } : ruleAnswer('REWE', 2, 1)) : fail(409, { error: 'rule write refused' }),
      'GET /api/transactions/tx-1': () => fail(500, { error: 'transaction refresh failed' }),
    });
    mount();
    await openCategoryPreview();
    const pattern = screen.getByRole('textbox', { name: 'Description contains' });
    fireEvent.change(pattern, { target: { value: 'REWE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh preview' }));
    await waitFor(() => expect(applyCategoryRule()).not.toHaveAttribute('aria-disabled', 'true'));
    fireEvent.click(remove ? screen.getByRole('button', { name: 'Remove category rule' }) : applyCategoryRule());
    const error = await screen.findByRole('alert');
    expect(error).toHaveTextContent(writeSucceeds ? 'Could not refresh the transaction: transaction refresh failed' : 'rule write refused');
    expect(pattern).toHaveValue('REWE');
    expect(requests().filter((request) => request === mutation)).toHaveLength(1);
    expect(requests().includes('GET /api/transactions/tx-1')).toBe(writeSucceeds);
    const before = window.location.href;
    const requestLeave = () => {
      if (leave === 'escape') fireEvent.keyDown(document, { key: 'Escape' });
      else act(() => setUrl({ screen: 'settings' }));
    };
    requestLeave();
    if (writeSucceeds) {
      expect(screen.queryByRole('button', { name: 'Discard changes' })).not.toBeInTheDocument();
      if (leave === 'escape') expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      else expect(window.location.search).toContain('screen=settings');
    } else {
      expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus();
      expect(window.location.href).toBe(before);
      fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
      expect(pattern).toHaveValue('REWE');
      expect(screen.getByRole('alert')).toHaveTextContent('rule write refused');
      requestLeave();
      fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    }
    expect(requests().filter((request) => request === mutation)).toHaveLength(1);
  });

  it('marks an edited rule committed before a failed transaction refresh, without offering to discard the saved rule', async () => {
    mockFetch({ ...CATEGORY_ROUTES,
      'POST /api/category-rules/preview': (init) => ok({ ...CATEGORY_PREVIEW, pattern: JSON.parse(String(init?.body)).pattern }),
      'POST /api/category-rules': () => ok(ruleAnswer('REWE', 2, 1)),
      'GET /api/transactions/tx-1': () => fail(500, { error: 'transaction refresh failed' }),
    });
    mount();
    await openCategoryPreview();
    fireEvent.change(screen.getByRole('textbox', { name: 'Description contains' }), { target: { value: 'REWE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh preview' }));
    await waitFor(() => expect(applyCategoryRule()).not.toHaveAttribute('aria-disabled', 'true'));
    fireEvent.click(applyCategoryRule());
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not refresh the transaction: transaction refresh failed');
    expect(screen.getByRole('alert')).toHaveTextContent('The rule sets Food');
    expect(requests().filter((request) => request === 'POST /api/category-rules')).toHaveLength(1);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('Discard unsaved changes?')).not.toBeInTheDocument();
    expect(requests().some((request) => request.startsWith('DELETE'))).toBe(false);
  });

  it('protects edited pattern navigation and Back without changing immediate transaction controls', async () => {
    mockFetch(CATEGORY_ROUTES);
    mount();
    await openCategoryPreview();
    const input = screen.getByRole('textbox', { name: 'Description contains' });
    input.focus();
    fireEvent.change(input, { target: { value: 'REWE broad' } });
    const before = window.location.href;
    act(() => setUrl({ screen: 'settings' }));
    expect(window.location.href).toBe(before);
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(input).toHaveValue('REWE broad');
    fireEvent.click(screen.getByRole('button', { name: 'Back to transaction' }));
    expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply to similar transactions' })).toHaveFocus());
    expect(screen.queryByRole('textbox', { name: 'Description contains' })).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(requests()).not.toContain('POST /api/category-rules');
  });

  it('carries the category just selected in the card through viewing an existing rule and refreshing', async () => {
    const sent: unknown[] = [];
    const oldRule = ruleAnswer('REWE', 2, 1).rule;
    mockFetch({ ...CATEGORY_ROUTES,
      'PATCH /api/transactions/tx-1/category': () => ok({ ...ROWS[0], category: 'support', categoryManual: true }),
      'POST /api/category-rules/preview': (init) => ok({
        ...CATEGORY_PREVIEW,
        pattern: JSON.parse(String(init?.body)).pattern,
        activeRule: JSON.parse(String(init?.body)).pattern === 'REWE' ? oldRule : null,
        otherRules: JSON.parse(String(init?.body)).pattern === 'REWE' ? [] : [oldRule],
      }),
      'POST /api/category-rules': (init) => {
        sent.push(JSON.parse(String(init?.body)));
        return ok({ ...ruleAnswer('REWE', 2, 1), rule: { ...oldRule, category: 'support' } });
      },
      'GET /api/transactions/tx-1': () => ok({ ...ROWS[0], category: 'support', categoryManual: true }),
    });
    mount();
    fireEvent.click(await screen.findByText('REWE Berlin'));
    fireEvent.click(screen.getByRole('button', { name: 'Support, this transaction only' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Support, this transaction only' })).toHaveAttribute('aria-pressed', 'true'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply to similar transactions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'View rule: REWE → Food' }));
    expect(await screen.findByText('Active rule: Food.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh preview' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply Support' })).not.toHaveAttribute('aria-disabled', 'true'));
    expect(within(screen.getByRole('dialog')).queryByRole('combobox')).toBeNull();
    expect(sent).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Apply Support' }));
    await screen.findByRole('dialog', { name: 'Transaction' });
    expect(sent).toEqual([{ pattern: 'REWE', category: 'support', previewToken: CATEGORY_PREVIEW.previewToken }]);
  });

  it('shows the full server group and manual exceptions, then applies only after confirmation', async () => {
    const sent: unknown[] = [];
    mockFetch({ ...CATEGORY_ROUTES, 'POST /api/category-rules': (init) => {
      sent.push(JSON.parse(String(init?.body)));
      return ok({ ...ruleAnswer('REWE Berlin', 2, 1), rule: { ...ruleAnswer('REWE Berlin', 2, 1).rule, category: 'food' } });
    } });
    mount();
    await openCategoryPreview();
    expect(screen.getByText('All accounts · All dates')).toBeInTheDocument();
    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText(/01.01.2025/)).toHaveTextContent('Old DKB');
    expect(screen.getByText('1 transaction keeps its manually assigned category.')).toBeInTheDocument();
    expect(applyCategoryRule()).not.toHaveAttribute('aria-disabled', 'true');
    expect(within(screen.getByRole('dialog')).queryByRole('combobox')).toBeNull();
    expect(sent).toEqual([]);
    fireEvent.click(applyCategoryRule());
    expect(await screen.findByRole('dialog', { name: 'Transaction' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Food, this transaction only' })).toHaveAttribute('aria-pressed', 'true');
    expect(sent).toEqual([{ pattern: 'REWE Berlin', category: 'food', previewToken: CATEGORY_PREVIEW.previewToken }]);
    expect(screen.getByRole('status')).toHaveTextContent('1 of them keeps a category you set by hand');
  });

  it('requires a new preview after editing the pattern and submits that preview token', async () => {
    const sent: unknown[] = [];
    mockFetch({ ...CATEGORY_ROUTES,
      'POST /api/category-rules/preview': (init) => ok({ ...CATEGORY_PREVIEW, pattern: JSON.parse(String(init?.body)).pattern, previewToken: 'd'.repeat(64) }),
      'POST /api/category-rules': (init) => { sent.push(JSON.parse(String(init?.body))); return ok(ruleAnswer('REWE', 2, 1)); },
    });
    mount();
    await openCategoryPreview();
    fireEvent.change(screen.getByLabelText('Description contains'), { target: { value: 'REWE' } });
    expect(applyCategoryRule()).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(applyCategoryRule());
    expect(sent).toEqual([]);
    expect(screen.queryByRole('list')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh preview' }));
    await waitFor(() => expect(applyCategoryRule()).not.toHaveAttribute('aria-disabled', 'true'));
    fireEvent.click(applyCategoryRule());
    await screen.findByRole('dialog', { name: 'Transaction' });
    expect(sent).toEqual([{ pattern: 'REWE', category: 'food', previewToken: 'd'.repeat(64) }]);
  });

  it('opens an existing broader rule for removal and returns to the refreshed transaction', async () => {
    const activeRule = ruleAnswer('REWE', 2, 1).rule;
    mockFetch({ ...CATEGORY_ROUTES,
      'POST /api/category-rules/preview': (init) => ok(JSON.parse(String(init?.body)).pattern === 'REWE'
        ? { ...CATEGORY_PREVIEW, pattern: 'REWE', activeRule }
        : { ...CATEGORY_PREVIEW, otherRules: [activeRule] }),
      'DELETE /api/category-rules/7': () => ok({ deleted: true }),
    });
    mount();
    await openCategoryPreview();
    fireEvent.click(screen.getByRole('button', { name: 'View rule: REWE → Food' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove category rule' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Category rule removed'));
    expect(requests()).toContain('DELETE /api/category-rules/7');
    expect(requests()).not.toContain('POST /api/category-rules');
    expect(screen.getByRole('dialog', { name: 'Transaction' })).toBeInTheDocument();
  });

  it('requires a refresh after a stale preview and preserves the chosen category', async () => {
    mockFetch({ ...CATEGORY_ROUTES, 'POST /api/category-rules': () => fail(409, { error: 'Refresh the preview before applying the rule.' }) });
    mount();
    await openCategoryPreview();
    fireEvent.click(applyCategoryRule());
    expect(await screen.findByRole('alert')).toHaveTextContent('Refresh the preview');
    expect(applyCategoryRule()).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(applyCategoryRule());
    expect(requests().filter((request) => request === 'POST /api/category-rules')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh preview' }));
    await waitFor(() => expect(applyCategoryRule()).not.toHaveAttribute('aria-disabled', 'true'));
    expect(applyCategoryRule()).toHaveTextContent('Apply Food');
  });

  it('backs out without a write and restores focus to category rules', async () => {
    mockFetch(CATEGORY_ROUTES);
    mount();
    await openCategoryPreview();
    fireEvent.click(screen.getByRole('button', { name: 'Back to transaction' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply to similar transactions' })).toHaveFocus());
    expect(requests()).not.toContain('POST /api/category-rules');
  });

  it('uses the clean title for the initial pattern', async () => {
    const sent: unknown[] = [];
    mockFetch({ ...CATEGORY_ROUTES,
      'GET /api/transactions': () => ok([{ ...ROWS[0], description: 'REWE Berlin Wertstellung 14.07.2026', displayDescription: 'REWE Berlin' }]),
      'POST /api/category-rules/preview': (init) => { sent.push(JSON.parse(String(init?.body))); return ok(CATEGORY_PREVIEW); },
    });
    mount();
    await openCategoryPreview();
    expect(sent).toEqual([{ pattern: 'REWE Berlin' }]);
  });

  it('keeps the dialog open and disables editing while saving', async () => {
    let release: (response: Response) => void = () => {};
    mockFetch({ ...CATEGORY_ROUTES, 'POST /api/category-rules': () => new Promise<Response>((resolve) => { release = resolve; }) });
    mount();
    await openCategoryPreview();
    applyCategoryRule().focus();
    expect(applyCategoryRule().closest('.sheet-footer')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Back to transaction' }).closest('.sheet-footer')).not.toBeNull();
    fireEvent.click(applyCategoryRule());
    expect(applyCategoryRule()).toHaveFocus();
    expect(applyCategoryRule()).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(applyCategoryRule());
    expect(screen.getByRole('status')).toHaveTextContent('Saving category rule…');
    expect(screen.getByLabelText('Description contains')).toHaveAttribute('readonly');
    expect(screen.getByLabelText('Description contains')).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Description contains'), { target: { value: 'Must not change' } });
    expect(screen.getByLabelText('Description contains')).toHaveValue('REWE Berlin');
    expect(screen.getByRole('button', { name: 'Back to transaction' })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'Apply category' })).toBeInTheDocument();
    release(ok(ruleAnswer('REWE Berlin', 2, 1)));
    await screen.findByRole('dialog', { name: 'Transaction' });
    expect(requests().filter((r) => r === 'POST /api/category-rules')).toHaveLength(1);
  });

  it('re-reads under the filter the list answers when the rule lands, not the one it was applied under', async () => {
    let release: (response: Response) => void = () => {};
    mockFetch({ ...CATEGORY_ROUTES, 'POST /api/category-rules': () => new Promise<Response>((resolve) => { release = resolve; }) });
    mount();
    await openCategoryPreview();
    fireEvent.click(applyCategoryRule());

    // the filter moves while the write is in flight, and the list re-reads for it
    chooseFilter('Category', 'food');
    await settle();

    release(ok(ruleAnswer('REWE Berlin', 2, 1)));
    await settle();
    await settle();

    // the third read is the rule's, and it carries the filter as of the settle: read
    // off the URL, because the rows alone are the same under either filter
    const lists = requestUrls().filter((url) => url.startsWith('GET /api/transactions?'));
    expect(lists).toHaveLength(3);
    expect(lists[2]).toContain('category=food');
  });
});

const EXPENSE = row({ id: 'tx-1', description: 'REWE Berlin', amount: -42.5, category: 'food' });
const INCOME = row({
  id: 'tx-in',
  description: 'ZZ Income',
  amount: 100,
  category: 'other',
  incomeSource: 'other',
  incomeSourceManual: false,
});

const SOURCES: IncomeSourceDef[] = [
  { id: 'salary', label: 'Salary', kind: 'own', patterns: [], sort: 0, builtin: true },
  { id: 'family', label: 'Support', kind: 'external', patterns: [], sort: 1, builtin: true },
];

const RULE: TransferRuleWithMatches = {
  id: 7,
  description: 'REWE Berlin',
  accountId: 'acc-1',
  matchMode: 'exact',
  createdAt: '2026-07-20T10:00:00.000Z',
  matches: 3,
};

const transferSwitch = () => screen.getByRole('checkbox', { name: /Transfer between own accounts/ });
const ruleButton = () => screen.getByRole('button', { name: 'Manage transfer rules' });
const oneOffSwitch = () => screen.getByRole('checkbox', { name: /One-off large purchase/ });
/** Inside the sheet: the category filter above the list carries an option of the same name. */
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
    expect(transferSwitch()).not.toBeChecked();
    expect(screen.queryByText(/Counted as neither income nor expense/)).toBeNull();

    fireEvent.click(transferSwitch());

    expect(await screen.findAllByText('transfer')).toHaveLength(2);
    expect(transferSwitch()).toBeChecked();
    expect(sent).toEqual([{ transfer: true }]);

    fireEvent.click(screen.getByRole('button', { name: 'Back to auto-detection' }));

    await waitFor(() => expect(sent).toEqual([{ transfer: true }, { transfer: null }]));
    await waitFor(() => expect(transferSwitch()).not.toBeChecked());
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

    expect(await screen.findAllByText('one-off')).toHaveLength(2);
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
    expect(screen.getAllByText('one-off')).toHaveLength(2);
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
  it('assigns Support through the category picker and explains its external-income treatment', async () => {
    const sent: unknown[] = [];
    mockFetch({
      ...TX_ROUTES,
      'GET /api/income-sources': () => ok(SOURCES),
      'GET /api/transactions': () => ok([INCOME]),
      'PATCH /api/transactions/tx-in/category': (init) => {
        sent.push(bodyOf(init));
        return ok({ ...INCOME, category: 'support', categoryManual: true, incomeSource: 'category:support' });
      },
    });
    mount();
    await openSheet('ZZ Income');
    fireEvent.click(screen.getByRole('button', { name: 'Support, this transaction only' }));
    expect(await screen.findByText('Support counts as income, but not as earnings for income-based goals.')).toBeInTheDocument();
    expect(sent).toEqual([{ category: 'support' }]);
    expect(screen.getByRole('button', { name: 'Support, this transaction only' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(screen.getByRole('dialog')).queryByRole('button', { name: 'Salary' })).toBeNull();
    expect(requests().some((request) => request.endsWith('/source'))).toBe(false);
  });

  it('re-reads the list after a Support pick, which can un-pair a transfer on another account', async () => {
    // an inferred pair: the incoming leg here, the outgoing one on the other account
    const incoming = { ...INCOME, category: 'transfers', transfer: true };
    const partner = row({
      id: 'tx-out',
      accountId: 'acc-2',
      description: 'To ZZ',
      amount: -100,
      date: txDate('2026-07-13'),
      category: 'transfers',
      transfer: true,
    });
    const afterwards = [
      { ...INCOME, category: 'support', categoryManual: true, incomeSource: 'category:support' },
      { ...partner, category: 'other', transfer: false },
    ];
    let reads = 0;
    mockFetch({
      ...TX_ROUTES,
      'GET /api/income-sources': () => ok(SOURCES),
      'GET /api/transactions': () => ok(++reads === 1 ? [incoming, partner] : afterwards),
      'PATCH /api/transactions/tx-in/category': () => ok(afterwards[0]),
    });
    mount();
    await openSheet('ZZ Income');
    expect(screen.getByText('To ZZ')).toHaveClass('muted-strike');

    fireEvent.click(screen.getByRole('button', { name: 'Support, this transaction only' }));

    // the server recomputed the pairs, so the partner leg is read again rather than kept
    await waitFor(() => expect(screen.getByText('To ZZ')).not.toHaveClass('muted-strike'));
    expect(requests().filter((r) => r === 'GET /api/transactions')).toHaveLength(2);
    // and the detail stays open on the updated row
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Support, this transaction only' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('restores direct-entry focus to the section after a Support refresh replaces the opener', async () => {
    const updated = { ...INCOME, category: 'support', categoryManual: true, incomeSource: 'category:support' };
    let reads = 0;
    let releaseRead!: (response: Response) => void;
    const reload = new Promise<Response>((resolve) => { releaseRead = resolve; });
    mockFetch({
      ...TX_ROUTES,
      'GET /api/transactions': () => ++reads === 1 ? ok([INCOME]) : reload,
      'PATCH /api/transactions/tx-in/category': () => ok(updated),
    });
    renderThemed(<div className="screen"><TransactionsScreen /></div>);
    const heading = screen.getByRole('heading', { name: 'Transactions' });
    const opener = (await screen.findByText('ZZ Income')).closest<HTMLButtonElement>('button')!;
    expect(heading).toHaveAttribute('tabindex', '-1');
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('button', { name: 'Support, this transaction only' }));
    await waitFor(() => expect(reads).toBe(2));
    expect(opener).not.toBeInTheDocument();
    await act(async () => { releaseRead(ok([updated])); });
    await waitFor(() => expect(screen.getByRole('button', { name: /^Close$/ })).not.toHaveAttribute('aria-disabled', 'true'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(heading).toHaveFocus();
  });

  it('re-reads the list when a row leaves Support, which can pair it with a transfer again', async () => {
    // a hand-marked Support row broke its inferred pair: both legs unstruck for now
    const marked = { ...INCOME, category: 'support', categoryManual: true, incomeSource: 'category:support' };
    const partner = row({
      id: 'tx-out',
      accountId: 'acc-2',
      description: 'To ZZ',
      amount: -100,
      date: txDate('2026-07-13'),
      category: 'other',
      transfer: false,
    });
    const afterwards = [
      { ...INCOME, category: 'transfers', transfer: true },
      { ...partner, category: 'transfers', transfer: true },
    ];
    let reads = 0;
    mockFetch({
      ...TX_ROUTES,
      'GET /api/income-sources': () => ok(SOURCES),
      'GET /api/transactions': () => ok(++reads === 1 ? [marked, partner] : afterwards),
      'PATCH /api/transactions/tx-in/category': () => ok(afterwards[0]),
    });
    mount();
    await openSheet('ZZ Income');
    expect(screen.getByText('To ZZ')).not.toHaveClass('muted-strike');

    fireEvent.click(screen.getByRole('button', { name: 'Category: back to auto-detection' }));

    // the partner leg on the other account is a transfer again, which only a re-read shows
    await waitFor(() => expect(screen.getByText('To ZZ')).toHaveClass('muted-strike'));
    expect(requests().filter((r) => r === 'GET /api/transactions')).toHaveLength(2);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Support, this transaction only' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('re-reads under the filter the list answers when the pick lands, not the one it was made under', async () => {
    let release: (r: Response) => void = () => {};
    mockFetch({
      ...TX_ROUTES,
      'GET /api/income-sources': () => ok(SOURCES),
      'GET /api/transactions': () => ok([INCOME]),
      'PATCH /api/transactions/tx-in/category': () =>
        new Promise<Response>((resolve) => (release = resolve)),
    });
    mount();
    await openSheet('ZZ Income');
    fireEvent.click(screen.getByRole('button', { name: 'Support, this transaction only' }));

    // the filter moves while the write is in flight, and the list re-reads for it
    chooseFilter('Category', 'food');
    await settle();

    release(ok({ ...INCOME, category: 'support', categoryManual: true, incomeSource: 'category:support' }));
    await settle();

    // the third read is the pick's, and it carries the filter as of the settle: read
    // off the URL, because the rows alone are the same under either filter
    const lists = requestUrls().filter((url) => url.startsWith('GET /api/transactions?'));
    expect(lists).toHaveLength(3);
    expect(lists[2]).toContain('category=food');
  });

  it('clears a stale catalog on revision failure and offers a retry', async () => {
    const fromFamily = row({
      id: 'tx-fam',
      description: 'From family',
      amount: 200,
      incomeSource: 'family',
    });
    let sourceReads = 0;
    mockFetch({
      ...TX_ROUTES,
      'GET /api/income-sources': () => {
        sourceReads += 1;
        if (sourceReads === 1) return ok([{ ...SOURCES[1], label: 'Old support' }]);
        if (sourceReads === 2) return fail(500, { error: 'catalog unavailable' });
        return ok([{ ...SOURCES[1], label: 'Fresh support' }]);
      },
      'GET /api/transactions': () => ok([fromFamily]),
    });
    const Host = () => {
      const [revision, setRevision] = useState(0);
      return (
        <>
          <button onClick={() => setRevision((value) => value + 1)}>Reclassify</button>
          <TransactionsScreen dataRevision={revision} />
        </>
      );
    };
    renderThemed(<Host />);

    expect(await screen.findByText('Old support', { selector: '.badge' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Reclassify' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Couldn’t load income sources: catalog unavailable',
    );
    expect(screen.queryByText('Old support')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry income sources' }));
    expect(await screen.findByText('Fresh support', { selector: '.badge' })).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the newer account list when an older read answers last', async () => {
    const cash = { ...ACCOUNTS[0], id: 'acc-3', name: 'Cash' };
    let reads = 0;
    let releaseOld: (response: Response) => void = () => {};
    mockFetch({
      ...TX_ROUTES,
      'GET /api/accounts': () => {
        reads += 1;
        if (reads === 2) return new Promise<Response>((resolve) => { releaseOld = resolve; });
        return ok(reads === 1 ? ACCOUNTS : [...ACCOUNTS, cash]);
      },
    });
    const Host = () => {
      const [revision, setRevision] = useState(0);
      return (
        <>
          <button onClick={() => setRevision((value) => value + 1)}>Accounts changed</button>
          <TransactionsScreen accountsRevision={revision} />
        </>
      );
    };
    renderThemed(<Host />);
    const options = () =>
      Array.from(
        (screen.getByRole('combobox', { name: 'Account' }) as HTMLSelectElement).options,
        (option) => option.text,
      );
    await waitFor(() => expect(options()).toContain('Sparkasse Giro'));

    fireEvent.click(screen.getByRole('button', { name: 'Accounts changed' }));
    fireEvent.click(screen.getByRole('button', { name: 'Accounts changed' }));
    await waitFor(() => expect(options()).toContain('Cash'));
    releaseOld(ok(ACCOUNTS));
    await settle();

    expect(options()).toContain('Cash');
  });

  it('badges outside help with the catalogue’s own word, and reads the derived source as its category', async () => {
    const fromFamily = row({ id: 'tx-fam', description: 'From family', amount: 200, incomeSource: 'family' });
    const derived = row({ id: 'tx-sup', description: 'Support row', amount: 300, category: 'support', incomeSource: 'category:support' });
    mockFetch({
      ...TX_ROUTES,
      'GET /api/income-sources': () => ok([{ ...SOURCES[1], label: 'Mum and Dad' }]),
      'GET /api/transactions': () => ok([fromFamily, derived]),
    });
    mount();

    const family = (await screen.findByText('From family')).closest<HTMLElement>('.row')!;
    await waitFor(() => expect(within(family).getByText('Mum and Dad')).toHaveClass('badge'));
    // the category already says what the derived source is; the badge is the catalogue's
    const support = screen.getByText('Support row').closest<HTMLElement>('.row')!;
    expect(support).toHaveTextContent('· Support');
    expect(within(support).queryByText('category:support')).toBeNull();
    expect(support.querySelector('.badge')).toBeNull();
  });

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
    expect(
      screen.getByText(/Manage income sources in Settings\. Set manually\./),
    ).toBeInTheDocument();
    expect(sent).toEqual([{ source: 'salary' }]);

    fireEvent.click(screen.getByRole('button', { name: 'Source: back to auto-detection' }));

    await waitFor(() => expect(sent).toEqual([{ source: 'salary' }, { source: null }]));
    await waitFor(() => expect(sourceChip('Salary')).toHaveAttribute('aria-pressed', 'false'));
    expect(
      screen.getByText(/Manage income sources in Settings\. Auto-detected\./),
    ).toBeInTheDocument();
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

const PREVIEW: TransferRulePreview = {
  txId: EXPENSE.id,
  accountId: EXPENSE.accountId,
  description: EXPENSE.description,
  transactions: [EXPENSE, { ...EXPENSE, id: 'older', date: txDate('2025-01-01'), transferManual: false }],
  matches: 2,
  manualOverrides: 1,
  activeRule: null,
  previewToken: 'a'.repeat(64),
};

const PREVIEW_ROUTES: Routes = {
  ...TX_ROUTES,
  'GET /api/transactions': () => ok([EXPENSE]),
  'GET /api/transactions/tx-1/transfer-rule-preview': () => ok(PREVIEW),
  'GET /api/transactions/tx-1': () => ok({ ...EXPENSE, transfer: true }),
};

const openPreview = async () => {
  await openSheet('REWE Berlin');
  fireEvent.click(ruleButton());
  await screen.findByText('2 transactions match');
};

const applyRuleButton = () => screen.getByRole('button', { name: 'Apply transfer rule' });

describe('the transfer rule', () => {
  it('previews the server group before any write and keeps the updated transaction open after applying', async () => {
    const sent: unknown[] = [];
    mockFetch({
      ...PREVIEW_ROUTES,
      'POST /api/transfer-rules': (init) => {
        sent.push(bodyOf(init));
        return ok({ rule: { ...RULE, matchMode: 'similar-v1' }, matches: 2 });
      },
    });
    mount();
    await openPreview();

    expect(within(screen.getByRole('list', { name: 'Matching transactions' })).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('1 manual transfer setting will be replaced.')).toBeInTheDocument();
    expect(screen.getByText(/Manually marked as not a transfer/)).toBeInTheDocument();
    expect(screen.getByText(/future matching transactions on this account/)).toBeInTheDocument();
    expect(sent).toEqual([]);
    fireEvent.click(applyRuleButton());

    expect(await screen.findByText('2 transactions marked as transfers.')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Transaction' })).toBeInTheDocument();
    expect(transferSwitch()).toBeChecked();
    expect(sent).toEqual([{ txId: 'tx-1', matchMode: 'similar-v1', previewToken: PREVIEW.previewToken }]);
    expect(requests().filter((r) => r === 'GET /api/transactions')).toHaveLength(2);
  });

  it('keeps the caption on the screen after the sheet that made it has closed', async () => {
    mockFetch({
      ...PREVIEW_ROUTES,
      'POST /api/transfer-rules': () => ok({ rule: { ...RULE, matchMode: 'similar-v1' }, matches: 2 }),
    });
    mount();
    await openPreview();
    fireEvent.click(applyRuleButton());
    expect(await screen.findByText('2 transactions marked as transfers.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // the copy the sheet carried went with it; the one that outlives it is the list's,
    // in the live region above the rows
    const caption = screen.getByText('2 transactions marked as transfers.');
    expect(caption.closest('[role="status"]')).not.toBeNull();
  });

  it('deletes the server-identified rule and preserves independent transfer detection', async () => {
    mockFetch({
      ...PREVIEW_ROUTES,
      'GET /api/transactions/tx-1/transfer-rule-preview': () => ok({ ...PREVIEW, activeRule: RULE }),
      'DELETE /api/transfer-rules/7': () => ok({ deleted: true }),
    });
    mount();
    await openPreview();
    expect(screen.getByText(/existing rule applies only to identical descriptions/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove transfer rule' }));

    expect(await screen.findByText(/Transfer rule removed/)).toBeInTheDocument();
    expect(transferSwitch()).toBeChecked();
    expect(requests()).toContain('DELETE /api/transfer-rules/7');
    expect(requests()).not.toContain('POST /api/transfer-rules');
  });

  it('returns from the preview without writing and restores focus', async () => {
    mockFetch(PREVIEW_ROUTES);
    mount();
    await openPreview();
    fireEvent.click(screen.getByRole('button', { name: 'Back to transaction' }));
    await waitFor(() => expect(ruleButton()).toHaveFocus());
    expect(transferSwitch()).not.toBeChecked();
    expect(requests().some((r) => r.startsWith('POST ') || r.startsWith('DELETE '))).toBe(false);
  });

  it('requires a fresh preview after a refusal and sends the refreshed token on retry', async () => {
    let reads = 0;
    const sent: unknown[] = [];
    mockFetch({
      ...PREVIEW_ROUTES,
      'GET /api/transactions/tx-1/transfer-rule-preview': () => ok({ ...PREVIEW, previewToken: ++reads === 1 ? PREVIEW.previewToken : 'b'.repeat(64) }),
      'POST /api/transfer-rules': (init) => {
        sent.push(bodyOf(init));
        return sent.length === 1
          ? fail(409, { error: 'The matching transactions changed. Refresh the preview before applying the rule.' })
          : ok({ rule: RULE, matches: 2 });
      },
    });
    mount();
    await openPreview();
    fireEvent.click(applyRuleButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('Refresh the preview');
    expect(applyRuleButton()).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(applyRuleButton());
    expect(sent).toHaveLength(1);
    expect(requests().filter((r) => r === 'GET /api/transactions')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh preview' }));
    await waitFor(() => expect(applyRuleButton()).not.toHaveAttribute('aria-disabled', 'true'));
    fireEvent.click(applyRuleButton());
    expect(await screen.findByText('2 transactions marked as transfers.')).toBeInTheDocument();
    expect(sent[1]).toEqual({ txId: 'tx-1', matchMode: 'similar-v1', previewToken: 'b'.repeat(64) });
  });

  it('shows a preview load failure in the dialog and retries it', async () => {
    let reads = 0;
    mockFetch({
      ...PREVIEW_ROUTES,
      'GET /api/transactions/tx-1/transfer-rule-preview': () => ++reads === 1 ? fail(500, { error: 'Preview unavailable' }) : ok(PREVIEW),
    });
    mount();
    await openSheet('REWE Berlin');
    fireEvent.click(ruleButton());
    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent('Preview unavailable');
    expect(screen.queryByRole('button', { name: 'Apply transfer rule' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh preview' }));
    expect(await screen.findByText('2 transactions match')).toBeInTheDocument();
  });

  it('prevents duplicate submissions and dismissal while saving', async () => {
    let release: (response: Response) => void = () => {};
    mockFetch({
      ...PREVIEW_ROUTES,
      'POST /api/transfer-rules': () => new Promise<Response>((resolve) => { release = resolve; }),
    });
    mount();
    await openPreview();
    fireEvent.click(applyRuleButton());
    expect(applyRuleButton()).toHaveAttribute('aria-disabled', 'true');
    expect(applyRuleButton().closest('.sheet-footer')).not.toBeNull();
    fireEvent.click(applyRuleButton());
    expect(screen.getByRole('status')).toHaveTextContent('Saving transfer rule…');
    expect(screen.getByRole('button', { name: 'Back to transaction' })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    release(ok({ rule: RULE, matches: 2 }));
    expect(await screen.findByText('2 transactions marked as transfers.')).toBeInTheDocument();
    expect(requests().filter((r) => r === 'POST /api/transfer-rules')).toHaveLength(1);
  });

  it('re-reads under the filter the list answers when the rule lands, not the one it was applied under', async () => {
    let release: (response: Response) => void = () => {};
    mockFetch({
      ...PREVIEW_ROUTES,
      'POST /api/transfer-rules': () => new Promise<Response>((resolve) => { release = resolve; }),
    });
    mount();
    await openPreview();
    fireEvent.click(applyRuleButton());

    // the filter moves while the write is in flight, and the list re-reads for it
    chooseFilter('Category', 'food');
    await settle();

    release(ok({ rule: { ...RULE, matchMode: 'similar-v1' }, matches: 2 }));
    await settle();
    await settle();

    // the third read is the rule's, and it carries the filter as of the settle: read
    // off the URL, because the rows alone are the same under either filter
    const lists = requestUrls().filter((url) => url.startsWith('GET /api/transactions?'));
    expect(lists).toHaveLength(3);
    expect(lists[2]).toContain('category=food');
  });
});

describe('transaction descriptions', () => {
  it.each(['2026-08-31', '2026-09-01'])('uses the server title and retains the original and value date when booked on %s', async (date) => {
    const original = 'Example Person Gutschriften Wertstellung 31.08.2026';
    const display = 'Example Person Gutschriften';
    mockFetch({
      ...TX_ROUTES,
      'GET /api/transactions': () => ok([{ ...EXPENSE, date: txDate(date), description: original, displayDescription: display, valueDate: day('2026-08-31') }]),
    });
    mount();
    await openSheet(display);
    expect(screen.getByRole('heading', { name: display })).toBeInTheDocument();
    const details = screen.getByText('Original description').closest('details')!;
    expect(details).not.toHaveAttribute('open');
    fireEvent.click(screen.getByText('Original description'));
    expect(details).toHaveAttribute('open');
    expect(within(details).getByText(original)).toBeVisible();
    expect(screen.queryByText(/Value date:/) !== null).toBe(date !== '2026-08-31');
    expect(screen.queryByText(/spread over 12 months/)).toBeNull();
    expect(oneOffSwitch()).toBeInTheDocument();
  });
});

describe('the day a transaction is on', () => {
  it('is the day the bank wrote, in the list and in the sheet', async () => {
    const booked = row({
      id: 'tx-1', description: 'REWE Berlin', category: 'food',
      date: txDate('2026-09-30'), valueDate: day('2026-10-01'),
    });
    mockFetch({ ...TX_ROUTES, 'GET /api/transactions': () => ok([booked]) });
    mount();

    expect((await screen.findByText('REWE Berlin')).closest('.row')).toHaveTextContent('30.09.2026 · Food');
    await openSheet('REWE Berlin');
    const sheet = screen.getByRole('dialog');
    expect(within(sheet).getByText('30.09.2026 · Food')).toBeInTheDocument();
    expect(within(sheet).getByText('Value date: 01.10.2026')).toBeInTheDocument();
  });

  it('is the day the bank wrote in a transfer rule preview', async () => {
    mockFetch(PREVIEW_ROUTES);
    mount();
    await openPreview();

    const matching = screen.getByRole('list', { name: 'Matching transactions' });
    expect(within(matching).getByText('14.07.2026')).toBeInTheDocument();
    expect(within(matching).getByText('01.01.2025')).toBeInTheDocument();
  });
});

describe('while a write is in flight', () => {
  it.each([
    { owner: 'category', route: 'category', role: 'button', name: 'Food, this transaction only', income: false },
    { owner: 'transfer', route: 'transfer', role: 'checkbox', name: 'Transfer between own accounts', income: false },
    { owner: 'one-off', route: 'one-off', role: 'checkbox', name: 'One-off large purchase', income: false },
    { owner: 'income source', route: 'source', role: 'button', name: 'Salary', income: true },
  ] as const)('keeps $owner focus and announces its pending/refusal without duplicate writes', async ({ owner, route, role, name, income }) => {
    let release!: (response: Response) => void;
    mockFetch({ ...TX_ROUTES,
      'GET /api/transactions': () => ok([income ? { ...INCOME, id: 'tx-1' } : EXPENSE]),
      'GET /api/income-sources': () => ok(SOURCES),
      [`PATCH /api/transactions/tx-1/${route}`]: () => new Promise<Response>((resolve) => { release = resolve; }),
    });
    mount();
    await openSheet(income ? INCOME.description : EXPENSE.description);
    const control = await screen.findByRole(role, { name });
    control.focus();
    fireEvent.click(control);
    expect(control).toHaveFocus();
    expect(control).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('status')).toHaveTextContent(`Saving ${owner}…`);
    fireEvent.click(control);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(requests().filter((request) => request === `PATCH /api/transactions/tx-1/${route}`)).toHaveLength(1);
    await act(async () => release(fail(503, { error: `${owner} write refused` })));
    expect(await screen.findByRole('alert')).toHaveTextContent(`${owner} write refused`);
    expect(screen.queryByText(`Saving ${owner}…`)).toBeNull();
    expect(control).toHaveFocus();
    expect(control).not.toHaveAttribute('aria-disabled', 'true');
  });

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

    expect(transferSwitch()).toHaveAttribute('aria-disabled', 'true');
    expect(ruleButton()).toHaveAttribute('aria-disabled', 'true');
    expect(oneOffSwitch()).toHaveAttribute('aria-disabled', 'true');
    expect(foodChip()).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(foodChip());
    fireEvent.click(oneOffSwitch());
    expect(requests().filter((request) => request.startsWith('PATCH'))).toHaveLength(1);

    // "not a transfer, by hand": the row keeps every switch it had
    release(ok({ ...EXPENSE, transfer: false, transferManual: false }));

    await waitFor(() => expect(transferSwitch()).not.toHaveAttribute('aria-disabled', 'true'));
    expect(ruleButton()).not.toHaveAttribute('aria-disabled', 'true');
    expect(oneOffSwitch()).not.toHaveAttribute('aria-disabled', 'true');
    expect(foodChip()).not.toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'Back to auto-detection' })).toBeEnabled();
  });
});
