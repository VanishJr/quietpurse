/**
 * The one thing the suite can hold about ROADMAP row 28: that the parser still parses
 * where `@napi-rs/canvas` is not installed. pdfjs-dist lists it as optional, so npm
 * skips it on any machine no prebuilt binary matches - which this one may or may not
 * be, so the child below makes the package unresolvable rather than asking.
 *
 * It has to be a child process. vitest runs one process with one module cache
 * (vitest.config.ts: `isolate: false`), so a hook installed in a test file would only
 * take effect if that file happened to be collected before pdf.test.ts - which is the
 * file-ordering version of the import-ordering defect this row exists to remove.
 *
 * Two assertions, and the second is the one nothing else in the tree can make: the
 * parse is unchanged, and pdfjs printed the ONE warning it prints when the package is
 * missing and the globals are already in place. A second line - `Cannot polyfill
 * DOMMatrix` - would mean the stubs landed after pdf.mjs evaluated, which type-checks,
 * passes every other test, and ships a build that cannot read a PDF on exactly those
 * machines.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseWithoutCanvas } from './canvasabsent';

const count = (text: string, needle: string): number =>
  text.split('\n').filter((l) => l.includes(needle)).length;

describe('the PDF parser where @napi-rs/canvas cannot be resolved', () => {
  it('parses what it parses here, and pdfjs warns exactly once', async () => {
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'test/canvasabsent.child.ts'], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
    });
    expect(child.status, child.stderr).toBe(0);

    const here = await parseWithoutCanvas();
    // the fixture is worth comparing against only if it parsed something
    expect(here.rows).toHaveLength(3);
    expect(here.balances).toEqual({
      openingCents: 100000,
      closingCents: 108766,
      currency: 'EUR',
      // the Total line prints two cells, so the template declares no gross pair
      gross: { kind: 'not-printed' },
    });
    expect(here.scan).toMatch(/scan/);
    expect(here.encrypted).toMatch(/password-protected/);
    expect(here.unrecognised).toMatch(/not one this importer recognises/);
    expect(here.path2dThrows).toBe(true);
    expect(here.domMatrixWithInitThrows).toBe(true);

    expect(child.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(child.stdout)).toEqual(JSON.parse(JSON.stringify(here)));

    expect(count(child.stderr, 'Cannot load "@napi-rs/canvas"')).toBe(1);
    expect(count(child.stderr, 'Cannot polyfill')).toBe(0);
  }, 60_000);
});
