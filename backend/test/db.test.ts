import { describe, expect, it } from 'vitest';
import {
  applyClassification,
  createImport,
  getTransaction,
  insertTransactions,
  listRecurringGroups,
  setOneOff,
  setRecurringIgnored,
  stageImport,
} from '../src/db';
import { NewTransaction } from '../src/types';
import { idOf } from './helpers';

const tx = (over: Partial<NewTransaction>): NewTransaction => ({
  accountId: 'acc1',
  provider: 'monobank',
  amount: -100,
  currency: 'EUR',
  date: '2026-01-10T12:00:00.000Z',
  description: 'test',
  category: 'other',
  fee: null,
  ...over,
});

describe('insertTransactions', () => {
  it('a provider reference deduplicates, and only against the same account', async () => {
    expect(await insertTransactions([tx({ dedupKey: 'mono:op-1' })])).toBe(1);
    expect(
      await insertTransactions([tx({ dedupKey: 'mono:op-1' }), tx({ dedupKey: 'mono:op-2' })]),
    ).toBe(1);
    // the same reference on another account is another transaction
    expect(await insertTransactions([tx({ dedupKey: 'mono:op-1', accountId: 'acc2' })])).toBe(1);
  });

  it('without a reference the key is computed, and the description is not in it', async () => {
    const row = { accountId: 'computed', date: '2026-04-01T09:00:00.000Z', amount: -12.5 };
    expect(await insertTransactions([tx({ ...row, description: 'ROSSMANN' })])).toBe(1);
    // a better parser produces a longer description for the same operation: still one row
    expect(await insertTransactions([tx({ ...row, description: 'ROSSMANN 4711 FILIALE' })])).toBe(
      0,
    );
    // ...and the row already there keeps the description it was stored with: a
    // duplicate is skipped, never merged (correcting facts belongs to ROADMAP 4.4)
    const stored = await getTransaction(await idOf('ROSSMANN'));
    expect(stored!.description).toBe('ROSSMANN');
  });

  it('the time of day is not in the key either - only the calendar day', async () => {
    const row = { accountId: 'sameday', amount: -4, description: 'coffee' };
    expect(await insertTransactions([tx({ ...row, date: '2026-05-02T08:00:00.000Z' })])).toBe(1);
    expect(await insertTransactions([tx({ ...row, date: '2026-05-02T19:30:00.000Z' })])).toBe(0);
  });

  it('identical rows in one batch are numbered, so both survive', async () => {
    const row = { accountId: 'twice', date: '2026-06-03T00:00:00.000Z', amount: -3.5 };
    expect(await insertTransactions([tx(row), tx(row)])).toBe(2);
    // and a re-import of the same pair adds nothing
    expect(await insertTransactions([tx(row), tx(row)])).toBe(0);
    // a third genuinely new one does get in
    expect(await insertTransactions([tx(row), tx(row), tx(row)])).toBe(1);
  });

  it('the ordinal is numbered across the whole batch, not per insert chunk', async () => {
    // chunking is at 1000 rows: 1500 identical rows must become 1500 transactions,
    // not 1000 followed by 500 collisions
    const row = { accountId: 'chunky', date: '2026-06-04T00:00:00.000Z', amount: -1 };
    const batch = Array.from({ length: 1500 }, () => tx(row));
    expect(await insertTransactions(batch)).toBe(1500);
    expect(await insertTransactions(batch)).toBe(0);
  });

  it('the base currency gets base_amount at once, the rest get null', async () => {
    await insertTransactions([
      tx({ amount: -50, currency: 'EUR', description: 'in euro' }),
      tx({ amount: -2000, currency: 'UAH', description: 'in hryvnia' }),
    ]);
    expect((await getTransaction(await idOf('in euro')))!.baseAmount).toBe(-50);
    expect((await getTransaction(await idOf('in hryvnia')))!.baseAmount).toBeUndefined();
  });
});

describe('setOneOff', () => {
  it('the mark lives in its own column and survives repeated calls', async () => {
    await insertTransactions([tx({ amount: -768, currency: 'EUR', description: 'a new laptop' })]);
    const id = await idOf('a new laptop');
    expect((await setOneOff(id, true))!.oneOff).toBe(true);
    expect((await setOneOff(id, false))!.oneOff).toBe(false);
    expect(await setOneOff('missing', true)).toBeUndefined();
  });
});

describe('hiding recurring groups', () => {
  it('ignored is set by the normalized key and can be cleared again', async () => {
    // three months of "rent" with a changing month in the description - one group
    await insertTransactions(
      [1, 2, 3].map((m) =>
        tx({
          accountId: 'rent-acc',
          amount: -900,
          currency: 'EUR',
          date: `2026-0${m}-01T00:00:00.000Z`,
          description: `Miete 0${m}/2026`,
        }),
      ),
    );
    await applyClassification(
      await Promise.all(
        [1, 2, 3].map(async (m) => ({
          id: await idOf(`Miete 0${m}/2026`),
          category: 'housing',
          transfer: false,
          refund: false,
          incomeSource: null,
          recurring: true,
        })),
      ),
    );

    const before = await listRecurringGroups('2026-01-01T00:00:00.000Z');
    const group = before.find((g) => g.description.startsWith('Miete'))!;
    expect(group.ignored).toBe(false);

    // hide by one spelling - the whole group hides (the key is normalized)
    await setRecurringIgnored('Miete 01/2026', true);
    const hidden = (await listRecurringGroups('2026-01-01T00:00:00.000Z')).find((g) =>
      g.description.startsWith('Miete'),
    )!;
    expect(hidden.ignored).toBe(true);

    await setRecurringIgnored('Miete 03/2026', false);
    const restored = (await listRecurringGroups('2026-01-01T00:00:00.000Z')).find((g) =>
      g.description.startsWith('Miete'),
    )!;
    expect(restored.ignored).toBe(false);
  });
});

/**
 * What Postgres itself refused. drizzle re-throws a driver error wrapped in a
 * "Failed query" one whose message names no constraint, so the name is read off the
 * cause - both drivers this suite runs on, PGlite and node-postgres, put it there
 * under the same two fields. A write that is accepted returns a string, which fails
 * the comparison rather than passing it by absence.
 */
type DriverError = { cause?: { code?: string; constraint?: string } };

const violated = async (write: Promise<unknown>): Promise<unknown> => {
  try {
    await write;
    return 'accepted';
  } catch (e) {
    const { code, constraint } = (e as DriverError).cause ?? {};
    return { code, constraint };
  }
};

/**
 * The column is the guard, and it was taken for a producer that does not exist yet:
 * 37b reads a fee off a PDF and never goes through readFee, so nothing else stands
 * between it and a negative fee (ROADMAP 37a, D2). The CHECK is declared in
 * schema.ts and emitted by drizzle-kit - a toolchain that stopped emitting it would
 * leave the migration without it, the guarantee gone, and every other test green.
 *
 * Through the data layer rather than raw SQL, and by the constraint's own name: a
 * renamed column that quietly dropped the check would still throw something.
 */
describe('a negative fee is refused by the column', () => {
  it('on transactions and on staged_transactions alike', async () => {
    const badFee = insertTransactions([tx({ fee: -0.01, description: 'bad fee' })]);
    expect(await violated(badFee)).toEqual({
      code: '23514',
      constraint: 'transactions_fee_cents_nonneg',
    });

    const record = await createImport({
      fileHash: 'negative-fee',
      sourceType: 'csv',
      parserVersion: 1,
    });
    expect(
      await violated(
        stageImport(record.id, [tx({ fee: -0.01, description: 'bad staged fee' })], 0, {
          name: 'Negative Fee Bank',
          currency: 'EUR',
        }),
      ),
    ).toEqual({ code: '23514', constraint: 'staged_transactions_fee_cents_nonneg' });

    // the sign is refused, not the column: a stated zero is a fact a file can carry
    expect(await insertTransactions([tx({ fee: 0, description: 'zero fee' })])).toBe(1);
  });
});
