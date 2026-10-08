import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useEditorSession } from '../editor';
import { Button } from '../components/Button';
import { FormActions } from '../components/FormActions';
import { Notice } from '../components/Notice';
import { PageHeader } from '../components/PageHeader';
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
  const selection = useRef({ goal: url.goal, token: 0 });
  if (selection.current.goal !== url.goal) {
    selection.current = { goal: url.goal, token: selection.current.token + 1 };
  }
  const selectionToken = selection.current.token;
  const [goals, setGoals] = useState<GoalSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<GoalSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  if (url.goal !== null && deleteTarget !== null) setDeleteTarget(null);
  const deleteEditor = useEditorSession({ open: deleteTarget !== null, dirty: false, busy: deleting, onClose: () => setDeleteTarget(null) });
  const loadGeneration = useRef(0);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const postWriteFocus = useRef<{ list: GoalSummary[] | null } | null>(null);
  useEffect(() => {
    const intent = postWriteFocus.current;
    if (!intent) return;
    const replaced = goals !== null && goals !== intent.list;
    if (!replaced && !error) return;
    if (replaced) postWriteFocus.current = null;
    if (document.activeElement === document.body && !titleRef.current?.closest('[hidden], [inert]')) {
      titleRef.current?.focus();
    }
  }, [goals, error]);

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
      deleteEditor.finish(() => {
        if (url.goal === deleteTarget.id) setUrl({ goal: null }, 'replace');
        postWriteFocus.current = { list: goals };
        setDeleteTarget(null);
      });
      await load();
    } catch (caught) {
      setDeleteError((caught as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <section className="screen-inner goals-screen">
      <PageHeader title="Goals" titleRef={titleRef} action={goals?.length === 0 && !error ? undefined : (
        <Button type="button" variant="primary" size="standard" disabled={goals === null}
          onClick={() => { setNotice(null); setUrl({ screen: 'goal', goal: 'new' }); }}>
          New goal
        </Button>
      )} />

      {goals === null && !error && <Notice placement="content" role="status">Loading goals…</Notice>}
      {notice && <Notice role="status">{notice}</Notice>}
      {error && (
        <Notice tone="error" placement="content" role="alert" remedy={
          <Button type="button" variant="secondary" size="standard" onClick={() => { titleRef.current?.focus(); void load(true); }}>
            Retry
          </Button>
        }>
          Couldn’t load goals: {error}
        </Notice>
      )}
      {goals !== null && goals.length === 0 && !error && (
        <div className="empty-state goals-empty">
          <h2>No goals yet.</h2>
          <p>Create one to track progress from your financial data.</p>
          <Button type="button" variant="primary" size="standard"
            onClick={() => { setNotice(null); setUrl({ screen: 'goal', goal: 'new' }); }}>
            Create a goal
          </Button>
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
          postWriteFocus.current = { list: goals };
          setNotice(null);
          if (selection.current.token === selectionToken) setUrl({ goal: null }, 'replace');
          void load();
        }}
      />

      <Sheet
        open={deleteTarget !== null}
        onClose={deleteEditor.requestClose}
        position="center"
        pattern="confirmation"
        busy={deleting}
        restoreFocus={() => document.querySelector<HTMLElement>('.screen:not([hidden]) h1')}
        title={deleteTarget ? `Delete ${deleteTarget.name}` : 'Delete goal'}
        header={deleteTarget && <h2>Delete “{deleteTarget.name}”?</h2>}
        initialFocus={() => document.querySelector<HTMLElement>('[data-goal-delete-cancel]')}
        footer={deleteTarget && (
          <>
            {deleteError && <Notice tone="error" role="alert">{deleteError}</Notice>}
            {deleting && <Notice role="status">Deleting goal…</Notice>}
            <FormActions
              cancel={
                <Button data-goal-delete-cancel type="button" variant="secondary" size="standard" disabled={deleting} onClick={deleteEditor.requestClose}>
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
      >
        {deleteTarget && (
          <p className="body-text">This removes the goal only. Accounts and transactions are unchanged.</p>
        )}
      </Sheet>
    </section>
  );
}
