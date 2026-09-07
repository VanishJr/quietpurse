/**
 * The one network call the backend makes, with the network stubbed: what the Monobank
 * list becomes, how long an answer is kept, and what a caller gets when the call fails.
 * The failure arm is the one the classifier stands on - it pairs a cross-currency
 * transfer with or without a rate - so it is driven end to end here as well.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REQUEST_TIMEOUT_MS } from '../src/rates';
import type { NewTransaction } from '../src/types';

const ENDPOINT = 'https://api.monobank.ua/bank/currency';
const TTL_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 10_000;

/** Monobank's shape: ISO 4217 numeric codes, and a cross rate or a buy/sell pair. */
const LIST = [
  { currencyCodeA: 840, currencyCodeB: 980, date: 1, rateBuy: 40, rateSell: 42 },
  { currencyCodeA: 978, currencyCodeB: 980, date: 1, rateCross: 45 },
  { currencyCodeA: 978, currencyCodeB: 840, date: 1, rateCross: 1.1 },
  { currencyCodeA: 826, currencyCodeB: 980, date: 1 },
];

type FetchArgs = Parameters<typeof fetch>;

const answering = (body: unknown, status = 200) =>
  vi.fn(
    async (..._args: FetchArgs) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  );

const failing = (error: Error) =>
  vi.fn(async (..._args: FetchArgs): Promise<Response> => {
    throw error;
  });

const install = (mock: ReturnType<typeof answering> | ReturnType<typeof failing>): void => {
  globalThis.fetch = mock as unknown as typeof fetch;
};

/** A fresh module, so the cache one case fills is not the cache the next reads. */
async function freshRates() {
  vi.resetModules();
  return (await import('../src/rates')).getRatesToUAH;
}

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
});

describe('getRatesToUAH', () => {
  it('maps the list to hryvnia per unit, and the hryvnia is 1', async () => {
    const fetchMock = answering(LIST);
    install(fetchMock);
    const getRatesToUAH = await freshRates();

    expect(await getRatesToUAH()).toEqual({ UAH: 1, USD: 41, EUR: 45 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(ENDPOINT);
  });

  /**
   * `toBeInstanceOf(AbortSignal)` alone is green against a signal that has ALREADY
   * fired, and against a budget of one millisecond - both of which abort the call
   * before it leaves, where ratesOrEmpty swallows the throw and every cross-currency
   * pair is then decided on time alone. So the signal is read for its state, and the
   * wait is real: AbortSignal.timeout runs on Node's own timer, which vi's fake ones
   * do not reach.
   */
  it('asks with a timeout that is neither already fired nor a token one', async () => {
    const fetchMock = answering(LIST);
    install(fetchMock);
    const getRatesToUAH = await freshRates();

    await getRatesToUAH();
    const signal = fetchMock.mock.calls[0][1]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect((signal as AbortSignal).aborted).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((signal as AbortSignal).aborted).toBe(false);
  });

  it('gives that call ten seconds', () => {
    expect(REQUEST_TIMEOUT_MS).toBe(TIMEOUT_MS);
  });

  it('answers the cache for just under ten minutes and asks again at ten', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-06T12:00:00.000Z'));
    const fetchMock = answering(LIST);
    install(fetchMock);
    const getRatesToUAH = await freshRates();

    await getRatesToUAH();
    vi.setSystemTime(Date.now() + TTL_MS - 1);
    await getRatesToUAH();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 1);
    await getRatesToUAH();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a failing call with nothing cached rejects with the failure', async () => {
    install(failing(new Error('no route to host')));
    const getRatesToUAH = await freshRates();

    await expect(getRatesToUAH()).rejects.toThrow('no route to host');
  });

  it('an answer that is not OK rejects, naming the status', async () => {
    install(answering({}, 503));
    const getRatesToUAH = await freshRates();

    await expect(getRatesToUAH()).rejects.toThrow('Monobank /bank/currency -> 503');
  });

  it('a failing call after a success answers the stale cache', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-06T12:00:00.000Z'));
    install(answering(LIST));
    const getRatesToUAH = await freshRates();
    const first = await getRatesToUAH();

    vi.setSystemTime(Date.now() + TTL_MS);
    const failed = failing(new Error('no route to host'));
    install(failed);
    expect(await getRatesToUAH()).toEqual(first);
    expect(failed).toHaveBeenCalledTimes(1);
  });
});

describe('reclassifyAll when the rate call fails', () => {
  /**
   * The timeout is modelled by the rejection the runtime produces for one; waiting the
   * real ten seconds would hold the suite for nothing. The pair is inside the
   * cross-currency window, so with no rate to check against it is made on time alone.
   */
  it('a timed-out rate call does not stop the pairing', async () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const fetchMock = failing(timeout);
    install(fetchMock);

    vi.resetModules();
    const db = await import('../src/db');
    const { freshTestDb } = await import('./pglite');
    db.initDb(await freshTestDb());
    await db.seedDefaults();
    const { reclassifyAll } = await import('../src/classify');

    const leg = (over: Partial<NewTransaction>): NewTransaction => ({
      accountId: 'eur-card',
      provider: 'upload',
      amount: -100,
      currency: 'EUR',
      date: '2026-03-03T09:00:00.000Z',
      description: 'Card to card',
      category: 'other',
      fee: null,
      mcc: 4829,
      ...over,
    });
    await db.insertTransactions([
      leg({}),
      leg({
        accountId: 'uah-card',
        amount: 4800,
        currency: 'UAH',
        date: '2026-03-03T09:05:00.000Z',
        description: 'Поповнення з картки',
      }),
    ]);

    await expect(reclassifyAll()).resolves.toBe(2);
    expect(fetchMock).toHaveBeenCalled();
    expect((await db.allTransactions()).map((t) => t.transfer)).toEqual([true, true]);
  });
});
