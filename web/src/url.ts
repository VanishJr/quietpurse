import { useSyncExternalStore } from 'react';

export interface AppUrl {
  screen: string | null;
  account: string | null;
  panel: string | null;
  chart: string | null;
  goal: string | null;
}

const KEYS = ['screen', 'account', 'panel', 'chart', 'goal'] as const;
const EMPTY: AppUrl = { screen: null, account: null, panel: null, chart: null, goal: null };
const STATE_KEY = '__fintoNavigation';
const session = Math.random().toString(36).slice(2);

type Proceed = (onAccepted?: () => void) => void;
type Guard = (proceed: Proceed, untracked?: boolean) => boolean;
type Position = { owner: 'finto:url'; session: string; segment: number; index: number };
type Entry = {
  url: string;
  state: unknown;
  position: Position | null;
  browserIndex: number | null;
  browserKey: string | null;
};
type NativeEntry = { index?: number; key?: string };
type NativeNavigation = { currentEntry?: NativeEntry; entries?: () => NativeEntry[] };
type NavigationStatus = 'ready' | 'displaced' | 'waiting';
type Traversal = {
  origin: Entry;
  destination: Entry;
  phase: 'restoring' | 'staged' | 'replaying' | 'unknown';
  accepted: boolean;
  afterRestore?: () => void;
  isCurrent?: () => boolean;
  onAccepted?: () => void;
};

let segment = 0;
let published: Entry | null = null;
let cachedUrl: string | null = null;
let observedBrowserUrl: string | null = null;
let cached: AppUrl = EMPTY;
const guards: { handler: Guard }[] = [];
let traversal: Traversal | null = null;
let listening = false;
let request = 0;
let navigationStatus: NavigationStatus = 'ready';
const listeners = new Set<() => void>();
const statusListeners = new Set<() => void>();

const href = (): string =>
  `${window.location.pathname}${window.location.search}${window.location.hash}`;

function storedPosition(state: unknown): Position | null {
  if (!state || typeof state !== 'object' || !(STATE_KEY in state)) return null;
  const value: unknown = (state as Record<string, unknown>)[STATE_KEY];
  if (!value || typeof value !== 'object') return null;
  const position = value as Position;
  return position.owner === 'finto:url' && typeof position.session === 'string' &&
    Number.isInteger(position.segment) && Number.isInteger(position.index) ? position : null;
}

function positionOf(state: unknown): Position | null {
  const position = storedPosition(state);
  return position?.session === session ? position : null;
}

function nativeNavigation(): NativeNavigation | undefined {
  return (window as Window & { navigation?: NativeNavigation }).navigation;
}

function currentEntry(): Entry {
  const state: unknown = window.history.state;
  const nativeEntry = nativeNavigation()?.currentEntry;
  const nativeIndex = nativeEntry?.index;
  return {
    url: href(), state, position: positionOf(state),
    browserIndex: Number.isInteger(nativeIndex) && nativeIndex! >= 0 ? nativeIndex! : null,
    browserKey: typeof nativeEntry?.key === 'string' && nativeEntry.key ? nativeEntry.key : null,
  };
}

function stateAt(state: unknown, position: Position): unknown {
  if (state === null || state === undefined) return { [STATE_KEY]: position };
  if (typeof state !== 'object' || Array.isArray(state) ||
    Object.getPrototypeOf(state) !== Object.prototype) return state;
  if (STATE_KEY in state && !storedPosition(state)) return state;
  return { ...state, [STATE_KEY]: position };
}

function managed(entry: Entry): Entry {
  if (entry.position) return entry;
  const state = stateAt(entry.state, { owner: 'finto:url', session, segment: ++segment, index: 0 });
  if (state !== entry.state) window.history.replaceState(state, '', entry.url);
  return { ...entry, state, position: positionOf(state) };
}

function distance(from: Entry, to: Entry): number | null {
  const navigation = nativeNavigation();
  if (navigation?.entries && (from.browserKey !== null || to.browserKey !== null)) {
    const entries = navigation.entries();
    const indexOf = (key: string | null): number | null => {
      if (key === null) return null;
      const index = entries.find((entry) => entry.key === key)?.index;
      return Number.isInteger(index) && index! >= 0 ? index! : null;
    };
    const origin = indexOf(from.browserKey);
    const destination = indexOf(to.browserKey);
    // Pruning rebases positions; a known missing identity cannot use a cached offset.
    return origin !== null && destination !== null ? destination - origin : null;
  }
  if (from.browserIndex !== null && to.browserIndex !== null) {
    const delta = to.browserIndex - from.browserIndex;
    return delta === 0 && from.browserKey !== null && to.browserKey !== null &&
      from.browserKey !== to.browserKey ? null : delta;
  }
  return from.position && to.position && from.position.segment === to.position.segment
    ? to.position.index - from.position.index : null;
}

function sameEntry(a: Entry, b: Entry): boolean {
  if (a.browserKey !== null && b.browserKey !== null) return a.browserKey === b.browserKey;
  return distance(a, b) === 0;
}

function updateNavigationStatus(): void {
  // A restore or replay whose offset is known is already on its way back; only an entry nothing
  // can locate leaves the reader somewhere unverified.
  const displaced = traversal?.phase === 'unknown' && !sameEntry(currentEntry(), traversal.origin);
  const next = displaced ? (traversal?.afterRestore ? 'waiting' : 'displaced') : 'ready';
  if (next === navigationStatus) return;
  navigationStatus = next;
  for (const listener of [...statusListeners]) listener();
}

function publish(entry: Entry): void {
  published = entry;
  updateNavigationStatus();
  for (const listener of [...listeners]) listener();
}

function read(): AppUrl {
  const url = listening && published ? published.url : href();
  if (url === cachedUrl) return cached;
  const params = new URL(url, window.location.href || 'http://finto.invalid').searchParams;
  cachedUrl = url;
  cached = {
    screen: params.get('screen'),
    account: params.get('account'),
    panel: params.get('panel'),
    chart: params.get('chart'),
    goal: params.get('goal'),
  };
  return cached;
}

function start(): void {
  if (listening) return;
  published = managed(currentEntry());
  observedBrowserUrl = href();
  listening = true;
  window.addEventListener('popstate', onPopState);
  window.addEventListener('hashchange', onHashChange);
}

function stop(): void {
  if (listeners.size || statusListeners.size || guards.length) return;
  if (traversal?.phase === 'staged' && !traversal.afterRestore) traversal = null;
  if (!listening || traversal) return;
  window.removeEventListener('popstate', onPopState);
  window.removeEventListener('hashchange', onHashChange);
  listening = false;
  published = null;
  observedBrowserUrl = null;
}

function subscribe(onChange: () => void): () => void {
  start();
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
    stop();
  };
}

function subscribeStatus(onChange: () => void): () => void {
  start();
  statusListeners.add(onChange);
  return () => {
    statusListeners.delete(onChange);
    stop();
  };
}

export function registerNavigationGuard(handler: Guard): () => void {
  start();
  const registration = { handler };
  guards.push(registration);
  return () => {
    const index = guards.indexOf(registration);
    if (index >= 0) guards.splice(index, 1);
    stop();
  };
}

function attempt(run: (isCurrent: () => boolean, onAccepted?: () => void) => void, untracked = false): boolean {
  const id = ++request;
  if (traversal?.afterRestore) {
    traversal.afterRestore = undefined;
    updateNavigationStatus();
  }
  const isCurrent = () => id === request;
  const effects: (() => void)[] = [];
  const remaining = [...guards].reverse();
  let finished = false;
  const finish = () => {
    if (finished || !isCurrent()) return;
    finished = true;
    run(isCurrent, effects.length ? () => { for (const effect of effects) effect(); } : undefined);
  };
  // Every open editor answers, newest first: one that accepts after its own prompt hands the
  // navigation to the older ones rather than letting it through past their drafts.
  const consult = (): boolean => {
    while (remaining.length) {
      const registration = remaining.shift()!;
      if (!guards.includes(registration)) continue;
      let checking = true;
      let accepted = false;
      const blocked = registration.handler((onAccepted) => {
        if (accepted || finished || !isCurrent()) return;
        accepted = true;
        if (onAccepted) effects.push(onAccepted);
        if (!checking && !consult()) finish();
      }, untracked);
      checking = false;
      if (blocked && !accepted) return true;
    }
    return false;
  };
  const blocked = consult();
  if (!blocked) finish();
  return blocked;
}

function replay(pending: Traversal): void {
  if (traversal !== pending || (pending.isCurrent && !pending.isCurrent())) return;
  pending.accepted = true;
  if (pending.phase === 'restoring') return;
  if (pending.phase === 'unknown') {
    // Without an entry index, guessing a direction can erase a forward destination.
    // Keep the unpublished draft rather than overwrite history to fake cancellation.
    traversal = null;
    pending.onAccepted?.();
    publish(managed(currentEntry()));
    stop();
    return;
  }
  const delta = distance(pending.origin, pending.destination);
  if (delta === null) {
    pending.phase = 'unknown';
    updateNavigationStatus();
    return;
  }
  const current = currentEntry();
  if (!sameEntry(current, pending.origin)) {
    const restore = distance(current, pending.origin);
    pending.phase = restore === null ? 'unknown' : 'restoring';
    if (restore !== null) window.history.go(restore);
    updateNavigationStatus();
    return;
  }
  pending.phase = 'replaying';
  window.history.go(delta);
}

function onPopState(): void {
  observedBrowserUrl = href();
  handlePopState();
  updateNavigationStatus();
}

function onHashChange(event: HashChangeEvent): void {
  const change = new URL(event.newURL || href(), window.location.href || 'http://finto.invalid');
  const url = `${change.pathname}${change.search}${change.hash}`;
  // Suppress duplicate notifications without treating their address as history-entry identity.
  if (url !== href() || url === observedBrowserUrl) return;
  onPopState();
}

function handlePopState(): void {
  const destination = currentEntry();
  if (traversal?.phase === 'restoring') {
    if (sameEntry(destination, traversal.origin)) {
      traversal.phase = 'staged';
      if (traversal.afterRestore) traversal.afterRestore();
      else if (traversal.accepted) replay(traversal);
      stop();
    } else {
      const delta = distance(destination, traversal.origin);
      if (delta !== null && delta !== 0) window.history.go(delta);
      else traversal.phase = 'unknown';
    }
    return;
  }
  if (traversal?.phase === 'replaying' && sameEntry(destination, traversal.destination)) {
    const pending = traversal;
    if (pending.isCurrent && !pending.isCurrent()) {
      const delta = distance(destination, pending.origin);
      pending.phase = delta === null ? 'unknown' : 'restoring';
      pending.accepted = false;
      pending.onAccepted = undefined;
      if (delta !== null) window.history.go(delta);
      return;
    }
    traversal = null;
    pending.onAccepted?.();
    publish(destination);
    stop();
    return;
  }
  if (traversal?.phase === 'unknown') {
    const pending = traversal;
    if (sameEntry(destination, pending.origin)) {
      pending.phase = 'staged';
      // Drain the accepted source write before invalidating its request token.
      if (pending.afterRestore) pending.afterRestore();
      else {
        traversal = null;
        ++request;
        publish(destination);
      }
      stop();
      return;
    }
    // Equal URLs and opaque state are not proof of returning to the same entry.
    if (destination.url === pending.origin.url && !guards.length) return;
  }
  const origin = published ?? destination;
  const hadBarrier = traversal !== null;
  traversal = null;
  if (destination.url === origin.url && !hadBarrier) {
    ++request;
    publish(managed(destination));
    stop();
    return;
  }
  const pending: Traversal = { origin, destination, phase: 'unknown', accepted: false };
  const blocked = attempt((isCurrent, onAccepted) => {
    if (traversal === pending) {
      pending.isCurrent = isCurrent;
      pending.onAccepted = onAccepted;
      replay(pending);
    } else {
      onAccepted?.();
      publish(managed(destination));
    }
  }, distance(destination, origin) === null);
  if (!blocked) {
    stop();
    return;
  }
  traversal = pending;
  const delta = distance(destination, origin);
  if (delta !== null && delta !== 0) {
    pending.phase = 'restoring';
    window.history.go(delta);
  }
}

function composeUrl(url: string, next: AppUrl): string {
  const base = new URL(url, window.location.href || 'http://finto.invalid');
  const params = new URLSearchParams(base.search);
  for (const key of KEYS) {
    const value = next[key];
    if (value) params.set(key, value);
    else params.delete(key);
  }
  const query = params.toString();
  return `${base.pathname}${query ? `?${query}` : ''}${base.hash}`;
}

export function urlFor(patch: Partial<AppUrl>): string {
  return composeUrl(listening && published ? published.url : href(), { ...read(), ...patch });
}

export function setUrl(patch: Partial<AppUrl>, mode: 'push' | 'replace' = 'push', onAccepted?: () => void): void {
  const next = { ...read(), ...patch };
  const url = urlFor(patch);
  // A click on the section already showing is not a navigation. Without this it is a history
  // entry identical to the one under it, and Back then has to be pressed once per click. The
  // caller's acceptance still runs behind the guards, except while a traversal is unresolved:
  // a new attempt there would supersede the write waiting on it.
  if (url === (listening && published ? published.url : href())) {
    if (onAccepted && !traversal) attempt((_, acceptanceEffect) => { acceptanceEffect?.(); onAccepted(); });
    return;
  }
  const write = (beforePublish?: () => void) => {
    traversal = null;
    const entry = managed(currentEntry());
    const position = entry.position && {
      ...entry.position, index: entry.position.index + (mode === 'push' ? 1 : 0),
    };
    const state = position ? stateAt(entry.state, position) : entry.state;
    const destination = composeUrl(entry.url, next);
    if (mode === 'push') window.history.pushState(state, '', destination);
    else window.history.replaceState(state, '', destination);
    beforePublish?.();
    onAccepted?.();
    publish(currentEntry());
    stop();
  };
  attempt((isCurrent, acceptanceEffect) => {
    // Do not write at the traversed entry until the source entry is verified.
    if (traversal?.phase === 'restoring' || traversal?.phase === 'replaying' || traversal?.phase === 'unknown') {
      traversal.accepted = false;
      traversal.afterRestore = () => { if (isCurrent()) write(acceptanceEffect); };
      updateNavigationStatus();
    } else write(acceptanceEffect);
  });
  updateNavigationStatus();
}

// No `getServerSnapshot`: this app never renders on a server, and passing `read` as one would
// claim that `window.location` is readable there.
export function useUrl(): AppUrl {
  return useSyncExternalStore(subscribe, read);
}

export function useNavigationStatus(): NavigationStatus {
  return useSyncExternalStore(subscribeStatus, () => navigationStatus);
}
