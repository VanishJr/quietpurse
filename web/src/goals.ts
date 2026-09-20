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
  tracking: '',
  reached: 'Reached',
  'needs-setup': 'Needs setup',
  'not-enough-data': 'Not enough data',
  'account-unavailable': 'Account unavailable',
  'at-risk': 'At risk',
  'over-limit': 'Over limit',
} satisfies Record<GoalStatus, string>;

export const goalTypeLabel = (type: GoalType): string => GOAL_TYPE_DEFS[type].label;

export const formatGoalValue = (
  value: number | null,
  unit: GoalProgress['unit'],
  currency: string | null,
): string => {
  if (value === null) return '—';
  if (unit === 'percent') return `${Math.round(value * 100) / 100}%`;
  const money = fmtMoney(value, currency ?? undefined);
  return unit === 'money-per-month' ? `${money}/mo` : money;
};

export const progressLabel = (progress: GoalProgress): string => {
  if (progress.status === 'reached') return 'Reached';
  if (progress.percentage === null) return GOAL_STATUS_LABELS[progress.status] || 'Progress unavailable';
  const percentage = `${Math.round(progress.percentage)}%`;
  return progress.semantic === 'used' ? `${percentage} used` : `${percentage} of target`;
};

export const remainingLabel = (progress: GoalProgress): string =>
  progress.overBy !== null && progress.overBy > 0 ? 'Over by' : 'Left';

export const goalStatusMessage = (goal: GoalSummary): string | null => {
  switch (goal.progress.status) {
    case 'needs-setup':
      return 'Add essential costs or import transactions to calculate progress.';
    case 'not-enough-data':
      return 'Import more transactions to calculate progress.';
    case 'account-unavailable':
      return 'A selected account was removed. Edit this goal to choose another account.';
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
