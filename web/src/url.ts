/**
 * Where the reader is, kept in the URL — as query parameters, and the path is never
 * touched: `?screen=transactions`, not `/transactions`, because a path this module
 * invented would rest on the shape rule of the server's fallback — two places agreeing
 * on what a file looks like — and a query string rests on nothing: the path stays
 * whatever served the app. Anything already in the query survives a write: only the
 * keys in `KEYS` are set or removed, so a `?ref=` somebody arrived on is still there
 * afterwards.
 */
import { useSyncExternalStore } from 'react';

export interface AppUrl {
  /** Unvalidated here — this module does not know the tabs; `tabOf` in the shell does. */
  screen: string | null;
  /** The account id the Overview is about, or null for "whichever is first". */
  account: string | null;
  /** Unvalidated here, for the same reason `screen` is. */
  panel: string | null;
  /** A chart id this module knows nothing about, like the account id above. */
  chart: string | null;
}

const KEYS = ['screen', 'account', 'panel', 'chart'] as const;

const EMPTY: AppUrl = { screen: null, account: null, panel: null, chart: null };

/**
 * An unchanged `location.search` has to answer with the very same object, which is what
 * this pair is for: `useSyncExternalStore` compares what `read` returns by IDENTITY, and
 * a fresh object per read is the documented infinite loop — re-render, read, another
 * new object.
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
 * Subscribers, for the writes this module makes itself: a `pushState` or a
 * `replaceState` fires no `popstate` — that event is the user moving through history,
 * not the app writing to it — so a write has to tell the subscribers, and `popstate`
 * covers the other half, the back and forward buttons.
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

/** The URL a patch would move to, without moving to it; exported for the shell's anchors. */
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
 * Everything not named in the patch stays as it is — so changing the screen keeps the
 * account, which is what makes coming back to the Overview come back to the account
 * that was being read.
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
