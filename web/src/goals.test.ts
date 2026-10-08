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
    expect(progressLabel(progress({ percentage: null }))).toBe('Progress unavailable');
  });

  it('distinguishes favorable surplus from limit consumption using server semantics', () => {
    expect(remainingLabel(progress())).toBe('Left');
    expect(remainingLabel(progress({ remaining: 0, overBy: 50 }))).toBe('Above target');
    expect(remainingLabel(progress({ semantic: 'used', overBy: 0 }))).toBe('Available');
    expect(remainingLabel(progress({ semantic: 'used', remaining: 0, overBy: 50, status: 'over-limit' }))).toBe('Over limit');
  });

  it('maps actionable statuses to accurate complete recovery text', () => {
    expect(goalStatusMessage(goal({ progress: progress({ status: 'needs-setup' }) }))).toBe(
      'Add essential costs to calculate progress.',
    );
    expect(
      goalStatusMessage(goal({ progress: progress({ status: 'account-unavailable' }) })),
    ).toBe('A selected account was removed. Edit this goal to choose another account.');
    expect(
      goalStatusMessage(
        goal({
          type: 'debt-payoff',
          progress: progress({ status: 'account-unavailable' }),
        } as Partial<GoalSummary>),
      ),
    ).toBe('The debt account was removed. Create a new goal to track another debt.');
    expect(goalStatusMessage(goal({ progress: progress({ status: 'tracking' }) }))).toBeNull();
  });

  it('does not prescribe another import when existing data may be unconverted', () => {
    const unconverted = goal({
      source: '6 complete months · Earnings',
      progress: progress({
        status: 'not-enough-data',
        current: null,
        remaining: null,
        overBy: null,
        percentage: null,
      }),
    });

    expect(goalStatusMessage(unconverted)).toBe(
      'There isn’t enough usable data in the selected period to calculate progress.',
    );
  });
});
