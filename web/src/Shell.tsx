import React, { useEffect, useRef, useState } from 'react';
import {
  AnalyticsIcon,
  GoalsIcon,
  ImportIcon,
  MoonIcon,
  OverviewIcon,
  SettingsIcon,
  SunIcon,
  TransactionsIcon,
} from './components/NavIcons';
import { AnalyticsScreen } from './screens/AnalyticsScreen';
import { GoalsScreen } from './screens/GoalsScreen';
import { OverviewScreen } from './screens/OverviewScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { TransactionsScreen } from './screens/TransactionsScreen';
import { ScreenShown } from './screen';
import { useTheme } from './theme';
import { TxFocus } from './types';
import { NavigationNotice } from './components/NavigationNotice';
import { setUrl, urlFor, useUrl } from './url';
import { isAvailable } from './dismiss';

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

/** One `shown` for both, so the `hidden` a screen sits under and what its sheets are told cannot differ. */
const Screen = ({ shown, children }: { shown: boolean; children: React.ReactNode }) => (
  <div className="screen" hidden={!shown}>
    <ScreenShown value={shown}>
      {shown && <NavigationNotice className="navigation-notice" />}
      {children}
    </ScreenShown>
  </div>
);

export function Shell() {
  const { scheme, setScheme } = useTheme();

  const url = useUrl();
  const tab = tabOf(url.screen);
  const [focus, setFocus] = useState<TxFocus | null>(null);
  const [dataRevision, setDataRevision] = useState(0);
  const [accountsRevision, setAccountsRevision] = useState(0);

  const onOverview = tab === 'overview';
  const importing = onOverview && url.panel === 'import';
  const place = `${tab}:${url.panel ?? ''}`;
  const previousPlace = useRef(place);
  useEffect(() => {
    if (previousPlace.current === place) return;
    previousPlace.current = place;
    const screen = document.querySelector<HTMLElement>('.screen:not([hidden])');
    if (Array.from(screen?.querySelectorAll<HTMLElement>('[role="dialog"]') ?? []).some(isAvailable)) return;
    const heading = Array.from(screen?.querySelectorAll<HTMLElement>('h1, h2') ?? []).find(isAvailable);
    if (heading) {
      heading.tabIndex = -1;
      heading.focus();
    }
  }, [place]);

  const go = (key: TabKey) => {
    // on `tab`, not the URL: the app opens on `/`, where Overview is current without being
    // named, and writing `?screen=overview` there is a history entry Back steps over silently
    if (key === tab && url.panel === null) return;
    setUrl(patchFor(key));
  };

  const navigate = (e: React.MouseEvent, run: () => void) => {
    // a modified click asked the browser for something — the address in a new page, or
    // downloaded — and is left to it
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    run();
  };

  const openTransactions = (accountId: string) => {
    setUrl({ screen: 'transactions', panel: null }, 'push', () => {
      setFocus((prev) => ({ accountId, nonce: (prev?.nonce ?? 0) + 1 }));
    });
  };

  const openImport = () => setUrl(IMPORT_PATCH);

  const dataChanged = () => setDataRevision((value) => value + 1);
  const accountsChanged = () => setAccountsRevision((value) => value + 1);

  return (
    <div className="app">
      <a className="skip" href="#screens">
        Skip to the content
      </a>

      <header className="topbar">
        <div className="topbar-inner">
          <div className="nav-mark">
            <svg className="brand-mark" viewBox="0 0 300 300" aria-hidden="true">
              <rect width="300" height="300" rx="62" />
              <path d="M247 216.5H138A66.5 66.5 0 1 1 187.42 194.5" />
            </svg>
            quiet<b>purse</b>
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
              <a
                className="nav-item"
                href={urlFor(patchFor('settings'))}
                onClick={(e) => navigate(e, () => go('settings'))}
                aria-current={tab === 'settings' ? 'page' : undefined}
              >
                <SettingsIcon />
                <span className="nav-label">Settings</span>
              </a>
            </div>
          </nav>

          <div className="topbar-actions">
            <button
              type="button"
              className="theme-toggle"
              aria-label="Dark mode"
              aria-pressed={scheme === 'dark'}
              onClick={() => setScheme(scheme === 'dark' ? 'light' : 'dark')}
            >
              <span className="theme-toggle-track" aria-hidden="true">
                <span className="theme-toggle-thumb">{scheme === 'dark' ? <MoonIcon /> : <SunIcon />}</span>
              </span>
            </button>
          </div>
          <p className="device-note">
            <span aria-hidden="true" />
            Stored on this device
          </p>
        </div>
      </header>

      <main className="screens" id="screens" tabIndex={-1}>
        <Screen shown={tab === 'overview'}>
          <OverviewScreen
            onOpenTransactions={openTransactions}
            onOpenAnalytics={() => go('analytics')}
            onDataChanged={dataChanged}
            onAccountsChanged={accountsChanged}
            dataRevision={dataRevision}
          />
        </Screen>
        <Screen shown={tab === 'transactions'}>
          <TransactionsScreen
            focus={focus}
            dataRevision={dataRevision}
            accountsRevision={accountsRevision}
          />
        </Screen>
        <Screen shown={tab === 'analytics'}>
          <AnalyticsScreen dataRevision={dataRevision} accountsRevision={accountsRevision} />
        </Screen>
        <Screen shown={tab === 'goal'}>
          <GoalsScreen reloadToken={dataRevision} accountsRevision={accountsRevision} />
        </Screen>
        <Screen shown={tab === 'settings'}>
          <SettingsScreen
            onOpenImport={openImport}
            onDataChanged={dataChanged}
            dataRevision={dataRevision}
          />
        </Screen>
      </main>
    </div>
  );
}
