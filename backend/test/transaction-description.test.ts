import { describe, expect, it } from 'vitest';
import {
  categoryPatternMatches,
  makeTransferRuleMatcher,
  matchesTransferRule,
  similarDescriptionKey,
  tallyTransferRuleMatches,
  transactionDescription,
} from '../src/transaction-description';

describe('bank value dates in transaction descriptions', () => {
  it('separates a valid trailing value date from the display name', () => {
    expect(transactionDescription('Example Person Gutschriften Wertstellung 31.08.2026')).toEqual({
      displayDescription: 'Example Person Gutschriften', valueDate: '2026-08-31',
    });
    expect(transactionDescription('Shop Wertstellung 29.02.2024')).toMatchObject({ valueDate: '2024-02-29' });
  });

  it.each([
    'Shop 31.08.2026', 'Shop Wertstellung 31.02.2026', 'Shop Wertstellung 29.02.2025',
    'Shop Wertstellung 00.01.2026', 'Shop Wertstellung 01.13.2026',
    'Shop Wertstellung 31.08.2026 invoice', 'Wertstellung 31.08.2026',
    '  Wertstellung 31.08.2026', '',
  ])('preserves text that is not an unambiguous suffix: %s', (description) => {
    expect(transactionDescription(description)).toEqual({});
  });

  it('scans a whitespace run once, so a restored description cannot stall every recompute', () => {
    expect(transactionDescription(`A${' '.repeat(200_000)}B`)).toEqual({});
  });

  it('normalizes spacing and case but retains contract numbers and other dates', () => {
    expect(similarDescriptionKey(' Example\u00a0PERSON Gutschriften WERTSTELLUNG 01.09.2026 '))
      .toBe(similarDescriptionKey('example person Gutschriften Wertstellung 31.08.2026'));
    expect(similarDescriptionKey('Example contract 123 08/2026 Wertstellung 31.08.2026'))
      .toBe('example contract 123 08/2026');
    expect(similarDescriptionKey('Example contract 124 08/2026'))
      .not.toBe(similarDescriptionKey('Example contract 123 08/2026'));
  });

  it('keeps legacy matching exact and new matching inside one account', () => {
    const rule = { description: 'Example Wertstellung 31.08.2026', accountId: 'a', matchMode: 'exact' as const };
    const tx = { description: 'EXAMPLE Wertstellung 01.09.2026', accountId: 'a' };
    expect(matchesTransferRule(rule, { ...tx, description: rule.description })).toBe(true);
    expect(matchesTransferRule(rule, tx)).toBe(false);
    expect(matchesTransferRule({ ...rule, matchMode: 'similar-v1' }, tx)).toBe(true);
    expect(matchesTransferRule({ ...rule, matchMode: 'similar-v1' }, { ...tx, accountId: 'b' })).toBe(false);
    expect(matchesTransferRule({ ...rule, description: ' ', matchMode: 'similar-v1' }, { ...tx, description: '' })).toBe(false);
  });

  it('answers every rule at once, and every rule over a keyed account, as the pairwise rule does', () => {
    const exact = { description: 'Example Wertstellung 31.08.2026', accountId: 'a', matchMode: 'exact' as const };
    const rules = [exact, { ...exact, matchMode: 'similar-v1' as const }, { ...exact, description: ' ', matchMode: 'similar-v1' as const }];
    const rows = [
      { description: exact.description, accountId: 'a' }, { description: 'EXAMPLE Wertstellung 01.09.2026', accountId: 'a' },
      { description: 'EXAMPLE Wertstellung 01.09.2026', accountId: 'b' }, { description: '', accountId: 'a' },
      { description: exact.description, accountId: 'b' },
    ];
    const matcher = makeTransferRuleMatcher(rules);
    expect(rows.map(matcher)).toEqual(rows.map((row) => rules.some((rule) => matchesTransferRule(rule, row))));
    expect(rows.map(matcher)).toEqual([true, true, false, false, false]);
    const covered = tallyTransferRuleMatches(rows);
    expect(rules.map(covered)).toEqual(rules.map((rule) => rows.filter((row) => matchesTransferRule(rule, row)).length));
    expect(rules.map(covered)).toEqual([1, 2, 0]);
  });

  it('matches a category pattern the way the classifier does, and an empty pattern never', () => {
    expect(categoryPatternMatches('REWE Berlin', 'rewe')).toBe(true);
    expect(categoryPatternMatches('İSTANBUL MARKET', 'istanbul')).toBe(false);
    expect(categoryPatternMatches('ΟΔΟΣ ΑΘΗΝΑΣ 12', 'οδος')).toBe(true);
    expect(categoryPatternMatches('anything', '')).toBe(false);
    expect(categoryPatternMatches('', '')).toBe(false);
  });
});
