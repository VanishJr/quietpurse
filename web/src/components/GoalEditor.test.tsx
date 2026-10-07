import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { APP_SETTINGS, SAVINGS_GOAL } from '../test/fixtures';
import { fail, mockFetch, ok, renderThemed, requests } from '../test/harness';
import type { GoalDetail } from '../types';
import { GoalEditor } from './GoalEditor';
import { ThemeProvider } from '../theme';

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

const DEBT_DETAIL: GoalDetail = {
  id: 'goal-debt',
  type: 'debt-payoff',
  name: 'Pay off loan',
  targetDate: null,
  createdAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-01T00:00:00.000Z',
  currency: 'EUR',
  source: 'Loan',
  accountId: 'debt',
  startingDebt: 2000,
  targetDebt: 0,
  progress: {
    ...SAVINGS_GOAL.progress,
    target: 2000,
    current: 2000,
    remaining: 0,
    percentage: 100,
    status: 'reached',
  },
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
    const amount = screen.getByLabelText('Monthly cost for Rent, row 1');
    fireEvent.change(amount, { target: { value: 'not a number' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create goal' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Monthly cost for Rent must be a positive number.');
    expect(amount).toHaveValue('not a number');
    expect(requests()).not.toContain('POST /api/goals');
    expect(screen.getByRole('button', { name: 'Delete Rent, row 1' })).toBeVisible();
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
    const close = vi.fn();
    const saved = vi.fn();
    mockFetch({
      ...baseRoutes,
      'POST /api/goals': () => fail(409, { error: 'a category spending limit already tracks this category' }),
    });
    renderThemed(<GoalEditor goalId="new" onClose={close} onSaved={saved} />);
    fireEvent.click(await screen.findByRole('button', { name: /Category spending limit/ }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Food again' } });
    fireEvent.change(screen.getByLabelText(/Monthly limit/), { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create goal' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('already tracks this category');
    expect(screen.getByLabelText('Name')).toHaveValue('Food again');
    expect(screen.getByLabelText(/Monthly limit/)).toHaveValue('500');
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(requests().filter((request) => request === 'POST /api/goals')).toHaveLength(1);
    expect(saved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByLabelText('Name')).toHaveValue('Food again');
    expect(screen.getByRole('alert')).toHaveTextContent('already tracks this category');
  });

  it('routes a missing goal during save through the unavailable fallback', async () => {
    const missing = vi.fn();
    mockFetch({
      ...baseRoutes,
      'GET /api/goals/goal-savings': () => ok(SAVINGS_DETAIL),
      'PUT /api/goals/goal-savings': () => fail(404, { error: 'goal not found' }),
    });
    renderThemed(
      <GoalEditor
        goalId="goal-savings"
        onClose={vi.fn()}
        onMissing={missing}
        onSaved={vi.fn()}
      />,
    );

    expect(await screen.findByRole('heading', { name: 'Edit goal' })).toBeVisible();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Edited savings' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(missing).toHaveBeenCalledOnce());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
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

  it('keeps the saved currency and refuses a savings account whose currency changed', async () => {
    const changedAccounts = ACCOUNTS.map((account) =>
      account.id === 'acc-1' ? { ...account, currency: 'USD' } : account,
    );
    mockFetch({
      ...baseRoutes,
      'GET /api/accounts': () => ok(changedAccounts),
      'GET /api/goals/goal-savings': () => ok(SAVINGS_DETAIL),
    });
    renderThemed(<GoalEditor goalId="goal-savings" onClose={vi.fn()} onSaved={vi.fn()} />);

    expect(await screen.findByText('Currency: EUR')).toBeVisible();
    expect(screen.getByLabelText('Target amount (EUR)')).toBeVisible();
    const staleAccount = screen.getByRole('checkbox', { name: 'Cash · USD (not eligible)' });
    expect(staleAccount).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Remove accounts that no longer use this goal’s EUR currency.',
    );
    expect(requests()).not.toContain('PUT /api/goals/goal-savings');

    fireEvent.click(staleAccount);
    const explicitlyReselected = screen.getByRole('checkbox', { name: 'Cash · USD' });
    expect(explicitlyReselected).toBeEnabled();
    fireEvent.click(explicitlyReselected);
    expect(screen.getByText('Currency: USD')).toBeVisible();
  });

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
    expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.getByRole('heading', { name: 'Savings balance' })).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps duplicate essential-cost controls distinct while reporting the duplicate', async () => {
    mockFetch({
      ...baseRoutes,
      'GET /api/goals/goal-fi': () => ok(FINANCIAL_DETAIL),
    });
    renderThemed(<GoalEditor goalId="goal-fi" onClose={vi.fn()} onSaved={vi.fn()} />);

    expect(await screen.findByLabelText('Cost 1 name')).toHaveValue('Rent');
    fireEvent.change(screen.getByLabelText('Cost 2 name'), { target: { value: 'Rent' } });
    expect(screen.getByLabelText('Monthly cost for Rent, row 1')).toHaveValue('900');
    expect(screen.getByLabelText('Monthly cost for Rent, row 2')).toHaveValue('300');
    expect(screen.getByRole('button', { name: 'Delete Rent, row 1' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Delete Rent, row 2' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Cost names must be unique.');
    expect(requests()).not.toContain('PUT /api/goals/goal-fi');
  });

  it('only offers negative-balance accounts for a new debt goal', async () => {
    mockFetch(baseRoutes);
    renderThemed(<GoalEditor goalId="new" onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Debt payoff/ }));
    const picker = screen.getByLabelText('Debt account');
    expect(within(picker).getByRole('option', { name: /Loan/ })).toBeInTheDocument();
    expect(within(picker).queryByRole('option', { name: /Cash ·/ })).not.toBeInTheDocument();
  });

  it('keeps a paid-off saved debt account and its saved currency visible while editing', async () => {
    const paidOffAccounts = ACCOUNTS.map((account) =>
      account.id === 'debt' ? { ...account, balance: 0, currency: 'USD' } : account,
    );
    mockFetch({
      ...baseRoutes,
      'GET /api/accounts': () => ok(paidOffAccounts),
      'GET /api/goals/goal-debt': () => ok(DEBT_DETAIL),
    });
    renderThemed(<GoalEditor goalId="goal-debt" onClose={vi.fn()} onSaved={vi.fn()} />);

    const picker = await screen.findByLabelText('Debt account');
    expect(picker).toHaveValue('debt');
    expect(within(picker).getByRole('option', { name: 'Loan · USD' })).toBeInTheDocument();
    expect(screen.getByText('Currency: EUR')).toBeVisible();
    expect(screen.getByLabelText('Target remaining debt (EUR)')).toBeVisible();
  });

  it.each(['Cancel', 'Close dialog', 'Escape'])(
    'closes a new goal with only default type choices without a guard via %s',
    async (dismissal) => {
      const close = vi.fn();
      mockFetch(baseRoutes);
      renderThemed(<GoalEditor goalId="new" onClose={close} onSaved={vi.fn()} />);
      fireEvent.click(await screen.findByRole('button', { name: /Financial independence/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Back' }));
      fireEvent.click(screen.getByRole('button', { name: /Savings rate/ }));
      if (dismissal === 'Escape') fireEvent.keyDown(document, { key: 'Escape' });
      else fireEvent.click(screen.getByRole('button', { name: dismissal }));
      expect(close).toHaveBeenCalledOnce();
      expect(screen.queryByRole('button', { name: 'Keep editing' })).not.toBeInTheDocument();
      expect(requests()).toEqual(['GET /api/accounts', 'GET /api/app-settings']);
    },
  );

  it.each(['Cancel', 'Close dialog', 'Escape'])(
    'guards meaningful new goal edits via %s and resumes on guard Escape',
    async (dismissal) => {
      const close = vi.fn();
      mockFetch(baseRoutes);
      renderThemed(<GoalEditor goalId="new" onClose={close} onSaved={vi.fn()} />);
      fireEvent.click(await screen.findByRole('button', { name: /Monthly income/ }));
      const name = screen.getByLabelText('Name');
      name.focus();
      fireEvent.change(name, { target: { value: 'My income' } });
      if (dismissal === 'Escape') fireEvent.keyDown(document, { key: 'Escape' });
      else fireEvent.click(screen.getByRole('button', { name: dismissal }));
      expect(close).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus();
      expect(name).not.toBeVisible();
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(name).toBeVisible();
      expect(name).toHaveValue('My income');
      expect(name).toHaveFocus();
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
      expect(close).toHaveBeenCalledOnce();
      expect(requests()).not.toContain('POST /api/goals');
    },
  );

  it('makes reverted edits pristine against the successfully loaded opening snapshot', async () => {
    const close = vi.fn();
    mockFetch({ ...baseRoutes, 'GET /api/goals/goal-savings': () => ok(SAVINGS_DETAIL) });
    renderThemed(<GoalEditor goalId="goal-savings" onClose={close} onSaved={vi.fn()} />);
    const target = await screen.findByLabelText('Target amount (EUR)');
    fireEvent.change(target, { target: { value: '10000' } });
    fireEvent.change(target, { target: { value: '9000' } });
    const account = screen.getByRole('checkbox', { name: 'Cash · EUR' });
    fireEvent.click(account);
    fireEvent.click(account);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(close).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Keep editing' })).not.toBeInTheDocument();
    expect(requests()).not.toContain('PUT /api/goals/goal-savings');
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
  });

  it('preserves Back and same-type values, guarding and discarding incompatible fields on a new type', async () => {
    const close = vi.fn();
    mockFetch(baseRoutes);
    renderThemed(<GoalEditor goalId="new" onClose={close} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Financial independence/ }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Independent' } });
    fireEvent.change(screen.getByLabelText('Cost 1 name'), { target: { value: 'Rent' } });
    fireEvent.change(screen.getByLabelText('Monthly cost for Rent, row 1'), { target: { value: '900' } });
    fireEvent.change(screen.getByLabelText('Safety buffer, %'), { target: { value: '15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.queryByRole('button', { name: 'Keep editing' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Financial independence/ }));
    expect(screen.getByLabelText('Name')).toHaveValue('Independent');
    expect(screen.getByLabelText('Monthly cost for Rent, row 1')).toHaveValue('900');
    expect(screen.getByLabelText('Safety buffer, %')).toHaveValue('15');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: /Monthly income/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    fireEvent.click(screen.getByRole('button', { name: /Financial independence/ }));
    expect(screen.getByLabelText('Cost 1 name')).toHaveValue('Rent');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: /Monthly income/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.getByLabelText('Monthly target (EUR)')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: /Financial independence/ }));
    expect(screen.getByLabelText('Cost 1 name')).toHaveValue('');
    expect(screen.getByLabelText('Monthly cost for row 1')).toHaveValue('');
    expect(screen.getByLabelText('Safety buffer, %')).toHaveValue('10');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(close).toHaveBeenCalledOnce();
    expect(requests()).not.toContain('POST /api/goals');
  });

  it('ignores empty cost rows and generated keys after deleting and recreating a saved cost', async () => {
    const close = vi.fn();
    const detail = { ...FINANCIAL_DETAIL, essentialCosts: [FINANCIAL_DETAIL.essentialCosts[0]] };
    mockFetch({ ...baseRoutes, 'GET /api/goals/goal-fi': () => ok(detail) });
    renderThemed(<GoalEditor goalId="goal-fi" onClose={close} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Rent, row 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add cost' }));
    fireEvent.change(screen.getByLabelText('Cost 1 name'), { target: { value: 'Rent' } });
    fireEvent.change(screen.getByLabelText('Monthly cost for Rent, row 1'), { target: { value: '900' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add cost' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(close).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Keep editing' })).not.toBeInTheDocument();
  });

  it.each(['label', 'monthly', 'delete'])(
    'detects meaningful saved cost %s changes',
    async (change) => {
      const close = vi.fn();
      mockFetch({ ...baseRoutes, 'GET /api/goals/goal-fi': () => ok(FINANCIAL_DETAIL) });
      renderThemed(<GoalEditor goalId="goal-fi" onClose={close} onSaved={vi.fn()} />);
      await screen.findByLabelText('Cost 1 name');
      if (change === 'label') fireEvent.change(screen.getByLabelText('Cost 1 name'), { target: { value: 'Housing' } });
      if (change === 'monthly') fireEvent.change(screen.getByLabelText('Monthly cost for Rent, row 1'), { target: { value: '1000' } });
      if (change === 'delete') fireEvent.click(screen.getByRole('button', { name: 'Delete Rent, row 1' }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(close).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus();
      expect(requests()).not.toContain('PUT /api/goals/goal-fi');
    },
  );

  it.each([false, true])('does not apply an older save result or unlock a newer editor opening (new save pending: %s)', async (newSavePending) => {
    let resolve!: (response: Response) => void;
    let resolveNew!: (response: Response) => void;
    const pending = new Promise<Response>((finish) => { resolve = finish; });
    const newPending = new Promise<Response>((finish) => { resolveNew = finish; });
    const saved = vi.fn();
    const close = vi.fn();
    const missing = vi.fn();
    mockFetch({
      ...baseRoutes,
      'GET /api/goals/goal-savings': () => ok(SAVINGS_DETAIL),
      'GET /api/goals/goal-income': () => ok(monthlyDetail),
      'PUT /api/goals/goal-savings': () => pending,
      'PUT /api/goals/goal-income': () => newPending,
    });
    const { rerender } = renderThemed(<GoalEditor goalId="goal-savings" onClose={close} onMissing={missing} onSaved={saved} />);
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Updated savings' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    rerender(<ThemeProvider><GoalEditor goalId="goal-income" onClose={close} onMissing={missing} onSaved={saved} /></ThemeProvider>);
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Income'));
    if (newSavePending) fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await act(async () => { resolve(ok(SAVINGS_DETAIL)); });
    expect(saved).toHaveBeenCalledWith(SAVINGS_DETAIL);
    expect(saved).toHaveBeenCalledOnce();
    expect(screen.getByLabelText('Name')).toHaveValue('Income');
    expect(screen.queryByRole('heading', { name: 'Goal saved' })).not.toBeInTheDocument();
    expect(requests().filter((request) => request.startsWith('PUT '))).toHaveLength(newSavePending ? 2 : 1);
    if (newSavePending) {
      expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('aria-busy', 'true');
      expect(screen.getByLabelText('Name')).toHaveAttribute('readonly');
      await act(async () => { resolveNew(ok(monthlyDetail)); });
      expect(saved).toHaveBeenCalledWith(monthlyDetail);
    } else expect(screen.getByRole('button', { name: 'Save' })).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('shows confirmed completion without another submission when the owner cannot close immediately', async () => {
    const saved = vi.fn();
    mockFetch({ ...baseRoutes, 'POST /api/goals': () => ok(monthlyDetail) });
    renderThemed(<GoalEditor goalId="new" onClose={vi.fn()} onSaved={saved} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Monthly income/ }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Income' } });
    fireEvent.change(screen.getByLabelText('Monthly target (EUR)'), { target: { value: '3000' } });
    const form = screen.getByLabelText('Name').closest('form')!;
    fireEvent.submit(form);
    await screen.findByRole('heading', { name: 'Goal saved' });
    expect(saved).toHaveBeenCalledWith(monthlyDetail);
    expect(screen.getByText(/was saved.*no longer an unsaved draft/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Create goal' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    fireEvent.submit(form);
    const leave = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(leave);
    expect(leave.defaultPrevented).toBe(false);
    expect(requests().filter((request) => request === 'POST /api/goals')).toHaveLength(1);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: 'Keep editing' })).not.toBeInTheDocument();
  });

  it('blocks duplicate pending writes and locks fields and every dismissal without losing focus', async () => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>((done) => { resolve = done; });
    const close = vi.fn();
    const saved = vi.fn();
    mockFetch({
      ...baseRoutes,
      'GET /api/goals/goal-savings': () => ok(SAVINGS_DETAIL),
      'PUT /api/goals/goal-savings': () => pending,
    });
    renderThemed(<GoalEditor goalId="goal-savings" onClose={close} onSaved={saved} />);
    const name = await screen.findByLabelText('Name');
    name.focus();
    fireEvent.change(name, { target: { value: 'House deposit' } });
    const save = screen.getByRole('button', { name: 'Save' });
    const form = name.closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    fireEvent.click(save);
    expect(name).toHaveFocus();
    expect(name).toHaveAttribute('readonly');
    expect(screen.getByLabelText('Target amount (EUR)')).toHaveAttribute('readonly');
    expect(screen.getByLabelText('Target date (optional)')).toHaveAttribute('readonly');
    fireEvent.change(name, { target: { value: 'Not submitted' } });
    expect(name).toHaveValue('House deposit');
    const account = screen.getByRole('checkbox', { name: 'Cash · EUR' });
    expect(account).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(account);
    expect(account).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Keep editing' })).not.toBeInTheDocument();
    expect(requests().filter((request) => request === 'PUT /api/goals/goal-savings')).toHaveLength(1);
    await act(async () => resolve(ok(SAVINGS_DETAIL)));
    await waitFor(() => expect(saved).toHaveBeenCalledWith(SAVINGS_DETAIL));
    expect(screen.queryByRole('button', { name: 'Keep editing' })).not.toBeInTheDocument();
  });

  it('keeps pending select controls focusable and restores their committed values on refusal', async () => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>((done) => { resolve = done; });
    mockFetch({
      ...baseRoutes,
      'GET /api/goals/goal-income': () => ok(monthlyDetail),
      'PUT /api/goals/goal-income': () => pending,
    });
    renderThemed(<GoalEditor goalId="goal-income" onClose={vi.fn()} onSaved={vi.fn()} />);
    const income = await screen.findByLabelText('Income');
    income.focus();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(income).toHaveFocus();
    expect(income).not.toBeDisabled();
    expect(income).toHaveAttribute('aria-disabled', 'true');
    fireEvent.change(income, { target: { value: 'all' } });
    expect(income).toHaveValue('own');
    const window = screen.getByLabelText('Averaging period');
    fireEvent.change(window, { target: { value: '12' } });
    expect(window).toHaveValue('6');
    await act(async () => resolve(fail(409, { error: 'goal cannot be saved' })));
    expect(await screen.findByRole('alert')).toHaveTextContent('goal cannot be saved');
    expect(income).toHaveAttribute('aria-disabled', 'false');
    fireEvent.change(income, { target: { value: 'all' } });
    expect(income).toHaveValue('all');
    expect(requests().filter((request) => request === 'PUT /api/goals/goal-income')).toHaveLength(1);
  });

  it('finishes missing-goal dependency loads without a discard prompt', async () => {
    const missing = vi.fn();
    mockFetch({ ...baseRoutes, 'GET /api/goals/gone': () => fail(404, { error: 'goal not found' }) });
    renderThemed(<GoalEditor goalId="gone" onClose={vi.fn()} onMissing={missing} onSaved={vi.fn()} />);
    await waitFor(() => expect(missing).toHaveBeenCalledOnce());
    expect(screen.queryByRole('button', { name: 'Keep editing' })).not.toBeInTheDocument();
  });

});
