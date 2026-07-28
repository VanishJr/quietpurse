/**
 * Two workspaces on one server must not see each other's data. This is the
 * Definition of Done for B2, and the assertion that matters most in the whole
 * suite: every query in src/db/index.ts carries a workspace filter, and a single
 * one forgotten would leak somebody's finances.
 *
 * The tests below therefore sweep the data layer broadly rather than deeply -
 * one assertion per family of queries (rows, singletons, aggregates, rules,
 * catalogues, journal), because the risk is a missed WHERE clause somewhere, not
 * a subtle bug in any one of them.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  addCategoryRule,
  addTransferRule,
  baselineTotal,
  commitImport,
  createImport,
  dbInstance,
  deleteImport,
  exportBackup,
  findCommittedImportByHash,
  finishSyncLogEntry,
  listImports,
  getMeta,
  getSetting,
  getTransaction,
  insertTransactions,
  listAccounts,
  listBaselineItems,
  listBudgets,
  listCategoryRules,
  listIncomeSources,
  listSyncJournal,
  listTransactions,
  listTransferRules,
  runWithWorkspace,
  seedDefaults,
  setBudget,
  setMeta,
  setOneOff,
  setSetting,
  setTransferOverride,
  startSyncLogEntry,
  summaryByCategory,
  summaryTotals,
  upsertAccount,
  upsertBaselineItem,
  upsertIncomeSource,
} from '../src/db';
import { TEST_WORKSPACE_ID } from './pglite';
import { NewTransaction } from '../src/types';

/** The neighbour: a second workspace, populated with its own conflicting data. */
const OTHER = 'other-workspace';

/** The id both workspaces' first row is forced to carry - see forceSharedId. */
const SHARED_TX_ID = 'shared-tx-id';

const tx = (over: Partial<NewTransaction>): NewTransaction => ({
  accountId: 'acc-shared-id',
  provider: 'monobank',
  amount: -100,
  currency: 'EUR',
  date: '2026-03-10T12:00:00.000Z',
  description: 'isolation test',
  category: 'other',
  ...over,
});

/**
 * Gives a workspace's row the SAME id its neighbour's row has. This is
 * deliberate, not a leftover: transaction ids are surrogate UUIDs now, so the
 * collision this suite is built to catch - a query that filters by id and forgets
 * the workspace - can no longer happen by accident, and a test that waits for it
 * to happen by accident proves nothing. So it is manufactured here, directly in
 * SQL, and every assertion below is then about the composite key doing its job.
 */
async function forceSharedId(workspaceId: string, description: string): Promise<void> {
  await dbInstance().execute(
    sql`UPDATE transactions SET id = ${SHARED_TX_ID}
        WHERE workspace_id = ${workspaceId} AND description = ${description}`,
  );
}

const JAN = '2026-01-01T00:00:00.000Z';
const DEC = '2026-12-31T23:59:59.999Z';

/** Both workspaces import a file with the same hash - see the imports test below. */
const SHARED_FILE_HASH = 'the-same-statement-pdf';
let myImportId = '';
let theirImportId = '';

async function importOf(label: string): Promise<string> {
  const record = await createImport({
    fileHash: SHARED_FILE_HASH,
    sourceType: 'csv',
    parserVersion: 1,
    originalFilename: `${label}.csv`,
  });
  await commitImport(record.id, 1, 0);
  return record.id;
}

beforeAll(async () => {
  await dbInstance().execute(
    sql`INSERT INTO organization (id, name, created_at) VALUES (${OTHER}, ${OTHER}, now())
        ON CONFLICT (id) DO NOTHING`,
  );

  // Both workspaces deliberately collide on everything they can: account id,
  // transaction id (forced, see forceSharedId), transaction dedup key, setting
  // key, budget category, rule pattern. Composite primary keys and
  // workspace-scoped unique indexes make that legal, and it is the case that
  // would break if a query filtered by id alone.
  await runWithWorkspace(TEST_WORKSPACE_ID, async () => {
    await upsertAccount({
      id: 'acc-shared-id',
      provider: 'monobank',
      name: 'Mine',
      currency: 'EUR',
      balance: 10,
    });
    await insertTransactions([
      tx({ amount: -100, description: 'mine: groceries' }),
      tx({ amount: 500, description: 'mine: salary' }),
    ]);
    await setSetting('base_currency', 'EUR');
    await setMeta('shared_key', 'mine');
    await setBudget('food', 200);
    await upsertBaselineItem('rent', 900);
    await addCategoryRule('shared-pattern', 'food');
    await addTransferRule('shared description', 'acc-shared-id');
    await upsertIncomeSource({ id: 'freelance', label: 'Mine freelance', kind: 'own' });
    const run = await startSyncLogEntry('2026-03-01T00:00:00.000Z');
    await finishSyncLogEntry(run, true, 2, [], ['mine']);
    myImportId = await importOf('mine');
  });

  await runWithWorkspace(OTHER, async () => {
    await seedDefaults();
    await upsertAccount({
      id: 'acc-shared-id',
      provider: 'monobank',
      name: 'Theirs',
      currency: 'USD',
      balance: 99,
    });
    await insertTransactions([
      tx({ amount: -7777, description: 'theirs: rent' }),
      tx({ amount: 4242, description: 'theirs: bonus' }),
    ]);
    await setSetting('base_currency', 'USD');
    await setMeta('shared_key', 'theirs');
    await setBudget('food', 5000);
    await upsertBaselineItem('rent', 3000);
    await addCategoryRule('shared-pattern', 'transport');
    await addTransferRule('shared description', 'acc-shared-id');
    await upsertIncomeSource({ id: 'freelance', label: 'Theirs freelance', kind: 'external' });
    const run = await startSyncLogEntry('2026-03-02T00:00:00.000Z');
    await finishSyncLogEntry(run, true, 2, [], ['theirs']);
    theirImportId = await importOf('theirs');
  });

  await forceSharedId(TEST_WORKSPACE_ID, 'mine: groceries');
  await forceSharedId(OTHER, 'theirs: rent');
});

describe('workspace isolation', () => {
  it('transactions: neither workspace sees the other, same id included', async () => {
    await runWithWorkspace(TEST_WORKSPACE_ID, async () => {
      const all = await listTransactions({ limit: 100 });
      expect(all.map((t) => t.description).sort()).toEqual(['mine: groceries', 'mine: salary']);
      // the id exists in both workspaces - it must resolve to OUR row
      expect((await getTransaction(SHARED_TX_ID))!.amount).toBe(-100);
      const theirsOnly = all.find((t) => t.description === 'theirs: bonus');
      expect(theirsOnly).toBeUndefined();
    });
    await runWithWorkspace(OTHER, async () => {
      const all = await listTransactions({ limit: 100 });
      expect(all.map((t) => t.description).sort()).toEqual(['theirs: bonus', 'theirs: rent']);
      expect((await getTransaction(SHARED_TX_ID))!.amount).toBe(-7777);
    });
  });

  /**
   * The dedup rule is UNIQUE (workspace_id, account_id, dedup_key). Drop the
   * workspace from it and two users importing the same statement would silently
   * be one user's data: the second import would be swallowed as a duplicate.
   */
  it('an identical transaction in two workspaces is two transactions', async () => {
    const row = tx({
      accountId: 'acc-collision',
      amount: -13.5,
      date: '2026-04-01T09:00:00.000Z',
      description: 'the very same coffee',
    });
    try {
      expect(await runWithWorkspace(TEST_WORKSPACE_ID, () => insertTransactions([row]))).toBe(1);
      // byte-for-byte the same row, and it is not ours - it must be inserted
      expect(await runWithWorkspace(OTHER, () => insertTransactions([row]))).toBe(1);
      // while within one workspace it still deduplicates
      expect(await runWithWorkspace(TEST_WORKSPACE_ID, () => insertTransactions([row]))).toBe(0);
    } finally {
      // the aggregates asserted below must not count this row
      await dbInstance().execute(
        sql`DELETE FROM transactions WHERE account_id = 'acc-collision'`,
      );
    }
  });

  it('accounts: the same account id is a different account in each workspace', async () => {
    await runWithWorkspace(TEST_WORKSPACE_ID, async () => {
      const accounts = await listAccounts(true);
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({ name: 'Mine', currency: 'EUR' });
    });
    await runWithWorkspace(OTHER, async () => {
      const accounts = await listAccounts(true);
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({ name: 'Theirs', currency: 'USD' });
    });
  });

  it('a write in one workspace cannot touch the other workspace row with the same id', async () => {
    try {
      await runWithWorkspace(TEST_WORKSPACE_ID, async () => {
        await setOneOff(SHARED_TX_ID, true);
        await setTransferOverride(SHARED_TX_ID, true);
      });
      await runWithWorkspace(OTHER, async () => {
        const theirs = (await getTransaction(SHARED_TX_ID))!;
        expect(theirs.oneOff).toBe(false);
        expect(theirs.transfer).toBe(false);
      });
    } finally {
      // put the row back: a transfer flag would drop it out of the aggregates the
      // next test sums, and no test here should depend on declaration order
      await runWithWorkspace(TEST_WORKSPACE_ID, async () => {
        await setOneOff(SHARED_TX_ID, false);
        await setTransferOverride(SHARED_TX_ID, null);
      });
    }
  });

  it('singletons (settings, meta) are per workspace, not per server', async () => {
    await runWithWorkspace(TEST_WORKSPACE_ID, async () => {
      expect(await getSetting('base_currency')).toBe('EUR');
      expect(await getMeta('shared_key')).toBe('mine');
    });
    await runWithWorkspace(OTHER, async () => {
      expect(await getSetting('base_currency')).toBe('USD');
      expect(await getMeta('shared_key')).toBe('theirs');
    });
  });

  it('aggregates only add up the current workspace', async () => {
    await runWithWorkspace(TEST_WORKSPACE_ID, async () => {
      const totals = await summaryTotals(JAN, DEC);
      expect(totals.expense).toBe(100);
      expect(totals.income).toBe(500);
      const byCategory = await summaryByCategory(JAN, DEC);
      expect(byCategory.reduce((s, c) => s + c.total, 0)).toBe(100);
    });
    await runWithWorkspace(OTHER, async () => {
      const totals = await summaryTotals(JAN, DEC);
      expect(totals.expense).toBe(7777);
      expect(totals.income).toBe(4242);
    });
  });

  it('rules, budgets, baseline and income sources stay separate', async () => {
    await runWithWorkspace(TEST_WORKSPACE_ID, async () => {
      expect((await listCategoryRules()).map((r) => r.category)).toEqual(['food']);
      expect(await listTransferRules()).toHaveLength(1);
      expect(await listBudgets()).toEqual([{ category: 'food', monthly: 200 }]);
      expect(await listBaselineItems()).toHaveLength(1);
      expect(await baselineTotal()).toBe(900);
      const freelance = (await listIncomeSources()).find((s) => s.id === 'freelance');
      expect(freelance).toMatchObject({ label: 'Mine freelance', kind: 'own' });
    });
    await runWithWorkspace(OTHER, async () => {
      expect((await listCategoryRules()).map((r) => r.category)).toEqual(['transport']);
      expect(await listTransferRules()).toHaveLength(1);
      expect(await listBudgets()).toEqual([{ category: 'food', monthly: 5000 }]);
      expect(await baselineTotal()).toBe(3000);
      const freelance = (await listIncomeSources()).find((s) => s.id === 'freelance');
      expect(freelance).toMatchObject({ label: 'Theirs freelance', kind: 'external' });
    });
  });

  it('the sync journal is per workspace', async () => {
    await runWithWorkspace(TEST_WORKSPACE_ID, async () => {
      const runs = await listSyncJournal(10);
      expect(runs).toHaveLength(1);
      expect(runs[0].log).toEqual(['mine']);
    });
    await runWithWorkspace(OTHER, async () => {
      const runs = await listSyncJournal(10);
      expect(runs).toHaveLength(1);
      expect(runs[0].log).toEqual(['theirs']);
    });
  });

  /**
   * The two imports share a file hash on purpose: the unique index behind the
   * "already imported" check is workspace-scoped, so two people uploading the
   * same statement must both get their own import - and neither may reach the
   * other's, least of all with the delete that takes transactions with it.
   */
  it('imports are invisible and undeletable from another workspace', async () => {
    await runWithWorkspace(TEST_WORKSPACE_ID, async () => {
      expect((await listImports()).map((i) => i.id)).toEqual([myImportId]);
      expect((await findCommittedImportByHash(SHARED_FILE_HASH))!.id).toBe(myImportId);
      expect(await deleteImport(theirImportId)).toBeUndefined();
    });
    await runWithWorkspace(OTHER, async () => {
      expect((await listImports()).map((i) => i.id)).toEqual([theirImportId]);
      expect((await findCommittedImportByHash(SHARED_FILE_HASH))!.id).toBe(theirImportId);
      expect(await deleteImport(myImportId)).toBeUndefined();
    });
  });

  /** The composite foreign key: (workspace_id, import_id), not import_id alone. */
  it('a transaction cannot be attached to another workspace import', async () => {
    await expect(
      runWithWorkspace(TEST_WORKSPACE_ID, () =>
        insertTransactions(
          // its own dedup group, or it would be skipped as a duplicate and the
          // foreign key would never be reached
          [tx({ description: 'stolen provenance', amount: -4321, date: '2026-09-09T00:00:00.000Z' })],
          theirImportId,
        ),
      ),
    ).rejects.toThrow();
    await runWithWorkspace(TEST_WORKSPACE_ID, async () => {
      const all = await listTransactions({ limit: 100 });
      expect(all.find((t) => t.description === 'stolen provenance')).toBeUndefined();
    });
  });

  it('a backup contains only the exporting workspace, with no workspace_id in it', async () => {
    const mine = await runWithWorkspace(TEST_WORKSPACE_ID, () => exportBackup());
    const descriptions = (mine.tables.transactions as { description: string }[])
      .map((t) => t.description)
      .sort();
    expect(descriptions).toEqual(['mine: groceries', 'mine: salary']);
    // workspace_id is stripped on export: a backup can be restored into any workspace
    for (const rows of Object.values(mine.tables)) {
      for (const row of rows as Record<string, unknown>[]) {
        expect(row).not.toHaveProperty('workspaceId');
      }
    }
  });
});
