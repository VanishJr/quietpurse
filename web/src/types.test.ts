import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  BREAKDOWN_DEFS,
  CHART_ACCOUNT_ID_MAX,
  CHART_ID_MAX,
  CHART_ID_SHAPE_SOURCE,
  CHART_TITLE_MAX,
  CHARTS_MAX,
  KIND_DEFS,
  METRIC_DEFS,
  RANGE_DEFS,
} from './analytics';
import type { MAX_ERROR_CHARS } from './api';
import type { GOAL_MODE_DEFS } from './screens/IndependenceScreen';
import type {
  CHART_ACCOUNT_ID_MAX as WIRE_CHART_ACCOUNT_ID_MAX,
  CHART_ID_MAX as WIRE_CHART_ID_MAX,
  CHART_ID_SHAPE_SOURCE as WIRE_CHART_ID_SHAPE_SOURCE,
  CHART_TITLE_MAX as WIRE_CHART_TITLE_MAX,
  CHARTS_MAX as WIRE_CHARTS_MAX,
  ChartBreakdown,
  ChartKind,
  ChartMetric,
  ChartRange,
  ERROR_DETAIL_MAX,
  GoalMode,
} from './types';

/**
 * Two rules about `types.ts` that no type holds, and the premise the pins in
 * `analytics.ts` and `api.ts` stand on.
 *
 * The wire is reached by type only: a value import of `backend/src/wire` compiles, is
 * erased by nothing, and bundles zod and the wire module into the built client with
 * both suites green. And it is reached through one door: `types.ts` is the only file
 * that names the backend path, so a rename on the server is one edit here and a `tsc`
 * error everywhere else. Both are read off the source with the compiler API, over
 * every form a specifier can take - the list `backend/test/wire.test.ts` walks.
 *
 * The pins are `satisfies typeof` the wire's exports and a record keyed by each of its
 * unions, and both assume the export carries a literal type: a wire constant widened
 * to `number`, or a tuple that lost its `as const`, makes every pin silent. The last
 * block holds that premise, and `tsc` is what reds it - at run time it is a no-op.
 *
 * SRC resolves from import.meta.url for the reason copy.test.ts states: the root of
 * this walk IS the directory this file sits in.
 */
const SRC = dirname(fileURLToPath(import.meta.url));
const BACKEND = resolve(SRC, '..', '..', 'backend');
const DOOR = 'types.ts';

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });

const FILES = walk(SRC)
  .filter((full) => /\.tsx?$/.test(full))
  .map((full) => relative(SRC, full).split(sep).join('/'));

type Crossing = { form: string; specifier: string; typeOnly: boolean };

const literal = (node: ts.Node | undefined): string =>
  node && ts.isStringLiteral(node) ? node.text : '(dynamic)';

/**
 * Every way a module can name another, with whether the statement is `import type` /
 * `export type`: an import, a re-export, `import x = require()`, a require or import()
 * call anywhere in the tree, a `typeof import('x')` in a type position, and a
 * triple-slash directive. An inline `import { type X }` is not the statement form and
 * reads as a value import here, which is the rule types.ts is held to.
 */
const specifiersOf = (source: ts.SourceFile): Crossing[] => {
  const found: Crossing[] = [
    ...source.referencedFiles,
    ...source.typeReferenceDirectives,
    ...source.libReferenceDirectives,
  ].map((r) => ({ form: 'reference', specifier: r.fileName, typeOnly: false }));
  const collect = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      found.push({
        form: 'import',
        specifier: literal(node.moduleSpecifier),
        typeOnly: node.importClause?.isTypeOnly ?? false,
      });
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      found.push({
        form: 'export',
        specifier: literal(node.moduleSpecifier),
        typeOnly: node.isTypeOnly,
      });
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      found.push({
        form: 'import =',
        specifier: literal(node.moduleReference.expression),
        typeOnly: node.isTypeOnly,
      });
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        found.push({ form: 'import()', specifier: literal(node.arguments[0]), typeOnly: false });
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        found.push({ form: 'require()', specifier: literal(node.arguments[0]), typeOnly: false });
      }
    }
    if (ts.isImportTypeNode(node)) {
      const arg = node.argument;
      found.push({
        form: 'import() type',
        specifier: ts.isLiteralTypeNode(arg) ? literal(arg.literal) : '(dynamic)',
        typeOnly: false,
      });
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  return found;
};

/**
 * A relative or absolute specifier that lands under backend/, and one the walk could
 * not read as a string: it cannot be shown not to land there, so it is refused.
 */
const intoBackend = (file: string, specifier: string): boolean =>
  specifier === '(dynamic)' ||
  (!/^[^./]/.test(specifier) &&
    !relative(BACKEND, resolve(dirname(file), specifier)).startsWith('..'));

const crossingsOf = (file: string, text: string): Crossing[] =>
  specifiersOf(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)).filter((c) =>
    intoBackend(file, c.specifier),
  );

const describeCrossing = (file: string, c: Crossing): string =>
  `${file}: ${c.form} '${c.specifier}'`;

describe('the wire is reached by type only and through one door', () => {
  const crossings = FILES.map((file) => ({
    file,
    found: crossingsOf(resolve(SRC, file), readFileSync(resolve(SRC, file), 'utf8')),
  }));

  it('reads the client source tree, and the door names the wire', () => {
    expect(FILES).toContain('api.ts');
    expect(FILES).toContain(DOOR);
    const door = crossings.find((c) => c.file === DOOR);
    expect(door?.found.length, 'a door that names no wire is a check over nothing').toBeGreaterThan(
      0,
    );
  });

  it('every crossing into backend/ is the statement form import type or export type', () => {
    const values = crossings.flatMap(({ file, found }) =>
      found.filter((c) => !c.typeOnly).map((c) => describeCrossing(file, c)),
    );
    expect(values).toEqual([]);
  });

  it('only types.ts names the backend path', () => {
    const doors = crossings.filter((c) => c.found.length > 0).map((c) => c.file);
    expect(doors).toEqual([DOOR]);
  });

  const crafted = (text: string): [string, string, boolean][] =>
    crossingsOf(resolve(SRC, 'crafted.ts'), text).map((c) => [c.form, c.specifier, c.typeOnly]);
  const WIRE = '../../backend/src/wire';

  it('sees every form a crossing can take, the ones a top-level scan misses included', () => {
    expect(crafted(`import type { Account } from '${WIRE}';`)).toEqual([['import', WIRE, true]]);
    expect(crafted(`export type { Account } from '${WIRE}';`)).toEqual([['export', WIRE, true]]);
    expect(crafted(`import { type Account } from '${WIRE}';`)).toEqual([['import', WIRE, false]]);
    expect(crafted(`import { CHARTS_MAX } from '${WIRE}';`)).toEqual([['import', WIRE, false]]);
    expect(crafted(`import '${WIRE}';`)).toEqual([['import', WIRE, false]]);
    expect(crafted(`export * from '${WIRE}';`)).toEqual([['export', WIRE, false]]);
    expect(crafted(`import wire = require('${WIRE}');`)).toEqual([['import =', WIRE, false]]);
    expect(crafted(`const HOLE = { x: require('${WIRE}') };`)).toEqual([
      ['require()', WIRE, false],
    ]);
    expect(crafted(`const later = () => import('${WIRE}');`)).toEqual([['import()', WIRE, false]]);
    expect(crafted(`type T = typeof import('${WIRE}');`)).toEqual([['import() type', WIRE, false]]);
    expect(crafted(`type U = import('${WIRE}').Account;`)).toEqual([
      ['import() type', WIRE, false],
    ]);
    expect(crafted(`/// <reference path="${WIRE}/index.ts" />\nexport {};`)).toEqual([
      ['reference', `${WIRE}/index.ts`, false],
    ]);
    expect(crafted('const dyn = require(name);')).toEqual([['require()', '(dynamic)', false]]);
    expect(crafted("import { Account } from './types';")).toEqual([]);
    expect(crafted("import { z } from 'zod';")).toEqual([]);
  });

  /**
   * A bare name is trusted above because the client resolves it from web/node_modules
   * alone; `paths` or `baseUrl` in the client's tsconfig would let one reach backend/
   * and make the one-file rule blind. Read through the compiler, never JSON.parse: a
   * comment added to the file must not red this for the wrong reason, and `extends`
   * is followed.
   */
  it('the client resolves a bare name from web/node_modules alone: no paths, no baseUrl', () => {
    const file = resolve(SRC, '..', 'tsconfig.json');
    const read = ts.readConfigFile(file, ts.sys.readFile);
    expect(read.error).toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(file));
    expect(parsed.errors).toEqual([]);
    expect(parsed.options.paths).toBeUndefined();
    expect(parsed.options.baseUrl).toBeUndefined();
  });
});

describe('the pins stand on literal types, and tsc is what holds this block', () => {
  it('each client constant is exactly the literal type of the wire export it is pinned to', () => {
    expectTypeOf<typeof WIRE_CHARTS_MAX>().toEqualTypeOf<typeof CHARTS_MAX>();
    expectTypeOf<typeof WIRE_CHART_TITLE_MAX>().toEqualTypeOf<typeof CHART_TITLE_MAX>();
    expectTypeOf<typeof WIRE_CHART_ID_MAX>().toEqualTypeOf<typeof CHART_ID_MAX>();
    expectTypeOf<typeof WIRE_CHART_ACCOUNT_ID_MAX>().toEqualTypeOf<typeof CHART_ACCOUNT_ID_MAX>();
    expectTypeOf<typeof WIRE_CHART_ID_SHAPE_SOURCE>().toEqualTypeOf<typeof CHART_ID_SHAPE_SOURCE>();
    expectTypeOf<typeof ERROR_DETAIL_MAX>().toEqualTypeOf<typeof MAX_ERROR_CHARS>();
  });

  it('each vocabulary record is keyed by exactly the wire union it is typed over', () => {
    expectTypeOf<ChartKind>().toEqualTypeOf<keyof typeof KIND_DEFS>();
    expectTypeOf<ChartMetric>().toEqualTypeOf<keyof typeof METRIC_DEFS>();
    expectTypeOf<ChartBreakdown>().toEqualTypeOf<keyof typeof BREAKDOWN_DEFS>();
    expectTypeOf<ChartRange>().toEqualTypeOf<keyof typeof RANGE_DEFS>();
    expectTypeOf<GoalMode>().toEqualTypeOf<keyof typeof GOAL_MODE_DEFS>();
  });
});
