import { describe, expect, it } from 'vitest';
import {
  exportBackup,
  getTransaction,
  insertTransactions,
  listTransactions,
  parseBackup,
  restoreBackup,
  setOneOff,
} from '../src/db';
import { Transaction } from '../src/types';

const tx = (id: string, amount: number): Transaction => ({
  id,
  accountId: 'acc1',
  provider: 'monobank',
  amount,
  currency: 'EUR',
  date: '2026-01-10T12:00:00.000Z',
  description: 'backup test',
  category: 'other',
});

describe('backup and restore (JSON)', () => {
  it('a backup restores the data, manual marks included', async () => {
    await insertTransactions([tx('bk-1', -10), tx('bk-2', -20)]);
    await setOneOff('bk-1', true);

    const data = await exportBackup();
    expect(data.format).toBe('finto-backup');
    expect(data.tables.transactions.length).toBeGreaterThanOrEqual(2);

    // the file survives a JSON round-trip (that is exactly what the endpoint sends)
    const reparsed = parseBackup(JSON.parse(JSON.stringify(data)));

    // "disaster": the mark is cleared, then we restore from the backup
    await setOneOff('bk-1', false);
    expect((await getTransaction('bk-1'))!.oneOff).toBe(false);

    const { tables, rows } = await restoreBackup(reparsed);
    expect(tables).toBeGreaterThan(0);
    expect(rows).toBeGreaterThan(0);
    expect((await getTransaction('bk-1'))!.oneOff).toBe(true);
    expect((await listTransactions({ accountId: 'acc1' })).length).toBeGreaterThanOrEqual(2);
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
