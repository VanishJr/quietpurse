import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const SRC = dirname(fileURLToPath(import.meta.url));
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name);
  return entry.isDirectory() ? walk(path) : [path];
});
const files = walk(SRC).filter((path) => /\.(css|tsx?)$/.test(path) && !/\.test\.tsx?$/.test(path) && !relative(SRC, path).startsWith('test/'));
const retired = [
  'btn', 'btn-ghost', 'btn-danger', 'btn-destroy', 'btn-sm', 'btn-link', 'btn-primary', 'btn-small', 'btn-row',
  'title', 'error', 'pill', 'input', 'legend', 'legend-row', 'legend-name', 'legend-pct', 'legend-value', 'total-row',
  'switch-label', 'switch-hint', 'header-btns', 'edit-hint', 'average', 'error-row', 'sheet-actions', 'setting-label', 'stack',
];

it('does not reintroduce retired selectors or class names into product presentation', () => {
  const found: string[] = [];
  for (const path of files) {
    const text = readFileSync(path, 'utf8');
    const file = relative(SRC, path);
    if (path.endsWith('.css')) {
      const css = text.replace(/\/\*[\s\S]*?\*\//g, '');
      for (const name of retired) {
        if (new RegExp(`\\.${name}(?![\\w-])`).test(css)) found.push(`${file}: .${name}`);
      }
    } else {
      const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
      const visitClass = (node: ts.Node): void => {
        if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
          for (const name of node.text.split(/\s+/)) {
            if (retired.includes(name)) found.push(`${file}: ${name}`);
          }
        }
        ts.forEachChild(node, visitClass);
      };
      const visit = (node: ts.Node): void => {
        if (ts.isJsxAttribute(node) && node.name.getText(source) === 'className' && node.initializer) visitClass(node.initializer);
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  expect(found).toEqual([]);
});
