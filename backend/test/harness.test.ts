import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { dbInstance } from '../src/db';
import { assertTestDatabase, schemaTables } from './pglite';

/**
 * The suite's first act against any database it is pointed at is TRUNCATE. The
 * development database differs from the test one by five characters, so the guard
 * that separates them is worth a test of its own.
 */
describe('assertTestDatabase', () => {
  it('accepts a database named for the purpose', () => {
    expect(() => assertTestDatabase('postgres://finto:finto@localhost:5432/finto_test')).not.toThrow();
    expect(() => assertTestDatabase('postgres://u:p@host/test')).not.toThrow();
  });

  it('refuses the development database, and says what to do', () => {
    expect(() => assertTestDatabase('postgres://finto:finto@localhost:5432/finto')).toThrow(
      /finto_test/,
    );
  });

  it('is not fooled by a name that merely ends in those letters', () => {
    expect(() => assertTestDatabase('postgres://u:p@host/protest')).toThrow();
  });
});

/**
 * The truncate is what isolates one file from the next, so a table it leaves out carries
 * rows across files with nothing to say so.
 */
describe('the truncate list', () => {
  it('is every table the migrated database has, and nothing else', async () => {
    const res = (await dbInstance().execute(
      sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    )) as unknown as { rows: { tablename: string }[] };

    expect((await schemaTables()).sort()).toEqual(res.rows.map((r) => r.tablename).sort());
  });
});
