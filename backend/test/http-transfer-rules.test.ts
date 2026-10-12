/**
 * The transfer-rule routes over real HTTP. The wire is worth asserting: the status, the
 * sentence and the count in the body. So is what the rows look like afterwards through
 * the same route the Transactions screen reads them from, because a rule that does not
 * re-tag changes the spending figure with nothing on screen saying so.
 */
import crypto from 'crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { insertTransactions, seedDefaults } from '../src/db';
import { NewTransaction, Transaction } from '../src/types';
import { type Agent, serve } from './loopback';
import { freshTestDb } from './pglite';

let agent: Agent;
let accountId: string;

/** An expense in the one account; the day keeps the rows apart. */
const tx = (description: string, day: string): NewTransaction => ({
  accountId,
  provider: 'upload',
  amount: -42,
  currency: 'EUR',
  date: `2026-04-${day}T10:00:00.000Z`,
  description,
  category: 'other',
  fee: null,
});

/** The account's rows as the Transactions screen reads them. */
const rows = async (): Promise<Transaction[]> => {
  const res = await agent.get(`/api/transactions?accountId=${accountId}&limit=200`);
  expect(res.status).toBe(200);
  return res.body as Transaction[];
};

const rowsNamed = async (description: string): Promise<Transaction[]> =>
  (await rows()).filter((t) => t.description === description);

const tagsOf = async (description: string): Promise<boolean[]> =>
  (await rowsNamed(description)).map((t) => t.transfer ?? false);

const postRule = (body: object) => agent.post('/api/transfer-rules').send(body);

const listRules = async (): Promise<{ id: number; description: string; matches: number }[]> => {
  const res = await agent.get('/api/transfer-rules');
  expect(res.status).toBe(200);
  return res.body;
};

/**
 * Everything asserted below is exact, so the file starts from an empty database. The
 * setup file already truncates and seeds before every file; this pair is here anyway,
 * so the exactness rests on a line in this file rather than on a setup file this one
 * does not name.
 */
beforeAll(async () => {
  await freshTestDb();
  await seedDefaults();
  agent = await serve(app);
  const created = await agent.post('/api/accounts').send({ name: 'Rules Bank', currency: 'EUR' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  accountId = created.body.id as string;
});

describe('POST /api/transfer-rules', () => {
  it.each([
    ['no txId', {}],
    ['a txId that is not text', { txId: 5 }],
    ['an empty txId', { txId: '' }],
  ])('refuses a body with %s', async (_what, body) => {
    const res = await postRule(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'txId field required' });
  });

  it('answers 404 for a txId that names no row', async () => {
    const res = await postRule({ txId: crypto.randomUUID() });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'transaction not found' });
  });

  it('refuses a transaction whose description is empty, and says why', async () => {
    await insertTransactions([tx('', '01')]);
    const blank = (await rows()).find((t) => t.description === '');
    expect(blank).toBeDefined();

    const res = await postRule({ txId: blank!.id });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'the transaction has an empty description, so there is nothing to hang a rule on',
    });
    expect(await listRules()).toEqual([]);
  });

  it('creates the rule, counts the rows it covers, and tags every one of them', async () => {
    await insertTransactions([
      tx('Rule Target Payment', '02'),
      tx('Rule Target Payment', '03'),
      tx('Unrelated Coffee', '04'),
    ]);
    expect(await tagsOf('Rule Target Payment')).toEqual([false, false]);
    const [first] = await rowsNamed('Rule Target Payment');

    const res = await postRule({ txId: first.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      rule: { description: 'Rule Target Payment', accountId },
      matches: 2,
    });
    expect(typeof res.body.rule.id).toBe('number');

    expect(await tagsOf('Rule Target Payment')).toEqual([true, true]);
    expect(await tagsOf('Unrelated Coffee')).toEqual([false]);
  });

  /**
   * The route clears manual marks on the rows the rule covers before re-tagging; without
   * that an old "this is not a transfer" outranks the rule on the one row it sits on,
   * and the screen shows a group of three with one untagged.
   */
  it('clears an earlier manual "this is not a transfer" on a row the rule covers', async () => {
    await insertTransactions([
      tx('Marked Then Ruled', '05'),
      tx('Marked Then Ruled', '06'),
      tx('Marked Then Ruled', '07'),
    ]);
    const [marked, other] = await rowsNamed('Marked Then Ruled');
    const patched = await agent
      .patch(`/api/transactions/${marked.id}/transfer`)
      .send({ transfer: false });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ transfer: false, transferManual: false });

    const res = await postRule({ txId: other.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.matches).toBe(3);

    const after = (await rowsNamed('Marked Then Ruled')).find((t) => t.id === marked.id)!;
    expect(after.transferManual).toBeNull();
    expect(after.transfer).toBe(true);
    expect(await tagsOf('Marked Then Ruled')).toEqual([true, true, true]);
  });
});

describe('GET /api/transfer-rules', () => {
  it('answers each rule with its own count of the rows it covers', async () => {
    const byDescription = new Map((await listRules()).map((r) => [r.description, r.matches]));
    expect(byDescription.get('Rule Target Payment')).toBe(2);
    expect(byDescription.get('Marked Then Ruled')).toBe(3);
    expect(byDescription.size).toBe(2);
  });
});

describe('DELETE /api/transfer-rules/:id', () => {
  it('refuses an id that is not a number', async () => {
    const res = await agent.delete('/api/transfer-rules/abc');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid rule id' });
  });

  it('answers 404 for an id no rule has', async () => {
    const res = await agent.delete('/api/transfer-rules/999999');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'rule not found' });
  });

  it('deletes the rule and untags the rows it covered, leaving the other rule standing', async () => {
    const before = await listRules();
    const rule = before.find((r) => r.description === 'Rule Target Payment')!;
    expect(await tagsOf('Rule Target Payment')).toEqual([true, true]);

    const res = await agent.delete(`/api/transfer-rules/${rule.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true });

    expect(await tagsOf('Rule Target Payment')).toEqual([false, false]);
    expect(await tagsOf('Marked Then Ruled')).toEqual([true, true, true]);
    expect((await listRules()).map((r) => r.id)).toEqual(
      before.filter((r) => r.id !== rule.id).map((r) => r.id),
    );
  });
});
