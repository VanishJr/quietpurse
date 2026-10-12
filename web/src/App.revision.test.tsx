import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';
import {
  accountMonths,
  accountSummary,
  importRecord,
  importsResponse,
  PRESETS,
  SAVINGS_GOAL,
  summaryResult,
  txDate,
} from './test/fixtures';
import { askedFor, FIRST_PAINT_ROUTES, mockFetch, ok, requests, requestUrls, type Routes } from './test/harness';
import type { Account, Transaction } from './types';

const giro: Account = {
  id: 'acc-1',
  provider: 'upload',
  name: 'Sparkasse Giro',
  currency: 'EUR',
  balance: -42,
  hidden: false,
};

const cash: Account = { ...giro, id: 'acc-3', name: 'Cash', balance: 0 };

const bakery: Transaction = {
  id: 'bakery-row',
  accountId: 'acc-1',
  provider: 'upload',
  amount: -42,
  currency: 'EUR',
  date: txDate('2026-08-14'),
  description: 'Corner bakery',
  category: 'other',
  categoryManual: false,
  transfer: false,
  transferManual: null,
  refund: false,
  incomeSourceManual: false,
  recurring: false,
  oneOff: false,
};

/** The Overview's reads name an account; the Transactions list on "All accounts" names none. */
const listReads = () =>
  requestUrls().filter(
    (r) =>
      r.startsWith('GET /api/transactions?') &&
      !new URL(r.slice('GET '.length), 'http://localhost').searchParams.has('accountId'),
  ).length;

const goalReads = () => requests().filter((r) => r === 'GET /api/goals').length;
const recurringReads = () => requests().filter((r) => r === 'GET /api/recurring').length;

/** The server holds the bakery row until `gone` says the change removed it from every read. */
const routes = (gone: () => boolean, rest: Routes): Routes => ({
  ...FIRST_PAINT_ROUTES,
  'GET /api/transactions': () => ok(gone() ? [] : [bakery]),
  'GET /api/summary': (_init, url) => ok(accountSummary(askedFor(url))),
  'GET /api/summary/months': (_init, url) => ok(accountMonths(askedFor(url))),
  ...rest,
});

const nav = () => within(screen.getByRole('navigation', { name: 'Sections' }));
const screenOf = (heading: HTMLElement) => heading.closest('.screen') as HTMLElement;

const openTransactions = async () => {
  fireEvent.click(nav().getByRole('link', { name: 'Transactions' }));
  const list = screenOf(screen.getByRole('heading', { name: 'Transactions' }));
  expect(await within(list).findByText('Corner bakery')).toBeVisible();
  return list;
};

const start = async () => {
  render(<App />);
  await screen.findByRole('region', { name: 'Balance of Sparkasse Giro' });
  return openTransactions();
};

const openAccountMenu = async () => {
  fireEvent.click(nav().getByRole('link', { name: 'Overview' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Account menu: Sparkasse Giro' }));
  return within(await screen.findByRole('dialog'));
};

const openSettingsHistory = () => {
  fireEvent.click(nav().getByRole('link', { name: 'Settings' }));
  const settings = screenOf(screen.getByRole('heading', { name: 'Settings' }));
  fireEvent.click(within(settings).getByRole('button', { name: 'Import history' }));
};

const confirmInHistory = async (action: string, confirm: string, notice: string) => {
  const history = screenOf(await screen.findByRole('heading', { name: 'Import history' }));
  fireEvent.click(await within(history).findByRole('button', { name: 'Actions for statement.csv' }));
  fireEvent.click(within(history).getByRole('button', { name: `${action} statement.csv` }));
  const reads = { list: listReads(), goals: goalReads() };
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: confirm }));
  expect(await within(history).findByText(notice)).toBeInTheDocument();
  return reads;
};

const expectReread = async (before: { list: number; goals: number }, list: HTMLElement) => {
  await waitFor(() => {
    expect(listReads()).toBeGreaterThan(before.list);
    expect(goalReads()).toBeGreaterThan(before.goals);
  });
  fireEvent.click(nav().getByRole('link', { name: 'Transactions' }));
  expect(await within(list).findByText('No transactions in the selected period.')).toBeVisible();
  expect(within(list).queryByText('Corner bakery')).not.toBeInTheDocument();
};

const importRoutes = (deleted: () => boolean, onDelete: () => void): Routes => ({
  'GET /api/accounts': () => ok([giro]),
  'GET /api/imports': () =>
    ok(importsResponse(deleted() ? [] : [importRecord({ transactions: 1 })])),
  'DELETE /api/imports/imp-1': () => {
    onDelete();
    return ok({ deleted: true, transactions: 1 });
  },
});

describe('removal data revision', () => {
  it('re-reads every mounted screen when an import is deleted from the Overview', async () => {
    let deleted = false;
    mockFetch(routes(() => deleted, importRoutes(() => deleted, () => { deleted = true; })));
    const list = await start();

    fireEvent.click((await openAccountMenu()).getByRole('button', { name: 'Import history' }));
    const before = await confirmInHistory(
      'Delete import',
      'Delete import',
      'Import deleted — 1 transaction removed.',
    );

    await expectReread(before, list);
  });

  it('re-reads every mounted screen when an import is deleted from Settings', async () => {
    let deleted = false;
    mockFetch(routes(() => deleted, importRoutes(() => deleted, () => { deleted = true; })));
    const list = await start();

    openSettingsHistory();
    const recurring = recurringReads();
    const before = await confirmInHistory(
      'Delete import',
      'Delete import',
      'Import deleted — 1 transaction removed.',
    );

    await waitFor(() => expect(recurringReads()).toBeGreaterThan(recurring));
    await expectReread(before, list);
  });

  it('shows the Overview the balance an import deleted from Settings left behind', async () => {
    let deleted = false;
    mockFetch(routes(() => deleted, {
      ...importRoutes(() => deleted, () => { deleted = true; }),
      'GET /api/accounts': () => ok([{ ...giro, balance: deleted ? 1200 : 1242 }]),
    }));
    await start();
    fireEvent.click(nav().getByRole('link', { name: 'Overview' }));
    expect(
      await screen.findByRole('region', { name: 'Balance of Sparkasse Giro' }),
    ).toHaveTextContent('1,242');

    openSettingsHistory();
    await confirmInHistory('Delete import', 'Delete import', 'Import deleted — 1 transaction removed.');

    fireEvent.click(nav().getByRole('link', { name: 'Overview' }));
    await waitFor(() =>
      expect(
        screen.getByRole('region', { name: 'Balance of Sparkasse Giro' }),
      ).toHaveTextContent('1,200'),
    );
  });

  it('re-reads no other screen when only the stored file is deleted', async () => {
    let removed = false;
    mockFetch(routes(() => false, {
      'GET /api/accounts': () => ok([giro]),
      'GET /api/imports': () =>
        ok(importsResponse([importRecord({ transactions: 1, documentAvailable: !removed })])),
      'DELETE /api/imports/imp-1/document': () => {
        removed = true;
        return ok({ deleted: true, importId: 'imp-1', bytesRemoved: true });
      },
    }));
    const list = await start();

    openSettingsHistory();
    const before = await confirmInHistory(
      'Delete the file for',
      'Delete file',
      'The stored statement was deleted.',
    );
    await act(async () => {});

    expect(listReads()).toBe(before.list);
    expect(goalReads()).toBe(before.goals);
    fireEvent.click(nav().getByRole('link', { name: 'Transactions' }));
    expect(within(list).getByText('Corner bakery')).toBeVisible();
  });

  it('re-reads every mounted screen when an account is deleted', async () => {
    let deleted = false;
    mockFetch(routes(() => deleted, {
      'GET /api/accounts': () => ok(deleted ? [cash] : [giro, cash]),
      'GET /api/imports': () => ok(importsResponse([importRecord({ transactions: 1 })])),
      'DELETE /api/accounts/acc-1': () => {
        deleted = true;
        return ok({ deleted: true, transactions: 1, imports: 1, documents: 1 });
      },
    }));
    const list = await start();

    fireEvent.click((await openAccountMenu()).getByText('Delete'));
    fireEvent.change(await screen.findByLabelText(/to confirm/), {
      target: { value: 'Sparkasse Giro' },
    });
    const before = { list: listReads(), goals: goalReads() };
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
    await screen.findByText(/Sparkasse Giro was deleted/);

    await expectReread(before, list);
  });

  it('re-reads every mounted screen when an account is hidden', async () => {
    let hidden = false;
    mockFetch(routes(() => hidden, {
      'GET /api/accounts': () => ok([{ ...giro, hidden }, cash]),
      'PATCH /api/accounts/acc-1': () => {
        hidden = true;
        return ok({ ...giro, hidden: true });
      },
    }));
    const list = await start();

    fireEvent.click((await openAccountMenu()).getByRole('button', { name: 'Hide' }));
    await screen.findByRole('heading', { name: 'Hide this account?' });
    const before = { list: listReads(), goals: goalReads() };
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Hide' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await expectReread(before, list);
  });

  it('re-reads every mounted screen when a hidden account is unhidden', async () => {
    let hidden = true;
    mockFetch(routes(() => hidden, {
      'GET /api/accounts': () => ok([{ ...giro, hidden }, cash]),
      'PATCH /api/accounts/acc-1': () => {
        hidden = false;
        return ok({ ...giro, hidden: false });
      },
    }));
    render(<App />);
    await screen.findByRole('region', { name: 'Balance of Cash' });
    fireEvent.click(nav().getByRole('link', { name: 'Transactions' }));
    const list = screenOf(screen.getByRole('heading', { name: 'Transactions' }));
    expect(await within(list).findByText('No transactions in the selected period.')).toBeVisible();

    fireEvent.click(nav().getByRole('link', { name: 'Overview' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show 1 hidden account' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sparkasse Giro (hidden)' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Unhide this account' }));
    const goals = goalReads();
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Unhide' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await waitFor(() => expect(goalReads()).toBeGreaterThan(goals));
    fireEvent.click(nav().getByRole('link', { name: 'Transactions' }));
    expect(await within(list).findByText('Corner bakery')).toBeVisible();
  });
});

const accountFilter = async (list: HTMLElement) => {
  fireEvent.click(nav().getByRole('link', { name: 'Transactions' }));
  const select = within(list).getByRole('combobox', { name: 'Account', hidden: true });
  return Array.from((select as HTMLSelectElement).options, (option) => option.text);
};

const chartAccountChoices = async () => {
  fireEvent.click(nav().getByRole('link', { name: 'Analytics' }));
  const analytics = screenOf(screen.getByRole('heading', { name: 'Analytics' }));
  const create = within(analytics).getByRole('button', { name: 'New chart' });
  await waitFor(() => expect(create).toBeEnabled());
  fireEvent.click(create);
  fireEvent.click(await within(analytics).findByRole('button', { name: /^Column/ }));
  const group = await within(analytics).findByRole('group', { name: 'Account' });
  const choices = within(group).getAllByRole('button').map((choice) => choice.textContent);
  fireEvent.click(within(analytics).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(within(analytics).queryByRole('dialog')).not.toBeInTheDocument());
  return choices;
};

const listRoutes = (accounts: () => Account[], rest: Routes = {}): Routes =>
  routes(() => false, {
    'GET /api/accounts': () => ok(accounts()),
    'GET /api/transactions': (_init, url) => ok(askedFor(url) === 'acc-3' ? [] : [bakery]),
    'GET /api/summary/months': (_init, url) =>
      ok(
        askedFor(url)
          ? accountMonths(askedFor(url))
          : { scope: 'all', from: '2026-01-01', to: '2026-12-31', baseCurrency: 'EUR', months: [] },
      ),
    ...rest,
  });

describe('account list revision', () => {
  it('offers an account created on the Overview everywhere, and leaves an open rule editor open', async () => {
    let created = false;
    mockFetch(listRoutes(() => (created ? [giro, cash] : [giro]), {
      'POST /api/accounts': () => {
        created = true;
        return ok(cash);
      },
      'GET /api/transactions/bakery-row/transfer-rule-preview': () =>
        ok({
          txId: bakery.id,
          accountId: bakery.accountId,
          description: bakery.description,
          transactions: [bakery],
          matches: 1,
          manualOverrides: 0,
          activeRule: null,
          previewToken: 'a'.repeat(64),
        }),
    }));
    const list = await start();
    expect(await accountFilter(list)).not.toContain('Cash');
    fireEvent.click(within(list).getByText('Corner bakery'));
    fireEvent.click(screen.getByRole('button', { name: 'Manage transfer rules' }));
    expect(await screen.findByRole('dialog', { name: 'Transfer rules' })).toBeVisible();

    fireEvent.click(nav().getByRole('link', { name: 'Overview' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add account' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Cash' } });
    const before = listReads();
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await screen.findByRole('button', { name: 'Cash' });

    await waitFor(async () => expect(await accountFilter(list)).toContain('Cash'));
    expect(within(list).getByRole('dialog', { name: 'Transfer rules' })).toBeVisible();
    expect(listReads()).toBe(before);
    expect(await chartAccountChoices()).toContain('Cash');
  });

  it('offers an account created in the import panel to Transactions', async () => {
    let created = false;
    mockFetch(listRoutes(() => (created ? [giro, cash] : [giro]), {
      'GET /api/imports/presets': () => ok(PRESETS),
      'POST /api/accounts': () => {
        created = true;
        return ok(cash);
      },
      'POST /api/imports': () => ok(summaryResult({ accountId: 'acc-3', accountName: 'Cash' })),
    }));
    const list = await start();
    expect(await accountFilter(list)).not.toContain('Cash');

    fireEvent.click(nav().getByRole('link', { name: 'Import' }));
    const panel = screenOf(await screen.findByRole('heading', { name: 'Import a statement' }));
    fireEvent.click(await within(panel).findByRole('button', { name: '+ New account' }));
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Account name' }), {
      target: { value: 'Cash' },
    });
    fireEvent.change(panel.querySelector('input[type=file]') as HTMLInputElement, {
      target: { files: [new File(['date;amount\n2026-08-14;-42'], 'statement.csv', { type: 'text/csv' })] },
    });
    fireEvent.click(await within(panel).findByRole('button', { name: 'Import' }));
    await within(panel).findByRole('button', { name: 'Confirm import' });

    await waitFor(async () => expect(await accountFilter(list)).toContain('Cash'));
  });

  it('shows a renamed account under its new name on Transactions, Analytics and Goals', async () => {
    let renamed = false;
    const daily = { ...giro, name: 'Giro Daily' };
    mockFetch(listRoutes(() => [renamed ? daily : giro], {
      'PATCH /api/accounts/acc-1': () => {
        renamed = true;
        return ok(daily);
      },
      'GET /api/goals': () =>
        ok({ goals: [{ ...SAVINGS_GOAL, source: `Imported balances · ${renamed ? daily.name : giro.name}` }] }),
    }));
    const list = await start();

    fireEvent.click((await openAccountMenu()).getByRole('button', { name: 'Rename' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Giro Daily' } });
    const before = listReads();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('button', { name: 'Giro Daily' });

    await waitFor(async () => expect(await accountFilter(list)).toContain('Giro Daily'));
    expect(await accountFilter(list)).not.toContain('Sparkasse Giro');
    expect(listReads()).toBe(before);
    const choices = await chartAccountChoices();
    expect(choices).toContain('Giro Daily');
    expect(choices).not.toContain('Sparkasse Giro');
    fireEvent.click(nav().getByRole('link', { name: 'Goals' }));
    const goals = screenOf(screen.getByRole('heading', { name: 'Goals' }));
    expect(await within(goals).findByText('Imported balances · Giro Daily')).toBeVisible();
  });

  it('takes a deleted account out of Transactions and Analytics', async () => {
    let deleted = false;
    mockFetch(listRoutes(() => (deleted ? [cash] : [giro, cash]), {
      'GET /api/imports': () => ok(importsResponse([importRecord({ transactions: 1 })])),
      'DELETE /api/accounts/acc-1': () => {
        deleted = true;
        return ok({ deleted: true, transactions: 1, imports: 1, documents: 1 });
      },
    }));
    const list = await start();
    expect(await accountFilter(list)).toContain('Sparkasse Giro');

    fireEvent.click((await openAccountMenu()).getByText('Delete'));
    fireEvent.change(await screen.findByLabelText(/to confirm/), {
      target: { value: 'Sparkasse Giro' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
    await screen.findByText(/Sparkasse Giro was deleted/);

    await waitFor(async () => expect(await accountFilter(list)).not.toContain('Sparkasse Giro'));
    expect(await chartAccountChoices()).not.toContain('Sparkasse Giro');
  });
});
