import { describe, expect, it } from 'vitest';
import {
  commitImport,
  createImport,
  exportBackup,
  getTransaction,
  insertTransactions,
  listImports,
  listTransactions,
  parseBackup,
  restoreBackup,
  setOneOff,
} from '../src/db';
import { NewTransaction } from '../src/types';
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
