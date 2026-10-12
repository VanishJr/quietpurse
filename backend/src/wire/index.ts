import { z } from 'zod';
import {
  goalCreateSchema,
  goalDeletedSchema,
  goalDetailSchema,
  goalListSchema,
  goalUpdateSchema,
} from './goals';
import { currencyKey, currencySchema } from './currency';

export * from './currency';
export * from './goals';

/**
 * 'upload' is the only value anything writes. The other two stay in the union because
 * rows carrying them exist, in databases that ran those integrations and in every
 * backup taken since, and narrowing it would make the compiler assert something false
 * about them.
 */
export const PROVIDERS = ['monobank', 'enablebanking', 'upload'] as const;
export const IMPORT_SOURCE_TYPES = ['csv', 'xlsx', 'pdf'] as const;
export const IMPORT_STATUSES = [
  'pending',
  'awaiting_confirmation',
  'committed',
  'failed',
  'discarded',
] as const;
/** Kind of source: own = your own earnings, external = help from outside. */
export const INCOME_SOURCE_KINDS = ['own', 'external'] as const;
/**
 * Why no opening/closing pair is shown for a file that DOES state a running balance.
 * Absent together with `balances` means the format states none. The two must not
 * spell the same, because a third state exists: a preset declared a balance column, it
 * resolved, and the check could not be completed.
 */
export const BALANCES_NOT_SHOWN = [
  'rows-outside-the-balance',
  'rows-without-a-balance',
  'balance-closes-on-itself',
  'more-than-one-currency',
] as const;

export const CHART_KINDS = ['line', 'column', 'area', 'donut', 'ranking', 'radar'] as const;
export const CHART_RANGES = ['3m', '6m', '12m', '24m', '3y', '5y'] as const;
export const CHART_BREAKDOWNS = [
  'expense-categories',
  'income-categories',
  'income-sources',
] as const;
export const CHART_METRICS = ['income', 'expense', 'net'] as const;

export const CHARTS_MAX = 100;
export const CHART_TITLE_MAX = 120;
export const CHART_ID_MAX = 64;
export const CHART_ACCOUNT_ID_MAX = 64;
export const CHART_ID_SHAPE_SOURCE = '^[A-Za-z0-9._~-]+$';
export const CHART_ID_SHAPE = new RegExp(CHART_ID_SHAPE_SOURCE);

export const ERROR_DETAIL_MAX = 500;

export type ChartKind = (typeof CHART_KINDS)[number];
export type ChartRange = (typeof CHART_RANGES)[number];
export type ChartBreakdown = (typeof CHART_BREAKDOWNS)[number];
export type ChartMetric = (typeof CHART_METRICS)[number];

export const providerSchema = z.enum(PROVIDERS);
export type Provider = z.infer<typeof providerSchema>;
export const importSourceTypeSchema = z.enum(IMPORT_SOURCE_TYPES);
export type ImportSourceType = z.infer<typeof importSourceTypeSchema>;
export const importStatusSchema = z.enum(IMPORT_STATUSES);
export type ImportStatus = z.infer<typeof importStatusSchema>;
export const incomeSourceKindSchema = z.enum(INCOME_SOURCE_KINDS);
export type IncomeSourceKind = z.infer<typeof incomeSourceKindSchema>;
export const balancesNotShownSchema = z.enum(BALANCES_NOT_SHOWN);
export type BalancesNotShown = z.infer<typeof balancesNotShownSchema>;

export const SUPPORT_INCOME_SOURCE = 'category:support';

/** A configured source id, or the read-only source derived from the Support category. */
export const incomeSourceSchema = z.string();
export type IncomeSource = z.infer<typeof incomeSourceSchema>;

export const accountSchema = z.strictObject({
  id: z.string(),
  provider: providerSchema,
  name: z.string(),
  currency: currencySchema,
  balance: z.number(),
  iban: z.string().optional(),
  hidden: z.boolean(),
});
export type Account = z.infer<typeof accountSchema>;

export const accountDeletedSchema = z.strictObject({
  deleted: z.literal(true),
  transactions: z.number(),
  imports: z.number(),
  documents: z.number(),
});
export type AccountDeleted = z.infer<typeof accountDeletedSchema>;

/**
 * A day off a statement, not a moment: its first ten characters are the YYYY-MM-DD the
 * bank wrote, and whatever follows them is never read through a `Date`.
 */
export const calendarDaySchema = z.string().brand<'CalendarDay'>();
export type CalendarDay = z.infer<typeof calendarDaySchema>;

/**
 * null unless the value is a YYYY-MM-DD that is a day on the calendar, alone or followed by a
 * time that day has, written as `toISOString` writes one.
 */
export const calendarDay = (value: string): CalendarDay | null => {
  const bare = value.length === 10;
  const date = new Date(bare ? `${value}T00:00:00.000Z` : value);
  if (Number.isNaN(date.getTime())) return null;
  // compared back, because Date rolls 2026-02-30 into March and 24:00 into the next day
  // rather than refusing them
  const written = date.toISOString();
  return (bare ? written.slice(0, 10) : written) === value ? (value as CalendarDay) : null;
};

export const instantSchema = z.string().brand<'Instant'>();
export type Instant = z.infer<typeof instantSchema>;
export const instant = (value: string): Instant => value as Instant;

export const transactionSchema = z.strictObject({
  id: z.string(),
  accountId: z.string(),
  provider: providerSchema,
  /** decimal amount in this row's `currency`; spending < 0, income > 0 */
  amount: z.number(),
  currency: currencySchema,
  /** ISO 8601 */
  date: calendarDaySchema,
  description: z.string(),
  mcc: z.number().optional(),
  displayDescription: z.string().optional(),
  valueDate: calendarDaySchema.optional(),
  category: z.string(),
  /** true: the category above was set by hand and no recompute will change it */
  categoryManual: z.boolean(),
  /** a transfer between the user's own accounts: neither income nor expense */
  transfer: z.boolean(),
  /** the user's manual flag; null = auto-detection decides */
  transferManual: z.boolean().nullable(),
  /** refund / cancelled purchase: arrives positive, but subtracts from spending */
  refund: z.boolean(),
  /** amount in the base currency at that date's rate; absent = rate not fetched yet */
  baseAmount: z.number().optional(),
  /** income source (income only) */
  incomeSource: incomeSourceSchema.optional(),
  incomeSourceManual: z.boolean(),
  /** detected, never set by hand */
  recurring: z.boolean(),
  /** set by hand; taken out of monthly spending and amortized instead */
  oneOff: z.boolean(),
  /**
   * The fee the statement stated for this operation, as it printed it (positive).
   * Absent on the way out and null on the way in: the source stated none, never a
   * zero this importer invented. `amount` is already net of it.
   */
  fee: z.number().optional(),
});
export type Transaction = z.infer<typeof transactionSchema>;

export const TRANSFER_RULE_MATCH_MODES = ['exact', 'similar-v1'] as const;

export const transferRuleSchema = z.strictObject({
  id: z.number(),
  description: z.string(),
  accountId: z.string(),
  matchMode: z.enum(TRANSFER_RULE_MATCH_MODES),
  createdAt: z.string(),
});
export type TransferRule = z.infer<typeof transferRuleSchema>;
export const transferRuleWithMatchesSchema = transferRuleSchema.extend({ matches: z.number() });
export type TransferRuleWithMatches = z.infer<typeof transferRuleWithMatchesSchema>;
export const transferRuleCreatedSchema = z.strictObject({
  rule: transferRuleSchema,
  matches: z.number(),
});
export type TransferRuleCreated = z.infer<typeof transferRuleCreatedSchema>;

export const transferRulePreviewSchema = z.strictObject({
  txId: z.string(),
  accountId: z.string(),
  description: z.string(),
  transactions: z.array(transactionSchema),
  matches: z.number(),
  manualOverrides: z.number(),
  activeRule: transferRuleSchema.nullable(),
  previewToken: z.string(),
});
export type TransferRulePreview = z.infer<typeof transferRulePreviewSchema>;

export const incomeSourceDefSchema = z.strictObject({
  id: z.string(),
  label: z.string(),
  kind: incomeSourceKindSchema,
  patterns: z.array(z.string()),
  sort: z.number(),
  builtin: z.boolean(),
});
export type IncomeSourceDef = z.infer<typeof incomeSourceDefSchema>;

/** Total for a category. The body carrying it names the currency, never this. */
export const categorySummarySchema = z.strictObject({
  category: z.string(),
  total: z.number(),
});
export type CategorySummary = z.infer<typeof categorySummarySchema>;

export const summaryTotalsSchema = z.strictObject({
  expense: z.number(),
  income: z.number(),
});
export type SummaryTotals = z.infer<typeof summaryTotalsSchema>;

export const incomeSourceTotalSchema = z.strictObject({
  source: z.string(),
  label: z.string(),
  kind: incomeSourceKindSchema,
  total: z.number(),
});
export type IncomeSourceTotal = z.infer<typeof incomeSourceTotalSchema>;

/**
 * The currencies among this account's rows that are not its own, over all time rather
 * than the window.
 */
const otherCurrenciesSchema = z.array(currencySchema);

export const summarySchema = z.strictObject({
  scope: z.literal('all'),
  from: z.string(),
  to: z.string(),
  baseCurrency: currencySchema,
  totals: summaryTotalsSchema,
  byCategory: z.array(categorySummarySchema),
  incomeByCategory: z.array(categorySummarySchema),
  incomeBySource: z.array(incomeSourceTotalSchema),
});
export type Summary = z.infer<typeof summarySchema>;

export const accountSummarySchema = z.strictObject({
  scope: z.literal('account'),
  from: z.string(),
  to: z.string(),
  accountId: z.string(),
  currency: currencySchema,
  otherCurrencies: otherCurrenciesSchema,
  totals: summaryTotalsSchema,
  byCategory: z.array(categorySummarySchema),
  incomeByCategory: z.array(categorySummarySchema),
  incomeBySource: z.array(incomeSourceTotalSchema),
});
export type AccountSummary = z.infer<typeof accountSummarySchema>;

/** One month's totals, in the base currency. */
export const monthTotalsSchema = z.strictObject({
  /** YYYY-MM */
  month: z.string(),
  expense: z.number(),
  expenseOneOff: z.number(),
  income: z.number(),
  incomeOwn: z.number(),
  incomeExternal: z.number(),
});
export type MonthTotals = z.infer<typeof monthTotalsSchema>;

/**
 * One month of an account's own transactions, labelled with the account's currency.
 * A row in another currency is summed in as it is, and `otherCurrencies` on the body
 * names every such currency.
 *
 * `net` is every row of the month summed, transfers included. That is the rule
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
export const accountMonthTotalsSchema = z.strictObject({
  /** YYYY-MM */
  month: z.string(),
  income: z.number(),
  expense: z.number(),
  net: z.number(),
});
export type AccountMonthTotals = z.infer<typeof accountMonthTotalsSchema>;

export const monthlySummarySchema = z.strictObject({
  scope: z.literal('all'),
  from: z.string(),
  to: z.string(),
  baseCurrency: currencySchema,
  months: z.array(monthTotalsSchema),
});
export type MonthlySummary = z.infer<typeof monthlySummarySchema>;

export const accountMonthlySummarySchema = z.strictObject({
  scope: z.literal('account'),
  from: z.string(),
  to: z.string(),
  accountId: z.string(),
  currency: currencySchema,
  otherCurrencies: otherCurrenciesSchema,
  months: z.array(accountMonthTotalsSchema),
});
export type AccountMonthlySummary = z.infer<typeof accountMonthlySummarySchema>;

/**
 * One saved chart, as both routes carry it: the dock's order is array position, so `sort`
 * is not on this type. It IS in a downloaded backup, which selects the columns rather than
 * this shape. So say "not on the charts API", never "never leaves".
 */
export const chartSchema = z.strictObject({
  id: z.string(),
  kind: z.enum(CHART_KINDS),
  title: z.string(),
  accountId: z.string().nullable(),
  metrics: z.array(z.enum(CHART_METRICS)),
  breakdown: z.enum(CHART_BREAKDOWNS),
  range: z.enum(CHART_RANGES),
});
export type Chart = z.infer<typeof chartSchema>;

export const chartListSchema = z.strictObject({
  version: z.number(),
  charts: z.array(chartSchema),
});
export type ChartList = z.infer<typeof chartListSchema>;

export const chartsStaleSchema = chartListSchema.extend({ error: z.string() });
export type ChartsStale = z.infer<typeof chartsStaleSchema>;

export const recurringGroupSchema = z.strictObject({
  key: z.string(),
  description: z.string(),
  category: z.string(),
  months: z.number(),
  count: z.number(),
  avgAmount: z.number(),
  monthlyAvg: z.number(),
  lastDate: calendarDaySchema,
  ignored: z.boolean(),
});
export type RecurringGroup = z.infer<typeof recurringGroupSchema>;

export const recurringSummarySchema = z.strictObject({
  baseCurrency: currencySchema,
  monthlyTotal: z.number(),
  groups: z.array(recurringGroupSchema),
});
export type RecurringSummary = z.infer<typeof recurringSummarySchema>;

export const conversionSchema = z.strictObject({
  baseCurrency: currencySchema,
  converting: z.boolean(),
  unconverted: z.number(),
});
export type Conversion = z.infer<typeof conversionSchema>;

export const appSettingsSchema = z.strictObject({
  /** base currency of all totals; changing it requires recomputing base_amount */
  baseCurrency: currencySchema,
  ownerNames: z.array(z.string()),
});
export type AppSettings = z.infer<typeof appSettingsSchema>;

export const categoryRuleSchema = z.strictObject({
  id: z.number(),
  pattern: z.string(),
  category: z.string(),
  createdAt: z.string(),
});
export type CategoryRule = z.infer<typeof categoryRuleSchema>;

const categoryRuleCounts = { matches: z.number(), overridden: z.number() };

export const categoryRuleWithCountsSchema = categoryRuleSchema.extend(categoryRuleCounts);
export type CategoryRuleWithCounts = z.infer<typeof categoryRuleWithCountsSchema>;
export type CategoryRuleCounts = Pick<CategoryRuleWithCounts, keyof typeof categoryRuleCounts>;

export const categoryRuleCreatedSchema = z.strictObject({
  rule: categoryRuleSchema,
  ...categoryRuleCounts,
});
export type CategoryRuleCreated = z.infer<typeof categoryRuleCreatedSchema>;

export const categoryRulePreviewSchema = z.strictObject({
  pattern: z.string(),
  transactions: z.array(transactionSchema),
  ...categoryRuleCounts,
  activeRule: categoryRuleSchema.nullable(),
  otherRules: z.array(categoryRuleSchema),
  previewToken: z.string(),
});
export type CategoryRulePreview = z.infer<typeof categoryRulePreviewSchema>;

export const importPresetsSchema = z.strictObject({
  presets: z.array(z.strictObject({ key: z.string(), title: z.string() })),
});
export type ImportPresets = z.infer<typeof importPresetsSchema>;

/** date, amount and description: the three slots every reader fills, and no others. */
export const readColumnsSchema = z.strictObject({
  date: z.string(),
  amount: z.string(),
  description: z.array(z.string()),
});
export type ReadColumns = z.infer<typeof readColumnsSchema>;

export const readAsSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('preset'),
    preset: z.string(),
    title: z.string(),
    columns: readColumnsSchema,
  }),
  z.strictObject({ kind: z.literal('auto-detected'), columns: readColumnsSchema }),
  z.strictObject({ kind: z.literal('request-mapping'), columns: readColumnsSchema }),
  z.strictObject({ kind: z.literal('pdf-template'), title: z.string() }),
]);
export type ReadAs = z.infer<typeof readAsSchema>;

export const seriesCountsSchema = z.strictObject({
  summed: z.number(),
  checked: z.number(),
});
export type SeriesCounts = z.infer<typeof seriesCountsSchema>;

export const statementTotalSchema = z.strictObject({
  currency: currencySchema,
  net: z.number(),
});
export type StatementTotal = z.infer<typeof statementTotalSchema>;

export const statementBalancesSchema = z.strictObject({
  opening: z.number(),
  closing: z.number(),
  currency: currencySchema,
  series: seriesCountsSchema.optional(),
});
export type StatementBalances = z.infer<typeof statementBalancesSchema>;

export const importSummarySchema = z.strictObject({
  importId: z.string(),
  accountId: z.string(),
  accountName: z.string(),
  total: z.number(),
  accepted: z.number(),
  /** dropped rows, the sum of the three below, and what imports.rows_rejected stores */
  skipped: z.number(),
  /** of those, the ones this importer failed on: an unreadable fee, or no date or amount */
  unreadable: z.number(),
  /** read fine, and dropped by a rule: the statement's own status column says so */
  filtered: z.number(),
  /** read fine, but moving no money once the fee is taken, so there is nothing to insert */
  noMovement: z.number(),
  problems: z.array(z.string()),
  /**
   * Of `accepted`, how many are not already in the database. The user reads this number
   * before deciding.
   */
  newRows: z.number(),
  alreadyPresent: z.number(),
  from: calendarDaySchema,
  to: calendarDaySchema,
  totals: z.array(statementTotalSchema).readonly(),
  readAs: readAsSchema,
  balances: statementBalancesSchema.optional(),
  /** set only when the file states a running balance and no pair came out of it */
  balancesNotShown: balancesNotShownSchema.optional(),
  supersededImportId: z.string().optional(),
});
export type ImportSummary = z.infer<typeof importSummarySchema>;

export const statementImportResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal('duplicate'),
    importId: z.string(),
    accountId: z.string(),
    accountIds: z.array(z.string()),
    uploadedAt: instantSchema,
    skipped: z.number(),
    total: z.number(),
  }),
  z.strictObject({ outcome: z.literal('awaiting_confirmation'), summary: importSummarySchema }),
]);
export type StatementImportResult = z.infer<typeof statementImportResultSchema>;

export const importConfirmedSchema = z.strictObject({
  importId: z.string(),
  accountId: z.string(),
  accountIds: z.array(z.string()),
  inserted: z.number(),
  skipped: z.number(),
  total: z.number(),
});
export type ImportConfirmed = z.infer<typeof importConfirmedSchema>;

export const importDiscardedSchema = z.strictObject({
  discarded: z.literal(true),
  importId: z.string(),
});
export type ImportDiscarded = z.infer<typeof importDiscardedSchema>;

export const importRecordSchema = z.strictObject({
  id: z.string(),
  fileHash: z.string(),
  sourceType: importSourceTypeSchema,
  originalFilename: z.string().nullable(),
  accountName: z.string().nullable(),
  /**
   * The account the rows are going to, resolved at staging. NULL wherever
   * accountName is, and it is the id and not the name that says where they landed:
   * a rename moves the account, never this row's accountName.
   */
  accountId: z.string().nullable(),
  uploadedAt: instantSchema,
  parserVersion: z.number(),
  status: importStatusSchema,
  rowsAccepted: z.number(),
  rowsRejected: z.number(),
  errorDetail: z.string().nullable(),
  transactions: z.number(),
  /**
   * Whether the ROW claims a document, which is not whether the file is on this
   * disk: the key is derived from originalFilename, id and sourceType, all three of
   * which a backup carries, so the claim survives a restore and the file may not.
   */
  documentAvailable: z.boolean(),
});
export type ImportRecord = z.infer<typeof importRecordSchema>;

/** Counts over the whole filtered set, never over the page (see listImports). */
export const importTotalsSchema = z.strictObject({
  imports: z.number(),
  documents: z.number(),
  /**
   * Transactions those imports own (transactions.import_id, "first wrote"), which
   * is NOT "this account's transactions": a row no import owns is in neither.
   */
  transactions: z.number(),
});
export type ImportTotals = z.infer<typeof importTotalsSchema>;

export const importListSchema = z.strictObject({
  imports: z.array(importRecordSchema),
  totals: importTotalsSchema,
});
export type ImportList = z.infer<typeof importListSchema>;

export const importDeletedSchema = z.strictObject({
  deleted: z.literal(true),
  transactions: z.number(),
});
export type ImportDeleted = z.infer<typeof importDeletedSchema>;

export const documentDeletedSchema = z.strictObject({
  deleted: z.literal(true),
  importId: z.string(),
  bytesRemoved: z.boolean(),
});
export type DocumentDeleted = z.infer<typeof documentDeletedSchema>;

export const healthSchema = z.strictObject({ ok: z.literal(true) });
export type Health = z.infer<typeof healthSchema>;

export const deletedSchema = z.strictObject({ deleted: z.literal(true) });
export type Deleted = z.infer<typeof deletedSchema>;

export const restoredSchema = z.strictObject({
  restored: z.literal(true),
  tables: z.number(),
  rows: z.number(),
});
export type Restored = z.infer<typeof restoredSchema>;

export const refusalSchema = z.strictObject({ error: z.string() });
export type Refusal = z.infer<typeof refusalSchema>;

export type Declared =
  | {
      kind: 'json';
      status: 200 | 201;
      body: z.ZodType;
      request?: z.ZodType;
      refusals?: Readonly<Record<number, z.ZodType>>;
    }
  | { kind: 'not-json'; content: string }
  | { kind: 'opaque-json'; content: string };

const json = <B extends z.ZodType, S extends 200 | 201 = 200>(body: B, status: S = 200 as S) =>
  ({ kind: 'json', status, body }) as const;

export const ANSWERS = {
  'GET /api/health': json(healthSchema),
  'GET /api/accounts': json(z.array(accountSchema)),
  'POST /api/accounts': json(accountSchema, 201),
  'PATCH /api/accounts/:id': json(accountSchema),
  'DELETE /api/accounts/:id': json(accountDeletedSchema),
  'GET /api/transactions': json(z.array(transactionSchema)),
  'GET /api/transactions/:id': json(transactionSchema),
  'GET /api/transactions/:id/transfer-rule-preview': json(transferRulePreviewSchema),
  'PATCH /api/transactions/:id/transfer': json(transactionSchema),
  'PATCH /api/transactions/:id/category': json(transactionSchema),
  'PATCH /api/transactions/:id/source': json(transactionSchema),
  'PATCH /api/transactions/:id/one-off': json(transactionSchema),
  'GET /api/transfer-rules': json(z.array(transferRuleWithMatchesSchema)),
  'POST /api/transfer-rules': json(transferRuleCreatedSchema),
  'DELETE /api/transfer-rules/:id': json(deletedSchema),
  'GET /api/summary': json(z.discriminatedUnion('scope', [summarySchema, accountSummarySchema])),
  'GET /api/summary/months': json(
    z.discriminatedUnion('scope', [monthlySummarySchema, accountMonthlySummarySchema]),
  ),
  'GET /api/analytics/charts': json(chartListSchema),
  'PUT /api/analytics/charts': {
    ...json(chartListSchema),
    refusals: { 409: chartsStaleSchema },
  },
  'GET /api/income-sources': json(z.array(incomeSourceDefSchema)),
  'POST /api/income-sources': json(incomeSourceDefSchema),
  'PUT /api/income-sources/:id': json(incomeSourceDefSchema),
  'DELETE /api/income-sources/:id': json(deletedSchema),
  'GET /api/recurring': json(recurringSummarySchema),
  'POST /api/recurring/ignore': json(recurringSummarySchema),
  'GET /api/goals': json(goalListSchema),
  'POST /api/goals': { ...json(goalDetailSchema, 201), request: goalCreateSchema },
  'GET /api/goals/:id': json(goalDetailSchema),
  'PUT /api/goals/:id': { ...json(goalDetailSchema), request: goalUpdateSchema },
  'DELETE /api/goals/:id': json(goalDeletedSchema),
  'GET /api/app-settings': json(appSettingsSchema),
  'PATCH /api/app-settings': json(appSettingsSchema),
  'GET /api/conversion': json(conversionSchema),
  'GET /api/category-rules': json(z.array(categoryRuleWithCountsSchema)),
  'POST /api/category-rules/preview': json(categoryRulePreviewSchema),
  'POST /api/category-rules': json(categoryRuleCreatedSchema),
  'DELETE /api/category-rules/:id': json(deletedSchema),
  'GET /api/export.csv': { kind: 'not-json', content: 'text/csv' },
  'GET /api/imports/presets': json(importPresetsSchema),
  'POST /api/imports': json(statementImportResultSchema),
  'POST /api/imports/:id/confirm': json(importConfirmedSchema),
  'POST /api/imports/:id/discard': json(importDiscardedSchema),
  'GET /api/imports': json(importListSchema),
  'DELETE /api/imports/:id': json(importDeletedSchema),
  'GET /api/imports/:id/document': {
    kind: 'not-json',
    content: 'the stored statement, application/octet-stream',
  },
  'DELETE /api/imports/:id/document': json(documentDeletedSchema),
  'GET /api/backup': {
    kind: 'opaque-json',
    content: 'the backup file; parseBackup owns its shape',
  },
  'POST /api/restore': json(restoredSchema),
  'GET /^\\/(?!api(?:\\/|$)).*/': { kind: 'not-json', content: 'the built client' },
} as const satisfies Record<string, Declared>;

export type Route = keyof typeof ANSWERS;
export type JsonRoute = {
  [K in Route]: (typeof ANSWERS)[K] extends { kind: 'json' } ? K : never;
}[Route];
export type AnswerBody<R extends JsonRoute> = z.output<(typeof ANSWERS)[R]['body']>;

type Def = {
  type: string;
  shape?: Record<string, z.ZodType>;
  element?: z.ZodType;
  options?: readonly z.ZodType[];
  innerType?: z.ZodType;
  in?: z.ZodType;
};

const defOf = (schema: z.ZodType): Def => (schema as unknown as { _zod: { def: Def } })._zod.def;

const childrenOf = (def: Def): z.ZodType[] => {
  switch (def.type) {
    case 'object':
      return Object.values(def.shape ?? {});
    case 'array':
      return [def.element!];
    case 'union':
      return [...(def.options ?? [])];
    case 'optional':
    case 'nullable':
    case 'readonly':
    case 'default':
      return [def.innerType!];
    case 'pipe':
      return [def.in!];
    default:
      return [];
  }
};

/** Whether a schema declares a currency anywhere under it; a body that declares none is sent as it is. */
const holding = new WeakMap<z.ZodType, boolean>();
const holdsCurrency = (schema: z.ZodType): boolean => {
  const known = holding.get(schema);
  if (known !== undefined) return known;
  const holds = schema === currencySchema || childrenOf(defOf(schema)).some(holdsCurrency);
  holding.set(schema, holds);
  return holds;
};

const folded = (schema: z.ZodType, value: unknown): unknown => {
  if (!holdsCurrency(schema)) return value;
  if (schema === currencySchema) return typeof value === 'string' ? currencyKey(value) : value;
  const def = defOf(schema);
  switch (def.type) {
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
      const shape = def.shape ?? {};
      return Object.fromEntries(
        Object.entries(value).map(([key, v]) => [key, Object.hasOwn(shape, key) ? folded(shape[key], v) : v]),
      );
    }
    case 'array':
      return Array.isArray(value) ? value.map((v) => folded(def.element!, v)) : value;
    // every option in turn: a field named the same is a currency in all of them or in none,
    // which backend/test/wire.test.ts holds
    case 'union':
      return (def.options ?? []).reduce<unknown>((v, option) => folded(option, v), value);
    case 'optional':
    case 'nullable':
    case 'readonly':
    case 'default':
      return folded(def.innerType!, value);
    case 'pipe':
      return folded(def.in!, value);
    default:
      return value;
  }
};

/**
 * The body as the route sends it: every value declared with currencySchema in currencyKey's form,
 * so a client compares currencies without knowing what an earlier version stored.
 */
export const sentForm = <R extends JsonRoute>(route: R, body: AnswerBody<R>): AnswerBody<R> =>
  folded(ANSWERS[route].body, body) as AnswerBody<R>;
