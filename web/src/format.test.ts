import { describe, expect, it } from 'vitest';
import {
  fmtDate,
  fmtDay,
  fmtMoney,
  fmtMonth,
  fmtMonthKey,
  fmtMonthTick,
  fmtShort,
  fmtWeekday,
  isoDay,
  truncateMiddle,
} from './format';

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

  it('fmtDay never turns a calendar date into an instant', () => {
    // The statement summary's date range. fmtDate is wrong for these in any negative
    // offset - `new Date('2026-02-01')` is UTC midnight, so it prints the 31st - and
    // unlike the fmtDate case above, that is not a shift this suite's TZ=UTC hides:
    // fmtDay splits the string, so there is no zone for it to be wrong in.
    expect(fmtDay('2026-02-01')).toBe('01.02.2026');
    expect(fmtDay('2026-12-31')).toBe('31.12.2026');
  });

  it('isoDay is local and round-trips a local Date', () => {
    expect(isoDay(new Date(2026, 6, 5))).toBe('2026-07-05');
    expect(isoDay(new Date(2026, 0, 1))).toBe('2026-01-01');
  });

  it('fmtMonth names the month', () => {
    expect(fmtMonth(new Date(2026, 6, 15))).toBe('July 2026');
  });

  it('fmtMonthKey splits the string rather than parsing it', () => {
    // `new Date('2026-01')` is UTC midnight and prints as December west of UTC. The
    // suite pins TZ=UTC, so only a split can be shown to be immune here - what the
    // assertion protects is that the implementation stays one.
    expect(fmtMonthKey('2026-07')).toBe('Jul 2026');
    expect(fmtMonthKey('2026-01')).toBe('Jan 2026');
    expect(fmtMonthKey('2025-12')).toBe('Dec 2025');
  });

  it('fmtMonthTick drops the year, which the range label above the chart carries', () => {
    expect(fmtMonthTick('2026-07')).toBe('Jul');
  });

  it('fmtWeekday names the day, which is what the greeting sits under', () => {
    // a real instant and read with local getters on purpose: this is today where the
    // reader is, not a calendar date off a statement
    expect(fmtWeekday(new Date(2026, 7, 7, 13, 30))).toBe('Friday, 7 Aug 2026');
    expect(fmtWeekday(new Date(2026, 0, 1))).toBe('Thursday, 1 Jan 2026');
  });
});

describe('truncateMiddle', () => {
  it('leaves a name that fits alone', () => {
    expect(truncateMiddle('Sparkasse', 18)).toBe('Sparkasse');
    // exactly the budget is a fit, not a cut
    expect(truncateMiddle('123456789012345678', 18)).toBe('123456789012345678');
  });

  it('keeps the end, which is where two statement exports differ', () => {
    // the real shape out of the database: same prefix, same date, different second
    const a = truncateMiddle('report_03-09-2026_11-22-33.pdf', 18);
    const b = truncateMiddle('report_03-09-2026_14-05-51.pdf', 18);
    expect(a).toHaveLength(18);
    expect(a).not.toBe(b);
    // cut from the right instead, both of these would read "report_03-09-202…"
    expect(a.endsWith('.pdf')).toBe(true);
  });

  it('spends the odd character on the head, because a name is read from the left', () => {
    expect(truncateMiddle('abcdefghij', 7)).toBe('abc…hij');
    expect(truncateMiddle('abcdefghij', 6)).toBe('abc…ij');
  });

  it('does not try to mark a cut it has no room for', () => {
    expect(truncateMiddle('abcdefghij', 3)).toBe('a…j');
    expect(truncateMiddle('abcdefghij', 2)).toBe('ab');
    expect(truncateMiddle('abcdefghij', 0)).toBe('');
  });
});
