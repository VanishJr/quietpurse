import {
  Account,
  AccountMonthlySummary,
  AccountSummary,
  AppSettings,
  BudgetsResponse,
  CsvImportResult,
  ImportConfirmed,
  ImportList,
  ImportRecord,
  ImportSummary,
  ImportTotals,
  Independence,
  IncomeSourceDef,
  RecurringSummary,
  Summary,
  Transaction,
  TransferRule,
} from '../types';

/**
 * Response bodies for the route tables, declared with the client's own types: when
 * types.ts drifts from what the tests assume, tsc fails here rather than a screen
 * quietly rendering a shape the backend no longer sends.
 */

export const APP_SETTINGS: AppSettings = { baseCurrency: 'EUR', ownerNames: ['Yurii Kalvenko'] };

export const ACCOUNTS: Account[] = [
  {
    id: 'acc-1',
    provider: 'upload',
    name: 'Sparkasse Giro',
    currency: 'EUR',
    balance: 1234.5,
  },
  {
    id: 'acc-2',
    provider: 'upload',
    name: 'Old DKB',
    currency: 'EUR',
    balance: -20,
    hidden: true,
  },
];

export const RECURRING: RecurringSummary = {
  baseCurrency: 'EUR',
  monthlyTotal: 0,
  groups: [],
};

export const TRANSFER_RULES: TransferRule[] = [];
export const INCOME_SOURCES: IncomeSourceDef[] = [];
export const TRANSACTIONS: Transaction[] = [];

/**
 * byCategory stays empty so no chart mounts: recharts renders into a 0x0 jsdom box
 * and complains about it on stderr, and chasing that is not this suite's business.
 */
export const SUMMARY: Summary = {
  scope: 'all',
  from: '2026-07-01',
  to: '2026-07-31',
  baseCurrency: 'EUR',
  totals: { expense: 0, income: 0 },
  byCategory: [],
  incomeByCategory: [],
  incomeBySource: [],
};

/**
 * The account arm of the same two endpoints, built around the id the request named.
 *
 * The id is a parameter and not a constant because api.ts refuses a body answering
 * about a different account than the one asked for — which is the whole point of the
 * check — so a fixed fixture would be a refusal in every test that loads a second
 * account. `askedFor` in the harness is what reads it off the URL.
 *
 * byCategory stays empty by default for the reason SUMMARY's does: a non-empty one
 * mounts the donut, and recharts measures a 0x0 box in jsdom.
 */
export const accountSummary = (
  accountId: string,
  patch: Partial<AccountSummary> = {},
): AccountSummary => ({
  scope: 'account',
  from: '2026-08-01',
  to: '2026-08-31',
  accountId,
  currency: 'EUR',
  otherCurrencies: [],
  totals: { expense: 0, income: 0 },
  byCategory: [],
  incomeByCategory: [],
  incomeBySource: [],
  ...patch,
});

export const accountMonths = (
  accountId: string,
  patch: Partial<AccountMonthlySummary> = {},
): AccountMonthlySummary => ({
  scope: 'account',
  from: '2026-03-01',
  to: '2026-08-31',
  accountId,
  currency: 'EUR',
  otherCurrencies: [],
  months: [],
  ...patch,
});

export const BUDGETS: BudgetsResponse = { baseCurrency: 'EUR', budgets: [] };

/**
 * A database that has never saved a chart, which is what the charts route answers a
 * first start with. Version 0 AND an empty list is also the migration's trigger, so a
 * test that seeds `finto.analytics.charts` against this fixture gets a PUT.
 */
export const NO_CHARTS = { version: 0, charts: [] };

export const INDEPENDENCE: Independence = {
  baseCurrency: 'EUR',
  settings: {
    bufferPct: 10,
    windowMonths: 6,
    hourlyRate: null,
    hoursCapPerWeek: 40,
    goalMode: 'baseline',
  },
  from: '2026-01-01',
  to: '2026-07-31',
  avgSpend: 1000,
  oneOffMonthly: 0,
  ownIncomeAvg: 900,
  externalAvg: 0,
  baselineSum: 800,
  baselineItems: [],
  baselineThreshold: 880,
  lifestyleThreshold: 1100,
  effectiveMode: 'baseline',
  threshold: 880,
  deficit: 0,
  selfSufficiency: 1,
  months: [],
  byCategory: [],
  hours: null,
};

/**
 * `revolut` is here so one case can assert that the title the summary names and the
 * label the chip renders are the same string, rather than claiming it. Nothing else in
 * web/ asserts the chip set, so the cost is one extra chip in tests that ignore chips.
 *
 * `generic` carries the backend's own long title and not GENERIC_PRESET_TITLE: the chip
 * a user sees online reads the parenthetical, and a fixture spelling the short form is
 * the reason no case here could see that the two differ.
 */
export const PRESETS = {
  presets: [
    {
      key: 'generic',
      title: 'Any statement (auto-detect the date, amount and description columns)',
    },
    { key: 'revolut', title: 'Revolut (Statement CSV)' },
  ],
};

/** The fixed import id keeps `POST /api/imports/imp-1/confirm` a literal route key. */
export const IMPORT_ID = 'imp-1';

export const summaryResult = (patch: Partial<ImportSummary> = {}): CsvImportResult => ({
  outcome: 'awaiting_confirmation',
  summary: {
    importId: IMPORT_ID,
    accountId: 'acc-9',
    accountName: 'statement',
    total: 14,
    accepted: 12,
    skipped: 0,
    unreadable: 0,
    filtered: 0,
    noMovement: 0,
    problems: [],
    newRows: 12,
    alreadyPresent: 0,
    from: '2026-06-01',
    to: '2026-06-30',
    totals: [{ currency: 'EUR', net: -420.5 }],
    // the arm the component's own default chip ('generic') produces, so every case
    // that does not patch it renders the one a real upload from this screen would
    readAs: {
      kind: 'auto-detected',
      columns: { date: 'Datum', amount: 'Betrag', description: ['Verwendungszweck'] },
    },
    ...patch,
  },
});

export const CONFIRMED: ImportConfirmed = {
  importId: IMPORT_ID,
  accountId: 'acc-9',
  accountIds: ['acc-9'],
  inserted: 12,
  skipped: 0,
  total: 12,
};

/**
 * A row of GET /api/imports: a plain committed import whose file is still stored.
 * Patched a field at a time, so each test says which one it is about.
 */
export const importRecord = (patch: Partial<ImportRecord> = {}): ImportRecord => ({
  id: IMPORT_ID,
  fileHash: 'f1e2d3c4',
  sourceType: 'csv',
  originalFilename: 'statement.csv',
  accountName: 'Sparkasse Giro',
  accountId: 'acc-1',
  uploadedAt: '2026-06-15T10:00:00.000Z',
  parserVersion: 1,
  status: 'committed',
  rowsAccepted: 12,
  rowsRejected: 0,
  errorDetail: null,
  transactions: 12,
  documentAvailable: true,
  ...patch,
});

/**
 * GET /api/imports. The default totals are DERIVED from the records, so the whole
 * page is the default case and a short page is something a test says on purpose.
 * Deriving a total from a page is exactly what the client may never do — here it is
 * what makes a mismatch a statement rather than a typo.
 */
export const importsResponse = (
  records: ImportRecord[] = [importRecord()],
  totals: Partial<ImportTotals> = {},
): ImportList => ({
  imports: records,
  totals: {
    imports: records.length,
    documents: records.filter((r) => r.documentAvailable).length,
    transactions: records.reduce((n, r) => n + r.transactions, 0),
    ...totals,
  },
});

export const IMPORTS = importsResponse();

export const DUPLICATE: CsvImportResult = {
  outcome: 'duplicate',
  importId: 'imp-0',
  accountId: 'acc-9',
  accountIds: ['acc-9'],
  uploadedAt: '2026-06-15T10:00:00.000Z',
  skipped: 0,
  total: 12,
};
