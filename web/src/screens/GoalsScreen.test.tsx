import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ACCOUNTS, APP_SETTINGS, SAVINGS_GOAL } from '../test/fixtures';
import { fail, mockFetch, ok, renderThemed, requests } from '../test/harness';
import type { GoalSummary } from '../types';
import { GoalsScreen } from './GoalsScreen';

const financialGoal = {
  ...SAVINGS_GOAL,
  id: 'goal-independence',
  type: 'financial-independence',
  name: 'Financial independence',
  source: '2 complete months · Essential costs + 10% buffer',
  supportExcluded: 0,
  workHoursLeft: 10,
  workHoursCapacityPerMonth: 4.33,
  workHoursCapacityExceeded: true,
  progress: {
    ...SAVINGS_GOAL.progress,
    unit: 'money-per-month',
    target: 1100,
    current: 900,
    remaining: 200,
    percentage: 81.82,
    period: { kind: 'complete-months', from: '2025-11-01', to: '2026-04-30', monthsUsed: 2 },
  },
} satisfies GoalSummary;

const categoryGoal: GoalSummary = {
  ...SAVINGS_GOAL,
  id: 'goal-food',
  type: 'category-spending-limit',
  name: 'Food limit',
  category: 'food',
  source: 'Current calendar month',
  progress: {
    ...SAVINGS_GOAL.progress,
    semantic: 'used',
    unit: 'money-per-month',
    target: 400,
    current: 300,
    remaining: 100,
    percentage: 75,
    forecast: 620,
    status: 'at-risk',
    period: { kind: 'current-month', from: '2026-05-01', to: '2026-05-15', monthsUsed: null },
  },
};

describe('GoalsScreen', () => {
  it('keeps the heading visible and New goal disabled while the list is unresolved', () => {
    mockFetch({ 'GET /api/goals': () => new Promise<Response>(() => {}) });
    const { container } = renderThemed(<GoalsScreen />);

    expect(container.querySelector('section.screen-inner')).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Goals' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'New goal' })).toBeDisabled();
    expect(screen.getByText('Loading goals…')).toBeVisible();
    expect(screen.queryByText('No goals yet.')).not.toBeInTheDocument();
  });

  it('shows a retryable load failure without claiming the list is empty', async () => {
    let attempts = 0;
    mockFetch({
      'GET /api/goals': () => {
        attempts++;
        return attempts === 1 ? fail(500, { error: 'database unavailable' }) : ok({ goals: [] });
      },
    });
    renderThemed(<GoalsScreen />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Couldn’t load goals: database unavailable',
    );
    expect(screen.queryByText('No goals yet.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No goals yet.')).toBeVisible();
    expect(requests()).toEqual(['GET /api/goals', 'GET /api/goals']);
  });

  it('renders the dedicated empty state and writes the create location', async () => {
    mockFetch({
      'GET /api/goals': () => ok({ goals: [] }),
      'GET /api/accounts': () => ok(ACCOUNTS),
      'GET /api/app-settings': () => ok(APP_SETTINGS),
    });
    renderThemed(<GoalsScreen />);

    expect(await screen.findByText('No goals yet.')).toBeVisible();
    expect(screen.getByText('Create one to track progress from your financial data.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Create a goal' }));
    expect(new URLSearchParams(window.location.search).get('goal')).toBe('new');
  });

  it('renders card figures, semantics, source lines and actionable status', async () => {
    mockFetch({ 'GET /api/goals': () => ok({ goals: [SAVINGS_GOAL, categoryGoal] }) });
    renderThemed(<GoalsScreen />);

    await screen.findByRole('heading', { name: 'Emergency savings' });
    const cards = screen.getAllByRole('article');
    expect(cards).toHaveLength(2);
    expect(within(cards[0]).getByRole('heading', { name: 'Emergency savings' })).toBeVisible();
    expect(within(cards[0]).getByText('9,000 EUR')).toBeVisible();
    expect(within(cards[0]).getByText('60% of target')).toBeVisible();
    const savingsProgress = within(cards[0]).getByRole('progressbar', { name: '60% of target' });
    expect(savingsProgress).toHaveAttribute('aria-valuemin', '0');
    expect(savingsProgress).toHaveAttribute('aria-valuemax', '100');
    expect(savingsProgress).toHaveAttribute('aria-valuenow', '60');
    expect(within(cards[1]).getByText('75% used')).toBeVisible();
    expect(within(cards[1]).getByRole('progressbar', { name: '75% used' })).toHaveAttribute(
      'aria-valuenow',
      '75',
    );
    expect(within(cards[1]).getByText('Forecast to exceed the limit this month.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Edit Emergency savings' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Delete Emergency savings' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Edit Food limit' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Delete Food limit' })).toBeVisible();
  });

  it('renders the server-computed work-hours capacity without deriving it', async () => {
    mockFetch({ 'GET /api/goals': () => ok({ goals: [financialGoal] }) });
    renderThemed(<GoalsScreen />);

    expect(
      await screen.findByText(
        'Left: 200 EUR/mo · about 10 work hours/month · exceeds 4.33 available hours/month',
      ),
    ).toBeVisible();
  });

  it('keeps an unavailable goal and its actions visible', async () => {
    const unavailable: GoalSummary = {
      ...SAVINGS_GOAL,
      progress: {
        ...SAVINGS_GOAL.progress,
        current: null,
        remaining: null,
        overBy: null,
        percentage: null,
        status: 'account-unavailable',
      },
    };
    mockFetch({ 'GET /api/goals': () => ok({ goals: [unavailable] }) });
    renderThemed(<GoalsScreen />);

    expect(await screen.findByRole('heading', { name: 'Emergency savings' })).toBeVisible();
    expect(screen.getByText('Account unavailable')).toBeVisible();
    expect(screen.getByRole('progressbar', { name: 'Account unavailable' })).not.toHaveAttribute(
      'aria-valuenow',
    );
    expect(screen.getByText(/Edit this goal/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Edit Emergency savings' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Delete Emergency savings' })).toBeEnabled();
  });

  it('gives an unavailable debt goal a recovery action the editor can perform', async () => {
    const unavailableDebt: GoalSummary = {
      ...SAVINGS_GOAL,
      id: 'goal-debt',
      type: 'debt-payoff',
      name: 'Card balance',
      progress: {
        ...SAVINGS_GOAL.progress,
        current: null,
        remaining: null,
        overBy: null,
        percentage: null,
        status: 'account-unavailable',
      },
    };
    mockFetch({ 'GET /api/goals': () => ok({ goals: [unavailableDebt] }) });
    renderThemed(<GoalsScreen />);

    expect(
      await screen.findByText('The debt account was removed. Create a new goal to track another debt.'),
    ).toBeVisible();
    expect(screen.queryByText(/Edit this goal/)).not.toBeInTheDocument();
  });

  it('keeps the confirmation open with the server error when delete fails', async () => {
    mockFetch({
      'GET /api/goals': () => ok({ goals: [SAVINGS_GOAL] }),
      'DELETE /api/goals/goal-savings': () => fail(500, { error: 'database busy' }),
    });
    renderThemed(<GoalsScreen />);
    await screen.findByRole('heading', { name: 'Emergency savings' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete Emergency savings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete goal' }));

    expect(await screen.findByText('database busy')).toBeVisible();
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Emergency savings' })).toBeVisible();
  });

  it('reloads after a successful delete', async () => {
    let reads = 0;
    mockFetch({
      'GET /api/goals': () => ok({ goals: reads++ === 0 ? [SAVINGS_GOAL] : [] }),
      'DELETE /api/goals/goal-savings': () => ok({ deleted: true, id: 'goal-savings' }),
    });
    renderThemed(<GoalsScreen />);
    await screen.findByRole('heading', { name: 'Emergency savings' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete Emergency savings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete goal' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('No goals yet.')).toBeVisible();
  });
});
