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
];

/** Category label; an unknown slug (or a free-form item label) is returned as-is. */
export const categoryLabel = (slug: string): string => CATEGORY_LABELS[slug] ?? slug;
