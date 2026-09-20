import React, { useState } from 'react';
import {
  AnalyticsIcon,
  GoalsIcon,
  ImportIcon,
  OverviewIcon,
  SettingsIcon,
  TransactionsIcon,
} from './components/NavIcons';
import { AnalyticsScreen } from './screens/AnalyticsScreen';
import { GoalsScreen } from './screens/GoalsScreen';
import { OverviewScreen } from './screens/OverviewScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { TransactionsScreen } from './screens/TransactionsScreen';
import { ThemeMode, useTheme } from './theme';
import { TxFocus } from './types';
import { setUrl, urlFor, useUrl } from './url';

const TABS = [
  { key: 'overview', title: 'Overview', Icon: OverviewIcon },
  { key: 'transactions', title: 'Transactions', Icon: TransactionsIcon },
  { key: 'analytics', title: 'Analytics', Icon: AnalyticsIcon },
  { key: 'goal', title: 'Goals', Icon: GoalsIcon },
] as const;

type TabKey = (typeof TABS)[number]['key'] | 'settings';

const TAB_KEYS: readonly TabKey[] = [...TABS.map((t) => t.key), 'settings'];

const tabOf = (screen: string | null): TabKey =>
  TAB_KEYS.includes(screen as TabKey) ? (screen as TabKey) : 'overview';

const patchFor = (key: TabKey) => ({ screen: key, panel: null });

const IMPORT_PATCH = { screen: 'overview', panel: 'import' } as const;

const NEXT_MODE: Record<ThemeMode, ThemeMode> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
};
const MODE_GLYPH: Record<ThemeMode, string> = { system: '◐', light: '☀', dark: '☾' };
const MODE_NAME: Record<ThemeMode, string> = {
  system: 'Auto',
  light: 'Light',
  dark: 'Dark',
};

export function Shell() {
  const { mode, setMode } = useTheme();

  const url = useUrl();
  const tab = tabOf(url.screen);
  const [focus, setFocus] = useState<TxFocus | null>(null);

  const onOverview = tab === 'overview';
  const importing = onOverview && url.panel === 'import';

  const go = (key: TabKey) => {
    // on `tab`, not the URL: the app opens on `/`, where Overview is current without being
    // named, and writing `?screen=overview` there is a history entry Back steps over silently
    if (key === tab && url.panel === null) return;
    setUrl(patchFor(key));
  };

  const navigate = (e: React.MouseEvent, run: () => void) => {
    // a modified click asked the browser for something — a new tab, the link copied —
    // and is left to it
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    run();
  };

  const openTransactions = (accountId: string) => {
    setFocus((prev) => ({ accountId, nonce: (prev?.nonce ?? 0) + 1 }));
    setUrl({ screen: 'transactions', panel: null });
  };

  const openImport = () => setUrl(IMPORT_PATCH);

  return (
    <div className="app">
      <a className="skip" href="#screens">
        Skip to the content
      </a>

      <header className="topbar">
        <div className="topbar-inner">
          <div className="nav-mark">
            <span className="brand-glyph" aria-hidden="true">
              f
            </span>
            Finto<span className="brand-period">.</span>
          </div>

          <nav className="tabbar" aria-label="Sections">
            <div className="nav-list">
              {TABS.map((t) => (
                <a
                  key={t.key}
                  className="nav-item"
                  // the same patch on both, so the address on hover cannot drift from
                  // the screen a click lands on
                  href={urlFor(patchFor(t.key))}
                  onClick={(e) => navigate(e, () => go(t.key))}
                  // Overview yields the mark while its import panel is up: two current
                  // pages is no answer, and of the two it is Import the reader is on
                  aria-current={
                    tab === t.key && !(t.key === 'overview' && importing)
                      ? 'page'
                      : undefined
                  }
                >
                  <t.Icon />
                  <span className="nav-label">{t.title}</span>
                </a>
              ))}

              <a
                className="nav-item nav-import"
                href={urlFor(IMPORT_PATCH)}
                onClick={(e) => navigate(e, openImport)}
                aria-current={importing ? 'page' : undefined}
              >
                <ImportIcon />
                <span className="nav-label">Import</span>
              </a>
            </div>
          </nav>

          <div className="topbar-actions">
            <button
              className="icon-btn"
              onClick={() => setMode(NEXT_MODE[mode])}
              aria-label={`Theme: ${MODE_NAME[mode]}. Click to change`}
            >
              <span aria-hidden="true">{MODE_GLYPH[mode]}</span>
            </button>
            <a
              className="settings-link"
              href={urlFor(patchFor('settings'))}
              onClick={(e) => navigate(e, () => go('settings'))}
              aria-current={tab === 'settings' ? 'page' : undefined}
              aria-label="Settings"
            >
              <SettingsIcon />
              <span className="settings-label">Settings</span>
            </a>
          </div>
          <p className="device-note">
            <span aria-hidden="true" />
            Stored on this device
          </p>
        </div>
      </header>

      <main className="screens" id="screens" tabIndex={-1}>
        <div className="screen" hidden={tab !== 'overview'}>
          <OverviewScreen
            onOpenTransactions={openTransactions}
            onOpenAnalytics={() => go('analytics')}
          />
        </div>
        <div className="screen" hidden={tab !== 'transactions'}>
          <TransactionsScreen focus={focus} />
        </div>
        <div className="screen" hidden={tab !== 'analytics'}>
          <AnalyticsScreen />
        </div>
        <div className="screen" hidden={tab !== 'goal'}>
          <GoalsScreen />
        </div>
        <div className="screen" hidden={tab !== 'settings'}>
          <SettingsScreen onOpenImport={openImport} />
        </div>
      </main>
    </div>
  );
}
