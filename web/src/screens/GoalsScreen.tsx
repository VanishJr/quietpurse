import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { GoalCard } from '../components/GoalCard';
import { Sheet } from '../components/Sheet';
import type { GoalSummary } from '../types';
import { setUrl, useUrl } from '../url';

interface Props {
  reloadToken?: number;
}

export function GoalsScreen({ reloadToken = 0 }: Props) {
  const url = useUrl();
  const [goals, setGoals] = useState<GoalSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<GoalSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const load = useCallback(async (initial = false) => {
    if (initial) setGoals(null);
    setError(null);
    try {
      setGoals((await api.goals()).goals);
    } catch (caught) {
      setError((caught as Error).message);
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load, reloadToken]);

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteGoal(deleteTarget.id);
      if (url.goal === deleteTarget.id) setUrl({ goal: null }, 'replace');
      setDeleteTarget(null);
      await load();
    } catch (caught) {
      setDeleteError((caught as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <section>
      <header className="header goals-header">
        <div>
          <h1>Goals</h1>
        </div>
        <button
          className="btn btn-primary"
          disabled={goals === null}
          onClick={() => setUrl({ screen: 'goal', goal: 'new' })}
        >
          New goal
        </button>
      </header>

      {goals === null && !error && <p className="state-note">Loading goals…</p>}
      {error && (
        <div className="error-row" role="alert">
          <span>Couldn’t load goals: {error}</span>
          <button className="btn btn-small" onClick={() => void load(true)}>
            Retry
          </button>
        </div>
      )}
      {goals !== null && goals.length === 0 && !error && (
        <div className="empty-state goals-empty">
          <h2>No goals yet.</h2>
          <p>Create one to track progress from your financial data.</p>
          <button
            className="btn btn-primary"
            onClick={() => setUrl({ screen: 'goal', goal: 'new' })}
          >
            Create a goal
          </button>
        </div>
      )}
      {goals !== null && goals.length > 0 && (
        <div className="goals-list">
          {goals.map((goal) => (
            <GoalCard
              key={goal.id}
              goal={goal}
              busy={deleting}
              onEdit={(selected) => setUrl({ screen: 'goal', goal: selected.id })}
              onDelete={(selected) => {
                setDeleteError(null);
                setDeleteTarget(selected);
              }}
            />
          ))}
        </div>
      )}

      <Sheet
        open={deleteTarget !== null}
        onClose={() => {
          if (!deleting) setDeleteTarget(null);
        }}
        position="center"
        title={deleteTarget ? `Delete ${deleteTarget.name}` : 'Delete goal'}
      >
        {deleteTarget && (
          <>
            <h2>Delete “{deleteTarget.name}”?</h2>
            <p className="body-text">This removes the goal only. Accounts and transactions are unchanged.</p>
            {deleteError && <p className="error-text">{deleteError}</p>}
            <div className="sheet-actions">
              <button className="btn" disabled={deleting} onClick={() => setDeleteTarget(null)}>
                Cancel
              </button>
              <button className="btn btn-danger" disabled={deleting} onClick={() => void confirmDelete()}>
                {deleting ? 'Deleting…' : 'Delete goal'}
              </button>
            </div>
          </>
        )}
      </Sheet>
    </section>
  );
}
