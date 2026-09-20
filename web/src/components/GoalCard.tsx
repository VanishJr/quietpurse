import {
  formatGoalValue,
  formatWorkHours,
  goalCategoryLabel,
  goalStatusMessage,
  progressLabel,
  remainingLabel,
} from '../goals';
import type { GoalSummary } from '../types';

interface Props {
  goal: GoalSummary;
  busy?: boolean;
  onEdit: (goal: GoalSummary) => void;
  onDelete: (goal: GoalSummary) => void;
}

export function GoalCard({ goal, busy = false, onEdit, onDelete }: Props) {
  const { progress } = goal;
  const over = progress.overBy !== null && progress.overBy > 0;
  const lastValue = over ? progress.overBy : progress.remaining;
  const status = goalStatusMessage(goal);
  const percentage = progress.percentage === null ? 0 : Math.max(0, Math.min(100, progress.percentage));
  const category = goalCategoryLabel(goal);

  return (
    <article className={`card goal-card goal-card-${progress.status}`}>
      <header className="goal-card-header">
        <div>
          <h2>{goal.name}</h2>
          {category && <p className="goal-card-kind">{category}</p>}
        </div>
        <div className="goal-card-actions">
          <button
            className="btn btn-small btn-ghost"
            aria-label={`Edit ${goal.name}`}
            disabled={busy}
            onClick={() => onEdit(goal)}
          >
            Edit
          </button>
          <button
            className="btn btn-small btn-ghost"
            aria-label={`Delete ${goal.name}`}
            disabled={busy}
            onClick={() => onDelete(goal)}
          >
            Delete
          </button>
        </div>
      </header>

      <dl className="goal-figures">
        <div>
          <dt>Target</dt>
          <dd>{formatGoalValue(progress.target, progress.unit, goal.currency)}</dd>
        </div>
        <div>
          <dt>Current</dt>
          <dd>{formatGoalValue(progress.current, progress.unit, goal.currency)}</dd>
        </div>
        <div>
          <dt>{remainingLabel(progress)}</dt>
          <dd>{formatGoalValue(lastValue, progress.unit, goal.currency)}</dd>
        </div>
      </dl>

      <div
        className="goal-progress"
        role="progressbar"
        aria-label={progressLabel(progress)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.percentage === null ? undefined : percentage}
      >
        <span style={{ width: `${percentage}%` }} />
      </div>
      <p className="goal-progress-label">{progressLabel(progress)}</p>
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
      {status && <p className="goal-status">{status}</p>}
    </article>
  );
}
