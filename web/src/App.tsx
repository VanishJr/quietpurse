import { useCallback, useEffect, useState } from 'react';
import { api, auth, onUnauthorized, SessionUser } from './api';
import { AnalyticsScreen } from './screens/AnalyticsScreen';
import { AuthScreen } from './screens/AuthScreen';
import { IndependenceScreen } from './screens/IndependenceScreen';
import { OnboardingScreen } from './screens/OnboardingScreen';
import { OverviewScreen } from './screens/OverviewScreen';
import { TransactionsScreen } from './screens/TransactionsScreen';
import { ThemeProvider } from './theme';
import { OnboardingStatus } from './types';

const TABS = [
  { key: 'overview', title: 'Overview' },
  { key: 'transactions', title: 'Transactions' },
  { key: 'analytics', title: 'Analytics' },
  { key: 'goal', title: 'Goal' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

/** The app itself — mounted only with a session, so every request below is scoped to the user's workspace. */
function SignedIn({ user, onSignedOut }: { user: SessionUser; onSignedOut: () => void }) {
  const [tab, setTab] = useState<TabKey>('overview');

  // first-run wizard: shown while the workspace has no accounts. "Go to the app"
  // (dismissed) closes it even without accounts — in case someone wants to look around.
  const [onboarding, setOnboarding] = useState<OnboardingStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // backend unreachable — just skip the wizard, the screens will show the error
    api.onboardingStatus().then(setOnboarding).catch(() => {});
  }, []);

  const signOut = async () => {
    try {
      await auth.logout();
    } finally {
      // even if the call failed, drop back to the login screen: whatever went
      // wrong, staying in a UI whose requests 401 is worse
      onSignedOut();
    }
  };

  if (onboarding?.needed && !dismissed) {
    return (
      <div className="app">
        <OnboardingScreen status={onboarding} onDone={() => setDismissed(true)} />
      </div>
    );
  }

  return (
    <div className="app">
      {/*
        Screens stay mounted so filters and already-loaded data survive a tab switch;
        `hidden` only takes the inactive ones out of layout and the a11y tree.
      */}
      <main className="screens">
        <div className="screen" hidden={tab !== 'overview'}>
          <OverviewScreen user={user} onSignOut={signOut} />
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

function Root() {
  // undefined = the session hasn't been checked yet (first paint), null = signed out
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);

  const checkSession = useCallback(() => {
    auth
      .session()
      .then(setUser)
      .catch(() => setUser(null));
  }, []);

  useEffect(checkSession, [checkSession]);

  // a session can expire while the tab sits open: the first 401 from any request
  // drops the whole app back to the login screen instead of painting errors
  useEffect(() => onUnauthorized(() => setUser(null)), []);

  // nothing on screen until the session is known: rendering the login form first
  // and swapping it for the app a moment later reads as a broken flash
  if (user === undefined) return <div className="app" />;
  if (user === null) return <AuthScreen onSignedIn={checkSession} />;
  return <SignedIn user={user} onSignedOut={() => setUser(null)} />;
}

export function App() {
  return (
    <ThemeProvider>
      <Root />
    </ThemeProvider>
  );
}
