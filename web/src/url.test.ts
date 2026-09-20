/**
 * url.ts without a DOM: a `window` carrying only what the module reads - `location`,
 * `history`, and the popstate listener pair - so what is asserted is the string the
 * module composes and which history call it makes, with nothing rendered. `useUrl` is
 * a hook and stays held by the screens that mount it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppUrl } from './url';

const ORIGIN = 'http://finto.test';

let current = new URL('/', ORIGIN);

const pushState = vi.fn((_state: unknown, _title: string, next: string) => {
  current = new URL(next, current);
});
const replaceState = vi.fn((_state: unknown, _title: string, next: string) => {
  current = new URL(next, current);
});

Object.assign(globalThis, {
  window: {
    location: {
      get pathname() {
        return current.pathname;
      },
      get search() {
        return current.search;
      },
      get hash() {
        return current.hash;
      },
    },
    history: { pushState, replaceState },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  },
});

const { urlFor, setUrl } = await import('./url');

const KEYS = ['screen', 'account', 'panel', 'chart', 'goal'] as const;

const at = (href: string): void => {
  current = new URL(href, ORIGIN);
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

const EMPTY: AppUrl = { screen: null, account: null, panel: null, chart: null, goal: null };
const FULL: AppUrl = {
  screen: 'overview',
  account: 'acc-1',
  panel: 'import',
  chart: 'c1',
  goal: 'g1',
};

beforeEach(() => {
  at('/');
  pushState.mockClear();
  replaceState.mockClear();
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

describe('setUrl', () => {
  it('pushes one history entry by default, and the URL reads back changed', () => {
    setUrl({ screen: 'transactions' });
    expect(pushState).toHaveBeenCalledTimes(1);
    expect(pushState.mock.calls[0][2]).toBe('/?screen=transactions');
    expect(replaceState).not.toHaveBeenCalled();
    expect(current.search).toBe('?screen=transactions');
  });

  it("'replace' rewrites the entry and pushes nothing", () => {
    setUrl({ account: 'acc-2' }, 'replace');
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState.mock.calls[0][2]).toBe('/?account=acc-2');
    expect(pushState).not.toHaveBeenCalled();
    expect(current.search).toBe('?account=acc-2');
  });

  it('writing the URL already shown adds no history entry', () => {
    setUrl({ screen: 'transactions' });
    setUrl({ screen: 'transactions' });
    expect(pushState).toHaveBeenCalledTimes(1);
  });

  it('a later write keeps what an earlier one set', () => {
    setUrl({ screen: 'overview' });
    setUrl({ account: 'acc-1' });
    expect(pushState).toHaveBeenCalledTimes(2);
    expect(parse(current.href)).toEqual({ ...EMPTY, screen: 'overview', account: 'acc-1' });
  });
});
