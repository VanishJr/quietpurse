/**
 * POST /api/restore over real HTTP. backup.test.ts holds what a restore does to the
 * rows; this file holds the door: which bodies it refuses and with which sentence, the
 * ceiling its two body parsers have to agree on, and that the restored rows are tagged
 * by today's rules rather than by the file's.
 */
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { insertTransactions, seedDefaults } from '../src/db';
import { NewTransaction, Transaction } from '../src/types';
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

/** What body-parser reads '25mb' as. */
const CEILING = 25 * 1024 * 1024;

/** A backup that restores nothing, padded to exactly `size` bytes in a key the envelope drops. */
const paddedBackup = (size: number): string => {
  const head = '{"format":"finto-backup","version":1,"tables":{},"pad":"';
  const tail = '"}';
  const body = `${head}${'x'.repeat(size - head.length - tail.length)}${tail}`;
  expect(Buffer.byteLength(body, 'utf8')).toBe(size);
  return body;
};

const BODY_TYPES = ['application/json', 'application/octet-stream'];

let agent: request.Agent;

const restore = (contentType: string, body: Buffer | string) =>
  agent.post('/api/restore').set('Content-Type', contentType).send(body);

beforeAll(async () => {
  await freshTestDb();
  await seedDefaults();
  agent = request.agent(app);
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
   * read them, so the sentence that names SQLite never fires on this path. Recorded
   * rather than defended against: what the person gets today is the catch-all's answer
   * to a parser error, and this is the case that would say so if that changed.
   */
  it('the same bytes as application/json are refused by the JSON parser as a 500, not by name', async () => {
    expect(Buffer.from(SQLITE_FILE, 'utf8').equals(Buffer.from(SQLITE_FILE, 'latin1'))).toBe(true);
    const res = await restore('application/json', SQLITE_FILE);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal error' });
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
 * The limit is written once per parser and the body reaches one of the two by content
 * type; if the two literals drift, a client sending JSON gets one ceiling and a client
 * sending bytes gets another. Held at the bound on both paths. The refusal over the
 * ceiling is recorded rather than defended against: it is the catch-all's 500 today,
 * not a 413 that names the ceiling.
 */
describe('the ceiling both parsers share', () => {
  it.each(BODY_TYPES)('%s: a body of exactly the ceiling restores', async (type) => {
    const res = await restore(type, paddedBackup(CEILING));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ restored: true, tables: 0, rows: 0 });
  });

  it.each(BODY_TYPES)('%s: one byte over the ceiling is refused, today as a 500', async (type) => {
    const res = await restore(type, paddedBackup(CEILING + 1));
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal error' });
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
