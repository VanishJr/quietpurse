/**
 * Account: who is signed in, and everything that is about the workspace rather than
 * about one of its accounts.
 *
 * The Overview used to carry the second half — the base currency, the owner names,
 * the recurring payments, the export and the whole-workspace import history — under a
 * "Workspace" heading below the dashboard. None of it was about the account on the
 * tab, which is the only thing that screen is now for, and all of it is settings.
 *
 * The order is the point, and it is: **who you are**, then **how Finto counts**, then
 * **what it found**, then **your data**, then **leaving**. Reading down the screen
 * goes from the thing that is true before the app has any data to the thing you do
 * last. Each section is a card so that the order is visible as separation rather than
 * as a run of headings.
 *
 * It fetches two things. `AppSettingsBlock` reads the settings it edits, and the
 * recurring list is read here; both were already first-paint requests when they were
 * on the Overview, so the app's first paint is unchanged.
 */
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api, apiLabel, auth, MIN_PASSWORD, PasswordChange, SessionUser } from '../api';
import { categoryLabel } from '../categories';
import { AppSettingsBlock } from '../components/AppSettingsBlock';
import { ImportHistory } from '../components/ImportHistory';
import { saveBlob } from '../download';
import { fmtDate, fmtMoney } from '../format';
import { initialOf } from '../identity';
import { RecurringSummary } from '../types';

/** How many recurring payments to show before the tail is summarised. */
const RECURRING_LIMIT = 8;

/** A refusal this screen made itself, before any request went out. */
type Feedback = PasswordChange | { outcome: 'not-sent'; message: string };

function Message({ feedback }: { feedback: Feedback }) {
  switch (feedback.outcome) {
    case 'changed':
      // the affirmation has nothing to derive itself from: the body is { token, user }
      // and echoes nothing about the password, so unlike AppSettingsBlock the 200 from
      // an endpoint whose only job is this change is the whole of the evidence
      return (
        <p className="hint">
          ✓ Password changed. Anywhere else you were signed in has been signed out.
        </p>
      );
    case 'refused':
      return (
        <p className="error">
          {feedback.wrongCurrent
            ? 'That is not your current password. Nothing was changed.'
            : `${feedback.message}. Nothing was changed.`}
        </p>
      );
    case 'signed-out':
      return (
        <p className="error">
          You are signed out, so nothing was changed. Sign out below and sign in again with the
          password you have now.
        </p>
      );
    case 'unknown':
      return (
        <p className="error">
          Finto cannot tell whether the password was changed ({feedback.detail}). Sign out and sign
          in again with the NEW password: if it is accepted, the change went through. If it is
          refused, your old password is still the one.
        </p>
      );
    case 'not-sent':
      return <p className="error">{feedback.message}</p>;
    default: {
      const unhandled: never = feedback;
      return unhandled;
    }
  }
}

interface Props {
  user: SessionUser;
  onSignOut: () => void;
  /** The sidebar's own Import, so the two entry points are one behaviour. */
  onOpenImport: () => void;
}

export function AccountScreen({ user, onSignOut, onOpenImport }: Props) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const [recurring, setRecurring] = useState<RecurringSummary | null>(null);
  const [recurringError, setRecurringError] = useState<string | null>(null);

  /** The import history takes the screen over; it is a page, not a panel. */
  const [historyOpen, setHistoryOpen] = useState(false);

  /**
   * The export's own refusal. It sits at the bottom of a long screen, and the error
   * line of any other block on it is somewhere the reader is no longer looking.
   */
  const [exportError, setExportError] = useState<string | null>(null);
  /**
   * In flight, and nothing else: /api/backup serialises every table, so on a real
   * workspace the screen sits unchanged long enough for a second click.
   */
  const [exporting, setExporting] = useState(false);

  const loadRecurring = useCallback(async () => {
    try {
      setRecurringError(null);
      setRecurring(await api.recurring());
    } catch (e) {
      setRecurringError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    loadRecurring();
  }, [loadRecurring]);

  /** Hide/restore a group of recurring payments (the backend replies with a fresh list). */
  const toggleRecurring = async (description: string, ignored: boolean) => {
    try {
      setRecurringError(null);
      setRecurring(await api.setRecurringIgnored(description, ignored));
    } catch (e) {
      setRecurringError((e as Error).message);
    }
  };

  /**
   * A fetch and not a link: /api/backup answers 500 like anything else, and a session
   * that expired in an open tab answers 401 — `<a download>` writes both to disk as
   * finto-backup-<date>.json, and the user believes they hold their data.
   */
  const runExport = async () => {
    setExporting(true);
    try {
      setExportError(null);
      const blob = await api.backup();
      // the name the backend's own Content-Disposition would have carried
      saveBlob(blob, `finto-backup-${new Date().toISOString().slice(0, 10)}.json`);
    } catch (e) {
      setExportError((e as Error).message);
    } finally {
      setExporting(false);
    }
  };

  const refuse = (message: string) => setFeedback({ outcome: 'not-sent', message });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    // this product has no password reset, so a new password mistyped once is an
    // account nobody can get back into
    if (next !== confirm) {
      refuse('The new password and the confirmation do not match.');
      return;
    }
    if (next.length < MIN_PASSWORD) {
      refuse(`New password: at least ${MIN_PASSWORD} characters.`);
      return;
    }
    // the server answers 200 to this and changes nothing, which would print as done
    if (next === current) {
      refuse('The new password is the one you are already using.');
      return;
    }
    setBusy(true);
    setFeedback(null);
    const result = await auth.changePassword(current, next);
    if (result.outcome === 'changed') {
      setCurrent('');
      setNext('');
      setConfirm('');
    }
    // a failure after the write has already deleted the sessions, so a retry answers
    // 401: that is the same failure's second half, not news that nothing was changed.
    // Only signing in can still answer what the unknown asked, so the unknown stands.
    setFeedback(
      result.outcome === 'signed-out' && feedback?.outcome === 'unknown' ? feedback : result,
    );
    setBusy(false);
  };

  const active = recurring?.groups.filter((g) => !g.ignored) ?? [];
  const ignored = recurring?.groups.filter((g) => g.ignored) ?? [];

  if (historyOpen) {
    return (
      <div className="screen-inner">
        <ImportHistory onBack={() => setHistoryOpen(false)} onChanged={loadRecurring} />
      </div>
    );
  }

  return (
    <div className="screen-inner">
      <h1 className="title">Your account</h1>

      {/* 1. who you are */}
      <section className="settings-section">
        <h2 className="settings-title">Signed in</h2>
        <div className="settings-id">
          <span className="avatar" aria-hidden="true">
            {initialOf(user)}
          </span>
          <div>
            {user.name && <div className="settings-id-name">{user.name}</div>}
            <div className="settings-id-mail">{user.email}</div>
          </div>
        </div>

        <form className="stack" onSubmit={submit}>
          {/*
            A real field rather than a line of text: a password manager files a new
            password under the username it finds in the same form, and one filed under
            no account is unrecoverable while there is no password reset.
          */}
          <input
            id="account-email"
            className="visually-hidden"
            type="text"
            readOnly
            aria-label="Signed in as"
            value={user.email}
            autoComplete="username"
          />

          <h3 className="block-title">Change password</h3>

          <label className="setting-label" htmlFor="account-current-password">
            Current password
          </label>
          <input
            id="account-current-password"
            className="input"
            type="password"
            required
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />

          <label className="setting-label" htmlFor="account-new-password">
            New password
          </label>
          <input
            id="account-new-password"
            className="input"
            type="password"
            required
            autoComplete="new-password"
            placeholder={`${MIN_PASSWORD}+ characters`}
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />

          <label className="setting-label" htmlFor="account-confirm-password">
            Confirm new password
          </label>
          <input
            id="account-confirm-password"
            className="input"
            type="password"
            required
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />

          {feedback && <Message feedback={feedback} />}

          <button className="btn" type="submit" disabled={busy}>
            {busy ? '…' : 'Change password'}
          </button>
          <p className="hint">
            Changing it signs out every other browser and phone you are signed in on. This one
            stays signed in.
          </p>
        </form>
      </section>

      {/* 2. how Finto counts — the two settings every figure in the app depends on */}
      <section className="settings-section">
        <h2 className="settings-title">How Finto counts</h2>
        <p className="settings-lead">
          These two decide what every total in the app means. They are the workspace's, not
          one account's.
        </p>
        <AppSettingsBlock />
      </section>

      {/* 3. what it found */}
      <section className="settings-section">
        <h2 className="settings-title">Recurring payments</h2>
        <p className="settings-lead">
          Detected across every account, over the last twelve months.{' '}
          {recurring && recurring.groups.length > 0 && (
            <>
              About{' '}
              <strong>{fmtMoney(recurring.monthlyTotal, recurring.baseCurrency)}</strong> a
              month.
            </>
          )}
        </p>
        {recurringError && <p className="error">Error: {recurringError}</p>}
        {recurring && recurring.groups.length === 0 && (
          <p className="hint">
            Nothing yet. A payment has to appear in several months before Finto calls it
            recurring.
          </p>
        )}
        {[...active.slice(0, RECURRING_LIMIT), ...ignored].map((g) => (
          <div key={g.description} className="row" style={{ padding: '8px 0' }}>
            <div className="row-main">
              <div className={`row-title${g.ignored ? ' muted-strike' : ''}`}>
                {g.description}
              </div>
              <div className="row-sub">
                {categoryLabel(g.category)} · {g.months} mo. · last {fmtDate(g.lastDate)}
                {g.ignored ? ' · hidden' : ''}
              </div>
            </div>
            <div
              className={`row-value${g.ignored ? ' muted-strike' : ''}`}
              style={{ fontSize: 13, color: 'var(--ink-secondary)' }}
            >
              {fmtMoney(g.monthlyAvg, recurring?.baseCurrency)}/mo
            </div>
            <button
              className={g.ignored ? 'btn-link' : 'btn-danger'}
              onClick={() => toggleRecurring(g.description, !g.ignored)}
              aria-label={
                g.ignored ? `Restore payment ${g.description}` : `Hide payment ${g.description}`
              }
            >
              {g.ignored ? 'Restore' : 'Hide'}
            </button>
          </div>
        ))}
        {active.length > RECURRING_LIMIT && (
          <p className="hint" style={{ marginTop: 6 }}>
            …and {active.length - RECURRING_LIMIT} more, smaller
          </p>
        )}
      </section>

      {/* 4. your data */}
      <section className="settings-section">
        <h2 className="settings-title">Your data</h2>
        <p className="settings-lead">
          What you have uploaded, and how to take all of it away with you.
        </p>

        <button className="btn-ghost" type="button" onClick={onOpenImport}>
          ⭳ Import a statement
        </button>

        <button
          className="btn-link"
          type="button"
          style={{ display: 'block' }}
          onClick={() => setHistoryOpen(true)}
        >
          ⧉ Import history (every account)
        </button>
        <p className="hint">
          Every file you have uploaded, what it read, and the file itself to download again.
          One account's history is under the ⋮ on its balance card, on Overview.
        </p>

        {/* the only user-reachable data export: unconditional on purpose - it used to
            sit inside the sync journal, which a workspace that never synced never had */}
        <button
          className="btn-link"
          type="button"
          style={{ display: 'block' }}
          disabled={exporting}
          onClick={runExport}
        >
          ⬇ Export my data (.json)
        </button>
        {exportError && <p className="error">Error: {exportError}</p>}
        <p className="hint">
          Every transaction, account and setting, as readable JSON — not encrypted, so anyone
          who opens the file can read it. The statement files you uploaded are not in it;
          download those from Import history.
        </p>
      </section>

      {/* 5. leaving */}
      <section className="settings-section">
        <h2 className="settings-title">Sign out</h2>
        <p className="settings-lead">This browser only. Your data stays where it is.</p>
        <button className="btn" type="button" onClick={onSignOut}>
          Sign out
        </button>
      </section>

      <p className="api-hint">API: {apiLabel()}</p>
    </div>
  );
}
