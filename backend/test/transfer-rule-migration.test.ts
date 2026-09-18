import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../src/db';

it('upgrades an existing database without rewriting transactions or expanding its rules', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'finto-rule-migration-'));
  const client = new PGlite();
  try {
    await fs.mkdir(path.join(directory, 'meta'));
    const journal = JSON.parse(await fs.readFile(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'));
    const initial = journal.entries[0];
    await fs.writeFile(path.join(directory, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: [initial] }));
    await fs.copyFile(path.join(MIGRATIONS_DIR, `${initial.tag}.sql`), path.join(directory, `${initial.tag}.sql`));
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: directory });
    await client.exec(`
      INSERT INTO accounts (id, provider, name, currency) VALUES ('old', 'upload', 'Existing account', 'EUR');
      INSERT INTO transactions (id, account_id, dedup_key, provider, amount_cents, currency, date, description, transfer_manual)
      VALUES ('old-tx', 'old', 'old-key', 'upload', 5000, 'EUR', '2026-08-31', 'Example Wertstellung 31.08.2026', false);
      INSERT INTO transfer_rules (description, account_id, created_at)
      VALUES ('Example Wertstellung 31.08.2026', 'old', '2026-09-01');
    `);
    const before = await client.query('SELECT * FROM transactions');
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    expect((await client.query('SELECT * FROM transactions')).rows).toEqual(before.rows);
    expect((await client.query('SELECT description, account_id, match_mode FROM transfer_rules')).rows).toEqual([
      { description: 'Example Wertstellung 31.08.2026', account_id: 'old', match_mode: 'exact' },
    ]);
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    expect((await client.query('SELECT * FROM transactions')).rows).toEqual(before.rows);
    await expect(client.exec("UPDATE transfer_rules SET match_mode = 'unknown'")).rejects.toMatchObject({ code: '23514' });
  } finally {
    await client.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
