import { describe, expect, it } from 'vitest';
import {
  createGoal,
  deleteAccount,
  deleteGoal,
  getGoal,
  listGoals,
  replaceGoal,
  upsertAccount,
} from '../src/db';
import type { GoalCreate } from '../src/wire';

const now = new Date('2026-05-01T12:00:00.000Z');

const account = async (
  id: string,
  name: string,
  currency: string,
  balance: number,
): Promise<void> => {
  await upsertAccount({ id, name, currency, balance, provider: 'upload' });
};

const financial = (
  name = 'Financial independence',
): Extract<GoalCreate, { type: 'financial-independence' }> => ({
  type: 'financial-independence',
  name,
  basis: 'essential-costs',
  bufferPct: 10,
  windowMonths: 6,
  hourlyRate: 25,
  hoursPerWeek: 20,
  essentialCosts: [
    { label: 'Rent', monthly: 900 },
    { label: 'Food', monthly: 300 },
  ],
});

describe('goal persistence', () => {
  it('creates and reads every supported type with its complete configuration', async () => {
    await account('cash-a', 'Cash A', 'EUR', 2000);
    await account('cash-b', 'Cash B', 'EUR', 1000);
    await account('debt', 'Debt', 'EUR', -4000);

    const created = [
      await createGoal(financial(), now),
      await createGoal(
        {
          type: 'emergency-fund',
          name: 'Emergency',
          targetDate: '2027-01-01',
          coverageMonths: 6,
          monthlyEssentials: 1200,
          accountIds: ['cash-a', 'cash-b'],
        },
        now,
      ),
      await createGoal(
        {
          type: 'savings-balance',
          name: 'Deposit',
          targetDate: null,
          target: 10_000,
          accountIds: ['cash-a'],
        },
        now,
      ),
      await createGoal(
        {
          type: 'debt-payoff',
          name: 'Clear debt',
          targetDate: null,
          accountId: 'debt',
          targetDebt: 0,
        },
        now,
      ),
      await createGoal(
        {
          type: 'monthly-income',
          name: 'Income',
          target: 3000,
          incomeScope: 'own',
          windowMonths: 6,
        },
        now,
      ),
      await createGoal(
        {
          type: 'savings-rate',
          name: 'Savings rate',
          targetPercent: 20,
          incomeScope: 'all',
          windowMonths: 12,
        },
        now,
      ),
      await createGoal(
        {
          type: 'category-spending-limit',
          name: 'Food limit',
          category: 'food',
          monthlyLimit: 450,
        },
        now,
      ),
    ];

    expect((await listGoals()).map((goal) => goal.type).sort()).toEqual([
      'category-spending-limit',
      'debt-payoff',
      'emergency-fund',
      'financial-independence',
      'monthly-income',
      'savings-balance',
      'savings-rate',
    ]);
    expect(created[0]).toMatchObject({
      type: 'financial-independence',
      essentialCosts: [
        { label: 'Rent', monthly: 900, sort: 0 },
        { label: 'Food', monthly: 300, sort: 1 },
      ],
    });
    expect(created[1]).toMatchObject({ currency: 'EUR', accountIds: ['cash-a', 'cash-b'] });
    expect(created[3]).toMatchObject({ startingDebt: 4000, targetDebt: 0, currency: 'EUR' });
    expect(created[4]).toMatchObject({ baseCurrency: 'EUR' });
    expect(created[6]).toMatchObject({ baseCurrency: 'EUR' });
  });

  it('replaces Financial independence configuration and costs atomically', async () => {
    const goal = await createGoal(financial('Original'), now);
    const replaced = await replaceGoal(
      goal.id,
      {
        type: 'financial-independence',
        name: 'Updated',
        basis: 'current-spending',
        bufferPct: 15,
        windowMonths: 12,
        hourlyRate: null,
        hoursPerWeek: null,
        essentialCosts: [{ label: 'Housing', monthly: 1000 }],
      },
      new Date('2026-05-02T12:00:00.000Z'),
    );
    expect(replaced).toMatchObject({
      ok: true,
      goal: {
        name: 'Updated',
        basis: 'current-spending',
        bufferPct: 15,
        windowMonths: 12,
        hourlyRate: null,
        hoursPerWeek: null,
        essentialCosts: [{ label: 'Housing', monthly: 1000, sort: 0 }],
      },
    });

    await expect(
      replaceGoal(
        goal.id,
        {
          ...financial('Refused'),
          essentialCosts: [
            { label: 'Rent', monthly: 900 },
            { label: 'rent', monthly: 500 },
          ],
        },
        now,
      ),
    ).rejects.toMatchObject({ code: 'duplicate-cost' });
    expect(await getGoal(goal.id)).toMatchObject({ name: 'Updated', essentialCosts: [{ label: 'Housing' }] });
  });

  it('keeps account-backed goals after an account is removed', async () => {
    await account('goal-cash', 'Goal cash', 'EUR', 1000);
    const goal = await createGoal(
      {
        type: 'savings-balance',
        name: 'Deposit',
        targetDate: null,
        target: 5000,
        accountIds: ['goal-cash'],
      },
      now,
    );

    expect(await deleteAccount('goal-cash')).toMatchObject({ ok: true });
    expect(await getGoal(goal.id)).toMatchObject({ accountIds: ['goal-cash'] });
  });

  it('enforces account, category, date and debt invariants', async () => {
    await account('eur', 'Euro cash', 'EUR', 1000);
    await account('usd', 'Dollar cash', 'USD', 1000);
    await account('loan', 'Loan', 'EUR', -2000);
    await account('positive', 'Positive', 'EUR', 2000);

    await expect(
      createGoal(
        {
          type: 'savings-balance',
          name: 'Mixed',
          targetDate: null,
          target: 5000,
          accountIds: ['eur', 'usd'],
        },
        now,
      ),
    ).rejects.toMatchObject({ code: 'currency-mismatch' });
    await expect(
      createGoal(
        {
          type: 'emergency-fund',
          name: 'Foreign reserve',
          targetDate: null,
          coverageMonths: 6,
          monthlyEssentials: 1000,
          accountIds: ['usd'],
        },
        now,
      ),
    ).rejects.toMatchObject({ code: 'currency-mismatch' });
    await expect(
      createGoal(
        {
          type: 'debt-payoff',
          name: 'Not debt',
          targetDate: null,
          accountId: 'positive',
          targetDebt: 0,
        },
        now,
      ),
    ).rejects.toMatchObject({ code: 'not-debt' });
    await expect(
      createGoal(
        {
          type: 'savings-balance',
          name: 'Past',
          targetDate: '2026-04-30',
          target: 5000,
          accountIds: ['eur'],
        },
        now,
      ),
    ).rejects.toMatchObject({ code: 'invalid-target-date' });
    await expect(
      createGoal(
        {
          type: 'category-spending-limit',
          name: 'Unknown',
          category: 'not-a-category',
          monthlyLimit: 100,
        },
        now,
      ),
    ).rejects.toMatchObject({ code: 'unknown-category' });

    await createGoal(
      {
        type: 'category-spending-limit',
        name: 'Food',
        category: 'transport',
        monthlyLimit: 400,
      },
      now,
    );
    await expect(
      createGoal(
        {
          type: 'category-spending-limit',
          name: 'Food again',
          category: 'transport',
          monthlyLimit: 500,
        },
        now,
      ),
    ).rejects.toMatchObject({ code: 'duplicate-category' });

    const debt = await createGoal(
      {
        type: 'debt-payoff',
        name: 'Loan',
        targetDate: null,
        accountId: 'loan',
        targetDebt: 0,
      },
      now,
    );
    await expect(
      replaceGoal(
        debt.id,
        {
          type: 'debt-payoff',
          name: 'Moved',
          targetDate: null,
          accountId: 'positive',
          targetDebt: 0,
        },
        now,
      ),
    ).rejects.toMatchObject({ code: 'debt-account-immutable' });
  });

  it('refuses type changes and cascades only goal-owned rows on delete', async () => {
    const goal = await createGoal(financial(), now);
    expect(
      await replaceGoal(
        goal.id,
        {
          type: 'monthly-income',
          name: 'Wrong type',
          target: 3000,
          incomeScope: 'own',
          windowMonths: 6,
        },
        now,
      ),
    ).toEqual({ ok: false, reason: 'type-mismatch' });
    expect(await deleteGoal(goal.id)).toBe(true);
    expect(await getGoal(goal.id)).toBeUndefined();
    expect(await deleteGoal(goal.id)).toBe(false);
  });
});
