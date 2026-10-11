import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';
import { accountMonths, accountSummary, CONFIRMED, PRESETS, summaryResult } from './test/fixtures';
import { askedFor, FIRST_PAINT_ROUTES, mockFetch, ok, requests, requestUrls } from './test/harness';
import type { Transaction } from './types';

const imported: Transaction = {
  id: 'imported-row',
  accountId: 'acc-1',
  provider: 'upload',
  amount: -42,
  currency: 'EUR',
  date: '2026-08-14',
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

/**
 * The Transactions list's reads, and not the Overview's: the Overview asks for one
 * account's recent rows and its own reload after an import fires with or without the
 * shared revision, while the list on "All accounts" names no account.
 */
const listReads = () =>
  requestUrls().filter(
    (r) =>
      r.startsWith('GET /api/transactions?') &&
      !new URL(r.slice('GET '.length), 'http://localhost').searchParams.has('accountId'),
  ).length;

const goalReads = () => requests().filter((r) => r === 'GET /api/goals').length;

describe('import data revision', () => {
  it('re-reads every mounted screen when an import is confirmed from the Import panel', async () => {
    let committed = false;
    mockFetch({
      ...FIRST_PAINT_ROUTES,
      'GET /api/imports/presets': () => ok(PRESETS),
      'GET /api/transactions': () => ok(committed ? [imported] : []),
      'GET /api/summary': (_init, url) => ok(accountSummary(askedFor(url))),
      'GET /api/summary/months': (_init, url) => ok(accountMonths(askedFor(url))),
      'POST /api/imports': () =>
        ok(summaryResult({ accountId: 'acc-1', accountName: 'Sparkasse Giro' })),
      'POST /api/imports/imp-1/confirm': () => {
        committed = true;
        return ok({ ...CONFIRMED, accountId: 'acc-1', accountIds: ['acc-1'] });
      },
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'Overview' });
    const tabs = within(screen.getByRole('navigation', { name: 'Sections' }));

    fireEvent.click(tabs.getByRole('link', { name: 'Transactions' }));
    const transactionsScreen = screen.getByRole('heading', { name: 'Transactions' })
      .closest('.screen') as HTMLElement;
    expect(
      await within(transactionsScreen).findByText('No transactions in the selected period.'),
    ).toBeVisible();

    fireEvent.click(tabs.getByRole('link', { name: 'Import' }));
    const importScreen = (await screen.findByRole('heading', { name: 'Import a statement' }))
      .closest('.screen') as HTMLElement;
    fireEvent.click(await within(importScreen).findByRole('button', { name: 'Sparkasse Giro' }));
    // hidden and unlabelled, so no RTL query reaches it
    fireEvent.change(importScreen.querySelector('input[type=file]') as HTMLInputElement, {
      target: {
        files: [new File(['date;amount\n2026-08-14;-42'], 'statement.csv', { type: 'text/csv' })],
      },
    });
    await within(importScreen).findByRole('button', {
      name: 'Choose another CSV, Excel or PDF statement file',
    });
    fireEvent.click(within(importScreen).getByRole('button', { name: 'Import' }));

    const confirm = await within(importScreen).findByRole('button', { name: 'Confirm import' });
    const listBefore = listReads();
    const goalsBefore = goalReads();
    fireEvent.click(confirm);
    expect(await within(importScreen).findByText(/Imported 12 of 12 rows/)).toBeInTheDocument();

    await waitFor(() => {
      expect(listReads()).toBeGreaterThan(listBefore);
      expect(goalReads()).toBeGreaterThan(goalsBefore);
    });

    fireEvent.click(tabs.getByRole('link', { name: 'Transactions' }));
    expect(await within(transactionsScreen).findByText('Corner bakery')).toBeVisible();
    expect(
      within(transactionsScreen).queryByText('No transactions in the selected period.'),
    ).not.toBeInTheDocument();
  });
});
