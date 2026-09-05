import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  BackupData,
  createImport,
  dbInstance,
  deleteImport,
  exportBackup,
  getImportDocumentRef,
  getTransaction,
  insertTransactions,
  listAccounts,
  listImports,
  listTransactions,
  parseBackup,
  recordImportDocument,
  restoreBackup,
  setOneOff,
} from '../src/db';
import { DocumentMissing, getDocument, putDocument } from '../src/documents';
import { storageRoot } from '../src/storage';
import { NewTransaction } from '../src/types';
import { accountFor, idOf, importAndConfirm, markImportCommitted } from './helpers';

const tx = (description: string, amount: number): NewTransaction => ({
  accountId: 'acc1',
  provider: 'monobank',
  amount,
  currency: 'EUR',
  date: '2026-01-10T12:00:00.000Z',
  description,
  category: 'other',
  fee: null,
});

describe('backup and restore (JSON)', () => {
  it('a backup restores the data, manual marks included', async () => {
    await insertTransactions([tx('backup marked', -10), tx('backup plain', -20)]);
    const marked = await idOf('backup marked');
    await setOneOff(marked, true);

    const data = await exportBackup();
    expect(data.format).toBe('finto-backup');
    expect(data.tables.transactions.length).toBeGreaterThanOrEqual(2);

    // the file survives a JSON round-trip (that is exactly what the endpoint sends)
    const reparsed = parseBackup(JSON.parse(JSON.stringify(data)));

    // "disaster": the mark is cleared, then we restore from the backup
    await setOneOff(marked, false);
    expect((await getTransaction(marked))!.oneOff).toBe(false);

    const { tables, rows } = await restoreBackup(reparsed);
    expect(tables).toBeGreaterThan(0);
    expect(rows).toBeGreaterThan(0);
    // the id survives the round-trip too: a restore is not a re-import, the rows
    // keep the identity the annotations were attached to
    expect((await getTransaction(marked))!.oneOff).toBe(true);
    expect((await listTransactions({ accountId: 'acc1' })).length).toBeGreaterThanOrEqual(2);
  });

  /**
   * exportBackup selects whole rows and sanitizeRow looks columns up through
   * getTableColumns, so a new column should ride along for free. Verified rather
   * than assumed: a fee that exports and does not restore is silent loss at exactly
   * the moment a user is relying on the file.
   */
  it('a stated fee survives export and restore, and so does a stated nothing', async () => {
    await insertTransactions([
      { ...tx('backup with fee', -63.62), fee: 0.44 },
      tx('backup without fee', -21.03),
    ]);

    const data = parseBackup(JSON.parse(JSON.stringify(await exportBackup())));
    await restoreBackup(data);

    const txs = await listTransactions({ accountId: 'acc1' });
    expect(txs.find((t) => t.description === 'backup with fee')!.fee).toBe(0.44);
    // NULL, not 0 - the fact "the source stated none" is what round-trips
    expect(txs.find((t) => t.description === 'backup without fee')!.fee).toBeUndefined();
  });

  /** imports restore before transactions, or import_id would have nothing to point at. */
  it('an import and the provenance of its rows survive the round-trip', async () => {
    const record = await createImport({
      fileHash: 'backup-hash',
      sourceType: 'csv',
      parserVersion: 1,
      originalFilename: 'statement.csv',
    });
    await markImportCommitted(record.id, 1, 0);
    await insertTransactions([tx('backup provenance', -33)], record.id);

    await restoreBackup(parseBackup(JSON.parse(JSON.stringify(await exportBackup()))));

    const restored = (await listImports()).imports.find((i) => i.id === record.id)!;
    expect(restored).toMatchObject({
      fileHash: 'backup-hash',
      originalFilename: 'statement.csv',
      status: 'committed',
    });
    expect(restored.transactions).toBe(1);
  });

  /**
   * The person's own backup, restored onto the machine that holds their statements:
   * the documents must still open. The key is derived from originalFilename, id and
   * sourceType, and a backup carries all three, so the pointer is reconstructible and
   * stripping it threw away something the restore can rebuild. Asserted on the DISK
   * and through getDocument both - a pointer that comes back and a file that does not
   * would pass either one alone.
   */
  it('a restore keeps the documents readable, and deleting the import still removes them', async () => {
    const csv = 'date,amount,description\n2026-05-05,-21.00,Restore then delete\n';
    const imported = await importAndConfirm({
      accountId: await accountFor('Restore Document Bank'),
      bytes: Buffer.from(csv, 'utf8'),
    });
    const blob = path.join(storageRoot(), `statement_${imported.importId}.csv`);
    const exists = (): Promise<boolean> =>
      fs
        .access(blob)
        .then(() => true)
        .catch(() => false);
    expect(await exists()).toBe(true);

    await restoreBackup(parseBackup(JSON.parse(JSON.stringify(await exportBackup()))));

    // the pointer came back with the row, and it names the file that is still there
    const ref = await getImportDocumentRef(imported.importId);
    expect(ref).toBeDefined();
    expect(await getDocument(ref!)).toEqual(Buffer.from(csv, 'utf8'));
    expect(await exists()).toBe(true);
    expect(
      (await listImports()).imports.find((i) => i.id === imported.importId)!.documentAvailable,
    ).toBe(true);

    expect(await deleteImport(imported.importId)).toBeDefined();
    expect(await exists()).toBe(false);
  });

  /**
   * The other arm of the restore, and the crafted backup with it. A claim the disk
   * cannot honour is not refused at restore time any more - it is answered at read
   * time, by the hash the row carries: a claim reaches a file only where the derived
   * key names one, and the bytes under it must hash to what the row recorded. So the
   * forged row resolves to a ref (the column is restored) and reads as nothing.
   */
  it('a restored claim reaches no file the row did not record', async () => {
    const statement = Buffer.from('date,amount,description\n2026-06-06,-42.00,Claimed\n', 'utf8');
    const fileHash = crypto.createHash('sha256').update(statement).digest('hex');
    const record = await createImport({ fileHash, sourceType: 'csv', parserVersion: 1 });
    await markImportCommitted(record.id, 1, 0);
    await putDocument({ importId: record.id, originalFilename: null, sourceType: 'csv' }, statement);
    await recordImportDocument(record.id);
    expect(await getDocument((await getImportDocumentRef(record.id))!)).toEqual(statement);

    const data = JSON.parse(JSON.stringify(await exportBackup())) as BackupData;
    const claimed = crypto.randomUUID();
    data.tables.imports.push({
      id: claimed,
      // its own hash: two committed imports of one file are what the partial index refuses
      fileHash: crypto.createHash('sha256').update('claimed').digest('hex'),
      sourceType: 'csv',
      originalFilename: 'claimed.csv',
      uploadedAt: new Date().toISOString(),
      parserVersion: 1,
      status: 'committed',
      rowsAccepted: 1,
      rowsRejected: 0,
      errorDetail: null,
      documentStored: true,
    });
    await restoreBackup(parseBackup(data));

    const stored = (await dbInstance().execute(
      sql`SELECT id, document_stored FROM imports WHERE id IN (${record.id}, ${claimed}) ORDER BY id`,
    )) as unknown as { rows: { id: string; document_stored: boolean }[] };
    expect(stored.rows).toHaveLength(2);
    expect(stored.rows.map((r) => r.document_stored)).toEqual([true, true]);

    // the forged row's key names no file, so the read refuses with the class the
    // route turns into a 404 rather than with a fault
    const forged = await getImportDocumentRef(claimed);
    expect(forged).toBeDefined();
    await expect(getDocument(forged!)).rejects.toBeInstanceOf(DocumentMissing);

    // and the real row reads its own bytes back, restore or no restore
    await expect(
      getDocument({ importId: record.id, originalFilename: null, sourceType: 'csv', fileHash }),
    ).resolves.toEqual(statement);
  });

  /**
   * The operator's own upgrade path (ROADMAP 5.4): a backup taken before the bank
   * integrations were deleted is the file they restore from AFTER dropping and
   * recreating the database, so it has to keep working with tables and columns this
   * schema no longer has. The two halves are held differently and both are asserted
   * here - restoreBackup iterates BACKUP_TABLES, so a removed table's key is
   * structurally unreachable, while a removed COLUMN is dropped by sanitizeRow, which
   * is ordinary application code a later change can delete.
   *
   * `tables: 1` is the pin on the first half: the three legacy keys contributed
   * nothing and, more to the point, were never offered to a table that does not exist.
   */
  it('a backup taken before the bank integrations were removed still restores', async () => {
    const legacy = {
      format: 'finto-backup' as const,
      version: 1 as const,
      exportedAt: '2026-05-01T00:00:00.000Z',
      tables: {
        accounts: [
          {
            id: 'acc-legacy',
            provider: 'monobank',
            name: 'Legacy Mono UAH',
            currency: 'UAH',
            balanceCents: 123456,
            iban: null,
            hidden: false,
            // the three columns this task dropped, exactly as an old export wrote them
            ebSessionId: 'eb-session-abc',
            lastSyncedAt: '2026-04-30T21:00:00.000Z',
            historyFrom: '2025-05-01',
          },
        ],
        // three tables this schema no longer knows
        eb_sessions: [
          {
            sessionId: 'eb-session-abc',
            aspspName: 'Revolut',
            aspspCountry: 'LT',
            validUntil: '2026-08-01T00:00:00.000Z',
            createdAt: '2026-05-01T00:00:00.000Z',
          },
        ],
        eb_auth_state: [
          {
            state: 'state-xyz',
            aspspName: 'Revolut',
            aspspCountry: 'LT',
            createdAt: '2026-05-01T00:00:00.000Z',
          },
        ],
        sync_log: [
          {
            id: 1,
            startedAt: '2026-04-30T21:00:00.000Z',
            finishedAt: '2026-04-30T21:04:00.000Z',
            ok: true,
            inserted: 7,
            errors: '[]',
            log: '["done"]',
          },
        ],
      },
    };

    const { tables, rows } = await restoreBackup(parseBackup(legacy));
    expect(tables).toBe(1);
    expect(rows).toBe(1);

    const account = (await listAccounts(true)).find((a) => a.id === 'acc-legacy');
    expect(account).toMatchObject({
      name: 'Legacy Mono UAH',
      currency: 'UAH',
      balance: 1234.56,
      provider: 'monobank',
    });
  });

  /**
   * imports.account_id is an ordinary column, so it exports and restores with no code
   * of its own - exportBackup selects whole rows and sanitizeRow keeps every real
   * column a restore carries like any other. Asserted rather than assumed, because the failure is
   * silent: an import that restores without the id it was staged against is one whose
   * confirm can no longer find its account.
   */
  it('the account an import was staged for survives the round-trip', async () => {
    const imported = await importAndConfirm({
      accountId: await accountFor('Account Id Backup Bank'),
      bytes: Buffer.from('date,amount,description\n2026-06-06,-44.00,Round trip\n', 'utf8'),
    });

    await restoreBackup(parseBackup(JSON.parse(JSON.stringify(await exportBackup()))));

    const restored = (await listImports()).imports.find((i) => i.id === imported.importId)!;
    expect(restored.accountId).toBe(imported.accountId);
    expect(restored.accountName).toBe('Account Id Backup Bank');
  });

  /**
   * accounts_name_unique applies to a restore, which inserts the file's accounts
   * wholesale: a backup holding two names differing only in case now fails, whole.
   * Accepted, and what makes it acceptable rather than catastrophic is that the DELETE
   * and every INSERT are one transaction - a refused restore leaves the database
   * exactly as it was, which is the half asserted here.
   */
  it('a restore refused by the name index leaves the existing rows untouched', async () => {
    await insertTransactions([tx('restore refusal survivor', -12)]);
    const before = await listTransactions({ accountId: 'acc1', limit: 100 });
    expect(before.length).toBeGreaterThan(0);
    const accountsBefore = (await listAccounts(true)).map((a) => a.id).sort();
    expect(accountsBefore.length).toBeGreaterThan(0);

    const clashing = {
      format: 'finto-backup' as const,
      version: 1 as const,
      tables: {
        accounts: [
          { id: 'dup-a', provider: 'upload', name: 'Doubled', currency: 'EUR', balanceCents: 0 },
          { id: 'dup-b', provider: 'upload', name: 'DOUBLED', currency: 'EUR', balanceCents: 0 },
        ],
      },
    };
    // the constraint is read off the cause: drizzle wraps the driver error, and only
    // the name is evidence that this index is what refused the restore
    const refused = await restoreBackup(parseBackup(clashing)).then(
      () => undefined,
      (e: { cause?: unknown }) => e.cause,
    );
    expect(refused).toMatchObject({ code: '23505', constraint: 'accounts_name_unique' });

    expect(await listTransactions({ accountId: 'acc1', limit: 100 })).toHaveLength(before.length);
    // this is the line that depends on the rollback: accounts IS in the backup, so
    // its DELETE ran and only the rollback put the person's own accounts back. The
    // transactions line above does not - a table the backup omits is skipped whole
    expect((await listAccounts(true)).map((a) => a.id).sort()).toEqual(accountsBefore);
    expect((await listAccounts(true)).map((a) => a.id)).not.toContain('dup-a');
  });

  it('parseBackup rejects files that are not a Finto backup', () => {
    expect(() => parseBackup(null)).toThrow(/not a Finto backup/);
    expect(() => parseBackup({ format: 'something-else' })).toThrow(/not a Finto backup/);
    expect(() => parseBackup({ format: 'finto-backup', version: 99, tables: {} })).toThrow(
      /unsupported backup version/,
    );
    expect(() => parseBackup({ format: 'finto-backup', version: 1 })).toThrow(/no tables/);
    expect(() =>
      parseBackup({ format: 'finto-backup', version: 1, tables: { accounts: 'oops' } }),
    ).toThrow(/is not an array/);
  });
});
