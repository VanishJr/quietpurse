/**
 * The application: the five screens and the tab bar. Mounted only with a session,
 * so every request below is scoped to the user's workspace.
 *
 * It is a module of its own so that it can be a chunk of its own. Imported
 * directly by App.tsx, it put the whole app — five screens and recharts with it —
 * into the one bundle the sign-in form is served from: 429 kB of JavaScript, 127
 * of them over the wire, to draw a card with two boxes on it, and every byte of it
 * downloaded and parsed by somebody who does not have an account yet. App.tsx
 * reaches it through `lazy()` instead, so the charts arrive with the screens that
 * draw them.
 */
import { useState } from 'react';
import { auth, SessionUser } from './api';
import { AccountScreen } from './screens/AccountScreen';
import { AnalyticsScreen } from './screens/AnalyticsScreen';
import { IndependenceScreen } from './screens/IndependenceScreen';
import { OverviewScreen } from './screens/OverviewScreen';
import { TransactionsScreen } from './screens/TransactionsScreen';

const TABS = [
  { key: 'overview', title: 'Overview' },
  { key: 'transactions', title: 'Transactions' },
  { key: 'analytics', title: 'Analytics' },
  { key: 'goal', title: 'Goal' },
  { key: 'account', title: 'Account' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

export function SignedIn({ user, onSignedOut }: { user: SessionUser; onSignedOut: () => void }) {
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
