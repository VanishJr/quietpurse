/**
 * POST /api/restore over real HTTP. backup.test.ts holds what a restore does to the
 * rows; this file holds the door: which bodies it refuses and with which sentence, the
 * ceiling its two body parsers have to agree on, and that the restored rows are tagged
 * by today's rules rather than by the file's.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { insertTransactions, seedDefaults } from '../src/db';
import { NewTransaction, Transaction } from '../src/types';
import { type Agent, serve } from './loopback';
import { freshTestDb } from './pglite';

const SQLITE_REFUSAL =
  'this is a SQLite database from an old version of Quietpurse, not a backup - nothing in this version reads one, and what this route takes is the JSON backup from the Overview screen';

const NOT_A_BACKUP =
  'backup could not be restored: not a Quietpurse backup file (expected JSON with format: "quietpurse-backup")';

/**
 * Recognised by its first 16 bytes; the rest is filler. A string and not a Buffer,
 * because supertest serialises a Buffer as JSON under a JSON content type - every
 * character here is below 0x80, so the bytes on the wire are these, under either type.
 */
const SQLITE_FILE = `SQLite format 3\0${'\u0007'.repeat(240)}`;

const emptyBackup = { format: 'quietpurse-backup', version: 1, tables: {} };

/** An independent literal: a pin that imported the constant would move with it. */
const CEILING = 25 * 1024 * 1024;

const BODY_TOO_LARGE =
  'the request body is larger than 25 MB, the ceiling for a JSON body or a backup file - nothing was changed';

/** A backup that restores nothing, padded to exactly `size` bytes in a key the envelope drops. */
const paddedBackup = (size: number): string => {
  const head = '{"format":"quietpurse-backup","version":1,"tables":{},"pad":"';
  const tail = '"}';
  const body = `${head}${'x'.repeat(size - head.length - tail.length)}${tail}`;
  expect(Buffer.byteLength(body, 'utf8')).toBe(size);
  return body;
};

const BODY_TYPES = ['application/json', 'application/octet-stream'];

let agent: Agent;

const restore = (contentType: string, body: Buffer | string) =>
  agent.post('/api/restore').set('Content-Type', contentType).send(body);

type Dump = { format: string; version: number; tables: Record<string, Record<string, unknown>[]> };

/** The current contents plus `count` transactions on a new account, so the file is a real dump. */
const dumpWithTransactions = async (count = 1): Promise<{ data: Dump; accountId: string }> => {
  const created = await agent.post('/api/accounts').send({ name: `Dated Bank ${crypto.randomUUID()}`, currency: 'EUR' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const accountId = created.body.id as string;
  await insertTransactions(Array.from({ length: count }, (_, n) => ({
    accountId,
    provider: 'upload' as const,
    amount: -20 - n,
    currency: 'EUR',
    date: '2026-10-05T23:30:00.000Z',
    description: 'Trattoria Nord',
    category: 'other',
    fee: null,
  })));
  return { data: (await agent.get('/api/backup')).body as Dump, accountId };
};

beforeAll(async () => {
  await freshTestDb();
  await seedDefaults();
  agent = await serve(app);
});

describe('what the door refuses', () => {
  it('refuses a SQLite database sent as bytes, by name', async () => {
    const res = await restore('application/octet-stream', SQLITE_FILE);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: SQLITE_REFUSAL });
  });

  /**
   * The header check runs on a Buffer, and only the octet-stream parser hands the route
   * one. The same bytes under application/json meet the JSON parser first, which cannot
   * read them, so the sentence that names SQLite never fires on this path: what the
   * person gets is the parser's own refusal behind the door's prefix. The prefix is
   * pinned and the rest is not - the words after it are the JSON engine's, they quote
   * the first bytes of the body, and they differ between Node versions.
   */
  it('the same bytes as application/json are refused by the JSON parser as a 400 that names JSON, not by the SQLite sentence', async () => {
    expect(Buffer.from(SQLITE_FILE, 'utf8').equals(Buffer.from(SQLITE_FILE, 'latin1'))).toBe(true);
    const res = await restore('application/json', SQLITE_FILE);
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error).toMatch(/^the request body could not be read as JSON: /);
    expect(res.body.error).not.toBe(SQLITE_REFUSAL);
  });

  it.each([
    [{ hello: 'world' }, NOT_A_BACKUP],
    [{ format: 'something-else', version: 1, tables: {} }, NOT_A_BACKUP],
    [
      { format: 'quietpurse-backup', version: 99, tables: {} },
      'backup could not be restored: unsupported backup version: 99',
    ],
    [{ format: 'quietpurse-backup', version: 1 }, 'backup could not be restored: backup file has no tables'],
    [
      { format: 'quietpurse-backup', version: 1, tables: { accounts: 'oops' } },
      'backup could not be restored: backup table accounts is not an array',
    ],
  ])('refuses JSON that is not a backup, %j, with the prefixed sentence', async (body, error) => {
    const res = await restore('application/json', JSON.stringify(body));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error });
  });

  /**
   * Refused for what is in the file, after the envelope was accepted: the sentence says
   * which column holds a value this version does not know, and nothing was deleted first.
   */
  it('a value this version does not know is refused by name, and nothing is replaced', async () => {
    const before = (await agent.get('/api/backup')).body as { tables: unknown };
    const imported = {
      id: 'carried',
      fileHash: 'carried-hash',
      sourceType: 'exe',
      originalFilename: 'statement.exe',
      uploadedAt: new Date().toISOString(),
      parserVersion: 1,
      status: 'committed',
      rowsAccepted: 0,
      rowsRejected: 0,
      errorDetail: null,
      documentStored: false,
    };
    const body = { format: 'quietpurse-backup', version: 1, tables: { transactions: [], imports: [imported] } };

    const res = await restore('application/json', JSON.stringify(body));

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'backup could not be restored: imports.sourceType: expected one of csv, xlsx, pdf',
    });
    expect(((await agent.get('/api/backup')).body as { tables: unknown }).tables).toEqual(before.tables);
  });

  describe('a date in a backup', () => {
    it.each([
      ['transactions', '05.10.2026'],
      ['transactions', 'Oct 5 2026'],
      ['fx_rates', '2026/10/05'],
    ])('%s.date %j is refused by name, and nothing is replaced', async (table, date) => {
      const { data } = await dumpWithTransactions();
      const before = structuredClone(data.tables);
      if (table === 'transactions') data.tables.transactions[0].date = date;
      else data.tables.fx_rates = [...(data.tables.fx_rates ?? []), { date, currency: 'USD', rate: 1.1 }];

      const res = await restore('application/json', JSON.stringify(data));

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: `backup could not be restored: ${table}.date: expected a value that starts with YYYY-MM-DD`,
      });
      expect(((await agent.get('/api/backup')).body as Dump).tables).toEqual(before);
    });

    it('restores what an earlier version could have stored, a day or time that does not exist included', async () => {
      const stored = ['2026-10-05', '2026-02-30T00:00:00.000Z', '2026-01-05T25:99:00.000Z'];
      const { data, accountId } = await dumpWithTransactions(stored.length);
      data.tables.transactions
        .filter((t) => t.accountId === accountId)
        .forEach((t, n) => { t.date = stored[n]; });
      data.tables.fx_rates = [...(data.tables.fx_rates ?? []), { date: '2026-10-05', currency: 'USD', rate: 1.1 }];

      const res = await restore('application/json', JSON.stringify(data));

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const after = ((await agent.get('/api/backup')).body as Dump).tables;
      expect(after.transactions.filter((t) => t.accountId === accountId).map((t) => t.date).sort()).toEqual([...stored].sort());
    });
  });

  /**
   * The import refuses a currency that is not a three-letter code, and the restore must
   * not: earlier versions stored a statement's currency cell whatever it said, and an
   * account's currency as an unmapped numeric code.
   */
  it('restores a currency an earlier version could have stored, on an account and on its rows, unchanged', async () => {
    const stored = ['EURO', '€', '933', 'eur'];
    const { data, accountId } = await dumpWithTransactions(stored.length);
    const account = data.tables.accounts.find((a) => a.id === accountId);
    if (!account) throw new Error('the dump has no row for the account it was made with');
    account.currency = '933';
    data.tables.transactions
      .filter((t) => t.accountId === accountId)
      .forEach((t, n) => { t.currency = stored[n]; });

    const res = await restore('application/json', JSON.stringify(data));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = ((await agent.get('/api/backup')).body as Dump).tables;
    expect(after.accounts.find((a) => a.id === accountId)?.currency).toBe('933');
    expect(after.transactions.filter((t) => t.accountId === accountId).map((t) => t.currency).sort()).toEqual([...stored].sort());
  });

  /**
   * The database's own refusal still says only that the write failed: its message is the
   * whole failed statement with every bound value, and that goes to the log.
   */
  it('a write the database refuses names no column and no row', async () => {
    const created = await agent.post('/api/accounts').send({ name: 'Twice Bank', currency: 'EUR' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const data = (await agent.get('/api/backup')).body as { tables: { accounts: Record<string, unknown>[] } };
    const account = data.tables.accounts.find((a) => a.id === created.body.id);
    data.tables.accounts.push({ ...account });

    const res = await restore('application/json', JSON.stringify(data));

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error:
        'backup could not be restored: the file was read, but writing it to the database failed - the reason is in the log this server printed',
    });
    expect((await agent.get('/api/accounts')).body).toContainEqual(expect.objectContaining({ id: created.body.id }));
  });

  /**
   * Neither parser claims the body, so the route sees none - and a real backup sent
   * under the wrong content type is refused as if it were not one.
   */
  it('a content type that is neither leaves the body unread, and a real backup under it is refused', async () => {
    const res = await restore('text/plain', JSON.stringify(emptyBackup));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: NOT_A_BACKUP });
  });
});

/**
 * One constant feeds both parsers and the body reaches one of the two by content type,
 * so a client sending JSON and a client sending bytes meet the same ceiling. Held at
 * the bound on both paths against this file's own CEILING literal: a constant moved to
 * 30 MB would otherwise move both parsers and the test together, with nothing red.
 * Over the ceiling, the parser's 413 comes through the last handler with a sentence
 * that names the figure.
 */
describe('the ceiling both parsers share', () => {
  it.each(BODY_TYPES)('%s: a body of exactly the ceiling restores', async (type) => {
    const res = await restore(type, paddedBackup(CEILING));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ restored: true, tables: 0, rows: 0 });
  });

  it.each(BODY_TYPES)('%s: one byte over the ceiling is refused as a 413 that names the ceiling', async (type) => {
    const res = await restore(type, paddedBackup(CEILING + 1));
    expect(res.status, JSON.stringify(res.body)).toBe(413);
    expect(res.body).toEqual({ error: BODY_TOO_LARGE });
  });
});

describe('what a restore leaves behind', () => {
  /**
   * The rows in the file carry the tags they had when the backup was taken; the rule
   * that recognises a transfer by the owner's own name is applied after the restore,
   * so a file whose rows predate it comes back tagged.
   */
  it("re-tags the restored rows by today's rules", async () => {
    const created = await agent.post('/api/accounts').send({ name: 'Restore Bank', currency: 'EUR' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const accountId = created.body.id as string;
    const row = (day: string): NewTransaction => ({
      accountId,
      provider: 'upload',
      amount: -50,
      currency: 'EUR',
      date: `2026-05-${day}T10:00:00.000Z`,
      description: 'Sent to Yurii Kalvenko',
      category: 'other',
      fee: null,
    });
    await insertTransactions([row('01'), row('02')]);

    const exported = await agent.get('/api/backup');
    expect(exported.status).toBe(200);
    const data = exported.body as { tables: { transactions: Record<string, unknown>[] } };
    const mine = data.tables.transactions.filter((t) => t.accountId === accountId);
    expect(mine).toHaveLength(2);
    for (const t of mine) t.transfer = false;

    const res = await restore('application/json', JSON.stringify(data));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ restored: true });

    const rows = (await agent.get(`/api/transactions?accountId=${accountId}`)).body as Transaction[];
    expect(rows).toHaveLength(2);
    expect(rows.map((t) => t.transfer)).toEqual([true, true]);
  });
});
