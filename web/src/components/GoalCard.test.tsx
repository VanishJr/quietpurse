import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SAVINGS_GOAL } from '../test/fixtures';
import { renderThemed } from '../test/harness';
import type { GoalSummary } from '../types';
import { GoalCard } from './GoalCard';

const renderCard = (goal: GoalSummary) =>
  renderThemed(<GoalCard goal={goal} onEdit={vi.fn()} onDelete={vi.fn()} />);

describe('GoalCard progress semantics', () => {
  it('leads with explicit status and keeps editing and deletion contextual', () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const { container } = renderThemed(<GoalCard goal={SAVINGS_GOAL} onEdit={onEdit} onDelete={onDelete} />);
    expect(container.querySelector('.goal-card-header')).toHaveTextContent('Emergency savingsTracking');
    const edit = screen.getByRole('button', { name: 'Edit Emergency savings' });
    const remove = screen.getByRole('button', { name: 'Delete Emergency savings' });
    expect(edit).toHaveClass('action-button--secondary');
    expect(remove).toHaveClass('action-button--destructive-secondary');
    fireEvent.click(edit);
    fireEvent.click(remove);
    expect(onEdit).toHaveBeenCalledWith(SAVINGS_GOAL);
    expect(onDelete).toHaveBeenCalledWith(SAVINGS_GOAL);
  });

  it('presents completion surplus with bounded progress and unchanged server values', () => {
    renderCard({ ...SAVINGS_GOAL, progress: { ...SAVINGS_GOAL.progress, current: 18000, overBy: 3000, remaining: 0, percentage: 120, status: 'reached' } });
    expect(screen.getByText('Reached')).toBeVisible();
    expect(screen.getByText('Above target')).toBeVisible();
    expect(screen.getByText('3,000 EUR')).toBeVisible();
    expect(screen.getByText('18,000 EUR')).toBeVisible();
    expect(screen.getByRole('progressbar', { name: 'Reached' })).toHaveAttribute('aria-valuenow', '100');
  });

  it('does not make a fully consumed spending limit look like completed savings', () => {
    renderCard({ ...SAVINGS_GOAL, type: 'category-spending-limit', category: 'food', progress: {
      ...SAVINGS_GOAL.progress, semantic: 'used', current: 18000, overBy: 3000, remaining: 0, percentage: 120, status: 'over-limit',
    } });
    expect(screen.getByText('Used')).toBeVisible();
    expect(screen.getByText('Limit')).toBeVisible();
    expect(screen.getAllByText('Over limit')).toHaveLength(2);
    expect(screen.getByText('120% used')).toBeVisible();
    expect(screen.queryByText('Reached')).not.toBeInTheDocument();
    const progress = screen.getByRole('progressbar', { name: '120% used' });
    expect(progress).toHaveAttribute('aria-valuenow', '100');
    expect(progress).toHaveAttribute('aria-valuetext', '120% used');
    expect(progress).toHaveAccessibleDescription('Emergency savings');
  });
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
