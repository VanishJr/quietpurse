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
 * ---------------------------------------------------------------------------
 * The navigation is one element in two shapes
 *
 * The design puts it across the top: a navy bar with the wordmark at the left, the
 * sections centred in it as pills, and the theme button and the avatar at the right.
 * That is the wide shape, and it replaced the navy sidebar the app had — which is
 * also why the content panel no longer has a rounded left edge: there is nothing to
 * the left of it to lay it on any more.
 *
 * The narrow shape is the bottom bar of the phone app, unchanged, and it is the same
 * element — `position: fixed` at the foot of the window rather than a second copy of
 * the nav rendered beside the first. Two copies would put every section name in the
 * accessibility tree twice.
 *
 * `Import` is in that list now rather than in a foot of its own, and is still hidden
 * on a phone for the reason it always was: it does not fit five-across, and the Account
 * screen carries its own control for it. The Overview carries one as well, but only in
 * its two blank states — so on a phone with accounts already in it, the Account screen
 * is the one route to Import rather than the second of two.
 *
 * `Account` is NOT in the list. It is the avatar at the right of the bar, which is
 * where the design puts it and what frees the fifth slot for Import.
 *
 * The nav comes first in the DOM now, where the sidebar came last. That was a
 * deliberate `row-reverse` — the screens are what a keyboard should reach first — and
 * it does not survive a bar that is visually above the content: an order that
 * disagrees with the painted one is worse for a keyboard than a short tab-through.
 */
import { useEffect, useRef, useState } from 'react';
import { auth, SessionUser } from './api';
import {
  AnalyticsIcon,
  GoalsIcon,
  ImportIcon,
  OverviewIcon,
  TransactionsIcon,
} from './components/NavIcons';
import { initialOf } from './identity';
import { AccountScreen } from './screens/AccountScreen';
import { AnalyticsScreen } from './screens/AnalyticsScreen';
import { IndependenceScreen } from './screens/IndependenceScreen';
import { OverviewScreen, PanelKind } from './screens/OverviewScreen';
import { TransactionsScreen } from './screens/TransactionsScreen';
import { ThemeMode, useTheme } from './theme';
import { TxFocus } from './types';

const TABS = [
  { key: 'overview', title: 'Overview', Icon: OverviewIcon },
  { key: 'analytics', title: 'Analytics', Icon: AnalyticsIcon },
  { key: 'transactions', title: 'Transactions', Icon: TransactionsIcon },
  { key: 'goal', title: 'Goals', Icon: GoalsIcon },
] as const;

type TabKey = (typeof TABS)[number]['key'] | 'account';

/** Theme button cycle: system → light → dark. */
const NEXT_MODE: Record<ThemeMode, ThemeMode> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
};
const MODE_GLYPH: Record<ThemeMode, string> = { system: '◐', light: '☀', dark: '☾' };
const MODE_NAME: Record<ThemeMode, string> = { system: 'Auto', light: 'Light', dark: 'Dark' };

export function SignedIn({ user, onSignedOut }: { user: SessionUser; onSignedOut: () => void }) {
  const { mode, setMode } = useTheme();
  const [tab, setTab] = useState<TabKey>('overview');
  const [focus, setFocus] = useState<TxFocus | null>(null);
  /**
   * Bumped by the bar's Import. A counter and not a boolean for the reason
   * `TxFocus` carries a nonce: the Overview stays mounted and owns which panel is
   * open, so asking it twice has to be two events rather than one value set twice.
   */
  const [importAsk, setImportAsk] = useState(0);
  /**
   * The same thing the other way round, and the reason it has to exist: the bar's
   * Overview was `setTab('overview')` and nothing else, which is a no-op while the
   * import panel is up — that panel IS the Overview screen at that moment, and the tab
   * was already on it. So Import could be entered and never left: every click on
   * Overview looked like it bounced straight back to Import.
   *
   * A counter for the same reason `importAsk` is one, and bumped on every Overview
   * click rather than only on the ones that change `tab`: leaving a panel open on a
   * screen the reader has walked away from means Overview answers with Import when
   * they come back to it, having asked for the dashboard.
   */
  const [overviewAsk, setOverviewAsk] = useState(0);
  /**
   * Which panel the Overview has taken itself over with, reported up by that screen.
   *
   * Import is a section in this bar but a panel on that screen, so `tab` alone cannot
   * say where the reader is: it read 'overview' while the import page filled the
   * window, and the bar marked Overview as the current page over it. This is the
   * missing half of that answer, and it decides two things below — which item is
   * current, and whether the band this bar starts is continued by anything.
   */
  const [ovPanel, setOvPanel] = useState<PanelKind | null>(null);
  /**
   * Whether the Overview is scrolled to its top, which is the other half of the same
   * question and was missing from it.
   *
   * The band runs on into that screen's hero, but only while the hero is where this bar
   * left it. `.screen` is the scroll container, so scrolling the dashboard past its
   * hero takes the navy out from under the bar — and `is-merged` had dropped the very
   * shadow that separates a navy bar from the near-white page then arriving under it.
   * Every other tab kept that shadow; the Overview lost it for as long as it was up.
   */
  const [atTop, setAtTop] = useState(true);
  const overview = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = overview.current;
    if (!el) return;
    // sub-pixel and not equality: a trackpad and a zoomed window both produce
    // fractional scroll positions, and 0.5px down is still the top of the page
    const read = () => setAtTop(el.scrollTop < 1);
    // read on the way in and out of a panel as well as on scroll: that swaps the whole
    // content of this container, and a scrollTop the browser clamps to a shorter page
    // does not always announce itself
    read();
    el.addEventListener('scroll', read, { passive: true });
    return () => el.removeEventListener('scroll', read);
  }, [ovPanel]);

  const onOverview = tab === 'overview';
  /** The reader is on the import page, whichever control took them there. */
  const importing = onOverview && ovPanel === 'import';
  /** Only the Overview's own hero continues the band, and only where the bar left it. */
  const bandRunsOn = onOverview && ovPanel === null && atTop;

  /** Every destination in the bar goes through here, so none of them can forget. */
  const go = (key: TabKey) => {
    if (key === 'overview') {
      setOverviewAsk((n) => n + 1);
      // what that ask is about to do, said in the same commit rather than a frame
      // later — the reason is under `openImport` below
      setOvPanel(null);
    }
    setTab(key);
  };

  const openTransactions = (accountId: string) => {
    setFocus((prev) => ({ accountId, nonce: (prev?.nonce ?? 0) + 1 }));
    setTab('transactions');
  };

  const openImport = () => {
    setImportAsk((n) => n + 1);
    setTab('overview');
    /*
      The Overview reports its panel from a passive effect, which runs after the paint
      of the commit that opened it. So entering Import from another tab drew one frame
      of `onOverview && ovPanel === null` — a merged, shadowless bar over a panel that
      has no hero to continue it — and only then corrected itself.

      This is not a second source of truth: it is the same fact the effect is about to
      report, said by the side that already knows it. The effect still owns every panel
      this bar did not open (the import history, and a panel closed from inside the
      screen), and when it reports 'import' back it sets the value already here.
    */
    setOvPanel('import');
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
        `is-merged` is the one thing about the band this component knows and CSS cannot
        work out: on the Overview the dark band does not end at the foot of this bar, it
        runs on into that screen's hero, so the shadow belongs to the hero and a second
        one cast from here would be a stripe across the middle of it.

        Three facts and not one, which is what `bandRunsOn` is: the right screen, with
        no panel over its hero, still scrolled to where that hero is under this bar.
      */}
      <header className={`topbar ov-band${bandRunsOn ? ' is-merged' : ''}`}>
        {/* the same column the screens are laid out in, so the wordmark lines up with
            the first card under it and the avatar with the last */}
        <div className="shell topbar-inner">
          <div className="nav-mark">Finto</div>

          <nav className="tabbar" aria-label="Sections">
            <div className="nav-list">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  className="nav-item"
                  onClick={() => go(t.key)}
                  // Overview yields the mark while its import panel is up: two current
                  // pages is no answer, and of the two it is Import the reader is on
                  aria-current={tab === t.key && !(t.key === 'overview' && importing) ? 'page' : undefined}
                >
                  <t.Icon />
                  <span className="nav-label">{t.title}</span>
                </button>
              ))}
              {/*
                It opens a panel of the Overview rather than a screen of its own, and
                for a long time that was the reason it carried no `aria-current` — but
                what the reader sees is a full window of Import under a bar that says
                Overview. Where the page lives is this app's business; which of these
                five is being looked at is theirs.
              */}
              <button
                className="nav-item nav-import"
                onClick={openImport}
                aria-current={importing ? 'page' : undefined}
              >
                <ImportIcon />
                <span className="nav-label">Import</span>
              </button>
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
            {/* the letter, not a photograph; it goes where the address and the
                settings are, which is the fifth screen */}
            <button
              className="avatar"
              onClick={() => go('account')}
              aria-current={tab === 'account' ? 'page' : undefined}
              aria-label={`Account: ${user.email}`}
            >
              <span aria-hidden="true">{initialOf(user)}</span>
            </button>
          </div>
        </div>
      </header>

      {/*
        Screens stay mounted so filters and already-loaded data survive a tab switch;
        `hidden` only takes the inactive ones out of layout and the a11y tree.
      */}
      <main className="screens">
        <div className="screen" ref={overview} hidden={tab !== 'overview'}>
          <OverviewScreen
            user={user}
            importAsk={importAsk}
            onOpenTransactions={openTransactions}
            overviewAsk={overviewAsk}
            onOpenAnalytics={() => setTab('analytics')}
            onPanelChange={setOvPanel}
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
    </div>
  );
}
