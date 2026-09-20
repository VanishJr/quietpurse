import { describe, expect, it } from 'vitest';
import { formatGoalValue, goalStatusMessage, progressLabel, remainingLabel } from './goals';
import type { GoalProgress, GoalSummary } from './types';

const progress = (patch: Partial<GoalProgress> = {}): GoalProgress => ({
  semantic: 'completion',
  unit: 'money',
  target: 1000,
  current: 600,
  remaining: 400,
  overBy: 0,
  percentage: 60,
  forecast: null,
  status: 'tracking',
  asOf: '2026-05-15T12:00:00.000Z',
  period: { kind: 'current-balances', from: null, to: null, monthsUsed: null },
  ...patch,
});

const goal = (patch: Partial<GoalSummary> = {}): GoalSummary => ({
  id: 'g1',
  type: 'savings-balance',
  name: 'Deposit',
  targetDate: null,
  createdAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-01T00:00:00.000Z',
  currency: 'EUR',
  source: 'Imported balances · Cash',
  progress: progress(),
  ...patch,
} as GoalSummary);

describe('Goals presentation', () => {
  it('formats values without deriving progress', () => {
    expect(formatGoalValue(2420, 'money-per-month', 'EUR')).toBe('2,420 EUR/mo');
    expect(formatGoalValue(60, 'percent', null)).toBe('60%');
    expect(formatGoalValue(null, 'money', 'EUR')).toBe('—');
  });

  it('distinguishes completion from spending used', () => {
    expect(progressLabel(progress({ percentage: 76 }))).toBe('76% of target');
    expect(progressLabel(progress({ semantic: 'used', percentage: 76 }))).toBe('76% used');
    expect(progressLabel(progress({ status: 'reached', percentage: 120 }))).toBe('Reached');
  });

  it('uses Over by only when the server reports an excess', () => {
    expect(remainingLabel(progress())).toBe('Left');
    expect(remainingLabel(progress({ remaining: 0, overBy: 50 }))).toBe('Over by');
  });

  it('maps actionable statuses to concise recovery text', () => {
    expect(goalStatusMessage(goal({ progress: progress({ status: 'needs-setup' }) }))).toContain(
      'Add essential costs',
    );
    expect(
      goalStatusMessage(goal({ progress: progress({ status: 'account-unavailable' }) })),
    ).toContain('Edit this goal');
    expect(
      goalStatusMessage(
        goal({
          type: 'debt-payoff',
          progress: progress({ status: 'account-unavailable' }),
        } as Partial<GoalSummary>),
      ),
    ).toContain('Create a new goal');
    expect(goalStatusMessage(goal({ progress: progress({ status: 'tracking' }) }))).toBeNull();
  });
});
