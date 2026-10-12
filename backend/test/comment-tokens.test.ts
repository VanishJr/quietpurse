import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { censusOf, commentsOf, compareSources, tokensOf } from '../scripts/comment-tokens';

/**
 * The control table. A comparator that has only ever agreed is worth nothing, and the
 * discriminating power is not spread evenly across these rows: a moved literal and a
 * renamed identifier are DIFFERENT under every wrong build ever tried here, and a
 * deleted comment line is IDENTICAL under most of them. What separates a build is the
 * misaimed control, the two JSX rows, and the pair below this describe.
 */
const TS_BASE = [
  '/**',
  ' * A docblock carrying a digit: row 65.',
  ' */',
  'export const LIMIT = 25;',
  '',
  '// a whole comment line',
  'export function widen(value: number): number {',
  '  return value * LIMIT; // and a trailing one',
  '}',
  '',
].join('\n');

const TSX_BASE = [
  "import { fmtMoney } from '../money';",
  '',
  '// a line comment above the component',
  'export function Hero({ total, unit }: { total: number; unit: string }) {',
  '  return (',
  '    <p className="hero">',
  '      {/* the figure and its unit are one sentence */}',
  '      {fmtMoney(total)} <span className="unit">{unit}</span>',
  '    </p>',
  '  );',
  '}',
  '',
].join('\n');

const swap = (text: string, from: string, to: string): string => {
  expect(text).toContain(from);
  return text.replace(from, to);
};

const dropLine = (text: string, needle: string): string => {
  const lines = text.split('\n');
  const at = lines.findIndex((line) => line.includes(needle));
  expect(at).toBeGreaterThanOrEqual(0);
  lines.splice(at, 1);
  return lines.join('\n');
};

describe('the control table the comparator is held by', () => {
  it('C1 calls a numeric literal changed in code DIFFERENT', () => {
    const verdict = compareSources('fixture.ts', TS_BASE, swap(TS_BASE, 'LIMIT = 25', 'LIMIT = 26'));
    expect(verdict.same).toBe(false);
  });

  it('C2 calls an identifier renamed DIFFERENT', () => {
    const verdict = compareSources('fixture.ts', TS_BASE, swap(TS_BASE, 'widen', 'broaden'));
    expect(verdict.same).toBe(false);
  });

  it('C3 calls a whole comment line deleted IDENTICAL', () => {
    const verdict = compareSources('fixture.ts', TS_BASE, dropLine(TS_BASE, 'a whole comment line'));
    expect(verdict).toEqual({ same: true, count: tokensOf('fixture.ts', TS_BASE).length });
  });

  /**
   * The misaimed control, and the only row that separates a build emitting JSDoc
   * blocks as tokens from a working one: that build answers DIFFERENT here with a
   * plausible token count, and answers every other row exactly as this one does.
   */
  it('C4 calls a digit changed INSIDE a docblock IDENTICAL', () => {
    const verdict = compareSources('fixture.ts', TS_BASE, swap(TS_BASE, 'row 65', 'row 66'));
    expect(verdict.same).toBe(true);
  });

  it('C4b calls a word changed inside a line comment in a .tsx IDENTICAL', () => {
    const work = swap(TSX_BASE, 'above the component', 'above the element');
    expect(compareSources('fixture.tsx', TSX_BASE, work).same).toBe(true);
  });

  it('C5 calls a bare JSX comment deleted from a .tsx IDENTICAL', () => {
    const work = dropLine(TSX_BASE, 'one sentence');
    expect(compareSources('fixture.tsx', TSX_BASE, work).same).toBe(true);
  });

  /**
   * The row that protects `web/`: the space between a money figure and its unit is a
   * rendered child, so a build normalising or dropping every whitespace-only JsxText
   * lets a sweep delete it green.
   */
  it('C6 calls a rendered space between two JSX children deleted DIFFERENT', () => {
    const work = swap(TSX_BASE, '{fmtMoney(total)} <span', '{fmtMoney(total)}<span');
    expect(compareSources('fixture.tsx', TSX_BASE, work).same).toBe(false);
  });

  it('C8 calls a blank line inserted in code IDENTICAL', () => {
    const work = swap(TS_BASE, 'export function widen', '\nexport function widen');
    expect(compareSources('fixture.ts', TS_BASE, work).same).toBe(true);
  });
});

/**
 * The rows that catch a wrong build in the silent direction. Every row above catches
 * one that shouts: a correct sweep called broken and then argued over. These catch a
 * comparator that is green over a deleted `await`, which is the only failure of this
 * instrument that can certify a sweep which changed behaviour.
 */
describe('the tokens a walk over child NODES never visits', () => {
  it('sees a keyword hanging off an expression node its parent visits: await removed', () => {
    const base = 'export async function f(g: () => Promise<number>) { return await g(); }';
    const work = 'export async function f(g: () => Promise<number>) { return g(); }';
    expect(compareSources('fixture.ts', base, work).same).toBe(false);
  });

  it('sees a flag on the declaration list that is no child node at all: const to let', () => {
    const base = 'export const MAX_UPLOAD_BYTES = 10;';
    const work = 'export let MAX_UPLOAD_BYTES = 10;';
    expect(compareSources('fixture.ts', base, work).same).toBe(false);
  });
});

/**
 * The cost of the drop rule, pinned rather than described: a sweep collapsing
 * `A {comment} B` into `A B` deletes one of two rendered space-only children, so the
 * DIFFERENT is correct and not a false alarm. A "fix" that makes the spaced form
 * agree reds here.
 */
describe('a bare JSX comment written inline between two children', () => {
  it('is DIFFERENT when it was spaced, because two rendered spaces become one', () => {
    const base = 'export const x = <p>{a} {/* c */} <b /></p>;';
    const work = 'export const x = <p>{a} <b /></p>;';
    expect(compareSources('fixture.tsx', base, work).same).toBe(false);
  });

  it('is IDENTICAL when it was unspaced, because nothing rendered was there', () => {
    const base = 'export const x = <p>{a}{/* c */}<b /></p>;';
    const work = 'export const x = <p>{a}<b /></p>;';
    expect(compareSources('fixture.tsx', base, work).same).toBe(true);
  });
});

describe('the census', () => {
  it('counts a comment sharing a line with the code before it', () => {
    expect(censusOf('fixture.ts', 'const a = 1; // why\n')).toEqual({
      commentLines: 1,
      nonBlank: 1,
      blocks: 1,
    });
  });

  it('counts a leading comment and the code line it sits above separately', () => {
    expect(censusOf('fixture.ts', '// why\nconst a = 1;\n')).toEqual({
      commentLines: 1,
      nonBlank: 2,
      blocks: 1,
    });
  });

  it('counts every line a block comment occupies', () => {
    expect(censusOf('fixture.ts', '/**\n * one\n * two\n */\nconst a = 1;\n')).toEqual({
      commentLines: 4,
      nonBlank: 5,
      blocks: 1,
    });
  });

  it('counts two comments on one line once as a line and twice as a block', () => {
    expect(censusOf('fixture.ts', '/* a */ const x = 1; // b\n')).toEqual({
      commentLines: 1,
      nonBlank: 1,
      blocks: 2,
    });
  });

  it('leaves a // inside a string and inside a template alone, which a scanner cannot', () => {
    const text = ['const a = "http://x";', 'const b = `y // z`;', ''].join('\n');
    expect(censusOf('fixture.ts', text)).toEqual({ commentLines: 0, nonBlank: 2, blocks: 0 });
  });

  it('counts no line of a file that is blank, and every line of one that is all comment', () => {
    expect(censusOf('fixture.ts', '\n\n\n')).toEqual({ commentLines: 0, nonBlank: 0, blocks: 0 });
    expect(censusOf('fixture.ts', '// only\n')).toEqual({
      commentLines: 1,
      nonBlank: 1,
      blocks: 1,
    });
  });
});

/**
 * The list the census folds over, and the one walk specs.test.ts reads comments through:
 * a holder built on a second walk would drift from this one in its control table first.
 */
describe('the comment list the census folds over', () => {
  const spans = (fileName: string, text: string): [number, number, string][] =>
    commentsOf(fileName, text).map((c) => [c.line, c.lineEnd, c.text]);

  it('commentsOf lists a docblock, a whole-line comment and a trailing one once each, with the lines they start and end on', () => {
    expect(spans('fixture.ts', TS_BASE)).toEqual([
      [1, 3, '/**\n * A docblock carrying a digit: row 65.\n */'],
      [6, 6, '// a whole comment line'],
      [8, 8, '// and a trailing one'],
    ]);
  });

  it('commentsOf reads a bare JSX comment inside braces', () => {
    expect(spans('fixture.tsx', TSX_BASE)).toEqual([
      [3, 3, '// a line comment above the component'],
      [7, 7, '/* the figure and its unit are one sentence */'],
    ]);
  });

  it('commentsOf reads nothing out of a string or a template that looks like one', () => {
    const text = ['const a = "http://x";', 'const b = `y // z`;', ''].join('\n');
    expect(commentsOf('fixture.ts', text)).toEqual([]);
  });

  it('commentsOf reads a comment after the last statement', () => {
    expect(spans('fixture.ts', 'const a = 1;\n// after everything\n')).toEqual([
      [2, 2, '// after everything'],
    ]);
  });

  /**
   * JSX text is rendered copy, and a scanner started inside it reads a `//` there as a
   * comment: once as the text's own leading range, once as the trailing range of the
   * brace before it. Either way it is what tokensOf calls a JsxText token. The third
   * shape puts the closing tag on a line of its own, so the range a scanner mints there
   * carries no `</`. A filter reading the text for one keeps it, and only a filter
   * reading the node's span drops it. The case after this one is the other half of
   * that pair.
   */
  it('commentsOf reads nothing out of JSX text that opens with //, on its own or after a brace', () => {
    const text = [
      'export const x = <p>// row 54 is text</p>;',
      'export const y = <p>{a}// row 54 is text too</p>;',
      'export const z = (',
      '  <p>',
      '    // row 54 is text',
      '  </p>',
      ');',
      '',
    ].join('\n');
    expect(commentsOf('fixture.tsx', text)).toEqual([]);
  });

  it('commentsOf keeps a real comment whose text carries a closing tag', () => {
    const text = [
      'export const x = (',
      '  // the element below closes with </p>',
      '  <p>{a}</p>',
      ');',
      '',
    ].join('\n');
    expect(spans('fixture.tsx', text)).toEqual([[2, 2, '// the element below closes with </p>']]);
  });

  it('commentsOf reads a docblock once, and nothing nested out of a // inside it', () => {
    expect(spans('fixture.ts', '/** @deprecated // row 57 */\nexport const a = 1;\n')).toEqual([
      [1, 1, '/** @deprecated // row 57 */'],
    ]);
  });
});

/**
 * The parser is error-tolerant, so nothing throws on its own and there is no "did it
 * parse" boolean in the public API, so `parseDiagnostics` is read off the object
 * through a local type. The pair is what keeps that read from going vacuous: a
 * `typescript` upgrade that drops the field reds the first of these rather than
 * passing forever.
 */
describe('a file that did not parse', () => {
  const GARBLED = 'export function f() { return 1;';

  it('is refused by the comparator rather than compared', () => {
    expect(() => compareSources('fixture.ts', GARBLED, GARBLED)).toThrow(/did not parse/);
  });

  it('is refused by the census too', () => {
    expect(() => censusOf('fixture.ts', 'const a = "oops;')).toThrow(/did not parse/);
  });

  it('does not refuse a well-formed file, so the refusal is not "refuse everything"', () => {
    expect(() => tokensOf('fixture.ts', 'export const a = 1;')).not.toThrow();
  });

  it('is what a .tsx read under the wrong ScriptKind becomes, so the extension is held', () => {
    const source = 'export const x = <p>{a}</p>;';
    expect(() => tokensOf('fixture.ts', source)).toThrow(/did not parse/);
    expect(() => tokensOf('fixture.tsx', source)).not.toThrow();
  });
});

/**
 * comment-tokens.ts is the half a test may import; comment-check.ts reads argv, the
 * filesystem and `git show`, and no test imports it. The check reads both because the
 * predicate has to demonstrate it can tell them apart. A purity check that has only
 * ever seen a pure file could be returning true no matter what.
 */
describe('comment-tokens.ts starts nothing when a test imports it', () => {
  const CORE = 'scripts/comment-tokens.ts';
  const ENTRY = 'scripts/comment-check.ts';

  const parse = (text: string): ts.SourceFile =>
    ts.createSourceFile(CORE, text, ts.ScriptTarget.Latest, true);

  const read = (relative: string): ts.SourceFile =>
    parse(fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8'));

  const named = (node: ts.CallExpression): string =>
    ts.isStringLiteral(node.arguments[0]) ? node.arguments[0].text : '(dynamic)';

  const specifiersOf = (source: ts.SourceFile): string[] => {
    const found: string[] = [];
    const collect = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        found.push(node.moduleSpecifier.text);
      }
      if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) found.push(named(node));
        if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
          found.push(named(node));
        }
      }
      ts.forEachChild(node, collect);
    };
    collect(source);
    return found;
  };

  const INERT_LEAVES: readonly ts.SyntaxKind[] = [
    ts.SyntaxKind.StringLiteral,
    ts.SyntaxKind.NumericLiteral,
    ts.SyntaxKind.RegularExpressionLiteral,
    ts.SyntaxKind.ArrowFunction,
  ];

  /** Over both halves of a property: a computed key is an expression a walk over values never visits. */
  const inertExpression = (node: ts.Expression): boolean => {
    if (ts.isArrayLiteralExpression(node)) return node.elements.every(inertExpression);
    if (ts.isObjectLiteralExpression(node)) {
      return node.properties.every(
        (p) =>
          ts.isShorthandPropertyAssignment(p) ||
          (ts.isPropertyAssignment(p) &&
            (!ts.isComputedPropertyName(p.name) || inertExpression(p.name.expression)) &&
            inertExpression(p.initializer)),
      );
    }
    return INERT_LEAVES.includes(node.kind);
  };

  const inert = (statement: ts.Statement): boolean => {
    if (ts.isImportDeclaration(statement)) return true;
    if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) return true;
    if (ts.isFunctionDeclaration(statement)) return true;
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.every(
        (d) => d.initializer !== undefined && inertExpression(d.initializer),
      );
    }
    return false;
  };

  const running = (source: ts.SourceFile): string[] =>
    source.statements.filter((s) => !inert(s)).map((s) => s.getText().split('\n')[0]);

  const core = read(CORE);
  const entry = read(ENTRY);

  it('imports typescript and nothing else, by import or by require', () => {
    expect(specifiersOf(core)).toEqual(['typescript']);
  });

  it('runs nothing at its top level, so importing it cannot read a file or spawn git', () => {
    expect(running(core)).toEqual([]);
  });

  it('reads a file that has imports and statements at all, so neither check is vacuous', () => {
    expect(specifiersOf(core).length).toBeGreaterThan(0);
    expect(core.statements.length).toBeGreaterThan(0);
  });

  /**
   * The non-vacuity control in its sharpest form, and the statement of why no test
   * imports the entry: the same two predicates called on the impure half must
   * disagree with themselves above.
   */
  it('reads comment-check.ts as the impure half, which is why no test imports it', () => {
    expect(specifiersOf(entry)).toContain('node:fs');
    expect(specifiersOf(entry)).toContain('node:child_process');
    expect(running(entry)).not.toEqual([]);
  });

  /** Against the positions a call can sit in rather than spellings of one shape. */
  const holes: [string, string][] = [
    ['a bare call', "export const HOLE = ts.getLeadingCommentRanges('', 0);"],
    ['a call inside an object literal', "export const HOLE = { r: ts.getLeadingCommentRanges('', 0) };"],
    ['a call inside an array literal', "export const HOLE = [ts.getLeadingCommentRanges('', 0)];"],
    ['a call two containers deep', "export const HOLE = [{ a: { b: ts.getLeadingCommentRanges('', 0) } }];"],
    ['a call inside a computed key', "export const HOLE = { [ts.sys.newLine]: 1 };"],
    [
      'a require reaching the filesystem from inside an object',
      "export const HOLE = { fs: require('node:fs').readFileSync('x', 'utf8') };",
    ],
    ['an IIFE', 'export const HOLE = (() => 1)();'],
    ['a bare statement', "console.log('x');"],
    ['a property access, which is how a SyntaxKind constant would arrive', 'export const HOLE = ts.SyntaxKind.JSDoc;'],
  ];

  it.each(holes)('sees %s at the top level as running', (_what, line) => {
    expect(running(parse(line))).not.toEqual([]);
  });

  /** Refusing every computed key closes the hole above and reds this, which is why it is not the fix. */
  it('sees a computed key that computes nothing as inert', () => {
    expect(running(parse("export const OK = { ['ts']: 1 };"))).toEqual([]);
  });

  it('sees the shapes this module is actually made of as inert', () => {
    const shapes = [
      "import ts from 'typescript';",
      'export type A = { kind: string };',
      'type B = ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] };',
      'export const C = (name: string): number => name.length;',
      "export const D: readonly string[] = ['.ts', '.tsx'];",
      'export function e(): number { return 1; }',
    ].join('\n');
    expect(running(parse(shapes))).toEqual([]);
  });

  /** The other half of the same hole: the specifier walk reaches a require inside a container. */
  it('names a module hidden inside a container literal', () => {
    expect(specifiersOf(parse("export const HOLE = { fs: require('node:fs') };"))).toEqual([
      'node:fs',
    ]);
  });
});
