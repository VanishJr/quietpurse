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
import { auth, MIN_PASSWORD } from '../api';

type Mode = 'login' | 'register';

export function AuthScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [inviteRequired, setInviteRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A public server can be invite-only; ask once so the form knows whether to
  // show the field at all rather than making everyone wonder what it is.
  useEffect(() => {
    void auth.signupMode().then((m) => setInviteRequired(m === 'invite'));
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (mode === 'register' && password.length < MIN_PASSWORD) {
      setError(`Password: at least ${MIN_PASSWORD} characters`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (mode === 'register') {
        // the name is optional for the user, but better-auth wants a string;
        // the part before @ is a reasonable stand-in
        await auth.register(
          email.trim(),
          password,
          name.trim() || email.trim().split('@')[0],
          inviteRequired ? inviteCode.trim() : undefined,
        );
      } else {
        await auth.login(email.trim(), password);
      }
      onSignedIn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const switchMode = () => {
    setMode(mode === 'login' ? 'register' : 'login');
    setError(null);
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
          {error && <p className="error">{error}</p>}
          <button className="btn" type="submit" disabled={busy}>
            {busy ? '…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <p className="hint" style={{ marginTop: 16 }}>
          {mode === 'login' ? 'No account yet?' : 'Already have an account?'}{' '}
          <button className="btn-link" type="button" onClick={switchMode}>
            {mode === 'login' ? 'Register' : 'Sign in'}
          </button>
        </p>
      </div>
    </div>
  );
}
