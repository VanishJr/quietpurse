import { CategoryRuleCounts } from './types';

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
