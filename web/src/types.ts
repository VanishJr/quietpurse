// Mirror of backend/src/types.ts

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
  lastSyncedAt?: string;
  /** how far back the account's history is already loaded (ISO) */
  historyFrom?: string;
  /** account removed: not shown, not counted in analytics, not synced */
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

export interface SyncStatus {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  log: string[];
  /** "data current as of …" — end of the last successful run */
  freshAsOf: string | null;
  /** expired bank sessions and errors from the last run — shown on screen */
  problems: string[];
}

/** One sync run from the journal (sync_log table). */
export interface SyncJournalRun {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  ok: boolean | null;
  inserted: number;
  errors: string[];
  log: string[];
}

/** App settings (the settings table). */
export interface AppSettings {
  baseCurrency: string;
  ownerNames: string[];
  syncIntervalMin: number;
}

export interface OnboardingStatus {
  /** true = no accounts — show the first-run wizard */
  needed: boolean;
  accounts: number;
  settings: AppSettings;
  providers: {
    monobank: { configured: boolean };
    enablebanking: { configured: boolean; sessions: number };
    csv: { configured: boolean };
  };
}

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
