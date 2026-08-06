/**
 * The application: the five screens and the navigation. Mounted only with a session,
 * so every request below is scoped to the user's workspace.
 *
 * It is a module of its own so that it can be a chunk of its own. Imported
 * directly by App.tsx, it put the whole app — five screens and recharts with it —
 * into the one bundle the sign-in form is served from: 429 kB of JavaScript, 127
 * of them over the wire, to draw a card with two boxes on it, and every byte of it
 * downloaded and parsed by somebody who does not have an account yet. App.tsx
 * reaches it through `lazy()` instead, so the charts arrive with the screens that
 * draw them.
 *
 * The navigation is one element in two shapes: a navy sidebar on a wide window, the
 * bottom bar it has always been on a phone. `Import` is in the sidebar's foot and
 * only there — it is an action rather than a screen, it does not fit five-across on
 * a phone, and the Overview carries its own control for it either way.
 */
import { useState } from 'react';
import { auth, SessionUser } from './api';
import {
  AccountIcon,
  AnalyticsIcon,
  GoalsIcon,
  ImportIcon,
  OverviewIcon,
  TransactionsIcon,
} from './components/NavIcons';
import { AccountScreen } from './screens/AccountScreen';
import { AnalyticsScreen } from './screens/AnalyticsScreen';
import { IndependenceScreen } from './screens/IndependenceScreen';
import { OverviewScreen } from './screens/OverviewScreen';
import { TransactionsScreen } from './screens/TransactionsScreen';
import { TxFocus } from './types';

const TABS = [
  { key: 'overview', title: 'Overview', Icon: OverviewIcon },
  { key: 'analytics', title: 'Analytics', Icon: AnalyticsIcon },
  { key: 'transactions', title: 'Transactions', Icon: TransactionsIcon },
  { key: 'goal', title: 'Goals', Icon: GoalsIcon },
  { key: 'account', title: 'Account', Icon: AccountIcon },
] as const;

type TabKey = (typeof TABS)[number]['key'];

export function SignedIn({ user, onSignedOut }: { user: SessionUser; onSignedOut: () => void }) {
  const [tab, setTab] = useState<TabKey>('overview');
  const [focus, setFocus] = useState<TxFocus | null>(null);
  /**
   * Bumped by the sidebar's Import. A counter and not a boolean for the reason
   * `TxFocus` carries a nonce: the Overview stays mounted and owns which panel is
   * open, so asking it twice has to be two events rather than one value set twice.
   */
  const [importAsk, setImportAsk] = useState(0);

  const openTransactions = (accountId: string) => {
    setFocus((prev) => ({ accountId, nonce: (prev?.nonce ?? 0) + 1 }));
    setTab('transactions');
  };

  const openImport = () => {
    setImportAsk((n) => n + 1);
    setTab('overview');
  };

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
          <OverviewScreen
            user={user}
            importAsk={importAsk}
            onOpenTransactions={openTransactions}
            onOpenAccount={() => setTab('account')}
          />
        </div>
        <div className="screen" hidden={tab !== 'transactions'}>
          <TransactionsScreen focus={focus} />
        </div>
        <div className="screen" hidden={tab !== 'analytics'}>
          <AnalyticsScreen />
        </div>
        <div className="screen" hidden={tab !== 'goal'}>
          <IndependenceScreen />
        </div>
        <div className="screen" hidden={tab !== 'account'}>
          <AccountScreen user={user} onSignOut={signOut} onOpenImport={openImport} />
        </div>
      </main>

      <nav className="tabbar" aria-label="Sections">
        <div className="nav-mark">Finto</div>
        <div className="nav-list">
          {TABS.map((t) => (
            <button
              key={t.key}
              className="nav-item"
              onClick={() => setTab(t.key)}
              aria-current={tab === t.key ? 'page' : undefined}
            >
              <t.Icon />
              <span className="nav-label">{t.title}</span>
            </button>
          ))}
        </div>
        <div className="nav-foot">
          <button className="nav-item" onClick={openImport}>
            <ImportIcon />
            <span className="nav-label">Import</span>
          </button>
        </div>
      </nav>
    </div>
  );
}
