/**
 * transfer_rules.match_mode is a column with a default and a CHECK, held here on
 * whichever engine the suite runs on. A backup taken before the column existed carries
 * no matchMode key, sanitizeRow passes what it has, and the insert leaves the column to
 * its default.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, expect, it } from 'vitest';
import { dbInstance, listTransferRules, parseBackup, restoreBackup } from '../src/db';
import { freshTestDb } from './pglite';

beforeEach(async () => {
  await freshTestDb();
});

it('a backup from before the matching mode existed restores its transfer rules as exact', async () => {
  const backup = parseBackup({
    format: 'finto-backup',
    version: 1,
    tables: {
      transfer_rules: [
        { id: 7, description: 'Example Wertstellung 31.08.2026', accountId: 'old', createdAt: '2026-09-01' },
      ],
    },
  });
  expect(await restoreBackup(backup)).toEqual({ tables: 1, rows: 1 });
  expect(await listTransferRules()).toEqual([
    {
      id: expect.any(Number),
      description: 'Example Wertstellung 31.08.2026',
      accountId: 'old',
      matchMode: 'exact',
      createdAt: '2026-09-01',
    },
  ]);
});

it('the column refuses a matching mode outside its vocabulary', async () => {
  const write = dbInstance().execute(sql`
    INSERT INTO transfer_rules (description, account_id, match_mode, created_at)
    VALUES ('Example Wertstellung 31.08.2026', 'old', 'unknown', '2026-09-01')`);
  const { code, constraint } = (await write.then(
    () => ({}),
    (e: { cause?: { code?: string; constraint?: string } }) => e.cause ?? {},
  )) as { code?: string; constraint?: string };
  expect({ code, constraint }).toEqual({ code: '23514', constraint: 'transfer_rules_match_mode_check' });
  expect(await listTransferRules()).toEqual([]);
});
