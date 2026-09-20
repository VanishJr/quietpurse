import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { APP_SETTINGS, SAVINGS_GOAL } from '../test/fixtures';
import { fail, mockFetch, ok, renderThemed, requests } from '../test/harness';
import type { GoalDetail } from '../types';
import { GoalEditor } from './GoalEditor';

const monthlyDetail: GoalDetail = {
  id: 'goal-income',
  type: 'monthly-income',
  name: 'Income',
  targetDate: null,
  createdAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-01T00:00:00.000Z',
  currency: 'EUR',
  source: '2 complete months · Earnings',
  target: 3000,
  incomeScope: 'own',
  windowMonths: 6,
  progress: {
    semantic: 'completion',
    unit: 'money-per-month',
    target: 3000,
    current: 2000,
    remaining: 1000,
    overBy: 0,
    percentage: 66.67,
    forecast: null,
    status: 'tracking',
    asOf: '2026-05-15T12:00:00.000Z',
    period: { kind: 'complete-months', from: '2025-11-01', to: '2026-04-30', monthsUsed: 2 },
  },
};

const SAVINGS_DETAIL: GoalDetail = {
  ...SAVINGS_GOAL,
  type: 'savings-balance',
  target: 9000,
  accountIds: ['acc-1'],
};

const ACCOUNTS = [
  { id: 'acc-1', provider: 'upload' as const, name: 'Cash', currency: 'EUR', balance: 5400, hidden: false },
  { id: 'acc-2', provider: 'upload' as const, name: 'USD cash', currency: 'USD', balance: 1000, hidden: false },
  { id: 'debt', provider: 'upload' as const, name: 'Loan', currency: 'EUR', balance: -2000, hidden: false },
];

const baseRoutes = {
  'GET /api/accounts': () => ok(ACCOUNTS),
  'GET /api/app-settings': () => ok(APP_SETTINGS),
};

describe('GoalEditor', () => {
  it('shows all supported types and supports Back and Cancel', async () => {
    const close = vi.fn();
    mockFetch(baseRoutes);
    renderThemed(<GoalEditor goalId="new" onClose={close} onSaved={vi.fn()} />);

    expect(await screen.findByRole('button', { name: /Financial independence/ })).toBeVisible();
    expect(screen.getAllByRole('button').filter((button) => button.classList.contains('goal-type-tile'))).toHaveLength(7);
    fireEvent.click(screen.getByRole('button', { name: /Monthly income/ }));
    expect(screen.getByRole('heading', { name: 'Monthly income' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('heading', { name: 'Choose a goal type' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(close).toHaveBeenCalledOnce();
  });

  it('creates a goal with the complete type-specific body', async () => {
    let body: unknown;
    const saved = vi.fn();
    mockFetch({
      ...baseRoutes,
      'POST /api/goals': (init) => {
        body = JSON.parse(String(init?.body));
        return ok(monthlyDetail, 201);
      },
    });
    renderThemed(<GoalEditor goalId="new" onClose={vi.fn()} onSaved={saved} />);
    fireEvent.click(await screen.findByRole('button', { name: /Monthly income/ }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Stable income' } });
    fireEvent.change(screen.getByLabelText(/Monthly target/), { target: { value: '3500' } });
    fireEvent.change(screen.getByLabelText('Income'), { target: { value: 'all' } });
    fireEvent.change(screen.getByLabelText('Averaging period'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create goal' }));

    await waitFor(() => expect(saved).toHaveBeenCalledWith(monthlyDetail));
    expect(body).toEqual({
      type: 'monthly-income',
      name: 'Stable income',
      target: 3500,
      incomeScope: 'all',
      windowMonths: 12,
    });
  });

  it('keeps invalid essential-cost text in place and sends no destructive write', async () => {
    mockFetch(baseRoutes);
    renderThemed(<GoalEditor goalId="new" onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Financial independence/ }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Independence' } });
    fireEvent.change(screen.getByLabelText('Cost name'), { target: { value: 'Rent' } });
    const amount = screen.getByLabelText('Monthly cost for Rent');
    fireEvent.change(amount, { target: { value: 'not a number' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create goal' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Monthly cost for Rent must be a positive number.');
    expect(amount).toHaveValue('not a number');
    expect(requests()).not.toContain('POST /api/goals');
    expect(screen.getByRole('button', { name: 'Delete' })).toBeVisible();
  });

  it('skips type selection on edit and saves a complete replacement', async () => {
    let body: unknown;
    const saved = vi.fn();
    mockFetch({
      ...baseRoutes,
      'GET /api/goals/goal-savings': () => ok(SAVINGS_DETAIL),
      'PUT /api/goals/goal-savings': (init) => {
        body = JSON.parse(String(init?.body));
        return ok(SAVINGS_DETAIL);
      },
    });
    renderThemed(<GoalEditor goalId="goal-savings" onClose={vi.fn()} onSaved={saved} />);

    expect(await screen.findByRole('heading', { name: 'Edit goal' })).toBeVisible();
    expect(screen.queryByText('Choose a goal type')).not.toBeInTheDocument();
    expect(screen.getByText('Progress will be recalculated from the selected accounts.')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'House deposit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(saved).toHaveBeenCalled());
    expect(body).toEqual({
      type: 'savings-balance',
      name: 'House deposit',
      targetDate: null,
      target: 9000,
      accountIds: ['acc-1'],
    });
  });

  it('keeps the editor and entered values open when the server refuses a save', async () => {
    mockFetch({
      ...baseRoutes,
      'POST /api/goals': () => fail(409, { error: 'a category spending limit already tracks this category' }),
    });
    renderThemed(<GoalEditor goalId="new" onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Category spending limit/ }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Food again' } });
    fireEvent.change(screen.getByLabelText(/Monthly limit/), { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create goal' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('already tracks this category');
    expect(screen.getByLabelText('Name')).toHaveValue('Food again');
    expect(screen.getByLabelText(/Monthly limit/)).toHaveValue('500');
    expect(screen.getByRole('dialog')).toBeVisible();
  });

  it('only offers negative-balance accounts for a new debt goal', async () => {
    mockFetch(baseRoutes);
    renderThemed(<GoalEditor goalId="new" onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Debt payoff/ }));
    const picker = screen.getByLabelText('Debt account');
    expect(within(picker).getByRole('option', { name: /Loan/ })).toBeInTheDocument();
    expect(within(picker).queryByRole('option', { name: /Cash ·/ })).not.toBeInTheDocument();
  });
});
