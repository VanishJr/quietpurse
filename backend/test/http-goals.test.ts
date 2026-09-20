import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { dbInstance, seedDefaults, upsertAccount } from '../src/db';
import type { GoalCreate } from '../src/wire';
import { freshTestDb } from './pglite';
import { sql } from 'drizzle-orm';

let agent: request.Agent;
const ids = new Map<string, string>();

const writes: GoalCreate[] = [
  {
    type: 'financial-independence',
    name: 'Financial independence',
    basis: 'essential-costs',
    bufferPct: 10,
    windowMonths: 6,
    hourlyRate: 25,
    hoursPerWeek: 20,
    essentialCosts: [{ label: 'Essentials', monthly: 1000 }],
  },
  {
    type: 'emergency-fund',
    name: 'Emergency',
    targetDate: '2099-01-01',
    coverageMonths: 6,
    monthlyEssentials: 1000,
    accountIds: ['cash'],
  },
  {
    type: 'savings-balance',
    name: 'Deposit',
    targetDate: null,
    target: 10_000,
    accountIds: ['cash'],
  },
  {
    type: 'debt-payoff',
    name: 'Debt',
    targetDate: null,
    accountId: 'debt',
    targetDebt: 0,
  },
  {
    type: 'monthly-income',
    name: 'Income',
    target: 3000,
    incomeScope: 'own',
    windowMonths: 6,
  },
  {
    type: 'savings-rate',
    name: 'Savings rate',
    targetPercent: 20,
    incomeScope: 'all',
    windowMonths: 6,
  },
  {
    type: 'category-spending-limit',
    name: 'Food',
    category: 'food',
    monthlyLimit: 400,
  },
];

beforeAll(async () => {
  await freshTestDb();
  await seedDefaults();
  await upsertAccount({ id: 'cash', provider: 'upload', name: 'Cash', currency: 'EUR', balance: 2000 });
  await upsertAccount({ id: 'debt', provider: 'upload', name: 'Debt', currency: 'EUR', balance: -4000 });
  await upsertAccount({ id: 'debt-two', provider: 'upload', name: 'Debt two', currency: 'EUR', balance: -1000 });
  agent = request.agent(app);
});

describe('Goals HTTP API', () => {
  it('starts with a real empty list', async () => {
    const res = await agent.get('/api/goals');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ goals: [] });
  });

  it.each(writes.map((write) => [write.type, write] as const))(
    'creates and reads a %s goal',
    async (type, write) => {
      const created = await agent.post('/api/goals').send(write);
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body).toMatchObject({
        id: expect.any(String),
        type,
        name: write.name,
        progress: {
          semantic: type === 'category-spending-limit' ? 'used' : 'completion',
          status: expect.any(String),
        },
      });
      ids.set(type, created.body.id as string);
      const read = await agent.get(`/api/goals/${created.body.id}`);
      expect(read.status, JSON.stringify(read.body)).toBe(200);
      expect(read.body).toEqual({
        ...created.body,
        progress: { ...created.body.progress, asOf: expect.any(String) },
      });
    },
  );

  it('lists card-ready summaries for every saved type', async () => {
    const res = await agent.get('/api/goals');
    expect(res.status).toBe(200);
    expect(res.body.goals).toHaveLength(writes.length);
    expect(res.body.goals.map((goal: { type: string }) => goal.type).sort()).toEqual(
      writes.map((write) => write.type).sort(),
    );
    expect(res.body.goals[0]).toMatchObject({ source: expect.any(String), progress: { asOf: expect.any(String) } });
  });

  it('uses strict complete replacement and refuses type changes', async () => {
    const id = ids.get('financial-independence')!;
    const replacement: GoalCreate = {
      type: 'financial-independence',
      name: 'Independent',
      basis: 'current-spending',
      bufferPct: 15,
      windowMonths: 12,
      hourlyRate: null,
      hoursPerWeek: null,
      essentialCosts: [{ label: 'Housing', monthly: 1200 }],
    };
    const saved = await agent.put(`/api/goals/${id}`).send(replacement);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({
      id,
      name: 'Independent',
      basis: 'current-spending',
      bufferPct: 15,
      essentialCosts: [{ label: 'Housing', monthly: 1200, sort: 0 }],
    });
    expect((await agent.get(`/api/goals/${id}`)).body).toEqual({
      ...saved.body,
      progress: { ...saved.body.progress, asOf: expect.any(String) },
    });

    const changed = await agent.put(`/api/goals/${id}`).send(writes[4]);
    expect(changed.status).toBe(409);
    expect(changed.body).toEqual({ error: 'a goal type cannot be changed' });
  });

  it('refuses unknown fields, invalid dates, blank names and incomplete bodies', async () => {
    const unknown = await agent.post('/api/goals').send({ ...writes[4], extra: true });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toContain('Unrecognized key');

    const past = await agent.post('/api/goals').send({ ...writes[2], targetDate: '2000-01-01' });
    expect(past.status).toBe(400);
    expect(past.body).toEqual({ error: 'target date must be today or later' });

    const blank = await agent.post('/api/goals').send({ ...writes[4], name: '   ' });
    expect(blank.status).toBe(400);
    expect(blank.body.error).toContain('name:');

    const incomplete = await agent.post('/api/goals').send({ type: 'monthly-income', name: 'No target' });
    expect(incomplete.status).toBe(400);
    expect(incomplete.body.error).toContain('target:');
  });

  it('refuses values below storage precision before reaching the database', async () => {
    for (const body of [
      { ...writes[0], hourlyRate: 20.001 },
      { ...writes[0], essentialCosts: [{ label: 'Essentials', monthly: 0.001 }] },
      { ...writes[3], targetDebt: 0.001 },
      { ...writes[5], targetPercent: 0.001 },
      { ...writes[6], monthlyLimit: 0.001 },
    ]) {
      const res = await agent.post('/api/goals').send(body);
      expect(res.status, JSON.stringify(res.body)).toBe(400);
    }
  });

  it('returns conflicts for duplicate categories and a changed debt account', async () => {
    const duplicate = await agent.post('/api/goals').send({ ...writes[6], name: 'Food again' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toContain('already tracks');

    const debt = writes[3] as Extract<GoalCreate, { type: 'debt-payoff' }>;
    const changed = await agent
      .put(`/api/goals/${ids.get('debt-payoff')}`)
      .send({ ...debt, accountId: 'debt-two' });
    expect(changed.status).toBe(409);
    expect(changed.body.error).toContain('cannot change');
  });

  it('answers unknown ids as 404 and delete removes only goal-owned configuration', async () => {
    expect((await agent.get('/api/goals/no-such-goal')).status).toBe(404);
    expect((await agent.put('/api/goals/no-such-goal').send(writes[4])).status).toBe(404);
    expect((await agent.delete('/api/goals/no-such-goal')).status).toBe(404);

    const id = ids.get('financial-independence')!;
    const deleted = await agent.delete(`/api/goals/${id}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ deleted: true, id });
    expect((await agent.get(`/api/goals/${id}`)).status).toBe(404);
    const costs = (await dbInstance().execute(
      sql`SELECT id FROM baseline_items WHERE goal_id = ${id}`,
    )) as unknown as { rows: { id: number }[] };
    expect(costs.rows).toEqual([]);
    expect((await agent.get('/api/accounts')).body).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'cash' }), expect.objectContaining({ id: 'debt' })]),
    );
  });

  it.each([
    ['get', '/api/independence'],
    ['get', '/api/settings'],
    ['patch', '/api/settings'],
    ['get', '/api/baseline'],
    ['put', '/api/baseline'],
    ['get', '/api/budgets'],
    ['put', '/api/budgets'],
  ] as const)('removes the old singleton route: %s %s', async (method, route) => {
    const res = method === 'get' ? await agent.get(route) : await agent[method](route).send({});
    expect(res.status).toBe(404);
  });
});
