import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
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

const FINANCIAL_DETAIL: GoalDetail = {
  id: 'goal-fi',
  type: 'financial-independence',
  name: 'Independent',
  targetDate: null,
  createdAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-01T00:00:00.000Z',
  currency: 'EUR',
  source: '2 complete months · Essential costs + 10% buffer',
  supportExcluded: 0,
  workHoursLeft: null,
  workHoursCapacityPerMonth: null,
  workHoursCapacityExceeded: null,
  basis: 'essential-costs',
  bufferPct: 10,
  windowMonths: 6,
  hourlyRate: null,
  hoursPerWeek: null,
  essentialCosts: [
    { id: 1, label: 'Rent', monthly: 900, sort: 0 },
    { id: 2, label: 'Food', monthly: 300, sort: 1 },
  ],
  progress: {
    ...SAVINGS_GOAL.progress,
    unit: 'money-per-month',
    target: 1320,
    current: null,
    remaining: null,
    overBy: null,
    percentage: null,
    status: 'not-enough-data',
    period: { kind: 'complete-months', from: '2025-11-01', to: '2026-04-30', monthsUsed: 0 },
  },
};

const unavailableDetails: Array<{ detail: GoalDetail; amountLabel: string }> = [
  {
    detail: {
      ...SAVINGS_DETAIL,
      id: 'missing-savings',
      currency: 'USD',
      accountIds: ['gone-usd'],
    },
    amountLabel: 'Target amount (USD)',
  },
  {
    detail: {
      id: 'missing-emergency',
      type: 'emergency-fund',
      name: 'Emergency',
      targetDate: null,
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
      currency: 'USD',
      source: 'Unavailable account',
      coverageMonths: 6,
      monthlyEssentials: 1000,
      accountIds: ['gone-usd'],
      progress: { ...SAVINGS_GOAL.progress, status: 'account-unavailable' },
    },
    amountLabel: 'Essential monthly amount (USD)',
  },
  {
    detail: {
      id: 'missing-debt',
      type: 'debt-payoff',
      name: 'Debt',
      targetDate: null,
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
      currency: 'USD',
      source: 'Unavailable account',
      accountId: 'gone-usd',
      startingDebt: 5000,
      targetDebt: 0,
      progress: { ...SAVINGS_GOAL.progress, status: 'account-unavailable' },
    },
    amountLabel: 'Target remaining debt (USD)',
  },
];

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
    fireEvent.change(screen.getByLabelText('Cost 1 name'), { target: { value: 'Rent' } });
    const amount = screen.getByLabelText('Monthly cost for Rent');
    fireEvent.change(amount, { target: { value: 'not a number' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create goal' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Monthly cost for Rent must be a positive number.');
    expect(amount).toHaveValue('not a number');
    expect(requests()).not.toContain('POST /api/goals');
    expect(screen.getByRole('button', { name: 'Delete Rent' })).toBeVisible();
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

  it('locks savings selections to the first selected account currency', async () => {
    mockFetch(baseRoutes);
    renderThemed(<GoalEditor goalId="new" onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Savings balance/ }));

    const eur = screen.getByRole('checkbox', { name: 'Cash · EUR' });
    const usd = screen.getByRole('checkbox', { name: 'USD cash · USD' });
    expect(usd).toBeEnabled();
    fireEvent.click(eur);
    expect(usd).toBeDisabled();
    fireEvent.click(usd);
    expect(usd).not.toBeChecked();
    fireEvent.click(eur);
    expect(usd).toBeEnabled();
  });

  it.each(unavailableDetails)(
    'keeps the persisted currency for unavailable $detail.type accounts',
    async ({ detail, amountLabel }) => {
      mockFetch({
        ...baseRoutes,
        [`GET /api/goals/${detail.id}`]: () => ok(detail),
      });
      renderThemed(<GoalEditor goalId={detail.id} onClose={vi.fn()} onSaved={vi.fn()} />);

      expect(await screen.findByText('Currency: USD')).toBeVisible();
      expect(screen.getByLabelText(amountLabel)).toBeVisible();
    },
  );

  it('keeps dependency failures separate from forms and retries with cleared state', async () => {
    let accountReads = 0;
    mockFetch({
      ...baseRoutes,
      'GET /api/accounts': () =>
        ++accountReads === 2 ? fail(500, { error: 'accounts unavailable' }) : ok(ACCOUNTS),
    });

    const Host = () => {
      const [id, setId] = useState<string | null>('new');
      return (
        <>
          <button onClick={() => setId('new')}>Reopen editor</button>
          <GoalEditor
            goalId={id}
            onClose={() => setId(null)}
            onSaved={vi.fn()}
          />
        </>
      );
    };
    renderThemed(<Host />);

    expect(await screen.findByRole('button', { name: /Savings balance/ })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reopen editor' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Couldn’t load goal: accounts unavailable',
    );
    expect(screen.queryByRole('button', { name: /Savings balance/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Cash · EUR/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: /Savings balance/ })).toBeVisible();
  });

  it('clears a form error when the create wizard returns to type selection', async () => {
    mockFetch(baseRoutes);
    renderThemed(<GoalEditor goalId="new" onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Monthly income/ }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Income' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create goal' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Monthly target');

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Savings balance/ }));
    expect(screen.getByRole('heading', { name: 'Savings balance' })).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('gives every essential-cost control stable row context', async () => {
    mockFetch({
      ...baseRoutes,
      'GET /api/goals/goal-fi': () => ok(FINANCIAL_DETAIL),
    });
    renderThemed(<GoalEditor goalId="goal-fi" onClose={vi.fn()} onSaved={vi.fn()} />);

    expect(await screen.findByLabelText('Cost 1 name')).toHaveValue('Rent');
    expect(screen.getByLabelText('Monthly cost for Rent')).toHaveValue('900');
    expect(screen.getByRole('button', { name: 'Delete Rent' })).toBeVisible();
    expect(screen.getByLabelText('Cost 2 name')).toHaveValue('Food');
    expect(screen.getByLabelText('Monthly cost for Food')).toHaveValue('300');
    expect(screen.getByRole('button', { name: 'Delete Food' })).toBeVisible();
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
