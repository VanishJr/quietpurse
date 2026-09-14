export type {
  Account,
  AccountDeleted,
  AccountMonthlySummary,
  AccountMonthTotals,
  AccountSummary,
  AppSettings,
  BalancesNotShown,
  BaselineItem,
  BaselineResponse,
  BudgetProgress,
  BudgetsResponse,
  BudgetsWritten,
  CategoryRuleCounts,
  CategoryRuleCreated,
  CategoryRuleWithCounts,
  CategorySummary,
  Chart,
  ChartBreakdown,
  ChartKind,
  ChartMetric,
  ChartRange,
  Deleted,
  DocumentDeleted,
  GoalMode,
  ImportConfirmed,
  ImportDeleted,
  ImportDiscarded,
  ImportList,
  ImportPresets,
  ImportRecord,
  ImportSourceType,
  ImportStatus,
  ImportSummary,
  ImportTotals,
  Independence,
  IndependenceMonth,
  IncomeSource,
  IncomeSourceDef,
  IncomeSourceKind,
  IncomeSourceTotal,
  MonthlySummary,
  MonthTotals,
  ReadAs,
  ReadColumns,
  RecurringSummary,
  SeriesCounts,
  Settings,
  StatementImportResult,
  Summary,
  Transaction,
  TransferRuleCreated,
  TransferRuleWithMatches,
} from '../../backend/src/wire';

export type {
  CHART_ACCOUNT_ID_MAX,
  CHART_ID_MAX,
  CHART_ID_SHAPE_SOURCE,
  CHART_TITLE_MAX,
  CHARTS_MAX,
  ERROR_DETAIL_MAX,
} from '../../backend/src/wire';

/**
 * "All transactions" on the Overview, asking the Transactions screen for one account.
 *
 * The nonce is what makes it an event rather than a setting: the screens all stay
 * mounted and keep their own filters, so a second click on the same account would
 * otherwise carry the same value and change nothing — after the user had narrowed the
 * filter by hand in between, which is exactly when they would click it again.
 *
 * Here rather than in Shell.tsx so that the screen reading it does not have to
 * import the module that renders it.
 */
export interface TxFocus {
  accountId: string;
  nonce: number;
}
