import { describe, expect, it } from 'vitest';
import {
  CATEGORIES,
  CATEGORY_LABELS,
  categoryLabel,
  categoryRuleCaption,
  incomeSourceLabel,
  REST_SECTOR,
  spendRing,
  spendSectors,
} from './categories';
import { PROVIDER_LABELS, providerLabel } from './providers';
import type { SUPPORT_INCOME_SOURCE } from './types';

/** The one derived source the server answers today, held to the wire's literal by tsc. */
const SUPPORT_SOURCE = 'category:support' satisfies typeof SUPPORT_INCOME_SOURCE;

describe('category dictionary', () => {
  it('has a label for every slug in the picker', () => {
    for (const slug of CATEGORIES) {
      expect(CATEGORY_LABELS[slug], `no label for "${slug}"`).toBeTypeOf('string');
    }
  });

  it('returns an unknown slug as-is', () => {
    expect(categoryLabel('groceries-2')).toBe('groceries-2');
  });

  it('answers a slug that names an inherited property with the slug, and never the property', () => {
    // a restored backup can carry any string as a category; a plain lookup answers
    // Object.prototype here, which React refuses as a child and unmounts the screen on
    expect(categoryLabel('__proto__')).toBe('__proto__');
    expect(incomeSourceLabel('category:__proto__', 'x')).toBe('__proto__');
  });
});

describe('the word for an income source', () => {
  it('reads a derived source through the category dictionary, whatever label it arrived with', () => {
    // the server answers the id as the label and composes no word: the word is this
    // dictionary's, so a renamed category and the source it derives cannot come apart
    expect(incomeSourceLabel(SUPPORT_SOURCE, SUPPORT_SOURCE)).toBe(categoryLabel('support'));
    expect(incomeSourceLabel(SUPPORT_SOURCE, SUPPORT_SOURCE)).not.toBe(SUPPORT_SOURCE);
  });

  it('keeps the label a catalogue source arrived with, which is the person’s own word', () => {
    expect(incomeSourceLabel('family', 'Mum and Dad')).toBe('Mum and Dad');
    expect(incomeSourceLabel('src-1', 'Acme GmbH')).toBe('Acme GmbH');
  });
});

describe('the sectors of the Overview ring', () => {
  it('carries the name a person reads, and never the slug', () => {
    expect(spendSectors([{ category: 'food', total: 120 }])).toEqual([
      { category: 'food', total: 120, label: 'Food' },
    ]);
  });

  it('labels a slug no dictionary knows with itself', () => {
    expect(spendSectors([{ category: 'groceries-2', total: 8 }])[0].label).toBe('groceries-2');
  });

  it('draws no sector for a category a refund pushed below zero', () => {
    const sectors = spendSectors([
      { category: 'food', total: 120 },
      { category: 'shopping', total: -40 },
      { category: 'cash', total: 0 },
    ]);
    expect(sectors.map((s) => s.category)).toEqual(['food']);
  });
});

describe('the ring against its legend', () => {
  /** Two in the tail, one of them a refund that exactly offsets the other. */
  const SPEND = [
    { category: 'food', total: 100 },
    { category: 'health', total: 50 },
    { category: 'shopping', total: 30 },
    { category: 'cash', total: 20 },
    { category: 'travel', total: -20 },
  ];

  it('draws the tail’s positive spending while the legend prints its net remainder', () => {
    const ring = spendRing(SPEND, 180);
    expect(ring.top.map((c) => c.category)).toEqual(['food', 'health', 'shopping']);
    expect(ring.rest.map((c) => c.category)).toEqual(['cash', 'travel']);
    // the tail’s row: 180 less the three named, which the refund has brought to nothing
    expect(ring.restTotal).toBe(0);
    // the tail’s sector: the cash that was spent, which a refund elsewhere does not undraw
    expect(ring.sectors.map((s) => [s.category, s.total])).toEqual([
      ['food', 100],
      ['health', 50],
      ['shopping', 30],
      [REST_SECTOR, 20],
    ]);
    expect(ring.sectors[3].label).toBe('Remaining · 2 categories');
  });

  it('keeps the server’s order and names actual Other separately from the remainder', () => {
    const ring = spendRing(
      [
        { category: 'other', total: 10 },
        { category: 'food', total: 60 },
        { category: 'housing', total: 100 },
        { category: 'cash', total: 40 },
      ],
      210,
    );
    expect(ring.top.map((c) => c.category)).toEqual(['other', 'food', 'housing']);
    expect(ring.rest).toEqual([{ category: 'cash', total: 40 }]);
    expect(ring.restTotal).toBe(40);
    expect(ring.sectors.map((s) => [s.category, s.label, s.total])).toEqual([
      ['other', 'Other', 10],
      ['food', 'Food', 60],
      ['housing', 'Housing', 100],
      [REST_SECTOR, 'Remaining · 1 category', 40],
    ]);
  });

  it('subtracts in cents, so a remainder that is zero on paper is zero on screen', () => {
    // 180.6 less 100.1, 50.2 and 30.3 is a few quadrillionths off zero in floating
    // point, which fmtMoney prints as −0; in cents it is 0 and prints as 0
    const ring = spendRing(
      [
        { category: 'food', total: 100.1 },
        { category: 'health', total: 50.2 },
        { category: 'shopping', total: 30.3 },
        { category: 'cash', total: 20 },
        { category: 'travel', total: -20 },
      ],
      180.6,
    );
    expect(ring.restTotal).toBe(0);
  });

  it('draws no tail when the tail is nothing but refunds, and none when there is no tail', () => {
    const refundsOnly = [
      { category: 'food', total: 100 },
      { category: 'health', total: 50 },
      { category: 'shopping', total: 30 },
      { category: 'travel', total: -20 },
    ];
    expect(spendRing(refundsOnly, 160).sectors.map((s) => s.category)).toEqual([
      'food',
      'health',
      'shopping',
    ]);
    expect(spendRing([{ category: 'food', total: 100 }], 100)).toEqual({
      top: [{ category: 'food', total: 100 }],
      rest: [],
      restTotal: 0,
      sectors: [{ category: 'food', total: 100, label: 'Food' }],
    });
  });

  it('keeps slug identity when a named category has no positive sector', () => {
    const ring = spendRing(
      [
        { category: 'food', total: 100 },
        { category: 'health', total: -50 },
        { category: 'shopping', total: 30 },
        { category: 'cash', total: 20 },
      ],
      100,
    );
    expect(ring.top.map((c) => c.category)).toEqual(['food', 'health', 'shopping']);
    expect(ring.sectors.map((s) => [s.category, s.label, s.total])).toEqual([
      ['food', 'Food', 100],
      ['shopping', 'Shopping', 30],
      [REST_SECTOR, 'Remaining · 1 category', 20],
    ]);
    expect(ring.restTotal).toBe(20);
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
