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
  'this is a SQLite database from an old version of Finto, not a backup - nothing in this version reads one, and what this route takes is the JSON backup from the Overview screen';

const NOT_A_BACKUP =
  'backup could not be restored: not a Finto backup file (expected JSON with format: "finto-backup")';

/**
 * Recognised by its first 16 bytes; the rest is filler. A string and not a Buffer,
 * because supertest serialises a Buffer as JSON under a JSON content type - every
 * character here is below 0x80, so the bytes on the wire are these, under either type.
 */
const SQLITE_FILE = `SQLite format 3\0${'\u0007'.repeat(240)}`;

const emptyBackup = { format: 'finto-backup', version: 1, tables: {} };

/** An independent literal: a pin that imported the constant would move with it. */
const CEILING = 25 * 1024 * 1024;

const BODY_TOO_LARGE =
  'the request body is larger than 25 MB, the ceiling for a JSON body or a backup file - nothing was changed';

/** A backup that restores nothing, padded to exactly `size` bytes in a key the envelope drops. */
const paddedBackup = (size: number): string => {
  const head = '{"format":"finto-backup","version":1,"tables":{},"pad":"';
  const tail = '"}';
  const body = `${head}${'x'.repeat(size - head.length - tail.length)}${tail}`;
  expect(Buffer.byteLength(body, 'utf8')).toBe(size);
  return body;
};

const BODY_TYPES = ['application/json', 'application/octet-stream'];

let agent: Agent;

const restore = (contentType: string, body: Buffer | string) =>
  agent.post('/api/restore').set('Content-Type', contentType).send(body);

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
      { format: 'finto-backup', version: 99, tables: {} },
      'backup could not be restored: unsupported backup version: 99',
    ],
    [{ format: 'finto-backup', version: 1 }, 'backup could not be restored: backup file has no tables'],
    [
      { format: 'finto-backup', version: 1, tables: { accounts: 'oops' } },
      'backup could not be restored: backup table accounts is not an array',
    ],
  ])('refuses JSON that is not a backup, %j, with the prefixed sentence', async (body, error) => {
    const res = await restore('application/json', JSON.stringify(body));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error });
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
