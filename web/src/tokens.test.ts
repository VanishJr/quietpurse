import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { darkInk, lightInk } from './theme';
import { METRIC_DEFS } from './analytics';
import { TOOLTIP_CHIP } from './chartTooltip';

const SRC = dirname(fileURLToPath(import.meta.url));
const TOKENS = 'styles/tokens.css';
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
const SHELLS = readdirSync(resolve(SRC, '..'), { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
  .map((entry) => `../${entry.name}`);
const FILES = [
  ...walk(SRC)
    .map((full) => relative(SRC, full).split(sep).join('/'))
    .filter((file) => /\.(css|ts|tsx|html)$/.test(file) && !/\.test\.tsx?$/.test(file) && !file.startsWith('test/')),
  ...SHELLS,
];
const textOf = (file: string) => readFileSync(resolve(SRC, file), 'utf8');
const source = textOf(TOKENS);
const declarations = (text: string) => [...text.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]);
const references = (text: string) => [...text.matchAll(/var\(\s*(--[\w-]+)\s*[),]/g)].map((m) => m[1]);
const declared = [...new Set(declarations(source))];
const product = FILES.map((file) => ({ file, text: textOf(file) }));

describe('live design tokens', () => {
  it('reads every token family, product styles and page shells', () => {
    for (const token of [
      '--r-md', '--r-dialog', '--dur-1', '--z-raised', '--space-1', '--space-12',
      '--text-page', '--text-helper', '--text-financial-primary', '--control-touch',
      '--page-wide', '--page-normal', '--page-editing', '--page-gutter',
    ]) expect(declared).toContain(token);
    expect(FILES).toContain(TOKENS);
    expect(FILES).toContain('styles.css');
    expect(FILES).toContain('styles/import.css');
    expect(FILES).toContain('../index.html');
    expect(FILES).not.toContain('tokens.test.ts');
    expect(FILES).not.toContain('test/fixtures.ts');
  });

  it('declares no token that the product does not reach', () => {
    const readers = new Set(product.flatMap(({ text }) => references(text)));
    expect(declared.filter((token) => !readers.has(token))).toEqual([]);
  });

  it('connects aliases to a rule rather than only to other unread aliases', () => {
    const cssRules = product.filter(({ file }) => file.endsWith('.css'))
      .map(({ text }) => text.replace(/^\s*--[\w-]+\s*:[^;]+;/gm, '')).join('\n');
    const reachable = new Set(references(cssRules));
    for (const { file, text } of product) {
      if (!file.endsWith('.css')) for (const token of references(text)) reachable.add(token);
    }
    const aliases = [...source.matchAll(/^\s*(--[\w-]+)\s*:\s*([^;]+);/gm)];
    let changed = true;
    while (changed) {
      changed = false;
      for (const [, token, value] of aliases) {
        if (!reachable.has(token)) continue;
        for (const dependency of references(value)) {
          if (!reachable.has(dependency)) { reachable.add(dependency); changed = true; }
        }
      }
    }
    expect(declared.filter((token) => !reachable.has(token))).toEqual([]);
  });

  it('keeps every palette role connected to styling or a named chart reader', () => {
    const readers = new Set([
      ...product.filter(({ file }) => file.endsWith('.css')).flatMap(({ text }) =>
        references(text.replace(/\/\*[\s\S]*?\*\//g, '')).filter((token) => token.startsWith('--ink-')).map((token) => token.slice('--ink-'.length))),
      ...product.filter(({ file }) => !file.endsWith('.css') && file !== 'theme.tsx').flatMap(({ text }) =>
        [...text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '').matchAll(/\bink\.([\w]+)\b/g)].map((match) => match[1])),
      ...Object.values(METRIC_DEFS).map((metric) => metric.ink),
      ...Object.values(TOOLTIP_CHIP).flatMap((chip) => [chip.fill, chip.label, chip.item]),
    ]);
    expect(Object.keys(lightInk).filter((role) => !readers.has(role))).toEqual([]);
  });

  it('resolves every literal variable through styles or either published palette', () => {
    const known = new Set([
      ...product.filter(({ file }) => file.endsWith('.css')).flatMap(({ text }) => declarations(text)),
      ...Object.keys(lightInk).map((key) => `--ink-${key}`),
    ]);
    expect(Object.keys(darkInk).sort()).toEqual(Object.keys(lightInk).sort());
    const missing = product.flatMap(({ file, text }) =>
      references(text).filter((token) => !known.has(token)).map((token) => `${file}: ${token}`));
    expect(missing).toEqual([]);
  });

  it('stacks the modal backdrop above every raised layer', () => {
    const value = (token: string) => Number(source.match(new RegExp(`^\\s*${token}\\s*:\\s*(\\d+)`, 'm'))?.[1]);
    expect(value('--z-modal')).toBeGreaterThan(value('--z-raised'));
    const backdrop = textOf('styles.css').match(/^\.backdrop \{[^}]*\}/m)?.[0];
    expect(backdrop).toMatch(/z-index:\s*var\(--z-modal\)/);
  });
});
