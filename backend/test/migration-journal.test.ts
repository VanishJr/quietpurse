/**
 * A database whose applied migrations are not this tree's. drizzle applies only the
 * entries newer than the last one its journal table records, so a database migrated by
 * another checkout's regenerated initial migration skips the forward migration in
 * silence: the start reports ready and every query naming the new column fails after
 * it. The refusal is a boot check that reads the journal before anything is written and
 * again after migrating, so it is exercised through connectDatabase() and never through
 * the suite's own harness, which migrates without it.
 *
 * The accept direction is in the same case as the refusal on purpose: a check that
 * refused every database would turn every refusal case green.
 */
import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { Client, Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { MIGRATIONS_DIR, closeDatabase, connectDatabase, initDb } from '../src/db';
import { freshTestDb } from './pglite';

const tree = readMigrationFiles({ migrationsFolder: MIGRATIONS_DIR });
/** A hash this tree has no file for, planted in the journal of a database this tree
 * migrated. Stamped after everything the tree carries it is the newest row, the one a
 * newest-only read would see; stamped between the initial migration and the first forward
 * one it sits under the tree's own newest row, and only a read of the whole journal sees
 * it. The position is the row's place in timestamp order, which the refusal names. */
const foreignHash = crypto.createHash('sha256').update('a regenerated initial migration from another checkout').digest('hex');
const stamps: [string, number, number][] = [
  ['after everything this tree carries', tree.at(-1)!.folderMillis + 1, 3],
  ['between the initial migration and the first forward one', tree[0].folderMillis + 1, 2],
];

const expectRefusal = async (
  attempt: Promise<void>,
  location: string,
  position: number,
  hash: string,
  createdAt: number,
): Promise<void> => {
  await expect(attempt).rejects.toThrow(`its migration ${position} is ${hash}`);
  await expect(attempt).rejects.toThrow(String(createdAt));
  await expect(attempt).rejects.toThrow(location);
  await expect(attempt).rejects.not.toThrow(/Failed query|params:/);
};

/** connectDatabase() installs the handle it opened; whichever way a case ends, the
 * suite's own database goes back in its place. */
afterEach(async () => {
  await closeDatabase();
  initDb(await freshTestDb());
});

describe.each(stamps)('a database migrated by a build this tree does not know, its row stamped %s', (_, createdAt, position) => {
  it('is refused by name on the embedded engine, where a database this tree migrated connects', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'finto-foreign-journal-'));
    const before = config.databaseDir;
    try {
      config.databaseDir = directory;
      await expect(connectDatabase()).resolves.toBeUndefined();
      await closeDatabase();

      const client = new PGlite(directory);
      await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_DIR });
      await client.query(`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)`, [foreignHash, createdAt]);
      await client.close();
      await expectRefusal(connectDatabase(), directory, position, foreignHash, createdAt);
    } finally {
      config.databaseDir = before;
      await closeDatabase();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(!process.env.TEST_DATABASE_URL)('is refused by name on a PostgreSQL server, where the suite\'s own database connects', async () => {
    const url = process.env.TEST_DATABASE_URL!;
    const shared = await freshTestDb();
    const before = config.databaseUrl;
    try {
      config.databaseUrl = url;
      await expect(connectDatabase()).resolves.toBeUndefined();
      await closeDatabase();

      await shared.execute(sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${foreignHash}, ${createdAt})`);
      await expectRefusal(connectDatabase(), new URL(url).pathname.slice(1), position, foreignHash, createdAt);
    } finally {
      config.databaseUrl = before;
      await closeDatabase();
      await shared.execute(sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${foreignHash}`);
    }
  });
});

/**
 * The journal shapes a build ships rather than a planted row: this tree's initial
 * migration alone, as every database from before the first forward migration carries it,
 * and the two a checkout that regenerated that file leaves behind - the file altered and
 * stamped inside the window before the forward migration, and the file unchanged under a
 * later stamp, which drizzle reads as "already past the forward migration". Each is
 * built the way transfer-rule-migration.test.ts builds its folder and migrated by drizzle
 * alone, so the database is exactly what that build would have written.
 */
const initialMigrationFolder = async (alter: { when?: number; prefix?: string } = {}): Promise<string> => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'finto-initial-migration-'));
  await fs.mkdir(path.join(folder, 'meta'));
  const journal = JSON.parse(await fs.readFile(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'));
  const initial = journal.entries[0];
  await fs.writeFile(
    path.join(folder, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries: [{ ...initial, when: alter.when ?? initial.when }] }),
  );
  const file = await fs.readFile(path.join(MIGRATIONS_DIR, `${initial.tag}.sql`), 'utf8');
  await fs.writeFile(path.join(folder, `${initial.tag}.sql`), (alter.prefix ?? '') + file);
  return folder;
};

const JOURNAL = 'SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at ASC, id ASC';
const MATCH_MODE = "SELECT 1 FROM information_schema.columns WHERE table_name = 'transfer_rules' AND column_name = 'match_mode'";

/** A database migrated from the folder, with config pointed at it so the next
 * connectDatabase() meets it the way the start would. `rows` reads it through a
 * connection of its own, after the start's is closed. */
type MigratedFrom = {
  location: string;
  rows(query: string): Promise<Record<string, unknown>[]>;
  cleanup(): Promise<void>;
};

const embeddedFrom = async (folder: string): Promise<MigratedFrom> => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'finto-foreign-journal-'));
  const before = config.databaseDir;
  config.databaseDir = directory;
  const client = new PGlite(directory);
  await migrate(drizzle(client), { migrationsFolder: folder });
  await client.close();
  return {
    location: directory,
    rows: async (query) => {
      const reader = new PGlite(directory);
      try {
        return (await reader.query<Record<string, unknown>>(query)).rows;
      } finally {
        await reader.close();
      }
    },
    cleanup: async () => {
      config.databaseDir = before;
      await closeDatabase();
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
};

/** Its own database on the server, named for the suite's refusal rule and dropped after;
 * the suite's own database is never migrated from a foreign folder. */
const serverFrom = async (folder: string): Promise<MigratedFrom> => {
  const name = 'finto_journal_test';
  const url = new URL(process.env.TEST_DATABASE_URL!);
  const admin = new Client({ connectionString: url.href });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.href });
  await migratePg(drizzlePg(pool), { migrationsFolder: folder });
  await pool.end();
  const before = config.databaseUrl;
  config.databaseUrl = url.href;
  return {
    location: name,
    rows: async (query) => {
      const reader = new Client({ connectionString: url.href });
      await reader.connect();
      try {
        return (await reader.query(query)).rows;
      } finally {
        await reader.end();
      }
    },
    cleanup: async () => {
      config.databaseUrl = before;
      await closeDatabase();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
};

const engines: [string, (folder: string) => Promise<MigratedFrom>, boolean][] = [
  ['the embedded engine', embeddedFrom, true],
  ['a PostgreSQL server', serverFrom, Boolean(process.env.TEST_DATABASE_URL)],
];

describe.each(engines)('a database carrying the initial migration alone, on %s', (_, migratedFrom, available) => {
  const on = it.skipIf(!available);

  on('from this tree, is accepted and upgraded in place', async () => {
    const folder = await initialMigrationFolder();
    const database = await migratedFrom(folder);
    try {
      expect(await database.rows(JOURNAL)).toHaveLength(1);
      await expect(connectDatabase()).resolves.toBeUndefined();
      await closeDatabase();
      expect((await database.rows(JOURNAL)).map((row) => row.hash)).toEqual(tree.map((entry) => entry.hash));
      expect(await database.rows(MATCH_MODE)).toHaveLength(1);
    } finally {
      await database.cleanup();
      await fs.rm(folder, { recursive: true, force: true });
    }
  });

  on('regenerated by another checkout and stamped inside the window before the forward migration, is refused with nothing written', async () => {
    const folder = await initialMigrationFolder({ when: tree[0].folderMillis + 1, prefix: '-- regenerated by another checkout\n' });
    const [shipped] = readMigrationFiles({ migrationsFolder: folder });
    const database = await migratedFrom(folder);
    try {
      expect(shipped.hash).not.toBe(tree[0].hash);
      await expectRefusal(connectDatabase(), database.location, 1, shipped.hash, shipped.folderMillis);
      expect((await database.rows(JOURNAL)).map((row) => row.hash)).toEqual([shipped.hash]);
      expect(await database.rows(MATCH_MODE)).toHaveLength(0);
    } finally {
      await database.cleanup();
      await fs.rm(folder, { recursive: true, force: true });
    }
  });

  on('from this tree but stamped after the forward migration, is refused once migrating has applied nothing', async () => {
    const folder = await initialMigrationFolder({ when: tree.at(-1)!.folderMillis + 1 });
    const database = await migratedFrom(folder);
    try {
      const attempt = connectDatabase();
      await expect(attempt).rejects.toThrow(`its migration 2 is missing (it has 1), and this build's migration 2 is ${tree[1].hash}`);
      await expect(attempt).rejects.toThrow(database.location);
      await expect(attempt).rejects.not.toThrow(/Failed query|params:/);
      expect((await database.rows(JOURNAL)).map((row) => row.hash)).toEqual([tree[0].hash]);
      expect(await database.rows(MATCH_MODE)).toHaveLength(0);
    } finally {
      await database.cleanup();
      await fs.rm(folder, { recursive: true, force: true });
    }
  });
});
