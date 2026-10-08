import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { APP_SETTINGS, SAVINGS_GOAL } from '../test/fixtures';
import { fail, mockFetch, ok, renderThemed, requests } from '../test/harness';
import type { GoalCreate, GoalDetail } from '../types';
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

const EMERGENCY_DETAIL: GoalDetail = {
  ...SAVINGS_GOAL, id: 'goal-emergency', type: 'emergency-fund', coverageMonths: 6,
  monthlyEssentials: 1000, accountIds: ['acc-1'],
};
const RATE_DETAIL: GoalDetail = {
  ...SAVINGS_GOAL, id: 'goal-rate', type: 'savings-rate', targetPercent: 20, incomeScope: 'own', windowMonths: 6,
};
const LIMIT_DETAIL: GoalDetail = {
  ...SAVINGS_GOAL, id: 'goal-limit', type: 'category-spending-limit', category: 'food', monthlyLimit: 500,
};

const bodyCases: Array<{ label: string; detail: GoalDetail; body: GoalCreate }> = [
  { label: 'Financial independence', detail: FINANCIAL_DETAIL, body: {
    type: 'financial-independence', name: 'Complete goal', basis: 'essential-costs', bufferPct: 100,
    windowMonths: 12, hourlyRate: 25.5, hoursPerWeek: 8.25,
    essentialCosts: [{ label: 'Rent', monthly: 900.5 }, { label: 'Food', monthly: 300.4 }],
  } },
  { label: 'Emergency fund', detail: EMERGENCY_DETAIL, body: {
    type: 'emergency-fund', name: 'Complete goal', targetDate: '2027-08-01', coverageMonths: 120,
    monthlyEssentials: 1000.05, accountIds: ['acc-1', 'debt'],
  } },
  { label: 'Savings balance', detail: SAVINGS_DETAIL, body: {
    type: 'savings-balance', name: 'Complete goal', targetDate: '2027-08-01', target: 5000.05, accountIds: ['acc-2'],
  } },
  { label: 'Debt payoff', detail: DEBT_DETAIL, body: {
    type: 'debt-payoff', name: 'Complete goal', targetDate: '2027-08-01', accountId: 'debt', targetDebt: 0,
  } },
  { label: 'Monthly income', detail: monthlyDetail, body: {
    type: 'monthly-income', name: 'Complete goal', target: 3000.05, incomeScope: 'all', windowMonths: 12,
  } },
  { label: 'Savings rate', detail: RATE_DETAIL, body: {
    type: 'savings-rate', name: 'Complete goal', targetPercent: 100, incomeScope: 'all', windowMonths: 3,
  } },
  { label: 'Category spending limit', detail: LIMIT_DETAIL, body: {
    type: 'category-spending-limit', name: 'Complete goal', category: 'transport', monthlyLimit: 450.05,
  } },
];

const change = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const inputCorrection = (control: HTMLInputElement, value: string, caret = 1) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(control, value);
  control.setSelectionRange(caret, caret);
  fireEvent.input(control);
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

  describe.each(['POST', 'PUT'] as const)('%s complete replacements', (method) => {
    it.each(bodyCases)('serializes every $body.type field and no presentation metadata', async ({ label, detail, body }) => {
      let written: unknown;
      const saved = vi.fn();
      mockFetch({
        ...baseRoutes,
        [`GET /api/goals/${detail.id}`]: () => ok(detail),
        [`${method} /api/goals${method === 'PUT' ? `/${detail.id}` : ''}`]: (init) => {
          written = JSON.parse(String(init?.body));
          return ok(detail, method === 'POST' ? 201 : 200);
        },
      });
      renderThemed(<GoalEditor goalId={method === 'POST' ? 'new' : detail.id} onClose={vi.fn()} onSaved={saved} />);
      if (method === 'POST') fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${label}`) }));
      else await screen.findByLabelText('Name');
      change('Name', ' Complete goal ');
      switch (body.type) {
        case 'financial-independence':
          change('Cost 1 name', ' Rent ');
          change('Monthly cost for Rent, row 1', ' 900.50 ');
          if (method === 'POST') fireEvent.click(screen.getByRole('button', { name: 'Add cost' }));
          change('Cost 2 name', 'Food');
          change('Monthly cost for Food, row 2', '300.40');
          fireEvent.click(screen.getByRole('button', { name: 'Add cost' }));
          change('Safety buffer, %', '100');
          change('Averaging period', '12');
          change(/Net hourly rate/, ' 25.50 ');
          change('Hours available per week (optional)', '8.25');
          break;
        case 'emergency-fund':
          change('Coverage months', '120');
          change(/Essential monthly amount/, '1000.05');
          for (const checkbox of screen.getAllByRole('checkbox')) {
            if ((checkbox as HTMLInputElement).checked) fireEvent.click(checkbox);
          }
          fireEvent.click(screen.getByRole('checkbox', { name: 'Cash · EUR' }));
          fireEvent.click(screen.getByRole('checkbox', { name: 'Loan · EUR' }));
          change('Target date (optional)', '2027-08-01');
          break;
        case 'savings-balance':
          change(/Target amount/, '5000.05');
          for (const checkbox of screen.getAllByRole('checkbox')) {
            if ((checkbox as HTMLInputElement).checked) fireEvent.click(checkbox);
          }
          fireEvent.click(screen.getByRole('checkbox', { name: 'USD cash · USD' }));
          change('Target date (optional)', '2027-08-01');
          break;
        case 'debt-payoff':
          if (method === 'POST') change('Debt account', 'debt');
          else expect(screen.getByLabelText('Debt account')).toBeDisabled();
          change(/Target remaining debt/, '');
          change('Target date (optional)', '2027-08-01');
          break;
        case 'monthly-income':
          change(/Monthly target/, '3000.05');
          change('Income', 'all');
          change('Averaging period', '12');
          break;
        case 'savings-rate':
          change('Target percentage', '100');
          change('Income', 'all');
          change('Averaging period', '3');
          break;
        case 'category-spending-limit':
          change('Category', 'transport');
          change(/Monthly limit/, '450.05');
          break;
      }
      fireEvent.click(screen.getByRole('button', { name: method === 'POST' ? 'Create goal' : 'Save' }));
      await waitFor(() => expect(saved).toHaveBeenCalledWith(detail));
      expect(written).toEqual(body);
      expect(requests().filter((request) => request.startsWith(`${method} `))).toHaveLength(1);
    });
  });

  it.each([
    { type: 'Monthly income', label: 'Monthly target (EUR)', raw: '12x', correction: '1200', message: 'Monthly target must be a positive number.' },
    { type: 'Emergency fund', label: 'Coverage months', raw: '1.5', correction: '6', message: 'Coverage months must be a whole number from 1 to 120.' },
    { type: 'Emergency fund', label: 'Essential monthly amount (EUR)', raw: 'NaN', correction: '1500', message: 'Essential monthly amount must be a positive number.' },
    { type: 'Savings balance', label: 'Target amount (EUR)', raw: ' -1 ', correction: '500', message: 'Target amount must be a positive number.' },
    { type: 'Debt payoff', label: 'Target remaining debt (EUR)', raw: '-1', correction: '', message: 'Target remaining debt must be zero or more.' },
    { type: 'Savings rate', label: 'Target percentage', raw: '101', correction: '100', message: 'Target percentage must be greater than 0 and at most 100.' },
    { type: 'Category spending limit', label: 'Monthly limit (EUR)', raw: 'Infinity', correction: '500', message: 'Monthly limit must be a positive number.' },
    { type: 'Financial independence', label: 'Safety buffer, %', raw: '101', correction: '', message: 'Safety buffer must be from 0 to 100.' },
    { type: 'Financial independence', label: 'Net hourly rate (EUR, optional)', raw: ' ', correction: '', message: 'Net hourly rate must be a positive number.' },
    { type: 'Financial independence', label: 'Hours available per week (optional)', raw: '0', correction: '10', message: 'Hours available per week must be a positive number.' },
  ])('associates raw $label refusals and corrects without moving focus or caret', async ({ type, label, raw, correction, message }) => {
    mockFetch(baseRoutes);
    renderThemed(<GoalEditor goalId="new" onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${type}`) }));
    change('Name', 'Draft');
    if (type === 'Financial independence') {
      change('Cost 1 name', 'Rent');
      change('Monthly cost for Rent, row 1', '900');
    }
    if (type === 'Emergency fund' && label === 'Coverage months') change(/Essential monthly amount/, '1000');
    const control = screen.getByLabelText(label) as HTMLInputElement;
    const id = control.id;
    const helper = control.getAttribute('aria-describedby');
    expect(id).not.toBe('');
    control.focus();
    change(label, raw);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create goal' }));
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    if (type === 'Financial independence') {
      expect(screen.getByRole('alert')).toHaveFocus();
      fireEvent.click(within(screen.getByRole('alert')).getByRole('link', { name: message }));
    }
    expect(control).toHaveFocus();
    expect(control).toHaveValue(raw);
    expect(control).toHaveAttribute('aria-invalid', 'true');
    expect(control.getAttribute('aria-describedby')?.split(' ')).toContain(`${id}-error`);
    expect(document.getElementById(`${id}-error`)).toHaveTextContent(message);
    expect(requests()).not.toContain('POST /api/goals');
    inputCorrection(control, correction, Math.min(1, correction.length));
    expect(screen.getByLabelText(label)).toBe(control);
    expect(control).toHaveFocus();
    expect(control.selectionStart).toBe(Math.min(1, correction.length));
    expect(control.id).toBe(id);
    expect(control).not.toHaveAttribute('aria-invalid');
    expect(document.getElementById(`${id}-error`)).not.toBeInTheDocument();
    expect(control.getAttribute('aria-describedby')).toBe(helper);
    expect(control).not.toHaveAttribute('required');
    expect(control).not.toHaveAttribute('min');
    expect(control).not.toHaveAttribute('max');
    expect(control).not.toHaveAttribute('pattern');
    expect(control.closest('form')).not.toHaveAttribute('novalidate');
  });

  it('focuses the first short-form refusal in predicate order only on submission', async () => {
    mockFetch(baseRoutes);
    renderThemed(<GoalEditor goalId="new" onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Monthly income/ }));
    const name = screen.getByLabelText('Name') as HTMLInputElement;
    const target = screen.getByLabelText('Monthly target (EUR)');
    target.focus();
    change('Name', '   ');
    change('Monthly target (EUR)', '0');
    fireEvent.click(screen.getByRole('button', { name: 'Create goal' }));
    expect(name).toHaveFocus();
    expect(name).toHaveValue('   ');
    expect(screen.getByRole('alert')).toHaveTextContent('Name is required.');
    inputCorrection(name, 'Name');
    expect(name).toHaveFocus();
    expect(name.selectionStart).toBe(1);
    expect(screen.getByRole('alert')).toHaveTextContent('Monthly target must be a positive number.');
    fireEvent.click(screen.getByRole('button', { name: 'Create goal' }));
    expect(target).toHaveFocus();
  });

  it.each(['Savings balance', 'Emergency fund'])('associates the %s account group and focuses its first available checkbox', async (type) => {
    mockFetch(baseRoutes);
    renderThemed(<GoalEditor goalId="new" onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${type}`) }));
    change('Name', 'Accounts');
    change(type === 'Savings balance' ? /Target amount/ : /Essential monthly amount/, '1000');
    fireEvent.click(screen.getByRole('button', { name: 'Create goal' }));
    const group = screen.getByRole('group', { name: 'Accounts' });
    const checkbox = screen.getByRole('checkbox', { name: 'Cash · EUR' });
    const id = group.id;
    expect(group).toHaveAttribute('aria-invalid', 'true');
    expect(checkbox).toHaveFocus();
    expect(checkbox).toHaveAttribute('aria-invalid', 'true');
    expect(checkbox.getAttribute('aria-describedby')?.split(' ')).toEqual([`${id}-help`, `${id}-error`]);
    expect(document.getElementById(`${id}-error`)).toHaveTextContent(/Choose at least one/);
    fireEvent.click(checkbox);
    expect(checkbox).toHaveFocus();
    expect(group).not.toHaveAttribute('aria-invalid');
    expect(checkbox).not.toHaveAttribute('aria-invalid');
    expect(checkbox).toHaveAttribute('aria-describedby', `${id}-help`);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('orients at an empty eligible account group instead of an unavailable focus target', async () => {
    mockFetch({ ...baseRoutes, 'GET /api/accounts': () => ok([]) });
    renderThemed(<GoalEditor goalId="new" onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Emergency fund/ }));
    change('Name', 'Emergency');
    change(/Essential monthly amount/, '1000');
    fireEvent.click(screen.getByRole('button', { name: 'Create goal' }));
    expect(screen.getByRole('group', { name: 'Accounts' })).toHaveFocus();
    expect(screen.getByRole('alert')).toHaveTextContent('Choose at least one funding account.');
  });

  it('targets a missing new debt selection after the debt amount passes validation', async () => {
    mockFetch(baseRoutes);
    renderThemed(<GoalEditor goalId="new" onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Debt payoff/ }));
    change('Name', 'Debt');
    change(/Target remaining debt/, '');
    fireEvent.click(screen.getByRole('button', { name: 'Create goal' }));
    const picker = screen.getByLabelText('Debt account');
    expect(picker).toHaveFocus();
    expect(picker).toHaveAttribute('aria-invalid', 'true');
    expect(document.getElementById(`${picker.id}-error`)).toHaveTextContent('Choose a debt account.');
    change('Debt account', 'debt');
    expect(picker).toHaveFocus();
    expect(picker).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('links ordered long-form issues without changing the URL hash, and updates correction without reorientation', async () => {
    window.history.replaceState(null, '', '/?screen=goal&goal=new#keep');
    mockFetch(baseRoutes);
    renderThemed(<GoalEditor goalId="new" onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Financial independence/ }));
    change('Safety buffer, %', '101');
    change('Monthly cost for row 1', 'bad');
    change('Net hourly rate (EUR, optional)', '-1');
    change('Hours available per week (optional)', '0');
    fireEvent.click(screen.getByRole('button', { name: 'Create goal' }));
    const summary = screen.getByRole('alert');
    expect(summary).toHaveFocus();
    const links = within(summary).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual([
      'Name is required.', 'Safety buffer must be from 0 to 100.', 'Every cost needs a name.',
      'Monthly cost for  must be a positive number.', 'Net hourly rate must be a positive number.',
      'Hours available per week must be a positive number.',
    ]);
    for (const link of links) {
      const target = document.getElementById(link.getAttribute('href')!.slice(1));
      expect(target).toBeVisible();
      fireEvent.click(link);
      expect(target).toHaveFocus();
      expect(window.location.hash).toBe('#keep');
    }
    const hours = screen.getByLabelText('Hours available per week (optional)') as HTMLInputElement;
    inputCorrection(hours, '10');
    expect(hours).toHaveFocus();
    expect(hours.selectionStart).toBe(1);
    expect(within(summary).queryByRole('link', { name: 'Hours available per week must be a positive number.' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(requests()).not.toContain('POST /api/goals');
  });

  it('keeps keyed cost/control/help/error identities as rows are added, renamed and removed, with deliberate removal focus', async () => {
    mockFetch(baseRoutes);
    renderThemed(<GoalEditor goalId="new" onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Financial independence/ }));
    change('Name', 'Costs');
    const first = screen.getByLabelText('Cost 1 name');
    const firstId = first.id;
    const add = screen.getByRole('button', { name: 'Add cost' });
    expect(add).toHaveClass('action-button--secondary');
    expect(screen.getByRole('button', { name: 'Delete row 1' })).toHaveClass('action-button--destructive-secondary');
    fireEvent.click(add);
    const second = screen.getByLabelText('Cost 2 name');
    const secondId = second.id;
    expect(second).toHaveFocus();
    change('Cost 2 name', 'Rent');
    const amount = screen.getByLabelText('Monthly cost for Rent, row 2') as HTMLInputElement;
    const amountId = amount.id;
    expect(amount).toHaveAttribute('aria-describedby', `${amountId}-help`);
    change('Monthly cost for Rent, row 2', 'bad');
    fireEvent.click(screen.getByRole('button', { name: 'Create goal' }));
    expect(amount).toHaveAttribute('aria-describedby', `${amountId}-help ${amountId}-error`);
    fireEvent.click(screen.getByRole('button', { name: 'Delete row 1' }));
    expect(screen.getByLabelText('Cost 1 name')).toBe(second);
    expect(second).toHaveFocus();
    expect(second.id).toBe(secondId);
    expect(document.getElementById(firstId)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Monthly cost for Rent, row 1')).toBe(amount);
    expect(amount.id).toBe(amountId);
    expect(amount).toHaveAttribute('aria-describedby', `${amountId}-help ${amountId}-error`);
    change('Cost 1 name', 'Housing');
    expect(screen.getByLabelText('Monthly cost for Housing, row 1')).toBe(amount);
    fireEvent.click(add);
    const last = screen.getByLabelText('Cost 2 name');
    expect(last).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Delete row 2' }));
    expect(second).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Housing, row 1' }));
    expect(add).toHaveFocus();
    expect(screen.queryByLabelText('Cost 1 name')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create goal' }));
    const summary = screen.getByRole('alert');
    expect(summary).toHaveFocus();
    const remedy = within(summary).getByRole('link', { name: 'Add at least one essential monthly cost.' });
    expect(remedy).toHaveAttribute('href', `#${add.id}`);
    fireEvent.click(remedy);
    expect(add).toHaveFocus();
    expect(add).toHaveAttribute('aria-describedby', `${add.id}-error`);
    fireEvent.click(add);
    expect(screen.getByLabelText('Cost 1 name')).toHaveFocus();
    expect(screen.getByLabelText('Cost 1 name').id).not.toBe(secondId);
  });

  it('associates duplicate cost names with the repeated name rather than parsing its sentence', async () => {
    mockFetch({ ...baseRoutes, 'GET /api/goals/goal-fi': () => ok(FINANCIAL_DETAIL) });
    renderThemed(<GoalEditor goalId="goal-fi" onClose={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByLabelText('Cost 1 name');
    change('Cost 2 name', ' rent ');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const first = screen.getByLabelText('Cost 1 name');
    const duplicate = screen.getByLabelText('Cost 2 name') as HTMLInputElement;
    expect(first).not.toHaveAttribute('aria-invalid');
    expect(duplicate).toHaveAttribute('aria-invalid', 'true');
    const link = within(screen.getByRole('alert')).getByRole('link', { name: 'Cost names must be unique.' });
    expect(link).toHaveAttribute('href', `#${duplicate.id}`);
    fireEvent.click(link);
    inputCorrection(duplicate, 'Food');
    expect(duplicate).toHaveFocus();
    expect(duplicate.selectionStart).toBe(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each(['name', 'monthly', 'duplicate'])('exposes hidden retained-cost %s errors through Target basis and restores keyed correction controls', async (invalid) => {
    mockFetch({ ...baseRoutes, 'GET /api/goals/goal-fi': () => ok(FINANCIAL_DETAIL) });
    renderThemed(<GoalEditor goalId="goal-fi" onClose={vi.fn()} onSaved={vi.fn()} />);
    const name = await screen.findByLabelText('Cost 1 name');
    const amount = screen.getByLabelText('Monthly cost for Rent, row 1');
    const ids = [name.id, amount.id];
    if (invalid === 'name') change('Cost 1 name', '  ');
    if (invalid === 'monthly') change('Monthly cost for Rent, row 1', 'bad');
    if (invalid === 'duplicate') change('Cost 2 name', 'Rent');
    change('Target basis', 'current-spending');
    expect(screen.queryByLabelText('Cost 1 name')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const basis = screen.getByLabelText('Target basis');
    const summary = screen.getByRole('alert');
    expect(summary).toHaveFocus();
    expect(basis).toHaveAttribute('aria-invalid', 'true');
    expect(document.getElementById(`${basis.id}-error`)).toHaveTextContent('Switch Target basis to Essential costs to correct the retained costs.');
    for (const link of within(summary).getAllByRole('link')) {
      expect(link).toHaveAttribute('href', `#${basis.id}`);
      expect(document.getElementById(link.getAttribute('href')!.slice(1))).toBeVisible();
      fireEvent.click(link);
      expect(basis).toHaveFocus();
    }
    expect(requests()).not.toContain('PUT /api/goals/goal-fi');
    change('Target basis', 'essential-costs');
    expect(basis).toHaveFocus();
    expect(screen.getByLabelText('Cost 1 name').id).toBe(ids[0]);
    const monthly = screen.getByLabelText(invalid === 'name' ? 'Monthly cost for row 1' : 'Monthly cost for Rent, row 1');
    expect(monthly.id).toBe(ids[1]);
    expect(basis).not.toHaveAttribute('aria-invalid');
    const correction = invalid === 'name' ? screen.getByLabelText('Cost 1 name') : invalid === 'duplicate' ? screen.getByLabelText('Cost 2 name') : monthly;
    expect(correction).toHaveAttribute('aria-invalid', 'true');
    fireEvent.click(within(summary).getAllByRole('link')[0]);
    expect(correction).toHaveFocus();
    inputCorrection(correction as HTMLInputElement, invalid === 'name' ? 'Rent' : invalid === 'duplicate' ? 'Food' : '900');
    expect(correction).toHaveFocus();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each(['POST', 'PUT'] as const)('preserves valid hidden costs, empty buffer coercion and optional nulls in %s bodies', async (method) => {
    let body: unknown;
    const saved = vi.fn();
    mockFetch({
      ...baseRoutes,
      'GET /api/goals/goal-fi': () => ok(FINANCIAL_DETAIL),
      [`${method} /api/goals${method === 'PUT' ? '/goal-fi' : ''}`]: (init) => {
        body = JSON.parse(String(init?.body));
        return ok(FINANCIAL_DETAIL);
      },
    });
    renderThemed(<GoalEditor goalId={method === 'POST' ? 'new' : 'goal-fi'} onClose={vi.fn()} onSaved={saved} />);
    if (method === 'POST') {
      fireEvent.click(await screen.findByRole('button', { name: /^Financial independence/ }));
      change('Name', 'Independent');
      change('Cost 1 name', 'Rent');
      change('Monthly cost for Rent, row 1', '900');
      fireEvent.click(screen.getByRole('button', { name: 'Add cost' }));
      change('Cost 2 name', 'Food');
      change('Monthly cost for Food, row 2', '300');
    } else await screen.findByLabelText('Cost 1 name');
    change('Safety buffer, %', '');
    change('Target basis', 'current-spending');
    fireEvent.click(screen.getByRole('button', { name: method === 'POST' ? 'Create goal' : 'Save' }));
    await waitFor(() => expect(saved).toHaveBeenCalled());
    expect(body).toEqual({
      type: 'financial-independence', name: 'Independent', basis: 'current-spending', bufferPct: 0, windowMonths: 6,
      hourlyRate: null, hoursPerWeek: null, essentialCosts: [{ label: 'Rent', monthly: 900 }, { label: 'Food', monthly: 300 }],
    });
  });

  it('permits current spending with no costs and ignores entirely blank cost rows', async () => {
    let body: unknown;
    mockFetch({ ...baseRoutes, 'POST /api/goals': (init) => { body = JSON.parse(String(init?.body)); return ok(FINANCIAL_DETAIL); } });
    renderThemed(<GoalEditor goalId="new" onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Financial independence/ }));
    change('Name', 'Current');
    change('Target basis', 'current-spending');
    fireEvent.click(screen.getByRole('button', { name: 'Create goal' }));
    await screen.findByRole('heading', { name: 'Goal saved' });
    expect(body).toEqual({ type: 'financial-independence', name: 'Current', basis: 'current-spending', bufferPct: 10, windowMonths: 6, hourlyRate: null, hoursPerWeek: null, essentialCosts: [] });
  });

  it.each([0, 1, 24, 25])('retains saved averaging period %s and its existing bounds without native constraints', async (windowMonths) => {
    let body: unknown;
    mockFetch({
      ...baseRoutes, 'GET /api/goals/goal-income': () => ok({ ...monthlyDetail, windowMonths }),
      'PUT /api/goals/goal-income': (init) => { body = JSON.parse(String(init?.body)); return ok(monthlyDetail); },
    });
    renderThemed(<GoalEditor goalId="goal-income" onClose={vi.fn()} onSaved={vi.fn()} />);
    const period = await screen.findByLabelText('Averaging period');
    expect(period).toHaveValue(String(windowMonths));
    expect(within(period).getByRole('option', { name: `${windowMonths} months` })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    if (windowMonths === 0 || windowMonths === 25) {
      expect(period).toHaveFocus();
      expect(period).toHaveAttribute('aria-invalid', 'true');
      expect(document.getElementById(`${period.id}-error`)).toHaveTextContent('Averaging period must be a whole number from 1 to 24.');
      expect(requests()).not.toContain('PUT /api/goals/goal-income');
    } else {
      await screen.findByRole('heading', { name: 'Goal saved' });
      expect(body).toEqual({ type: 'monthly-income', name: 'Income', target: 3000, incomeScope: 'own', windowMonths });
    }
  });

  it('leaves unidentified server refusals in the footer without marking fields or stealing focus', async () => {
    let resolve!: (response: Response) => void;
    mockFetch({
      ...baseRoutes, 'GET /api/goals/goal-income': () => ok(monthlyDetail),
      'PUT /api/goals/goal-income': () => new Promise<Response>((done) => { resolve = done; }),
    });
    renderThemed(<GoalEditor goalId="goal-income" onClose={vi.fn()} onSaved={vi.fn()} />);
    const name = await screen.findByLabelText('Name') as HTMLInputElement;
    name.focus();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await act(async () => resolve(fail(409, { error: 'Name and target need server review' })));
    const alert = await screen.findByRole('alert');
    expect(alert.closest('.sheet-footer')).not.toBeNull();
    expect(alert.closest('form')).toBeNull();
    expect(name).toHaveFocus();
    expect(name).not.toHaveAttribute('aria-invalid');
    expect(screen.getByLabelText('Monthly target (EUR)')).not.toHaveAttribute('aria-invalid');
    inputCorrection(name, 'Edited');
    expect(name).toHaveFocus();
    expect(name.selectionStart).toBe(1);
    expect(alert).toHaveTextContent('Name and target need server review');
  });


  it.each([
    { type: 'Emergency fund', label: 'Coverage months', raw: '0', message: 'Coverage months must be a whole number from 1 to 120.' },
    { type: 'Emergency fund', label: 'Coverage months', raw: '121', message: 'Coverage months must be a whole number from 1 to 120.' },
    { type: 'Emergency fund', label: 'Coverage months', raw: '120.5', message: 'Coverage months must be a whole number from 1 to 120.' },
    { type: 'Savings rate', label: 'Target percentage', raw: '0', message: 'Target percentage must be greater than 0 and at most 100.' },
    { type: 'Savings rate', label: 'Target percentage', raw: '-1', message: 'Target percentage must be greater than 0 and at most 100.' },
    { type: 'Savings rate', label: 'Target percentage', raw: 'NaN', message: 'Target percentage must be greater than 0 and at most 100.' },
    { type: 'Financial independence', label: 'Safety buffer, %', raw: '-1', message: 'Safety buffer must be from 0 to 100.' },
    { type: 'Financial independence', label: 'Safety buffer, %', raw: 'Infinity', message: 'Safety buffer must be from 0 to 100.' },
    { type: 'Debt payoff', label: 'Target remaining debt (EUR)', raw: 'NaN', message: 'Target remaining debt must be zero or more.' },
  ])('preserves $type bounds and raw $label = $raw', async ({ type, label, raw, message }) => {
    mockFetch(baseRoutes);
    renderThemed(<GoalEditor goalId="new" onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${type}`) }));
    change('Name', 'Bounds');
    change(label, raw);
    fireEvent.click(screen.getByRole('button', { name: 'Create goal' }));
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(screen.getByLabelText(label)).toHaveValue(raw);
    expect(screen.getByLabelText(label)).toHaveAttribute('aria-invalid', 'true');
    expect(requests()).not.toContain('POST /api/goals');
  });

  it('uses typed cost metadata even when its user-provided name resembles another field error', async () => {
    mockFetch(baseRoutes);
    renderThemed(<GoalEditor goalId="new" onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Financial independence/ }));
    change('Name', 'Typed ownership');
    change('Cost 1 name', 'Name is required. Safety buffer');
    const amount = screen.getByLabelText('Monthly cost for Name is required. Safety buffer, row 1');
    fireEvent.change(amount, { target: { value: 'bad' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create goal' }));
    const summary = screen.getByRole('alert');
    const link = within(summary).getByRole('link', { name: 'Monthly cost for Name is required. Safety buffer must be a positive number.' });
    expect(link).toHaveAttribute('href', `#${amount.id}`);
    fireEvent.click(link);
    expect(amount).toHaveFocus();
    expect(screen.getByLabelText('Name')).not.toHaveAttribute('aria-invalid');
    expect(screen.getByLabelText('Safety buffer, %')).not.toHaveAttribute('aria-invalid');
    expect(screen.getByLabelText('Cost 1 name')).not.toHaveAttribute('aria-invalid');
  });

  it.each(['accounts', 'settings', 'goal'] as const)('retries the entire dependency set after a partial %s refusal and waits for the complete replacement', async (failed) => {
    const reads = { accounts: 0, settings: 0, goal: 0 };
    let resolveAccounts!: (response: Response) => void;
    const saved: GoalDetail = { ...SAVINGS_DETAIL, name: 'Reloaded', currency: 'USD', accountIds: ['acc-2'] };
    mockFetch({
      'GET /api/accounts': () => {
        const attempt = ++reads.accounts;
        if (attempt === 1 && failed === 'accounts') return fail(500, { error: 'dependency refused' });
        if (attempt === 2) return new Promise<Response>((done) => { resolveAccounts = done; });
        return ok(ACCOUNTS);
      },
      'GET /api/app-settings': () => {
        const attempt = ++reads.settings;
        if (attempt === 1 && failed === 'settings') return fail(500, { error: 'dependency refused' });
        return ok(attempt === 1 ? APP_SETTINGS : { ...APP_SETTINGS, baseCurrency: 'USD' });
      },
      'GET /api/goals/goal-savings': () => {
        const attempt = ++reads.goal;
        if (attempt === 1 && failed === 'goal') return fail(500, { error: 'dependency refused' });
        return ok(attempt === 1 ? SAVINGS_DETAIL : saved);
      },
    });
    renderThemed(<GoalEditor goalId="goal-savings" onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('dependency refused');
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByText('Loading goal…')).toBeVisible();
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
    await waitFor(() => expect(reads).toEqual({ accounts: 2, settings: 2, goal: 2 }));
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    await act(async () => resolveAccounts(ok(ACCOUNTS)));
    expect(await screen.findByLabelText('Name')).toHaveValue('Reloaded');
    expect(screen.getByLabelText('Target amount (USD)')).toHaveValue('9000');
    expect(screen.getByRole('checkbox', { name: 'USD cash · USD' })).toBeChecked();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([404, 409])('ignores an old save refusal %s after a newer opening has its own validation and focus', async (status) => {
    let resolve!: (response: Response) => void;
    const close = vi.fn();
    const missing = vi.fn();
    const saved = vi.fn();
    mockFetch({
      ...baseRoutes, 'GET /api/goals/goal-savings': () => ok(SAVINGS_DETAIL),
      'PUT /api/goals/goal-savings': () => new Promise<Response>((done) => { resolve = done; }),
    });
    const { rerender } = renderThemed(<GoalEditor goalId="goal-savings" onClose={close} onMissing={missing} onSaved={saved} />);
    await screen.findByLabelText('Name');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    rerender(<ThemeProvider><GoalEditor goalId="new" onClose={close} onMissing={missing} onSaved={saved} /></ThemeProvider>);
    fireEvent.click(await screen.findByRole('button', { name: /^Monthly income/ }));
    change('Name', 'New draft');
    change('Monthly target (EUR)', 'bad');
    fireEvent.click(screen.getByRole('button', { name: 'Create goal' }));
    const target = screen.getByLabelText('Monthly target (EUR)');
    expect(target).toHaveFocus();
    await act(async () => resolve(fail(status, { error: 'old opening refusal' })));
    expect(screen.getByRole('alert')).toHaveTextContent('Monthly target must be a positive number.');
    expect(target).toHaveFocus();
    expect(target).toHaveValue('bad');
    expect(screen.getByLabelText('Name')).toHaveValue('New draft');
    expect(missing).not.toHaveBeenCalled();
    expect(saved).not.toHaveBeenCalled();
    expect(requests()).not.toContain('POST /api/goals');
  });


});
