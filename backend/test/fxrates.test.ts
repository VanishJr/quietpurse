import { afterEach, describe, expect, it, vi } from 'vitest';
import { getFxRate, saveFxRate } from '../src/db';
import { ecbProvider, nbuProvider, resolveRate } from '../src/fxrates';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const mockJson = (payload: unknown) =>
  Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as Response);

describe('resolveRate: ECB for its own currencies, NBU for the hryvnia', () => {
  it('USD -> EUR goes through frankfurter and is cached as a pair', async () => {
    const fetchMock = vi.fn((url: string | URL | Request) => {
      expect(String(url)).toContain('frankfurter.dev');
      expect(String(url)).toContain('base=USD');
      return mockJson({ rates: { EUR: 0.9 } });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(await resolveRate('2026-03-02', 'USD', 'EUR')).toBe(0.9);
    expect(await getFxRate('2026-03-02', 'USD:EUR')).toBe(0.9);

    // the second call comes from the cache, the network is untouched
    expect(await resolveRate('2026-03-02', 'USD', 'EUR')).toBe(0.9);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('UAH -> EUR is not an ECB pair - an NBU cross-rate through hryvnia', async () => {
    const fetchMock = vi.fn((url: string | URL | Request) => {
      const u = String(url);
      expect(u).toContain('bank.gov.ua');
      if (u.includes('valcode=EUR')) return mockJson([{ cc: 'EUR', rate: 48.0 }]);
      return mockJson([]);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // 1 UAH = 1/48 EUR
    expect(await resolveRate('2026-03-02', 'UAH', 'EUR')).toBeCloseTo(1 / 48, 6);
    // the NBU leg is cached in the old format (day, currency) -> hryvnia per unit
    expect(await getFxRate('2026-03-02', 'EUR')).toBe(48.0);
  });

  it('an identical pair is 1 without network; an unknown currency is null, not a throw', async () => {
    globalThis.fetch = (() => Promise.reject(new Error('network disabled'))) as typeof fetch;
    expect(await resolveRate('2026-03-02', 'EUR', 'EUR')).toBe(1);
    // the ECB does not know XXX; the NBU returns nothing (network fails) -> the network error propagates
    await expect(resolveRate('2026-03-02', 'XXX', 'EUR')).rejects.toThrow();
  });

  it('supports: ECB by its static list, NBU always tries', () => {
    expect(ecbProvider.supports('USD', 'EUR')).toBe(true);
    expect(ecbProvider.supports('UAH', 'EUR')).toBe(false);
    expect(nbuProvider.supports('UAH', 'EUR')).toBe(true);
  });

  it('NBU lookback: no rate on a weekend - the Friday rate comes from the cache', async () => {
    // for Saturday the NBU returns an empty array (no rate), Friday is already cached
    globalThis.fetch = ((url: string | URL | Request) => {
      expect(String(url)).toContain('bank.gov.ua');
      return mockJson([]);
    }) as unknown as typeof fetch;
    await saveFxRate('2026-03-06', 'PLN', 11.5);
    await saveFxRate('2026-03-06', 'EUR', 48.0);
    expect(await nbuProvider.getRate('2026-03-07', 'PLN', 'EUR')).toBeCloseTo(11.5 / 48, 6);
    // and Saturday is cached under the requested day - a repeat needs no network
    expect(await getFxRate('2026-03-07', 'PLN')).toBe(11.5);
  });
});
