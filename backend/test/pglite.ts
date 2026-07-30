/**
 * The test database, in one of two shapes.
 *
 * By default an embedded PGlite (WASM Postgres): no Docker, no server, and what
 * every local run and the fast CI job uses. Set TEST_DATABASE_URL and the same
 * tests run against a real Postgres instead — the second CI job does that,
 * because PGlite is single-connection and cannot exercise anything about
 * concurrency: the partial unique index on imports, or two writers at once.
 *
 * Either way there is one instance per test worker. A PGlite is a whole WASM
 * instance (~tens of MB that never really free), and spawning one per test file -
 * let alone per test - piled up until the worker crashed with a native V8 OOM. So
 * the handle lives on globalThis, surviving vitest's per-file module registry
 * resets, and callers get isolation by truncating every table instead. The driver
 * modules are imported dynamically so the unused one is never loaded at all.
 */
import path from 'path';
import { sql } from 'drizzle-orm';
import type { Db } from '../src/db';

/**
 * Truncated between test files. The order does not matter (CASCADE follows the
 * workspace_id foreign keys), but `organization` must be in the list: it is the
 * parent of every data table, and leaving stale workspaces behind would let one
 * file's rows leak into the next file's scoped queries.
 */
const TABLES = [
  'accounts',
  'imports',
  'transactions',
  // CASCADE would reach it through the foreign key on imports; listed so the next
  // reader does not have to work that out
  'staged_transactions',
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

const g = globalThis as typeof globalThis & { __fintoTestDb?: Db };

/**
 * The workspace every test runs in. Tests call the db layer directly rather than
 * through HTTP, so there is no session to derive a workspace from - setup.ts
 * points setWorkspaceFallback() at this id (see src/db/workspace.ts). Tests that
 * need to prove isolation create a second workspace themselves.
 */
export const TEST_WORKSPACE_ID = 'test-workspace';

const MIGRATIONS = { migrationsFolder: path.resolve(process.cwd(), 'drizzle') };

/**
 * The first thing the suite does to a database is TRUNCATE every table in it, so
 * pointing it at the wrong one destroys real data - and the dev database is one
 * typo away (`finto` vs `finto_test`) from the URL a person would paste. Refuse
 * anything not named for the purpose rather than discover the mistake afterwards.
 */
export function assertTestDatabase(url: string): void {
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!/(^|_)test$/.test(name)) {
    throw new Error(
      `TEST_DATABASE_URL points at database "${name}", and the suite truncates every ` +
        `table it connects to. Name the database with a _test suffix (finto_test) and ` +
        `create it separately from the one you develop against.`,
    );
  }
}

async function connect(): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL;
  if (url) {
    assertTestDatabase(url);
    const { Pool } = await import('pg');
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    // idle connections would otherwise hold the event loop open past the last test
    const db = drizzle(new Pool({ connectionString: url, allowExitOnIdle: true }));
    await migrate(db, MIGRATIONS);
    return db;
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const { migrate } = await import('drizzle-orm/pglite/migrator');
  const db = drizzle(new PGlite());
  await migrate(db, MIGRATIONS);
  return db;
}

/**
 * A migrated, empty database (shared instance, all tables truncated) with the
 * test workspace row present - the data tables' workspace_id references it, so
 * nothing can be inserted before it exists.
 */
export async function freshTestDb(): Promise<Db> {
  if (!g.__fintoTestDb) {
    g.__fintoTestDb = await connect();
    // a real Postgres survives the process: the previous run's rows are still there
    await truncateAll(g.__fintoTestDb);
    await createWorkspace(g.__fintoTestDb, TEST_WORKSPACE_ID);
    return g.__fintoTestDb;
  }
  await truncateAll(g.__fintoTestDb);
  await createWorkspace(g.__fintoTestDb, TEST_WORKSPACE_ID);
  return g.__fintoTestDb;
}

async function truncateAll(db: Db): Promise<void> {
  // quoted: `user` is a reserved word in Postgres
  const list = TABLES.map((t) => `"${t}"`).join(', ');
  await db.execute(sql.raw(`TRUNCATE ${list} RESTART IDENTITY CASCADE`));
}

/** Adds a workspace (an `organization` row) - the FK target for all data tables. */
export async function createWorkspace(db: Db, id: string): Promise<string> {
  await db.execute(
    sql`INSERT INTO organization (id, name, created_at) VALUES (${id}, ${id}, now())
        ON CONFLICT (id) DO NOTHING`,
  );
  return id;
}
