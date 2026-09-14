import type { Transaction } from './wire';

export type {
  Account,
  AccountMonthlySummary,
  AccountMonthTotals,
  AccountSummary,
  CategorySummary,
  IncomeSource,
  IncomeSourceDef,
  IncomeSourceKind,
  IncomeSourceTotal,
  MonthlySummary,
  MonthTotals,
  Provider,
  Summary,
  SummaryTotals,
  Transaction,
  TransferRule,
} from './wire';

type AssignedAfterInsert =
  | 'categoryManual'
  | 'transfer'
  | 'transferManual'
  | 'refund'
  | 'baseAmount'
  | 'incomeSource'
  | 'incomeSourceManual'
  | 'recurring'
  | 'oneOff';

/**
 * No id yet: it is a surrogate the data layer assigns, and nothing outside it
 * constructs one. dedupKey is where a format that carries its own stable reference to
 * an operation plugs in; absent, the key is computed instead.
 *
 * fee is required here and optional on Transaction, and that asymmetry is the point: a
 * parser that read a fee and a data layer that dropped it would differ only in the
 * database, where the confirmation screen has already shown the corrected net. Every
 * producer must say what the source stated, including that it stated nothing.
 *
 * Every other field a statement does not state - the classifier's flags, the
 * base-currency conversion, the user's marks - is omitted through AssignedAfterInsert,
 * which keeps this type to what insertTransactionsOn reads: a required field added to
 * Transaction is a compile error at stagedToNew unless it is named there.
 */
export type NewTransaction = Omit<Transaction, 'id' | 'fee' | AssignedAfterInsert> & {
  dedupKey?: string;
  fee: number | null;
};
