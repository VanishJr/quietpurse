import { beforeEach, describe, expect, it } from 'vitest';
import {
  createGoal,
  initDb,
  insertTransactions,
  seedDefaults,
  setSetting,
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
