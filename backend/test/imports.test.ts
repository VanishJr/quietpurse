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
  type ResolvedAccountId,
  clearImportDocument,
  confirmImport,
  createImport,
  dbInstance,
  deleteImport,
  getAccount,
  getImportDocumentRef,
  insertTransactions,
  listImports,
  listTransactions,
  recordImportDocument,
  stageImport,
  upsertAccount,
} from '../src/db';
import { config } from '../src/config';
import { DOCUMENT_STORE_REFUSED, getDocument } from '../src/documents';
import { accountFor, importAndConfirm } from './helpers';
import { storageRoot } from '../src/storage';
import { NewTransaction } from '../src/types';

/** A generic-preset file: one line per row, all of them parseable. */
const csvFile = (...rows: string[]): string =>
  ['date,amount,description', ...rows].join('\n');

/** The same row repeated n times - one dedup group, ordinals 1..n. */
const repeated = (n: number, row: string): string =>
  csvFile(...Array.from({ length: n }, () => row));

const importFile = async (name: string, csv: string) =>
  importAndConfirm({ accountId: await accountFor(name), bytes: Buffer.from(csv, 'utf8') });

const countFor = async (accountId: string): Promise<number> =>
  (await listTransactions({ accountId, limit: 500 })).length;

/**
 * Where an upload with no filename lands, spelled out by hand rather than asked of
 * the module: the name a person finds in the folder is the contract.
 */
const blobOf = (importId: string): string => path.join(storageRoot(), `statement_${importId}.csv`);

const blobExists = async (importId: string): Promise<boolean> =>
  fs
    .access(blobOf(importId))
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

    // the same bytes into a different account: were they parsed, two more rows
    // would land in that one
    const otherId = await accountFor('Hash Bank Other Name');
    const second = await importFile('Hash Bank Other Name', csv);
    expect(second.duplicate).toBe(true);
    expect(second.importId).toBe(first.importId);
    expect(second.inserted).toBe(0);
    expect(await countFor(otherId)).toBe(0);
    expect(await countFor(first.accountId)).toBe(2);

    // and the answer names the account the rows are ACTUALLY in, not the one this
    // request asked for
    expect(second.accountIds).toEqual([first.accountId]);
    expect(second.accountId).toBe(first.accountId);
    expect(await getAccount(second.accountId)).toBeDefined();

    // and one import row, not two
    const mine = (await listImports()).imports.filter((i) => i.id === first.importId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ status: 'committed', rowsAccepted: 2, rowsRejected: 0 });
    expect(mine[0].transactions).toBe(2);
  });

  /**
   * A committed import that owns nothing: its rows were all written by an
   * earlier one, so the dedup key sent every insert away. The empty accountIds
   * is the honest answer - it says where this import's rows are, and there are
   * none, which is not the same as nothing having been imported.
   *
   * `accountId` is empty for the same reason and not for want of a better guess.
   * The account the request picked is NOT the answer: the field says where the
   * earlier import's rows went, and that import may have put them elsewhere
   * entirely, so standing the requested id in would be a claim nothing checked.
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
    expect(again.accountId).toBe('');
  });

  it('a parse that throws leaves a failed import, and the same bytes may be retried', async () => {
    const csv = ['when;how much;what', '05.01.2026;-10,00;Bakery'].join('\n');
    await expect(importFile('Retry Bank', csv)).rejects.toThrow(
      /could not find date\/amount\/description columns/,
    );
    const failed = (await listImports()).imports.filter((i) => i.status === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].errorDetail).toMatch(/could not find date\/amount\/description columns/);
    expect(failed[0].transactions).toBe(0);
    expect(await countFor(await accountFor('Retry Bank'))).toBe(0);
    // and the row records no account: createImport writes before the parse, so there
    // is nothing to record yet. Asserted on the COLUMN, because the mapper is what
    // would be changed alongside a writer that started filling it in - and an account
    // id on a row that never parsed is a client-visible field on the history screen
    const staged = (await dbInstance().execute(
      sql`SELECT account_id FROM imports
          WHERE id = ${failed[0].id}`,
    )) as unknown as { rows: { account_id: string | null }[] };
    expect(staged.rows[0].account_id).toBeNull();

    // a failed import does not claim the file - only a committed one does
    const retried = await importAndConfirm({
      accountId: await accountFor('Retry Bank'),
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
    expect((await listImports()).imports.map((i) => i.id)).toContain(april.importId);
    expect((await listImports()).imports.map((i) => i.id)).not.toContain(march.importId);
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

    const failed = (await listImports()).imports.find((i) => i.errorDetail?.includes('col a'))!;
    expect(failed.status).toBe('failed');
    const ref = await getImportDocumentRef(failed.id);
    expect(await getDocument(ref!)).toEqual(Buffer.from(csv, 'utf8'));
  });

  it('deleting an import destroys its document too', async () => {
    const result = await importFile('Delete Document Bank', csvFile('2026-06-02,-13.00,Gone'));
    expect(await blobExists(result.importId)).toBe(true);

    expect((await deleteImport(result.importId))!.removed).toBe(1);
    expect(await blobExists(result.importId)).toBe(false);
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
    const blob = blobOf(result.importId);
    await fs.rm(blob, { force: true });
    await fs.mkdir(path.join(blob, 'inner'), { recursive: true });

    try {
      expect((await deleteImport(result.importId))!.removed).toBe(1);
      expect(await countFor(result.accountId)).toBe(0);
      // the blob path is still there (as the directory), which is only true when
      // the removal really failed: without it the two assertions above are also
      // satisfied by an ordinary delete, and the fixture could rot unnoticed
      expect(await blobExists(result.importId)).toBe(true);
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
   * The failure is forced by pointing the store at a plain FILE for the duration -
   * no chmod, identical on Windows and Linux - and never by touching the folder the
   * other cases' documents are in.
   */
  it('an import whose document cannot be stored is refused, and the bytes stay re-uploadable', async () => {
    const csv = csvFile('2026-06-03,-14.00,Refused');
    const accountId = await accountFor('Storage Failure Bank');
    const blocked = path.join(config.home, 'blocked-statements');
    await fs.mkdir(config.home, { recursive: true });
    await fs.writeFile(blocked, 'a file where the statements folder belongs');

    const before = config.documentStorePath;
    try {
      config.documentStorePath = blocked;
      const failure = await importAndConfirm({ accountId, bytes: Buffer.from(csv, 'utf8') }).catch(
        (e: Error) => e,
      );
      expect(failure).toBeInstanceOf(Error);
      // asserted by identity: a regex alone stays green on a message "improved"
      // to splice in a cause chain that happens to carry no drive letter
      expect((failure as Error).message).toBe(DOCUMENT_STORE_REFUSED);
      expect((failure as Error).message).not.toMatch(
        /[A-Za-z]:\\|\/tmp\/|EEXIST|ENOTDIR|EACCES/,
      );

      const refused = (await listImports()).imports.filter(
        (r) => r.errorDetail === DOCUMENT_STORE_REFUSED,
      );
      expect(refused).toHaveLength(1);
      expect(refused[0]).toMatchObject({ status: 'failed', transactions: 0 });
      expect(await countFor(accountId)).toBe(0);
    } finally {
      config.documentStorePath = before;
      await fs.rm(blocked, { force: true });
    }

    // the disk is fixed: the same bytes go in, because only a `committed` import
    // ever claimed the hash (ROADMAP 4.3)
    const retried = await importAndConfirm({ accountId, bytes: Buffer.from(csv, 'utf8') });
    expect(retried.duplicate).toBeUndefined();
    expect(retried.inserted).toBe(1);
    expect(await blobExists(retried.importId)).toBe(true);
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
    // the import runs first so the provider-referenced row can be built for the
    // account it actually resolved: the two have to be in one account for the
    // renumbering to reach them at all
    const p = await importFile('Mixed Bank', repeated(2, row));
    const provided: NewTransaction = {
      accountId: p.accountId,
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

    await importFile('Mixed Bank', repeated(3, row));
    expect((await deleteImport(p.importId))!.removed).toBe(2);

    expect(await dedupKeys(p.accountId)).toEqual([
      'c:2026-07-01|-350|EUR|1',
      'mono:9f3c',
    ]);
  });
});

/**
 * ROADMAP row 66: the page is capped, the totals are not. What is under test is that
 * the three totals describe the whole FILTERED set and the page describes the first
 * `limit` of it, so a panel can say how many are not listed instead of counting what
 * it was sent.
 *
 * Every case starts with nothing imported and this describe is the last in the file:
 * vitest runs this suite in one process, files in order and with no truncation between
 * them, so 101 imports left behind would be in every later file's unfiltered
 * listImports() for the rest of the run - which is why the truncate is inside each
 * case rather than at the end of the describe, where a failing case would skip it.
 */
describe('listImports: the filter and the totals', () => {
  let seq = 0;

  /** Distinct amounts, so nothing an import stages is deduplicated against a sibling. */
  const stagedRows = (accountId: string, n: number, mark: number): NewTransaction[] =>
    Array.from({ length: n }, (_, i) => ({
      accountId,
      provider: 'upload' as const,
      amount: -(mark * 100 + i + 1),
      currency: 'EUR',
      date: '2026-09-01T00:00:00.000Z',
      description: `totals row ${mark}.${i}`,
      category: 'other',
      fee: null,
    }));

  /**
   * A committed import attributed to an account, owning `n` transactions - the two
   * calls the product path makes, so nothing here fabricates a state an upload
   * cannot produce.
   */
  async function importInto(accountId: string, name: string, n: number): Promise<string> {
    seq += 1;
    const mark = seq;
    // the account first, and with these ids rather than minted ones: listImports
    // filters on the literal below. An upload cannot stage into an account that is
    // not there, so neither may this (row 26b)
    await upsertAccount({ id: accountId, provider: 'upload', name, currency: 'EUR', balance: 0 });
    const record = await createImport({
      fileHash: `totals-${mark}`,
      sourceType: 'csv',
      parserVersion: 1,
    });
    await stageImport(record.id, stagedRows(accountId, n, mark), 0, {
      id: accountId as ResolvedAccountId,
      name,
      currency: 'EUR',
    });
    const confirmed = await confirmImport(record.id);
    expect(confirmed, `confirming ${record.id}`).toMatchObject({ confirmed: true });
    // the pointer only; no bytes are written, and documentAvailable is about the
    // pointer (010 D5)
    await recordImportDocument(record.id);
    return record.id;
  }

  /**
   * Every total below is exact over everything imported, so each case starts with
   * nothing imported: the cascade takes the transactions and the staged rows with
   * the import rows, and nothing after this describe reads them.
   */
  const startingEmpty = async (body: () => Promise<void>): Promise<void> => {
    await dbInstance().execute(sql`TRUNCATE imports CASCADE`);
    await body();
  };

  it('counts the filtered set and pages the same set, with the other account left out', async () => {
    await startingEmpty(async () => {
      const mine = 'csv:totals-mine';
      const theirs = 'csv:totals-theirs';
      const stripped = await importInto(mine, 'Totals Mine', 4);
      await importInto(mine, 'Totals Mine', 3);
      await importInto(theirs, 'Totals Theirs', 9);
      // one of mine stops claiming a readable document, so totals.documents cannot
      // be totals.imports under another name
      await clearImportDocument(stripped);

      const { imports, totals } = await listImports({ accountId: mine });

      expect(imports.map((r) => r.accountId)).toEqual([mine, mine]);
      expect(totals.imports).toBe(2);
      expect(totals.documents).toBe(1);
      // literal, not expect.anything(): SUM() over bigint is numeric, and both
      // drivers hand numeric over as a string - "7" fails here and must
      expect(totals.transactions).toBe(7);

      // the page is whole, so each total is an identity over what it carries
      expect(imports.reduce((n, r) => n + r.transactions, 0)).toBe(totals.transactions);
      expect(imports.filter((r) => r.documentAvailable)).toHaveLength(totals.documents);
      expect(imports).toHaveLength(totals.imports);

      // and the answer over every account still has the other account's nine in it
      const all = await listImports();
      expect(all.totals).toEqual({ imports: 3, documents: 2, transactions: 16 });
    });
  });

  /**
   * The combination the delete panel actually meets: an account with more imports
   * than the page returns. It is a different mistake from the cap case below - a
   * COUNT(*) OVER () written outside the filtered set passes that one and fails this.
   */
  it('a filtered page shorter than its filtered set still counts the whole of it', async () => {
    await startingEmpty(async () => {
      const mine = 'csv:overflow-mine';
      const theirs = 'csv:overflow-theirs';
      for (let i = 0; i < 7; i += 1) {
        const id = await importInto(mine, 'Overflow Mine', 1);
        if (i >= 4) await clearImportDocument(id);
      }
      for (let i = 0; i < 3; i += 1) await importInto(theirs, 'Overflow Theirs', 2);

      const { imports, totals } = await listImports({ accountId: mine, limit: 5 });

      expect(imports).toHaveLength(5);
      expect(totals).toEqual({ imports: 7, documents: 4, transactions: 7 });
      // the page cannot answer any of the three: it carries five rows and five
      // transactions, and the panel prints seven
      expect(imports.reduce((n, r) => n + r.transactions, 0)).toBe(5);
    });
  });

  it('the page stops at 100 and the total does not', async () => {
    await startingEmpty(async () => {
      for (let i = 0; i < 101; i += 1) {
        await createImport({ fileHash: `cap-${i}`, sourceType: 'csv', parserVersion: 1 });
      }

      const { imports, totals } = await listImports();

      expect(imports).toHaveLength(100);
      expect(totals.imports).toBe(101);
      // these never reached the parse, so they own nothing and claim no document
      expect(totals).toEqual({ imports: 101, documents: 0, transactions: 0 });
    });
  });

  /**
   * COUNT(*) OVER () returns no ROW when the filtered set is empty, so the zeroes
   * come from an absent row rather than from a page of length 0 - and an id that
   * matches nothing is not an error.
   */
  it('an accountId that matches nothing is an empty page and three zeroes', async () => {
    await startingEmpty(async () => {
      await importInto('csv:unknown-neighbour', 'Unknown Neighbour', 2);

      expect(await listImports({ accountId: 'no-such-account' })).toEqual({
        imports: [],
        totals: { imports: 0, documents: 0, transactions: 0 },
      });
      // '' filters and matches nothing here too: it never widens to every account
      expect((await listImports({ accountId: '' })).totals.imports).toBe(0);
    });
  });

  /**
   * The statement's alias list is a hand-written mirror of the row and rowsOf<T>
   * asserts the shape rather than deriving it, so a dropped or misspelled alias
   * typechecks and leaves that field undefined. On the VALUES rather than on the
   * keys, because rowToImport builds an object literal: the key is there whatever
   * the row held. null is legitimate and stays legal - undefined is the symptom,
   * and a column added later inherits this without anyone extending a list.
   */
  it('no field of a listed import is undefined - every alias reached the mapper', async () => {
    await startingEmpty(async () => {
      await importInto('csv:aliases-mine', 'Aliases Mine', 2);

      const [record] = (await listImports()).imports;
      expect(Object.entries(record).filter(([, v]) => v === undefined)).toEqual([]);
      // a value each from the two halves of the statement: the plain aliases, and
      // the correlated count the window functions sum
      expect(record).toMatchObject({ status: 'committed', parserVersion: 1, transactions: 2 });
    });
  });
});
