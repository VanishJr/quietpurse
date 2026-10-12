import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The client cannot know which rate source converted a given amount. The resolver
 * asks its providers in order (backend/src/fxrates.ts) and nothing about which one
 * answered survives the write into fx_rates, so a screen naming one prints a guess
 * as a fact. The Analytics caption once did, for every user.
 *
 * Delete this file when the summary carries per-pair rate provenance and the client
 * renders what actually answered. Until then it is the only thing in this package
 * that makes the guess impossible to reintroduce: the caption's own assertions live
 * in AnalyticsScreen.test.tsx and would be rewritten with the screen.
 *
 * SRC resolves from import.meta.url and not from process.cwd(), diverging on purpose
 * from the cross-file checks in backend/test: those read a target that is not
 * beside them, so they need a package root, whereas here the root of the walk is the
 * directory this file sits in.
 */
describe('no client copy names a rate source', () => {
  const SRC = dirname(fileURLToPath(import.meta.url));
  const SELF = 'copy.test.ts';

  /**
   * The page shell sits beside src/ and carries copy of its own. Derived rather than
   * listed so that a second page added to vite.config.ts's build input is covered the
   * day it appears. Only the files beside src/, never a walk of the package: the build
   * output beside it is whatever was last built and can carry a caption the source no
   * longer does, so the guard would redden on a directory nobody edited.
   */
  const SHELLS = readdirSync(resolve(SRC, '..'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
    .map((entry) => `../${entry.name}`);

  const SOURCES = [
    /\bNBU\b/gi,
    /\bECB\b/gi,
    /frankfurter/gi,
    /\bnational\s+bank\b/gi,
    /\bcentral\s+bank\b/gi,
  ];

  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });

  const FILES = [
    ...walk(SRC).map((full) => relative(SRC, full).split(sep).join('/')),
    ...SHELLS,
  ].filter((file) => file !== SELF);

  it('reads the client source tree and the page shell', () => {
    expect(FILES.length).toBeGreaterThan(0);
    // written out rather than compared against SHELLS, which would be the same list
    // on both sides of the assertion and green however short it got
    expect(FILES).toContain('screens/AnalyticsScreen.tsx');
    expect(FILES).toContain('../index.html');
  });

  it('finds no rate source named anywhere in the client', () => {
    const hits: string[] = [];
    for (const file of FILES) {
      const text = readFileSync(resolve(SRC, file), 'utf8');
      for (const pattern of SOURCES) {
        for (const match of text.matchAll(pattern)) {
          const line = text.slice(0, match.index).split('\n').length;
          hits.push(`${file}:${line} ${match[0]}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
