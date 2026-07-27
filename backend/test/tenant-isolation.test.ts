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
  dbInstance,
  exportBackup,
  finishSyncLogEntry,
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
import { Transaction } from '../src/types';

/** The neighbour: a second workspace, populated with its own conflicting data. */
const OTHER = 'other-workspace';

const tx = (over: Partial<Transaction>): Transaction => ({
  id: 'iso-1',
  accountId: 'acc-shared-id',
  provider: 'monobank',
  amount: -100,
  currency: 'EUR',
  date: '2026-03-10T12:00:00.000Z',
  description: 'isolation test',
  category: 'other',
  ...over,
});

const JAN = '2026-01-01T00:00:00.000Z';
const DEC = '2026-12-31T23:59:59.999Z';

beforeAll(async () => {
  await dbInstance().execute(
    sql`INSERT INTO organization (id, name, created_at) VALUES (${OTHER}, ${OTHER}, now())
        ON CONFLICT (id) DO NOTHING`,
  );

  // Both workspaces deliberately use the SAME ids everywhere: account id,
  // transaction id, setting key, budget category, rule pattern. Composite
  // primary keys make that legal, and it is the case that would break if a
  // query filtered by id alone.
  await runWithWorkspace(TEST_WORKSPACE_ID, async () => {
    await upsertAccount({
      id: 'acc-shared-id',
      provider: 'monobank',
      name: 'Mine',
      currency: 'EUR',
      balance: 10,
    });
    await insertTransactions([
      tx({ id: 'shared-tx-id', amount: -100, description: 'mine: groceries' }),
      tx({ id: 'mine-only', amount: 500, description: 'mine: salary' }),
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
      tx({ id: 'shared-tx-id', amount: -7777, description: 'theirs: rent' }),
      tx({ id: 'theirs-only', amount: 4242, description: 'theirs: bonus' }),
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
  });
});

describe('workspace isolation', () => {
  it('transactions: neither workspace sees the other, same id included', async () => {
    await runWithWorkspace(TEST_WORKSPACE_ID, async () => {
      const all = await listTransactions({ limit: 100 });
      expect(all.map((t) => t.id).sort()).toEqual(['mine-only', 'shared-tx-id']);
      // the id exists in both workspaces - it must resolve to OUR row
      expect((await getTransaction('shared-tx-id'))!.amount).toBe(-100);
      expect(await getTransaction('theirs-only')).toBeUndefined();
    });
    await runWithWorkspace(OTHER, async () => {
      const all = await listTransactions({ limit: 100 });
      expect(all.map((t) => t.id).sort()).toEqual(['shared-tx-id', 'theirs-only']);
      expect((await getTransaction('shared-tx-id'))!.amount).toBe(-7777);
      expect(await getTransaction('mine-only')).toBeUndefined();
    });
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
        await setOneOff('shared-tx-id', true);
        await setTransferOverride('shared-tx-id', true);
      });
      await runWithWorkspace(OTHER, async () => {
        const theirs = (await getTransaction('shared-tx-id'))!;
        expect(theirs.oneOff).toBe(false);
        expect(theirs.transfer).toBe(false);
      });
    } finally {
      // put the row back: a transfer flag would drop it out of the aggregates the
      // next test sums, and no test here should depend on declaration order
      await runWithWorkspace(TEST_WORKSPACE_ID, async () => {
        await setOneOff('shared-tx-id', false);
        await setTransferOverride('shared-tx-id', null);
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

  it('a backup contains only the exporting workspace, with no workspace_id in it', async () => {
    const mine = await runWithWorkspace(TEST_WORKSPACE_ID, () => exportBackup());
    const ids = (mine.tables.transactions as { id: string }[]).map((t) => t.id).sort();
    expect(ids).toEqual(['mine-only', 'shared-tx-id']);
    // workspace_id is stripped on export: a backup can be restored into any workspace
    for (const rows of Object.values(mine.tables)) {
      for (const row of rows as Record<string, unknown>[]) {
        expect(row).not.toHaveProperty('workspaceId');
      }
    }
  });
});
