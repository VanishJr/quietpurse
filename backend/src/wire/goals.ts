import { z } from 'zod';

export const GOAL_TYPES = [
  'financial-independence',
  'emergency-fund',
  'savings-balance',
  'debt-payoff',
  'monthly-income',
  'savings-rate',
  'category-spending-limit',
] as const;
export const GOAL_BASES = ['essential-costs', 'current-spending'] as const;
export const GOAL_INCOME_SCOPES = ['own', 'all'] as const;
export const GOAL_PROGRESS_SEMANTICS = ['completion', 'used'] as const;
export const GOAL_UNITS = ['money', 'money-per-month', 'percent'] as const;
export const GOAL_STATUSES = [
  'tracking',
  'reached',
  'needs-setup',
  'not-enough-data',
  'account-unavailable',
  'at-risk',
  'over-limit',
] as const;
export const GOAL_PERIODS = ['current-month', 'complete-months', 'current-balances'] as const;

export const GOALS_MAX = 100;
export const GOAL_NAME_MAX = 120;
export const GOAL_ACCOUNT_MAX = 20;
export const GOAL_WINDOW_MAX = 24;
export const GOAL_COVERAGE_MAX = 120;
export const GOAL_AMOUNT_MAX = 21_474_836.47;

export const goalTypeSchema = z.enum(GOAL_TYPES);
export type GoalType = z.infer<typeof goalTypeSchema>;
export const goalBasisSchema = z.enum(GOAL_BASES);
export type GoalBasis = z.infer<typeof goalBasisSchema>;
export const goalIncomeScopeSchema = z.enum(GOAL_INCOME_SCOPES);
export type GoalIncomeScope = z.infer<typeof goalIncomeScopeSchema>;
export const goalProgressSemanticSchema = z.enum(GOAL_PROGRESS_SEMANTICS);
export type GoalProgressSemantic = z.infer<typeof goalProgressSemanticSchema>;
export const goalUnitSchema = z.enum(GOAL_UNITS);
export type GoalUnit = z.infer<typeof goalUnitSchema>;
export const goalStatusSchema = z.enum(GOAL_STATUSES);
export type GoalStatus = z.infer<typeof goalStatusSchema>;
export const goalPeriodKindSchema = z.enum(GOAL_PERIODS);
export type GoalPeriodKind = z.infer<typeof goalPeriodKindSchema>;

const name = z.string().trim().min(1).max(GOAL_NAME_MAX);
const exactHundredth = (value: number): boolean =>
  value === Math.round(value * 100) / 100;
const centValue = z
  .number()
  .finite()
  .refine(exactHundredth, 'must be a whole number of cents');
const amount = centValue.min(0.01).max(GOAL_AMOUNT_MAX);
const nonNegativeAmount = centValue.min(0).max(GOAL_AMOUNT_MAX);
const percentage = z
  .number()
  .finite()
  .refine(exactHundredth, 'must be a whole number of basis points')
  .min(0.01)
  .max(100);
const windowMonths = z.number().int().min(1).max(GOAL_WINDOW_MAX);
const accountId = z.string().trim().min(1);
const accountIds = z.array(accountId).min(1).max(GOAL_ACCOUNT_MAX);
const targetDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable();

export const goalCostWriteSchema = z.strictObject({
  label: z.string().trim().min(1).max(120),
  monthly: amount,
});
export type GoalCostWrite = z.infer<typeof goalCostWriteSchema>;

export const financialIndependenceGoalWriteSchema = z.strictObject({
  type: z.literal('financial-independence'),
  name,
  basis: goalBasisSchema,
  bufferPct: z.number().finite().min(0).max(100),
  windowMonths,
  hourlyRate: centValue.min(0.01).max(10_000).nullable(),
  hoursPerWeek: z.number().finite().min(0.01).max(168).nullable(),
  essentialCosts: z.array(goalCostWriteSchema).max(200),
});
export const emergencyFundGoalWriteSchema = z.strictObject({
  type: z.literal('emergency-fund'),
  name,
  targetDate,
  coverageMonths: z.number().int().min(1).max(GOAL_COVERAGE_MAX),
  monthlyEssentials: amount,
  accountIds,
});
export const savingsBalanceGoalWriteSchema = z.strictObject({
  type: z.literal('savings-balance'),
  name,
  targetDate,
  target: amount,
  accountIds,
});
export const debtPayoffGoalWriteSchema = z.strictObject({
  type: z.literal('debt-payoff'),
  name,
  targetDate,
  accountId,
  targetDebt: nonNegativeAmount,
});
export const monthlyIncomeGoalWriteSchema = z.strictObject({
  type: z.literal('monthly-income'),
  name,
  target: amount,
  incomeScope: goalIncomeScopeSchema,
  windowMonths,
});
export const savingsRateGoalWriteSchema = z.strictObject({
  type: z.literal('savings-rate'),
  name,
  targetPercent: percentage,
  incomeScope: goalIncomeScopeSchema,
  windowMonths,
});
export const categorySpendingGoalWriteSchema = z.strictObject({
  type: z.literal('category-spending-limit'),
  name,
  category: z.string().trim().min(1),
  monthlyLimit: amount,
});

export const goalCreateSchema = z.discriminatedUnion('type', [
  financialIndependenceGoalWriteSchema,
  emergencyFundGoalWriteSchema,
  savingsBalanceGoalWriteSchema,
  debtPayoffGoalWriteSchema,
  monthlyIncomeGoalWriteSchema,
  savingsRateGoalWriteSchema,
  categorySpendingGoalWriteSchema,
]);
export const goalUpdateSchema = goalCreateSchema;
export type GoalCreate = z.infer<typeof goalCreateSchema>;
export type GoalUpdate = z.infer<typeof goalUpdateSchema>;

export const goalPeriodSchema = z.strictObject({
  kind: goalPeriodKindSchema,
  from: z.string().nullable(),
  to: z.string().nullable(),
  monthsUsed: z.number().int().nonnegative().nullable(),
});
export type GoalPeriod = z.infer<typeof goalPeriodSchema>;

export const goalProgressSchema = z.strictObject({
  semantic: goalProgressSemanticSchema,
  unit: goalUnitSchema,
  target: z.number().nullable(),
  current: z.number().nullable(),
  remaining: z.number().nullable(),
  overBy: z.number().nullable(),
  percentage: z.number().nullable(),
  forecast: z.number().nullable(),
  status: goalStatusSchema,
  asOf: z.string(),
  period: goalPeriodSchema,
});
export type GoalProgress = z.infer<typeof goalProgressSchema>;

const goalSummaryFields = {
  id: z.string(),
  name: z.string(),
  targetDate: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  currency: z.string().nullable(),
  source: z.string(),
  progress: goalProgressSchema,
};

export const financialIndependenceGoalSummarySchema = z.strictObject({
  ...goalSummaryFields,
  type: z.literal('financial-independence'),
  supportExcluded: z.number().nullable(),
  workHoursLeft: z.number().nullable(),
  workHoursCapacityPerMonth: z.number().nullable(),
  workHoursCapacityExceeded: z.boolean().nullable(),
});
export const emergencyFundGoalSummarySchema = z.strictObject({
  ...goalSummaryFields,
  type: z.literal('emergency-fund'),
});
export const savingsBalanceGoalSummarySchema = z.strictObject({
  ...goalSummaryFields,
  type: z.literal('savings-balance'),
});
export const debtPayoffGoalSummarySchema = z.strictObject({
  ...goalSummaryFields,
  type: z.literal('debt-payoff'),
});
export const monthlyIncomeGoalSummarySchema = z.strictObject({
  ...goalSummaryFields,
  type: z.literal('monthly-income'),
});
export const savingsRateGoalSummarySchema = z.strictObject({
  ...goalSummaryFields,
  type: z.literal('savings-rate'),
});
export const categorySpendingGoalSummarySchema = z.strictObject({
  ...goalSummaryFields,
  type: z.literal('category-spending-limit'),
  category: z.string(),
});

export const goalSummarySchema = z.discriminatedUnion('type', [
  financialIndependenceGoalSummarySchema,
  emergencyFundGoalSummarySchema,
  savingsBalanceGoalSummarySchema,
  debtPayoffGoalSummarySchema,
  monthlyIncomeGoalSummarySchema,
  savingsRateGoalSummarySchema,
  categorySpendingGoalSummarySchema,
]);
export type GoalSummary = z.infer<typeof goalSummarySchema>;

export const goalCostSchema = z.strictObject({
  id: z.number().int(),
  label: z.string(),
  monthly: z.number(),
  sort: z.number().int(),
});
export type GoalCost = z.infer<typeof goalCostSchema>;

export const financialIndependenceGoalDetailSchema = financialIndependenceGoalSummarySchema.extend({
  basis: goalBasisSchema,
  bufferPct: z.number(),
  windowMonths: z.number().int(),
  hourlyRate: z.number().nullable(),
  hoursPerWeek: z.number().nullable(),
  essentialCosts: z.array(goalCostSchema),
});
export const emergencyFundGoalDetailSchema = emergencyFundGoalSummarySchema.extend({
  coverageMonths: z.number().int(),
  monthlyEssentials: z.number(),
  accountIds: z.array(z.string()),
});
export const savingsBalanceGoalDetailSchema = savingsBalanceGoalSummarySchema.extend({
  target: z.number(),
  accountIds: z.array(z.string()),
});
export const debtPayoffGoalDetailSchema = debtPayoffGoalSummarySchema.extend({
  accountId: z.string(),
  startingDebt: z.number(),
  targetDebt: z.number(),
});
export const monthlyIncomeGoalDetailSchema = monthlyIncomeGoalSummarySchema.extend({
  target: z.number(),
  incomeScope: goalIncomeScopeSchema,
  windowMonths: z.number().int(),
});
export const savingsRateGoalDetailSchema = savingsRateGoalSummarySchema.extend({
  targetPercent: z.number(),
  incomeScope: goalIncomeScopeSchema,
  windowMonths: z.number().int(),
});
export const categorySpendingGoalDetailSchema = categorySpendingGoalSummarySchema.extend({
  monthlyLimit: z.number(),
});

export const goalDetailSchema = z.discriminatedUnion('type', [
  financialIndependenceGoalDetailSchema,
  emergencyFundGoalDetailSchema,
  savingsBalanceGoalDetailSchema,
  debtPayoffGoalDetailSchema,
  monthlyIncomeGoalDetailSchema,
  savingsRateGoalDetailSchema,
  categorySpendingGoalDetailSchema,
]);
export type GoalDetail = z.infer<typeof goalDetailSchema>;

export const goalListSchema = z.strictObject({ goals: z.array(goalSummarySchema) });
export type GoalList = z.infer<typeof goalListSchema>;

export const goalDeletedSchema = z.strictObject({
  deleted: z.literal(true),
  id: z.string(),
});
export type GoalDeleted = z.infer<typeof goalDeletedSchema>;
