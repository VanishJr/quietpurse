/** Shared types and helpers for migrations. A separate file so that migrations
 * do not import index.ts (a circular import with the registry). */
import type Database from 'better-sqlite3';

export interface Migration {
  id: number;
  name: string;
  up: (db: Database.Database) => void;
}

/** Adds a column if it is not there yet. */
export function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  decl: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

/** Drops a column if it exists (SQLite 3.35+). */
export function dropColumnIfExists(db: Database.Database, table: string, column: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  }
}
