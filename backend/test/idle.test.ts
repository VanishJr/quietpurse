import { expect, it, vi } from 'vitest';
import { reclassifyAll } from '../src/classify';
import { insertTransactions } from '../src/db';

const sentinel = (() => Promise.reject(new Error('the previous case mock'))) as typeof fetch;
let left = false;

it('leaves a fetch mock of its own in place when it ends', () => {
  // not restored here, and this file has no hook: only the setup file's after hooks
  // stand between this mock and the next case
  globalThis.fetch = sentinel;
  left = true;
});

it('starts offline whatever mock the case before it left behind', async () => {
  expect(left, 'the case that leaves a mock in place did not run').toBe(true);
  expect(globalThis.fetch, 'the idle hook left the previous case mock in place').not.toBe(sentinel);
  await expect(globalThis.fetch('https://example.invalid/')).rejects.toThrow('network disabled in tests');
});

let calls = 0;
let parked: (() => void) | undefined;

it('leaves a rate call parked, with a run queued behind it, when it ends', async () => {
  const holding = ((_input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    if (calls > 1) return Promise.reject(new Error('a call after the parked one'));
    const signal = init?.signal;
    return new Promise<Response>((_, reject) => {
      parked = () => reject(new Error('released'));
      signal?.addEventListener('abort', () => reject(signal.reason));
    });
  }) as typeof fetch;
  // the idle hook's own assignment of fetch is what releases the parked call, so the run
  // queued behind it meets whatever that hook assigned; nothing is awaited or restored
  // here, which would end the hold before the hook runs
  let current = holding;
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    get: () => current,
    set: (value: typeof fetch) => {
      current = value;
      parked?.();
    },
  });

  await insertTransactions([
    {
      accountId: 'idle-acc',
      provider: 'upload',
      amount: -12.5,
      currency: 'EUR',
      date: '2026-04-02T10:00:00.000Z',
      description: 'Idle parked',
      category: 'other',
      fee: null,
    },
  ]);
  void reclassifyAll();
  await vi.waitFor(() => expect(calls).toBe(1));
  void reclassifyAll();
});

it('finds that the run queued behind the parked call met the network offline', () => {
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: globalThis.fetch,
  });
  expect(calls, 'the idle hook waited on the queue before it put the network offline').toBe(1);
});
