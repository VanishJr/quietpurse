/**
 * Versioned schema migrations. The applied migration number is kept in
 * meta.schema_version; at startup every migration with a higher number runs,
 * each in its own transaction.
 *
 * Rules for new migrations:
 *  - forward only, sequential numbers, file migrations/NNN-name.ts;
 *  - a migration is synchronous (better-sqlite3) and does not import db.ts -
 *    the connection comes in as a parameter (see helpers.ts);
 *  - never edit an applied migration - only add a new one.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './helpers';
import { migration001 } from './001-initial';
import { migration002 } from './002-money-cents';

export type { Migration } from './helpers';

const MIGRATIONS: Migration[] = [migration001, migration002];

const VERSION_KEY = 'schema_version';

export function schemaVersion(db: Database.Database): number {
  // meta is created right here: the runner must be able to read the version before 001
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(VERSION_KEY) as
    | { value: string }
    | undefined;
  return row ? parseInt(row.value, 10) : 0;
}

export function runMigrations(
  db: Database.Database,
  log: (s: string) => void = () => {},
): void {
  const sorted = [...MIGRATIONS].sort((a, b) => a.id - b.id);
  let version = schemaVersion(db);
  for (const m of sorted) {
    if (m.id <= version) continue;
    db.transaction(() => {
      m.up(db);
      db.prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run(VERSION_KEY, String(m.id));
    })();
    version = m.id;
    log(`migration ${String(m.id).padStart(3, '0')}-${m.name} applied`);
  }
}
