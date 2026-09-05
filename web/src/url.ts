/**
 * Where the reader is, kept in the URL.
 *
 * Three facts: which of the six destinations is on screen, which account the Overview
 * is about, and which panel has taken that screen over. They were three `useState`s in
 * two components, which meant the app had no answer to Back, to Reload, or to "send me
 * the link" — a session was a thing you could only be in, never return to.
 *
 * ---------------------------------------------------------------------------
 * Query parameters, and the path is never touched
 *
 * `?screen=transactions`, not `/transactions`. The build is a two-page one — the app is
 * `index.html` and the public page is `landing.html` — so a path this module invented
 * would be a path the host has to be told to rewrite back to `index.html`, and told
 * without swallowing the landing page. A query string needs nothing from anybody: the
 * path stays whatever served the app, and the same file answers every URL this writes.
 *
 * Anything already in the query survives a write. Only the three keys below are set or
 * removed, so a `?ref=` somebody arrived on is still there afterwards.
 *
 * ---------------------------------------------------------------------------
 * Why an external store rather than a hook with state in it
 *
 * Two components read this — the navigation reads `screen`, the Overview reads
 * `account` and `panel` — and Back has to move both at once. `useState` in either one
 * cannot hear `popstate`, and a copy in each is two copies to disagree.
 *
 * `useSyncExternalStore` is the primitive for exactly this: the URL is the store, and
 * both components subscribe to it. It also means the two are no longer wired to each
 * other. The Overview used to be handed a counter that was bumped to ask it to open its
 * import panel, and to report the panel back up so the bar could mark Import as the
 * current page; both directions were working around a fact neither component owned.
 * They read it from here now, and the counters are gone.
 */
import { useSyncExternalStore } from 'react';

export interface AppUrl {
  /** One of Shell's TabKeys, unvalidated — this module does not know them. */
  screen: string | null;
  /** The account id the Overview is about, or null for "whichever is first". */
  account: string | null;
  /** 'import' or 'history', unvalidated for the same reason `screen` is. */
  panel: string | null;
  /**
   * Which chart the Analytics workspace is showing — a chart id this module knows
   * nothing about, like the three above.
   *
   * The charts themselves belong to the workspace and are read from the server (see
   * `analytics.ts`), so a link carrying one of these ids opens the right tab on every
   * device the person who made it signs in on, and falls back to the first chart for
   * anybody else. That is the same promise `account` already makes: the URL says where
   * the reader was, and the reader's own data says whether that place still exists.
   */
  chart: string | null;
}

const KEYS = ['screen', 'account', 'panel', 'chart'] as const;

const EMPTY: AppUrl = { screen: null, account: null, panel: null, chart: null };

/**
 * The last query string parsed, and what it parsed to.
 *
 * `useSyncExternalStore` calls `read` on every render and compares what comes back by
 * IDENTITY. A fresh object each time is a new identity each time, which it reads as
 * "changed again" — it re-renders, calls `read`, and finds another new object: the
 * documented infinite loop. So an unchanged `location.search` has to answer with the
 * very same object, which is what this pair is for.
 */
let cachedSearch: string | null = null;
let cached: AppUrl = EMPTY;

function read(): AppUrl {
  const search = window.location.search;
  if (search === cachedSearch) return cached;
  const params = new URLSearchParams(search);
  cachedSearch = search;
  cached = {
    screen: params.get('screen'),
    account: params.get('account'),
    panel: params.get('panel'),
    chart: params.get('chart'),
  };
  return cached;
}

/**
 * Subscribers, for the writes this module makes itself.
 *
 * `pushState` and `replaceState` deliberately do not fire `popstate` — that event is
 * the user moving through history, not the app writing to it — so a write has to tell
 * the subscribers. `popstate` covers the other half: the back and forward buttons.
 */
const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener('popstate', onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('popstate', onChange);
  };
}

/** The current URL as this module writes them, for the no-op check below. */
const href = (): string =>
  `${window.location.pathname}${window.location.search}${window.location.hash}`;

/**
 * The URL a patch would move to, without moving to it.
 *
 * Exported because the navigation is anchors now, and an `href` is a promise about
 * where a click lands. Building it a second time in Shell.tsx would be two pieces
 * of code that agree until one of them is edited — and the failure is invisible from
 * the app's own side: the click still works, because the click never uses the `href`
 * at all. What would be wrong is the address in the status bar, in the copied link,
 * and in the tab that a middle click opens, which is the entire point of the change.
 */
export function urlFor(patch: Partial<AppUrl>): string {
  const next = { ...read(), ...patch };
  const params = new URLSearchParams(window.location.search);
  for (const key of KEYS) {
    const value = next[key];
    if (value) params.set(key, value);
    else params.delete(key);
  }
  const query = params.toString();
  return `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
}

/**
 * Move some of the three. Everything not named in the patch stays as it is — so
 * changing the screen keeps the account, which is what makes coming back to the
 * Overview come back to the account that was being read.
 *
 * `replace` is for a value the APP derived rather than one the reader chose: it must
 * not leave a history entry, or Back would land on the URL the app was about to
 * correct and correct it again, which is a Back button that does nothing.
 */
export function setUrl(patch: Partial<AppUrl>, mode: 'push' | 'replace' = 'push'): void {
  const url = urlFor(patch);

  // A click on the section already showing is not a navigation. Without this it is a
  // history entry identical to the one under it, and Back then has to be pressed once
  // per click to get anywhere.
  if (url === href()) return;

  if (mode === 'push') window.history.pushState(null, '', url);
  else window.history.replaceState(null, '', url);

  // a copy, because a subscriber is free to unsubscribe while it is being notified
  for (const listener of [...listeners]) listener();
}

/**
 * No `getServerSnapshot` third argument: this app never renders on a server, and
 * passing `read` as one would be a claim that `window.location` is readable there.
 */
export function useUrl(): AppUrl {
  return useSyncExternalStore(subscribe, read);
}
