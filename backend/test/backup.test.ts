import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  BackupData,
  commitImport,
  createImport,
  dbInstance,
  deleteImport,
  exportBackup,
  getImportDocumentRef,
  getTransaction,
  insertTransactions,
  listImports,
  listTransactions,
  parseBackup,
  recordImportDocument,
  restoreBackup,
  runWithWorkspace,
  setOneOff,
} from '../src/db';
import { getDocument, putDocument } from '../src/documents';
import { importStatement } from '../src/providers/statement';
import { storageRoot } from '../src/storage';
import { NewTransaction } from '../src/types';
import { createWorkspace, TEST_WORKSPACE_ID } from './pglite';
import { idOf } from './helpers';

const tx = (description: string, amount: number): NewTransaction => ({
  accountId: 'acc1',
  provider: 'monobank',
  amount,
  currency: 'EUR',
  date: '2026-01-10T12:00:00.000Z',
  description,
  category: 'other',
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

  /** imports restore before transactions, or import_id would have nothing to point at. */
  it('an import and the provenance of its rows survive the round-trip', async () => {
    const record = await createImport({
      fileHash: 'backup-hash',
      sourceType: 'csv',
      parserVersion: 1,
      originalFilename: 'statement.csv',
    });
    await commitImport(record.id, 1, 0);
    await insertTransactions([tx('backup provenance', -33)], record.id);

    await restoreBackup(parseBackup(JSON.parse(JSON.stringify(await exportBackup()))));

    const restored = (await listImports()).find((i) => i.id === record.id)!;
    expect(restored).toMatchObject({
      fileHash: 'backup-hash',
      originalFilename: 'statement.csv',
      status: 'committed',
    });
    expect(restored.transactions).toBe(1);
  });

  /**
   * A restore strips the document pointer, so the workspace's own documents become
   * unreadable even though the ids - and therefore the keys - come back identical.
   * They must not also become undeletable: deleteImport addresses a document
   * without consulting the pointer, and this asserts it on the DISK rather than on
   * a return value, because that is the only thing that distinguishes the two.
   */
  it('a restore leaves the documents on disk, and deleting the import still removes them', async () => {
    const csv = 'date,amount,description\n2026-05-05,-21.00,Restore then delete\n';
    const imported = await importStatement({
      accountName: 'Restore Document Bank',
      currency: 'EUR',
      bytes: Buffer.from(csv, 'utf8'),
    });
    const blob = path.join(storageRoot(), TEST_WORKSPACE_ID, imported.importId);
    const exists = (): Promise<boolean> =>
      fs
        .access(blob)
        .then(() => true)
        .catch(() => false);
    expect(await exists()).toBe(true);

    await restoreBackup(parseBackup(JSON.parse(JSON.stringify(await exportBackup()))));

    // the pointer is gone, the bytes are not
    expect(await getImportDocumentRef(imported.importId)).toBeUndefined();
    expect(await exists()).toBe(true);

    expect(await deleteImport(imported.importId)).toBeDefined();
    expect(await exists()).toBe(false);
  });

  /**
   * The crafted backup: a row naming ANOTHER workspace's import id, with that
   * workspace's file hash and a document pointer, restored into this one. Two
   * independent guards have to stand between it and the neighbour's bank
   * statement, so both get their own assertion - with one shared assertion,
   * removing either guard would leave the test green.
   */
  it('a restored row cannot claim another workspace document', async () => {
    const victim = 'doc-victim';
    await createWorkspace(dbInstance(), victim);
    const statement = Buffer.from('date,amount,description\n2026-06-06,-42.00,Theirs\n', 'utf8');
    const fileHash = crypto.createHash('sha256').update(statement).digest('hex');

    const victimImportId = await runWithWorkspace(victim, async () => {
      const record = await createImport({ fileHash, sourceType: 'csv', parserVersion: 1 });
      await commitImport(record.id, 1, 0);
      await recordImportDocument(record.id, await putDocument(record.id, statement));
      return record.id;
    });

    const data = JSON.parse(JSON.stringify(await exportBackup())) as BackupData;
    data.tables.imports.push({
      id: victimImportId,
      fileHash,
      sourceType: 'csv',
      originalFilename: 'theirs.csv',
      uploadedBy: null,
      uploadedAt: new Date().toISOString(),
      parserVersion: 1,
      status: 'committed',
      rowsAccepted: 1,
      rowsRejected: 0,
      errorDetail: null,
      documentKeyVersion: 1,
    });
    await restoreBackup(parseBackup(data));

    // guard B: the pointer never survives a restore
    const stored = (await dbInstance().execute(
      sql`SELECT document_key_version FROM imports
          WHERE workspace_id = ${TEST_WORKSPACE_ID} AND id = ${victimImportId}`,
    )) as unknown as { rows: { document_key_version: number | null }[] };
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0].document_key_version).toBeNull();
    expect(await getImportDocumentRef(victimImportId)).toBeUndefined();

    // guard A: even a ref forged past the strip resolves to this workspace's key
    await expect(
      getDocument({ importId: victimImportId, keyVersion: 1, fileHash }),
    ).rejects.toThrow(/no bytes at/);

    // and the victim still has their own document
    await runWithWorkspace(victim, async () => {
      expect(await getDocument((await getImportDocumentRef(victimImportId))!)).toEqual(statement);
    });
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
