import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SAVINGS_GOAL } from '../test/fixtures';
import { renderThemed } from '../test/harness';
import type { GoalSummary } from '../types';
import { GoalCard } from './GoalCard';

const renderCard = (goal: GoalSummary) =>
  renderThemed(<GoalCard goal={goal} onEdit={vi.fn()} onDelete={vi.fn()} />);

describe('GoalCard progress semantics', () => {
  it('exposes the bounded numeric progress value', () => {
    renderCard(SAVINGS_GOAL);

    const progress = screen.getByRole('progressbar', { name: '60% of target' });
    expect(progress).toHaveAttribute('aria-valuemin', '0');
    expect(progress).toHaveAttribute('aria-valuemax', '100');
    expect(progress).toHaveAttribute('aria-valuenow', '60');
  });

  it('leaves an unavailable progress value indeterminate', () => {
    renderCard({
      ...SAVINGS_GOAL,
      progress: {
        ...SAVINGS_GOAL.progress,
        current: null,
        remaining: null,
        overBy: null,
        percentage: null,
        status: 'account-unavailable',
      },
    });

    const progress = screen.getByRole('progressbar', { name: 'Account unavailable' });
    expect(progress).toHaveAttribute('aria-valuemin', '0');
    expect(progress).toHaveAttribute('aria-valuemax', '100');
    expect(progress).not.toHaveAttribute('aria-valuenow');
  });
});
