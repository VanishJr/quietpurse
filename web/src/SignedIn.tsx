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
 *
 * ---------------------------------------------------------------------------
 * Which of the six is showing is in the URL
 *
 * `?screen=` names it, and the Overview adds `?account=` and `?panel=` of its own — see
 * `url.ts`, including why a query parameter rather than a path. What it buys here is
 * the Back button: six destinations and an import panel that could each be entered and
 * none of which could be left by the one control every browser puts on the window.
 *
 * ---------------------------------------------------------------------------
 * ...which is what lets the destinations be links
 *
 * Every section, and the avatar, is an `<a href>` carrying the URL it would move to.
 * They were `<button onClick>` — a control that HAPPENS to change the page, and a
 * browser has no way to find that out. So Cmd-click, middle click, "Open in a new tab"
 * and "Copy link address" were all missing from the one element on the screen whose
 * entire job is going somewhere, and hovering a section said nothing in the status bar.
 * None of that was an oversight while the app had no addresses to put in an `href`; it
 * has them now.
 *
 * A plain left click stays the app's: `preventDefault` and the same `setUrl` the button
 * called, so nothing reloads, no screen is unmounted and nothing already fetched is
 * thrown away. Every other click is handed straight back to the browser. That rule is
 * written once, in `navigate` below.
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
  /** The reader is on the import page, whichever control took them there. */
  const importing = onOverview && url.panel === 'import';
  /** Only the Overview's own hero continues the band, and only where the bar left it. */
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
   * Import is a panel OF the Overview, so this is that screen with that panel up —
   * one write, and both components see it in the same commit.
   *
   * It used to be three statements that could not all land at once, and the bar drew a
   * frame of the wrong thing between them: the Overview reported its panel from a
   * passive effect, which runs after the paint, so entering Import from another tab
   * painted one merged, shadowless bar over a panel with no hero to continue it.
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
      {/* The bar above the content carries seven controls before the first thing on the
          screen, and a keyboard walks all seven on every arrival. The landing page has
          had this since it was written (`Landing.tsx`); the app, which is the side people
          come back to daily, had not. */}
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
                It opens a panel of the Overview rather than a screen of its own, and
                for a long time that was the reason it carried no `aria-current` — but
                what the reader sees is a full window of Import under a bar that says
                Overview. Where the page lives is this app's business; which of these
                five is being looked at is theirs.
              */}
              <a
                className="nav-item nav-import"
                // a panel of the Overview is a URL like any other, which is why this one
                // is as linkable as the five screens
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
            {/* the letter, not a photograph; it goes where the address and the
                settings are, which is the fifth screen */}
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
