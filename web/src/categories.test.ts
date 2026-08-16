import { describe, expect, it } from 'vitest';
import { CATEGORIES, CATEGORY_LABELS, categoryLabel, categoryRuleCaption } from './categories';
import { PROVIDER_LABELS, providerLabel } from './providers';

describe('category dictionary', () => {
  it('has a label for every slug in the picker', () => {
    for (const slug of CATEGORIES) {
      expect(CATEGORY_LABELS[slug], `no label for "${slug}"`).toBeTypeOf('string');
    }
  });

  it('returns an unknown slug as-is', () => {
    expect(categoryLabel('groceries-2')).toBe('groceries-2');
  });
});

describe('what a category rule just did', () => {
  it('names the pattern, the rule and both of the two numbers', () => {
    expect(categoryRuleCaption('REWE', 'food', { matches: 15, overridden: 3 })).toBe(
      'The rule sets Food for transactions whose description contains "REWE". ' +
        '15 transactions match that text across every account, hidden ones included. ' +
        '3 of them keep a category you set by hand, which no rule changes.',
    );
  });

  it('never states a number of rows the rule moved', () => {
    // matches - overridden is a claim about where rows ended up, and two things make it
    // false: a row hand-set to this rule's own category is counted in `overridden`, and
    // a newer overlapping rule keeps rows this one matched
    const caption = categoryRuleCaption('REWE', 'food', { matches: 15, overridden: 3 });
    expect(caption).not.toContain('12');
  });

  it('says nothing about hand-set rows when there are none', () => {
    const caption = categoryRuleCaption('BVG', 'transport', { matches: 4, overridden: 0 });
    expect(caption).toContain('4 transactions match that text across every account');
    expect(caption).not.toContain('by hand');
  });

  it('counts one match in the singular', () => {
    expect(categoryRuleCaption('Netflix', 'subscriptions', { matches: 1, overridden: 0 })).toContain(
      '1 transaction matches that text',
    );
  });

  it('says so when every match is hand-set, singular and plural', () => {
    expect(categoryRuleCaption('REWE', 'food', { matches: 3, overridden: 3 })).toContain(
      'All 3 keep a category you set by hand',
    );
    expect(categoryRuleCaption('REWE', 'food', { matches: 1, overridden: 1 })).toContain(
      'It keeps a category you set by hand',
    );
  });

  it('reports a pattern that matches nothing as saved, not as refused', () => {
    const caption = categoryRuleCaption('Zzz', 'other', { matches: 0, overridden: 0 });
    expect(caption).toContain('the rule is saved and applies to transactions that arrive later');
    expect(caption).not.toContain('0 transactions');
  });

  it('cuts a pattern longer than the display budget', () => {
    const long = 'A'.repeat(200);
    const caption = categoryRuleCaption(long, 'food', { matches: 2, overridden: 0 });
    expect(caption).toContain(`"${'A'.repeat(80)}…"`);
    expect(caption).not.toContain('A'.repeat(81));
  });
});

describe('provider dictionary', () => {
  it('names every provider the API can return', () => {
    // 'upload' covers every statement the user brought in themselves - the parser
    // that read it (csv, xlsx) is an implementation detail and must never surface
    expect(providerLabel('upload')).toBe('Uploaded statement');
    expect(PROVIDER_LABELS).not.toHaveProperty('csv');
    expect(PROVIDER_LABELS).not.toHaveProperty('xlsx');
  });

  it('returns an unknown provider as-is', () => {
    expect(providerLabel('revolut-direct')).toBe('revolut-direct');
  });
});
