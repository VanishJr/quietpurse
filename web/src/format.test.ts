import { describe, expect, it } from 'vitest';
import { fmtDate, fmtMoney, fmtMonth, fmtShort, isoDay } from './format';

describe('fmtMoney', () => {
  it('groups thousands and drops a zero fraction', () => {
    expect(fmtMoney(1000)).toBe('1,000');
    expect(fmtMoney(1234567.5)).toBe('1,234,567.50');
    expect(fmtMoney(0)).toBe('0');
  });

  it('uses a minus sign, not a hyphen', () => {
    // U+2212: the hyphen renders too short next to digits at this size
    expect(fmtMoney(-42.5)).toBe('−42.50');
    expect(fmtMoney(-42.5).startsWith('-')).toBe(false);
  });

  it('appends the currency only when one is given', () => {
    expect(fmtMoney(12.34, 'EUR')).toBe('12.34 EUR');
    expect(fmtMoney(12.34)).toBe('12.34');
  });
});

describe('fmtShort', () => {
  it('switches unit at each threshold', () => {
    expect(fmtShort(950)).toBe('950');
    expect(fmtShort(1200)).toBe('1.2k');
    expect(fmtShort(30500)).toBe('31k');
    expect(fmtShort(1200000)).toBe('1.2M');
  });

  it('keeps one decimal just under the rounding threshold', () => {
    // the k-with-a-decimal band ends at 10_000, so 9_999 reads as 10.0k and
    // 10_000 as 10k - deliberate, an axis should not carry a pointless digit
    expect(fmtShort(9999)).toBe('10.0k');
    expect(fmtShort(10000)).toBe('10k');
  });
});

describe('dates', () => {
  it('formats dd.mm.yyyy', () => {
    expect(fmtDate('2026-07-05T12:00:00Z')).toBe('05.07.2026');
  });

  it('reads a date-only string as UTC and prints it in local time', () => {
    // The API sends date-only strings, which JS parses as UTC midnight, and
    // fmtDate then reads them with local getters. West of UTC that is the day
    // before. The suite pins TZ=UTC (vitest.config.ts) so this stays stable -
    // the shift itself is real and lives on until dates are parsed as local.
    expect(fmtDate('2026-07-05')).toBe('05.07.2026');
  });

  it('isoDay is local and round-trips a local Date', () => {
    expect(isoDay(new Date(2026, 6, 5))).toBe('2026-07-05');
    expect(isoDay(new Date(2026, 0, 1))).toBe('2026-01-01');
  });

  it('fmtMonth names the month', () => {
    expect(fmtMonth(new Date(2026, 6, 15))).toBe('July 2026');
  });
});
