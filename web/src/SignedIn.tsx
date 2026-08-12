/**
 * The application: the five screens and the navigation. Mounted only with a session,
 * so every request below is scoped to the user's workspace.
 *
 * It is a module of its own so that it can be a chunk of its own: imported directly by
 * App.tsx it puts the whole app - five screens and recharts with it - into the bundle
 * the sign-in form is served from, downloaded and parsed by somebody who does not have
 * an account yet. App.tsx reaches it through `lazy()` instead.
 *
 * The navigation is ONE element in two shapes: a bar across the top when there is room,
 * and `position: fixed` at the foot of the window when there is not - never a second
 * copy rendered beside the first, which would put every section name in the
 * accessibility tree twice.
 *
 * `Import` is in that list and is hidden on a phone: it does not fit five-across, and
 * the Account screen carries its own control for it. `Account` is NOT in the list - it
 * is the avatar at the right of the bar, which is what frees the fifth slot for Import.
 *
 * The nav comes first in the DOM. The screens are what a keyboard should reach first,
 * which is what the `row-reverse` it replaced was for, and that does not survive a bar
 * that is visually above the content: an order that disagrees with the painted one is
 * worse for a keyboard than a short tab-through.
 *
 * Which of the six is showing is in the URL - `?screen=`, plus the Overview's own
 * `?account=` and `?panel=`; see `url.ts`, including why a query parameter rather than
 * a path. What it buys is the Back button.
 *
 * Every section, and the avatar, is an `<a href>` carrying the URL it would move to,
 * not a `<button onClick>`: a control that HAPPENS to change the page is one a browser
 * cannot offer Cmd-click, middle click, "Open in a new tab" or "Copy link address" for.
 * A plain left click stays the app's and every other click is handed straight back to
 * the browser; that rule is written once, in `navigate` below.
 */
import React, { useEffect, useRef, useState } from 'react';
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
import { OverviewScreen } from './screens/OverviewScreen';
import { TransactionsScreen } from './screens/TransactionsScreen';
import { ThemeMode, useTheme } from './theme';
import { TxFocus } from './types';
import { setUrl, urlFor, useUrl } from './url';

const TABS = [
  { key: 'overview', title: 'Overview', Icon: OverviewIcon },
  { key: 'analytics', title: 'Analytics', Icon: AnalyticsIcon },
  { key: 'transactions', title: 'Transactions', Icon: TransactionsIcon },
  { key: 'goal', title: 'Goals', Icon: GoalsIcon },
] as const;

type TabKey = (typeof TABS)[number]['key'] | 'account';

const TAB_KEYS: readonly TabKey[] = [...TABS.map((t) => t.key), 'account'];

/**
 * Which screen a URL is asking for, and Overview for a URL that asks for nothing this
 * app has. `?screen=` is typed by anybody who wants to type it — and an old link to a
 * screen since renamed is the same case — so this is a normal arrival rather than an
 * error: the alternative is a blank window under a bar with nothing marked on it.
 */
const tabOf = (screen: string | null): TabKey =>
  TAB_KEYS.includes(screen as TabKey) ? (screen as TabKey) : 'overview';

/**
 * What each destination in the bar moves by. Every one of them is written twice now —
 * once as the `href` the browser is shown and once as the write a click makes — and
 * these two are what stop the pair from ever being different patches. A bar that
 * advertises one address and delivers another is worse than one that advertises none:
 * the click still works, so nothing in the app is visibly wrong, and what is wrong is
 * the link somebody copied out of it.
 */
const patchFor = (key: TabKey) => ({ screen: key, panel: null });

/** Import is a panel OF the Overview, which is a URL like any other. */
const IMPORT_PATCH = { screen: 'overview', panel: 'import' } as const;

const NEXT_MODE: Record<ThemeMode, ThemeMode> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
};
const MODE_GLYPH: Record<ThemeMode, string> = { system: '◐', light: '☀', dark: '☾' };
const MODE_NAME: Record<ThemeMode, string> = { system: 'Auto', light: 'Light', dark: 'Dark' };

export function SignedIn({ user, onSignedOut }: { user: SessionUser; onSignedOut: () => void }) {
  const { mode, setMode } = useTheme();
  /**
   * Where the reader is, read from the URL rather than held here — so Back, Reload and
   * a pasted link all land on the screen they name. See `url.ts`.
   *
   * Two counters and a callback stood in this place. The bar had to ASK the Overview to
   * open its import panel — a counter and not a boolean, because asking twice has to be
   * two events rather than one value set twice — ask it again to close whatever panel
   * was open, since clicking Overview while the import panel was up moved no `tab` and
   * so did nothing at all, and then be TOLD BACK which panel had ended up open, because
   * Import is a section in this bar and a panel on that screen. Three mechanisms, one
   * missing fact: neither component owned where the reader was. The URL owns it.
   */
  const url = useUrl();
  const tab = tabOf(url.screen);
  const [focus, setFocus] = useState<TxFocus | null>(null);
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
  }, [url.panel]);

  const onOverview = tab === 'overview';
  const importing = onOverview && url.panel === 'import';
  const bandRunsOn = onOverview && url.panel === null && atTop;

  /**
   * Every destination in the bar goes through here, so none of them can forget.
   *
   * The panel is dropped whichever screen is being asked for, and that one line is both
   * halves of what the second counter used to do. A panel is a page OF the Overview, so
   * clicking Overview has to be the way out of one — `tab` was already on that screen,
   * so moving it changed nothing and Import could be entered and never left — and a
   * panel left open behind a reader who walked away to another screen is Overview
   * answering with Import when they come back to it, having asked for the dashboard.
   *
   * The account is NOT dropped: coming back to the Overview comes back to the account
   * that was being read.
   *
   * The early return is about `tab` and not about the URL, which is why `setUrl` cannot
   * make it: the app opens on `/`, where Overview is the current screen without being
   * named, so clicking Overview there would write `?screen=overview` — a different URL
   * that paints the identical window, and a history entry Back can only step over
   * silently. Two states of this bar are the same page, and only this side knows it.
   */
  const go = (key: TabKey) => {
    if (key === tab && url.panel === null) return;
    setUrl(patchFor(key));
  };

  /**
   * Which half of a link click belongs to the app.
   *
   * Only the plain one. A modifier means the reader asked the BROWSER for something —
   * a new tab, a new window, a download, the link on the clipboard — and every one of
   * those is answered by doing nothing here and leaving the anchor alone. `button !== 0`
   * is the middle click, which is a new tab as well; on the browsers this runs on React
   * would not deliver that to `onClick` anyway, so it is the belt rather than the
   * braces, but the rule reads as one rule with it written down.
   */
  const navigate = (e: React.MouseEvent, run: () => void) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    run();
  };

  const openTransactions = (accountId: string) => {
    setFocus((prev) => ({ accountId, nonce: (prev?.nonce ?? 0) + 1 }));
    setUrl({ screen: 'transactions', panel: null });
  };

  /**
   * Import is a panel OF the Overview, so this is that screen with that panel up - one
   * write, and both components see it in the same commit. Separate writes cannot all
   * land at once, and the bar then draws a frame of the wrong thing between them: a
   * panel reported from a passive effect runs after the paint, so entering Import from
   * another tab paints a merged, shadowless bar over a panel with no hero to continue
   * it.
   */
  const openImport = () => setUrl(IMPORT_PATCH);

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
      {/* The bar above the content carries every one of its controls before the first
          thing on the screen, and a keyboard walks all of them on every arrival. */}
      <a className="skip" href="#screens">
        Skip to the content
      </a>

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
                <a
                  key={t.key}
                  className="nav-item"
                  // the same patch on both, so the address on hover cannot drift from
                  // the screen a click lands on
                  href={urlFor(patchFor(t.key))}
                  onClick={(e) => navigate(e, () => go(t.key))}
                  // Overview yields the mark while its import panel is up: two current
                  // pages is no answer, and of the two it is Import the reader is on
                  aria-current={tab === t.key && !(t.key === 'overview' && importing) ? 'page' : undefined}
                >
                  <t.Icon />
                  <span className="nav-label">{t.title}</span>
                </a>
              ))}
              {/*
                It opens a panel of the Overview rather than a screen of its own, and it
                still carries `aria-current`: what the reader sees is a full window of
                Import, and a bar that said Overview over it would be answering a
                different question. Where the page lives is this app's business; which of
                these five is being looked at is theirs.
              */}
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
              className="avatar"
              href={urlFor(patchFor('account'))}
              onClick={(e) => navigate(e, () => go('account'))}
              aria-current={tab === 'account' ? 'page' : undefined}
              aria-label={`Account: ${user.email}`}
            >
              <span aria-hidden="true">{initialOf(user)}</span>
            </a>
          </div>
        </div>
      </header>

      {/*
        Screens stay mounted so filters and already-loaded data survive a tab switch;
        `hidden` only takes the inactive ones out of layout and the a11y tree.
      */}
      <main className="screens" id="screens">
        <div className="screen" ref={overview} hidden={tab !== 'overview'}>
          <OverviewScreen
            user={user}
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
          <IndependenceScreen />
        </div>
        <div className="screen" hidden={tab !== 'account'}>
          <AccountScreen user={user} onSignOut={signOut} onOpenImport={openImport} />
        </div>
      </main>
    </div>
  );
}
