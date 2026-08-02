/**
 * Provenance (ROADMAP 4.4): every upload is an `imports` row, and deleting that
 * row takes the transactions it wrote with it.
 *
 * The ordinal test near the bottom is the one this suite exists for. Deleting an
 * import punches holes in the dedup ordinals, and holes make the next import
 * insert rows it should have recognised as duplicates. Real data holds no `c:`
 * keys with holes yet, so this test is the only thing that will ever notice if
 * the renumbering in deleteImport goes away.
 */
import fs from 'fs/promises';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  dbInstance,
  deleteImport,
  getAccount,
  getImportDocumentRef,
  insertTransactions,
  listImports,
  listTransactions,
  runWithWorkspace,
} from '../src/db';
import { DOCUMENT_STORE_REFUSED, getDocument } from '../src/documents';
import { importAndConfirm } from './helpers';
import { importStatement } from '../src/providers/statement';
import { storageRoot } from '../src/storage';
import { NewTransaction } from '../src/types';
import { createWorkspace, TEST_WORKSPACE_ID } from './pglite';

/** A generic-preset file: one line per row, all of them parseable. */
const csvFile = (...rows: string[]): string =>
  ['date,amount,description', ...rows].join('\n');

/** The same row repeated n times - one dedup group, ordinals 1..n. */
const repeated = (n: number, row: string): string =>
  csvFile(...Array.from({ length: n }, () => row));

const importFile = (accountName: string, csv: string) =>
  importAndConfirm({ accountName, currency: 'EUR', bytes: Buffer.from(csv, 'utf8') });

const countFor = async (accountId: string): Promise<number> =>
  (await listTransactions({ accountId, limit: 500 })).length;

/** Whether a blob exists, addressed by hand rather than through the key registry. */
const blobExists = async (workspaceId: string, importId: string): Promise<boolean> =>
  fs
    .access(path.join(storageRoot(), workspaceId, importId))
    .then(() => true)
    .catch(() => false);

/** The stored dedup keys of an account, in insertion-independent order. */
async function dedupKeys(accountId: string): Promise<string[]> {
  const res = (await dbInstance().execute(
    sql`SELECT dedup_key FROM transactions WHERE account_id = ${accountId} ORDER BY dedup_key`,
  )) as unknown as { rows: { dedup_key: string }[] };
  return res.rows.map((r) => r.dedup_key);
}

describe('imports: the file layer', () => {
  it('the same file twice is recognised by its hash and never parsed again', async () => {
    const csv = csvFile('2026-01-05,-900.00,Rent', '2026-01-06,-23.45,Groceries');
    const first = await importFile('Hash Bank', csv);
    expect(first.duplicate).toBeUndefined();
    expect(first.inserted).toBe(2);

    // the same bytes under a different account name: were it parsed, it would
    // create that account and insert two more rows
    const second = await importFile('Hash Bank Other Name', csv);
    expect(second.duplicate).toBe(true);
    expect(second.importId).toBe(first.importId);
    expect(second.inserted).toBe(0);
    expect(await getAccount('csv:hash-bank-other-name')).toBeUndefined();
    expect(await countFor(first.accountId)).toBe(2);

    // and the answer names the account the rows are ACTUALLY in, not the one
    // that was asked for and does not exist
    expect(second.accountIds).toEqual([first.accountId]);
    expect(second.accountId).toBe(first.accountId);
    expect(await getAccount(second.accountId)).toBeDefined();

    // and one import row, not two
    const mine = (await listImports()).filter((i) => i.id === first.importId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ status: 'committed', rowsAccepted: 2, rowsRejected: 0 });
    expect(mine[0].transactions).toBe(2);
  });

  /**
   * A committed import that owns nothing: its rows were all written by an
   * earlier one, so the dedup key sent every insert away. The empty accountIds
   * is the honest answer - it says where this import's rows are, and there are
   * none, which is not the same as nothing having been imported.
   */
  it('a duplicate of an import that owns no rows answers with no accounts', async () => {
    const a = csvFile('2026-02-01,-15.00,Bakery');
    // different bytes, same dedup key: the description is not part of it
    const b = csvFile('2026-02-01,-15.00,Bakery GmbH');

    const first = await importFile('Owns Nothing Bank', a);
    expect(first.inserted).toBe(1);
    const second = await importFile('Owns Nothing Bank', b);
    expect(second.duplicate).toBeUndefined();
    expect(second.inserted).toBe(0);

    const again = await importFile('Owns Nothing Bank', b);
    expect(again.duplicate).toBe(true);
    expect(again.importId).toBe(second.importId);
    expect(again.accountIds).toEqual([]);
    expect(again.accountId).toBe('csv:owns-nothing-bank');
  });

  it('a parse that throws leaves a failed import, and the same bytes may be retried', async () => {
    const csv = ['when;how much;what', '05.01.2026;-10,00;Bakery'].join('\n');
    await expect(importFile('Retry Bank', csv)).rejects.toThrow(
      /could not find date\/amount\/description columns/,
    );
    const failed = (await listImports()).filter((i) => i.status === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].errorDetail).toMatch(/could not find date\/amount\/description columns/);
    expect(failed[0].transactions).toBe(0);
    expect(await getAccount('csv:retry-bank')).toBeUndefined();

    // a failed import does not claim the file - only a committed one does
    const retried = await importAndConfirm({
      accountName: 'Retry Bank',
      currency: 'EUR',
      bytes: Buffer.from(csv, 'utf8'),
      mapping: {
        date: 'when',
        amount: 'how much',
        description: 'what',
        delimiter: ';',
        decimal: ',',
        dateFormat: 'dmy',
      },
    });
    expect(retried.duplicate).toBeUndefined();
    expect(retried.inserted).toBe(1);

    // and now that it is committed, the same bytes are refused before parsing
    expect((await importFile('Retry Bank', csv)).duplicate).toBe(true);
  });

  it('deleting an import removes its transactions and nothing else', async () => {
    const march = await importFile('Delete Bank', csvFile('2026-03-01,-10.00,March one'));
    const april = await importFile('Delete Bank', csvFile('2026-04-01,-20.00,April one'));
    const other = await importFile('Untouched Bank', csvFile('2026-03-01,-30.00,Other bank'));
    expect(await countFor(march.accountId)).toBe(2);

    const result = await deleteImport(march.importId);
    expect(result).toEqual({ removed: 1, accountIds: [march.accountId] });

    const left = await listTransactions({ accountId: march.accountId });
    expect(left.map((t) => t.description)).toEqual(['April one']);
    expect(await countFor(other.accountId)).toBe(1);
    expect((await listImports()).map((i) => i.id)).toContain(april.importId);
    expect((await listImports()).map((i) => i.id)).not.toContain(march.importId);
    // the account survives its import, with the balance recomputed
    expect((await getAccount(march.accountId))!.balance).toBe(-20);
  });

  it('deleting a missing import is a no-op, not a throw', async () => {
    expect(await deleteImport('no-such-import')).toBeUndefined();
  });

  it('a committed import keeps the uploaded file itself, byte for byte', async () => {
    const csv = csvFile('2026-06-01,-12.00,Stored document');
    const result = await importFile('Document Bank', csv);

    const ref = await getImportDocumentRef(result.importId);
    expect(ref).toBeDefined();
    expect(await getDocument(ref!)).toEqual(Buffer.from(csv, 'utf8'));
  });

  /**
   * The reason the document is written BEFORE the parse (ROADMAP 4.5): "my import
   * came out wrong" is undiagnosable without the input, and the imports that went
   * wrong are exactly the failed ones.
   */
  it('a failed parse keeps its document', async () => {
    const csv = ['col a;col b;col c', '05.02.2026;-11,00;Kiosk'].join('\n');
    await expect(importFile('Failed Document Bank', csv)).rejects.toThrow(
      /could not find date\/amount\/description columns/,
    );

    const failed = (await listImports()).find((i) => i.errorDetail?.includes('col a'))!;
    expect(failed.status).toBe('failed');
    const ref = await getImportDocumentRef(failed.id);
    expect(await getDocument(ref!)).toEqual(Buffer.from(csv, 'utf8'));
  });

  it('deleting an import destroys its document too', async () => {
    const result = await importFile('Delete Document Bank', csvFile('2026-06-02,-13.00,Gone'));
    expect(await blobExists(TEST_WORKSPACE_ID, result.importId)).toBe(true);

    expect((await deleteImport(result.importId))!.removed).toBe(1);
    expect(await blobExists(TEST_WORKSPACE_ID, result.importId)).toBe(false);
    expect(await getImportDocumentRef(result.importId)).toBeUndefined();
  });

  /**
   * The rows are already gone when the blob delete runs, so its failure is logged
   * and swallowed: raising would send the user to press a button whose import no
   * longer exists, and the second press answers "not found". Nothing but this test
   * holds that - the catch is reachable from user data, not only from a broken disk
   * (a restored `imports.id` outside the key charset makes the key refuse before any
   * disk access), and removing it 500s the route AFTER the delete has happened.
   *
   * The failure is forced with a non-empty directory where the blob belongs, so the
   * unlink fails with something that is not ENOENT on every platform this runs on.
   */
  it('a document that cannot be removed does not fail the delete of its import', async () => {
    const result = await importFile('Stuck Document Bank', csvFile('2026-06-04,-16.00,Stuck'));
    const blob = path.join(storageRoot(), TEST_WORKSPACE_ID, result.importId);
    await fs.rm(blob, { force: true });
    await fs.mkdir(path.join(blob, 'inner'), { recursive: true });

    try {
      expect((await deleteImport(result.importId))!.removed).toBe(1);
      expect(await countFor(result.accountId)).toBe(0);
      // the blob path is still there (as the directory), which is only true when
      // the removal really failed: without it the two assertions above are also
      // satisfied by an ordinary delete, and the fixture could rot unnoticed
      expect(await blobExists(TEST_WORKSPACE_ID, result.importId)).toBe(true);
    } finally {
      await fs.rm(blob, { recursive: true, force: true });
    }
  });

  /**
   * The document cannot be stored: the import is REFUSED, not committed with a
   * warning. Committing would claim the file hash forever, so the same bytes would
   * answer "already imported" on every retry and the one artefact that cannot be
   * recovered later could never be captured for that file at all.
   *
   * The failure is forced by putting a plain file where the workspace's directory
   * belongs - no chmod, identical on Windows and Linux - and in a workspace of its
   * own, because in the shared one that path is a directory full of the other
   * tests' documents and clearing it would mean deleting them.
   */
  it('an import whose document cannot be stored is refused, and the bytes stay re-uploadable', async () => {
    const workspace = 'doc-storage-failure';
    await createWorkspace(dbInstance(), workspace);
    const csv = csvFile('2026-06-03,-14.00,Refused');
    const blocked = path.join(storageRoot(), workspace);
    await fs.mkdir(storageRoot(), { recursive: true });
    await fs.writeFile(blocked, 'a file where the workspace directory belongs');

    try {
      await runWithWorkspace(workspace, async () => {
        const failure = await importFile('Storage Failure Bank', csv).catch((e: Error) => e);
        expect(failure).toBeInstanceOf(Error);
        // asserted by identity: a regex alone stays green on a message "improved"
        // to splice in a cause chain that happens to carry no drive letter
        expect((failure as Error).message).toBe(DOCUMENT_STORE_REFUSED);
        expect((failure as Error).message).not.toMatch(
          /[A-Za-z]:\\|\/tmp\/|EEXIST|ENOTDIR|EACCES/,
        );

        const rows = await listImports();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ status: 'failed', errorDetail: DOCUMENT_STORE_REFUSED });
        expect(rows[0].transactions).toBe(0);
        expect(await listTransactions({ limit: 10 })).toHaveLength(0);
      });

      // the disk is fixed: the same bytes go in, because only a `committed` import
      // ever claimed the hash (ROADMAP 4.3)
      await fs.rm(blocked, { force: true });
      await runWithWorkspace(workspace, async () => {
        const retried = await importFile('Storage Failure Bank', csv);
        expect(retried.duplicate).toBeUndefined();
        expect(retried.inserted).toBe(1);
        expect(await blobExists(workspace, retried.importId)).toBe(true);
      });
    } finally {
      // only while it is still the blocking FILE - on the way out of the happy path
      // this same path is the workspace's directory, holding the retry's document
      const stat = await fs.stat(blocked).catch(() => undefined);
      if (stat?.isFile()) await fs.rm(blocked, { force: true });
    }
  });

  it('transactions from a bank sync survive an import deletion', async () => {
    const synced: NewTransaction = {
      accountId: 'mono:sync-account',
      provider: 'monobank',
      amount: -12.5,
      currency: 'EUR',
      date: '2026-05-01T10:00:00.000Z',
      description: 'synced, not imported',
      category: 'other',
      fee: null,
    };
    expect(await insertTransactions([synced])).toBe(1);
    const uploaded = await importFile('Sync Neighbour', csvFile('2026-05-02,-9.00,Uploaded'));

    const result = await deleteImport(uploaded.importId);
    expect(result!.removed).toBe(1);
    expect(await countFor('mono:sync-account')).toBe(1);
  });

  /**
   * ROADMAP 4.4's ordinal case, with the numbers that actually break it: a hole
   * below the incoming file's row count, and a live ordinal above it.
   *
   *   A claims 2 -> ordinals 1,2      B claims 4 -> adds 3,4
   *   delete A   -> {3,4} renumbered to {1,2}
   *   C claims 3 -> one row is new, three in total
   *
   * Without the renumbering the survivors sit at {3,4}, C's ordinals 1,2 are
   * both free, and the account ends up with four rows for three real ones.
   */
  it('an import deleted from the middle of a dedup group does not leave a hole', async () => {
    const coffee = '2026-03-06,-3.50,Espresso House';
    const a = await importFile('Ordinal Bank', repeated(2, coffee));
    expect(a.inserted).toBe(2);
    const b = await importFile('Ordinal Bank', repeated(4, coffee));
    expect(b.inserted).toBe(2);
    expect(await countFor(a.accountId)).toBe(4);

    expect((await deleteImport(a.importId))!.removed).toBe(2);
    expect(await countFor(a.accountId)).toBe(2);
    expect(await dedupKeys(a.accountId)).toEqual([
      'c:2026-03-06|-350|EUR|1',
      'c:2026-03-06|-350|EUR|2',
    ]);

    const c = await importFile('Ordinal Bank', repeated(3, coffee));
    expect(c.inserted).toBe(1);
    expect(await countFor(a.accountId)).toBe(3);
  });

  /**
   * The batching case: one delete leaving survivors at a different ordinal in
   * each of three groups. Per-group round trips would have made this correct and
   * slow; it has to come out identical from the batched statements.
   */
  it('one delete renumbers every group it touched, each from its own ordinal', async () => {
    const g1 = '2026-08-01,-5.00,Group one';
    const g2 = '2026-08-02,-6.00,Group two';
    const g3 = '2026-08-03,-7.00,Group three';
    const file = (n1: number, n2: number, n3: number) =>
      csvFile(
        ...Array<string>(n1).fill(g1),
        ...Array<string>(n2).fill(g2),
        ...Array<string>(n3).fill(g3),
      );

    const p = await importFile('Batch Bank', file(1, 2, 3));
    expect(p.inserted).toBe(6);
    // one more of each: they land on ordinals 2, 3 and 4 respectively
    const q = await importFile('Batch Bank', file(2, 3, 4));
    expect(q.inserted).toBe(3);

    expect((await deleteImport(p.importId))!.removed).toBe(6);
    expect(await dedupKeys(q.accountId)).toEqual([
      'c:2026-08-01|-500|EUR|1',
      'c:2026-08-02|-600|EUR|1',
      'c:2026-08-03|-700|EUR|1',
    ]);
  });

  it('renumbering rewrites computed keys only, never a provider reference', async () => {
    const row = '2026-07-01,-3.50,Mixed group';
    const provided: NewTransaction = {
      accountId: 'csv:mixed-bank',
      provider: 'monobank',
      dedupKey: 'mono:9f3c',
      amount: -3.5,
      currency: 'EUR',
      date: '2026-07-01T00:00:00.000Z',
      description: 'same group, but the bank named it',
      category: 'other',
      fee: null,
    };
    expect(await insertTransactions([provided])).toBe(1);

    const p = await importFile('Mixed Bank', repeated(2, row));
    await importFile('Mixed Bank', repeated(3, row));
    expect((await deleteImport(p.importId))!.removed).toBe(2);

    expect(await dedupKeys('csv:mixed-bank')).toEqual([
      'c:2026-07-01|-350|EUR|1',
      'mono:9f3c',
    ]);
  });
});
