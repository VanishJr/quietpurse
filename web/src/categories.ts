import { toCents } from './accounts';
import { CategoryRuleCounts, CategorySummary } from './types';

export const CATEGORY_LABELS: Record<string, string> = {
  housing: 'Housing',
  food: 'Food',
  transport: 'Transport',
  subscriptions: 'Subscriptions',
  entertainment: 'Entertainment',
  health: 'Health',
  shopping: 'Shopping',
  cash: 'Cash',
  transfers: 'Transfers',
  salary: 'Salary',
  support: 'Support',
  cashback: 'Cashback',
  other: 'Other',
  // pseudo-category on the Goal screen: amortized one-off purchases
  'one-off-avg': 'One-off (avg)',
};

/** In the picker's order. */
export const CATEGORIES = [
  'housing',
  'food',
  'transport',
  'subscriptions',
  'entertainment',
  'health',
  'shopping',
  'cash',
  'transfers',
  'salary',
  'support',
  'cashback',
  'other',
] as const;

/**
 * A slug the picker can actually send. Not Transaction.category, which stays a string:
 * rows carry whatever the backend classified them as.
 */
export type Category = (typeof CATEGORIES)[number];

export const categoryLabel = (slug: string): string =>
  Object.hasOwn(CATEGORY_LABELS, slug) ? CATEGORY_LABELS[slug] : slug;

/** The read-only income source the server derives from a category: this prefix and the slug. */
const CATEGORY_SOURCE = 'category:';

/**
 * The word for an income source. A derived one reads through the category dictionary, so
 * the category and the source it derives are one word wherever either is printed; every
 * other id keeps the label it arrived with, the catalogue's or the wire's.
 */
export const incomeSourceLabel = (id: string, label: string): string =>
  id.startsWith(CATEGORY_SOURCE) ? categoryLabel(id.slice(CATEGORY_SOURCE.length)) : label;

export interface SpendSector extends CategorySummary {
  label: string;
}

/**
 * Only the positive categories: a refund can push one below zero — the purchase it
 * reverses was in an earlier month — and there is no such thing as a negative sector.
 * That is also why the figure in the hole `SpendingByCategory` draws is the month's
 * expense total and not the sum of these.
 *
 * The labelling is here rather than in the component because recharts looks `nameKey`
 * up on the datum and never checks it: a ring whose sectors carry only the slug prints
 * `food` at the reader when they point at one, and nothing but a case can say so.
 */
export const spendSectors = <T extends CategorySummary>(spend: T[]): (T & SpendSector)[] =>
  spend
    .filter((c) => c.total > 0)
    .map((c) => ({ ...c, label: categoryLabel(c.category) }));

/** How many categories the Overview ring names before it groups the tail. */
const RING_TOP = 3;

/** The tail's own key, which no slug can be. */
export const REST_SECTOR = '__rest';

export const restLabel = (count: number): string =>
  `Other · ${count} ${count === 1 ? 'category' : 'categories'}`;

export interface RingSector extends SpendSector {
  /** The sector's row in the legend: its index in `top`, and none for the tail. */
  slot: number | null;
}

export interface SpendRing {
  /** The categories the legend names, in the server's order. */
  top: CategorySummary[];
  /** What the legend groups under one row. */
  rest: CategorySummary[];
  /** The tail as the legend prints it: the month's net total less the named categories. */
  restTotal: number;
  /** What the ring draws: the named categories and the tail, positive parts only. */
  sectors: RingSector[];
}

/**
 * The legend keeps the server's net figures while the ring draws only what has a size,
 * so the tail's sector is the sum of its positive categories and not the legend's
 * remainder — a refund inside the tail can zero the one and not the other.
 */
export function spendRing(spend: CategorySummary[], total: number): SpendRing {
  const top = spend.slice(0, RING_TOP);
  const rest = spend.slice(RING_TOP);
  // Subtract in cents so a zero remainder stays zero after the wire's conversion.
  const restTotal =
    (toCents(total) - top.reduce((sum, c) => sum + toCents(c.total), 0)) / 100;
  const positiveRest =
    spendSectors(rest).reduce((sum, c) => sum + toCents(c.total), 0) / 100;
  const sectors: RingSector[] = [
    // the slot is stamped before the positive filter, so a named category a refund
    // pushed below zero takes its slot with it and the ones after keep theirs
    ...spendSectors(top.map((c, slot) => ({ ...c, slot }))),
    ...(positiveRest > 0
      ? [{ category: REST_SECTOR, label: restLabel(rest.length), total: positiveRest, slot: null }]
      : []),
  ];
  return { top, rest, restTotal, sectors };
}

const PATTERN_DISPLAY_MAX = 80;

const quote = (pattern: string): string =>
  `"${pattern.length > PATTERN_DISPLAY_MAX ? `${pattern.slice(0, PATTERN_DISPLAY_MAX)}…` : pattern}"`;

/**
 * States the rule and counts transactions, and never the category a row ended up in.
 * The pattern is quoted because the sentence outlives the sheet that holds the input.
 */
export function categoryRuleCaption(
  pattern: string,
  category: string,
  counts: CategoryRuleCounts,
): string {
  const { matches, overridden } = counts;
  const rule = `The rule sets ${categoryLabel(category)} for transactions whose description contains ${quote(pattern)}.`;
  if (matches === 0) {
    return `${rule} Nothing matches that text yet — the rule is saved and applies to transactions that arrive later.`;
  }
  const found = `${matches} transaction${matches === 1 ? ' matches' : 's match'} that text across every account, hidden ones included.`;
  if (overridden === 0) return `${rule} ${found}`;
  const kept =
    overridden === matches
      ? `${matches === 1 ? 'It keeps' : `All ${matches} keep`} a category you set by hand, which no rule changes.`
      : `${overridden} of them ${overridden === 1 ? 'keeps' : 'keep'} a category you set by hand, which no rule changes.`;
  return `${rule} ${found} ${kept}`;
}
