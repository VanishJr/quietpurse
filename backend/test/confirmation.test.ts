/**
 * The confirmation step: an upload no longer makes its rows the
 * user's data. It stages them and answers with a summary; Confirm is what writes.
 *
 * The two assertions this file exists for are the first and the fourth. **Nothing
 * reads a staged row** - and that is held by the table boundary, not by a filter, so
 * the sweep below is a statement about the design rather than about twenty WHERE
 * clauses. **Discarding an import cannot take a row another import was told already
 * existed** - a staged row claims no dedup key, so the scenario cannot be built.
 *
 * PGlite is single-connection, so nothing here exercises two confirms
 * racing; the sequential case is asserted, and TEST_DATABASE_URL is what runs the
 * rest against a real server.
 */
import fs from 'fs/promises';
import path from 'path';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  ERROR_DETAIL_MAX,
  type ResolvedAccountId,
  confirmImport,
  createAccount,
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
  updateAccount,
} from '../src/db';
import { ImportSummary, importStatement } from '../src/providers/statement';
import { storageRoot } from '../src/storage';
import { accountFor } from './helpers';

const csvFile = (...rows: string[]): string => ['date,amount,description', ...rows].join('\n');

/** The same row repeated n times - one dedup group, ordinals 1..n. */
const repeated = (n: number, row: string, tag = ''): string =>
  csvFile(...Array.from({ length: n }, (_, i) => `${row}${tag ? ` ${tag}${i}` : ''}`));

/**
 * A statement staged into the account of that name, made first if nothing has
 * not got one. Two uploads under one name go to one account, which is what the cases
 * about superseding and deduplication below are built on.
 */
async function upload(name: string, csv: string): Promise<ImportSummary> {
  return uploadTo(await accountFor(name), csv);
}

/** The account is picked, so the request carries no name and no currency. */
async function uploadTo(accountId: string, csv: string): Promise<ImportSummary> {
  const result = await importStatement({ accountId, bytes: Buffer.from(csv, 'utf8') });
  if (result.outcome !== 'awaiting_confirmation') {
    throw new Error(`expected a summary, got ${JSON.stringify(result)}`);
  }
  return result.summary;
}

/** How many rows this import still has waiting - 0 once it is confirmed or discarded. */
async function stagedCount(importId: string): Promise<number> {
  const res = (await dbInstance().execute(
    sql`SELECT COUNT(*) AS n FROM staged_transactions
        WHERE import_id = ${importId}`,
  )) as unknown as { rows: { n: string }[] };
  return Number(res.rows[0].n);
}

/** What the staged rows hold in fee_cents, in file order - raw, so nothing maps it back. */
async function stagedFeeCents(importId: string): Promise<(number | null)[]> {
  const res = (await dbInstance().execute(
    sql`SELECT fee_cents FROM staged_transactions
        WHERE import_id = ${importId}
        ORDER BY row_no`,
  )) as unknown as { rows: { fee_cents: number | null }[] };
  return res.rows.map((r) => r.fee_cents);
}

const importRow = async (id: string) =>
  (await listImports({ limit: 500 })).imports.find((i) => i.id === id);

/** Where an upload with no filename lands, spelled out: the name in the folder is the contract. */
const blobExists = (importId: string): Promise<boolean> =>
  fs
    .access(path.join(storageRoot(), `statement_${importId}.csv`))
    .then(() => true)
    .catch(() => false);

const JAN = '2026-01-01T00:00:00.000Z';
const DEC = '2026-12-31T23:59:59.999Z';

describe('an unconfirmed import is not the user’s data', () => {
  /**
   * First in the file on purpose: it asserts on totals over every account, so
   * it has to run before anything else here has confirmed a row.
   */
  it('is invisible to every read path there is', async () => {
    const summary = await upload(
      'Invisible Bank',
      csvFile('2026-02-01,-40.00,Staged rent', '2026-02-02,-2.50,Staged coffee'),
    );

    expect(summary).toMatchObject({
      accountName: 'Invisible Bank',
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
    expect(await summaryTotals({ kind: 'all' }, JAN, DEC)).toEqual({ expense: 0, income: 0 });
    expect(await summaryMonthlyTotals({ kind: 'all' }, JAN, DEC)).toEqual([]);
    expect(await listRecurringGroups(JAN)).toEqual([]);
    // the account is the one the upload picked, and nothing has reached it: no rows
    // and a balance still at 0, so Overview shows what it showed before the upload
    expect(await listAccounts(true)).toHaveLength(1);
    expect((await getAccount(summary.accountId))!.balance).toBe(0);

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

    // the id the summary named is the id the confirm used: it is recorded on the
    // import at staging and read back here, not derived twice from the name
    expect(result).toEqual({
      confirmed: true,
      accountId: summary.accountId,
      accountIds: [summary.accountId],
      inserted: 2,
      rowsAccepted: 2,
      rowsRejected: 0,
    });
    expect(await listTransactions({ accountId: summary.accountId })).toHaveLength(2);
    // the balance is recomputed inside the confirm transaction: nothing else ever
    // recomputes it, so a window that ended before it would leave 0 for good
    expect((await getAccount(summary.accountId))!.balance).toBe(-30);
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
    expect(await listTransactions({ accountId: summary.accountId })).toHaveLength(1);
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
    expect(await listTransactions({ accountId: first.accountId })).toHaveLength(0);

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
    expect(await listTransactions({ accountId: live.accountId })).toHaveLength(1);
    expect(await importRow(live.importId)).toMatchObject({ status: 'committed' });
  });
});

describe('an outstanding import and a second upload of the same bytes', () => {
  /**
   * The file hash is claimed by `committed` alone, so a staged import must not make
   * its own bytes answer "already imported": with no Confirm control on the history
   * screen, re-uploading is the only way back to an import whose tab was closed. The
   * new upload supersedes the old one, and says so.
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
   * imports screen tell someone they rejected an import they never
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
   * PGlite is single-connection and the state is what matters, not the
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
   * Built by hand rather than by racing: PGlite is single-connection, so
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
          accountId: first.accountId,
          provider: 'upload',
          amount: -25,
          currency: 'EUR',
          date: '2026-05-09',
          description: 'Raced',
          category: 'other',
          fee: null,
        },
      ],
      0,
      { id: first.accountId as ResolvedAccountId, name: 'Raced Bank', currency: 'EUR' },
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
    expect(await listTransactions({ accountId: first.accountId })).toHaveLength(1);
    expect(await discardImport(second.id)).toEqual({ discarded: true });
  });
});

/**
 * The scenario the staging table exists to make impossible.
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
    expect(await listTransactions({ accountId: b.accountId })).toHaveLength(3);
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
    expect(await listTransactions({ accountId: b.accountId })).toHaveLength(3);
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
    expect(await listTransactions({ accountId: more.accountId })).toHaveLength(5);
  });

  it('fewer incoming than present', async () => {
    const seed = await upload('Preview Fewer Bank', espresso(5, 'sf'));
    await confirmImport(seed.importId);

    const fewer = await upload('Preview Fewer Bank', espresso(2, 'ff'));
    expect(fewer).toMatchObject({ accepted: 2, newRows: 0, alreadyPresent: 2 });
    const result = await confirmImport(fewer.importId);
    expect(result).toMatchObject({ confirmed: true, inserted: fewer.newRows });
    expect(await listTransactions({ accountId: fewer.accountId })).toHaveLength(5);
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
          WHERE import_id = ${summary.importId}
            AND row_no = 1`,
    );

    await expect(confirmImport(summary.importId)).rejects.toThrow(
      new RegExp(`import ${summary.importId} was staged with 2 rows and 1 are present`),
    );
    // the whole transaction rolled back: still confirmable, nothing written
    expect(await importRow(summary.importId)).toMatchObject({
      status: 'awaiting_confirmation',
    });
    expect(await listTransactions({ accountId: summary.accountId })).toHaveLength(0);
  });

  /**
   * account_name is nullable because every import from before this step is, and the
   * confirm checks it without reading it - the create that consumed it went when the
   * upload stopped taking a name. Dropping the check would make an import from before
   * this step confirmable, landing rows against an id with no recorded destination.
   *
   * The pair of assertions this used to carry - no account under the staged id, none
   * under the name - guarded "the confirm did not invent one". That guarantee did not
   * go away, it moved: upsertAccountOn is not called here any more, and a missing
   * account is the account-missing refusal below.
   */
  it('an import with no recorded account name is refused', async () => {
    const summary = await upload('Nameless Bank', csvFile('2026-08-05,-12.00,Nameless'));
    await dbInstance().execute(
      sql`UPDATE imports SET account_name = NULL
          WHERE id = ${summary.importId}`,
    );

    await expect(confirmImport(summary.importId)).rejects.toThrow(
      /records no account name, currency or id/,
    );
    expect(await listTransactions({ accountId: summary.accountId })).toHaveLength(0);
    expect(await importRow(summary.importId)).toMatchObject({
      status: 'awaiting_confirmation',
    });
  });

  /**
   * The same guard on the column this row added. account_id is nullable because
   * createImport writes the row before the parse, and a NULL one that reached
   * `awaiting_confirmation` means the server staged an import without resolving an
   * account - not something a user can do, so it is a throw and a 5xx.
   */
  it('an import with no recorded account id is refused', async () => {
    const summary = await upload('Idless Bank', csvFile('2026-08-06,-13.00,Idless'));
    await dbInstance().execute(
      sql`UPDATE imports SET account_id = NULL
          WHERE id = ${summary.importId}`,
    );

    await expect(confirmImport(summary.importId)).rejects.toThrow(
      /records no account name, currency or id/,
    );
    expect(await listTransactions({ accountId: summary.accountId })).toHaveLength(0);
    expect(await importRow(summary.importId)).toMatchObject({
      status: 'awaiting_confirmation',
    });
  });

  /**
   * stageImport takes the rows and the account as independent arguments and there is
   * no foreign key from transactions.account_id to accounts.id, so a caller whose rows
   * were built for another account would otherwise get an account nobody's rows join,
   * rows against an account with no row, and the balance of the empty one recomputed -
   * all answered as confirmed. Today's one caller threads one resolved id into both.
   */
  it('staged rows built for another account are refused, not written', async () => {
    const summary = await upload('Guard Bank', csvFile('2026-08-10,-11.00,Elsewhere'));
    await dbInstance().execute(
      sql`UPDATE staged_transactions SET account_id = 'csv:somewhere-else'
          WHERE import_id = ${summary.importId}`,
    );

    // built from the id the import recorded, not from a literal: that id is the
    // subject of the guard, and a literal here would only assert the message's shape
    await expect(confirmImport(summary.importId)).rejects.toThrow(
      new RegExp(
        `recorded against account ${summary.accountId} but staged a row for csv:somewhere-else`,
      ),
    );
    expect(await listTransactions({ accountId: summary.accountId })).toHaveLength(0);
    expect(await getAccount('csv:somewhere-else')).toBeUndefined();
    expect(await importRow(summary.importId)).toMatchObject({
      status: 'awaiting_confirmation',
    });
  });
});

/**
 * The second of the two gates on the account an upload picked. The upload proved the
 * account was there and not removed; the user removed it while the summary sat on screen.
 * Landing the rows now would answer `inserted: 2` for rows VISIBLE_ACCOUNT() keeps out of
 * every list, every summary and the export - a success nothing displays.
 *
 * The fourth part is what makes the first three evidence. A test asserting only the
 * refusal passes just as well against an implementation that destroyed the import on
 * its way out, so the same import is confirmed afterwards and the count the summary
 * promised is the count that lands.
 *
 * Only the sequential half of the window is reachable here: PGlite is
 * single-connection, so nothing can hold this confirm's transaction open
 * while a PATCH /api/accounts/:id {hidden:true} commits. The FOR UPDATE that closes
 * that race is uncovered by the default suite and by TEST_DATABASE_URL alike.
 */
describe('an account removed between the upload and the confirm', () => {
  it('refuses, leaves the import confirmable, and lands the rows once it is restored', async () => {
    const created = await createAccount({ name: 'Vanishing Bank', currency: 'EUR' });
    const id = created.ok ? created.account.id : '';
    const summary = await uploadTo(
      id,
      csvFile('2026-09-01,-14.00,Before it went', '2026-09-02,-15.00,And after'),
    );
    expect(summary.accepted).toBe(2);

    await updateAccount(id, { hidden: true });
    expect(await confirmImport(summary.importId)).toEqual({
      confirmed: false,
      reason: 'account-hidden',
    });

    // the whole transaction rolled back: the import is where it was, its staged rows
    // are still there, and the refusal did not un-hide the account on the way out
    expect(await importRow(summary.importId)).toMatchObject({
      status: 'awaiting_confirmation',
    });
    expect(await stagedCount(summary.importId)).toBe(2);
    expect((await getAccount(id))!.hidden).toBe(true);

    await updateAccount(id, { hidden: false });
    expect(await listTransactions({ accountId: id })).toHaveLength(0);

    expect(await confirmImport(summary.importId)).toMatchObject({
      confirmed: true,
      accountId: id,
      inserted: 2,
    });
    expect(await listTransactions({ accountId: id })).toHaveLength(2);
    expect(await stagedCount(summary.importId)).toBe(0);
  });
});

/**
 * The window: the account is deleted while the upload is still parsing, so the
 * destination was proved before the delete and the staging happens after it. While the
 * confirm could still create an account, its upsert simply created this one again - a
 * deleted account came back, holding rows, at 200.
 *
 * It cannot be set up through the product API, and that is not a gap in the test:
 * deleteAccount refuses while the account holds staged rows (HOLDS_STAGED_ROWS), and
 * by the time an import is confirmable it does. The DELETE below is what the real
 * window produces, and it works because staged_transactions has no foreign key to
 * accounts - only to imports - so the staged rows outlive the account. Clearing them
 * too would hit the partial-import throw instead and pass for the wrong reason, which
 * is why the count is asserted before the confirm as well as after it.
 */
describe('an account deleted between the upload and the confirm', () => {
  it('refuses, creates nothing, and leaves the import to be discarded', async () => {
    const id = await accountFor('Deleted Bank');
    const summary = await uploadTo(
      id,
      csvFile('2026-10-01,-21.00,Into the deleted', '2026-10-02,-22.00,And this one'),
    );
    expect(await stagedCount(summary.importId)).toBe(2);

    await dbInstance().execute(
      sql`DELETE FROM accounts WHERE id = ${id}`,
    );
    expect(await getAccount(id)).toBeUndefined();

    expect(await confirmImport(summary.importId)).toEqual({
      confirmed: false,
      reason: 'account-missing',
    });

    // the account did not come back - the whole point - and the rollback took the
    // insert with it: an import back where it was, with its rows still staged
    expect(await getAccount(id)).toBeUndefined();
    expect(await listAccounts()).not.toContainEqual(expect.objectContaining({ id }));
    expect(await listTransactions({ accountId: id })).toHaveLength(0);
    expect(await importRow(summary.importId)).toMatchObject({
      status: 'awaiting_confirmation',
    });
    expect(await stagedCount(summary.importId)).toBe(2);

    // and every retry refuses the same way: the id is minted server-side, so nothing
    // the user can do brings that account back. Discard is the only exit
    expect(await confirmImport(summary.importId)).toEqual({
      confirmed: false,
      reason: 'account-missing',
    });
    expect(await discardImport(summary.importId)).toEqual({ discarded: true });
    expect(await stagedCount(summary.importId)).toBe(0);
  });
});

/**
 * A throw *after* the stage committed - the supersede, a read, anything between there and
 * the response - leaves a `failed` import. `failed` is neither confirmable nor
 * discardable, so its staged rows would sit unreachable until deleteImport. The sweep is
 * in failImport rather than the caller's catch so that no future caller has to remember
 * it.
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

  /**
   * The last cut between a composed refusal and the screen. It was a
   * bare slice, so what error_detail kept ended wherever 500 characters ran out and
   * read as a finished sentence - the client renders the whole of it and adds no
   * cut of its own. Both messages are built from ERROR_DETAIL_MAX and not from a
   * literal past it: exactly the cap is not a cut and carries no mark.
   */
  it('a message past what error_detail keeps is marked where it was cut', async () => {
    const fits = await upload('Marked Cut Bank', csvFile('2026-08-21,-14.00,Kept whole'));
    const over = await upload('Marked Cut Bank', csvFile('2026-08-22,-15.00,Cut short'));
    const whole = 'x'.repeat(ERROR_DETAIL_MAX);

    await failImport(fits.importId, whole);
    await failImport(over.importId, `${whole} and there was more behind it`);

    const detail = async (id: string): Promise<string | null | undefined> =>
      (await listImports()).imports.find((i) => i.id === id)?.errorDetail;
    expect(await detail(fits.importId)).toBe(whole);
    expect(await detail(over.importId)).toBe(`${'x'.repeat(ERROR_DETAIL_MAX - 1)}…`);
  });
});

/**
 * A fee the parser read must not be lost between the summary the user accepts and
 * the row the database keeps. The READ side of that is held by
 * `tsc` - stagedToNew returns NewTransaction and fee is required on it - but the
 * write side is not: omitting fee_cents from stageImport's values is legal
 * TypeScript against a nullable column, and the confirmation screen would then show
 * a net the database does not hold. This is what holds that half.
 */
describe('a stated fee survives staging', () => {
  it('reaches staged_transactions, and then the row the confirm writes', async () => {
    // the Balance column chains through the movements rather than reading 0 on both
    // rows: 100.00 - 63.62 - 10.00, which is what the bank prints and what the
    // reconciliation gate reads. Two rows are cheap, and they buy the assertion below
    // that a derived pair survives to the summary the confirm path shows
    const file = [
      'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance',
      'CARD_PAYMENT,Current,2026-10-01 09:00:00,2026-10-01 10:00:00,Staged With Fee,-63.18,0.44,EUR,COMPLETED,36.38',
      'CARD_PAYMENT,Current,2026-10-02 09:00:00,2026-10-02 10:00:00,Staged No Fee,-10.00,0.00,EUR,COMPLETED,26.38',
    ].join('\n');

    const result = await importStatement({
      accountId: await accountFor('Fee Staging'),
      preset: 'revolut',
      bytes: Buffer.from(file, 'utf8'),
    });
    if (result.outcome !== 'awaiting_confirmation') {
      throw new Error(`expected a summary, got ${JSON.stringify(result)}`);
    }
    const { summary } = result;

    // the number on the confirmation screen is already the movement, not the column
    expect(summary.totals).toEqual([{ currency: 'EUR', net: -73.62 }]);
    // and the statement's own running balance says the same, off one series - whose
    // two rows are one junction, so the run is one the verdict could have failed on
    expect(summary.balances).toEqual({
      opening: 100,
      closing: 26.38,
      currency: 'EUR',
      series: { summed: 1, checked: 1 },
    });
    expect(await stagedFeeCents(summary.importId)).toEqual([44, 0]);

    expect(await confirmImport(summary.importId)).toMatchObject({ confirmed: true, inserted: 2 });
    const txs = await listTransactions({ accountId: summary.accountId });
    expect(txs.find((t) => t.description === 'Staged With Fee')).toMatchObject({
      amount: -63.62,
      fee: 0.44,
    });
    expect(txs.find((t) => t.description === 'Staged No Fee')).toMatchObject({
      amount: -10,
      fee: 0,
    });
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
    // something here later: the history screen reads error_detail === null as "the
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
          fee: null,
        },
      ],
      0,
      { id: 'csv:cascade-bank' as ResolvedAccountId, name: 'Cascade Bank', currency: 'EUR' },
    );
    expect(await stagedCount(record.id)).toBe(1);

    // a backup carrying an empty imports table: the restore's DELETE FROM imports is
    // all there is, and the staged rows have to go with it. No new delete is written
    // anywhere - the composite foreign key is what does this
    await restoreBackup(parseBackup({ format: 'finto-backup', version: 1, tables: { imports: [] } }));
    expect(await stagedCount(record.id)).toBe(0);
  });
});
