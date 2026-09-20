import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { reclassifyAll } from '../src/classify';
import { allTransactions, createGoal, insertTransactions, seedDefaults, setBaseForBaseCurrency } from '../src/db';
import { getGoalProgress } from '../src/goals';
import type { NewTransaction } from '../src/types';
import { freshTestDb } from './pglite';

const agent = request(app);
let accountId: string;
const row = (description: string, amount: number, date = '2026-08-10'): NewTransaction => ({
  accountId, provider: 'upload', description, amount, date, currency: 'EUR', category: 'other', fee: null,
});

async function summary(account = false) {
  const res = await agent.get('/api/summary').query({
    from: '2026-08-01', to: '2026-08-31', ...(account ? { accountId } : {}),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

beforeEach(async () => {
  await freshTestDb();
  await seedDefaults();
  const account = await agent.post('/api/accounts').send({ name: 'Support test', currency: 'EUR' });
  expect(account.status).toBe(201);
  accountId = account.body.id;
});

describe('Support category', () => {
  it('counts a manually assigned category as income and external help, excluding it from own earnings', async () => {
    await insertTransactions([row('Salary', 1200), row('Assistance payment', 300), row('REWE', -500)]);
    await reclassifyAll();
    const help = (await allTransactions()).find((tx) => tx.description === 'Assistance payment')!;
    const res = await agent.patch(`/api/transactions/${help.id}/category`).send({ category: 'support' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ category: 'support', categoryManual: true, transfer: false });
    for (const account of [false, true]) {
      const result = await summary(account);
      expect(result.totals.income).toBe(1500);
      expect(result.incomeByCategory).toContainEqual({ category: 'support', total: 300 });
      expect(result.incomeBySource).toContainEqual({ source: res.body.incomeSource, label: 'category:support', kind: 'external', total: 300 });
    }
    const saved = await createGoal(
      {
        type: 'financial-independence',
        name: 'Independence',
        basis: 'essential-costs',
        bufferPct: 0,
        windowMonths: 6,
        hourlyRate: null,
        hoursPerWeek: null,
        essentialCosts: [{ label: 'Living costs', monthly: 1000 }],
      },
      new Date('2026-09-16T00:00:00Z'),
    );
    const goal = await getGoalProgress(saved.id, new Date('2026-09-16T00:00:00Z'));
    expect(goal).toMatchObject({
      supportExcluded: 300,
      progress: { current: 1200, target: 1000, percentage: 120 },
    });
  });

  it('overrides a previous salary source while selected and restores that choice when the category is cleared', async () => {
    await insertTransactions([row('Assistance payment', 300)]);
    await reclassifyAll();
    const [help] = await allTransactions();
    expect((await agent.patch(`/api/transactions/${help.id}/source`).send({ source: 'salary' })).status).toBe(200);
    expect((await agent.patch(`/api/transactions/${help.id}/category`).send({ category: 'support' })).status).toBe(200);
    const refused = await agent.patch(`/api/transactions/${help.id}/source`).send({ source: 'salary' });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain('Support is external income');
    expect((await summary()).incomeBySource).toMatchObject([{ label: 'category:support', kind: 'external', total: 300 }]);
    const cleared = await agent.patch(`/api/transactions/${help.id}/category`).send({ category: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ category: 'other', incomeSource: 'salary', incomeSourceManual: true });
    expect((await summary()).incomeBySource).toMatchObject([{ source: 'salary', kind: 'own', total: 300 }]);
  });

  it('applies through a previewed category rule to existing and future matches and reverses on deletion', async () => {
    await insertTransactions([row('Assistance payment Wertstellung 10.08.2026', 300)]);
    await reclassifyAll();
    const preview = await agent.post('/api/category-rules/preview').send({ pattern: 'Assistance payment' });
    expect(preview.status).toBe(200);
    const rule = await agent.post('/api/category-rules').send({
      pattern: preview.body.pattern, previewToken: preview.body.previewToken, category: 'support',
    });
    expect(rule.status, JSON.stringify(rule.body)).toBe(200);
    await insertTransactions([row('Assistance payment Wertstellung 20.08.2026', 200, '2026-08-20')]);
    await reclassifyAll();
    expect((await allTransactions()).every((tx) => tx.category === 'support')).toBe(true);
    expect((await summary()).incomeBySource).toMatchObject([{ label: 'category:support', kind: 'external', total: 500 }]);
    expect((await agent.delete(`/api/category-rules/${rule.body.rule.id}`)).status).toBe(200);
    expect((await summary()).incomeBySource).toMatchObject([{ source: 'other', kind: 'own', total: 500 }]);
  });

  it('breaks an inferred transfer pair when its incoming leg is explicitly identified as support', async () => {
    const second = await agent.post('/api/accounts').send({ name: 'Second', currency: 'EUR' });
    await insertTransactions([row('Incoming amount', 300), { ...row('Outgoing amount', -300), accountId: second.body.id }]);
    await reclassifyAll();
    expect((await allTransactions()).every((tx) => tx.transfer)).toBe(true);
    const help = (await allTransactions()).find((tx) => tx.amount > 0)!;
    expect((await agent.patch(`/api/transactions/${help.id}/category`).send({ category: 'support' })).status).toBe(200);
    expect((await allTransactions()).every((tx) => !tx.transfer)).toBe(true);
    expect((await summary()).totals.income).toBe(300);
    await agent.patch(`/api/transactions/${help.id}/category`).send({ category: null });
    expect((await allTransactions()).every((tx) => tx.transfer)).toBe(true);
  });

  it('keeps sign, refunds and explicit transfer flags authoritative', async () => {
    await insertTransactions([row('Assistance payment', -100), row('Assistance refund', 20), row('Assistance transfer', 200)]);
    await agent.post('/api/category-rules').send({ pattern: 'Assistance', category: 'support' });
    const ownTransfer = (await allTransactions()).find((tx) => tx.amount === 200)!;
    await agent.patch(`/api/transactions/${ownTransfer.id}/transfer`).send({ transfer: true });
    const result = await summary();
    expect(result.totals).toMatchObject({ income: 0, expense: 80 });
    expect(result.incomeBySource).toEqual([]);
    const saved = await createGoal(
      {
        type: 'monthly-income',
        name: 'Income',
        target: 100,
        incomeScope: 'own',
        windowMonths: 6,
      },
      new Date('2026-09-16T00:00:00Z'),
    );
    expect(await getGoalProgress(saved.id, new Date('2026-09-16T00:00:00Z'))).toMatchObject({
      progress: { current: 0 },
    });
  });

  it('does not depend on an editable income source having its original name or kind', async () => {
    await insertTransactions([row('Assistance payment', 300)]);
    await setBaseForBaseCurrency('EUR');
    const [help] = await allTransactions();
    await agent.patch(`/api/transactions/${help.id}/category`).send({ category: 'support' });
    const changed = await agent.put('/api/income-sources/family').send({ label: 'Repurposed source', kind: 'own' });
    expect(changed.status).toBe(200);
    expect((await summary()).incomeBySource).toMatchObject([{ label: 'category:support', kind: 'external', total: 300 }]);
    const saved = await createGoal(
      {
        type: 'monthly-income',
        name: 'Own income',
        target: 100,
        incomeScope: 'own',
        windowMonths: 6,
      },
      new Date('2026-09-16T00:00:00Z'),
    );
    expect((await getGoalProgress(saved.id, new Date('2026-09-16T00:00:00Z')))?.progress.current).toBe(0);
  });
});
