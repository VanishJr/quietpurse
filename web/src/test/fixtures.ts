import { SessionUser } from '../api';
import {
  Account,
  AppSettings,
  BudgetsResponse,
  CsvImportResult,
  ImportConfirmed,
  ImportRecord,
  ImportSummary,
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

export const USER: SessionUser = { id: 'u1', email: 'owner@example.com', name: 'Owner' };

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
  from: '2026-07-01',
  to: '2026-07-31',
  baseCurrency: 'EUR',
  totals: { expense: 0, income: 0 },
  byCategory: [],
  incomeByCategory: [],
  incomeBySource: [],
};

export const BUDGETS: BudgetsResponse = { baseCurrency: 'EUR', budgets: [] };

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
  threshold: 880,
  deficit: 0,
  selfSufficiency: 1,
  months: [],
  byCategory: [],
  hours: null,
};

export const PRESETS = { presets: [{ key: 'generic', title: 'Any statement' }] };

/** The fixed import id keeps `POST /api/imports/imp-1/confirm` a literal route key. */
export const IMPORT_ID = 'imp-1';

export const summaryResult = (patch: Partial<ImportSummary> = {}): CsvImportResult => ({
  outcome: 'awaiting_confirmation',
  summary: {
    importId: IMPORT_ID,
    accountId: 'acc-9',
    accountName: 'statement',
    accountExists: false,
    total: 14,
    accepted: 12,
    skipped: 0,
    problems: [],
    newRows: 12,
    alreadyPresent: 0,
    from: '2026-06-01',
    to: '2026-06-30',
    totals: [{ currency: 'EUR', net: -420.5 }],
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
  uploadedBy: USER.id,
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

export const IMPORTS = { imports: [importRecord()] };

export const DUPLICATE: CsvImportResult = {
  outcome: 'duplicate',
  importId: 'imp-0',
  accountId: 'acc-9',
  accountIds: ['acc-9'],
  uploadedAt: '2026-06-15T10:00:00.000Z',
  skipped: 0,
  total: 12,
};
