/**
 * One shared PGlite (embedded Postgres) per test worker. Each PGlite is a whole
 * WASM instance (~tens of MB that never really free), and spawning one per test
 * file - let alone per test - piled up until the worker crashed with a native
 * V8 OOM. So the instance lives on globalThis, surviving vitest's per-file module
 * registry resets, and callers get isolation by truncating every table instead.
 */
import path from 'path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { sql } from 'drizzle-orm';

/**
 * Truncated between test files. The order does not matter (CASCADE follows the
 * workspace_id foreign keys), but `organization` must be in the list: it is the
 * parent of every data table, and leaving stale workspaces behind would let one
 * file's rows leak into the next file's scoped queries.
 */
const TABLES = [
  'accounts',
  'transactions',
  'fx_rates',
  'category_rules',
  'transfer_rules',
  'recurring_ignores',
  'budgets',
  'baseline_items',
  'income_sources',
  'settings',
  'meta',
  'eb_sessions',
  'eb_auth_state',
  'sync_log',
  // auth/workspace tables
  'organization',
  'member',
  'invitation',
  'session',
  'auth_account',
  'verification',
  'user',
];

const g = globalThis as typeof globalThis & { __fintoPglite?: PGlite };

/**
 * The workspace every test runs in. Tests call the db layer directly rather than
 * through HTTP, so there is no session to derive a workspace from - setup.ts
 * points setWorkspaceFallback() at this id (see src/db/workspace.ts). Tests that
 * need to prove isolation create a second workspace themselves.
 */
export const TEST_WORKSPACE_ID = 'test-workspace';

/**
 * A migrated, empty database (shared instance, all tables truncated) with the
 * test workspace row present - the data tables' workspace_id references it, so
 * nothing can be inserted before it exists.
 */
export async function freshTestDb() {
  if (!g.__fintoPglite) {
    g.__fintoPglite = new PGlite();
    const db = drizzle(g.__fintoPglite);
    await migrate(db, { migrationsFolder: path.resolve(process.cwd(), 'drizzle') });
    await createWorkspace(db, TEST_WORKSPACE_ID);
    return db;
  }
  const db = drizzle(g.__fintoPglite);
  // quoted: `user` is a reserved word in Postgres
  const list = TABLES.map((t) => `"${t}"`).join(', ');
  await db.execute(sql.raw(`TRUNCATE ${list} RESTART IDENTITY CASCADE`));
  await createWorkspace(db, TEST_WORKSPACE_ID);
  return db;
}

/** Adds a workspace (an `organization` row) - the FK target for all data tables. */
export async function createWorkspace(
  db: ReturnType<typeof drizzle>,
  id: string,
): Promise<string> {
  await db.execute(
    sql`INSERT INTO organization (id, name, created_at) VALUES (${id}, ${id}, now())
        ON CONFLICT (id) DO NOTHING`,
  );
  return id;
}
