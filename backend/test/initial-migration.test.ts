import fs from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = path.resolve(process.cwd(), 'drizzle');

const goalTables = [
  'baseline_items',
  'category_spending_goals',
  'debt_payoff_goals',
  'emergency_fund_goals',
  'financial_independence_goals',
  'goal_accounts',
  'goals',
  'monthly_income_goals',
  'savings_balance_goals',
  'savings_rate_goals',
] as const;

describe('0000_initial', () => {
  it('is the only migration and snapshot before release', async () => {
    const migrationFiles = (await fs.readdir(MIGRATIONS))
      .filter((name) => name.endsWith('.sql'))
      .sort();
    const snapshotFiles = (await fs.readdir(path.join(MIGRATIONS, 'meta')))
      .filter((name) => name.endsWith('_snapshot.json'))
      .sort();
    const journal = JSON.parse(
      await fs.readFile(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ idx: number; tag: string }> };

    expect(migrationFiles).toEqual(['0000_initial.sql']);
    expect(snapshotFiles).toEqual(['0000_snapshot.json']);
    expect(journal.entries).toEqual([
      expect.objectContaining({ idx: 0, tag: '0000_initial' }),
    ]);
  });

  it('creates the current normalized schema without a legacy upgrade phase', async () => {
    const client = new PGlite();
    try {
      const db = drizzle(client);
      await migrate(db, { migrationsFolder: MIGRATIONS });

      const tables = await db.execute<{ tablename: string }>(sql`
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename IN (${sql.join(goalTables.map((name) => sql`${name}`), sql`, `)})
        ORDER BY tablename
      `);
      const goals = await db.execute<{ count: number }>(
        sql`SELECT COUNT(*)::int AS count FROM goals`,
      );
      const baseline = await db.execute<{ count: number }>(
        sql`SELECT COUNT(*)::int AS count FROM baseline_items`,
      );
      const budgets = await db.execute<{ name: string | null }>(
        sql`SELECT to_regclass('budgets')::text AS name`,
      );
      const baselineGoal = await db.execute<{ is_nullable: string }>(sql`
        SELECT is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'baseline_items'
          AND column_name = 'goal_id'
      `);

      expect(tables.rows.map((row) => row.tablename)).toEqual([...goalTables].sort());
      expect(goals.rows[0].count).toBe(0);
      expect(baseline.rows[0].count).toBe(0);
      expect(budgets.rows[0].name).toBeNull();
      expect(baselineGoal.rows).toEqual([{ is_nullable: 'NO' }]);
    } finally {
      await client.close();
    }
  });
});
