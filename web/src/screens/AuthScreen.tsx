/**
 * Sign in / register. The only screen reachable without a session — everything
 * else in the app is behind it (see App.tsx).
 *
 * One form in two modes rather than two screens: the fields are almost the same,
 * and someone who mistyped their email on the register tab shouldn't have to
 * retype it after switching to login. The session itself is a cookie set by the
 * backend, so there is nothing to store here — on success the app just re-checks
 * the session and renders.
 */
import { FormEvent, useEffect, useState } from 'react';
import { auth, AuthAttempt, MIN_PASSWORD } from '../api';

type Mode = 'login' | 'register';

/**
 * A refusal this screen made itself, before any request went out. 'signed-in' is
 * excluded rather than given an arm returning null: the success member is then
 * unable to reach the message at all.
 */
type Feedback =
  | Exclude<AuthAttempt, { outcome: 'signed-in' }>
  | { outcome: 'not-sent'; message: string };

/**
 * The sentence is composed here, from the member. Nothing the server wrote is
 * printed except by 'unexpected', which frames it as the server's words - a
 * message this client has no name for is still the only thing the person has.
 */
function Message({ feedback }: { feedback: Feedback }) {
  switch (feedback.outcome) {
    case 'bad-email':
      return (
        <p className="error">
          That is not a complete email address. Check it for a typo — an address like ivan@gmail is
          missing its ending, for example ivan@example.com.
        </p>
      );
    case 'wrong-credentials':
      // the server refuses to say which of the two it was, and neither does this
      return <p className="error">That email and password do not match an account here.</p>;
    case 'email-taken':
      return <p className="error">There is already an account with that address. Sign in instead.</p>;
    case 'password-too-short':
      // only reachable once MIN_PASSWORD has drifted from the server's minimum, so
      // the number this client holds is the one number known to be wrong here
      return <p className="error">That password is too short for this server.</p>;
    case 'rate-limited':
      // one member for a 429 on either tab, and the windows differ 60x between them
      // (auth.ts:95-96); whether the bucket is shared is the deployment's business,
      // not this client's. So: no tab, no interval, no account of whose fault it was
      return <p className="error">Too many attempts on this server just now — wait and try again.</p>;
    case 'malformed-request':
      return (
        <p className="error">
          Finto sent this server something it would not accept. That is a bug in Finto, not
          something you can fix here.
        </p>
      );
    case 'unreachable':
      return (
        <p className="error">
          Finto could not reach the server, so it does not know whether that worked. This is not a
          problem with your account or your password. ({feedback.reason})
        </p>
      );
    case 'unexpected':
      return <p className="error">The server refused this. It said: {feedback.detail}</p>;
    case 'not-sent':
      return <p className="error">{feedback.message}</p>;
    default: {
      const unhandled: never = feedback;
      return unhandled;
    }
  }
}

export function AuthScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [inviteRequired, setInviteRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  // A public server can be invite-only; ask once so the form knows whether to
  // show the field at all rather than making everyone wonder what it is.
  useEffect(() => {
    void auth.signupMode().then((m) => setInviteRequired(m === 'invite'));
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    // deliberately not on the login tab: there a short password is a wrong password,
    // and naming its length names a cause that is not the cause
    if (mode === 'register' && password.length < MIN_PASSWORD) {
      setFeedback({
        outcome: 'not-sent',
        message: `Password: at least ${MIN_PASSWORD} characters`,
      });
      return;
    }
    setBusy(true);
    setFeedback(null);
    const result =
      mode === 'register'
        ? // the name is optional for the user, but better-auth wants a string;
          // the part before @ is a reasonable stand-in
          await auth.register(
            email.trim(),
            password,
            name.trim() || email.trim().split('@')[0],
            inviteRequired ? inviteCode.trim() : undefined,
          )
        : await auth.login(email.trim(), password);
    setBusy(false);
    // the only call site: it re-checks the session, so firing it on a failure asks
    // the server a question that answers "signed out" and says nothing to anyone
    if (result.outcome === 'signed-in') {
      onSignedIn();
      return;
    }
    setFeedback(result);
  };

  const switchMode = () => {
    setMode(mode === 'login' ? 'register' : 'login');
    // a refusal composed for the tab being left is a wrong sentence about the one
    // being arrived at
    setFeedback(null);
  };

  return (
    <div className="screen" style={{ position: 'static', flex: 1 }}>
      <div className="screen-inner">
        <h1 className="title">Finto</h1>
        <p className="hint">
          {mode === 'login'
            ? 'Sign in to your data.'
            : 'A new account comes with its own workspace — nobody else on this server sees its data.'}
        </p>

        <form className="stack" onSubmit={submit}>
          {mode === 'register' && (
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name (optional)"
              aria-label="Name"
              autoComplete="name"
            />
          )}
          <input
            className="input"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            aria-label="Email"
            autoComplete="email"
          />
          <input
            className="input"
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={mode === 'register' ? `Password (${MIN_PASSWORD}+ characters)` : 'Password'}
            aria-label="Password"
            autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
          />
          {mode === 'register' && inviteRequired && (
            <input
              className="input"
              required
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
              placeholder="Invite code"
              aria-label="Invite code"
            />
          )}
          {feedback && <Message feedback={feedback} />}
          <button className="btn" type="submit" disabled={busy}>
            {busy ? '…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <p className="hint" style={{ marginTop: 16 }}>
          {mode === 'login' ? 'No account yet?' : 'Already have an account?'}{' '}
          {/* disabled while a request is out: switching mid-flight lets the answer
              land and paint a sentence about the tab the person has just left */}
          <button className="btn-link" type="button" onClick={switchMode} disabled={busy}>
            {mode === 'login' ? 'Register' : 'Sign in'}
          </button>
        </p>
      </div>
    </div>
  );
}
