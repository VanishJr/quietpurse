import { useId } from 'react';
import {
  GOAL_STATUS_LABELS,
  formatGoalValue,
  formatWorkHours,
  goalCategoryLabel,
  goalStatusMessage,
  progressLabel,
  remainingLabel,
} from '../goals';
import type { GoalSummary } from '../types';
import { Button } from './Button';

interface Props {
  goal: GoalSummary;
  busy?: boolean;
  onEdit: (goal: GoalSummary) => void;
  onDelete: (goal: GoalSummary) => void;
}

export function GoalCard({ goal, busy = false, onEdit, onDelete }: Props) {
  const titleId = useId();
  const { progress } = goal;
  const over = progress.overBy !== null && progress.overBy > 0;
  const lastValue = over ? progress.overBy : progress.remaining;
  const guidance = goalStatusMessage(goal);
  const status = GOAL_STATUS_LABELS[progress.status];
  const label = progressLabel(progress);
  const percentage = progress.percentage === null ? 0 : Math.max(0, Math.min(100, progress.percentage));
  const category = goalCategoryLabel(goal);

  return (
    <article className={`card goal-card goal-card-${progress.status} goal-card-${progress.semantic}`}>
      <header className="goal-card-header">
        <h2 id={titleId}>{goal.name}</h2>
        <p className="goal-status-label">{status}</p>
      </header>
      {guidance && <p className="goal-status">{guidance}</p>}

      <dl className="goal-figures">
        <div>
          <dt>{progress.semantic === 'used' ? 'Used' : 'Current'}</dt>
          <dd className="financial-value">{formatGoalValue(progress.current, progress.unit, goal.currency)}</dd>
        </div>
        <div>
          <dt>{progress.semantic === 'used' ? 'Limit' : 'Target'}</dt>
          <dd className="financial-value">{formatGoalValue(progress.target, progress.unit, goal.currency)}</dd>
        </div>
        <div className={over ? `goal-excess-${progress.semantic}` : undefined}>
          <dt>{remainingLabel(progress)}</dt>
          <dd className="financial-value">{formatGoalValue(lastValue, progress.unit, goal.currency)}</dd>
        </div>
      </dl>

      <div
        className="goal-progress"
        role="progressbar"
        aria-label={label}
        aria-describedby={titleId}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.percentage === null ? undefined : percentage}
        aria-valuetext={label}
      >
        <span style={{ width: `${percentage}%` }} />
      </div>
      {label !== status && <p className="goal-progress-label">{label}</p>}
      {category && <p className="goal-card-kind">{category}</p>}
      <p className="goal-source">{goal.source}</p>
      {goal.type === 'financial-independence' &&
        goal.supportExcluded !== null &&
        goal.supportExcluded > 0 && (
          <p className="goal-support">
            Support excluded: {formatGoalValue(goal.supportExcluded, 'money-per-month', goal.currency)}
          </p>
        )}
      {goal.type === 'financial-independence' && goal.workHoursLeft !== null && (
        <p className="goal-support">
          Left: {formatGoalValue(progress.remaining, 'money-per-month', goal.currency)} · about{' '}
          {formatWorkHours(goal.workHoursLeft)} work hours/month
          {goal.workHoursCapacityPerMonth !== null &&
            goal.workHoursCapacityExceeded !== null && (
              <>
                {' · '}
                {goal.workHoursCapacityExceeded ? 'exceeds' : 'within'}{' '}
                {formatWorkHours(goal.workHoursCapacityPerMonth)} available hours/month
              </>
            )}
        </p>
      )}
      <div className="goal-card-actions">
        <Button type="button" variant="secondary" size="compact" aria-label={`Edit ${goal.name}`} disabled={busy} onClick={() => onEdit(goal)}>
          Edit
        </Button>
        <Button type="button" variant="destructive-secondary" size="compact" aria-label={`Delete ${goal.name}`} disabled={busy} onClick={() => onDelete(goal)}>
          Delete
        </Button>
      </div>
    </article>
  );
}
