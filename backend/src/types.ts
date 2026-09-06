/**
 * 'upload' is the only value anything writes. The other two stay in the union because
 * rows carrying them exist, in databases that ran those integrations and in every
 * backup taken since, and narrowing it would make the compiler assert something false
 * about them.
 */
export type Provider = 'monobank' | 'enablebanking' | 'upload';

export interface Account {
  id: string;
  provider: Provider;
  name: string;
  currency: string;
  balance: number;
  iban?: string;
  /** Off the screen and out of the figures; the rows themselves stay. */
  hidden?: boolean;
}

export interface TransferRule {
  id: number;
  description: string;
  accountId: string;
  createdAt: string;
}

/** The id of a row in income_sources, seeded or the user's own. */
export type IncomeSource = string;

/** Kind of source: own = your own earnings, external = help from outside. */
export type IncomeSourceKind = 'own' | 'external';

export interface IncomeSourceDef {
  id: string;
  label: string;
  kind: IncomeSourceKind;
  patterns: string[];
  sort: number;
  /** seeded source: can't be deleted, automation is keyed on its id */
  builtin: boolean;
}

export interface Transaction {
  id: string;
  accountId: string;
  provider: Provider;
  /** decimal amount in the account's currency; spending < 0, income > 0 */
  amount: number;
  currency: string;
  /** ISO 8601 */
  date: string;
  description: string;
  mcc?: number;
  category: string;
  /** true — the category above was set by hand and no recompute will change it */
  categoryManual?: boolean;
  /** a transfer between the user's own accounts — neither income nor expense */
  transfer?: boolean;
  /** the user's manual flag; null — decided by auto-detection */
  transferManual?: boolean | null;
  /** refund / cancelled purchase: arrives positive, but subtracts from spending */
  refund?: boolean;
  /** amount in the base currency at that date's rate; absent = rate not fetched yet */
  baseAmount?: number;
  /** income source (income only) */
  incomeSource?: IncomeSource;
  incomeSourceManual?: boolean;
  /** detected, never set by hand */
  recurring?: boolean;
  /** set by hand; taken out of monthly spending and amortized instead */
  oneOff?: boolean;
  /**
   * The fee the statement stated for this operation, as it printed it (positive).
   * Absent on the way out and null on the way in — the source stated none; never a
   * zero this importer invented. `amount` is already net of it.
   */
  fee?: number | null;
}

/**
 * No id yet: it is a surrogate the data layer assigns, and nothing outside it
 * constructs one. dedupKey is where a format that carries its own stable reference to
 * an operation plugs in; absent, the key is computed instead.
 *
 * fee is required here and optional on Transaction, and that asymmetry is the point: a
 * parser that read a fee and a data layer that dropped it would differ only in the
 * database, where the confirmation screen has already shown the corrected net. Every
 * producer must say what the source stated, including that it stated nothing.
 */
export type NewTransaction = Omit<Transaction, 'id' | 'fee'> & {
  dedupKey?: string;
  fee: number | null;
};

/** Total for a category. The body carrying it names the currency, never this. */
export interface CategorySummary {
  category: string;
  total: number;
}

/** One month's totals, in the base currency. */
export interface MonthTotals {
  /** YYYY-MM */
  month: string;
  expense: number;
  expenseOneOff: number;
  income: number;
  /** income from your own sources (kind = own) */
  incomeOwn: number;
  /** help from external sources (kind = external) */
  incomeExternal: number;
}

/**
 * One month of an account's own transactions, in that account's currency.
 *
 * `net` is every row of the month summed, transfers included - the rule
 * recalcAccountBalanceFromTransactions computes a balance by, and the only reason the
 * months can be added up and compared with the balance printed beside them. That
 * comparison holds over a window covering the account's whole history: the balance has
 * no date filter, so over a shorter window the months add up to that window's movement
 * instead. income and expense exclude transfers, exactly as the figures over every account do.
 *
 * Not MonthTotals and not assignable to it: expenseOneOff, incomeOwn and incomeExternal
 * are independence figures and independence is a question about every account together,
 * so the compiler refuses a base-currency month where an account month is wanted.
 */
export interface AccountMonthTotals {
  /** YYYY-MM */
  month: string;
  income: number;
  expense: number;
  net: number;
}

export interface SummaryTotals {
  expense: number;
  income: number;
}

export interface IncomeSourceTotal {
  source: string;
  label: string;
  kind: IncomeSourceKind;
  total: number;
}

/**
 * Every account together, every amount in the base currency. `scope` is a literal
 * rather than a field that happens to be there, so reading an account body as this
 * one is a compile error. The literal is `all`, beside `account` on the per-account
 * bodies: one word each for the two scopes the wire answers.
 */
export interface Summary {
  scope: 'all';
  from: string;
  to: string;
  baseCurrency: string;
  totals: SummaryTotals;
  byCategory: CategorySummary[];
  incomeByCategory: CategorySummary[];
  incomeBySource: IncomeSourceTotal[];
}

/** One named account, every amount in that account's own currency. */
export interface AccountSummary {
  scope: 'account';
  from: string;
  to: string;
  accountId: string;
  currency: string;
  /**
   * The currencies among this account's rows that are not its own - all time, not the
   * window. Required rather than optional, because [] means "checked, and there are
   * none" where undefined means nobody looked.
   */
  otherCurrencies: string[];
  totals: SummaryTotals;
  byCategory: CategorySummary[];
  incomeByCategory: CategorySummary[];
  incomeBySource: IncomeSourceTotal[];
}

/** The "over the year" chart over every account, in the base currency. */
export interface MonthlySummary {
  scope: 'all';
  from: string;
  to: string;
  baseCurrency: string;
  months: MonthTotals[];
}

/** The same chart for one account, in that account's own currency. */
export interface AccountMonthlySummary {
  scope: 'account';
  from: string;
  to: string;
  accountId: string;
  currency: string;
  /** as on AccountSummary: all time, and [] is an answer */
  otherCurrencies: string[];
  months: AccountMonthTotals[];
}
