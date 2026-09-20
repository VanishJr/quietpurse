import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = path.resolve(process.cwd(), 'drizzle');

const databaseAtInitialMigration = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'finto-goals-migration-'));
  await fs.mkdir(path.join(directory, 'meta'));
  await fs.copyFile(
    path.join(MIGRATIONS, '0000_initial.sql'),
    path.join(directory, '0000_initial.sql'),
  );
  const journal = JSON.parse(
    await fs.readFile(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8'),
  ) as { version: string; dialect: string; entries: unknown[] };
  await fs.writeFile(
    path.join(directory, 'meta', '_journal.json'),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, 1) }),
  );
  const client = new PGlite();
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: directory });
  await fs.rm(directory, { recursive: true, force: true });
  return { client, db };
};

describe('0001_goals', () => {
  it('leaves a fresh installation with no goals', async () => {
    const client = new PGlite();
    try {
      const db = drizzle(client);
      await migrate(db, { migrationsFolder: MIGRATIONS });
      const goals = await db.execute<{ count: number }>(sql`SELECT COUNT(*)::int AS count FROM goals`);
      const old = await db.execute<{ name: string | null }>(sql`SELECT to_regclass('budgets')::text AS name`);
      expect(goals.rows[0].count).toBe(0);
      expect(old.rows[0].name).toBeNull();
    } finally {
      await client.close();
    }
  });

  it('upgrades singleton settings, baseline costs and budgets in place', async () => {
    const { client, db } = await databaseAtInitialMigration();
    try {
      await db.execute(sql`
        INSERT INTO meta (key, value) VALUES
          ('settings', '{"goalMode":"lifestyle","bufferPct":15,"windowMonths":12,"hourlyRate":25,"hoursCapPerWeek":30}')
      `);
      await db.execute(sql`INSERT INTO settings (key, value) VALUES ('base_currency', 'USD')`);
      await db.execute(sql`
        INSERT INTO baseline_items (label, monthly_cents, sort) VALUES
          ('Rent', 90000, 0), ('Food', 30000, 1)
      `);
      await db.execute(sql`INSERT INTO budgets (category, monthly_cents) VALUES ('groceries', 45000)`);

      await migrate(db, { migrationsFolder: MIGRATIONS });

      const goals = await db.execute<{
        id: string;
        type: string;
        name: string;
      }>(sql`SELECT id, type, name FROM goals ORDER BY type`);
      expect(goals.rows).toEqual([
        expect.objectContaining({ type: 'category-spending-limit' }),
        expect.objectContaining({
          id: '00000000-0000-4000-8000-000000000001',
          type: 'financial-independence',
          name: 'Financial independence',
        }),
      ]);

      const financial = await db.execute<{
        basis: string;
        buffer_pct: number;
        window_months: number;
        hourly_rate_cents: number;
        hours_per_week: number;
      }>(sql`SELECT basis, buffer_pct, window_months, hourly_rate_cents, hours_per_week
             FROM financial_independence_goals`);
      expect(financial.rows[0]).toEqual({
        basis: 'current-spending',
        buffer_pct: 15,
        window_months: 12,
        hourly_rate_cents: 2500,
        hours_per_week: 30,
      });

      const costs = await db.execute<{ label: string; monthly_cents: number; goal_id: string }>(
        sql`SELECT label, monthly_cents, goal_id FROM baseline_items ORDER BY sort`,
      );
      expect(costs.rows).toEqual([
        { label: 'Rent', monthly_cents: 90000, goal_id: '00000000-0000-4000-8000-000000000001' },
        { label: 'Food', monthly_cents: 30000, goal_id: '00000000-0000-4000-8000-000000000001' },
      ]);

      const category = await db.execute<{
        category: string;
        monthly_limit_cents: number;
        base_currency: string;
      }>(sql`SELECT category, monthly_limit_cents, base_currency FROM category_spending_goals`);
      expect(category.rows).toEqual([
        { category: 'groceries', monthly_limit_cents: 45000, base_currency: 'USD' },
      ]);
      const legacySettings = await db.execute<{ count: number }>(
        sql`SELECT COUNT(*)::int AS count FROM meta WHERE key = 'settings'`,
      );
      expect(legacySettings.rows[0].count).toBe(0);
    } finally {
      await client.close();
    }
  });

  it('uses bounded defaults for malformed legacy settings', async () => {
    const { client, db } = await databaseAtInitialMigration();
    try {
      await db.execute(sql`INSERT INTO meta (key, value) VALUES ('settings', '{not json')`);
      await migrate(db, { migrationsFolder: MIGRATIONS });
      const rows = await db.execute<{
        basis: string;
        buffer_pct: number;
        window_months: number;
        hourly_rate_cents: number | null;
        hours_per_week: number;
      }>(sql`SELECT basis, buffer_pct, window_months, hourly_rate_cents, hours_per_week
             FROM financial_independence_goals`);
      expect(rows.rows[0]).toEqual({
        basis: 'essential-costs',
        buffer_pct: 10,
        window_months: 6,
        hourly_rate_cents: null,
        hours_per_week: 20,
      });
    } finally {
      await client.close();
    }
  });
});
