import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ERROR_DETAIL_MAX } from '../src/db';

/**
 * The one invariant that spans both packages. The importer composes a refusal to
 * ERROR_DETAIL_MAX and orders its clauses on the premise that all of it is read,
 * so a smaller cut in the client does not shorten the message - it deletes the
 * clause the composer put last, and ends the sentence mid-token.
 *
 * Both numbers have moved once already, independently. Reading the client source
 * from here is the only place they meet: the packages share no build.
 */
describe('the diagnostic budget survives to the screen', () => {
  const apiSource = fs.readFileSync(
    path.resolve(process.cwd(), '../web/src/api.ts'),
    'utf8',
  );

  it('the client shows at least what the backend composes', () => {
    const match = apiSource.match(/MAX_ERROR_CHARS\s*=\s*(\d+)/);
    expect(match, 'MAX_ERROR_CHARS not found in web/src/api.ts - was it renamed?').toBeTruthy();
    expect(Number(match![1])).toBeGreaterThanOrEqual(ERROR_DETAIL_MAX);
  });
});
