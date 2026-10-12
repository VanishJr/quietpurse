import { beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  createGoal,
  dbInstance,
  initDb,
  insertTransactions,
  seedDefaults,
  setSetting,
  upsertAccount,
} from '../src/db';
import { getGoalProgress } from '../src/goals';
import type { NewTransaction } from '../src/types';
import { freshTestDb } from './pglite';

const NOW = new Date('2026-05-15T12:00:00.000Z');

const transaction = (over: Partial<NewTransaction>): NewTransaction => ({
  accountId: 'currency-progress',
  provider: 'upload',
  amount: 0,
  currency: 'EUR',
  date: '2026-04-10T12:00:00.000Z',
  description: 'Currency progress row',
  category: 'other',
  fee: null,
  ...over,
});

beforeEach(async () => {
  initDb(await freshTestDb());
  await seedDefaults();
});

describe('base-currency goal units', () => {
  it('withholds incomparable income and category progress after the base currency changes', async () => {
    await insertTransactions([
      transaction({ amount: 1000, description: 'Income', category: 'salary' }),
      transaction({
        amount: -100,
        date: '2026-05-05T12:00:00.000Z',
        description: 'Food',
        category: 'food',
      }),
    ]);
    const income = await createGoal(
      {
        type: 'monthly-income',
        name: 'Income target',
        target: 1200,
        incomeScope: 'own',
        windowMonths: 6,
      },
      NOW,
    );
    const category = await createGoal(
      {
        type: 'category-spending-limit',
        name: 'Food limit',
        category: 'food',
        monthlyLimit: 200,
      },
      NOW,
    );

    expect(await getGoalProgress(income.id, NOW)).toMatchObject({
      currency: 'EUR',
      progress: { target: 1200, current: 1000 },
    });
    expect(await getGoalProgress(category.id, NOW)).toMatchObject({
      currency: 'EUR',
      progress: { target: 200, current: 100 },
    });

    await setSetting('base_currency', 'USD');

    expect(await getGoalProgress(income.id, NOW)).toMatchObject({
      currency: 'EUR',
      progress: { target: 1200, current: null, percentage: null, status: 'not-enough-data' },
    });
    expect(await getGoalProgress(category.id, NOW)).toMatchObject({
      currency: 'EUR',
      progress: { target: 200, current: null, percentage: null, status: 'not-enough-data' },
    });
  });
});

/** An earlier version could store an account's currency in lower case; it is the same currency. */
describe('a currency spelt in lower case', () => {
  it('a base currency spelt in lower case does not withhold progress', async () => {
    await insertTransactions([
      transaction({ amount: 1000, description: 'Income', category: 'salary' }),
      transaction({ amount: -100, date: '2026-05-05T12:00:00.000Z', description: 'Food', category: 'food' }),
    ]);
    const goals = await Promise.all([
      createGoal(
        {
          type: 'financial-independence',
          name: 'Independence',
          basis: 'current-spending',
          bufferPct: 10,
          windowMonths: 6,
          hourlyRate: 20,
          hoursPerWeek: 20,
          essentialCosts: [],
        },
        NOW,
      ),
      createGoal({ type: 'monthly-income', name: 'Income target', target: 1200, incomeScope: 'own', windowMonths: 6 }, NOW),
      createGoal({ type: 'category-spending-limit', name: 'Food limit', category: 'food', monthlyLimit: 200 }, NOW),
    ]);
    const before = await Promise.all(goals.map((g) => getGoalProgress(g.id, NOW)));

    await setSetting('base_currency', 'eur');

    expect(await Promise.all(goals.map((g) => getGoalProgress(g.id, NOW)))).toEqual(before);
  });

  it('an account whose currency is spelt in lower case keeps its goals available', async () => {
    await upsertAccount({ id: 'cash', name: 'Cash', balance: 2000, currency: 'EUR', provider: 'upload' });
    await upsertAccount({ id: 'loan', name: 'Loan', balance: -4000, currency: 'EUR', provider: 'upload' });
    const goals = await Promise.all([
      createGoal(
        { type: 'emergency-fund', name: 'Emergency', targetDate: null, coverageMonths: 6, monthlyEssentials: 1200, accountIds: ['cash'] },
        NOW,
      ),
      createGoal({ type: 'savings-balance', name: 'Savings', targetDate: null, target: 5000, accountIds: ['cash'] }, NOW),
      createGoal({ type: 'debt-payoff', name: 'Debt', targetDate: null, accountId: 'loan', targetDebt: 0 }, NOW),
    ]);
    const before = await Promise.all(goals.map((g) => getGoalProgress(g.id, NOW)));

    await dbInstance().execute(sql`UPDATE accounts SET currency = LOWER(currency)`);

    expect(await Promise.all(goals.map((g) => getGoalProgress(g.id, NOW)))).toEqual(before);
  });

  it('a goal takes accounts whose currency is spelt in either case, and an emergency fund in the base currency spelt in lower case', async () => {
    await upsertAccount({ id: 'upper', name: 'Upper', balance: 1000, currency: 'EUR', provider: 'upload' });
    await upsertAccount({ id: 'lower', name: 'Lower', balance: 500, currency: 'eur', provider: 'upload' });

    await expect(
      createGoal({ type: 'savings-balance', name: 'Both', targetDate: null, target: 5000, accountIds: ['upper', 'lower'] }, NOW),
    ).resolves.toMatchObject({ accountIds: ['upper', 'lower'] });
    await expect(
      createGoal(
        { type: 'emergency-fund', name: 'Lower fund', targetDate: null, coverageMonths: 3, monthlyEssentials: 500, accountIds: ['lower'] },
        NOW,
      ),
    ).resolves.toMatchObject({ accountIds: ['lower'] });
  });
});
