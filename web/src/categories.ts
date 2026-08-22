import { CategoryRuleCounts, CategorySummary } from './types';

/**
 * Category dictionary: the API returns stable slugs, the human-readable names
 * live here only. For i18n this dictionary becomes translation keys and the API
 * doesn't have to change.
 */
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
  cashback: 'Cashback',
  other: 'Other',
  // pseudo-category on the Goal screen: amortized one-off purchases
  'one-off-avg': 'One-off (avg)',
};

/** App categories (slugs, order = order in the picker). */
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
  'cashback',
  'other',
] as const;

/**
 * A slug the picker can actually send. Not Transaction.category, which stays a string:
 * rows carry whatever the backend classified them as.
 */
export type Category = (typeof CATEGORIES)[number];

/** Category label; an unknown slug (or a free-form item label) is returned as-is. */
export const categoryLabel = (slug: string): string => CATEGORY_LABELS[slug] ?? slug;

/** A category as the Overview's ring draws it: the summary, plus the name a person reads. */
export interface SpendSector extends CategorySummary {
  label: string;
}

/**
 * The sectors of the Overview's ring.
 *
 * Only the positive categories: a refund can push one below zero — the purchase it
 * reverses was in an earlier month — and there is no such thing as a negative sector.
 * That is also why the figure in the hole is the month's expense total and not the sum
 * of these; `SpendingByCategory.tsx`'s header is where that is settled.
 *
 * The labelling is here rather than in the component because recharts looks `nameKey`
 * up on the datum and never checks it: a ring whose sectors carry only the slug prints
 * `food` at the reader when they point at one, and nothing but a case can say so.
 */
export const spendSectors = (spend: CategorySummary[]): SpendSector[] =>
  spend
    .filter((c) => c.total > 0)
    .map((c) => ({ ...c, label: categoryLabel(c.category) }));

const PATTERN_DISPLAY_MAX = 80;

const quote = (pattern: string): string =>
  `"${pattern.length > PATTERN_DISPLAY_MAX ? `${pattern.slice(0, PATTERN_DISPLAY_MAX)}…` : pattern}"`;

/**
 * What a category rule just did, from the pair of counts the backend answers with, and
 * the only reader of either of them.
 *
 * It states the rule and counts transactions, and never the category a row ended up
 * in. Two things make that claim false: `overridden` counts a hand-set row whatever
 * the hand-set value was, so a row already set to this rule's category is in it; and a
 * newer overlapping rule keeps rows this one matched, because the classifier takes the
 * first match over rules ordered newest-first and an upsert leaves createdAt alone.
 *
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
