import { afterEach, describe, expect, it, vi } from 'vitest';

describe('currencyName', () => {
  const intl = Intl as unknown as { DisplayNames: unknown };
  const original = intl.DisplayNames;

  afterEach(() => {
    intl.DisplayNames = original;
    vi.resetModules();
  });

  it('names a known code and nothing that is not a code', async () => {
    const { currencyName } = await import('./currencies');
    expect(currencyName(' eur ')).toBe('Euro');
    expect(currencyName('EURO')).toBeNull();
  });

  it('loses only the name where Intl.DisplayNames is missing', async () => {
    vi.resetModules();
    intl.DisplayNames = undefined;
    const { currencyName, CURRENCY_SUGGESTIONS } = await import('./currencies');
    expect(CURRENCY_SUGGESTIONS).toContain('EUR');
    expect(currencyName('EUR')).toBeNull();
  });
});
