/**
 * The two account routes over real HTTP: creating an account
 * before any statement names one, and renaming or removing one afterwards.
 *
 * Driven through supertest, because what is worth asserting here
 * is the wire: the status codes, and the sentence each refusal composes. A 409 that
 * names an account the user cannot see, or a 200 for a patch that changed nothing,
 * are both invisible from the data layer.
 */
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { ACCOUNT_NAME_MAX, dbInstance, seedDefaults } from '../src/db';
import { type Agent, serve } from './loopback';
import { freshTestDb } from './pglite';

let agent: Agent;

const csvFile = (label: string): Buffer =>
  Buffer.from(['date,amount,description', `2026-03-01,-10.00,${label}`].join('\n'), 'utf8');

/**
 * An empty account over the door that creates one. Since the upload stopped taking a name
 * it is the only door that does, so every account this file uploads into comes through
 * here.
 */
const makeAccount = async (name: string): Promise<string> => {
  const res = await agent.post('/api/accounts').send({ name, currency: 'EUR' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
};

/** An account of that name, and a statement staged into it. */
const stage = async (name: string, label: string) => stageInto(await makeAccount(name), label);

/** The account is picked, so the request carries no name and no currency. */
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
   * The currency was required, so the "+ Add" control that asks
   * for a name alone had to guess one on the server's behalf. It is defaulted here
   * now, from the same setting the client was reading.
   */
  it('defaults the currency to the base currency when none is sent', async () => {
    const res = await agent.post('/api/accounts').send({ name: 'Currencyless' });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.currency).toBe('EUR');
    expect((await readAccount(res.body.id))!.currency).toBe('EUR');
  });

  /**
   * Optional is not unchecked, and the sentence no longer says "required". The upload
   * used to compose this one too; it takes no currency at all now, so this
   * schema is left with the two account doors.
   */
  it('still refuses a currency that is not a 3-letter code', async () => {
    const res = await agent.post('/api/accounts').send({ name: 'Euro Spelled Out', currency: 'euro' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('currency must be a 3-letter ISO code');
  });
});

describe('the account name bound is one number at both doors that write one', () => {
  // built FROM the constant rather than beside it: a literal 61 here goes on passing
  // over a bound that has moved, which is the whole failure the single constant
  // exists to prevent
  const tooLong = 'x'.repeat(ACCOUNT_NAME_MAX + 1);
  const longest = 'y'.repeat(ACCOUNT_NAME_MAX);
  const sentence = `account name must be at most ${ACCOUNT_NAME_MAX} characters`;

  it('refuses an over-long name on create and on rename', async () => {
    const created = await agent.post('/api/accounts').send({ name: tooLong, currency: 'EUR' });
    expect(created.status).toBe(400);
    expect(created.body.error).toBe(sentence);

    const ok = await agent.post('/api/accounts').send({ name: longest, currency: 'EUR' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);

    const renamed = await agent.patch(`/api/accounts/${ok.body.id}`).send({ name: tooLong });
    expect(renamed.status).toBe(400);
    expect(renamed.body.error).toBe(sentence);
  });

  /**
   * The failure: a name an account already has that its own rename endpoint would refuse.
   * It is reachable only if the doors bound different strings, which is what one schema -
   * trimming before it bounds - prevents. The upload was the third door before it stopped
   * taking a name; the two that remain are the two that write a name.
   */
  it('and a name accepted on create can be sent back to the rename endpoint', async () => {
    // its own filler, because the case above already holds `longest`
    const atTheBound = 'z'.repeat(ACCOUNT_NAME_MAX);
    const padded = `  ${atTheBound}  `;
    const created = await agent.post('/api/accounts').send({ name: padded, currency: 'EUR' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.name).toBe(atTheBound);

    const renamed = await agent.patch(`/api/accounts/${created.body.id}`).send({ name: padded });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(renamed.body.name).toBe(atTheBound);
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

  it('answers 404 for an id this Finto does not have', async () => {
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
 * The correction on the wire. The currency an account was created in can be
 * corrected, and only while the account holds no rows of its own - balance_cents is
 * the plain sum of amount_cents whatever each row says, so re-denominating a
 * populated account relabels a total that was never in the new unit and nothing
 * afterwards can tell that it happened.
 *
 * Both halves of that guard answer here, and with different sentences: a committed
 * import is permanent and a staged one is a discard away. There is no control for
 * any of it in the client, so these requests are the whole surface.
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
   * The trap in correcting a currency while an import waits, run to the end. An import
   * stamps each of its rows with the account's currency when the file is READ, and
   * nothing re-resolves that at confirm - so a correction made while an import waits
   * would stand on the account and be reverted on its rows, which then refuse every
   * further change. The guard refuses inside that window instead, and the sentence names
   * the one way through: discard, correct, upload again.
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
 * DELETE, which is not the PATCH above with `hidden` set. Hiding is
 * reversible and keeps every row; this destroys the account, its transactions, its
 * imports, their staged rows and their stored statements, and answers with the
 * counts of what it actually removed.
 */
describe('DELETE /api/accounts/:id', () => {
  const STAGED =
    'this account has an import waiting to be confirmed - confirm it or discard it, then delete the account';

  const create = async (name: string) => {
    const res = await agent.post('/api/accounts').send({ name, currency: 'EUR' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; name: string };
  };

  const csvRows = (...rows: string[]): Buffer =>
    Buffer.from(['date,amount,description', ...rows].join('\n'), 'utf8');

  /** The id arm again, with the bytes chosen rather than derived from a label. */
  const stageBytes = async (accountId: string, bytes: Buffer) => {
    const res = await agent
      .post('/api/imports')
      .field('accountId', accountId)
      .attach('file', bytes, 'statement.csv');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as {
      outcome: string;
      summary?: { importId: string };
    };
  };

  const commit = async (accountId: string, bytes: Buffer): Promise<string> => {
    const staged = await stageBytes(accountId, bytes);
    const importId = staged.summary!.importId;
    expect((await confirm(importId)).status, `confirming ${importId}`).toBe(200);
    return importId;
  };

  const rowsIn = async (accountId: string) =>
    (await agent.get(`/api/transactions?accountId=${accountId}`)).body as {
      description: string;
      transfer: boolean;
    }[];

  /**
   * Numeric literals after JSON.stringify catch a count that arrived as a string from
   * node-postgres, and the key set catches a field that arrived undefined through rowsVia
   * - toEqual alone treats an absent key and an undefined one as the same thing. The
   * three numbers are deliberately different: equal ones would let a dropped
   * `document_key_version` pass as a correct answer.
   */
  it('answers with what it destroyed, and with nothing else', async () => {
    const account = await create('Destroyed Counts');
    await commit(account.id, csvRows('2026-07-01,-71.00,Counted one', '2026-07-02,-72.00,Counted two'));
    const second = await commit(account.id, csvRows('2026-07-03,-73.00,Counted three'));
    // one statement the user already deleted: `documents` counts the imports that
    // still claim a readable one, which is the number the panel showed them
    expect((await agent.delete(`/api/imports/${second}/document`)).status).toBe(200);

    const res = await agent.delete(`/api/accounts/${account.id}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = JSON.parse(JSON.stringify(res.body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['deleted', 'documents', 'imports', 'transactions']);
    expect(body).toEqual({ deleted: true, transactions: 3, imports: 2, documents: 1 });

    expect(await readAccount(account.id)).toBeUndefined();
    expect(await rowsIn(account.id)).toHaveLength(0);
  });

  it('answers 404 for an id this Finto does not have, and for one just deleted', async () => {
    const unknown = await agent.delete('/api/accounts/no-such-account');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe('account not found');

    const account = await create('Deleted Twice Http');
    expect((await agent.delete(`/api/accounts/${account.id}`)).status).toBe(200);

    const again = await agent.delete(`/api/accounts/${account.id}`);
    expect(again.status).toBe(404);
    expect(again.body.error).toBe('account not found');
  });

  /**
   * The waiting import's refusal on the wire. The state is momentary and one click from
   * over in either direction, and the sentence says so - where the currency correction's
   * near-identical refusal offers only discard, because confirming defeats that one and
   * is harmless here.
   *
   * One test, two holders: the clause is on the imports statement AND on the
   * accounts one, and dropping either turns this 200. Without the first the imports
   * go, the cascade takes the staged rows and the last guard finds nothing left to
   * refuse; without the second the account goes while its imports stay behind it.
   */
  it('answers 409 while an import waits to be confirmed, and names both ways out', async () => {
    const account = await create('Waiting Http');
    const staged = await stageInto(account.id, 'waiting');

    const refused = await agent.delete(`/api/accounts/${account.id}`);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error).toBe(STAGED);
    expect(await readAccount(account.id)).toBeDefined();

    // the way out the sentence names first, walked: confirm, then delete
    expect((await confirm(staged.importId)).status).toBe(200);
    const res = await agent.delete(`/api/accounts/${account.id}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ deleted: true, transactions: 1, imports: 1, documents: 1 });
    expect(await readAccount(account.id)).toBeUndefined();
  });

  /** The accounts people delete are the ones they hid first. */
  it('deletes an account that was removed from the app', async () => {
    const account = await create('Hidden Then Deleted Http');
    await commit(account.id, csvRows('2026-07-04,-74.00,Hidden and full'));
    expect((await agent.patch(`/api/accounts/${account.id}`).send({ hidden: true })).status).toBe(200);

    const res = await agent.delete(`/api/accounts/${account.id}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ deleted: true, transactions: 1, imports: 1, documents: 1 });
    expect(await readAccount(account.id)).toBeUndefined();
  });

  /**
   * The hash and the name, which are the same class of thing: imports_file_hash_unique
   * is partial on `committed` and accounts_name_unique is not partial at all, so
   * destroying the account has to free both. A delete that left either held would
   * make the statement permanently un-importable and the name permanently unusable,
   * with nothing on any screen holding them.
   */
  it('frees the account name and the file hash of every import it destroyed', async () => {
    const account = await create('Reusable Http');
    const bytes = csvRows('2026-07-05,-75.00,Re-uploadable');
    await commit(account.id, bytes);

    // while it is committed those bytes import nothing
    const duplicate = await stageBytes(account.id, bytes);
    expect(duplicate.outcome).toBe('duplicate');

    expect((await agent.delete(`/api/accounts/${account.id}`)).status).toBe(200);

    const again = await create('Reusable Http');
    expect(again.id).not.toBe(account.id);
    const staged = await stageBytes(again.id, bytes);
    expect(staged.outcome).toBe('awaiting_confirmation');
    expect((await confirm(staged.summary!.importId)).status).toBe(200);
    expect(await rowsIn(again.id)).toHaveLength(1);
  });

  /**
   * The consequence of a real delete: its transfers re-read as income and expense across
   * the whole history, retroactively. The surviving leg's monthly figures move,
   * legitimately and with nothing on screen saying so - which is the client's sentence to
   * decide and the route's to leave possible.
   *
   * Asserted as the EFFECT and not as the call: `reclassifyAll` appears nowhere else
   * in this suite, so "the route calls it" is held by nothing at all. Removing the
   * line from the route turns the last assertion here red.
   */
  it('leaves the surviving leg of a transfer no longer a transfer', async () => {
    const out = await create('Transfer Out');
    const into = await create('Transfer In');
    await commit(out.id, csvRows('2026-08-01,-77.77,Moved between my own'));
    await commit(into.id, csvRows('2026-08-01,77.77,Moved between my own'));

    const paired = await rowsIn(into.id);
    expect(paired).toHaveLength(1);
    expect(paired[0].transfer).toBe(true);
    expect((await rowsIn(out.id))[0].transfer).toBe(true);

    expect((await agent.delete(`/api/accounts/${out.id}`)).status).toBe(200);

    const survivor = await rowsIn(into.id);
    expect(survivor).toHaveLength(1);
    expect(survivor[0].transfer).toBe(false);
  });
});

/**
 * The confirm gate on the picked account, on the wire. This is the two-tab case at HTTP
 * scale: the upload proved the account was there, the account was removed in another tab,
 * and Confirm is pressed on a summary card that is still on screen. The status is what
 * matters as much as the sentence - a 409 is the user's to fix, where the 500
 * ImportNotConfirmable answers would page an operator for a state the user created, and
 * every clause of its sentence would be false here.
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

/**
 * The sibling above's harder half: the account was not hidden, it was
 * deleted, and no request the user can make brings it back - ids are minted
 * server-side. So the sentence may not say "try again", which is what disqualified
 * reusing account-hidden's, and this is the only place that sentence is asserted at
 * all: the exhaustive switch behind it holds that a member has a case, never that the
 * case says anything true.
 *
 * The state cannot be set up through this API and that is the guard working, not a
 * gap: DELETE /api/accounts/:id refuses while the import waits, asserted above. The
 * real window is the delete landing during the parse, and the statement below is what
 * that leaves behind.
 */
describe('a confirm whose account was deleted while it waited', () => {
  it('answers 409, and the sentence sends the user to Discard', async () => {
    const id = await makeAccount('Deleted Mid Confirm');
    const staged = await stageInto(id, 'deleted mid confirm');

    await dbInstance().execute(sql`DELETE FROM accounts WHERE id = ${id}`);

    const refused = await confirm(staged.importId);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(
      'nothing was imported: the account these rows go to was deleted while this import was waiting, and it cannot be brought back. Discard this import and upload the file again into another account',
    );
    expect(refused.body.error).toMatch(/Discard/);
    expect(refused.body.error).not.toMatch(/try again|press Confirm again|restore it/);

    // and it stays refused, so the sentence is not sending the user in a circle -
    // then the way out it names, walked
    expect((await confirm(staged.importId)).status).toBe(409);
    expect((await agent.post(`/api/imports/${staged.importId}/discard`)).status).toBe(200);
  });
});
