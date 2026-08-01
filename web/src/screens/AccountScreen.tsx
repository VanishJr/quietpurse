/**
 * Account identity: who is signed in, the password, and signing out. Base currency
 * and owner names are the workspace's settings, not the account's, and stay on
 * Overview.
 *
 * It fetches nothing. Every screen in App.tsx stays mounted and is only `hidden`,
 * so a load here would be a load on the whole app's first paint.
 */
import { FormEvent, useState } from 'react';
import { auth, MIN_PASSWORD, PasswordChange, SessionUser } from '../api';

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

export function AccountScreen({ user, onSignOut }: { user: SessionUser; onSignOut: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

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

  return (
    <div className="screen-inner">
      <h1 className="title">Your account</h1>

      <form className="stack" onSubmit={submit}>
        <label className="setting-label" htmlFor="account-email">
          Signed in as
        </label>
        {/*
          A real field rather than a line of text: a password manager files a new
          password under the username it finds in the same form, and one filed under
          no account is unrecoverable while there is no password reset.
        */}
        <input
          id="account-email"
          className="input"
          type="text"
          readOnly
          value={user.email}
          autoComplete="username"
        />

        <h2 className="block-title">Change password</h2>

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
          Changing it signs out every other browser and phone you are signed in on. This one stays
          signed in.
        </p>
      </form>

      <h2 className="block-title">Sign out</h2>
      <button className="btn" type="button" onClick={onSignOut}>
        Sign out
      </button>
      <p className="hint">This browser only. Your data stays where it is.</p>
    </div>
  );
}
