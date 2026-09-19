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
  CategoryRulePreview,
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
  TransferRulePreview,
  TransferRuleWithMatches,
} from '../../backend/src/wire';

export type {
  CHART_ACCOUNT_ID_MAX,
  CHART_ID_MAX,
  CHART_ID_SHAPE_SOURCE,
  CHART_TITLE_MAX,
  CHARTS_MAX,
  ERROR_DETAIL_MAX,
  SUPPORT_INCOME_SOURCE,
} from '../../backend/src/wire';

/**
 * The nonce is what makes it an event rather than a setting: the screens all stay
 * mounted and keep their own filters, so a second click on the same account would
 * otherwise carry the same value and change nothing — after the user had narrowed the
 * filter by hand in between, which is exactly when they would click it again. Here
 * rather than beside the shell that renders it, so the screen reading it does not
 * import that module.
 */
export interface TxFocus {
  accountId: string;
  nonce: number;
}
