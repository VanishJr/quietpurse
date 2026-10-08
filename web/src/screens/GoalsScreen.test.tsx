import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ACCOUNTS, APP_SETTINGS, SAVINGS_GOAL } from '../test/fixtures';
import { fail, mockFetch, ok, renderThemed, requests } from '../test/harness';
import type { GoalSummary } from '../types';
import { GoalsScreen } from './GoalsScreen';
import { ScreenShown } from '../screen';
import { ThemeProvider } from '../theme';
import { setUrl } from '../url';

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
  it('replaces Delete with the URL editor across Back and Forward without retaining modal locks', async () => {
    window.history.replaceState(null, '', '/?screen=goal');
    mockFetch({
      'GET /api/goals': () => ok({ goals: [SAVINGS_GOAL] }),
      'GET /api/accounts': () => ok(ACCOUNTS),
      'GET /api/app-settings': () => ok(APP_SETTINGS),
      [`GET /api/goals/${SAVINGS_GOAL.id}`]: () => ok({
        ...SAVINGS_GOAL, type: 'savings-balance', target: 15000, accountIds: ['acc-1'], targetDate: null,
      }),
    });
    renderThemed(<div className="screen"><GoalsScreen /></div>);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Emergency savings' }));
    await screen.findByRole('textbox', { name: 'Name' });
    act(() => window.history.back());
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Delete Emergency savings' }));
    expect(document.body.style.overflow).toBe('hidden');
    act(() => window.history.forward());
    await screen.findByRole('textbox', { name: 'Name' });
    await waitFor(() => expect(screen.getAllByRole('dialog', { hidden: true })).toHaveLength(1));
    expect(screen.getByRole('dialog', { name: 'Edit goal' })).toBeVisible();
    expect(document.body.style.overflow).toBe('hidden');
    expect(document.querySelector<HTMLElement>('.screen')?.style.overflow).toBe('hidden');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.body.style.overflow).toBe('');
    expect(document.querySelector<HTMLElement>('.screen')?.style.overflow).toBe('');
    expect(document.querySelector('[inert]')).toBeNull();
    expect(requests().some((request) => request.startsWith('DELETE '))).toBe(false);
    const returned = new Promise<void>((resolve) => window.addEventListener('popstate', () => resolve(), { once: true }));
    act(() => window.history.back());
    await act(async () => { await returned; });
    expect(window.location.search).toBe('?screen=goal');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('refreshes a committed hidden save without closing a newer goal selection', async () => {
    window.history.replaceState(null, '', '/?screen=goal&goal=goal-savings');
    const savings = { ...SAVINGS_GOAL, type: 'savings-balance', target: 9000, accountIds: ['acc-1'] };
    const income = { ...SAVINGS_GOAL, id: 'goal-income', type: 'monthly-income', name: 'Income',
      target: 3000, incomeScope: 'own', windowMonths: 6 };
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>((finish) => { resolve = finish; });
    mockFetch({
      'GET /api/goals': () => ok({ goals: [savings, income] }),
      'GET /api/accounts': () => ok(ACCOUNTS),
      'GET /api/app-settings': () => ok(APP_SETTINGS),
      'GET /api/goals/goal-savings': () => ok(savings),
      'GET /api/goals/goal-income': () => ok(income),
      'PUT /api/goals/goal-savings': () => pending,
    });
    const view = (shown: boolean) => <ScreenShown value={shown}><div className="screen" hidden={!shown}><GoalsScreen /></div></ScreenShown>;
    const { rerender } = renderThemed(view(true));
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Updated savings' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    rerender(<ThemeProvider>{view(false)}</ThemeProvider>);
    act(() => setUrl({ goal: 'goal-income' }));
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Income'));
    await act(async () => { resolve(ok(savings)); });
    expect(new URLSearchParams(window.location.search).get('goal')).toBe('goal-income');
    expect(screen.getByLabelText('Name')).toHaveValue('Income');
    expect(requests().filter((request) => request === 'GET /api/goals')).toHaveLength(2);
    expect(requests().filter((request) => request === 'PUT /api/goals/goal-savings')).toHaveLength(1);
  });

  it('recovers focus when a delayed first-goal refresh removes the empty-state opener', async () => {
    let reads = 0;
    let finish!: (response: Response) => void;
    const saved = { ...SAVINGS_GOAL, type: 'monthly-income', name: 'Salary target', target: 3000, incomeScope: 'own', windowMonths: 6 };
    mockFetch({
      'GET /api/goals': () => ++reads === 1 ? ok({ goals: [] }) : new Promise<Response>((resolve) => { finish = resolve; }),
      'GET /api/accounts': () => ok(ACCOUNTS),
      'GET /api/app-settings': () => ok(APP_SETTINGS),
      'POST /api/goals': () => ok(saved),
    });
    renderThemed(<GoalsScreen />);
    const opener = await screen.findByRole('button', { name: 'Create a goal' });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(await screen.findByRole('button', { name: /^Monthly income/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Salary target' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Monthly target (EUR)' }), { target: { value: '3000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create goal' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
    await act(async () => finish(ok({ goals: [saved] })));
    await screen.findByRole('button', { name: 'Edit Salary target' });
    expect(screen.getByRole('heading', { name: 'Goals' })).toHaveFocus();
  });

  it('keeps post-save focus recovery through a failed refresh and a successful Retry', async () => {
    let reads = 0;
    let finish!: (response: Response) => void;
    const saved = { ...SAVINGS_GOAL, type: 'monthly-income', name: 'Salary target', target: 3000, incomeScope: 'own', windowMonths: 6 };
    mockFetch({
      'GET /api/goals': () => {
        reads++;
        if (reads === 1) return ok({ goals: [] });
        if (reads === 2) return fail(500, { error: 'refresh failed' });
        return new Promise<Response>((resolve) => { finish = resolve; });
      },
      'GET /api/accounts': () => ok(ACCOUNTS),
      'GET /api/app-settings': () => ok(APP_SETTINGS),
      'POST /api/goals': () => ok(saved),
    });
    renderThemed(<GoalsScreen />);
    const opener = await screen.findByRole('button', { name: 'Create a goal' });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(await screen.findByRole('button', { name: /^Monthly income/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Salary target' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Monthly target (EUR)' }), { target: { value: '3000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create goal' }));
    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(opener).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Goals' })).toHaveFocus();
    retry.focus();
    fireEvent.click(retry);
    expect(screen.getByRole('heading', { name: 'Goals' })).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    await act(async () => finish(ok({ goals: [saved] })));
    await screen.findByRole('button', { name: 'Edit Salary target' });
    expect(screen.getByRole('heading', { name: 'Goals' })).toHaveFocus();
    expect(requests().filter((request) => request === 'POST /api/goals')).toHaveLength(1);
  });

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
    expect(screen.queryByRole('button', { name: 'New goal' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create a goal' })).toHaveClass('action-button--primary');
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

  it('keeps goal-only consequences and secondary Cancel before final destructive confirmation', async () => {
    mockFetch({ 'GET /api/goals': () => ok({ goals: [SAVINGS_GOAL] }) });
    renderThemed(<GoalsScreen />);
    await screen.findByRole('heading', { name: 'Emergency savings' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete Emergency savings' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(within(dialog).getByText('This removes the goal only. Accounts and transactions are unchanged.')).toBeVisible();
    const actions = within(dialog).getAllByRole('button').filter((button) => button.getAttribute('aria-label') !== 'Close dialog');
    expect(actions.map((button) => button.textContent)).toEqual(['Cancel', 'Delete goal']);
    expect(actions[0]).toHaveClass('action-button--secondary');
    expect(actions[1]).toHaveClass('action-button--destructive-primary');
    expect(actions[1]).not.toHaveClass('btn', 'btn-danger');
    expect(actions.map((button) => button.getAttribute('type'))).toEqual(['button', 'button']);
    fireEvent.click(actions[0]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(requests()).toEqual(['GET /api/goals']);
  });

  it('keeps deletion pending identity, blocks duplicates and dismissal, then retains a failed draft', async () => {
    let finish!: (response: Response) => void;
    mockFetch({
      'GET /api/goals': () => ok({ goals: [SAVINGS_GOAL] }),
      'DELETE /api/goals/goal-savings': () => new Promise<Response>((resolve) => { finish = resolve; }),
    });
    renderThemed(<GoalsScreen />);
    await screen.findByRole('heading', { name: 'Emergency savings' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete Emergency savings' }));
    const remove = screen.getByRole('button', { name: 'Delete goal' });
    remove.focus();
    fireEvent.click(remove);

    expect(remove).toHaveFocus();
    expect(remove).toHaveAttribute('aria-busy', 'true');
    expect(remove).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Deleting goal…');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    fireEvent.click(remove);
    fireEvent.click(remove, { detail: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(remove, { key: 'Escape' });
    fireEvent.click(document.querySelector('.backdrop')!);
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(requests()).toEqual(['GET /api/goals', 'DELETE /api/goals/goal-savings']);

    finish(fail(500, { error: 'database busy' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('database busy');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(remove).not.toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(requests()).toEqual(['GET /api/goals', 'DELETE /api/goals/goal-savings']);
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

  it.each([false, true])('recovers post-delete orientation after delayed replacement without stealing a user-selected control (chosen: %s)', async (chosen) => {
    let deleted = false;
    let resolve!: (response: Response) => void;
    const refresh = new Promise<Response>((finish) => { resolve = finish; });
    mockFetch({
      'GET /api/goals': () => deleted ? refresh : ok({ goals: [SAVINGS_GOAL, categoryGoal] }),
      'DELETE /api/goals/goal-savings': () => { deleted = true; return ok({ deleted: true, id: 'goal-savings' }); },
    });
    renderThemed(<div className="screen"><GoalsScreen /></div>);
    const opener = await screen.findByRole('button', { name: 'Delete Emergency savings' });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('button', { name: 'Delete goal' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const heading = screen.getByRole('heading', { name: 'Goals' });
    expect(opener).toBeDisabled();
    expect(heading).toHaveFocus();
    const next = screen.getByRole('button', { name: 'New goal' });
    if (chosen) next.focus();
    else {
      heading.blur();
      expect(document.activeElement).toBe(document.body);
    }
    await act(async () => { resolve(ok({ goals: [categoryGoal] })); });
    expect(opener).not.toBeInTheDocument();
    expect(chosen ? next : heading).toHaveFocus();
    expect(requests().filter((request) => request === 'GET /api/goals')).toHaveLength(2);
    expect(requests().filter((request) => request === 'DELETE /api/goals/goal-savings')).toHaveLength(1);
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
