/**
 * Deleting a category rule over HTTP (ROADMAP row 75). The rule's creation door and
 * the data layer's delete are held elsewhere (category-override.test.ts); what this
 * route adds to the delete is the recompute after it, and that is the arm worth the
 * file: a rule deleted without one leaves every row it re-tagged wearing a category
 * the rule no longer justifies, with nothing on screen saying so.
 */
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { reclassifyAll } from '../src/classify';
import { insertTransactions, seedDefaults } from '../src/db';
import { Transaction } from '../src/types';
import { freshTestDb } from './pglite';

let agent: request.Agent;
let ruleId: number;

const rewe = async (): Promise<Transaction> => {
  const res = await agent.get('/api/transactions');
  expect(res.status).toBe(200);
  const rows = (res.body as Transaction[]).filter((t) => t.description === 'REWE Berlin');
  expect(rows).toHaveLength(1);
  return rows[0];
};

const listRules = async (): Promise<{ id: number }[]> => {
  const res = await agent.get('/api/category-rules');
  expect(res.status).toBe(200);
  return res.body as { id: number }[];
};

beforeAll(async () => {
  await freshTestDb();
  await seedDefaults();
  agent = request.agent(app);
  const created = await agent.post('/api/accounts').send({ name: 'Rules Bank', currency: 'EUR' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  await insertTransactions([
    {
      accountId: created.body.id as string,
      provider: 'upload',
      amount: -10,
      currency: 'EUR',
      date: '2026-04-10T10:00:00.000Z',
      description: 'REWE Berlin',
      category: 'other',
      fee: null,
    },
  ]);
  // the categoriser's own answer, then a rule over it through the door that makes rules
  await reclassifyAll();
  expect((await rewe()).category).toBe('food');
  const rule = await agent.post('/api/category-rules').send({ pattern: 'REWE', category: 'shopping' });
  expect(rule.status, JSON.stringify(rule.body)).toBe(200);
  ruleId = rule.body.rule.id as number;
  expect((await rewe()).category).toBe('shopping');
});

describe('DELETE /api/category-rules/:id', () => {
  it('refuses an id that is not a number', async () => {
    const res = await agent.delete('/api/category-rules/abc');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid rule id' });
    expect((await listRules()).map((r) => r.id)).toEqual([ruleId]);
  });

  it('answers 404 for an id no rule has', async () => {
    const res = await agent.delete('/api/category-rules/999999');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'rule not found' });
    expect((await listRules()).map((r) => r.id)).toEqual([ruleId]);
  });

  it('deletes the rule and hands its rows back to the categoriser', async () => {
    const res = await agent.delete(`/api/category-rules/${ruleId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ deleted: true });
    expect(await listRules()).toEqual([]);
    // the recompute after the delete, which is the only thing the route adds to it
    expect(await rewe()).toMatchObject({ category: 'food', categoryManual: false });
  });
});
