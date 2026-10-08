import { categoryLabel } from './categories';
import { fmtMoney } from './format';
import type {
  GoalBasis,
  GoalIncomeScope,
  GoalProgress,
  GoalStatus,
  GoalSummary,
  GoalType,
} from './types';

interface GoalTypeDef {
  label: string;
  fact: string;
}

export const GOAL_TYPE_DEFS = {
  'financial-independence': {
    label: 'Financial independence',
    fact: 'Uses transactions and income sources',
  },
  'emergency-fund': { label: 'Emergency fund', fact: 'Uses account balances' },
  'savings-balance': { label: 'Savings balance', fact: 'Uses account balances' },
  'debt-payoff': { label: 'Debt payoff', fact: 'Uses one debt account' },
  'monthly-income': { label: 'Monthly income', fact: 'Uses income transactions' },
  'savings-rate': { label: 'Savings rate', fact: 'Uses income and spending' },
  'category-spending-limit': {
    label: 'Category spending limit',
    fact: 'Uses this calendar month',
  },
} satisfies Record<GoalType, GoalTypeDef>;

export const GOAL_TYPE_ORDER = Object.keys(GOAL_TYPE_DEFS) as GoalType[];

export const GOAL_BASIS_DEFS = {
  'essential-costs': 'Essential costs',
  'current-spending': 'Current spending',
} satisfies Record<GoalBasis, string>;

export const GOAL_INCOME_SCOPE_DEFS = {
  own: 'Earnings',
  all: 'All income',
} satisfies Record<GoalIncomeScope, string>;

export const GOAL_STATUS_LABELS = {
  tracking: 'Tracking',
  reached: 'Reached',
  'needs-setup': 'Needs setup',
  'not-enough-data': 'Not enough data',
  'account-unavailable': 'Account unavailable',
  'at-risk': 'At risk',
  'over-limit': 'Over limit',
} satisfies Record<GoalStatus, string>;

export const goalTypeLabel = (type: GoalType): string => GOAL_TYPE_DEFS[type].label;

const assertNever = (value: never): never => {
  throw new Error(`Unsupported goal vocabulary value: ${String(value)}`);
};

export const formatGoalValue = (
  value: number | null,
  unit: GoalProgress['unit'],
  currency: string | null,
): string => {
  if (value === null) return '—';
  switch (unit) {
    case 'money':
      return fmtMoney(value, currency ?? undefined);
    case 'money-per-month':
      return `${fmtMoney(value, currency ?? undefined)}/mo`;
    case 'percent':
      return `${Math.round(value * 100) / 100}%`;
    default:
      return assertNever(unit);
  }
};

export const formatWorkHours = (value: number): string =>
  new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);

export const progressLabel = (progress: GoalProgress): string => {
  if (progress.status === 'reached') return 'Reached';
  if (progress.percentage === null) return progress.status === 'tracking' ? 'Progress unavailable' : GOAL_STATUS_LABELS[progress.status];
  const percentage = `${Math.round(progress.percentage)}%`;
  switch (progress.semantic) {
    case 'completion':
      return `${percentage} of target`;
    case 'used':
      return `${percentage} used`;
    default:
      return assertNever(progress.semantic);
  }
};

export const remainingLabel = (progress: GoalProgress): string => {
  const over = progress.overBy !== null && progress.overBy > 0;
  switch (progress.semantic) {
    case 'completion':
      return over ? 'Above target' : 'Left';
    case 'used':
      return over ? 'Over limit' : 'Available';
    default:
      return assertNever(progress.semantic);
  }
};

export const goalStatusMessage = (goal: GoalSummary): string | null => {
  switch (goal.progress.status) {
    case 'needs-setup':
      return 'Add essential costs to calculate progress.';
    case 'not-enough-data':
      return 'There isn’t enough usable data in the selected period to calculate progress.';
    case 'account-unavailable':
      return goal.type === 'debt-payoff'
        ? 'The debt account was removed. Create a new goal to track another debt.'
        : 'A selected account was removed. Edit this goal to choose another account.';
    case 'at-risk':
      return 'Forecast to exceed the limit this month.';
    case 'over-limit':
      return 'This month is over the saved limit.';
    case 'tracking':
    case 'reached':
      return null;
  }
};

export const goalCategoryLabel = (goal: GoalSummary): string | null =>
  goal.type === 'category-spending-limit' ? categoryLabel(goal.category) : null;
