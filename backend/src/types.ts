/**
 * Where the data came from. 'upload' is a statement the user brought in, in any
 * format, and it is the only value anything writes: the direct bank integrations
 * were deleted (ROADMAP 5.4). 'monobank' and 'enablebanking' stay in the union
 * because rows carrying them exist — in databases that ran those integrations and
 * in every backup taken since — and narrowing it would make the compiler assert
 * something false about them.
 */
export type Provider = 'monobank' | 'enablebanking' | 'upload';

export interface Account {
  id: string;
  provider: Provider;
  name: string;
  currency: string;
  balance: number;
  iban?: string;
  /**
   * Account removed by the user: not shown, its transactions stay out of analytics.
   * The transactions remain in the database — the classifier still needs them as
   * the other leg of a transfer to a visible account.
   */
  hidden?: boolean;
}

/**
 * A "transactions like this are transfers between my own accounts" rule:
 * description + account. Applied to every past and future transaction on each
 * recompute. Needed where pair matching can't help: an outgoing "Sent from N26",
 * say, whose other leg isn't in the database (the money went to a bank that isn't
 * connected).
 */
export interface TransferRule {
  id: number;
  description: string;
  accountId: string;
  createdAt: string;
}

/**
 * Income source — the id of a row in income_sources ('salary', 'family', 'other',
 * plus your own: freelance, stipend...).
 */
export type IncomeSource = string;

/** Kind of source: own = your own earnings, external = help from outside. */
export type IncomeSourceKind = 'own' | 'external';

/** Income source definition (the income_sources table). */
export interface IncomeSourceDef {
  id: string;
  label: string;
  kind: IncomeSourceKind;
  /**
   * Names/phrases for auto-tagging: income whose description contains all the words
   * of one of the patterns gets this source (see classify.ts).
   */
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
  /** transfer between your own accounts — neither income nor expense */
  transfer?: boolean;
  /** the user's manual flag; null — decided by auto-detection */
  transferManual?: boolean | null;
  /** refund / cancelled purchase: arrives positive, but subtracts from spending */
  refund?: boolean;
  /** amount in the base currency at that date's rate; absent = rate not fetched yet */
  baseAmount?: number;
  /** income source (income only) */
  incomeSource?: IncomeSource;
  /** true = the income source was set manually */
  incomeSourceManual?: boolean;
  /** recurring payment (rent, subscription) — detected automatically */
  recurring?: boolean;
  /** one-off large purchase — amortized in average spending; set manually */
  oneOff?: boolean;
  /**
   * The fee the statement stated for this operation, as it printed it (positive).
   * Absent on the way out and null on the way in — the source stated none; never a
   * zero this importer invented. `amount` is already net of it.
   */
  fee?: number | null;
}

/**
 * A parsed transaction on its way into the database. It has no id yet: the id is
 * a surrogate assigned by insertTransactions, and nothing outside the data layer
 * constructs one.
 *
 * dedupKey is a source's own stable reference to the operation. No parser supplies
 * one today — an uploaded statement carries no such reference, so every key is
 * computed by insertTransactions — and the field is where a format that does carry
 * one plugs in (ROADMAP 5.2 names CAMT.053 and MT940).
 *
 * fee is required here and optional on Transaction, and that asymmetry is the point:
 * a parser that read a fee and a data layer that dropped it would differ only in the
 * database, where the confirmation screen has already shown the corrected net. Every
 * producer must say what the source stated, including that it stated nothing.
 */
export type NewTransaction = Omit<Transaction, 'id' | 'fee'> & {
  dedupKey?: string;
  fee: number | null;
};

/** Total for a category in the base currency. */
export interface CategorySummary {
  category: string;
  total: number;
}

/**
 * One month's totals in the base currency: a bar of the "over the year" chart and
 * an input to the independence calculation.
 */
export interface MonthTotals {
  /** YYYY-MM */
  month: string;
  expense: number;
  /** the share of spending flagged as one-off */
  expenseOneOff: number;
  income: number;
  /** income from your own sources (kind = own) */
  incomeOwn: number;
  /** help from external sources (kind = external): family, stipend... */
  incomeExternal: number;
}

/** Every amount is in the base currency (baseCurrency). */
export interface Summary {
  from: string;
  to: string;
  baseCurrency: string;
  totals: { expense: number; income: number };
  /** spending by category (net: refunds subtracted) */
  byCategory: CategorySummary[];
  /** income by category */
  incomeByCategory: CategorySummary[];
  /** income by source (id + label + kind from income_sources) */
  incomeBySource: { source: string; label: string; kind: IncomeSourceKind; total: number }[];
}
