import { useSyncExternalStore } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppUrl } from './url';

vi.mock('react', () => ({
  useSyncExternalStore: vi.fn((_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot()),
}));

const ORIGIN = 'http://finto.test';

type HistoryEntry = { url: URL; state: unknown };
let entries: HistoryEntry[] = [];
let index = 0;
let queued: (() => void)[] = [];
const popListeners = new Set<() => void>();
type HashNotification = Pick<HashChangeEvent, 'oldURL' | 'newURL'>;
const hashListeners = new Set<(event: HashNotification) => void>();
const current = () => entries[index].url;
const pushState = vi.fn((state: unknown, _title: string, next: string) => {
  entries.splice(index + 1, entries.length, { url: new URL(next, current()), state: structuredClone(state) });
  index++;
});
const replaceState = vi.fn((state: unknown, _title: string, next: string) => {
  entries[index] = { url: new URL(next, current()), state: structuredClone(state) };
});
const go = vi.fn((delta: number) => {
  queued.push(() => {
    const next = index + delta;
    if (next < 0 || next >= entries.length || next === index) return;
    const oldURL = current().href;
    index = next;
    const newURL = current().href;
    for (const listener of [...popListeners]) listener();
    if (new URL(oldURL).hash !== new URL(newURL).hash) {
      for (const listener of [...hashListeners]) listener({ oldURL, newURL });
    }
  });
});
const flushOne = () => queued.shift()?.();
const flush = () => {
  let remaining = 30;
  while (queued.length && remaining-- > 0) flushOne();
  expect(queued).toHaveLength(0);
};
const addEventListener = vi.fn((type: string, listener: unknown) => {
  if (type === 'popstate') popListeners.add(listener as () => void);
  else if (type === 'hashchange') hashListeners.add(listener as (event: HashNotification) => void);
  else throw new Error(`Unexpected URL subscription: ${type}`);
});
const removeEventListener = vi.fn((type: string, listener: unknown) => {
  if (type === 'popstate') popListeners.delete(listener as () => void);
  else if (type === 'hashchange') hashListeners.delete(listener as (event: HashNotification) => void);
  else throw new Error(`Unexpected URL subscription: ${type}`);
});

Object.assign(globalThis, {
  window: {
    location: {
      get href() { return current().href; },
      get pathname() { return current().pathname; },
      get search() { return current().search; },
      get hash() { return current().hash; },
    },
    history: {
      get state() { return structuredClone(entries[index].state); },
      get length() { return entries.length; },
      pushState, replaceState, go,
      back: () => go(-1), forward: () => go(1),
    },
    addEventListener, removeEventListener,
  },
});

let urlFor: typeof import('./url').urlFor;
let setUrl: typeof import('./url').setUrl;
let registerNavigationGuard: typeof import('./url').registerNavigationGuard;
let useNavigationStatus: typeof import('./url').useNavigationStatus;
let useUrl: typeof import('./url').useUrl;

const observeStatus = () => {
  useNavigationStatus();
  const [subscribe, getSnapshot] = vi.mocked(useSyncExternalStore).mock.lastCall!;
  const changed = vi.fn();
  const release = subscribe(changed);
  return { getSnapshot, changed, release };
};

const KEYS = ['screen', 'account', 'panel', 'chart', 'goal'] as const;

const at = (href: string): void => {
  entries = [{ url: new URL(href, ORIGIN), state: null }];
  index = 0;
};

/** What a URL the module wrote reads back as, key by key. */
const parse = (href: string): AppUrl => {
  const params = new URL(href, ORIGIN).searchParams;
  return {
    screen: params.get('screen'),
    account: params.get('account'),
    panel: params.get('panel'),
    chart: params.get('chart'),
    goal: params.get('goal'),
  };
};

function keyedNativeHistory() {
  const keys = new WeakMap<HistoryEntry, string>();
  let nextKey = 0;
  const keyOf = (entry: HistoryEntry) => {
    if (!keys.has(entry)) keys.set(entry, `entry-${nextKey++}`);
    return keys.get(entry)!;
  };
  const navigation = {
    get currentEntry() { return { index, key: keyOf(entries[index]) }; },
    entries: () => entries.map((entry, i) => ({ index: i, key: keyOf(entry) })),
  };
  Object.assign(window, { navigation });
  return navigation;
}

const EMPTY: AppUrl = { screen: null, account: null, panel: null, chart: null, goal: null };
const FULL: AppUrl = {
  screen: 'overview',
  account: 'acc-1',
  panel: 'import',
  chart: 'c1',
  goal: 'g1',
};

beforeEach(async () => {
  at('/');
  queued = [];
  popListeners.clear();
  hashListeners.clear();
  Reflect.deleteProperty(window, 'navigation');
  vi.clearAllMocks();
  vi.resetModules();
  ({ urlFor, setUrl, registerNavigationGuard, useNavigationStatus, useUrl } = await import('./url'));
});

describe('urlFor', () => {
  it.each(KEYS)('%s round-trips through the URL it writes', (key) => {
    const patch: Partial<AppUrl> = {};
    patch[key] = `${key}-value`;
    expect(parse(urlFor(patch))).toEqual({ ...EMPTY, [key]: `${key}-value` });
  });

  it('a value with spaces, a slash and non-ASCII round-trips', () => {
    const account = 'Mono UAH/2 — картка';
    expect(parse(urlFor({ account })).account).toBe(account);
  });

  it('writes every field it is given and keeps a parameter it does not own', () => {
    at('/?ref=newsletter');
    expect(
      urlFor({
        screen: 'analytics',
        account: 'acc-1',
        panel: 'history',
        chart: 'c1',
        goal: 'g1',
      }),
    ).toBe('/?ref=newsletter&screen=analytics&account=acc-1&panel=history&chart=c1&goal=g1');
  });

  it.each(KEYS)('null removes %s and leaves the other keys', (key) => {
    at('/?screen=overview&account=acc-1&panel=import&chart=c1&goal=g1');
    const patch: Partial<AppUrl> = {};
    patch[key] = null;
    expect(parse(urlFor(patch))).toEqual({ ...FULL, [key]: null });
  });

  it('an empty string removes the key as null does', () => {
    at('/?panel=import');
    expect(parse(urlFor({ panel: '' }))).toEqual(EMPTY);
  });

  it('a field not in the patch keeps its current value', () => {
    at('/?account=acc-1');
    expect(parse(urlFor({ screen: 'analytics' }))).toEqual({
      ...EMPTY,
      account: 'acc-1',
      screen: 'analytics',
    });
  });

  it('keeps the path and the hash it was given', () => {
    at('/app/#top');
    expect(urlFor({ screen: 'transactions' })).toBe('/app/?screen=transactions#top');
  });

  it('drops the question mark when nothing is left', () => {
    at('/?screen=overview');
    expect(urlFor({ screen: null })).toBe('/');
  });

  it('composes without moving the page', () => {
    urlFor({ screen: 'transactions' });
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
  });
});

describe('full URL publication', () => {
  it('publishes hash-only changes as a new snapshot and keeps real-link hashes current', () => {
    at('/?screen=overview&foreign=kept#before');
    useUrl();
    const [subscribe, read] = vi.mocked(useSyncExternalStore).mock.lastCall!;
    const changed = vi.fn();
    const release = subscribe(changed);
    const original = read();
    expect(hashListeners.size).toBe(1);
    const oldURL = current().href;
    pushState(null, '', '/?screen=overview&foreign=kept#screens');
    const notification = { oldURL, newURL: current().href };
    for (const listener of [...hashListeners]) listener(notification);
    expect(changed).toHaveBeenCalledOnce();
    expect(read()).toEqual(original);
    expect(read()).not.toBe(original);
    const currentSnapshot = read();
    expect(read()).toBe(currentSnapshot);
    for (const listener of [...hashListeners]) listener(notification);
    expect(changed).toHaveBeenCalledOnce();
    expect(read()).toBe(currentSnapshot);
    expect(urlFor({ screen: 'transactions' })).toBe('/?screen=transactions&foreign=kept#screens');
    release();
    expect(popListeners.size).toBe(0);
    expect(hashListeners.size).toBe(0);
  });

  it('changes snapshot identity for a path-only publication without changing owned values', () => {
    at('/app/?screen=overview#same');
    useUrl();
    const [subscribe, read] = vi.mocked(useSyncExternalStore).mock.lastCall!;
    const release = subscribe(vi.fn());
    const original = read();
    pushState(null, '', '/other/?screen=overview#same');
    for (const listener of [...popListeners]) listener();
    expect(read()).toEqual(original);
    expect(read()).not.toBe(original);
    expect(urlFor({ screen: 'transactions' })).toBe('/other/?screen=transactions#same');
    release();
  });
});

describe('setUrl', () => {
  it('defers accepted side effects together with a blocked URL write', () => {
    let accept!: () => void;
    const accepted = vi.fn();
    const release = registerNavigationGuard((proceed) => { accept = proceed; return true; });
    setUrl({ screen: 'transactions' }, 'push', accepted);
    expect(accepted).not.toHaveBeenCalled();
    expect(current().search).toBe('');
    accept();
    accept();
    expect(accepted).toHaveBeenCalledOnce();
    expect(current().search).toBe('?screen=transactions');
    release();
  });

  it('prefers native entry indices when a foreign producer has copied managed state into another entry', () => {
    Object.assign(window, { navigation: { get currentEntry() { return { index }; } } });
    let blocked = false;
    let accept!: () => void;
    const release = registerNavigationGuard((proceed) => { accept = proceed; return blocked; });
    setUrl({ screen: 'goal' });
    pushState(entries[index].state, '', '/?screen=analytics');
    for (const listener of [...popListeners]) listener();
    setUrl({ screen: 'goal', goal: 'new' });
    blocked = true;
    go(-3);
    flush();
    expect(index).toBe(3);
    blocked = false;
    accept();
    flush();
    expect(index).toBe(0);
    expect(entries).toHaveLength(4);
    release();
  });

  it('resolves entry identities against live positions after the browser prunes a captured index', () => {
    at('/app/?screen=overview&foreign=kept#origin');
    entries[0].state = { foreign: 'state-kept' };
    let base = 0;
    Object.assign(window, { navigation: {
      get currentEntry() { return { index, key: `entry-${base + index}` }; },
      entries: () => entries.map((_entry, i) => ({ index: i, key: `entry-${base + i}` })),
    } });
    let blocked = false;
    let accept!: () => void;
    const release = registerNavigationGuard((proceed) => { accept = proceed; return blocked; });
    setUrl({ screen: 'transactions' });
    setUrl({ screen: 'overview' });
    // Pruning changes positions without changing either surviving entry's identity.
    entries.shift();
    base++;
    index--;
    const before = entries.map((entry) => ({ url: entry.url.href, state: structuredClone(entry.state) }));
    blocked = true;
    go(-1);
    flush();
    expect(index).toBe(1);
    expect(go).toHaveBeenLastCalledWith(1);
    expect(current().pathname + current().search + current().hash).toBe('/app/?screen=overview&foreign=kept#origin');
    expect(useUrl().screen).toBe('overview');
    blocked = false;
    accept();
    flush();
    expect(index).toBe(0);
    expect(go).toHaveBeenLastCalledWith(-1);
    expect(useUrl().screen).toBe('transactions');
    go(1);
    flush();
    expect(useUrl().screen).toBe('overview');
    expect(entries.map((entry) => ({ url: entry.url.href, state: entry.state }))).toEqual(before);
    release();
  });

  it('restores the actual source before replaying a surviving Back destination after a foreign push', () => {
    entries = [
      { url: new URL('/app/?screen=transactions&foreign=target#old', ORIGIN), state: 'opaque target' },
      { url: new URL('/app/?screen=goal&goal=new&foreign=source#draft', ORIGIN), state: 'opaque source' },
    ];
    index = 1;
    keyedNativeHistory();
    let blocked = true;
    let accept!: () => void;
    const accepted = vi.fn();
    const release = registerNavigationGuard((proceed) => { accept = () => proceed(accepted); return blocked; });
    go(-1);
    flush();
    expect(index).toBe(1);
    pushState('foreign new entry', '', '/app/?screen=settings&foreign=external#new');
    const before = entries.map((entry) => ({ url: entry.url.href, state: entry.state }));
    go.mockClear();
    accept();
    flushOne();
    expect(index).toBe(1);
    expect(accepted).not.toHaveBeenCalled();
    expect(useUrl().screen).toBe('goal');
    flush();
    expect(index).toBe(0);
    expect(go.mock.calls).toEqual([[-1], [-1]]);
    expect(accepted).toHaveBeenCalledOnce();
    expect(useUrl().screen).toBe('transactions');
    expect(entries.map((entry) => ({ url: entry.url.href, state: entry.state }))).toEqual(before);
    blocked = false;
    go(2);
    flush();
    expect(current().hash).toBe('#new');
    expect(entries[2].state).toBe('foreign new entry');
    release();
  });

  it('keeps the source barrier when distinct native keys have the same cached index without a live list', () => {
    entries = [
      { url: new URL('/?screen=transactions#target', ORIGIN), state: 'opaque target' },
      { url: new URL('/?screen=goal#source', ORIGIN), state: 'opaque source' },
    ];
    index = 1;
    const navigation = keyedNativeHistory();
    Reflect.deleteProperty(navigation, 'entries');
    const nativeCurrent = Object.getOwnPropertyDescriptor(navigation, 'currentEntry')!.get!;
    let stale = false;
    Object.defineProperty(navigation, 'currentEntry', { get: () => {
      const entry = nativeCurrent.call(navigation) as { key: string; index: number };
      return stale ? { ...entry, index: 1 } : entry;
    } });
    let accept!: () => void;
    const accepted = vi.fn();
    const release = registerNavigationGuard((proceed) => { accept = () => proceed(accepted); return true; });
    const status = observeStatus();
    go(-1);
    flush();
    pushState('foreign new entry', '', '/?screen=settings#foreign');
    stale = true;
    go.mockClear();
    accept();
    flush();
    expect(go).not.toHaveBeenCalled();
    expect(accepted).not.toHaveBeenCalled();
    expect(index).toBe(2);
    expect(useUrl().screen).toBe('goal');
    expect(status.getSnapshot()).toBe('displaced');
    release();
    status.release();
  });

  it('compensates and replays Forward after opaque native entries are rebased', () => {
    entries = [
      { url: new URL('/?screen=settings#old', ORIGIN), state: ['old foreign'] },
      { url: new URL('/?screen=goal&goal=new#source', ORIGIN), state: 'opaque source' },
      { url: new URL('/?screen=transactions#target', ORIGIN), state: 42 },
    ];
    index = 1;
    keyedNativeHistory();
    let blocked = true;
    let accept!: () => void;
    const release = registerNavigationGuard((proceed) => { accept = proceed; return blocked; });
    entries.shift();
    index--;
    const before = entries.map((entry) => ({ url: entry.url.href, state: entry.state }));
    go(1);
    flush();
    expect(index).toBe(0);
    expect(go).toHaveBeenLastCalledWith(-1);
    expect(useUrl().screen).toBe('goal');
    blocked = false;
    accept();
    flush();
    expect(index).toBe(1);
    expect(useUrl().screen).toBe('transactions');
    expect(entries.map((entry) => ({ url: entry.url.href, state: entry.state }))).toEqual(before);
    release();
  });

  it('never substitutes a cached index for a known missing key when the other endpoint exposes only an index', () => {
    entries = [
      { url: new URL('/?screen=transactions#target', ORIGIN), state: 'opaque target' },
      { url: new URL('/?screen=goal&goal=new#source', ORIGIN), state: 'opaque source' },
    ];
    index = 1;
    const navigation = keyedNativeHistory();
    const sourceKey = navigation.currentEntry.key;
    const nativeCurrent = Object.getOwnPropertyDescriptor(navigation, 'currentEntry')!.get!;
    const nativeEntries = navigation.entries;
    Object.defineProperty(navigation, 'currentEntry', { get: () => {
      const entry = nativeCurrent.call(navigation) as { key: string; index: number };
      return index === 0 ? { index: entry.index } : entry;
    } });
    const release = registerNavigationGuard(() => true);
    const status = observeStatus();
    navigation.entries = () => nativeEntries().filter((entry) => entry.key !== sourceKey);
    go(-1);
    flush();
    expect(go.mock.calls).toEqual([[-1]]);
    expect(index).toBe(0);
    expect(useUrl().screen).toBe('goal');
    expect(status.getSnapshot()).toBe('displaced');
    release();
    status.release();
  });

  it.each([-1, Number.NaN, undefined])('refuses a live source index that is not available (%s)', (invalid) => {
    entries = [
      { url: new URL('/?screen=transactions#target', ORIGIN), state: 'opaque target' },
      { url: new URL('/?screen=goal&goal=new#source', ORIGIN), state: 'opaque source' },
    ];
    index = 1;
    const navigation = keyedNativeHistory();
    const sourceKey = navigation.currentEntry.key;
    const nativeEntries = navigation.entries;
    const release = registerNavigationGuard(() => true);
    const status = observeStatus();
    const unavailable = () => nativeEntries().map((entry) => entry.key === sourceKey ? { ...entry, index: invalid } : entry);
    Object.assign(navigation, { entries: unavailable });
    go(-1);
    flush();
    expect(go.mock.calls).toEqual([[-1]]);
    expect(index).toBe(0);
    expect(useUrl().screen).toBe('goal');
    expect(status.getSnapshot()).toBe('displaced');
    release();
    status.release();
  });

  it('does not reload or publish a foreign push when a staged Forward destination disappears', () => {
    entries = [
      { url: new URL('/?screen=overview#source', ORIGIN), state: 'opaque source' },
      { url: new URL('/?screen=transactions#target', ORIGIN), state: 'opaque target' },
    ];
    keyedNativeHistory();
    let accept!: () => void;
    const accepted = vi.fn();
    const release = registerNavigationGuard((proceed) => { accept = () => proceed(accepted); return true; });
    const status = observeStatus();
    go(1);
    flush();
    expect(index).toBe(0);
    pushState('foreign new entry', '', '/?screen=settings#foreign');
    const before = entries.map((entry) => ({ url: entry.url.href, state: entry.state }));
    go.mockClear();
    accept();
    flush();
    expect(go).not.toHaveBeenCalled();
    expect(accepted).not.toHaveBeenCalled();
    expect(useUrl().screen).toBe('overview');
    expect(status.getSnapshot()).toBe('displaced');
    expect(entries.map((entry) => ({ url: entry.url.href, state: entry.state }))).toEqual(before);
    go(-1);
    flush();
    expect(status.getSnapshot()).toBe('ready');
    expect(useUrl().screen).toBe('overview');
    expect(accepted).not.toHaveBeenCalled();
    release();
    status.release();
  });

  it('does not issue a stale restoration when the source disappears before an overtaken replay lands', () => {
    entries = [
      { url: new URL('/?screen=overview#source', ORIGIN), state: 'opaque source' },
      { url: new URL('/?screen=transactions#target', ORIGIN), state: 'opaque target' },
    ];
    keyedNativeHistory();
    let prune = false;
    popListeners.add(() => {
      if (!prune) return;
      entries.shift();
      index--;
      prune = false;
    });
    let accept!: () => void;
    const accepted = vi.fn();
    const release = registerNavigationGuard((proceed) => { accept = () => proceed(accepted); return true; });
    const status = observeStatus();
    go(1);
    flush();
    accept();
    setUrl({ screen: 'settings' });
    prune = true;
    go.mockClear();
    flush();
    expect(go).not.toHaveBeenCalled();
    expect(accepted).not.toHaveBeenCalled();
    expect(useUrl().screen).toBe('overview');
    expect(status.getSnapshot()).toBe('displaced');
    expect(entries).toHaveLength(1);
    expect(current().search).toBe('?screen=transactions');
    expect(entries[0].state).toBe('opaque target');
    release();
    status.release();
  });

  it('uses native entry indices to cancel and replay untracked multi-step traversal without changing foreign state', () => {
    entries = [
      { url: new URL('/?screen=overview&foreign=yes#old', ORIGIN), state: ['foreign'] },
      { url: new URL('/?screen=analytics', ORIGIN), state: 'opaque' },
      { url: new URL('/?screen=goal&goal=new', ORIGIN), state: 42 },
    ];
    index = 2;
    Object.assign(window, { navigation: { get currentEntry() { return { index }; } } });
    let accept!: () => void;
    const release = registerNavigationGuard((proceed) => { accept = proceed; return true; });
    go(-2);
    flush();
    expect(index).toBe(2);
    expect(urlFor({})).toBe('/?screen=goal&goal=new');
    expect(entries.map((entry) => entry.state)).toEqual([['foreign'], 'opaque', 42]);
    expect(entries).toHaveLength(3);
    accept();
    flush();
    expect(index).toBe(0);
    expect(current().hash).toBe('#old');
    expect(entries.map((entry) => entry.state)).toEqual([['foreign'], 'opaque', 42]);
    release();
    go(2);
    flush();
    expect(index).toBe(2);
    expect(current().search).toBe('?screen=goal&goal=new');
  });

  beforeEach(() => {
    registerNavigationGuard(() => false)();
    replaceState.mockClear();
  });

  it('pushes one history entry by default, and the URL reads back changed', () => {
    setUrl({ screen: 'transactions' });
    expect(pushState).toHaveBeenCalledTimes(1);
    expect(pushState.mock.calls[0][2]).toBe('/?screen=transactions');
    expect(replaceState).not.toHaveBeenCalled();
    expect(current().search).toBe('?screen=transactions');
  });

  it("'replace' rewrites the entry and pushes nothing", () => {
    setUrl({ account: 'acc-2' }, 'replace');
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState.mock.calls[0][2]).toBe('/?account=acc-2');
    expect(pushState).not.toHaveBeenCalled();
    expect(current().search).toBe('?account=acc-2');
  });

  it('writing the URL already shown adds no history entry', () => {
    setUrl({ screen: 'transactions' });
    setUrl({ screen: 'transactions' });
    expect(pushState).toHaveBeenCalledTimes(1);
  });

  it('still runs an accepted side effect for the URL already shown, behind the guards', () => {
    setUrl({ screen: 'transactions' });
    vi.clearAllMocks();
    let accept!: () => void;
    const accepted = vi.fn();
    const release = registerNavigationGuard((proceed) => { accept = proceed; return true; });
    setUrl({ screen: 'transactions' }, 'push', accepted);
    expect(accepted).not.toHaveBeenCalled();
    accept();
    expect(accepted).toHaveBeenCalledOnce();
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    release();
    setUrl({ screen: 'transactions' }, 'push', accepted);
    expect(accepted).toHaveBeenCalledTimes(2);
  });

  it('keeps an older guard when a newer one unregisters, and asks every guard in turn', () => {
    const accepts: Array<() => void> = [];
    const olderDiscard = vi.fn();
    const newerDiscard = vi.fn();
    const older = vi.fn((proceed: (onAccepted?: () => void) => void) => { accepts.push(() => proceed(olderDiscard)); return true; });
    const newer = vi.fn((proceed: (onAccepted?: () => void) => void) => { accepts.push(() => proceed(newerDiscard)); return true; });
    registerNavigationGuard(older);
    const releaseNewer = registerNavigationGuard(newer);
    setUrl({ screen: 'settings' });
    expect(newer).toHaveBeenCalledOnce();
    expect(older).not.toHaveBeenCalled();
    accepts[0]();
    expect(older).toHaveBeenCalledOnce();
    expect(current().search).toBe('');
    accepts[1]();
    expect(current().search).toBe('?screen=settings');
    expect(newerDiscard).toHaveBeenCalledOnce();
    expect(olderDiscard).toHaveBeenCalledOnce();
    releaseNewer();
    setUrl({ screen: 'goal' });
    expect(older).toHaveBeenCalledTimes(2);
    expect(current().search).toBe('?screen=settings');
  });

  it('a later write keeps what an earlier one set', () => {
    setUrl({ screen: 'overview' });
    setUrl({ account: 'acc-1' });
    expect(pushState).toHaveBeenCalledTimes(2);
    expect(parse(current().href)).toEqual({ ...EMPTY, screen: 'overview', account: 'acc-1' });
  });
});

describe('navigation guard', () => {
  const historyUrls = () => entries.map((entry) => entry.url.pathname + entry.url.search + entry.url.hash);
  const setup = () => {
    at('/app/?ref=mail&screen=overview#top');
    replaceState({ foreign: { token: 'kept' } }, '', current().href);
    const release = registerNavigationGuard(() => false);
    setUrl({ screen: 'transactions' });
    setUrl({ screen: 'goal', goal: 'g1' });
    release();
    vi.clearAllMocks();
  };

  it('stages a paired popstate/hashchange only once and retains the frozen snapshot through cancellation', () => {
    setup();
    entries[1].url.hash = '#between';
    entries[2].url.hash = '#source';
    const staged: (() => void)[] = [];
    const handler = vi.fn((proceed: () => void) => { staged.push(proceed); return true; });
    const release = registerNavigationGuard(handler);
    const before = entries.map((entry) => ({ url: new URL(entry.url.href), state: structuredClone(entry.state) }));
    const original = useUrl();
    go(-1);
    flush();
    expect(handler).toHaveBeenCalledOnce();
    expect(index).toBe(2);
    expect(entries).toEqual(before);
    expect(useUrl()).toBe(original);
    go(-1);
    flush();
    expect(handler).toHaveBeenCalledTimes(2);
    staged[1]();
    flush();
    expect(index).toBe(1);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(entries).toEqual(before);
    staged[0]();
    expect(index).toBe(1);
    release();
  });

  it.each(['push', 'replace'] as const)('retains an accepted %s through duplicate and stale hash notifications during compensation', (mode) => {
    setup();
    entries[1].url.hash = '#between';
    entries[2].url.hash = '#source';
    const staged: Array<(onAccepted?: () => void) => void> = [];
    const handler = vi.fn((proceed: (onAccepted?: () => void) => void) => { staged.push(proceed); return true; });
    const release = registerNavigationGuard(handler);
    const accepted = vi.fn();
    const discarded = vi.fn();
    const sourceURL = current().href;
    go(-1);
    flushOne();
    const duplicate = { oldURL: sourceURL, newURL: current().href };
    setUrl({ goal: 'saved' }, mode, accepted);
    staged[1](discarded);
    for (const listener of [...hashListeners]) listener(duplicate);
    expect(go.mock.calls.map(([delta]) => delta)).toEqual([-1, 1]);
    expect(handler).toHaveBeenCalledTimes(2);
    flush();
    expect(current().pathname + current().search + current().hash)
      .toBe('/app/?ref=mail&screen=goal&goal=saved#source');
    expect(accepted).toHaveBeenCalledOnce();
    expect(discarded).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledTimes(2);
    const writes = mode === 'push' ? pushState : replaceState;
    expect(writes).toHaveBeenCalledOnce();
    for (const listener of [...hashListeners]) listener({ oldURL: duplicate.newURL, newURL: sourceURL });
    expect(writes).toHaveBeenCalledOnce();
    expect(accepted).toHaveBeenCalledOnce();
    staged[0]();
    release();
  });

  it('stages an app write and replays it only once, preserving foreign state/query/path/hash', () => {
    setup();
    let proceed = () => {};
    const handler = vi.fn((next: () => void) => { proceed = next; return true; });
    registerNavigationGuard(handler);
    const before = entries.map((entry) => ({ url: new URL(entry.url.href), state: structuredClone(entry.state) }));
    setUrl({ screen: 'analytics', goal: null });
    expect(entries).toEqual(before);
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
    proceed();
    proceed();
    expect(pushState).toHaveBeenCalledTimes(1);
    expect(current().pathname + current().search + current().hash)
      .toBe('/app/?ref=mail&screen=analytics#top');
    expect(window.history.state).toMatchObject({ foreign: { token: 'kept' } });
  });

  it('allows false handlers and ignores true no-op pushes and replaces', () => {
    setup();
    const handler = vi.fn(() => false);
    registerNavigationGuard(handler);
    setUrl({ goal: 'g1' });
    setUrl({ goal: 'g1' }, 'replace');
    expect(handler).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    setUrl({ screen: 'settings' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(current().search).toContain('screen=settings');
  });

  it('guards destructive derived replaces without creating an entry', () => {
    setup();
    let proceed = () => {};
    registerNavigationGuard((next) => { proceed = next; return true; });
    setUrl({ goal: 'g2' }, 'replace');
    expect(current().search).toContain('goal=g1');
    expect(replaceState).not.toHaveBeenCalled();
    proceed();
    expect(current().search).toContain('goal=g2');
    expect(entries).toHaveLength(3);
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(pushState).not.toHaveBeenCalled();
    expect(window.history.state).toMatchObject({ foreign: { token: 'kept' } });
  });

  it('invalidates an older staged app action when a newer action is requested', () => {
    setup();
    const staged: (() => void)[] = [];
    registerNavigationGuard((next) => { staged.push(next); return true; });
    setUrl({ screen: 'analytics' });
    setUrl({ screen: 'settings' });
    staged[0]();
    expect(pushState).not.toHaveBeenCalled();
    staged[1]();
    expect(pushState).toHaveBeenCalledTimes(1);
    expect(current().search).toContain('screen=settings');
  });

  it('compensates Back over multiple managed entries, retains Forward, and replays the exact traversal', () => {
    setup();
    let proceed = () => {};
    const handler = vi.fn((next: () => void) => { proceed = next; return true; });
    registerNavigationGuard(handler);
    const before = entries.map((entry) => ({ url: new URL(entry.url.href), state: structuredClone(entry.state) }));
    go(-2);
    flush();
    expect(index).toBe(2);
    expect(entries).toEqual(before);
    expect(historyUrls()).toEqual([
      '/app/?ref=mail&screen=overview#top',
      '/app/?ref=mail&screen=transactions#top',
      '/app/?ref=mail&screen=goal&goal=g1#top',
    ]);
    expect(go.mock.calls.map(([delta]) => delta)).toEqual([-2, 2]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    proceed();
    proceed();
    flush();
    expect(index).toBe(0);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(entries).toEqual(before);
    go(2);
    flush();
    expect(index).toBe(0);
    expect(handler).toHaveBeenCalledTimes(2);
    proceed();
    flush();
    expect(index).toBe(2);
    expect(entries).toEqual(before);
  });

  it('can accept Back before the compensating popstate arrives', () => {
    setup();
    let proceed = () => {};
    registerNavigationGuard((next) => { proceed = next; return true; });
    go(-1);
    flushOne();
    expect(index).toBe(1);
    proceed();
    expect(go.mock.calls.map(([delta]) => delta)).toEqual([-1, 1]);
    flush();
    expect(index).toBe(1);
    expect(go.mock.calls.map(([delta]) => delta)).toEqual([-1, 1, -1]);
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('a busy blocker compensates repeated Back and Forward without losing destinations', () => {
    setup();
    go(-1);
    flush();
    const before = entries.map((entry) => ({ url: new URL(entry.url.href), state: structuredClone(entry.state) }));
    const handler = vi.fn(() => true);
    registerNavigationGuard(handler);
    go(1);
    flush();
    expect(index).toBe(1);
    go(-1);
    flush();
    expect(index).toBe(1);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(entries).toEqual(before);
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('waits for compensation before a newer accepted app write and uses one popstate listener', () => {
    setup();
    const staged: (() => void)[] = [];
    const handler = vi.fn((next: () => void) => { staged.push(next); return true; });
    registerNavigationGuard(handler);
    go(-1);
    flushOne();
    setUrl({ screen: 'settings' });
    staged[1]();
    expect(pushState).not.toHaveBeenCalled();
    expect(popListeners.size).toBe(1);
    flush();
    expect(handler).toHaveBeenCalledTimes(2);
    expect(pushState).toHaveBeenCalledTimes(1);
    expect(current().search).toContain('screen=settings');
    expect(historyUrls().slice(0, 3)).toEqual([
      '/app/?ref=mail&screen=overview#top',
      '/app/?ref=mail&screen=transactions#top',
      '/app/?ref=mail&screen=goal&goal=g1#top',
    ]);
    staged[0]();
    flush();
    expect(pushState).toHaveBeenCalledTimes(1);
  });

  it('drops a superseded accepted write whose compensation has not completed', () => {
    setup();
    const staged: ((onAccepted?: () => void) => void)[] = [];
    registerNavigationGuard((next) => { staged.push(next); return true; });
    const accepted = vi.fn();
    go(-1);
    flushOne();
    const discarded = vi.fn();
    setUrl({ screen: 'settings' }, 'push', accepted);
    staged[1](discarded);
    setUrl({ screen: 'analytics' });
    flush();
    expect(index).toBe(2);
    expect(urlFor({})).toContain('screen=goal');
    expect(pushState).not.toHaveBeenCalled();
    expect(accepted).not.toHaveBeenCalled();
    expect(discarded).not.toHaveBeenCalled();
    expect(entries).toHaveLength(3);
    staged[1]();
    expect(pushState).not.toHaveBeenCalled();
    staged[2]();
    expect(current().search).toContain('screen=analytics');
    expect(accepted).not.toHaveBeenCalled();
    expect(pushState).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('keeps replay discard effects token-checked when a newer app request is accepted=%s', (accepted) => {
    setup();
    const staged: ((onAccepted?: () => void) => void)[] = [];
    registerNavigationGuard((next) => { staged.push(next); return true; });
    const oldDiscard = vi.fn();
    const newDiscard = vi.fn();
    go(-1);
    flush();
    staged[0](oldDiscard);
    setUrl({ screen: 'settings' });
    if (accepted) staged[1](newDiscard);
    flush();
    expect(oldDiscard).not.toHaveBeenCalled();
    if (accepted) {
      expect(newDiscard).toHaveBeenCalledOnce();
      expect(current().search).toContain('screen=settings');
      expect(pushState).toHaveBeenCalledTimes(1);
    } else {
      expect(newDiscard).not.toHaveBeenCalled();
      expect(index).toBe(2);
      expect(urlFor({})).toContain('screen=goal');
      expect(pushState).not.toHaveBeenCalled();
      expect(entries).toHaveLength(3);
    }
  });

  it('does not guess an unknown direct-entry offset or rewrite history when blocked', () => {
    at('/older/?ref=old#old');
    replaceState({ older: 'untouched' }, '', current().href);
    pushState({ direct: 'untouched' }, '', '/app/?screen=goal&goal=g1&ref=new#top');
    let proceed = () => {};
    registerNavigationGuard((next) => { proceed = next; return true; });
    const before = entries.map((entry) => ({ url: new URL(entry.url.href), state: structuredClone(entry.state) }));
    vi.clearAllMocks();
    go(-1);
    flush();
    // Cancellation cannot restore an unknown offset. The published location stays
    // at the editor, while the address bar stays at the browser's actual entry.
    expect(index).toBe(0);
    expect(urlFor({ panel: 'import' }))
      .toBe('/app/?screen=goal&goal=g1&ref=new&panel=import#top');
    expect(entries).toEqual(before);
    expect(go).toHaveBeenCalledTimes(1);
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    proceed();
    expect(urlFor({})).toBe('/older/?ref=old#old');
    expect(index).toBe(0);
    expect(entries).toHaveLength(2);
    expect(window.history.state).toMatchObject({ older: 'untouched' });
    go(1);
    flush();
    expect(urlFor({})).toBe('/older/?ref=old#old');
    proceed();
    expect(index).toBe(1);
    expect(window.history.state).toMatchObject({ direct: 'untouched' });
    expect(entries).toHaveLength(2);
  });

  it('uses the same conservative fallback for untracked multi-step Back and Forward', () => {
    at('/?screen=overview');
    pushState({ middle: 'kept' }, '', '/?screen=transactions');
    pushState({ direct: 'kept' }, '', '/?screen=goal&goal=g1');
    pushState({ future: 'kept' }, '', '/?screen=settings');
    go(-1);
    flush();
    let proceed = () => {};
    registerNavigationGuard((next) => { proceed = next; return true; });
    const before = entries.map((entry) => ({ url: new URL(entry.url.href), state: structuredClone(entry.state) }));
    vi.clearAllMocks();
    go(-2);
    flush();
    expect(index).toBe(0);
    expect(urlFor({})).toBe('/?screen=goal&goal=g1');
    expect(entries).toEqual(before);
    expect(go).toHaveBeenCalledTimes(1);
    go(3);
    flush();
    expect(index).toBe(3);
    expect(urlFor({})).toBe('/?screen=goal&goal=g1');
    expect(entries).toEqual(before);
    expect(go).toHaveBeenCalledTimes(2);
    proceed();
    expect(urlFor({})).toBe('/?screen=settings');
    expect(window.history.state).toMatchObject({ future: 'kept' });
    expect(entries).toHaveLength(4);
  });

  it('starts a new managed segment after reload without discarding foreign state', async () => {
    setup();
    vi.resetModules();
    ({ urlFor, setUrl, registerNavigationGuard } = await import('./url'));
    const release = registerNavigationGuard(() => false);
    setUrl({ goal: 'g2' });
    setUrl({ goal: 'g3' });
    release();
    let proceed = () => {};
    registerNavigationGuard((next) => { proceed = next; return true; });
    vi.clearAllMocks();
    go(-2);
    flush();
    expect(index).toBe(4);
    proceed();
    flush();
    expect(index).toBe(2);
    expect(window.history.state).toMatchObject({ foreign: { token: 'kept' } });
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    expect(entries).toHaveLength(5);
  });

  it.each([42, 'foreign', ['foreign'], { __fintoNavigation: 'foreign', token: 'kept' }])(
    'preserves opaque foreign state %j without repurposing it', (state) => {
      replaceState(state, '', '/?screen=goal&goal=g1');
      registerNavigationGuard(() => false);
      setUrl({ account: 'derived' }, 'replace');
      expect(window.history.state).toEqual(state);
      setUrl({ screen: 'analytics' });
      expect(window.history.state).toEqual(state);
    },
  );

  it('a former registration cleanup cannot remove the current active blocker', () => {
    const first = registerNavigationGuard(() => false);
    const handler = vi.fn(() => true);
    const second = registerNavigationGuard(handler);
    first();
    setUrl({ screen: 'settings' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(pushState).not.toHaveBeenCalled();
    second();
    expect(popListeners.size).toBe(0);
    setUrl({ screen: 'settings' });
    expect(pushState).toHaveBeenCalledTimes(1);
  });
});

describe('displaced source writes', () => {
  type Proceed = (onAccepted?: () => void) => void;
  const sourceUrl = '/app/?ref=mail&screen=goal&goal=new#top';
  const savedUrl = '/app/?ref=mail&screen=goal&goal=saved#top';
  const copyEntries = () => entries.map((entry) => ({
    url: new URL(entry.url.href), state: structuredClone(entry.state),
  }));
  const setup = (state: unknown = { foreign: { token: 'source' } }) => {
    at('/older/?ref=old#past');
    entries[0].state = ['older', { token: 'untouched' }];
    pushState(state, '', sourceUrl);
    pushState('future untouched', '', '/future/?ref=later#forward');
    index = 1;
    const staged: Proceed[] = [];
    const handler = vi.fn((proceed: Proceed) => { staged.push(proceed); return true; });
    const release = registerNavigationGuard(handler);
    const before = copyEntries();
    vi.clearAllMocks();
    go(-1);
    flush();
    expect(index).toBe(0);
    expect(urlFor({})).toBe(sourceUrl);
    expect(copyEntries()).toEqual(before);
    expect(useNavigationStatus()).toBe('displaced');
    return { staged, handler, release, before };
  };

  it.each(['replace', 'push'] as const)(
    'holds an accepted %s at unknown Back and drains it only at the managed source', (mode) => {
      const { staged, handler, release, before } = setup();
      const status = observeStatus();
      const source = useUrl();
      const accepted = vi.fn();
      const discard = vi.fn();
      setUrl({ goal: 'saved' }, mode, accepted);
      expect(useNavigationStatus()).toBe('displaced');
      staged[1](discard);
      staged[1](discard);
      expect(status.getSnapshot()).toBe('waiting');
      expect(status.changed).toHaveBeenCalledOnce();
      expect(useUrl()).toBe(source);
      expect(copyEntries()).toEqual(before);
      expect(index).toBe(0);
      expect(go.mock.calls.map(([delta]) => delta)).toEqual([-1]);
      expect(pushState).not.toHaveBeenCalled();
      expect(replaceState).not.toHaveBeenCalled();
      expect(accepted).not.toHaveBeenCalled();
      expect(discard).not.toHaveBeenCalled();
      go(1);
      flush();
      expect(handler).toHaveBeenCalledTimes(2);
      expect(current().pathname + current().search + current().hash).toBe(savedUrl);
      expect(useNavigationStatus()).toBe('ready');
      expect(status.changed).toHaveBeenCalledTimes(2);
      expect(accepted).toHaveBeenCalledOnce();
      expect(discard).toHaveBeenCalledOnce();
      expect(window.history.state).toMatchObject({ foreign: { token: 'source' } });
      expect(entries).toHaveLength(3);
      expect(entries[0]).toEqual(before[0]);
      if (mode === 'replace') {
        expect(index).toBe(1);
        expect(entries[2]).toEqual(before[2]);
        expect(replaceState).toHaveBeenCalledOnce();
        expect(pushState).not.toHaveBeenCalled();
      } else {
        expect(index).toBe(2);
        expect(entries[1]).toEqual(before[1]);
        expect(pushState).toHaveBeenCalledOnce();
        expect(replaceState).not.toHaveBeenCalled();
      }
      staged[0]();
      staged[1]();
      expect(accepted).toHaveBeenCalledOnce();
      expect(discard).toHaveBeenCalledOnce();
      release();
      status.release();
      if (mode === 'replace') {
        go(1);
        flush();
        expect(index).toBe(2);
        expect(window.history.state).toBe('future untouched');
      }
    },
  );

  it.each(['replace', 'push'] as const)(
    'preserves the verified source’s current foreign URL and state for a queued %s', (mode) => {
      const updateSource = () => {
        if (index !== 1) return;
        replaceState({ ...window.history.state, foreign: { token: 'updated' } }, '',
          '/changed/?ref=updated&screen=goal&goal=new&foreign=retained#updated');
      };
      popListeners.add(updateSource);
      const { staged, release, before } = setup();
      const accepted = vi.fn();
      setUrl({ goal: 'saved' }, mode, accepted);
      staged[1]();
      expect(copyEntries()).toEqual(before);
      go(1);
      flush();
      expect(current().pathname + current().search + current().hash)
        .toBe('/changed/?ref=updated&screen=goal&goal=saved&foreign=retained#updated');
      expect(window.history.state).toMatchObject({ foreign: { token: 'updated' } });
      expect(entries[0]).toEqual(before[0]);
      expect(accepted).toHaveBeenCalledOnce();
      expect(useNavigationStatus()).toBe('ready');
      if (mode === 'replace') expect(entries[2]).toEqual(before[2]);
      else expect(entries[1].url.pathname + entries[1].url.search + entries[1].url.hash)
        .toBe('/changed/?ref=updated&screen=goal&goal=new&foreign=retained#updated');
      expect(entries).toHaveLength(3);
      release();
      popListeners.delete(updateSource);
    },
  );

  it('retains the source barrier and pending write after the last guard/reader unregisters', () => {
    const { staged, release, before } = setup();
    const accepted = vi.fn();
    setUrl({ goal: 'saved' }, 'replace', accepted);
    staged[1]();
    release();
    expect(popListeners.size).toBe(1);
    expect(removeEventListener).not.toHaveBeenCalled();
    expect(useNavigationStatus()).toBe('waiting');
    expect(urlFor({})).toBe(sourceUrl);
    expect(copyEntries()).toEqual(before);
    go(1);
    flush();
    expect(accepted).toHaveBeenCalledOnce();
    expect(current().search).toContain('goal=saved');
    expect(useNavigationStatus()).toBe('ready');
    expect(popListeners.size).toBe(0);
    expect(removeEventListener.mock.calls.map(([type]) => type)).toEqual(['popstate', 'hashchange']);
    expect(hashListeners.size).toBe(0);
    expect(entries[0]).toEqual(before[0]);
    expect(entries[2]).toEqual(before[2]);
  });

  it('status-only subscriptions cannot reset or publish the frozen URL', () => {
    const { staged, release, before } = setup();
    const original = useUrl();
    const [subscribeUrl, readUrl] = vi.mocked(useSyncExternalStore).mock.lastCall!;
    const urlChanged = vi.fn();
    const releaseUrl = subscribeUrl(urlChanged);
    release();
    releaseUrl();
    const status = observeStatus();
    expect(status.getSnapshot()).toBe('displaced');
    expect(readUrl()).toBe(original);
    expect(copyEntries()).toEqual(before);
    expect(replaceState).not.toHaveBeenCalled();
    const accepted = vi.fn();
    setUrl({ goal: 'saved' }, 'replace', accepted);
    expect(status.getSnapshot()).toBe('waiting');
    expect(status.changed).toHaveBeenCalledOnce();
    expect(urlChanged).not.toHaveBeenCalled();
    expect(readUrl()).toBe(original);
    status.release();
    expect(popListeners.size).toBe(1);
    go(1);
    flush();
    expect(accepted).toHaveBeenCalledOnce();
    staged[0]();
    expect(accepted).toHaveBeenCalledOnce();
    expect(popListeners.size).toBe(0);
  });

  it('keeps listening for a source barrier even without an accepted write', () => {
    const { release, before } = setup();
    release();
    expect(popListeners.size).toBe(1);
    expect(useNavigationStatus()).toBe('displaced');
    go(1);
    flush();
    expect(useNavigationStatus()).toBe('ready');
    expect(popListeners.size).toBe(0);
    expect(copyEntries()).toEqual(before);
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('uses current source foreign state rather than the frozen or displaced state for a deferred write', () => {
    const { staged, release, before } = setup();
    setUrl({ goal: 'saved' }, 'replace');
    staged[1]();
    const state = entries[1].state as { foreign: { token: string } };
    state.foreign.token = 'updated while displaced';
    go(1);
    flush();
    expect(window.history.state).toMatchObject({ foreign: { token: 'updated while displaced' } });
    expect(entries[0]).toEqual(before[0]);
    expect(entries[2]).toEqual(before[2]);
    release();
  });

  it.each(['key', 'index'] as const)('verifies an opaque source by native %s without guessing an offset', (identity) => {
    Object.assign(window, { navigation: { get currentEntry() {
      // The older entry supplies no native offset, but the source is identifiable.
      if (index !== 1) return {};
      return identity === 'key' ? { key: 'source-entry' } : { index };
    } } });
    const { staged, release, before } = setup(42);
    const accepted = vi.fn();
    setUrl({ goal: 'saved' }, 'replace', accepted);
    staged[1]();
    release();
    expect(copyEntries()).toEqual(before);
    expect(useNavigationStatus()).toBe('waiting');
    go(1);
    flush();
    expect(index).toBe(1);
    expect(current().search).toContain('goal=saved');
    expect(window.history.state).toBe(42);
    expect(accepted).toHaveBeenCalledOnce();
    expect(useNavigationStatus()).toBe('ready');
    expect(entries[0]).toEqual(before[0]);
    expect(entries[2]).toEqual(before[2]);
    expect(go.mock.calls.map(([delta]) => delta)).toEqual([-1, 1]);
  });

  it('does not confuse equal opaque state/URLs with source identity, even at the actual opaque source', () => {
    const { staged, release } = setup(['opaque', { value: 'same' }]);
    entries[2] = { url: new URL(sourceUrl, ORIGIN), state: structuredClone(entries[1].state) };
    entries.push({ url: new URL('/chosen/?screen=settings#end', ORIGIN), state: 'chosen opaque' });
    const before = copyEntries();
    const mutation = vi.fn();
    // Server writes stay in their owners: only navigation callbacks are deferred.
    mutation();
    const accepted = vi.fn();
    const discard = vi.fn();
    setUrl({ goal: 'saved' }, 'replace', accepted);
    staged[1](discard);
    release();
    go(2);
    flush();
    expect(index).toBe(2);
    expect(useNavigationStatus()).toBe('waiting');
    expect(urlFor({})).toBe(sourceUrl);
    expect(copyEntries()).toEqual(before);
    go(-1);
    flush();
    expect(index).toBe(1);
    expect(useNavigationStatus()).toBe('waiting');
    expect(copyEntries()).toEqual(before);
    expect(accepted).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
    expect(mutation).toHaveBeenCalledOnce();
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    expect(go.mock.calls.map(([delta]) => delta)).toEqual([-1, 2, -1]);
    let choose!: Proceed;
    const releaseChoice = registerNavigationGuard((proceed) => { choose = proceed; return true; });
    go(2);
    flush();
    expect(useNavigationStatus()).toBe('displaced');
    const chosen = vi.fn();
    choose(chosen);
    choose(chosen);
    expect(useNavigationStatus()).toBe('ready');
    expect(urlFor({})).toBe('/chosen/?screen=settings#end');
    expect(chosen).toHaveBeenCalledOnce();
    expect(accepted).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
    expect(mutation).toHaveBeenCalledOnce();
    expect(copyEntries()).toEqual(before);
    releaseChoice();
  });

  it('abandons queued navigation when an unguarded browser request accepts another destination', () => {
    const { staged, release, before } = setup(42);
    const accepted = vi.fn();
    const discard = vi.fn();
    setUrl({ goal: 'saved' }, 'replace', accepted);
    staged[1](discard);
    release();
    go(2);
    flush();
    expect(index).toBe(2);
    expect(urlFor({})).toBe('/future/?ref=later#forward');
    expect(useNavigationStatus()).toBe('ready');
    expect(copyEntries()).toEqual(before);
    expect(accepted).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    staged[0]();
    staged[1](discard);
    expect(accepted).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
    expect(popListeners.size).toBe(0);
  });

  it('prefers a native key over matching index/state/URL on a different opaque entry', () => {
    let key = 'source-key';
    Object.assign(window, { navigation: { get currentEntry() {
      return index === 0 ? {} : { key, index: 1 };
    } } });
    const { staged, release, before } = setup('opaque');
    const accepted = vi.fn();
    setUrl({ goal: 'saved' }, 'replace', accepted);
    staged[1]();
    release();
    entries[2] = { url: new URL(sourceUrl, ORIGIN), state: 'opaque' };
    key = 'different-key';
    go(2);
    flush();
    expect(index).toBe(2);
    expect(useNavigationStatus()).toBe('waiting');
    expect(accepted).not.toHaveBeenCalled();
    expect(entries[0]).toEqual(before[0]);
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    key = 'source-key';
    go(-1);
    flush();
    expect(accepted).toHaveBeenCalledOnce();
    expect(index).toBe(1);
    expect(useNavigationStatus()).toBe('ready');
    expect(current().search).toContain('goal=saved');
  });

  it.each([false, true])('supersedes an older deferred write with a newer accepted=%s request', (acceptLatest) => {
    const { staged, release, before } = setup();
    const oldAccepted = vi.fn();
    const oldDiscard = vi.fn();
    const latestAccepted = vi.fn();
    const latestDiscard = vi.fn();
    setUrl({ goal: 'obsolete' }, 'push', oldAccepted);
    staged[1](oldDiscard);
    expect(useNavigationStatus()).toBe('waiting');
    setUrl({ goal: 'saved' }, 'replace', latestAccepted);
    expect(useNavigationStatus()).toBe('displaced');
    if (acceptLatest) staged[2](latestDiscard);
    expect(useNavigationStatus()).toBe(acceptLatest ? 'waiting' : 'displaced');
    staged[0]();
    staged[1](oldDiscard);
    expect(copyEntries()).toEqual(before);
    go(1);
    flush();
    expect(useNavigationStatus()).toBe('ready');
    expect(oldAccepted).not.toHaveBeenCalled();
    expect(oldDiscard).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
    if (!acceptLatest) {
      expect(copyEntries()).toEqual(before);
      expect(latestAccepted).not.toHaveBeenCalled();
      expect(latestDiscard).not.toHaveBeenCalled();
      // Returning to the source also invalidates the latest still-blocked request.
      staged[2](latestDiscard);
      expect(replaceState).not.toHaveBeenCalled();
      setUrl({ goal: 'saved' }, 'replace', latestAccepted);
      staged[3](latestDiscard);
    }
    expect(current().search).toContain('goal=saved');
    expect(replaceState).toHaveBeenCalledOnce();
    expect(latestAccepted).toHaveBeenCalledOnce();
    expect(latestDiscard).toHaveBeenCalledOnce();
    staged[1](oldDiscard);
    staged[2](latestDiscard);
    expect(latestAccepted).toHaveBeenCalledOnce();
    expect(latestDiscard).toHaveBeenCalledOnce();
    expect(entries[0]).toEqual(before[0]);
    expect(entries[2]).toEqual(before[2]);
    release();
  });

  it.each(['push', 'replace'] as const)('keeps a pending write/token untouched by a no-op %s', (mode) => {
    const { staged, handler, release, before } = setup();
    const accepted = vi.fn();
    const noOp = vi.fn();
    setUrl({ goal: 'saved' }, 'replace', accepted);
    staged[1]();
    setUrl({ goal: 'new' }, mode, noOp);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(useNavigationStatus()).toBe('waiting');
    expect(copyEntries()).toEqual(before);
    go(1);
    flush();
    expect(accepted).toHaveBeenCalledOnce();
    expect(noOp).not.toHaveBeenCalled();
    expect(current().search).toContain('goal=saved');
    expect(entries).toHaveLength(3);
    release();
  });

  it('keeps an indexed restoration and its accepted afterRestore write quiet without disturbing publication', () => {
    at('/?screen=overview');
    const staged: Proceed[] = [];
    let blocked = false;
    const release = registerNavigationGuard((proceed) => { staged.push(proceed); return blocked; });
    setUrl({ screen: 'goal', goal: 'new' });
    blocked = true;
    const status = observeStatus();
    expect(status.getSnapshot()).toBe('ready');
    const original = useUrl();
    go(-1);
    flushOne();
    expect(useNavigationStatus()).toBe('ready');
    expect(useUrl()).toBe(original);
    const accepted = vi.fn();
    setUrl({ goal: 'saved' }, 'replace', accepted);
    staged[2]();
    expect(useNavigationStatus()).toBe('ready');
    expect(accepted).not.toHaveBeenCalled();
    flush();
    expect(index).toBe(1);
    expect(useNavigationStatus()).toBe('ready');
    expect(accepted).toHaveBeenCalledOnce();
    expect(current().search).toContain('goal=saved');
    expect(status.changed).not.toHaveBeenCalled();
    release();
    status.release();
  });
});
