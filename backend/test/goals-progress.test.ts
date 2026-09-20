import { beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  createGoal,
  dbInstance,
  deleteAccount,
  getGoal,
  initDb,
  insertTransactions,
  replaceGoal,
  seedDefaults,
  setCategoryOverride,
  setSetting,
  setOneOff,
  updateAccountBalance,
  upsertAccount,
} from '../src/db';
import { getGoalProgress } from '../src/goals';
import type { NewTransaction } from '../src/types';
import type { GoalCreate } from '../src/wire';
import { findTx } from './helpers';
import { freshTestDb } from './pglite';

const NOW = new Date('2026-05-15T12:00:00.000Z');

beforeEach(async () => {
  initDb(await freshTestDb());
  await seedDefaults();
});

const transaction = (over: Partial<NewTransaction>): NewTransaction => ({
  accountId: 'progress',
  provider: 'upload',
  amount: -100,
  currency: 'EUR',
  date: '2026-04-10T12:00:00.000Z',
  description: 'Progress row',
  category: 'other',
  fee: null,
  ...over,
});

const addAccount = async (
  id: string,
  name: string,
  balance: number,
  currency = 'EUR',
): Promise<void> => {
  await upsertAccount({ id, name, balance, currency, provider: 'upload' });
};

describe('server-owned goal progress', () => {
  it('uses the buffered Financial independence target for progress and excludes support', async () => {
    for (const [month, suffix] of [
      ['03', 'a'],
      ['04', 'b'],
    ]) {
      await insertTransactions([
        transaction({
          amount: 900,
          date: `2026-${month}-10T12:00:00.000Z`,
          description: `Earnings ${suffix}`,
          category: 'salary',
        }),
        transaction({
          amount: 300,
          date: `2026-${month}-11T12:00:00.000Z`,
          description: `Support ${suffix}`,
          category: 'support',
        }),
      ]);
    }
    const input: Extract<GoalCreate, { type: 'financial-independence' }> = {
      type: 'financial-independence',
      name: 'Independence',
      basis: 'essential-costs',
      bufferPct: 10,
      windowMonths: 6,
      hourlyRate: 20,
      hoursPerWeek: 20,
      essentialCosts: [{ label: 'Essentials', monthly: 1000 }],
    };
    const goal = await createGoal(input, NOW);

    const detail = await getGoalProgress(goal.id, NOW);
    expect(detail).toMatchObject({
      type: 'financial-independence',
      supportExcluded: 300,
      workHoursLeft: 10,
      workHoursCapacityPerMonth: 86.67,
      workHoursCapacityExceeded: false,
      progress: {
        target: 1100,
        current: 900,
        remaining: 200,
        percentage: 81.82,
        status: 'tracking',
        period: { monthsUsed: 2 },
      },
    });

    await replaceGoal(goal.id, { ...input, hoursPerWeek: 1 }, NOW);
    expect(await getGoalProgress(goal.id, NOW)).toMatchObject({
      type: 'financial-independence',
      workHoursLeft: 10,
      workHoursCapacityPerMonth: 4.33,
      workHoursCapacityExceeded: true,
    });
  });

  it('does not fall back from unconfigured essential costs to current spending', async () => {
    const stamp = NOW.toISOString();
    await dbInstance().execute(sql`
      INSERT INTO goals (id, type, name, target_date, created_at, updated_at)
      VALUES ('legacy-empty', 'financial-independence', 'Legacy', NULL, ${stamp}, ${stamp})
    `);
    await dbInstance().execute(sql`
      INSERT INTO financial_independence_goals
        (goal_id, goal_type, basis, buffer_pct, window_months, hourly_rate_cents, hours_per_week)
      VALUES ('legacy-empty', 'financial-independence', 'essential-costs', 10, 6, NULL, NULL)
    `);
    await insertTransactions([
      transaction({ amount: -1000, description: 'Lifestyle spend' }),
      transaction({ amount: 1200, description: 'Income', category: 'salary' }),
    ]);

    const detail = await getGoalProgress('legacy-empty', NOW);
    expect(detail).toMatchObject({
      type: 'financial-independence',
      progress: {
        target: null,
        current: null,
        percentage: null,
        status: 'needs-setup',
      },
    });
  });

  it('amortizes one-offs into the current-spending target', async () => {
    await insertTransactions([
      transaction({ amount: -1000, date: '2026-03-05T12:00:00.000Z', description: 'March regular' }),
      transaction({ amount: -1200, date: '2026-03-06T12:00:00.000Z', description: 'Computer' }),
      transaction({ amount: -1000, date: '2026-04-05T12:00:00.000Z', description: 'April regular' }),
      transaction({ amount: 500, date: '2026-03-20T12:00:00.000Z', description: 'March income', category: 'salary' }),
      transaction({ amount: 500, date: '2026-04-20T12:00:00.000Z', description: 'April income', category: 'salary' }),
    ]);
    await setOneOff((await findTx((row) => row.description === 'Computer')).id, true);
    const goal = await createGoal(
      {
        type: 'financial-independence',
        name: 'Lifestyle',
        basis: 'current-spending',
        bufferPct: 0,
        windowMonths: 6,
        hourlyRate: null,
        hoursPerWeek: null,
        essentialCosts: [],
      },
      NOW,
    );

    const detail = await getGoalProgress(goal.id, NOW);
    expect(detail?.progress).toMatchObject({ target: 1100, current: 500, remaining: 600 });
  });

  it('computes balance and debt goals and preserves unavailable account states', async () => {
    await addAccount('cash-a', 'Cash A', 2000);
    await addAccount('cash-b', 'Cash B', 1000);
    await addAccount('loan', 'Loan', -4000);
    const emergency = await createGoal(
      {
        type: 'emergency-fund',
        name: 'Emergency',
        targetDate: null,
        coverageMonths: 6,
        monthlyEssentials: 1200,
        accountIds: ['cash-a', 'cash-b'],
      },
      NOW,
    );
    const savings = await createGoal(
      {
        type: 'savings-balance',
        name: 'Savings',
        targetDate: null,
        target: 5000,
        accountIds: ['cash-a'],
      },
      NOW,
    );
    const debt = await createGoal(
      {
        type: 'debt-payoff',
        name: 'Debt',
        targetDate: null,
        accountId: 'loan',
        targetDebt: 0,
      },
      NOW,
    );
    await updateAccountBalance('loan', -2500);

    expect((await getGoalProgress(emergency.id, NOW))?.progress).toMatchObject({
      target: 7200,
      current: 3000,
      remaining: 4200,
      percentage: 41.67,
    });
    expect((await getGoalProgress(debt.id, NOW))?.progress).toMatchObject({
      target: 0,
      current: 2500,
      remaining: 2500,
      percentage: 37.5,
    });
    await updateAccountBalance('loan', 100);
    expect((await getGoalProgress(debt.id, NOW))?.progress).toMatchObject({
      current: 0,
      remaining: 0,
      percentage: 100,
      status: 'reached',
    });

    await deleteAccount('cash-a');
    expect(await getGoal(savings.id)).toMatchObject({ accountIds: ['cash-a'] });
    expect((await getGoalProgress(savings.id, NOW))?.progress).toMatchObject({
      current: null,
      status: 'account-unavailable',
    });
  });

  it('averages income over the complete months that contain usable data', async () => {
    for (const [month, suffix] of [
      ['03', 'a'],
      ['04', 'b'],
    ]) {
      await insertTransactions([
        transaction({
          amount: 1000,
          date: `2026-${month}-10T12:00:00.000Z`,
          description: `Own ${suffix}`,
          category: 'salary',
        }),
        transaction({
          amount: 500,
          date: `2026-${month}-11T12:00:00.000Z`,
          description: `Help ${suffix}`,
          category: 'support',
        }),
      ]);
    }
    const own = await createGoal(
      {
        type: 'monthly-income',
        name: 'Own income',
        target: 1200,
        incomeScope: 'own',
        windowMonths: 6,
      },
      NOW,
    );
    const all = await createGoal(
      {
        type: 'monthly-income',
        name: 'All income',
        target: 1200,
        incomeScope: 'all',
        windowMonths: 6,
      },
      NOW,
    );

    expect((await getGoalProgress(own.id, NOW))?.progress).toMatchObject({
      current: 1000,
      status: 'tracking',
      period: { monthsUsed: 2 },
    });
    expect((await getGoalProgress(all.id, NOW))?.progress).toMatchObject({
      current: 1500,
      status: 'reached',
      period: { monthsUsed: 2 },
    });
  });

  it('does not compare saved base-currency targets with another currency', async () => {
    await insertTransactions([
      transaction({
        amount: 1000,
        date: '2026-04-10T12:00:00.000Z',
        description: 'April income',
        category: 'salary',
      }),
      transaction({
        amount: -100,
        date: '2026-05-05T12:00:00.000Z',
        description: 'May food',
        category: 'food',
      }),
    ]);
    const income = await createGoal(
      {
        type: 'monthly-income',
        name: 'Income',
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

    for (const [goal, target] of [
      [income, 1200],
      [category, 200],
    ] as const) {
      expect(await getGoalProgress(goal.id, NOW)).toMatchObject({
        currency: 'EUR',
        source: 'Saved in EUR · Base currency is USD',
        progress: {
          target,
          current: null,
          percentage: null,
          status: 'not-enough-data',
        },
      });
    }
  });

  it('calculates savings rate with refunds and support scope, and refuses zero income', async () => {
    await insertTransactions([
      transaction({ amount: 2000, description: 'Salary', category: 'salary' }),
      transaction({ amount: 1000, description: 'Support', category: 'support' }),
      transaction({ amount: -1000, description: 'Spending', category: 'food' }),
      transaction({ amount: 200, description: 'Refund', category: 'food' }),
      transaction({ amount: -500, description: 'Transfer', category: 'transfers' }),
    ]);
    const refund = await findTx((row) => row.description === 'Refund');
    await dbInstance().execute(sql`UPDATE transactions SET refund = true WHERE id = ${refund.id}`);
    const transfer = await findTx((row) => row.description === 'Transfer');
    await dbInstance().execute(sql`UPDATE transactions SET transfer = true WHERE id = ${transfer.id}`);
    const own = await createGoal(
      {
        type: 'savings-rate',
        name: 'Own rate',
        targetPercent: 50,
        incomeScope: 'own',
        windowMonths: 6,
      },
      NOW,
    );
    const all = await createGoal(
      {
        type: 'savings-rate',
        name: 'All rate',
        targetPercent: 70,
        incomeScope: 'all',
        windowMonths: 6,
      },
      NOW,
    );

    expect((await getGoalProgress(own.id, NOW))?.progress).toMatchObject({
      current: 60,
      status: 'reached',
    });
    expect((await getGoalProgress(all.id, NOW))?.progress).toMatchObject({
      current: 73.33,
      status: 'reached',
    });

    await dbInstance().execute(sql`UPDATE transactions SET amount_cents = -100, base_amount_cents = -100`);
    expect((await getGoalProgress(own.id, NOW))?.progress).toMatchObject({
      current: null,
      status: 'not-enough-data',
    });
  });

  it('reports category spending as percentage used with forecast and manual overrides', async () => {
    await insertTransactions([
      transaction({
        amount: -200,
        date: '2026-05-01T12:00:00.000Z',
        description: 'Manual food',
        category: 'other',
      }),
      transaction({
        amount: 50,
        date: '2026-05-02T12:00:00.000Z',
        description: 'Food refund',
        category: 'food',
      }),
    ]);
    const manual = await findTx((row) => row.description === 'Manual food');
    await setCategoryOverride(manual.id, 'food');
    const refund = await findTx((row) => row.description === 'Food refund');
    await dbInstance().execute(sql`UPDATE transactions SET refund = true WHERE id = ${refund.id}`);
    const goal = await createGoal(
      {
        type: 'category-spending-limit',
        name: 'Food limit',
        category: 'food',
        monthlyLimit: 200,
      },
      NOW,
    );

    const detail = await getGoalProgress(goal.id, NOW);
    expect(detail?.progress).toMatchObject({
      semantic: 'used',
      target: 200,
      current: 150,
      remaining: 50,
      percentage: 75,
      forecast: 310,
      status: 'at-risk',
    });

    await insertTransactions([
      transaction({
        amount: -100,
        date: '2026-05-03T12:00:00.000Z',
        description: 'More food',
        category: 'food',
      }),
    ]);
    expect((await getGoalProgress(goal.id, NOW))?.progress).toMatchObject({
      current: 250,
      overBy: 50,
      status: 'over-limit',
    });
  });

  it('reports incomplete conversion instead of partial-looking progress', async () => {
    await insertTransactions([
      transaction({ amount: 1000, description: 'Converted income', category: 'salary' }),
      transaction({ amount: 500, description: 'Missing rate', currency: 'USD', category: 'salary' }),
    ]);
    const missing = await findTx((row) => row.description === 'Missing rate');
    await dbInstance().execute(
      sql`UPDATE transactions SET base_amount_cents = NULL WHERE id = ${missing.id}`,
    );
    const goal = await createGoal(
      {
        type: 'monthly-income',
        name: 'Income',
        target: 1200,
        incomeScope: 'all',
        windowMonths: 6,
      },
      NOW,
    );
    expect((await getGoalProgress(goal.id, NOW))?.progress).toMatchObject({
      current: null,
      percentage: null,
      status: 'not-enough-data',
    });
  });
});
