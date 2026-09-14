/**
 * The two per-transaction marks that had no HTTP case: the income
 * source and the one-off flag. The transfer flag's route is held in
 * http-transfer-rules.test.ts and the category's in category-override.test.ts; the
 * no-body refusal every JSON route shares is http-body.test.ts's and is not re-pinned.
 */
import crypto from 'crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { reclassifyAll } from '../src/classify';
import { insertTransactions, seedDefaults } from '../src/db';
import { NewTransaction } from '../src/types';
import { idOf } from './helpers';
import { freshTestDb } from './pglite';

let agent: request.Agent;
let incomeId: string;
let expenseId: string;

beforeAll(async () => {
  await freshTestDb();
  await seedDefaults();
  agent = request.agent(app);
  const created = await agent.post('/api/accounts').send({ name: 'Marks Bank', currency: 'EUR' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const accountId = created.body.id as string;
  const tx = (amount: number, description: string): NewTransaction => ({
    accountId,
    provider: 'upload',
    amount,
    currency: 'EUR',
    date: '2026-04-10T10:00:00.000Z',
    description,
    category: 'other',
    fee: null,
  });
  // neither description matches a source pattern, an owner name or a refund word
  await insertTransactions([tx(100, 'ZZ Income Alpha'), tx(-42, 'ZZ Expense Beta')]);
  // the classifier's own answer in income_source, rather than a NULL the row reader
  // happens to render the same way
  await reclassifyAll();
  incomeId = await idOf('ZZ Income Alpha');
  expenseId = await idOf('ZZ Expense Beta');
});

const patchSource = (id: string, body: object) =>
  agent.patch(`/api/transactions/${id}/source`).send(body);

const patchOneOff = (id: string, body: object) =>
  agent.patch(`/api/transactions/${id}/one-off`).send(body);

describe('PATCH /api/transactions/:id/source', () => {
  it('marks the row with a source by hand', async () => {
    const res = await patchSource(incomeId, { source: 'salary' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      id: incomeId,
      incomeSource: 'salary',
      incomeSourceManual: true,
    });
  });

  /**
   * On a row that was marked first, so the write has something to undo: a row never
   * marked already reads `other` and `false`, and a handler that ignored null would
   * be green on it.
   */
  it('null hands the row back to auto-detection', async () => {
    const marked = await patchSource(incomeId, { source: 'salary' });
    expect(marked.status).toBe(200);
    expect(marked.body).toMatchObject({ incomeSource: 'salary', incomeSourceManual: true });

    const res = await patchSource(incomeId, { source: null });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      id: incomeId,
      incomeSource: 'other',
      incomeSourceManual: false,
    });
  });

  it.each([
    ['an id no source has', { source: 'stipend' }],
    ['a source that is not text', { source: 7 }],
  ])('refuses %s, listing the sources there are', async (_what, body) => {
    const res = await patchSource(incomeId, body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/^source field required: /);
    expect(res.body.error).toMatch(/\| null$/);
    expect(res.body.error).toContain('salary');
  });

  it('answers 404 for a transaction that does not exist', async () => {
    const res = await patchSource(crypto.randomUUID(), { source: 'salary' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'transaction not found' });
  });
});

describe('PATCH /api/transactions/:id/one-off', () => {
  it('sets the mark', async () => {
    const res = await patchOneOff(expenseId, { oneOff: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ id: expenseId, oneOff: true });
  });

  /** Its own case: a handler writing a literal `true` is invisible to the one above. */
  it('clears the mark', async () => {
    expect((await patchOneOff(expenseId, { oneOff: true })).body.oneOff).toBe(true);

    const res = await patchOneOff(expenseId, { oneOff: false });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ id: expenseId, oneOff: false });
  });

  it.each([
    ['a string', { oneOff: 'yes' }],
    ['no oneOff key', {}],
  ])('refuses %s', async (_what, body) => {
    const res = await patchOneOff(expenseId, body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'oneOff field required: true | false' });
  });

  it('answers 404 for a transaction that does not exist', async () => {
    const res = await patchOneOff(crypto.randomUUID(), { oneOff: true });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'transaction not found' });
  });
});
