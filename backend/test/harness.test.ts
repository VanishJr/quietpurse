import { describe, expect, it } from 'vitest';
import { assertTestDatabase } from './pglite';

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
