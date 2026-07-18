import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  backupTo,
  getTransaction,
  insertTransactions,
  listTransactions,
  migrateAfterRestore,
  restoreFrom,
  setOneOff,
} from '../src/db';
import { Transaction } from '../src/types';

const tmp = path.join(os.tmpdir(), `finto-test-backup-${process.pid}.db`);

afterAll(() => {
  fs.rmSync(tmp, { force: true });
});

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

describe('backup and restore', () => {
  it('a dump restores the data, manual marks included', async () => {
    insertTransactions([tx('bk-1', -10), tx('bk-2', -20)]);
    setOneOff('bk-1', true);

    await backupTo(tmp);
    expect(fs.readFileSync(tmp).subarray(0, 15).toString()).toBe('SQLite format 3');

    // "disaster": the mark is cleared, then we restore from the dump
    setOneOff('bk-1', false);
    expect(getTransaction('bk-1')!.oneOff).toBe(false);

    const { tables, rows } = restoreFrom(tmp);
    migrateAfterRestore();
    expect(tables).toBeGreaterThan(0);
    expect(rows).toBeGreaterThan(0);
    expect(getTransaction('bk-1')!.oneOff).toBe(true);
    expect(listTransactions({ accountId: 'acc1' }).length).toBeGreaterThanOrEqual(2);
  });
});
