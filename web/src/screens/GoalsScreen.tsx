import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Button } from '../components/Button';
import { FormActions } from '../components/FormActions';
import { Notice } from '../components/Notice';
import { GoalCard } from '../components/GoalCard';
import { GoalEditor } from '../components/GoalEditor';
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
  const [notice, setNotice] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<GoalSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const loadGeneration = useRef(0);

  const load = useCallback(async (initial = false) => {
    const generation = ++loadGeneration.current;
    if (initial) setGoals(null);
    setError(null);
    try {
      const next = await api.goals();
      if (generation === loadGeneration.current) setGoals(next.goals);
    } catch (caught) {
      if (generation === loadGeneration.current) setError((caught as Error).message);
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load, reloadToken]);

  const handleMissingGoal = useCallback(() => {
    setUrl({ goal: null }, 'replace');
    setNotice('That goal is no longer available.');
  }, []);

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
    <section className="screen-inner">
      <header className="header goals-header">
        <div>
          <h1>Goals</h1>
        </div>
        <button
          className="btn btn-primary"
          disabled={goals === null}
          onClick={() => {
            setNotice(null);
            setUrl({ screen: 'goal', goal: 'new' });
          }}
        >
          New goal
        </button>
      </header>

      {goals === null && !error && <p className="state-note">Loading goals…</p>}
      {notice && <p className="state-note" role="status">{notice}</p>}
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
            onClick={() => {
              setNotice(null);
              setUrl({ screen: 'goal', goal: 'new' });
            }}
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
              onEdit={(selected) => {
                setNotice(null);
                setUrl({ screen: 'goal', goal: selected.id });
              }}
              onDelete={(selected) => {
                setDeleteError(null);
                setDeleteTarget(selected);
              }}
            />
          ))}
        </div>
      )}

      <GoalEditor
        goalId={url.goal}
        onClose={() => setUrl({ goal: null }, 'replace')}
        onMissing={handleMissingGoal}
        onSaved={() => {
          setNotice(null);
          setUrl({ goal: null }, 'replace');
          void load();
        }}
      />

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
            {deleteError && <Notice tone="error" role="alert">{deleteError}</Notice>}
            {deleting && <Notice role="status">Deleting goal…</Notice>}
            <FormActions
              cancel={
                <Button type="button" variant="secondary" size="standard" disabled={deleting} onClick={() => setDeleteTarget(null)}>
                  Cancel
                </Button>
              }
              completion={
                <Button type="button" variant="destructive-primary" size="standard" pending={deleting} onClick={() => void confirmDelete()}>
                  Delete goal
                </Button>
              }
            />
          </>
        )}
      </Sheet>
    </section>
  );
}
