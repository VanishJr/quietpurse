import {
  currentBaseCurrency,
  getGoal,
  goalCurrentCategoryTotals,
  goalMonthlyTotals,
  listAccounts,
  listGoals,
  type GoalCategorySpend,
  type GoalMonthTotals,
  type GoalRecord,
} from './db';
import type {
  GoalDetail,
  GoalList,
  GoalPeriod,
  GoalProgress,
  GoalStatus,
  GoalSummary,
  GoalUnit,
} from './wire';

const round2 = (value: number): number => Math.round(value * 100) / 100;
const dayOf = (date: Date): string => date.toISOString().slice(0, 10);
const monthStart = (date: Date, delta = 0): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + delta, 1));
const endOfPreviousMonth = (date: Date): Date => new Date(monthStart(date).getTime() - 1);
const endOfMonth = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
const mean = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};
const monthsText = (months: number): string =>
  `${months} complete ${months === 1 ? 'month' : 'months'}`;

const period = (
  kind: GoalPeriod['kind'],
  from: string | null,
  to: string | null,
  monthsUsed: number | null,
): GoalPeriod => ({ kind, from, to, monthsUsed });

const completionProgress = (
  target: number | null,
  current: number | null,
  unit: GoalUnit,
  status: GoalStatus,
  asOf: string,
  calculationPeriod: GoalPeriod,
): GoalProgress => ({
  semantic: 'completion',
  unit,
  target: target === null ? null : round2(target),
  current: current === null ? null : round2(current),
  remaining:
    target === null || current === null ? null : round2(Math.max(target - current, 0)),
  overBy: target === null || current === null ? null : round2(Math.max(current - target, 0)),
  percentage:
    target === null || current === null || target <= 0
      ? null
      : round2((current / target) * 100),
  forecast: null,
  status,
  asOf,
  period: calculationPeriod,
});

const usedProgress = (
  limit: number,
  current: number | null,
  forecast: number | null,
  status: GoalStatus,
  asOf: string,
  calculationPeriod: GoalPeriod,
): GoalProgress => ({
  semantic: 'used',
  unit: 'money-per-month',
  target: round2(limit),
  current: current === null ? null : round2(current),
  remaining: current === null ? null : round2(Math.max(limit - current, 0)),
  overBy: current === null ? null : round2(Math.max(current - limit, 0)),
  percentage: current === null ? null : round2((current / limit) * 100),
  forecast: forecast === null ? null : round2(forecast),
  status,
  asOf,
  period: calculationPeriod,
});

const completeRows = (
  rows: GoalMonthTotals[],
  now: Date,
  windowMonths: number,
): GoalMonthTotals[] => {
  const first = monthStart(now, -windowMonths).toISOString().slice(0, 7);
  return rows.filter((row) => row.month >= first);
};

const completePeriod = (now: Date, rows: GoalMonthTotals[], windowMonths: number): GoalPeriod =>
  period(
    'complete-months',
    dayOf(monthStart(now, -windowMonths)),
    dayOf(endOfPreviousMonth(now)),
    rows.length,
  );

interface GoalContext {
  now: Date;
  asOf: string;
  baseCurrency: string;
  months: GoalMonthTotals[];
  categories: Map<string, GoalCategorySpend>;
  currentMonthRows: number;
  accounts: Map<string, Awaited<ReturnType<typeof listAccounts>>[number]>;
}

const unavailableAccounts = (
  goal: Extract<GoalRecord, { type: 'emergency-fund' | 'savings-balance' }>,
  context: GoalContext,
): boolean =>
  goal.accountIds.some((id) => {
    const account = context.accounts.get(id);
    return !account || account.currency !== goal.currency;
  });

const accountNames = (accountIds: string[], context: GoalContext): string[] =>
  accountIds.map((id) => context.accounts.get(id)?.name ?? 'Unavailable account');

const financialDetail = (
  goal: Extract<GoalRecord, { type: 'financial-independence' }>,
  context: GoalContext,
): GoalDetail => {
  const rows = completeRows(context.months, context.now, goal.windowMonths);
  const hasUnconverted = rows.some((row) => row.unconverted > 0);
  const oneOffRows = completeRows(context.months, context.now, 12);
  const oneOffMonthly = oneOffRows.reduce((sum, row) => sum + row.expenseOneOff, 0) / 12;
  const spendByMonth = rows.map((row) => row.expense - row.expenseOneOff + oneOffMonthly);
  const essentialBase = goal.essentialCosts.reduce((sum, cost) => sum + cost.monthly, 0);
  const spendingBase = median(spendByMonth);
  const base = goal.basis === 'essential-costs' ? essentialBase : spendingBase;
  const configured = goal.basis === 'essential-costs' ? essentialBase > 0 : spendingBase > 0;
  const target = configured ? round2(base * (1 + goal.bufferPct / 100)) : null;
  const ownIncome = rows.length === 0 ? null : round2(mean(rows.map((row) => row.incomeOwn)));
  const supportExcluded = rows.length === 0 ? 0 : round2(mean(rows.map((row) => row.incomeExternal)));
  let status: GoalStatus;
  if (!configured) status = goal.basis === 'essential-costs' ? 'needs-setup' : 'not-enough-data';
  else if (rows.length === 0 || hasUnconverted) status = 'not-enough-data';
  else status = ownIncome !== null && target !== null && ownIncome >= target ? 'reached' : 'tracking';
  const current = status === 'needs-setup' || status === 'not-enough-data' ? null : ownIncome;
  const progress = completionProgress(
    target,
    current,
    'money-per-month',
    status,
    context.asOf,
    completePeriod(context.now, rows, goal.windowMonths),
  );
  const workHoursLeft =
    goal.hourlyRate !== null && progress.remaining !== null
      ? round2(progress.remaining / goal.hourlyRate)
      : null;
  const workHoursCapacityPerMonth =
    goal.hoursPerWeek === null ? null : round2((goal.hoursPerWeek * 52) / 12);
  const workHoursCapacityExceeded =
    workHoursLeft === null || workHoursCapacityPerMonth === null
      ? null
      : workHoursLeft > workHoursCapacityPerMonth;
  const basis = goal.basis === 'essential-costs' ? 'Essential costs' : 'Current spending';
  return {
    ...goal,
    currency: context.baseCurrency,
    source: `${monthsText(rows.length)} · ${basis} + ${goal.bufferPct}% buffer`,
    supportExcluded,
    workHoursLeft,
    workHoursCapacityPerMonth,
    workHoursCapacityExceeded,
    progress,
  };
};

const balanceDetail = (
  goal: Extract<GoalRecord, { type: 'emergency-fund' | 'savings-balance' }>,
  context: GoalContext,
): GoalDetail => {
  const missing = unavailableAccounts(goal, context);
  const target =
    goal.type === 'emergency-fund'
      ? round2(goal.monthlyEssentials * goal.coverageMonths)
      : goal.target;
  const current = missing
    ? null
    : round2(
        goal.accountIds.reduce(
          (sum, id) => sum + (context.accounts.get(id)?.balance ?? 0),
          0,
        ),
      );
  const status: GoalStatus = missing
    ? 'account-unavailable'
    : current !== null && current >= target
      ? 'reached'
      : 'tracking';
  const progress = completionProgress(
    target,
    current,
    'money',
    status,
    context.asOf,
    period('current-balances', null, null, null),
  );
  const names = accountNames(goal.accountIds, context).join(', ');
  const source =
    goal.type === 'emergency-fund'
      ? `${goal.coverageMonths} months of essential costs · ${names}`
      : `Imported balances · ${names}`;
  return { ...goal, currency: goal.currency, source, progress };
};

const debtDetail = (
  goal: Extract<GoalRecord, { type: 'debt-payoff' }>,
  context: GoalContext,
): GoalDetail => {
  const account = context.accounts.get(goal.accountId);
  const missing = !account || account.currency !== goal.currency;
  const currentDebt = missing ? null : round2(Math.max(-account.balance, 0));
  const amountToPay = goal.startingDebt - goal.targetDebt;
  const percentage =
    currentDebt === null
      ? null
      : round2(Math.min(100, ((goal.startingDebt - currentDebt) / amountToPay) * 100));
  const status: GoalStatus = missing
    ? 'account-unavailable'
    : currentDebt !== null && currentDebt <= goal.targetDebt
      ? 'reached'
      : 'tracking';
  const progress: GoalProgress = {
    semantic: 'completion',
    unit: 'money',
    target: round2(goal.targetDebt),
    current: currentDebt,
    remaining: currentDebt === null ? null : round2(Math.max(currentDebt - goal.targetDebt, 0)),
    overBy: null,
    percentage,
    forecast: null,
    status,
    asOf: context.asOf,
    period: period('current-balances', null, null, null),
  };
  return {
    ...goal,
    currency: goal.currency,
    source: `Imported balance · ${account?.name ?? 'Unavailable account'}`,
    progress,
  };
};

const monthlyIncomeDetail = (
  goal: Extract<GoalRecord, { type: 'monthly-income' }>,
  context: GoalContext,
): GoalDetail => {
  const rows = completeRows(context.months, context.now, goal.windowMonths);
  const unavailable = rows.length === 0 || rows.some((row) => row.unconverted > 0);
  const values = rows.map((row) =>
    goal.incomeScope === 'own' ? row.incomeOwn : row.income,
  );
  const current = unavailable ? null : round2(mean(values));
  const status: GoalStatus =
    current === null ? 'not-enough-data' : current >= goal.target ? 'reached' : 'tracking';
  const { baseCurrency: currency, ...publicGoal } = goal;
  return {
    ...publicGoal,
    currency,
    source: `${monthsText(rows.length)} · ${goal.incomeScope === 'own' ? 'Earnings' : 'All income'}`,
    progress: completionProgress(
      goal.target,
      current,
      'money-per-month',
      status,
      context.asOf,
      completePeriod(context.now, rows, goal.windowMonths),
    ),
  };
};

const savingsRateDetail = (
  goal: Extract<GoalRecord, { type: 'savings-rate' }>,
  context: GoalContext,
): GoalDetail => {
  const rows = completeRows(context.months, context.now, goal.windowMonths);
  const income = rows.reduce(
    (sum, row) => sum + (goal.incomeScope === 'own' ? row.incomeOwn : row.income),
    0,
  );
  const expenses = rows.reduce((sum, row) => sum + row.expense, 0);
  const unavailable =
    rows.length === 0 || rows.some((row) => row.unconverted > 0) || income === 0;
  const current = unavailable ? null : round2(((income - expenses) / income) * 100);
  const status: GoalStatus =
    current === null
      ? 'not-enough-data'
      : current >= goal.targetPercent
        ? 'reached'
        : 'tracking';
  return {
    ...goal,
    currency: null,
    source: `${monthsText(rows.length)} · ${goal.incomeScope === 'own' ? 'Earnings' : 'All income'}`,
    progress: completionProgress(
      goal.targetPercent,
      current,
      'percent',
      status,
      context.asOf,
      completePeriod(context.now, rows, goal.windowMonths),
    ),
  };
};

const categoryDetail = (
  goal: Extract<GoalRecord, { type: 'category-spending-limit' }>,
  context: GoalContext,
): GoalDetail => {
  const row = context.categories.get(goal.category);
  const unavailable = context.currentMonthRows === 0 || (row?.unconverted ?? 0) > 0;
  const current = unavailable ? null : round2(row?.total ?? 0);
  const elapsed = context.now.getUTCDate();
  const days = endOfMonth(context.now).getUTCDate();
  const forecast = current === null ? null : round2((current / elapsed) * days);
  const status: GoalStatus =
    current === null
      ? 'not-enough-data'
      : current > goal.monthlyLimit
        ? 'over-limit'
        : forecast !== null && forecast > goal.monthlyLimit
          ? 'at-risk'
          : 'tracking';
  const { baseCurrency: currency, ...publicGoal } = goal;
  return {
    ...publicGoal,
    currency,
    source: 'Current calendar month',
    progress: usedProgress(
      goal.monthlyLimit,
      current,
      forecast,
      status,
      context.asOf,
      period('current-month', dayOf(monthStart(context.now)), dayOf(context.now), null),
    ),
  };
};

const detailFor = (goal: GoalRecord, context: GoalContext): GoalDetail => {
  switch (goal.type) {
    case 'financial-independence':
      return financialDetail(goal, context);
    case 'emergency-fund':
    case 'savings-balance':
      return balanceDetail(goal, context);
    case 'debt-payoff':
      return debtDetail(goal, context);
    case 'monthly-income':
      return monthlyIncomeDetail(goal, context);
    case 'savings-rate':
      return savingsRateDetail(goal, context);
    case 'category-spending-limit':
      return categoryDetail(goal, context);
  }
};

const summaryOf = (detail: GoalDetail): GoalSummary => {
  const common = {
    id: detail.id,
    name: detail.name,
    targetDate: detail.targetDate,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    currency: detail.currency,
    source: detail.source,
    progress: detail.progress,
  };
  switch (detail.type) {
    case 'financial-independence':
      return {
        ...common,
        type: detail.type,
        supportExcluded: detail.supportExcluded,
        workHoursLeft: detail.workHoursLeft,
        workHoursCapacityPerMonth: detail.workHoursCapacityPerMonth,
        workHoursCapacityExceeded: detail.workHoursCapacityExceeded,
      };
    case 'category-spending-limit':
      return { ...common, type: detail.type, category: detail.category };
    case 'emergency-fund':
    case 'savings-balance':
    case 'debt-payoff':
    case 'monthly-income':
    case 'savings-rate':
      return { ...common, type: detail.type };
  }
};

const detailsFor = async (goals: GoalRecord[], now: Date): Promise<GoalDetail[]> => {
  if (goals.length === 0) return [];
  let maxWindow = 0;
  for (const goal of goals) {
    if (
      goal.type === 'financial-independence' ||
      goal.type === 'monthly-income' ||
      goal.type === 'savings-rate'
    ) {
      maxWindow = Math.max(maxWindow, goal.windowMonths);
    }
    if (goal.type === 'financial-independence') maxWindow = Math.max(maxWindow, 12);
  }
  const completeTo = endOfPreviousMonth(now);
  const needsCategories = goals.some((goal) => goal.type === 'category-spending-limit');
  const needsAccounts = goals.some(
    (goal) =>
      goal.type === 'emergency-fund' ||
      goal.type === 'savings-balance' ||
      goal.type === 'debt-payoff',
  );
  const [baseCurrency, months, categoryRows, accounts] = await Promise.all([
    currentBaseCurrency(),
    maxWindow > 0
      ? goalMonthlyTotals(monthStart(now, -maxWindow).toISOString(), completeTo.toISOString())
      : Promise.resolve([]),
    needsCategories
      ? goalCurrentCategoryTotals(monthStart(now).toISOString(), now.toISOString())
      : Promise.resolve([]),
    needsAccounts ? listAccounts() : Promise.resolve([]),
  ]);
  const context: GoalContext = {
    now,
    asOf: now.toISOString(),
    baseCurrency,
    months,
    categories: new Map(categoryRows.map((row) => [row.category, row])),
    currentMonthRows: categoryRows[0]?.totalRows ?? 0,
    accounts: new Map(accounts.map((account) => [account.id, account])),
  };
  return goals.map((goal) => detailFor(goal, context));
};

export async function listGoalProgress(now = new Date()): Promise<GoalList> {
  const details = await detailsFor(await listGoals(), now);
  return { goals: details.map(summaryOf) };
}

export async function getGoalProgress(
  id: string,
  now = new Date(),
): Promise<GoalDetail | undefined> {
  const goal = await getGoal(id);
  if (!goal) return undefined;
  return (await detailsFor([goal], now))[0];
}
