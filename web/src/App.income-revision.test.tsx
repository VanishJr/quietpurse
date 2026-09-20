import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';
import { accountMonths, accountSummary } from './test/fixtures';
import { askedFor, FIRST_PAINT_ROUTES, mockFetch, ok, requests } from './test/harness';
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
  description: 'Family Support Payment',
  category: 'other',
  categoryManual: false,
  transfer: true,
  transferManual: null,
  refund: false,
  incomeSource: 'other',
  incomeSourceManual: false,
  recurring: false,
  oneOff: false,
};

describe('income-source data revision', () => {
  it('refreshes every mounted reader when a pattern breaks a transfer pair', async () => {
    let changed = false;
    const newSource = {
      ...oldSource,
      label: 'Grant',
      patterns: ['Family Support Payment'],
    };
    const bounds = (url = '') => {
      const query = new URL(url, 'http://localhost').searchParams;
      return { from: query.get('from') ?? '', to: query.get('to') ?? '' };
    };
    const recurringGroup = {
      description: 'Monthly gym payment',
      category: 'subscriptions',
      months: 3,
      count: 3,
      avgAmount: -40,
      monthlyAvg: -40,
      lastDate: '2026-07-10',
      ignored: false,
    };
    mockFetch({
      ...FIRST_PAINT_ROUTES,
      'GET /api/income-sources': () => ok([changed ? newSource : oldSource]),
      'PUT /api/income-sources/stipend': () => {
        changed = true;
        return ok(newSource);
      },
      'GET /api/transactions': () =>
        ok([
          changed
            ? { ...income, transfer: false, incomeSource: 'stipend' }
            : income,
        ]),
      'GET /api/transactions/income-row': () =>
        ok(changed ? { ...income, transfer: false, incomeSource: 'stipend' } : income),
      'GET /api/transactions/income-row/transfer-rule-preview': () =>
        ok({
          txId: income.id,
          accountId: income.accountId,
          description: income.description,
          transactions: [income],
          matches: 1,
          manualOverrides: 0,
          activeRule: null,
          previewToken: 'a'.repeat(64),
        }),
      'GET /api/summary': (_init, url) =>
        ok(
          accountSummary(askedFor(url), {
            ...bounds(url),
            totals: { income: changed ? 500 : 0, expense: 0 },
            incomeByCategory: changed ? [{ category: 'other', total: 500 }] : [],
          }),
        ),
      'GET /api/summary/months': (_init, url) =>
        ok(
          accountMonths(askedFor(url), {
            ...bounds(url),
            months: [
              { month: '2026-07', income: changed ? 500 : 0, expense: 0, net: 500 },
            ],
          }),
        ),
      'GET /api/recurring': () =>
        ok({
          baseCurrency: 'EUR',
          monthlyTotal: changed ? 40 : 0,
          groups: changed ? [recurringGroup] : [],
        }),
    });
    render(<App />);

    const initialFlows = await screen.findByRole('region', {
      name: 'Income and expenses for Sparkasse Giro',
    });
    expect(within(initialFlows).getByText('+0 EUR')).toBeVisible();
    const tabs = within(screen.getByRole('navigation', { name: 'Sections' }));
    fireEvent.click(tabs.getByRole('link', { name: 'Transactions' }));
    const transactionsScreen = screen.getByRole('heading', { name: 'Transactions' })
      .closest('.screen-inner') as HTMLElement;
    fireEvent.click(await within(transactionsScreen).findByText('Family Support Payment'));
    expect(screen.getByRole('checkbox', { name: /Transfer between own accounts/ })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Manage transfer rules' }));
    expect(await screen.findByRole('dialog', { name: 'Transfer rules' })).toBeVisible();

    fireEvent.click(screen.getByRole('link', { name: 'Settings' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Stipend' }));
    fireEvent.change(screen.getByLabelText('Source name'), { target: { value: 'Grant' } });
    fireEvent.change(screen.getByLabelText('Statement match patterns'), {
      target: { value: 'Family Support Payment' },
    });
    const transactionsBefore = requests().filter(
      (request) => request === 'GET /api/transactions',
    ).length;
    const summariesBefore = requests().filter(
      (request) => request === 'GET /api/summary',
    ).length;
    const recurringBefore = requests().filter(
      (request) => request === 'GET /api/recurring',
    ).length;
    const sourceForm = screen.getByLabelText('Source name').closest('.row') as HTMLElement;
    fireEvent.click(within(sourceForm).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Grant')).toBeVisible();
    expect(
      await screen.findByRole('button', { name: 'Hide payment Monthly gym payment' }),
    ).toBeVisible();
    await waitFor(() => {
      expect(
        requests().filter((request) => request === 'GET /api/transactions').length,
      ).toBeGreaterThan(transactionsBefore);
      expect(
        requests().filter((request) => request === 'GET /api/summary').length,
      ).toBeGreaterThan(summariesBefore);
      expect(
        requests().filter((request) => request === 'GET /api/recurring').length,
      ).toBeGreaterThan(recurringBefore);
    });

    fireEvent.click(tabs.getByRole('link', { name: 'Overview' }));
    const refreshedFlows = await screen.findByRole('region', {
      name: 'Income and expenses for Sparkasse Giro',
    });
    expect(within(refreshedFlows).getByText('+500 EUR')).toBeVisible();

    fireEvent.click(tabs.getByRole('link', { name: 'Transactions' }));
    const refreshedSheet = await screen.findByRole('dialog', { name: 'Transaction' });
    expect(
      within(refreshedSheet).getByRole('checkbox', { name: /Transfer between own accounts/ }),
    ).not.toBeChecked();
    expect(within(refreshedSheet).getByRole('button', { name: 'Grant' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(await screen.findByText('Grant', { selector: '.badge' })).toBeVisible();
  });
});
