import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';
import { SUMMARY } from './test/fixtures';
import { FIRST_PAINT_ROUTES, mockFetch, ok, requests } from './test/harness';
import type { IncomeSourceDef, Transaction } from './types';

const oldSource: IncomeSourceDef = {
  id: 'stipend',
  label: 'Stipend',
  kind: 'external',
  patterns: [],
  sort: 0,
  builtin: false,
};

const income: Transaction = {
  id: 'income-row',
  accountId: 'acc-1',
  provider: 'upload',
  amount: 500,
  currency: 'EUR',
  date: '2026-07-14',
  description: 'Income row',
  category: 'salary',
  categoryManual: false,
  transfer: false,
  transferManual: null,
  refund: false,
  incomeSource: 'stipend',
  incomeSourceManual: false,
  recurring: false,
  oneOff: false,
};

describe('income-source data revision', () => {
  it('refreshes mounted transaction readers after a Settings mutation', async () => {
    let changed = false;
    const newSource = { ...oldSource, label: 'Grant' };
    mockFetch({
      ...FIRST_PAINT_ROUTES,
      'GET /api/income-sources': () => ok([changed ? newSource : oldSource]),
      'PUT /api/income-sources/stipend': () => {
        changed = true;
        return ok(newSource);
      },
      'GET /api/transactions': () => ok([income]),
      'GET /api/summary': () => ok(SUMMARY),
      'GET /api/summary/months': () =>
        ok({
          scope: 'all',
          from: '2026-07-01',
          to: '2026-07-31',
          baseCurrency: 'EUR',
          months: [],
        }),
    });
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeVisible();
    const tabs = within(screen.getByRole('navigation', { name: 'Sections' }));
    fireEvent.click(screen.getByRole('link', { name: 'Settings' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Stipend' }));
    fireEvent.change(screen.getByLabelText('Source name'), { target: { value: 'Grant' } });
    const transactionsBefore = requests().filter(
      (request) => request === 'GET /api/transactions',
    ).length;
    const sourceForm = screen.getByLabelText('Source name').closest('.row') as HTMLElement;
    fireEvent.click(within(sourceForm).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Grant')).toBeVisible();
    await waitFor(() =>
      expect(
        requests().filter((request) => request === 'GET /api/transactions').length,
      ).toBeGreaterThan(transactionsBefore),
    );
    fireEvent.click(tabs.getByRole('link', { name: 'Transactions' }));
    expect(await screen.findByText('Grant', { selector: '.badge' })).toBeVisible();
  });
});
