import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ACCOUNTS, INCOME_SOURCES, TRANSFER_RULES } from '../test/fixtures';
import { fail, mockFetch, ok, renderThemed, Routes } from '../test/harness';
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
