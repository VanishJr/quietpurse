/**
 * A held rate call is released with a rejection and never with a rate list: an answer is
 * cached, and the next run would then make no call to count.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reclassifyAll, reclassifyIdle, reclassifyIfRulesChanged } from '../src/classify';
import { addCategoryRule, dbInstance, insertTransactions, seedDefaults, setMeta } from '../src/db';
import { NewTransaction } from '../src/types';
import { findTx, rejectionOf } from './helpers';
import { freshTestDb } from './pglite';

const MONOBANK = 'https://api.monobank.ua/bank/currency';
const WINDOW_MS = 100;

const realFetch = globalThis.fetch;
let holding = false;
let rateCalls = 0;
let parked: (() => void)[] = [];
let settledOrder: string[] = [];

const offline = (): Promise<Response> => Promise.reject(new Error('network disabled in tests'));

const release = (): void => {
  const waiting = parked;
  parked = [];
  for (const fail of waiting) fail();
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function track<T>(name: string, promise: Promise<T>): { promise: Promise<T>; settled: () => boolean } {
  let settled = false;
  const mark = (): void => {
    settled = true;
    settledOrder.push(name);
  };
  promise.then(mark, mark);
  return { promise, settled: () => settled };
}

const row = (description: string): NewTransaction => ({
  accountId: 'serial-acc',
  provider: 'upload',
  amount: -12.5,
  currency: 'EUR',
  date: '2026-04-02T10:00:00.000Z',
  description,
  category: 'other',
  fee: null,
});

const categoryOf = async (description: string): Promise<string> =>
  (await findTx((t) => t.description === description)).category;

beforeEach(async () => {
  await freshTestDb();
  await seedDefaults();
  holding = false;
  rateCalls = 0;
  parked = [];
  settledOrder = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    if (String(input) !== MONOBANK) return offline();
    rateCalls += 1;
    if (!holding) return offline();
    const signal = init?.signal;
    return new Promise<Response>((_, reject) => {
      parked.push(() => reject(new Error('released')));
      // as a real fetch does: a call a failed case left parked then ends at the request's
      // own timeout, inside setup.ts's idle wait, instead of wedging every later file
      signal?.addEventListener('abort', () => reject(signal.reason));
    });
  }) as typeof fetch;
});

afterEach(() => {
  holding = false;
  release();
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('the recompute runs one at a time', () => {
  it('starts no second run while one is in flight', async () => {
    await insertTransactions([row('Serial one')]);
    holding = true;
    const a = track('a', reclassifyAll());
    await vi.waitFor(() => expect(rateCalls).toBe(1));

    const b = track('b', reclassifyAll());
    await sleep(WINDOW_MS);
    expect(rateCalls, 'a second run reached its rate call while the first was held').toBe(1);

    holding = false;
    release();
    await a.promise;
    await b.promise;
    expect(rateCalls).toBe(2);
    expect(settledOrder).toEqual(['a', 'b']);
  });

  it('answers every caller who arrives during a run with one run that starts after them', async () => {
    await insertTransactions([row('Serial two')]);
    holding = true;
    const a = track('a', reclassifyAll());
    await vi.waitFor(() => expect(rateCalls).toBe(1));
    const idle = track('idle', reclassifyIdle());
    const callers = [1, 2, 3].map((n) => track(`c${n}`, reclassifyAll()));

    release();
    await vi.waitFor(() => expect(rateCalls, 'no follow-up run started after the held one').toBe(2));
    expect(a.settled()).toBe(true);
    expect(callers.map((c) => c.settled()), 'a caller was answered by the run it arrived during').toEqual([false, false, false]);
    expect(idle.settled(), 'the idle wait settled with a run still queued').toBe(false);

    const d = track('d', reclassifyAll());
    release();
    await vi.waitFor(() => expect(rateCalls, 'a caller arriving during the follow-up joined it').toBe(3));
    await Promise.all(callers.map((c) => c.promise));
    expect(d.settled()).toBe(false);
    expect(idle.settled(), 'the idle wait settled with a run in flight').toBe(false);

    holding = false;
    release();
    await d.promise;
    await idle.promise;
    expect(rateCalls).toBe(3);
  });

  it('signs the rules the run loaded, not a rule saved while it was in flight', async () => {
    await insertTransactions([row('Zorblat Qwv')]);
    holding = true;
    const a = track('a', reclassifyAll());
    await vi.waitFor(() => expect(rateCalls).toBe(1));

    await addCategoryRule('zorblat', 'food');
    holding = false;
    release();
    await a.promise;
    expect(await categoryOf('Zorblat Qwv'), 'the run loaded its rules after the hold, not before').toBe('other');

    expect(await reclassifyIfRulesChanged(), 'the signature names a rule the rows never received').toBe(true);
    expect(await categoryOf('Zorblat Qwv')).toBe('food');
  });

  it('starts the queued run after a run that failed, and hands the failure only to its own callers', async () => {
    await insertTransactions([row('Glovo order')]);
    holding = true;
    const a = rejectionOf(reclassifyAll());
    await vi.waitFor(() => expect(rateCalls).toBe(1));

    const boom = new Error('the re-tag write failed');
    const execute = vi.spyOn(dbInstance(), 'execute').mockRejectedValueOnce(boom);
    const heard: unknown[] = [];
    const listen = (reason: unknown): void => {
      heard.push(reason);
    };
    process.on('unhandledRejection', listen);
    try {
      const c = track('c', reclassifyAll());
      holding = false;
      release();
      expect(await a).toBe(boom);
      await c.promise;
      expect(await categoryOf('Glovo order'), 'the queued run did not write').toBe('food');

      await reclassifyAll();
      expect(rateCalls).toBe(3);
      await nextTurn();
      expect(heard).toEqual([]);
    } finally {
      process.off('unhandledRejection', listen);
      execute.mockRestore();
    }
  });

  it('leaves nothing unhandled when a run fails with nobody queued behind it', async () => {
    await insertTransactions([row('Serial alone')]);
    holding = true;
    const a = rejectionOf(reclassifyAll());
    await vi.waitFor(() => expect(rateCalls).toBe(1));

    const boom = new Error('the re-tag write failed');
    const execute = vi.spyOn(dbInstance(), 'execute').mockRejectedValueOnce(boom);
    const heard: unknown[] = [];
    const listen = (reason: unknown): void => {
      heard.push(reason);
    };
    process.on('unhandledRejection', listen);
    try {
      holding = false;
      release();
      expect(await a).toBe(boom);
      await nextTurn();
      expect(heard, 'the queue kept a rejection nobody handles').toEqual([]);

      await reclassifyAll();
      expect(rateCalls).toBe(2);
    } finally {
      process.off('unhandledRejection', listen);
      execute.mockRestore();
    }
  });

  it('compares the signature only after the run in flight has written its own', async () => {
    await insertTransactions([row('Serial five')]);
    await setMeta('classify_version', 'stale');
    holding = true;
    const a = track('a', reclassifyAll());
    await vi.waitFor(() => expect(rateCalls).toBe(1));

    const check = track('check', reclassifyIfRulesChanged());
    await sleep(WINDOW_MS);
    expect(check.settled(), 'the start-up check settled while a run was in flight').toBe(false);

    holding = false;
    release();
    await a.promise;
    expect(await check.promise, 'the start-up check compared before the run in flight had written').toBe(false);
    expect(rateCalls).toBe(1);
  });

  it('lets a held run finish inside its own case when its rate call times out', async () => {
    await insertTransactions([row('Serial timed out')]);
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    holding = true;
    const a = track('a', reclassifyAll());
    await vi.waitFor(() => expect(rateCalls).toBe(1));

    timeout.abort(new Error('the rate call timed out'));
    await vi.waitFor(() => expect(a.settled(), 'a held run outlived the timeout of its own rate call').toBe(true));
    await a.promise;
    expect(rateCalls).toBe(1);
  });
});
