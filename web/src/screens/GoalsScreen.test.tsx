import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SAVINGS_GOAL } from '../test/fixtures';
import { fail, mockFetch, ok, renderThemed, requests } from '../test/harness';
import type { GoalSummary } from '../types';
import { GoalsScreen } from './GoalsScreen';

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
    renderThemed(<GoalsScreen />);

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
    mockFetch({ 'GET /api/goals': () => ok({ goals: [] }) });
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
    expect(within(cards[1]).getByText('75% used')).toBeVisible();
    expect(within(cards[1]).getByText('Forecast to exceed the limit this month.')).toBeVisible();
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
    expect(screen.getByText(/Edit this goal/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
  });

  it('keeps the confirmation open with the server error when delete fails', async () => {
    mockFetch({
      'GET /api/goals': () => ok({ goals: [SAVINGS_GOAL] }),
      'DELETE /api/goals/goal-savings': () => fail(500, { error: 'database busy' }),
    });
    renderThemed(<GoalsScreen />);
    await screen.findByRole('heading', { name: 'Emergency savings' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete goal' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('No goals yet.')).toBeVisible();
  });
});
