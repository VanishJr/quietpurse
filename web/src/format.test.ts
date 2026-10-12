import { describe, expect, it } from 'vitest';
import {
  fmtDay,
  fmtInstant,
  fmtMoney,
  fmtMonthKey,
  fmtMonthTick,
  fmtShort,
  fmtWeekday,
  isoDay,
  truncateMiddle,
} from './format';
import { day, instant, txDate } from './test/fixtures';

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
    // 10_000 as 10k. That is deliberate: an axis should not carry a pointless digit
    expect(fmtShort(9999)).toBe('10.0k');
    expect(fmtShort(10000)).toBe('10k');
  });
});

describe('dates', () => {
  it('runs west of UTC, where a day read through a Date is the day before', () => {
    expect(new Date('2026-09-30T00:00:00.000Z').getDate()).toBe(29);
  });

  it("fmtInstant reads a moment in the reader's own zone", () => {
    expect(fmtInstant(instant('2026-07-05T12:00:00.000Z'))).toBe('05.07.2026');
    expect(fmtInstant(instant('2026-10-01T02:00:00.000Z'))).toBe('30.09.2026');
  });

  it('fmtDay prints the day the bank wrote, in each shape the server sends one', () => {
    expect(fmtDay(day('2026-02-01'))).toBe('01.02.2026');
    expect(fmtDay(txDate('2026-09-30'))).toBe('30.09.2026');
    // a statement that states a time: east of UTC, read through a Date, this is the 6th
    expect(fmtDay(txDate('2026-01-05', '23:30:00'))).toBe('05.01.2026');
  });

  it('isoDay is local and round-trips a local Date', () => {
    expect(isoDay(new Date(2026, 6, 5))).toBe('2026-07-05');
    expect(isoDay(new Date(2026, 0, 1))).toBe('2026-01-01');
  });

  it('fmtMonthKey splits the string rather than parsing it', () => {
    // `new Date('2026-01')` is UTC midnight, which is December west of UTC
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
