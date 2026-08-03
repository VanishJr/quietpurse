/**
 * The two account routes over real HTTP (ROADMAP 5.1, row 25): creating an account
 * before any statement names one, and renaming or removing one afterwards.
 *
 * Driven through supertest with a real session, because what is worth asserting here
 * is the wire: the status codes, and the sentence each refusal composes. A 409 that
 * names an account the user cannot see, or a 200 for a patch that changed nothing,
 * are both invisible from the data layer.
 *
 * The process-wide test fallback is cleared for the duration, as in upload.test.ts:
 * with it armed a request that never entered a workspace context would answer from
 * the test workspace instead of throwing.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { initAuth } from '../src/auth';
import { ACCOUNT_NAME_MAX, dbInstance, setWorkspaceFallback } from '../src/db';
import { TEST_WORKSPACE_ID } from './pglite';

let agent: request.Agent;

const csvFile = (label: string): Buffer =>
  Buffer.from(['date,amount,description', `2026-03-01,-10.00,${label}`].join('\n'), 'utf8');

/** Upload a statement and answer with the import awaiting confirmation. */
const stage = async (accountName: string, label: string) => {
  const res = await agent
    .post('/api/imports')
    .field('accountName', accountName)
    .field('currency', 'EUR')
    .attach('file', csvFile(label), 'statement.csv');
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.summary as { importId: string; accountId: string; accountExists: boolean };
};

const confirm = (importId: string) => agent.post(`/api/imports/${importId}/confirm`);

beforeAll(async () => {
  initAuth(dbInstance());
  setWorkspaceFallback(undefined);

  agent = request.agent(app);
  const res = await agent.post('/api/auth/sign-up/email').send({
    email: 'accounts@example.com',
    password: 'correct-horse-battery',
    name: 'accounts',
  });
  expect(res.status, `sign-up failed: ${JSON.stringify(res.body)}`).toBeLessThan(300);
});

afterAll(() => {
  // the fallback is process-wide - the rest of the run expects it armed
  setWorkspaceFallback(TEST_WORKSPACE_ID);
});

describe('POST /api/accounts', () => {
  it('creates an empty account and answers 201 with it', async () => {
    const res = await agent.post('/api/accounts').send({ name: 'Manual Bank', currency: 'eur' });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      name: 'Manual Bank',
      // upper-cased on the way in, as the upload path already does
      currency: 'EUR',
      provider: 'upload',
      balance: 0,
      hidden: false,
    });
    expect(res.body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);

    const listed = (await agent.get('/api/accounts')).body as { id: string }[];
    expect(listed.map((a) => a.id)).toContain(res.body.id);
  });

  it('refuses a name another account holds, quoting the name as stored', async () => {
    expect((await agent.post('/api/accounts').send({ name: 'Held', currency: 'EUR' })).status).toBe(
      201,
    );

    const res = await agent.post('/api/accounts').send({ name: 'HELD', currency: 'EUR' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('an account called "Held" already has that name');
  });

  /**
   * A hidden holder has to be named as hidden, or the user is refused on behalf of a
   * row that is nowhere on their screen and told nothing they can act on.
   */
  it('and says so when the account holding the name has been removed', async () => {
    const created = await agent.post('/api/accounts').send({ name: 'Gone', currency: 'EUR' });
    expect((await agent.patch(`/api/accounts/${created.body.id}`).send({ hidden: true })).status)
      .toBe(200);

    const res = await agent.post('/api/accounts').send({ name: 'gone', currency: 'EUR' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(
      'an account called "Gone" already has that name, and it has been removed from the app - restore it, or pick another name',
    );
  });

  it('refuses an unknown field rather than dropping it', async () => {
    const res = await agent
      .post('/api/accounts')
      .send({ name: 'Strict', currency: 'EUR', hidden: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unknown field: "hidden"');
  });

  it('refuses a name that is only whitespace, and one with no currency', async () => {
    const blank = await agent.post('/api/accounts').send({ name: '   ', currency: 'EUR' });
    expect(blank.status).toBe(400);
    expect(blank.body.error).toBe('account name must not be empty');

    const noCurrency = await agent.post('/api/accounts').send({ name: 'Currencyless' });
    expect(noCurrency.status).toBe(400);
    expect(noCurrency.body.error).toBe('currency field required (3-letter ISO code)');
  });
});

describe('the account name bound is one number at every door', () => {
  // built FROM the constant rather than beside it: a literal 61 here goes on passing
  // over a bound that has moved, which is the whole failure the single constant
  // exists to prevent
  const tooLong = 'x'.repeat(ACCOUNT_NAME_MAX + 1);
  const longest = 'y'.repeat(ACCOUNT_NAME_MAX);
  const sentence = `account name must be at most ${ACCOUNT_NAME_MAX} characters`;

  it('refuses an over-long name on create, on rename, and on upload', async () => {
    const created = await agent.post('/api/accounts').send({ name: tooLong, currency: 'EUR' });
    expect(created.status).toBe(400);
    expect(created.body.error).toBe(sentence);

    const ok = await agent.post('/api/accounts').send({ name: longest, currency: 'EUR' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);

    const renamed = await agent.patch(`/api/accounts/${ok.body.id}`).send({ name: tooLong });
    expect(renamed.status).toBe(400);
    expect(renamed.body.error).toBe(sentence);

    const uploaded = await agent
      .post('/api/imports')
      .field('accountName', tooLong)
      .field('currency', 'EUR')
      .attach('file', csvFile('too long a name'), 'statement.csv');
    expect(uploaded.status).toBe(400);
    expect(uploaded.body.error).toBe(sentence);
  });

  /**
   * The failure decision 10 names: a name an account already has that its own rename
   * endpoint would refuse. It is reachable only if the doors bound different strings,
   * which is what one schema - trimming before it bounds - prevents.
   */
  it('and a name accepted at upload can be sent back to the rename endpoint', async () => {
    const padded = `  ${longest}  `;
    const staged = await stage(padded, 'padded name');
    expect((await confirm(staged.importId)).status).toBe(200);

    const renamed = await agent.patch(`/api/accounts/${staged.accountId}`).send({ name: padded });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(renamed.body.name).toBe(longest);
  });
});

describe('PATCH /api/accounts/:id', () => {
  const create = async (name: string) => {
    const res = await agent.post('/api/accounts').send({ name, currency: 'EUR' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; name: string };
  };

  it('renames, and removing it from the app still works', async () => {
    const account = await create('Rename Me');

    const renamed = await agent.patch(`/api/accounts/${account.id}`).send({ name: 'Renamed' });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(renamed.body).toMatchObject({ id: account.id, name: 'Renamed', hidden: false });

    // both fields in one request, which is the shape the union at the data layer
    // exists for
    const both = await agent
      .patch(`/api/accounts/${account.id}`)
      .send({ name: 'Renamed Again', hidden: true });
    expect(both.status).toBe(200);
    expect(both.body).toMatchObject({ name: 'Renamed Again', hidden: true });

    const visible = (await agent.get('/api/accounts')).body as { id: string }[];
    expect(visible.map((a) => a.id)).not.toContain(account.id);
    const all = (await agent.get('/api/accounts?all=1')).body as { id: string }[];
    expect(all.map((a) => a.id)).toContain(account.id);
  });

  it('refuses a patch that asks for nothing rather than answering 200', async () => {
    const account = await create('Unchanged');
    const res = await agent.patch(`/api/accounts/${account.id}`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('nothing to change: send name, hidden, or both');
  });

  it('answers 404 for an id this workspace does not have', async () => {
    const res = await agent.patch('/api/accounts/no-such-account').send({ hidden: true });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('account not found');
  });

  it('answers 409 for a name another account holds', async () => {
    await create('Occupied');
    const other = await create('Free');

    const res = await agent.patch(`/api/accounts/${other.id}`).send({ name: 'occupied' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('an account called "Occupied" already has that name');
  });

  it('but not for a case-variant of the account’s own name', async () => {
    const account = await create('Own Case');
    const res = await agent.patch(`/api/accounts/${account.id}`).send({ name: 'OWN CASE' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.name).toBe('OWN CASE');
  });
});

/**
 * The refusal this row adds, end to end. It is reachable through the API alone: stage
 * an import for a name no account holds, create that account, and the id the import
 * was staged for no longer has a name it can use.
 */
describe('a confirm whose account name was taken while it waited', () => {
  it('answers 409, imports nothing, and confirms once the name is free', async () => {
    const staged = await stage('Contested Http', 'contested');
    expect(staged.accountExists).toBe(false);

    const blocker = await agent
      .post('/api/accounts')
      .send({ name: 'Contested Http', currency: 'EUR' });
    expect(blocker.status).toBe(201);
    expect(blocker.body.id).not.toBe(staged.accountId);

    const refused = await confirm(staged.importId);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(
      'nothing was imported: another account already uses the name "Contested Http", and this import was staged for a different one. Upload the file again and its rows will join that account',
    );
    // nothing landed: no account under the staged id, and the blocker is still empty
    const accounts = (await agent.get('/api/accounts?all=1')).body as { id: string }[];
    expect(accounts.map((a) => a.id)).not.toContain(staged.accountId);
    expect(
      (await agent.get(`/api/transactions?accountId=${blocker.body.id}`)).body,
    ).toHaveLength(0);

    await agent.patch(`/api/accounts/${blocker.body.id}`).send({ name: 'Contested Http Old' });
    const confirmed = await confirm(staged.importId);
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body).toMatchObject({ accountId: staged.accountId, inserted: 1 });
  });

  /**
   * The same refusal when the account holding the name is hidden. The plain sentence
   * tells the user to upload the file again, and following it would land every row in
   * an account nothing displays, answered 200 - so this one names the state and the
   * way out of it instead.
   */
  it('and names the holder as removed when it is hidden', async () => {
    const staged = await stage('Hidden Contest', 'hidden contest');
    const blocker = await agent
      .post('/api/accounts')
      .send({ name: 'Hidden Contest', currency: 'EUR' });
    expect((await agent.patch(`/api/accounts/${blocker.body.id}`).send({ hidden: true })).status)
      .toBe(200);

    const refused = await confirm(staged.importId);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(
      'nothing was imported: another account already uses the name "Hidden Contest", and that account has been removed from the app - restore it or rename it, then upload the file again',
    );
  });
});
