import { useEffect, useState } from 'react';
import { api } from './api';
import { AnalyticsScreen } from './screens/AnalyticsScreen';
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

function Root() {
  const [tab, setTab] = useState<TabKey>('overview');

  // first-run wizard: shown while the database has no accounts. "Go to the app"
  // (dismissed) closes it even without accounts — in case someone wants to look around.
  const [onboarding, setOnboarding] = useState<OnboardingStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // backend unreachable — just skip the wizard, the screens will show the error
    api.onboardingStatus().then(setOnboarding).catch(() => {});
  }, []);

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

export function App() {
  return (
    <ThemeProvider>
      <Root />
    </ThemeProvider>
  );
}
