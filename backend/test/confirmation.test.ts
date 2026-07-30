/**
 * The confirmation step (ROADMAP 5.3): an upload no longer makes its rows the
 * user's data. It stages them and answers with a summary; Confirm is what writes.
 *
 * The two assertions this file exists for are the first and the fourth. **Nothing
 * reads a staged row** - and that is held by the table boundary, not by a filter, so
 * the sweep below is a statement about the design rather than about twenty WHERE
 * clauses. **Discarding an import cannot take a row another import was told already
 * existed** - a staged row claims no dedup key, so the scenario cannot be built.
 *
 * PGlite is single-connection (CLAUDE.md), so nothing here exercises two confirms
 * racing; the sequential case is asserted, and TEST_DATABASE_URL is what runs the
 * rest against a real server.
 */
import fs from 'fs/promises';
import path from 'path';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  confirmImport,
  createImport,
  dbInstance,
  discardImport,
  exportBackup,
  failImport,
  getAccount,
  listAccounts,
  listImports,
  listRecurringGroups,
  listTransactions,
  parseBackup,
  restoreBackup,
  stageImport,
  summaryMonthlyTotals,
  summaryTotals,
  supersedeStagedImports,
} from '../src/db';
import { ImportSummary, importStatement } from '../src/providers/statement';
import { storageRoot } from '../src/storage';
import { TEST_WORKSPACE_ID } from './pglite';

const csvFile = (...rows: string[]): string => ['date,amount,description', ...rows].join('\n');

/** The same row repeated n times - one dedup group, ordinals 1..n. */
const repeated = (n: number, row: string, tag = ''): string =>
  csvFile(...Array.from({ length: n }, (_, i) => `${row}${tag ? ` ${tag}${i}` : ''}`));

async function upload(accountName: string, csv: string): Promise<ImportSummary> {
  const result = await importStatement({
    accountName,
    currency: 'EUR',
    bytes: Buffer.from(csv, 'utf8'),
  });
  if (result.outcome !== 'awaiting_confirmation') {
    throw new Error(`expected a summary, got ${JSON.stringify(result)}`);
  }
  return result.summary;
}

/** How many rows this import still has waiting - 0 once it is confirmed or discarded. */
async function stagedCount(importId: string): Promise<number> {
  const res = (await dbInstance().execute(
    sql`SELECT COUNT(*) AS n FROM staged_transactions
        WHERE workspace_id = ${TEST_WORKSPACE_ID} AND import_id = ${importId}`,
  )) as unknown as { rows: { n: string }[] };
  return Number(res.rows[0].n);
}

const importRow = async (id: string) => (await listImports(500)).find((i) => i.id === id);

const blobExists = (importId: string): Promise<boolean> =>
  fs
    .access(path.join(storageRoot(), TEST_WORKSPACE_ID, importId))
    .then(() => true)
    .catch(() => false);

const JAN = '2026-01-01T00:00:00.000Z';
const DEC = '2026-12-31T23:59:59.999Z';

describe('an unconfirmed import is not the user’s data', () => {
  /**
   * First in the file on purpose: it asserts on totals over the whole workspace, so
   * it has to run before anything else here has confirmed a row.
   */
  it('is invisible to every read path there is', async () => {
    const summary = await upload(
      'Invisible Bank',
      csvFile('2026-02-01,-40.00,Staged rent', '2026-02-02,-2.50,Staged coffee'),
    );

    expect(summary).toMatchObject({
      accountId: 'csv:invisible-bank',
      accountName: 'Invisible Bank',
      accountExists: false,
      total: 2,
      accepted: 2,
      skipped: 0,
      newRows: 2,
      alreadyPresent: 0,
      from: '2026-02-01',
      to: '2026-02-02',
      totals: [{ currency: 'EUR', net: -42.5 }],
      problems: [],
    });
    expect(summary.supersededImportId).toBeUndefined();

    expect(await listTransactions({ limit: 500 })).toHaveLength(0);
    expect(await summaryTotals(JAN, DEC)).toEqual({ expense: 0, income: 0 });
    expect(await summaryMonthlyTotals(JAN, DEC)).toEqual([]);
    expect(await listRecurringGroups(JAN)).toEqual([]);
    // no account either: one created at upload would stand on Overview with a
    // balance of 0 before the user confirmed, and outlive a discard
    expect(await listAccounts(true)).toHaveLength(0);
    expect(await getAccount(summary.accountId)).toBeUndefined();

    const backup = await exportBackup();
    expect(backup.tables.transactions).toEqual([]);
    expect(backup.tables.staged_transactions).toBeUndefined();

    // the import itself is visible, and honest about owning nothing
    expect(await importRow(summary.importId)).toMatchObject({
      status: 'awaiting_confirmation',
      rowsAccepted: 2,
      rowsRejected: 0,
      transactions: 0,
    });
    expect(await stagedCount(summary.importId)).toBe(2);
  });

  it('confirm answers with what landed, and the account appears with its balance', async () => {
    const summary = await upload(
      'Confirm Bank',
      csvFile('2026-03-01,-10.00,Confirmed one', '2026-03-02,-20.00,Confirmed two'),
    );
    const result = await confirmImport(summary.importId);

    expect(result).toEqual({
      confirmed: true,
      accountId: 'csv:confirm-bank',
      accountIds: ['csv:confirm-bank'],
      inserted: 2,
      rowsAccepted: 2,
      rowsRejected: 0,
    });
    expect(await listTransactions({ accountId: 'csv:confirm-bank' })).toHaveLength(2);
    // the balance is recomputed inside the confirm transaction: nothing else ever
    // recomputes it, so a window that ended before it would leave 0 for good
    expect((await getAccount('csv:confirm-bank'))!.balance).toBe(-30);
    expect(await stagedCount(summary.importId)).toBe(0);
    expect(await importRow(summary.importId)).toMatchObject({
      status: 'committed',
      transactions: 2,
    });
  });

  it('a second confirm inserts nothing and says why', async () => {
    const summary = await upload('Twice Confirmed Bank', csvFile('2026-03-05,-11.00,Once'));
    expect(await confirmImport(summary.importId)).toMatchObject({ confirmed: true, inserted: 1 });

    expect(await confirmImport(summary.importId)).toEqual({
      confirmed: false,
      reason: 'status',
      status: 'committed',
    });
    expect(await listTransactions({ accountId: 'csv:twice-confirmed-bank' })).toHaveLength(1);
  });

  it('confirming or discarding an import that does not exist answers nothing', async () => {
    expect(await confirmImport('no-such-import')).toBeUndefined();
    expect(await discardImport('no-such-import')).toBeUndefined();
  });
});

describe('discard', () => {
  it('drops the staged rows, keeps the document, and leaves the file re-uploadable', async () => {
    const csv = csvFile('2026-04-01,-30.00,Discarded one', '2026-04-02,-31.00,Discarded two');
    const first = await upload('Discard Bank', csv);
    expect(await blobExists(first.importId)).toBe(true);

    expect(await discardImport(first.importId)).toEqual({ discarded: true });
    expect(await stagedCount(first.importId)).toBe(0);
    // the row survives to reference the statement, and error_detail stays NULL: on a
    // discarded import that is what says the USER declined it
    expect(await importRow(first.importId)).toMatchObject({
      status: 'discarded',
      errorDetail: null,
      transactions: 0,
    });
    expect(await blobExists(first.importId)).toBe(true);
    expect(await listTransactions({ accountId: 'csv:discard-bank' })).toHaveLength(0);

    // only `committed` ever claimed the hash, so the same bytes go in again
    const second = await upload('Discard Bank', csv);
    expect(second.importId).not.toBe(first.importId);
    expect(second.supersededImportId).toBeUndefined();
    expect(await confirmImport(second.importId)).toMatchObject({ confirmed: true, inserted: 2 });
  });

  it('is idempotent, but refuses a committed import', async () => {
    const staged = await upload('Idempotent Discard Bank', csvFile('2026-04-05,-5.00,Gone'));
    expect(await discardImport(staged.importId)).toEqual({ discarded: true });
    // the requested state already holds - answering with an error about a goal
    // already achieved would be misreporting the result, not refusing loudly
    expect(await discardImport(staged.importId)).toEqual({ discarded: true });

    const live = await upload('Committed Discard Bank', csvFile('2026-04-06,-6.00,Real'));
    await confirmImport(live.importId);
    expect(await discardImport(live.importId)).toEqual({ discarded: false, status: 'committed' });
    // and nothing was done: a destructive-sounding request reported as done with the
    // rows still on every screen is the failure this refusal exists for
    expect(await listTransactions({ accountId: 'csv:committed-discard-bank' })).toHaveLength(1);
    expect(await importRow(live.importId)).toMatchObject({ status: 'committed' });
  });
});

describe('an outstanding import and a second upload of the same bytes', () => {
  /**
   * The file hash is claimed by `committed` alone (ROADMAP 4.3), so a staged import
   * must not make its own bytes answer "already imported" - with no imports-history
   * screen until roadmap item 10, re-uploading is the only way back to an import
   * whose tab was closed. The new upload supersedes the old one, and says so.
   */
  it('re-uploading is not refused: it supersedes the outstanding import', async () => {
    const csv = csvFile('2026-05-01,-14.00,Closed the tab');
    const abandoned = await upload('Superseded Bank', csv);
    const fresh = await upload('Superseded Bank', csv);

    expect(fresh.importId).not.toBe(abandoned.importId);
    expect(fresh.supersededImportId).toBe(abandoned.importId);
    expect(await importRow(abandoned.importId)).toMatchObject({ status: 'discarded' });
    expect(await stagedCount(abandoned.importId)).toBe(0);
    expect(await stagedCount(fresh.importId)).toBe(1);

    // the superseded one is terminal: it can never be confirmed
    expect(await confirmImport(abandoned.importId)).toEqual({
      confirmed: false,
      reason: 'status',
      status: 'discarded',
    });
    expect(await confirmImport(fresh.importId)).toMatchObject({ confirmed: true, inserted: 1 });
  });

  /**
   * On a `discarded` row error_detail is what separates the ways it can be reached,
   * and NULL means the person said no. A superseded row left empty would have the
   * imports screen (roadmap item 10) tell someone they rejected an import they never
   * saw, and it is also the only place a copy the user displaced can be told apart
   * from one they refused - which the retention purge will need.
   */
  it('a superseded import records that the server discarded it, not the user', async () => {
    const csv = csvFile('2026-05-02,-15.00,Reason recorded');
    const abandoned = await upload('Reason Bank', csv);
    await upload('Reason Bank', csv);
    expect((await importRow(abandoned.importId))?.errorDetail).toMatch(/superseded/);

    const declined = await upload('Declined Bank', csvFile('2026-05-03,-16.00,Declined'));
    expect(await discardImport(declined.importId)).toEqual({ discarded: true });
    expect((await importRow(declined.importId))?.errorDetail).toBeNull();
  });

  /**
   * The other half of the same race, and the damaging one. `id <> exceptId` is
   * symmetric: A stages, B stages, then A's supersede runs late and matches B while
   * B's has already taken A - both `discarded`, nothing confirmable, and the file
   * needs a third upload. Reproduced by calling the late supersede by hand, because
   * PGlite is single-connection (CLAUDE.md) and the state is what matters, not the
   * timing that produces it.
   */
  it('a late supersede cannot take the import that replaced it', async () => {
    const csv = csvFile('2026-05-04,-17.00,Mutual');
    const first = await upload('Mutual Bank', csv);
    const second = await upload('Mutual Bank', csv);
    const fileHash = (await importRow(first.importId))!.fileHash;

    expect(await supersedeStagedImports(fileHash, first.importId)).toEqual([]);
    expect(await importRow(second.importId)).toMatchObject({ status: 'awaiting_confirmation' });
    expect(await stagedCount(second.importId)).toBe(1);
    expect(await confirmImport(second.importId)).toMatchObject({ confirmed: true, inserted: 1 });
  });

  /**
   * Two uploads of one file that overlap in time both look for an outstanding import
   * of that hash while the other is still `pending`, both find none, and both reach
   * `awaiting_confirmation`. The second Confirm then meets imports_file_hash_unique
   * rather than the status check, and its whole transaction rolls back.
   *
   * Built by hand rather than by racing: PGlite is single-connection (CLAUDE.md), so
   * a real race is not reproducible in the default run, while the state it produces
   * is. What must not happen is a 500 on the one screen whose job is telling the user
   * whether their data landed.
   */
  it('a second staged copy of the same file answers 409, not a driver error', async () => {
    const csv = csvFile('2026-05-09,-25.00,Raced');
    const first = await upload('Raced Bank', csv);
    const fileHash = (await importRow(first.importId))!.fileHash;

    const second = await createImport({ fileHash, sourceType: 'csv', parserVersion: 1 });
    await stageImport(
      second.id,
      [
        {
          accountId: 'csv:raced-bank',
          provider: 'upload',
          amount: -25,
          currency: 'EUR',
          date: '2026-05-09',
          description: 'Raced',
          category: 'other',
        },
      ],
      0,
      { name: 'Raced Bank', currency: 'EUR' },
    );

    expect(await confirmImport(first.importId)).toMatchObject({ confirmed: true, inserted: 1 });
    expect(await confirmImport(second.id)).toEqual({
      confirmed: false,
      reason: 'file-committed',
      heldBy: first.importId,
    });
    // the loser is left where it was - the server does not discard on the user's
    // behalf here - and its rows never landed twice
    expect(await importRow(second.id)).toMatchObject({ status: 'awaiting_confirmation' });
    expect(await listTransactions({ accountId: 'csv:raced-bank' })).toHaveLength(1);
    expect(await discardImport(second.id)).toEqual({ discarded: true });
  });
});

/**
 * ROADMAP 5.3's Q1, the scenario the staging table exists to make impossible.
 *
 * With unconfirmed rows in `transactions` they would occupy (account, dedup_key):
 * an import uploaded while an unconfirmed one overlapped it would insert nothing for
 * those rows and honestly report them as already present, and discarding the first
 * would then delete rows the second was told existed. Two green imports, no error,
 * missing transactions.
 */
describe('a discarded import cannot take another import’s rows', () => {
  const coffee = (n: number, tag: string) => repeated(n, '2026-06-01,-3.50,Espresso', tag);

  it('B keeps every row it reported after A is discarded', async () => {
    const a = await upload('Q1 Bank', coffee(2, 'a'));
    // B overlaps A entirely and adds one: with A staged it sees only confirmed data
    const b = await upload('Q1 Bank', coffee(3, 'b'));
    expect(b.newRows).toBe(3);
    expect(await confirmImport(b.importId)).toMatchObject({ confirmed: true, inserted: 3 });

    expect(await discardImport(a.importId)).toEqual({ discarded: true });
    expect(await listTransactions({ accountId: 'csv:q1-bank' })).toHaveLength(3);
  });

  it('and confirming A afterwards honestly reports what was left to insert', async () => {
    const a = await upload('Q1 Late Bank', coffee(2, 'la'));
    const b = await upload('Q1 Late Bank', coffee(3, 'lb'));
    await confirmImport(b.importId);

    // A's two rows are now B's; the ordinary overlapping-statement case
    expect(await confirmImport(a.importId)).toMatchObject({
      confirmed: true,
      inserted: 0,
      rowsAccepted: 2,
    });
    expect(await listTransactions({ accountId: 'csv:q1-late-bank' })).toHaveLength(3);
    // and A owns nothing, which is what accountIds says
    expect(await confirmImport(b.importId)).toMatchObject({ confirmed: false });
  });
});

/**
 * The preview counter (`newRows`) is the only number a person reads before pressing
 * Confirm. The dedup key carries an ordinal within its group, so it is right only if
 * the numbering the preview did matches the numbering the confirm does - which is
 * why one function produces both (claimedKeys in db/index.ts).
 */
describe('the preview count is exactly what the confirm inserts', () => {
  const espresso = (n: number, tag: string) => repeated(n, '2026-07-01,-4.25,Latte', tag);

  it('more incoming than present', async () => {
    const seed = await upload('Preview Bank', espresso(2, 's'));
    await confirmImport(seed.importId);

    const more = await upload('Preview Bank', espresso(5, 'm'));
    expect(more).toMatchObject({ accepted: 5, newRows: 3, alreadyPresent: 2 });
    const result = await confirmImport(more.importId);
    expect(result).toMatchObject({ confirmed: true, inserted: more.newRows });
    expect(await listTransactions({ accountId: 'csv:preview-bank' })).toHaveLength(5);
  });

  it('fewer incoming than present', async () => {
    const seed = await upload('Preview Fewer Bank', espresso(5, 'sf'));
    await confirmImport(seed.importId);

    const fewer = await upload('Preview Fewer Bank', espresso(2, 'ff'));
    expect(fewer).toMatchObject({ accepted: 2, newRows: 0, alreadyPresent: 2 });
    const result = await confirmImport(fewer.importId);
    expect(result).toMatchObject({ confirmed: true, inserted: fewer.newRows });
    expect(await listTransactions({ accountId: 'csv:preview-fewer-bank' })).toHaveLength(5);
  });
});

describe('the confirm refuses what it cannot honestly complete', () => {
  /**
   * `awaiting_confirmation` means the complete staged set is present. Held first by
   * stageImport writing the rows and the status in one transaction, and then by this
   * - without which the invariant would rest on that never being reordered, and its
   * failure would read as "imported 1 row" under a summary that promised 2.
   */
  it('a staged set that lost a row is refused, not partially imported', async () => {
    const summary = await upload(
      'Partial Bank',
      csvFile('2026-08-01,-8.00,Kept', '2026-08-02,-9.00,Lost'),
    );
    await dbInstance().execute(
      sql`DELETE FROM staged_transactions
          WHERE workspace_id = ${TEST_WORKSPACE_ID} AND import_id = ${summary.importId}
            AND row_no = 1`,
    );

    await expect(confirmImport(summary.importId)).rejects.toThrow(
      new RegExp(`import ${summary.importId} was staged with 2 rows and 1 are present`),
    );
    // the whole transaction rolled back: still confirmable, nothing written
    expect(await importRow(summary.importId)).toMatchObject({
      status: 'awaiting_confirmation',
    });
    expect(await listTransactions({ accountId: 'csv:partial-bank' })).toHaveLength(0);
  });

  /**
   * account_name is nullable because every import from before this step is. Taken as
   * `?? ''` it slugifies to `csv:account` - a real import landing in an account the
   * user never named, reported as a success.
   */
  it('an import with no recorded account name is refused', async () => {
    const summary = await upload('Nameless Bank', csvFile('2026-08-05,-12.00,Nameless'));
    await dbInstance().execute(
      sql`UPDATE imports SET account_name = NULL
          WHERE workspace_id = ${TEST_WORKSPACE_ID} AND id = ${summary.importId}`,
    );

    await expect(confirmImport(summary.importId)).rejects.toThrow(
      /records no account name or currency/,
    );
    expect(await getAccount('csv:account')).toBeUndefined();
    expect(await importRow(summary.importId)).toMatchObject({
      status: 'awaiting_confirmation',
    });
  });

  /**
   * stageImport takes the rows and the account name as independent arguments, there
   * is no foreign key from transactions.account_id to accounts.id, and the confirm
   * re-derives the account from imports.account_name. A caller whose rows were built
   * for another account would otherwise get an account nobody's rows join, rows
   * against an account with no row, and the balance of the empty one recomputed - all
   * answered as confirmed. Today's one caller cannot produce it; item 6's PDF path is
   * the second caller this guard exists for.
   */
  it('staged rows built for another account are refused, not written', async () => {
    const summary = await upload('Guard Bank', csvFile('2026-08-10,-11.00,Elsewhere'));
    await dbInstance().execute(
      sql`UPDATE staged_transactions SET account_id = 'csv:somewhere-else'
          WHERE workspace_id = ${TEST_WORKSPACE_ID} AND import_id = ${summary.importId}`,
    );

    await expect(confirmImport(summary.importId)).rejects.toThrow(
      /recorded against account csv:guard-bank but staged a row for csv:somewhere-else/,
    );
    expect(await getAccount('csv:guard-bank')).toBeUndefined();
    expect(await getAccount('csv:somewhere-else')).toBeUndefined();
    expect(await importRow(summary.importId)).toMatchObject({
      status: 'awaiting_confirmation',
    });
  });
});

/**
 * A throw *after* the stage committed - the supersede, a read, anything between there
 * and the response - leaves a `failed` import. `failed` is neither confirmable nor
 * discardable, so its staged rows would sit unreachable until deleteImport, which has
 * no button until roadmap item 10. The sweep is in failImport rather than the caller's
 * catch so that no future caller has to remember it.
 */
describe('a failed import leaves no staged rows behind', () => {
  it('failImport takes them with the status', async () => {
    const summary = await upload('Swept Bank', csvFile('2026-08-20,-13.00,Swept away'));
    expect(await stagedCount(summary.importId)).toBe(1);

    await failImport(summary.importId, 'something threw after the stage');

    expect(await stagedCount(summary.importId)).toBe(0);
    expect(await importRow(summary.importId)).toMatchObject({ status: 'failed' });
    // the document is kept either way - that is what a failed import is retained for
    expect(await blobExists(summary.importId)).toBe(true);
  });
});

describe('backup and restore', () => {
  /**
   * staged_transactions is not a backup table, so an `awaiting_confirmation` import
   * would arrive with nothing behind it: an import whose Confirm inserts zero rows
   * and reports success. It lands as `discarded` instead, and error_detail is what
   * separates that from a discard the user actually performed.
   */
  it('an import awaiting confirmation is restored as discarded, with the reason', async () => {
    const staged = await upload('Restored Bank', csvFile('2026-09-01,-19.00,Was waiting'));
    const declined = await upload('Declined Bank', csvFile('2026-09-02,-20.00,Was declined'));
    await discardImport(declined.importId);

    await restoreBackup(parseBackup(JSON.parse(JSON.stringify(await exportBackup()))));

    const restored = (await importRow(staged.importId))!;
    expect(restored.status).toBe('discarded');
    expect(restored.errorDetail).toMatch(/still awaiting confirmation when the backup was taken/);
    expect(await stagedCount(staged.importId)).toBe(0);
    expect(await confirmImport(staged.importId)).toEqual({
      confirmed: false,
      reason: 'status',
      status: 'discarded',
    });

    // the other direction, so the user-discard side cannot quietly start writing
    // something here later: item 10's screen reads error_detail === null as "the
    // person said no"
    expect(await importRow(declined.importId)).toMatchObject({
      status: 'discarded',
      errorDetail: null,
    });
  });

  /** The composite cascade: deleting the imports rows takes the staged ones too. */
  it('a restore leaves no staged rows behind', async () => {
    const record = await createImport({
      fileHash: 'restore-cascade',
      sourceType: 'csv',
      parserVersion: 1,
    });
    await stageImport(
      record.id,
      [
        {
          accountId: 'csv:cascade-bank',
          provider: 'upload',
          amount: -1.5,
          currency: 'EUR',
          date: '2026-09-09',
          description: 'cascade',
          category: 'other',
        },
      ],
      0,
      { name: 'Cascade Bank', currency: 'EUR' },
    );
    expect(await stagedCount(record.id)).toBe(1);

    // a backup carrying an empty imports table: the restore's DELETE FROM imports is
    // all there is, and the staged rows have to go with it. No new delete is written
    // anywhere - the composite foreign key is what does this
    await restoreBackup(parseBackup({ format: 'finto-backup', version: 1, tables: { imports: [] } }));
    expect(await stagedCount(record.id)).toBe(0);
  });
});
