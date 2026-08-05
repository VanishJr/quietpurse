import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { apiLabel, auth, onUnauthorized, SessionResult } from './api';
import { AuthScreen } from './screens/AuthScreen';
import { ThemeProvider } from './theme';

/**
 * The app, fetched when there is a session to show it to.
 *
 * Static, this import put all five screens and recharts into the bundle that
 * serves the sign-in form — 429 kB, 127 over the wire, downloaded in full by
 * everyone who has not signed in yet and by everyone whose session had expired.
 * None of it can render until the session comes back, and on the two branches
 * below that it cannot, none of it ever renders at all.
 *
 * The cost of the split is one network round trip between "signed in" and the
 * Overview screen, on a path that is already waiting for /api/auth/get-session.
 */
const SignedIn = lazy(() => import('./SignedIn').then((m) => ({ default: m.SignedIn })));

/**
 * A server nobody can reach is not a user who is signed out. The one thing this
 * screen must not do is offer a password field: the run this was found by ended in
 * "my account is broken", which is what a login form invites the reader to conclude.
 */
function Unreachable({
  reason,
  onChecked,
}: {
  reason: string;
  onChecked: (result: SessionResult) => void;
}) {
  const [busy, setBusy] = useState(false);

  // the answer replaces this screen only once it has arrived: dropping back to
  // 'checking' first would take away the only control there is, and a second
  // failure would read as a flash and then a blank page
  const retry = async () => {
    setBusy(true);
    const result = await auth.session();
    setBusy(false);
    onChecked(result);
  };

  return (
    <div className="screen" style={{ position: 'static', flex: 1 }}>
      <div className="screen-inner">
        <h1 className="title">Cannot reach the server</h1>
        <p className="error">
          Finto could not reach the server, so it cannot tell whether you are signed in. This is
          not a problem with your account or your password.
        </p>
        <p className="hint">Check that you are online and the server is running, then try again.</p>
        <div className="stack">
          <button className="btn" type="button" disabled={busy} onClick={retry}>
            {busy ? '…' : 'Retry'}
          </button>
        </div>
        <p className="api-hint">
          API: {apiLabel()}
          <br />
          {reason}
        </p>
      </div>
    </div>
  );
}

/** 'checking' is Root's alone: the answer is not back yet, and no screen may claim otherwise. */
type SessionState = SessionResult | { state: 'checking' };

function Root() {
  const [session, setSession] = useState<SessionState>({ state: 'checking' });

  const checkSession = useCallback(() => {
    void auth.session().then(setSession);
  }, []);

  useEffect(checkSession, [checkSession]);

  // a session can expire while the tab sits open: the first 401 from any request
  // drops the whole app back to the login screen instead of painting errors
  useEffect(() => onUnauthorized(() => setSession({ state: 'signed-out' })), []);

  switch (session.state) {
    // nothing on screen until the session is known: rendering the login form first
    // and swapping it for the app a moment later reads as a broken flash
    case 'checking':
      return <div className="app" />;
    case 'unreachable':
      return <Unreachable reason={session.reason} onChecked={setSession} />;
    case 'signed-out':
      return <AuthScreen onSignedIn={checkSession} />;
    case 'signed-in':
      return (
        // the same blank shell 'checking' paints, for the same reason: the chunk is
        // a moment away and a spinner for it would be a second thing to look at
        <Suspense fallback={<div className="app" />}>
          <SignedIn user={session.user} onSignedOut={() => setSession({ state: 'signed-out' })} />
        </Suspense>
      );
    default: {
      // a component may return undefined, so a state added without a branch above
      // would compile and paint nothing; this makes it a type error instead
      const unhandled: never = session;
      return unhandled;
    }
  }
}

export function App() {
  return (
    <ThemeProvider>
      <Root />
    </ThemeProvider>
  );
}
