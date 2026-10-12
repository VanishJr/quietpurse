/**
 * Deleting an import over HTTP. The data layer's delete, with its rows, ordinals and
 * stored file, is held in imports.test.ts. What this route adds is the count in the
 * answer and the recompute after the delete, because transfer pairing changes when the
 * other leg disappears. A surviving leg still tagged as a transfer is silently out of
 * every spending figure the person reads, after a delete that answered 200.
 */
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { seedDefaults } from '../src/db';
import { storageRoot } from '../src/storage';
import { Transaction } from '../src/types';
import { type Agent, serve } from './loopback';
import { freshTestDb } from './pglite';

/** The three rows the import under test owns; one of them is a transfer's outgoing leg. */
const LEG_OUT = 'ZZ Leg Out';
const OWNED = [LEG_OUT, 'ZZ Row Two', 'ZZ Row Three'];
/** The other import: the incoming leg, on another account and the same day, and a control row. */
const LEG_IN = 'ZZ Leg In';
const CONTROL = 'ZZ Control';

const statement = (lines: string[]): Buffer =>
  Buffer.from(['date,amount,description', ...lines].join('\n'), 'utf8');

const OWNED_CSV = statement([
  `2026-03-05,-50.00,${LEG_OUT}`,
  '2026-03-06,-11.00,ZZ Row Two',
  '2026-03-07,-12.00,ZZ Row Three',
]);
const OTHER_CSV = statement([`2026-03-05,50.00,${LEG_IN}`, `2026-03-08,-13.00,${CONTROL}`]);

let agent: Agent;
let ownedId: string;

const makeAccount = async (name: string): Promise<string> => {
  const res = await agent.post('/api/accounts').send({ name, currency: 'EUR' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
};

/** Through the door and confirmed, which is the path that recomputes the tags. */
const committed = async (accountId: string, file: Buffer): Promise<string> => {
  const staged = await agent
    .post('/api/imports')
    .field('accountId', accountId)
    .field('preset', 'generic')
    .attach('file', file, 'statement.csv');
  expect(staged.status, JSON.stringify(staged.body)).toBe(200);
  const importId = staged.body.summary.importId as string;
  const confirmed = await agent.post(`/api/imports/${importId}/confirm`);
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
  return importId;
};

const rows = async (): Promise<Transaction[]> => {
  const res = await agent.get('/api/transactions');
  expect(res.status).toBe(200);
  return res.body as Transaction[];
};

const one = async (description: string): Promise<Transaction> => {
  const found = (await rows()).filter((t) => t.description === description);
  expect(found, `expected exactly one "${description}"`).toHaveLength(1);
  return found[0];
};

const importIds = async (): Promise<string[]> => {
  const res = await agent.get('/api/imports');
  expect(res.status).toBe(200);
  return (res.body.imports as { id: string }[]).map((i) => i.id);
};

/**
 * Where the file for the upload sits, spelled out as import-documents.test.ts spells it.
 */
const blobExists = (importId: string): Promise<boolean> =>
  fs
    .access(path.join(storageRoot(), `statement_${importId}.csv`))
    .then(() => true)
    .catch(() => false);

beforeAll(async () => {
  await freshTestDb();
  await seedDefaults();
  agent = await serve(app);
  ownedId = await committed(await makeAccount('Deleted Bank'), OWNED_CSV);
  await committed(await makeAccount('Other Bank'), OTHER_CSV);
});

describe('DELETE /api/imports/:id', () => {
  it('answers 404 for an id no import has', async () => {
    const res = await agent.delete(`/api/imports/${crypto.randomUUID()}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'import not found' });
    expect((await rows()).map((t) => t.description).sort()).toEqual(
      [...OWNED, LEG_IN, CONTROL].sort(),
    );
  });

  it('removes the import, its rows and its file, and re-tags the leg it left behind', async () => {
    // the anchor for the recompute: both legs paired before the delete
    expect((await one(LEG_OUT)).transfer).toBe(true);
    expect((await one(LEG_IN)).transfer).toBe(true);
    expect(await blobExists(ownedId)).toBe(true);

    const res = await agent.delete(`/api/imports/${ownedId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ deleted: true, transactions: 3 });

    expect((await rows()).map((t) => t.description).sort()).toEqual([LEG_IN, CONTROL].sort());
    expect(await importIds()).not.toContain(ownedId);
    expect(await blobExists(ownedId)).toBe(false);
    // the recompute after the delete: a leg with nothing to pair with is not a transfer
    expect((await one(LEG_IN)).transfer).toBe(false);
  });
});
