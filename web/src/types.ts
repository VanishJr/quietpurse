// Mirror of backend/src/types.ts

/**
 * 'upload' is the only value the backend writes — the direct bank integrations were
 * deleted. The other two stay because rows carrying them still exist, and narrowing
 * the union would make the compiler assert something false about them.
 */
export type Provider = 'monobank' | 'enablebanking' | 'upload';

/** Income source — id from the income_sources table (salary/family/other + custom). */
export type IncomeSource = string;

/** Source kind: own = your own earnings, external = help from outside. */
export type IncomeSourceKind = 'own' | 'external';

/** Income source definition (catalog at /api/income-sources). */
export interface IncomeSourceDef {
  id: string;
  label: string;
  kind: IncomeSourceKind;
  /** names/phrases that auto-tag income with this source */
  patterns: string[];
  sort: number;
  /** seeded source — cannot be deleted */
  builtin: boolean;
}

export interface Account {
  id: string;
  provider: Provider;
  name: string;
  currency: string;
  balance: number;
  iban?: string;
  /** account removed: not shown, not counted in analytics */
  hidden?: boolean;
}

/** "Every transaction like this is a transfer": a rule by description + account. */
export interface TransferRule {
  id: number;
  description: string;
  accountId: string;
  createdAt: string;
  /** how many transactions the rule covers */
  matches: number;
}

/** "Description contains X -> category Y": a rule created from the app. */
export interface CategoryRule {
  id: number;
  pattern: string;
  category: string;
  createdAt: string;
  matches: number;
}

export interface Transaction {
  id: string;
  accountId: string;
  provider: Provider;
  amount: number;
  currency: string;
  date: string;
  description: string;
  mcc?: number;
  category: string;
  /** transfer between own accounts — neither income nor expense */
  transfer: boolean;
  /** manual override; null — the flag was decided by auto-detection */
  transferManual: boolean | null;
  /** purchase refund: comes in positive but is subtracted from expenses */
  refund: boolean;
  /** amount in the base currency at the transaction date's rate; absent = rate not fetched yet */
  baseAmount?: number;
  /** income source (income transactions only) */
  incomeSource?: IncomeSource;
  /** true = income source set manually */
  incomeSourceManual?: boolean;
  /** recurring payment (rent, subscription) — auto-detected */
  recurring?: boolean;
  /** one-off large purchase (amortized into average spending) — set manually */
  oneOff?: boolean;
}

/**
 * "All transactions" on the Overview, asking the Transactions screen for one account.
 *
 * The nonce is what makes it an event rather than a setting: the screens all stay
 * mounted and keep their own filters, so a second click on the same account would
 * otherwise carry the same value and change nothing — after the user had narrowed the
 * filter by hand in between, which is exactly when they would click it again.
 *
 * Here rather than in SignedIn.tsx so that the screen reading it does not have to
 * import the module that renders it.
 */
export interface TxFocus {
  accountId: string;
  nonce: number;
}

/** Category total in the base currency. */
export interface CategorySummary {
  category: string;
  total: number;
}

/** All amounts in the base currency. Transfers excluded, refunds subtracted. */
export interface Summary {
  from: string;
  to: string;
  baseCurrency: string;
  totals: { expense: number; income: number };
  byCategory: CategorySummary[];
  incomeByCategory: CategorySummary[];
  incomeBySource: { source: string; label: string; kind: IncomeSourceKind; total: number }[];
}

/** One month's totals in the base currency. */
export interface MonthTotals {
  /** YYYY-MM */
  month: string;
  expense: number;
  /** part of expenses flagged as one-off (one_off) */
  expenseOneOff: number;
  income: number;
  /** income from own sources (kind = own) */
  incomeOwn: number;
  /** help from external sources (kind = external) */
  incomeExternal: number;
}

export interface MonthlySummary {
  from: string;
  to: string;
  baseCurrency: string;
  months: MonthTotals[];
}

/** App settings (the settings table). */
export interface AppSettings {
  baseCurrency: string;
  ownerNames: string[];
}

/**
 * Why an opening/closing pair is missing from a summary whose file does state a
 * running balance. A slug, like every other vocabulary the API sends: the sentences
 * live in the client dictionary (see BALANCES_NOT_SHOWN in CsvImport).
 */
export type BalancesNotShown =
  | 'rows-outside-the-balance'
  | 'rows-without-a-balance'
  | 'balance-closes-on-itself'
  | 'more-than-one-currency';

/**
 * How many running balances a derived pair was summed from, and how many of those the
 * backend's check could have failed on. A run of one row states one balance and has no
 * second one to agree with, so nothing about it was compared — which is what separates
 * "checked" from "summed" and is the only reason both numbers are sent.
 *
 * Nested, so a pair carries both or is not a derived pair. Hand-written against
 * providers/statement.ts like the rest of this file.
 */
export type SeriesCounts = { summed: number; checked: number };

/** date, amount and description: the three slots every reader fills, and no others. */
export interface ReadColumns {
  date: string;
  amount: string;
  description: string[];
}

/**
 * Which reader the backend used, and what it filled the columns from. A discriminated
 * union and not a name plus optionals: a preset has a slug and a title, a PDF layout
 * has a title and no columns at all, and two states that are not the same must not be
 * spelled the same way.
 *
 * Hand-written against providers/statement.ts, and nothing checks the two are in step —
 * see readAsSentence, whose fallback exists for the day one of them is edited alone.
 */
export type ReadAs =
  | { kind: 'preset'; preset: string; title: string; columns: ReadColumns }
  | { kind: 'auto-detected'; columns: ReadColumns }
  | { kind: 'request-mapping'; columns: ReadColumns }
  | { kind: 'pdf-template'; title: string };

/**
 * What an uploaded statement was read as, for the user to accept or reject. None of
 * it is in the database yet — the rows are staged on the backend and become data
 * only when the import is confirmed.
 */
export interface ImportSummary {
  importId: string;
  /** where the rows will go: the derived id, the name as typed, and whether it exists */
  accountId: string;
  accountName: string;
  accountExists: boolean;
  /** data rows in the file */
  total: number;
  /** rows that could be read */
  accepted: number;
  /** rows the parser could not use */
  skipped: number;
  problems: string[];
  /**
   * Of `accepted`, how many are not already in the database. A snapshot: another
   * import landing in between can take one of these, which is why the confirmed
   * panel reads its own number rather than repeating this one.
   */
  newRows: number;
  alreadyPresent: number;
  /** YYYY-MM-DD */
  from: string;
  to: string;
  /** net movement per currency: a file with a currency column carries more than one */
  totals: { currency: string; net: number }[];
  /**
   * Which reader filled the date, amount and description columns, and what it filled
   * them from — the one thing the counts above cannot say. Required, so a summary that
   * names no reader is a compile error rather than a card with a paragraph missing.
   *
   * Only those three slots. A request can also supply the date format, the decimal
   * separator and a status filter, and none of them is reported here.
   */
  readAs: ReadAs;
  /**
   * The statement's own opening and closing balance, which the backend checked these
   * rows against — printed by the document for a PDF, derived from the running
   * balance a CSV or Excel file prints per row. Never a check that failed: a break
   * is refused, so no summary is sent for one.
   *
   * `series` is which running balances the pair was summed from — how many, and how
   * many of those were checked by anything — and it is absent exactly when the
   * document printed the pair itself. So it says three things at once and all of them
   * decide the sentence: whether the numbers are a sum the user will not find in any
   * cell, which of the two checks was run, and how much of the pair it reached.
   */
  balances?: { opening: number; closing: number; currency: string; series?: SeriesCounts };
  /**
   * Why no pair is shown for a file that DOES state a running balance. Absent
   * together with `balances` means the format states none, and the two must not read
   * the same — a file that never claimed to carry a balance gets no line at all.
   */
  balancesNotShown?: BalancesNotShown;
  /** an earlier upload of these same bytes was waiting, and has been discarded */
  supersededImportId?: string;
}

/**
 * An upload imports nothing. Either these bytes are already in the database, or
 * there is a summary to confirm — and the union is what stops a summary being
 * rendered for a duplicate, or an "imported N" line for something that has not been.
 */
export type CsvImportResult =
  | {
      outcome: 'duplicate';
      importId: string;
      accountId: string;
      accountIds: string[];
      uploadedAt: string;
      skipped: number;
      total: number;
    }
  | { outcome: 'awaiting_confirmation'; summary: ImportSummary };

/** What actually landed. `inserted` is the backend's own count, not the preview's. */
export interface ImportConfirmed {
  importId: string;
  accountId: string;
  accountIds: string[];
  inserted: number;
  skipped: number;
  total: number;
}

/** See the status comment in backend/src/db/schema.ts: each value promises something different. */
export type ImportStatus =
  | 'pending'
  | 'awaiting_confirmation'
  | 'committed'
  | 'failed'
  | 'discarded';

/** Mirror of ImportSourceType in backend/src/db/index.ts. */
export type ImportSourceType = 'csv' | 'xlsx' | 'pdf';

/** One row of GET /api/imports — mirror of ImportRecord in backend/src/db/index.ts. */
export interface ImportRecord {
  id: string;
  fileHash: string;
  sourceType: ImportSourceType;
  originalFilename: string | null;
  /** what the upload asked for — NULL before the parse and on every older row */
  accountName: string | null;
  /**
   * The account the rows went to, resolved at staging. NULL wherever accountName is.
   * It, and not the name, is what says where they landed: a rename moves the account
   * and leaves this row's accountName behind — which is why the per-account import
   * history filters on this and never on the name.
   */
  accountId: string | null;
  uploadedBy: string | null;
  uploadedAt: string;
  parserVersion: number;
  status: ImportStatus;
  /** rows the parser accepted / could not use */
  rowsAccepted: number;
  rowsRejected: number;
  errorDetail: string | null;
  /** transactions this import still owns, which is not rowsAccepted: a row an
      earlier import already wrote belongs to that one */
  transactions: number;
  /**
   * Whether a document can be READ for this row, which is not whether bytes exist:
   * a restored row has its pointer stripped while its statement is still on disk.
   */
  documentAvailable: boolean;
}

// ---------- recurring payments ----------

export interface RecurringGroup {
  description: string;
  category: string;
  months: number;
  count: number;
  avgAmount: number;
  /** what the group costs per month (base currency) */
  monthlyAvg: number;
  lastDate: string;
  /** hidden by the user: excluded from the list and the monthly total */
  ignored: boolean;
}

export interface RecurringSummary {
  baseCurrency: string;
  monthlyTotal: number;
  groups: RecurringGroup[];
}

// ---------- independence ----------

export interface Settings {
  bufferPct: number;
  windowMonths: number;
  hourlyRate: number | null;
  hoursCapPerWeek: number;
  /** what to compute the threshold from: the bare minimum or the median of all spending */
  goalMode: GoalMode;
}

/** What the threshold is built from — see the header of IndependenceScreen.tsx. */
export type GoalMode = 'baseline' | 'lifestyle';

/** A baseline minimum line item. */
export interface BaselineItem {
  id: number;
  label: string;
  monthly: number;
  sort: number;
}

export interface IndependenceMonth {
  month: string;
  spend: number;
  ownIncome: number;
  /** help from external sources (kind = external) */
  external: number;
}

export interface Independence {
  baseCurrency: string;
  settings: Settings;
  from: string;
  to: string;
  /** median of monthly spending over the window (one-offs amortized) */
  avgSpend: number;
  oneOffMonthly: number;
  ownIncomeAvg: number;
  /** average help from external sources over the window */
  externalAvg: number;
  /** sum of the baseline minimum line items (before the buffer) */
  baselineSum: number;
  baselineItems: BaselineItem[];
  /** bare minimum + buffer */
  baselineThreshold: number;
  /** median spending + buffer — the price of the current lifestyle */
  lifestyleThreshold: number;
  /** active threshold: depends on settings.goalMode */
  threshold: number;
  deficit: number;
  /** own income / active mode's base */
  selfSufficiency: number;
  months: IndependenceMonth[];
  byCategory: CategorySummary[];
  hours: {
    hourlyRate: number;
    extraHoursPerMonth: number;
    totalHoursPerMonth: number;
    capPerMonth: number;
    capExceeded: boolean;
  } | null;
}

// ---------- budgets ----------

export interface Budget {
  category: string;
  monthly: number;
  spent: number;
  /** linear forecast of the category's spending to the end of the month */
  forecast: number;
}

export interface BudgetsResponse {
  baseCurrency: string;
  budgets: Budget[];
}

export interface BaselineResponse {
  baseCurrency: string;
  items: BaselineItem[];
  total: number;
}
