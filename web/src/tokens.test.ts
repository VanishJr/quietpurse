import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A token declared in styles/tokens.css and reached by nothing.
 *
 * That file is the one place two stylesheets were meant to agree, and the failure it
 * has is silent in both directions: CSS has no compiler, an unread custom property
 * costs nothing at run time, and a rule naming one that does not exist falls back to
 * the initial value rather than erroring. So a token outlives whatever deleted its
 * last caller, and the next person wanting that value writes a second declaration
 * beside it - which is the drift tokens.css was written to end. Deleting the public
 * page left a batch of them behind, and every suite stayed green.
 *
 * SRC resolves from import.meta.url, not process.cwd(), for the reason copy.test.ts
 * states: the root of this walk IS the directory this file sits in.
 *
 * What this does NOT hold, so nobody reads it as more than it is:
 *
 * - The other direction. A `var(--typo)` naming nothing is the worse defect and is
 *   not checked here, because the declarations live in three places with different
 *   shapes - this file, styles.css's own aliases, and the `--ink-*` set theme.tsx
 *   publishes from TypeScript at run time - and a check that modelled two of the
 *   three would report the third as a typo.
 * - A token read only by another token that is itself unread. A reference is a
 *   reference here; a self-contained island of two would pass.
 * - Anything outside this package. Nothing else loads this file.
 */
describe('every design token has a reader', () => {
  const SRC = dirname(fileURLToPath(import.meta.url));
  const TOKENS = 'styles/tokens.css';

  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });

  /**
   * The page shell sits beside src/ and can name a token in an inline style, so it is
   * read too - derived the same way copy.test.ts derives it, so a second page added to
   * the build is covered the day it appears.
   */
  const SHELLS = readdirSync(resolve(SRC, '..'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
    .map((entry) => `../${entry.name}`);

  const READABLE = /\.(css|ts|tsx|html)$/;

  const FILES = [
    ...walk(SRC)
      .map((full) => relative(SRC, full).split(sep).join('/'))
      .filter((file) => READABLE.test(file)),
    ...SHELLS,
  ];

  const source = readFileSync(resolve(SRC, TOKENS), 'utf8');

  /**
   * The declaration side is this file's own `--name:` lines. A `var(--name)` never
   * matches, so the declarations and the references cannot be confused for each other
   * and the file may be scanned for both.
   */
  const declared = [...source.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]);

  it('reads tokens.css and the whole client source tree', () => {
    // written out rather than compared against the lists themselves, which would be
    // the same values on both sides of the assertion and green however short they got
    expect(declared).toContain('--c-ground');
    expect(declared.length).toBeGreaterThan(10);
    expect(FILES).toContain(TOKENS);
    expect(FILES).toContain('styles.css');
    expect(FILES).toContain('../index.html');
  });

  it('declares no token that nothing reaches', () => {
    const readers = new Map<string, string[]>();
    for (const file of FILES) {
      const text = readFileSync(resolve(SRC, file), 'utf8');
      for (const token of declared) {
        // the closing paren is not matched: var() takes a fallback after a comma
        // `\b` would end the name at the hyphen that STARTS a longer one, so
        // var(--c-paper-hi) would answer for --c-paper. The close paren and the
        // comma are the only two things that may follow a name inside var().
        if (new RegExp(`var\\(\\s*${token}\\s*[),]`).test(text)) {
          readers.set(token, [...(readers.get(token) ?? []), file]);
        }
      }
    }

    const unread = declared.filter((token) => !readers.has(token));
    expect(
      unread,
      `declared in ${TOKENS} and named by no var() anywhere in this package: ` +
        `${unread.join(', ')} - delete it, or point at it from the rule that wrote its value out by hand`,
    ).toEqual([]);
  });
});
