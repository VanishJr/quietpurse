import { useCallback, useEffect, useState } from 'react';
import { apiLabel, auth, onUnauthorized, SessionResult, SessionUser } from './api';
import { AccountScreen } from './screens/AccountScreen';
import { AnalyticsScreen } from './screens/AnalyticsScreen';
import { AuthScreen } from './screens/AuthScreen';
import { IndependenceScreen } from './screens/IndependenceScreen';
import { OverviewScreen } from './screens/OverviewScreen';
import { TransactionsScreen } from './screens/TransactionsScreen';
import { ThemeProvider } from './theme';

const TABS = [
  { key: 'overview', title: 'Overview' },
  { key: 'transactions', title: 'Transactions' },
  { key: 'analytics', title: 'Analytics' },
  { key: 'goal', title: 'Goal' },
  { key: 'account', title: 'Account' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

/** The app itself — mounted only with a session, so every request below is scoped to the user's workspace. */
function SignedIn({ user, onSignedOut }: { user: SessionUser; onSignedOut: () => void }) {
  const [tab, setTab] = useState<TabKey>('overview');

  const signOut = async () => {
    try {
      await auth.logout();
    } finally {
      // even if the call failed, drop back to the login screen: whatever went
      // wrong, staying in a UI whose requests 401 is worse
      onSignedOut();
    }
  };

  return (
    <div className="app">
      {/*
        Screens stay mounted so filters and already-loaded data survive a tab switch;
        `hidden` only takes the inactive ones out of layout and the a11y tree.
      */}
      <main className="screens">
        <div className="screen" hidden={tab !== 'overview'}>
          <OverviewScreen />
        </div>
        <div className="screen" hidden={tab !== 'transactions'}>
          <TransactionsScreen />
        </div>
        <div className="screen" hidden={tab !== 'analytics'}>
          <AnalyticsScreen />
        </div>
        <div className="screen" hidden={tab !== 'goal'}>
          <IndependenceScreen />
        </div>
        <div className="screen" hidden={tab !== 'account'}>
          <AccountScreen user={user} onSignOut={signOut} />
        </div>
      </main>

      <nav className="tabbar" aria-label="Sections">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            aria-current={tab === t.key ? 'page' : undefined}
          >
            {t.title}
          </button>
        ))}
      </nav>
    </div>
  );
}

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
        <SignedIn user={session.user} onSignedOut={() => setSession({ state: 'signed-out' })} />
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
