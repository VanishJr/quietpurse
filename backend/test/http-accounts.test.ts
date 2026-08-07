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

/** The id arm: the account is picked, so the request carries no name and no currency. */
const stageInto = async (accountId: string, label: string) => {
  const res = await agent
    .post('/api/imports')
    .field('accountId', accountId)
    .attach('file', csvFile(label), 'statement.csv');
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.summary as { importId: string; accountId: string };
};

const confirm = (importId: string) => agent.post(`/api/imports/${importId}/confirm`);

/** The account as the API answers for it, hidden ones included. */
const readAccount = async (id: string) => {
  const all = (await agent.get('/api/accounts?all=1')).body as {
    id: string;
    name: string;
    currency: string;
  }[];
  return all.find((a) => a.id === id);
};

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

  it('refuses a name that is only whitespace', async () => {
    const blank = await agent.post('/api/accounts').send({ name: '   ', currency: 'EUR' });
    expect(blank.status).toBe(400);
    expect(blank.body.error).toBe('account name must not be empty');
  });

  /**
   * Row 65's first half: the currency was required, so the "+ Add" control that asks
   * for a name alone had to guess one on the server's behalf. It is defaulted here
   * now, from the same setting the client was reading.
   */
  it('defaults the currency to the workspace base currency when none is sent', async () => {
    const res = await agent.post('/api/accounts').send({ name: 'Currencyless' });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.currency).toBe('EUR');
    expect((await readAccount(res.body.id))!.currency).toBe('EUR');
  });

  /**
   * Optional is not unchecked. The message is the one the upload's door composes too
   * - one schema at both, so it no longer says "required" at either.
   */
  it('still refuses a currency that is not a 3-letter code', async () => {
    const res = await agent.post('/api/accounts').send({ name: 'Euro Spelled Out', currency: 'euro' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('currency must be a 3-letter ISO code');
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
    expect(res.body.error).toBe('nothing to change: send name, hidden, currency, or any of them');
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
 * Row 65's second half, on the wire. The currency an account was created in can be
 * corrected, and only while the account holds no rows of its own - balance_cents is
 * the plain sum of amount_cents whatever each row says, so re-denominating a
 * populated account relabels a total that was never in the new unit and nothing
 * afterwards can tell that it happened.
 *
 * Both halves of that guard answer here, and with different sentences: a committed
 * import is permanent and a staged one is a discard away. There is no control for
 * any of it yet (the account menu is row 27's), so these requests are the whole
 * surface.
 */
describe('PATCH /api/accounts/:id {currency}', () => {
  const HELD =
    'this account holds transactions, and changing its currency would relabel amounts that were never in it - delete the imports behind this account, which empties it, and the currency can be changed again';
  const STAGED =
    'this account has an import waiting to be confirmed, and its rows were already prepared in the currency it has now - discard that import, change the currency, then upload the statement again';

  const create = async (name: string) => {
    const res = await agent.post('/api/accounts').send({ name });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; name: string; currency: string };
  };

  it('changes it while the account is empty, and upper-cases it on the way in', async () => {
    const account = await create('Wrong Unit');
    expect(account.currency).toBe('EUR');

    const res = await agent.patch(`/api/accounts/${account.id}`).send({ currency: 'usd' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.currency).toBe('USD');
    expect((await readAccount(account.id))!.currency).toBe('USD');
  });

  it('and while it is hidden - hidden is what is displayed, not what is writable', async () => {
    const account = await create('Hidden And Empty');
    expect((await agent.patch(`/api/accounts/${account.id}`).send({ hidden: true })).status).toBe(
      200,
    );

    const res = await agent.patch(`/api/accounts/${account.id}`).send({ currency: 'CHF' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await readAccount(account.id))!.currency).toBe('CHF');
  });

  it('refuses once the account holds transactions, and stores nothing', async () => {
    const staged = await stage('Populated Unit', 'populated');
    expect((await confirm(staged.importId)).status).toBe(200);

    const res = await agent.patch(`/api/accounts/${staged.accountId}`).send({ currency: 'USD' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(HELD);
    expect((await readAccount(staged.accountId))!.currency).toBe('EUR');
  });

  /**
   * One statement, one outcome. A rename riding along with a refused currency must
   * not be applied on its own - a 200 for half of what was asked is exactly what the
   * single UPDATE exists to make unrepresentable.
   */
  it('and takes a name sent in the same body down with it', async () => {
    const staged = await stage('Partial Unit', 'partial');
    expect((await confirm(staged.importId)).status).toBe(200);

    const res = await agent
      .patch(`/api/accounts/${staged.accountId}`)
      .send({ name: 'Partial Unit Renamed', currency: 'USD' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(HELD);
    expect(await readAccount(staged.accountId)).toMatchObject({
      name: 'Partial Unit',
      currency: 'EUR',
    });
  });

  /**
   * The guard must NOT be paired with VISIBLE_ACCOUNT(), which every other predicate
   * in db/index.ts is: that one excludes the transactions OF hidden accounts, so
   * together they would read a hidden account holding a thousand rows as empty,
   * re-denominate it at 200, and restore it into a screen of relabelled figures -
   * unrecoverably, because those rows then refuse the change back.
   */
  it('refuses for a hidden account holding transactions too', async () => {
    const staged = await stage('Hidden And Full', 'hidden and full');
    expect((await confirm(staged.importId)).status).toBe(200);
    expect((await agent.patch(`/api/accounts/${staged.accountId}`).send({ hidden: true })).status)
      .toBe(200);

    const res = await agent.patch(`/api/accounts/${staged.accountId}`).send({ currency: 'USD' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(HELD);
    expect((await readAccount(staged.accountId))!.currency).toBe('EUR');
  });

  /**
   * The trap S3 exists for, run to the end. An import stamps each of its rows with
   * the account's currency when the file is READ, and nothing re-resolves that at
   * confirm - so a correction made while an import waits would stand on the account
   * and be reverted on its rows, which then refuse every further change. The guard
   * refuses inside that window instead, and the sentence names the one way through:
   * discard, correct, upload again.
   */
  it('refuses while an import is staged, and the order the sentence names works', async () => {
    const account = await create('Staged Correction');
    const staged = await stageInto(account.id, 'staged correction');

    const refused = await agent.patch(`/api/accounts/${account.id}`).send({ currency: 'usd' });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(STAGED);
    expect((await readAccount(account.id))!.currency).toBe('EUR');

    // transient, not a latch: the staged rows go and the account is correctable again
    expect((await agent.post(`/api/imports/${staged.importId}/discard`)).status).toBe(200);
    const corrected = await agent.patch(`/api/accounts/${account.id}`).send({ currency: 'usd' });
    expect(corrected.status, JSON.stringify(corrected.body)).toBe(200);
    expect(corrected.body.currency).toBe('USD');

    // and the rows land in the corrected unit, which is what refusing bought
    const again = await stageInto(account.id, 'staged correction');
    expect((await confirm(again.importId)).status).toBe(200);
    const rows = (await agent.get(`/api/transactions?accountId=${account.id}`))
      .body as { currency: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].currency).toBe('USD');

    // the other half of the guard now, and this one does not go away
    const permanent = await agent.patch(`/api/accounts/${account.id}`).send({ currency: 'EUR' });
    expect(permanent.status).toBe(409);
    expect(permanent.body.error).toBe(HELD);
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

/**
 * Row 26a's confirm gate on the wire. This is the two-tab case at HTTP scale: the
 * upload proved the account was there, the account was removed in another tab, and
 * Confirm is pressed on a summary card that is still on screen. The status is what
 * matters as much as the sentence - a 409 is the user's to fix, where the 500
 * ImportNotConfirmable answers would page an operator for a state the user created,
 * and every clause of its sentence would be false here.
 */
describe('a confirm whose account was removed while it waited', () => {
  it('answers 409 with the way out, and confirms once the account is restored', async () => {
    const created = await agent
      .post('/api/accounts')
      .send({ name: 'Removed Mid Confirm', currency: 'EUR' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const upload = await agent
      .post('/api/imports')
      .field('accountId', created.body.id)
      .attach('file', csvFile('removed mid confirm'), 'statement.csv');
    expect(upload.status, JSON.stringify(upload.body)).toBe(200);
    const staged = upload.body.summary as { importId: string; accountId: string };

    expect((await agent.patch(`/api/accounts/${created.body.id}`).send({ hidden: true })).status)
      .toBe(200);

    const refused = await confirm(staged.importId);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(
      'nothing was imported: the account these rows go to has been removed from the app - restore it, then press Confirm again',
    );

    // the way out the sentence names, walked: restore, press Confirm again
    expect((await agent.patch(`/api/accounts/${created.body.id}`).send({ hidden: false })).status)
      .toBe(200);
    const confirmed = await confirm(staged.importId);
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body).toMatchObject({ accountId: staged.accountId, inserted: 1 });
  });
});
