import { dirname, isAbsolute, relative, resolve } from 'node:path';
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
import type { KIND_DEFS as INCOME_SOURCE_KIND_DEFS } from './components/IncomeSourcesBlock';
import type {
  GOAL_BASIS_DEFS,
  GOAL_INCOME_SCOPE_DEFS,
  GOAL_STATUS_LABELS,
  GOAL_TYPE_DEFS,
} from './goals';
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
  GOAL_BASES,
  GOAL_INCOME_SCOPES,
  GOAL_PERIODS,
  GOAL_PROGRESS_SEMANTICS,
  GOAL_STATUSES,
  GOAL_TYPES,
  GOAL_UNITS,
  GoalBasis,
  GoalIncomeScope,
  GoalPeriodKind,
  GoalProgressSemantic,
  GoalStatus,
  GoalType,
  GoalUnit,
  IncomeSourceKind,
} from './types';

/**
 * Rules about `types.ts` that no type holds, and the premise the pins in
 * `analytics.ts` and `api.ts` stand on.
 *
 * The wire is reached by type only: a value import of `backend/src/wire` compiles, is
 * erased by nothing, and bundles zod and the wire module into the built client with
 * both suites green. And it is reached through one door: `types.ts` is the only file
 * that names the backend path, so a rename on the server is one edit here and a `tsc`
 * error everywhere else. Both are read off the program the compiler builds from
 * `web/tsconfig.json`: every file it compiles outside `node_modules` and `backend/`,
 * not a directory. The walk covers every import form the compiler resolves (the list
 * `backend/test/wire.test.ts` walks), and each specifier is resolved the way the
 * compiler resolves it, so what is tested is the file it lands on and not what the
 * text looks like.
 *
 * The pins are `satisfies typeof` the wire's exports and a record keyed by each of its
 * unions, and both assume the export carries a literal type: a wire constant widened
 * to `number`, or a tuple that lost its `as const`, makes every pin silent. The last
 * block holds that premise. `tsc` is what reds it, and at run time it is a no-op.
 *
 * WEB resolves from import.meta.url for the reason copy.test.ts states: the root of
 * this walk IS the package this file sits in.
 *
 * The third block walks the same program narrowed to product files (no tests, harness
 * or config) for what reaches browser storage. It holds the ruling `web/src/SPEC.md`
 * states: the theme is the one deliberate exception, one legacy read is on its way
 * out, and every operation each file may use is named.
 */
const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND = resolve(WEB, '..', 'backend');
const WIRE = resolve(BACKEND, 'src', 'wire');
const CONFIG = resolve(WEB, 'tsconfig.json');
const DOOR = 'src/types.ts';

const under = (dir: string, file: string | undefined): boolean => {
  if (file === undefined) return false;
  const rel = relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

const parsed = ts.getParsedCommandLineOfConfigFile(CONFIG, undefined, {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic: (d) => {
    throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  },
});
if (parsed === undefined) throw new Error(`${CONFIG} did not parse`);
const OPTIONS = parsed.options;

const program = ts.createProgram({ rootNames: parsed.fileNames, options: OPTIONS });
const SOURCES = program
  .getSourceFiles()
  .filter((f) => !f.fileName.split('/').includes('node_modules') && !under(BACKEND, f.fileName));
const FILES = SOURCES.map((f) => relative(WEB, f.fileName));

type Specifier = { form: string; specifier: string; typeOnly: boolean };
type Crossing = Specifier & { resolved: string | undefined };

const literal = (node: ts.Node | undefined): string =>
  node && ts.isStringLiteral(node) ? node.text : '(dynamic)';

/**
 * Every way a module can name another, with whether the statement is `import type` /
 * `export type`: an import, a re-export, `import x = require()`, a require or import()
 * call anywhere in the tree, a `typeof import('x')` in a type position, and a
 * triple-slash directive. An inline `import { type X }` is not the statement form and
 * reads as a value import here, which is the rule types.ts is held to.
 */
const specifiersOf = (source: ts.SourceFile): Specifier[] => {
  const reference = (form: string, refs: readonly ts.FileReference[]): Specifier[] =>
    refs.map((r) => ({ form, specifier: r.fileName, typeOnly: false }));
  const found: Specifier[] = [
    ...reference('reference path', source.referencedFiles),
    ...reference('reference types', source.typeReferenceDirectives),
    ...reference('reference lib', source.libReferenceDirectives),
  ];
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
 * The file the compiler lands a specifier on, under the client's own options: a
 * `paths` or `baseUrl` mapping, a `rootDirs` overlay and a relay outside `src/` are
 * all seen here as the file they reach. A lib directive names a lib and never a file.
 */
const resolved = (file: string, s: Specifier): string | undefined => {
  switch (s.form) {
    case 'reference path':
      return ts.resolveTripleslashReference(s.specifier, file);
    case 'reference types':
      return ts.resolveTypeReferenceDirective(s.specifier, file, OPTIONS, ts.sys)
        .resolvedTypeReferenceDirective?.resolvedFileName;
    case 'reference lib':
      return undefined;
    default:
      return ts.resolveModuleName(s.specifier, file, OPTIONS, ts.sys).resolvedModule
        ?.resolvedFileName;
  }
};

/**
 * A specifier that lands under backend/, and one the walk could not read as a string:
 * it cannot be shown not to land there, so it is refused.
 */
const crossingsOf = (source: ts.SourceFile): Crossing[] =>
  specifiersOf(source)
    .map((s) => ({ ...s, resolved: resolved(source.fileName, s) }))
    .filter((c) => c.specifier === '(dynamic)' || under(BACKEND, c.resolved));

const describeCrossing = (file: string, c: Crossing): string =>
  `${file}: ${c.form} '${c.specifier}'` +
  (c.resolved === undefined ? '' : ` -> backend/${relative(BACKEND, c.resolved)}`);

describe('the wire is reached by type only and through one door', () => {
  const crossings = SOURCES.map((source) => ({
    file: relative(WEB, source.fileName),
    found: crossingsOf(source),
  }));

  it('reads the client program, and the door names the wire and nothing else under backend/', () => {
    expect(FILES).toContain('src/api.ts');
    // the program's files and not src/
    expect(FILES).toContain('vite.config.ts');
    expect(FILES).toContain('vitest.config.ts');
    expect(FILES).toContain(DOOR);
    const door = crossings.find((c) => c.file === DOOR);
    expect(door?.found.length, 'a door that names no wire is a check over nothing').toBeGreaterThan(
      0,
    );
    const outsideWire = (door?.found ?? [])
      .filter((c) => !under(WIRE, c.resolved))
      .map((c) => describeCrossing(DOOR, c));
    expect(outsideWire).toEqual([]);
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
    crossingsOf(
      ts.createSourceFile(resolve(WEB, 'src', 'crafted.ts'), text, ts.ScriptTarget.Latest, true),
    ).map((c) => [c.form, c.specifier, c.typeOnly]);
  const TO_WIRE = '../../backend/src/wire';

  it('sees every form a crossing can take, the ones a top-level scan misses included', () => {
    expect(crafted(`import type { Account } from '${TO_WIRE}';`)).toEqual([
      ['import', TO_WIRE, true],
    ]);
    expect(crafted(`export type { Account } from '${TO_WIRE}';`)).toEqual([
      ['export', TO_WIRE, true],
    ]);
    expect(crafted(`import { type Account } from '${TO_WIRE}';`)).toEqual([
      ['import', TO_WIRE, false],
    ]);
    expect(crafted(`import { CHARTS_MAX } from '${TO_WIRE}';`)).toEqual([
      ['import', TO_WIRE, false],
    ]);
    expect(crafted(`import '${TO_WIRE}';`)).toEqual([['import', TO_WIRE, false]]);
    expect(crafted(`export * from '${TO_WIRE}';`)).toEqual([['export', TO_WIRE, false]]);
    expect(crafted(`import wire = require('${TO_WIRE}');`)).toEqual([
      ['import =', TO_WIRE, false],
    ]);
    expect(crafted(`const HOLE = { x: require('${TO_WIRE}') };`)).toEqual([
      ['require()', TO_WIRE, false],
    ]);
    expect(crafted(`const later = () => import('${TO_WIRE}');`)).toEqual([
      ['import()', TO_WIRE, false],
    ]);
    expect(crafted(`type T = typeof import('${TO_WIRE}');`)).toEqual([
      ['import() type', TO_WIRE, false],
    ]);
    expect(crafted(`type U = import('${TO_WIRE}').Account;`)).toEqual([
      ['import() type', TO_WIRE, false],
    ]);
    expect(crafted(`/// <reference path="${TO_WIRE}/index.ts" />\nexport {};`)).toEqual([
      ['reference path', `${TO_WIRE}/index.ts`, false],
    ]);
    expect(crafted('const dyn = require(name);')).toEqual([['require()', '(dynamic)', false]]);
    expect(crafted("import { Account } from './types';")).toEqual([]);
    expect(crafted("import { z } from 'zod';")).toEqual([]);
  });

  /**
   * A belt beside the resolution above, which would see a crossing through either
   * option anyway: `paths` or `baseUrl` would let a bare name reach backend/, so the
   * door's own text would stop saying where it goes, and the row refuses a `paths`
   * mapping to a second copy of zod outright. Read through the compiler, never
   * JSON.parse: a comment added to the file must not red this for the wrong reason,
   * and `extends` is followed.
   */
  it('the client resolves a bare name from web/node_modules alone: no paths, no baseUrl', () => {
    expect(parsed.errors).toEqual([]);
    expect(OPTIONS.paths).toBeUndefined();
    expect(OPTIONS.baseUrl).toBeUndefined();
  });
});

/**
 * The package's own statement of product source, written out rather than read off the
 * coverage block in vitest.config.ts: that block is a reading and not a gate by its own
 * comment, and a gate that imported it would couple two unrelated rules.
 */
const PRODUCT = SOURCES.filter(
  (f) =>
    under(resolve(WEB, 'src'), f.fileName) &&
    !/\.test\.tsx?$/.test(f.fileName) &&
    !under(resolve(WEB, 'src', 'test'), f.fileName),
);

/** Closed, and the spec says what it cannot see. */
const STORAGE = ['localStorage', 'sessionStorage', 'indexedDB'];

/**
 * Each hit as the operation it feeds, such as `localStorage.getItem`, or the bare name
 * when it feeds none, which nothing in the allowlist is. `window.localStorage.getItem`
 * and the bare form both land on the identifier, so the walk reads through one
 * enclosing access to reach the operation.
 */
const storageUsesOf = (source: ts.SourceFile): string[] => {
  const found = new Set<string>();
  // the program's files carry no parent pointers (the binder sets those), so the walk hands them down
  const operationOf = (id: ts.Identifier, parent: ts.Node, grand: ts.Node | undefined): string => {
    if (ts.isPropertyAccessExpression(parent) && parent.expression === id) {
      return `${id.text}.${parent.name.text}`;
    }
    if (ts.isPropertyAccessExpression(parent) && parent.name === id && grand !== undefined) {
      if (ts.isPropertyAccessExpression(grand) && grand.expression === parent) {
        return `${id.text}.${grand.name.text}`;
      }
    }
    return id.text;
  };
  const visit = (node: ts.Node, parent: ts.Node, grand: ts.Node | undefined): void => {
    if (ts.isIdentifier(node) && STORAGE.includes(node.text)) {
      found.add(operationOf(node, parent, grand));
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'cookie') {
      found.add(node.getText(source));
    }
    ts.forEachChild(node, (child) => visit(child, node, parent));
  };
  visit(source, source, undefined);
  return [...found].sort();
};

const storageByFile = (files: readonly ts.SourceFile[]): Record<string, string[]> =>
  Object.fromEntries(
    files
      .map((f) => [relative(WEB, f.fileName), storageUsesOf(f)] as const)
      .filter(([, uses]) => uses.length > 0)
      .sort(([a], [b]) => a.localeCompare(b)),
  );

/** The ruling itself. */
const BROWSER: Record<string, string[]> = {
  'src/analytics.ts': ['localStorage.getItem', 'localStorage.removeItem'],
  'src/theme.tsx': ['localStorage.getItem', 'localStorage.setItem'],
};

describe('what reaches browser storage in product source', () => {
  it('reads the product files and not the tests, the harness or the config', () => {
    const files = PRODUCT.map((f) => relative(WEB, f.fileName));
    for (const anchor of ['src/main.tsx', 'src/theme.tsx', 'src/analytics.ts']) {
      expect(files).toContain(anchor);
    }
    for (const outside of ['src/types.test.ts', 'src/test/setup.ts', 'vitest.config.ts']) {
      expect(files).not.toContain(outside);
    }
  });

  it('theme.tsx alone stores anything in the browser; one migration reads and removes', () => {
    expect(storageByFile(PRODUCT)).toEqual(BROWSER);
  });

  const crafted = (text: string): string[] =>
    storageUsesOf(
      ts.createSourceFile(resolve(WEB, 'src', 'crafted.ts'), text, ts.ScriptTarget.Latest, true),
    );

  it('sees each way a file can reach storage, and names the two it cannot', () => {
    expect(crafted("window.localStorage.setItem('k', 'v');")).toEqual(['localStorage.setItem']);
    expect(crafted('const s = localStorage;')).toEqual(['localStorage']);
    expect(crafted("document.cookie = 'a=b';")).toEqual(['document.cookie']);
    expect(crafted("indexedDB.open('db');")).toEqual(['indexedDB.open']);
    expect(crafted('globalThis.sessionStorage.clear();')).toEqual(['sessionStorage.clear']);
    expect(crafted("localStorage.getItem('a'); localStorage.getItem('b');")).toEqual([
      'localStorage.getItem',
    ]);
    // the limit, asserted as a limit: a string-keyed access carries no identifier to see
    expect(crafted("window['localStorage'].setItem('k', 'v');")).toEqual([]);
    expect(crafted("const persist = usePersistedStore('k');")).toEqual([]);
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
    expectTypeOf<GoalType>().toEqualTypeOf<(typeof GOAL_TYPES)[number]>();
    expectTypeOf<GoalBasis>().toEqualTypeOf<(typeof GOAL_BASES)[number]>();
    expectTypeOf<GoalIncomeScope>().toEqualTypeOf<(typeof GOAL_INCOME_SCOPES)[number]>();
    expectTypeOf<GoalProgressSemantic>().toEqualTypeOf<
      (typeof GOAL_PROGRESS_SEMANTICS)[number]
    >();
    expectTypeOf<GoalUnit>().toEqualTypeOf<(typeof GOAL_UNITS)[number]>();
    expectTypeOf<GoalStatus>().toEqualTypeOf<(typeof GOAL_STATUSES)[number]>();
    expectTypeOf<GoalPeriodKind>().toEqualTypeOf<(typeof GOAL_PERIODS)[number]>();
  });

  it('each vocabulary record is keyed by exactly the wire union it is typed over', () => {
    expectTypeOf<ChartKind>().toEqualTypeOf<keyof typeof KIND_DEFS>();
    expectTypeOf<ChartMetric>().toEqualTypeOf<keyof typeof METRIC_DEFS>();
    expectTypeOf<ChartBreakdown>().toEqualTypeOf<keyof typeof BREAKDOWN_DEFS>();
    expectTypeOf<ChartRange>().toEqualTypeOf<keyof typeof RANGE_DEFS>();
    expectTypeOf<GoalType>().toEqualTypeOf<keyof typeof GOAL_TYPE_DEFS>();
    expectTypeOf<GoalBasis>().toEqualTypeOf<keyof typeof GOAL_BASIS_DEFS>();
    expectTypeOf<GoalIncomeScope>().toEqualTypeOf<keyof typeof GOAL_INCOME_SCOPE_DEFS>();
    expectTypeOf<GoalStatus>().toEqualTypeOf<keyof typeof GOAL_STATUS_LABELS>();
    expectTypeOf<IncomeSourceKind>().toEqualTypeOf<keyof typeof INCOME_SOURCE_KIND_DEFS>();
  });
});
