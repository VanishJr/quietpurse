/**
 * How the re-tag reaches the database.
 *
 * This used to be one UPDATE per row inside one transaction. That is correct against
 * a connection pool and it is a freeze against the embedded database, which has ONE
 * connection: every other query in the application queues behind the open
 * transaction, and the app answers nothing at all until the re-tag finishes. Neither
 * suite could see it - they run sequentially - and the node-postgres side never had
 * the property, so the change that introduced it was green on both drivers.
 *
 * What is held here is therefore the SHAPE and not only the result: the number of
 * statements has to be a function of the batch size and not of the row count, or the
 * defect comes back the next time somebody writes the obvious loop. The result is
 * held beside it, across the batch boundary, because a batching bug loses rows
 * quietly and every existing classify case fits inside one batch.
 */
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { CLASSIFY_BATCH, Classification, applyClassification, dbInstance, insertTransactions, seedDefaults } from '../src/db';
import { NewTransaction } from '../src/types';
import { freshTestDb } from './pglite';

const ROWS = CLASSIFY_BATCH * 2 + 7;

const tx = (n: number): NewTransaction => ({
  accountId: 'batch-acc',
  provider: 'monobank',
  amount: -1 - n / 100,
  currency: 'EUR',
  date: '2026-02-01T09:00:00.000Z',
  description: `Batching row ${n}`,
  category: 'other',
  fee: null,
});

/** Every row gets its own values, so a batch that reused its neighbour's is visible. */
const wanted = (id: string, n: number): Classification => ({
  id,
  category: n % 2 === 0 ? 'groceries' : 'transport',
  transfer: n % 3 === 0,
  refund: n % 5 === 0,
  incomeSource: n % 7 === 0 ? null : `source-${n % 4}`,
  recurring: n % 11 === 0,
});

describe('the re-tag writes in bounded batches', () => {
  let ids: { id: string; n: number }[];

  beforeAll(async () => {
    await freshTestDb();
    await seedDefaults();
    await insertTransactions(Array.from({ length: ROWS }, (_, i) => tx(i)));
    const rows = (await dbInstance().execute(
      sql`SELECT id, description FROM transactions ORDER BY description`,
    )) as unknown as { rows: { id: string; description: string }[] };
    ids = rows.rows.map((r) => ({ id: r.id, n: Number(r.description.replace('Batching row ', '')) }));
    expect(ids).toHaveLength(ROWS);
  });

  it('issues one statement per batch rather than one per row, and no transaction at all', async () => {
    const db = dbInstance();
    const execute = vi.spyOn(db, 'execute');
    const transaction = vi.spyOn(db, 'transaction');
    try {
      await applyClassification(ids.map(({ id, n }) => wanted(id, n)));
      expect(execute).toHaveBeenCalledTimes(Math.ceil(ROWS / CLASSIFY_BATCH));
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      execute.mockRestore();
      transaction.mockRestore();
    }
  });

  it('gives every row its own values, on both sides of a batch boundary', async () => {
    await applyClassification(ids.map(({ id, n }) => wanted(id, n)));
    const read = (await dbInstance().execute(
      sql`SELECT id, category, transfer, refund, income_source, recurring FROM transactions`,
    )) as unknown as {
      rows: {
        id: string;
        category: string;
        transfer: boolean;
        refund: boolean;
        income_source: string | null;
        recurring: boolean;
      }[];
    };
    expect(read.rows).toHaveLength(ROWS);
    const byId = new Map(read.rows.map((r) => [r.id, r]));
    for (const { id, n } of ids) {
      const want = wanted(id, n);
      // the driver's own boolean and null shapes are part of what is being checked:
      // this file is one of the ones the real-Postgres job reads differently
      expect(byId.get(id), `row ${n}`).toEqual({
        id,
        category: want.category,
        transfer: want.transfer,
        refund: want.refund,
        income_source: want.incomeSource,
        recurring: want.recurring,
      });
    }
  });
});
