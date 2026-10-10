/**
 * The test database, in one of two shapes.
 *
 * By default an embedded PGlite (WASM Postgres) in memory: what every local run and
 * the fast CI job uses, and the same engine the product itself runs on. Set
 * TEST_DATABASE_URL and the same tests run against a real Postgres instead — the
 * second CI job does that, because PGlite is single-connection and cannot exercise
 * anything about concurrency: the partial unique index on imports, or two writers
 * at once.
 *
 * Either way there is one instance per test worker. A PGlite is a whole WASM
 * instance (~tens of MB that never really free), and spawning one per test file -
 * let alone per test - piled up until the worker crashed with a native V8 OOM. So
 * the handle lives on globalThis, surviving vitest's per-file module registry
 * resets, and callers get isolation by truncating every table instead. The driver
 * modules are imported dynamically so the unused one is never loaded at all.
 */
import path from 'path';
import { getTableName, is, sql } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import type { Db } from '../src/db';

export async function schemaTables(): Promise<string[]> {
  const schema = await import('../src/db/schema');
  return Object.values<unknown>(schema)
    .filter((v): v is PgTable => is(v, PgTable))
    .map((t) => getTableName(t));
}

const g = globalThis as typeof globalThis & { __quietpurseTestDb?: Db };

const MIGRATIONS = { migrationsFolder: path.resolve(process.cwd(), 'drizzle') };

/**
 * The first thing the suite does to a database is TRUNCATE every table in it, so
 * pointing it at the wrong one destroys real data - and a person's own database is
 * one typo away (`quietpurse` vs `quietpurse_test`) from the URL they would paste. Refuse
 * anything not named for the purpose rather than discover the mistake afterwards.
 */
export function assertTestDatabase(url: string): void {
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!/(^|_)test$/.test(name)) {
    throw new Error(
      `TEST_DATABASE_URL points at database "${name}", and the suite truncates every ` +
        `table it connects to. Name the database with a _test suffix (quietpurse_test) and ` +
        `create it separately from the one you use.`,
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

/** A migrated, empty database (shared instance, all tables truncated). */
export async function freshTestDb(): Promise<Db> {
  if (!g.__quietpurseTestDb) {
    g.__quietpurseTestDb = await connect();
  }
  // a real Postgres survives the process: the previous run's rows are still there
  await truncateAll(g.__quietpurseTestDb);
  return g.__quietpurseTestDb;
}

/** The order does not matter: CASCADE follows the foreign keys. */
async function truncateAll(db: Db): Promise<void> {
  const list = (await schemaTables()).map((t) => `"${t}"`).join(', ');
  await db.execute(sql.raw(`TRUNCATE ${list} RESTART IDENTITY CASCADE`));
}
