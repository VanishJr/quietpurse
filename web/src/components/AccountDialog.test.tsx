import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { importRecord, importsResponse } from '../test/fixtures';
import { mockFetch, ok, renderThemed, requestUrls, Routes } from '../test/harness';
import { Account } from '../types';
import { AccountDialog } from './AccountDialog';

/**
 * The delete panel, mounted on its own. Reaching its hidden-account branch through
 * OverviewScreen is four interactions and a fixture change, and that branch is the
 * only place `totals.transactions` is ever printed — the precedent for mounting a
 * component directly rather than through its screen is BudgetsBlock.test.tsx.
 *
 * The through-the-screen delete preview stays in OverviewScreen.test.tsx: what is
 * asserted here is which numbers the panel prints, not that the ⋮ opens it.
 */

const ACCOUNT: Account = {
  id: 'acc-1',
  provider: 'upload',
  name: 'Sparkasse Giro',
  currency: 'EUR',
  balance: 1234.5,
};

/**
 * Two rows and totals that could not have come from them. Every number below is
 * therefore evidence about where the panel read it: counting the page gives 2, 1
 * and 24, and the assertions demand 137, 90 and 4021.
 */
const TRUNCATED = importsResponse(
  [importRecord(), importRecord({ id: 'imp-2', documentAvailable: false })],
  { imports: 137, documents: 90, transactions: 4021 },
);

const mount = (account: Account, routes: Routes) => {
  mockFetch(routes);
  return renderThemed(
    <AccountDialog
      kind="delete"
      origin="menu"
      account={account}
      baseCurrency="EUR"
      onStep={vi.fn()}
      onClose={vi.fn()}
      onOpenHistory={vi.fn()}
      onCreated={vi.fn()}
      onUpdated={vi.fn()}
    />,
  );
};

describe('the delete preview', () => {
  it('prints the totals of the whole history, not of the page it was sent', async () => {
    mount(ACCOUNT, {
      'GET /api/imports': () => ok(TRUNCATED),
      'GET /api/transactions': () => ok([]),
    });

    expect(await screen.findByText('137 imports')).toBeInTheDocument();
    expect(screen.getByText('90 uploaded files')).toBeInTheDocument();
    // and the two rows it was sent are not what any of it was counted from
    expect(screen.queryByText('2 imports')).not.toBeInTheDocument();
    expect(screen.queryByText('1 uploaded file')).not.toBeInTheDocument();
  });

  it('asks the server for this account, rather than the workspace it belongs to', async () => {
    mount(ACCOUNT, {
      'GET /api/imports': () => ok(TRUNCATED),
      'GET /api/transactions': () => ok([]),
    });
    await screen.findByText('137 imports');

    expect(requestUrls()).toContain('GET /api/imports?accountId=acc-1');
  });

  /**
   * The transactions endpoint answers nothing for a hidden account, so this branch
   * is the one that has to count from the imports — and it is the only place a
   * total that is larger than the page can be printed as a transaction count.
   */
  it('counts a hidden account from the totals, and says that is what it did', async () => {
    // no GET /api/transactions in the table: asking it for a hidden account would
    // answer 0 for an account with thousands, and the afterEach guard names it
    mount({ ...ACCOUNT, hidden: true }, { 'GET /api/imports': () => ok(TRUNCATED) });

    expect(await screen.findByText('4021 transactions')).toBeInTheDocument();
    expect(screen.getByText(/across its imports/)).toBeInTheDocument();
  });

  /**
   * The caveat this row replaces. It said an import older than the page is not in
   * these numbers; after this change every number is over the whole history, so
   * leaving it would teach the reader to disbelieve the ones that are still true.
   */
  it('no longer warns that older imports are missing from the numbers', async () => {
    mount(ACCOUNT, {
      'GET /api/imports': () => ok(TRUNCATED),
      'GET /api/transactions': () => ok([]),
    });
    await screen.findByText('137 imports');

    expect(screen.queryByText(/an import older than that is not in these numbers/)).toBeNull();
  });
});
