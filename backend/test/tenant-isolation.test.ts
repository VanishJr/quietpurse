/**
 * Two workspaces on one server must not see each other's data. This is the
 * Definition of Done for B2, and the assertion that matters most in the whole
 * suite: every query in src/db/index.ts carries a workspace filter, and a single
 * one forgotten would leak somebody's finances.
 *
 * The tests below therefore sweep the data layer broadly rather than deeply -
 * one assertion per family of queries (rows, singletons, aggregates, rules,
 * catalogues), because the risk is a missed WHERE clause somewhere, not a subtle
 * bug in any one of them.
 *
 * The set of tables exercised here is kept equal to BACKUP_TABLES (src/db/index.ts):
 * a lost WHERE in a table that reaches the backup puts one workspace's rows in
 * another workspace's export file.
 */
import crypto from 'crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  type ResolvedAccountId,
  addCategoryRule,
  createAccount,
  findAccountByName,
  updateAccount,
  addTransferRule,
  baselineTotal,
  clearImportDocument,
  confirmImport,
  createImport,
  discardImport,
  dbInstance,
  deleteImport,
  exportBackup,
  findCommittedImportByHash,
  getFxRate,
  getImportDocumentRef,
  listImports,
  getMeta,
  getSetting,
  getTransaction,
  insertTransactions,
  stageImport,
  listAccounts,
  listBaselineItems,
  listBudgets,
  listCategoryRules,
  listIncomeSources,
  listRecurringGroups,
  listTransactions,
  listTransferRules,
  recordImportDocument,
  resolveUploadAccountId,
  runWithWorkspace,
  saveFxRate,
  seedDefaults,
  setBudget,
  setMeta,
  setOneOff,
  setRecurringIgnored,
  setSetting,
  setTransferOverride,
  summaryByCategory,
  summaryTotals,
  upsertAccount,
  upsertBaselineItem,
  upsertIncomeSource,
} from '../src/db';
import { getDocument, putDocument } from '../src/documents';
import { ACCOUNT_NOT_FOUND, importStatement } from '../src/providers/statement';
import { markImportCommitted } from './helpers';
import { buildPdf } from './pdffixture';
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
  fee: null,
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

/** The one (date, currency) both workspaces store a rate for, at different values. */
const FX_DAY = '2026-05-05';
const FX_CURRENCY = 'CHF';

/** The description both workspaces' recurring payment carries - one recurringKey. */
const SHARED_RECURRING = 'Shared Subscription Ltd';

/** Both workspaces import a file with the same hash - see the imports test below. */
const SHARED_FILE_HASH = 'the-same-statement-pdf';
let myImportId = '';
let theirImportId = '';

/**
 * A committed import of the shared file. Fabricated rather than staged and
 * confirmed: a real confirm creates an account and a transaction, and the
 * assertions below count exactly what each workspace can see. The confirmation
 * lifecycle has its own suite (confirmation.test.ts).
 */
async function importOf(label: string): Promise<string> {
  const record = await createImport({
    fileHash: SHARED_FILE_HASH,
    sourceType: 'csv',
    parserVersion: 1,
    originalFilename: `${label}.csv`,
  });
  await markImportCommitted(record.id, 1, 0);
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
    await saveFxRate(FX_DAY, FX_CURRENCY, 1.25);
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
    await saveFxRate(FX_DAY, FX_CURRENCY, 42);
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

  /**
   * The account identity queries this row added, all four scoped by the same
   * mechanism. The last leg is the one worth having: accounts_name_unique is
   * per workspace, so two workspaces naming an account the same is legal - and a
   * global index would have made one user's account name refuse another's.
   */
  it('accounts: a name is neither readable nor writable across workspaces', async () => {
    let outstandingId: string | undefined;
    try {
      await runWithWorkspace(TEST_WORKSPACE_ID, async () => {
        expect(await findAccountByName('Theirs')).toBeUndefined();
        expect((await findAccountByName('Mine'))!.id).toBe('acc-shared-id');
        // the ids collide on purpose, so a rename that lost its workspace clause
        // would rename the other workspace's account instead of answering 404
        expect(await updateAccount('acc-shared-id', { name: 'Mine Renamed' })).toMatchObject({
          ok: true,
          account: { name: 'Mine Renamed' },
        });
      });
      await runWithWorkspace(OTHER, async () => {
        expect((await findAccountByName('Theirs'))!.currency).toBe('USD');
        expect(await findAccountByName('Mine Renamed')).toBeUndefined();
        // and the same name in both workspaces is not a collision: the index is
        // (workspace_id, lower(name))
        const created = await createAccount({ name: 'Mine Renamed', currency: 'USD' });
        expect(created).toMatchObject({ ok: true });
        expect(await runWithWorkspace(TEST_WORKSPACE_ID, () => listAccounts(true))).toHaveLength(1);
      });

      // Branch (b) of the resolver, which no other case in the suite reaches with two
      // workspaces: an outstanding import's minted id is offered to a later upload of
      // the same name - within one workspace only. Without the clause on that query,
      // the neighbour's unconfirmed preview would decide where these rows land.
      const outstanding = await runWithWorkspace(TEST_WORKSPACE_ID, () =>
        createImport({
          fileHash: 'cross-workspace-resolution',
          sourceType: 'csv',
          parserVersion: 1,
        }),
      );
      outstandingId = outstanding.id;
      const minted = crypto.randomUUID() as ResolvedAccountId;
      await runWithWorkspace(TEST_WORKSPACE_ID, async () => {
        await stageImport(outstanding.id, [], 0, {
          id: minted,
          name: 'Unbanked',
          currency: 'EUR',
        });
        expect(await resolveUploadAccountId('Unbanked')).toBe(minted);
      });
      await runWithWorkspace(OTHER, async () => {
        expect(await resolveUploadAccountId('Unbanked')).not.toBe(minted);
      });
    } finally {
      // put all three fixture mutations back, so no test added to this file has to
      // know this one ran. Each is guarded, because a failure above can leave any of
      // them undone and a cleanup that throws would hide the failure that caused it.
      await runWithWorkspace(TEST_WORKSPACE_ID, async () => {
        if (outstandingId) await deleteImport(outstandingId);
        await updateAccount('acc-shared-id', { name: 'Mine' });
      });
      await runWithWorkspace(OTHER, async () => {
        const extra = await findAccountByName('Mine Renamed');
        if (extra) {
          await dbInstance().execute(
            sql`DELETE FROM accounts WHERE workspace_id = ${OTHER} AND id = ${extra.id}`,
          );
        }
      });
    }
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

  /**
   * A historical rate is universal, but the stored value is "base currency per
   * unit" and each workspace picks its own base - so the same (date, currency)
   * legally holds two different numbers. Both are asserted rather than one being
   * checked absent: an undefined-only assertion also passes if the write went
   * nowhere.
   */
  it('fx rates: the same date and currency hold each workspace own rate', async () => {
    await runWithWorkspace(TEST_WORKSPACE_ID, async () => {
      expect(await getFxRate(FX_DAY, FX_CURRENCY)).toBe(1.25);
    });
    await runWithWorkspace(OTHER, async () => {
      expect(await getFxRate(FX_DAY, FX_CURRENCY)).toBe(42);
    });
  });

  /**
   * recurring_ignores is keyed on a description, so both workspaces' groups hash
   * to the same key on purpose: the ignore lookup joins on that key alone and only
   * the workspace clause keeps our "hide this" out of the neighbour's Overview.
   * Both halves matter - a group that is merely absent from OTHER would also be
   * absent if the fixture had produced no group at all.
   */
  it('recurring ignores: hiding a group leaves the neighbour identical group visible', async () => {
    const recurring = (over: Partial<NewTransaction>): NewTransaction =>
      tx({ description: SHARED_RECURRING, amount: -19.99, date: '2026-06-15T10:00:00.000Z', ...over });
    try {
      // each workspace's own base currency, so insertTransactions fills
      // base_amount_cents - listRecurringGroups skips rows without it
      await runWithWorkspace(TEST_WORKSPACE_ID, () =>
        insertTransactions([recurring({ currency: 'EUR' })]),
      );
      await runWithWorkspace(OTHER, () => insertTransactions([recurring({ currency: 'USD' })]));
      // insertTransactions does not set `recurring` - detection is the classifier's
      await dbInstance().execute(
        sql`UPDATE transactions SET recurring = true WHERE description = ${SHARED_RECURRING}`,
      );

      await runWithWorkspace(TEST_WORKSPACE_ID, () =>
        setRecurringIgnored(SHARED_RECURRING, true),
      );

      await runWithWorkspace(TEST_WORKSPACE_ID, async () => {
        const ours = (await listRecurringGroups(JAN)).find(
          (g) => g.description === SHARED_RECURRING,
        );
        expect(ours).toMatchObject({ ignored: true });
      });
      await runWithWorkspace(OTHER, async () => {
        const theirs = (await listRecurringGroups(JAN)).find(
          (g) => g.description === SHARED_RECURRING,
        );
        expect(theirs).toMatchObject({ ignored: false });
      });
    } finally {
      await runWithWorkspace(TEST_WORKSPACE_ID, () =>
        setRecurringIgnored(SHARED_RECURRING, false),
      );
      // later cases assert exact transaction counts and lists, so this fixture
      // must not outlive the case that created it
      await dbInstance().execute(
        sql`DELETE FROM transactions WHERE description = ${SHARED_RECURRING}`,
      );
    }
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

  /**
   * The confirmation routes take an import id from the URL, which is the shape that
   * leaks: the primary key is (workspace_id, id), so the same id is legal in two
   * workspaces and a restored backup produces exactly that. Both answer "no such
   * import" - the conditional UPDATE matches nothing inside the workspace scope, so
   * an absent id and a foreign one are the same code path - and neither may move
   * the neighbour's row.
   */
  it('confirm and discard cannot reach another workspace import', async () => {
    const staged = await runWithWorkspace(OTHER, async () => {
      const record = await createImport({
        fileHash: 'cross-workspace-confirm',
        sourceType: 'csv',
        parserVersion: 1,
      });
      await stageImport(
        record.id,
        [tx({ accountId: 'csv:theirs-staged', provider: 'upload', description: 'theirs: staged' })],
        0,
        { id: 'csv:theirs-staged' as ResolvedAccountId, name: 'Theirs Staged', currency: 'EUR' },
      );
      return record.id;
    });

    await runWithWorkspace(TEST_WORKSPACE_ID, async () => {
      expect(await confirmImport(staged)).toBeUndefined();
      expect(await discardImport(staged)).toBeUndefined();
      expect(await listTransactions({ limit: 100 })).toHaveLength(2);
    });

    // still exactly as it was left: awaiting confirmation, its rows still staged
    await runWithWorkspace(OTHER, async () => {
      expect((await listImports()).find((i) => i.id === staged)!.status).toBe(
        'awaiting_confirmation',
      );
      const confirmed = await confirmImport(staged);
      expect(confirmed).toMatchObject({ confirmed: true, inserted: 1 });
      await deleteImport(staged);
    });
  });

  /**
   * Row 26a's confirm-side guard reads the accounts row by id, and two workspaces
   * may hold that id legally. Drop its workspace clause and the neighbour's hidden
   * account decides this confirm: the read finds it and these rows are refused for
   * an account this workspace never removed.
   *
   * Only one row carries the id, so there is nothing for the engine to choose
   * between: with the clause the read misses and the ordinary create path runs,
   * without it the read hits the neighbour's. The guard firing for a workspace's
   * own hidden account is confirmation.test.ts's, and is not repeated here.
   */
  it('a neighbour hidden account cannot refuse this workspace confirm', async () => {
    const shared = crypto.randomUUID();
    let importId: string | undefined;
    try {
      await runWithWorkspace(OTHER, async () => {
        await upsertAccount({
          id: shared,
          provider: 'upload',
          name: 'Theirs Removed',
          currency: 'USD',
          balance: 0,
        });
        expect(await updateAccount(shared, { hidden: true })).toMatchObject({ ok: true });
      });

      await runWithWorkspace(TEST_WORKSPACE_ID, async () => {
        const record = await createImport({
          fileHash: 'neighbour-hidden-account',
          sourceType: 'csv',
          parserVersion: 1,
        });
        importId = record.id;
        await stageImport(
          record.id,
          [
            tx({
              accountId: shared,
              provider: 'upload',
              description: 'mine: into an account only the neighbour hid',
              date: '2026-10-10T00:00:00.000Z',
            }),
          ],
          0,
          { id: shared as ResolvedAccountId, name: 'Mine Fresh', currency: 'EUR' },
        );
        expect(await confirmImport(record.id)).toMatchObject({ confirmed: true, inserted: 1 });
      });
    } finally {
      // both accounts and the import go back, so the counts every case above and
      // below asserts are the ones the fixture set up. Guarded, because a failure
      // above must not be hidden by a cleanup that throws.
      await runWithWorkspace(TEST_WORKSPACE_ID, async () => {
        if (importId) await deleteImport(importId);
      });
      await dbInstance().execute(
        sql`DELETE FROM accounts WHERE workspace_id IN (${TEST_WORKSPACE_ID}, ${OTHER})
            AND id = ${shared}`,
      );
    }
  });

  /**
   * The same clause on the other gate: resolveUploadAccount reads the accounts row by
   * the id the upload picked, and widen that filter and the neighbour's account
   * answers - the rows stage against it and land there on Confirm, in a workspace
   * that never saw it. Deleting the clause outright is held elsewhere, by
   * workspace-scope.test.ts, but only because currentWorkspaceId() stops being called
   * with it; a clause that is present and wrong is what this case sees.
   *
   * The neighbour's account is VISIBLE deliberately: against a hidden one both
   * refusals merely prove the read found or missed something, and the assertion stops
   * telling a scope failure apart from the removed-account one.
   */
  it('an account of the neighbour cannot be uploaded into by id', async () => {
    const shared = crypto.randomUUID();
    try {
      await runWithWorkspace(OTHER, () =>
        upsertAccount({
          id: shared,
          provider: 'upload',
          name: 'Theirs Visible',
          currency: 'USD',
          balance: 0,
        }),
      );

      await runWithWorkspace(TEST_WORKSPACE_ID, async () => {
        await expect(
          importStatement({
            accountId: shared,
            bytes: Buffer.from(
              'date,amount,description\n2026-10-11,-11.00,mine: into the neighbour account\n',
              'utf8',
            ),
          }),
        ).rejects.toThrow(ACCOUNT_NOT_FOUND);
      });
    } finally {
      // the refusal is above createImport, so there is no import to undo - only the
      // neighbour's account row, which the counts other cases assert would otherwise
      // include. Guarded, because a failure above must not be hidden by a cleanup
      // that throws.
      await dbInstance().execute(
        sql`DELETE FROM accounts WHERE workspace_id IN (${TEST_WORKSPACE_ID}, ${OTHER})
            AND id = ${shared}`,
      );
    }
  });

  /**
   * A stored document is reached through a key whose first segment is the CURRENT
   * workspace, never one read out of the row - so the second assertion here holds
   * even with the row-level guard bypassed on purpose.
   */
  it('a stored document is invisible and unreadable from another workspace', async () => {
    const statement = Buffer.from('date,amount,description\n2026-04-04,-7.00,Mine\n', 'utf8');
    // the fixture's imports were created with a fake file_hash, so the ref below is
    // built by hand - which is also what makes it a forgery when OTHER uses it
    const ref = {
      importId: myImportId,
      keyVersion: 1,
      fileHash: crypto.createHash('sha256').update(statement).digest('hex'),
    };

    await runWithWorkspace(TEST_WORKSPACE_ID, async () => {
      await recordImportDocument(myImportId, await putDocument(myImportId, statement));
      expect(await getImportDocumentRef(myImportId)).toMatchObject({ keyVersion: 1 });
      expect(await getDocument(ref)).toEqual(statement);
    });

    await runWithWorkspace(OTHER, async () => {
      expect(await getImportDocumentRef(myImportId)).toBeUndefined();
      await expect(getDocument(ref)).rejects.toThrow(/no bytes at/);
    });

    // the neighbour's attempt neither read nor damaged it
    await runWithWorkspace(TEST_WORKSPACE_ID, async () => {
      expect(await getDocument(ref)).toEqual(statement);
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

  /**
   * Last on purpose: it is the only case here that adds import rows, and the
   * assertions above count what each workspace can see.
   *
   * The primary key is (workspace_id, id), so the same import id in two
   * workspaces is legal - and it is what a restored backup produces, since
   * restoreBackup keeps the ids out of the file. recordImportDocument's UPDATE
   * must therefore be scoped by workspace, not by id alone. Dropping the clause
   * while keeping the currentWorkspaceId() call leaves every other test green:
   * the import's own row is still updated, and the damage lands on the
   * neighbour, which is what this asserts on.
   */
  it('recordImportDocument cannot touch a neighbour row carrying the same id', async () => {
    const SHARED = 'shared-import-id';
    const force = async (ws: string, from: string) => {
      await dbInstance().execute(
        sql`UPDATE imports SET id = ${SHARED} WHERE workspace_id = ${ws} AND id = ${from}`,
      );
    };
    const newImport = (fileHash: string, originalFilename: string) =>
      createImport({ fileHash, sourceType: 'csv', parserVersion: 1, originalFilename });

    await runWithWorkspace(OTHER, async () => {
      const theirs = await newImport('collide-theirs', 't.csv');
      await force(OTHER, theirs.id);
    });
    await runWithWorkspace(TEST_WORKSPACE_ID, async () => {
      const mine = await newImport('collide-mine', 'm.csv');
      await force(TEST_WORKSPACE_ID, mine.id);
      await recordImportDocument(SHARED, 1);
    });

    const stored = (await dbInstance().execute(
      sql`SELECT document_key_version FROM imports WHERE workspace_id = ${OTHER} AND id = ${SHARED}`,
    )) as unknown as { rows: { document_key_version: number | null }[] };
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0].document_key_version).toBeNull();
  });

  /**
   * The same shape one function later: clearImportDocument is the UPDATE the
   * document delete route runs, and an unscoped one would make the neighbour's row
   * stop claiming a document whose bytes are still on disk - the one state nothing
   * revisits. It is asserted here rather than in the route's own suite because the
   * damage lands on a workspace no request in that suite ever names.
   */
  it('clearImportDocument cannot touch a neighbour row carrying the same id', async () => {
    const SHARED = 'shared-clear-import-id';
    const force = async (ws: string, from: string) => {
      await dbInstance().execute(
        sql`UPDATE imports SET id = ${SHARED} WHERE workspace_id = ${ws} AND id = ${from}`,
      );
    };
    const claimed = async (ws: string): Promise<number | null> => {
      const rows = (await dbInstance().execute(
        sql`SELECT document_key_version FROM imports WHERE workspace_id = ${ws} AND id = ${SHARED}`,
      )) as unknown as { rows: { document_key_version: number | null }[] };
      expect(rows.rows).toHaveLength(1);
      return rows.rows[0].document_key_version;
    };

    for (const [ws, fileHash] of [
      [OTHER, 'clear-collide-theirs'],
      [TEST_WORKSPACE_ID, 'clear-collide-mine'],
    ] as const) {
      await runWithWorkspace(ws, async () => {
        const record = await createImport({ fileHash, sourceType: 'csv', parserVersion: 1 });
        await force(ws, record.id);
        await recordImportDocument(SHARED, 1);
      });
    }

    await runWithWorkspace(TEST_WORKSPACE_ID, () => clearImportDocument(SHARED));
    expect(await claimed(TEST_WORKSPACE_ID)).toBeNull();
    expect(await claimed(OTHER)).toBe(1);
  });

  /**
   * The PDF parser is the third async window between a request entering a workspace
   * context and its rows being written, and a WRONG context is this project's worst
   * defect class: the rows land in someone else's workspace and nothing throws (a
   * lost context throws, which is the safe failure).
   *
   * The argument that it cannot happen is structural rather than empirical: pdfjs
   * disables its worker under Node outright (`if (isNodeJS) this.#isWorkerDisabled
   * = true`, pdf.mjs in pdfjs-dist@6.2.108), so no callback is ever registered in
   * one request's context and invoked on behalf of another - which is the shape
   * item 4's multer defect had. What is shared is a lazily-created promise, and a
   * continuation after `await` resumes in the AWAITER's store, not the creator's.
   *
   * **What this test is worth, exactly:** it exercises context PROPAGATION across
   * the parse, in sequence. PGlite is single-connection and the suite is
   * sequential, so nothing here exercises concurrency and it would not catch a
   * race. The structural argument above is what covers the case it cannot reach.
   */
  it('two workspaces importing PDFs in sequence keep their rows to themselves', async () => {
    const pdf = (label: string, day: string, amount: string, closing: string): Buffer =>
      buildPdf([
        [
          { x: 39.7, y: 27.1, text: '© 2026 Revolut Bank UAB, Zweigniederlassung Deutschland' },
          { x: 42.7, y: 700, text: 'Дата' },
          { x: 124.8, y: 700, text: 'Описание' },
          { x: 335.1, y: 700, text: 'Списания' },
          { x: 417.1, y: 700, text: 'Пополнения' },
          { x: 42.7, y: 680, text: day },
          { x: 124.8, y: 680, text: label },
          { x: 335.1, y: 680, text: amount },
          // the balance summary the reconciliation gate checks against (rows 6b and
          // 035): 100,00 less the one debit, which is also the whole of the
          // outgoing half with nothing on the incoming one
          { x: 42.7, y: 640, text: 'Итого' },
          { x: 253.0, y: 640, text: '100,00€' },
          { x: 335.1, y: 640, text: amount },
          { x: 417.1, y: 640, text: '0,00€' },
          { x: 526.2, y: 640, text: closing },
        ],
      ]);

    const importPdf = async (workspace: string, bytes: Buffer): Promise<string> =>
      runWithWorkspace(workspace, async () => {
        // both workspaces are given an account of the same name AND the same id, so
        // the upload resolves by name onto a colliding id in each. Ids are UUIDs
        // now, so the collision has to be arranged - and arranging it is the point:
        // it is the case a query that forgot the workspace would get wrong
        await upsertAccount({
          id: 'acc-pdf-isolation',
          provider: 'upload',
          name: 'Pdf Isolation',
          currency: 'EUR',
          balance: 0,
        });
        const staged = await importStatement({
          accountName: 'Pdf Isolation',
          currency: 'EUR',
          bytes,
        });
        if (staged.outcome !== 'awaiting_confirmation') throw new Error('not staged');
        const confirmed = await confirmImport(staged.summary.importId);
        expect(confirmed?.confirmed).toBe(true);
        return staged.summary.accountId;
      });

    const mine = await importPdf(
      TEST_WORKSPACE_ID,
      pdf('Mine only', '4 июл. 2026г.', '11,11€', '88,89€'),
    );
    const theirs = await importPdf(
      OTHER,
      pdf('Theirs only', '5 июл. 2026г.', '22,22€', '77,78€'),
    );
    // the same account id in both, so a query that forgot the workspace would see
    // four rows rather than two
    expect(theirs).toBe(mine);

    for (const [workspace, own, other] of [
      [TEST_WORKSPACE_ID, 'Mine only', 'Theirs only'],
      [OTHER, 'Theirs only', 'Mine only'],
    ] as const) {
      await runWithWorkspace(workspace, async () => {
        const rows = await listTransactions({ accountId: mine, limit: 50 });
        expect(rows.map((t) => t.description)).toEqual([own]);
        expect(rows.every((t) => t.description !== other)).toBe(true);
      });
    }
  });
});
