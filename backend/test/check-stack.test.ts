import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import ts from 'typescript';
import {
  assertCheckPort,
  assertNoOptions,
  assertRunPaths,
  backendArgv,
  backendEnv,
  DEFAULT_API_PORT,
  DEFAULT_APP_PORT,
  killOutcome,
  markerFor,
  NOTHING_TO_TEAR_DOWN,
  parseOptions,
  reuseVerdict,
  shouldKill,
  teardownIncomplete,
  teardownSentence,
  webArgv,
  type ChildRecord,
  type Observed,
} from '../scripts/check-stack-guards';

const MARKER = markerFor('ab12cd34');

const record = (over: Partial<ChildRecord> = {}): ChildRecord => ({
  kind: 'backend',
  pid: 28820,
  port: 4300,
  commandLine: `"C:\\Program Files\\nodejs\\node.exe" cli.mjs src\\index.ts -- --finto-check-run ${MARKER}`,
  creationDate: '2026-08-18T09:12:33.4410000+03:00',
  logPath: 'C:\\Temp\\finto-check\\ab12cd34\\backend.log',
  ...over,
});

const observed = (r: ChildRecord, over: Partial<Observed> = {}): Observed => ({
  pid: r.pid,
  commandLine: r.commandLine,
  creationDate: r.creationDate,
  ...over,
});

/**
 * I3. Written first because it is the whole reason shouldKill exists: a manifest
 * left behind by a crashed run names a pid Windows has since handed to something
 * else, and the fix meant to prevent the taskkill incident is what reproduces it.
 */
describe('shouldKill', () => {
  it('refuses a pid that has been reused by another process', () => {
    const r = record();
    const verdict = shouldKill(
      r,
      observed(r, { commandLine: '"C:\\Program Files\\nodejs\\node.exe" C:\\Dev\\Finto\\backend\\node_modules\\tsx\\dist\\cli.mjs src\\index.ts' }),
    );
    expect(verdict.kill).toBe(false);
    expect(verdict.kill === false && verdict.reason).toBe('not-ours');
  });

  it('refuses a pid whose process started at a different time', () => {
    const r = record();
    const verdict = shouldKill(r, observed(r, { creationDate: '2026-08-18T11:00:00.0000000+03:00' }));
    expect(verdict.kill === false && verdict.reason).toBe('not-ours');
  });

  it('refuses a child whose identity was never captured', () => {
    const r = record({ commandLine: '', creationDate: '' });
    expect(shouldKill(r, observed(record())).kill).toBe(false);
  });

  it('reports a dead process as gone, which is not the same answer as not-ours', () => {
    const verdict = shouldKill(record(), undefined);
    expect(verdict.kill === false && verdict.reason).toBe('gone');
  });

  it('kills the process whose whole identity still matches', () => {
    const r = record();
    expect(shouldKill(r, observed(r))).toEqual({ kill: true });
  });

  it('names what differed, so a refusal can be read rather than guessed at', () => {
    const r = record();
    const verdict = shouldKill(r, observed(r, { pid: 99999, creationDate: 'later' }));
    expect(verdict.kill === false && verdict.reason === 'not-ours' && verdict.detail).toContain('99999');
  });
});

/** I1. The owner's database and the suite's are one typo apart from the check's. */
/** I2. */
describe('assertCheckPort', () => {
  it.each([4000, 5173, 5174, 5175])('refuses %i, which the owner is on or drifts onto', (port) => {
    expect(() => assertCheckPort('app', port)).toThrow(/owner's stack/);
  });

  /**
   * Through the constants and on their values, because either half alone is green
   * where it matters: asserted as bare literals, a default moved onto 4000 passes
   * until somebody runs `up`; asserted only through the constants, a default moved
   * to 4301 passes while check-stack.md and the `up` summary still print 4300.
   */
  it('accepts the check stack\u2019s own defaults', () => {
    expect(assertCheckPort('api', DEFAULT_API_PORT)).toBe(DEFAULT_API_PORT);
    expect(assertCheckPort('app', DEFAULT_APP_PORT)).toBe(DEFAULT_APP_PORT);
    expect(DEFAULT_API_PORT).toBe(4300);
    expect(DEFAULT_APP_PORT).toBe(5473);
  });

  it.each([0, 80, 65535, 50000, 1.5, Number.NaN])('refuses %s as a port at all', (port) => {
    expect(() => assertCheckPort('api', port)).toThrow(/not a usable port/);
  });
});

/** I2b. */
describe('the child command lines', () => {
  it('pins the web port with --strictPort, so a busy port is a failure and not a drift', () => {
    const argv = webArgv({ viteBin: 'vite.js', port: 5473, host: 'localhost', marker: MARKER });
    expect(argv).toContain('--strictPort');
    expect(argv.slice(argv.indexOf('--port'), argv.indexOf('--port') + 2)).toEqual(['--port', '5473']);
    expect(argv.slice(argv.indexOf('--host'), argv.indexOf('--host') + 2)).toEqual(['--host', 'localhost']);
  });

  it('carries the run marker in both children, after the -- vite refuses unknown flags before', () => {
    const web = webArgv({ viteBin: 'vite.js', port: 5473, host: 'localhost', marker: MARKER });
    const backend = backendArgv({ tsxCli: 'cli.mjs', entry: 'src/index.ts', marker: MARKER });
    for (const argv of [web, backend]) {
      expect(argv.at(-1)).toBe(MARKER);
      expect(argv.at(-3)).toBe('--');
    }
    expect(backend.slice(0, 2)).toEqual(['cli.mjs', 'src/index.ts']);
  });

  it('derives the marker from the run id, so two runs are never confusable', () => {
    expect(markerFor('ab12cd34')).toBe('finto-check-ab12cd34');
    expect(markerFor('ab12cd34')).not.toBe(markerFor('ab12cd35'));
  });
});

/**
 * The zero-row refusal only ever fires on an `--import` the parser saw, so a flag
 * dropped in silence defeats it through the door beside it: `up` then reports ready
 * over an empty database and the only tell is a summary line that is not there.
 */
describe('parseOptions', () => {
  it('takes the three flags it documents', () => {
    expect(
      parseOptions(['up', '--api-port', '4301', '--app-port', '5474', '--import', 'C:\\x.pdf']),
    ).toEqual({ apiPort: 4301, appPort: 5474, importFile: 'C:\\x.pdf' });
  });

  it('falls back to the shipped defaults', () => {
    expect(parseOptions(['up'])).toEqual({
      apiPort: DEFAULT_API_PORT,
      appPort: DEFAULT_APP_PORT,
      importFile: undefined,
    });
  });

  it('refuses --import=<path>, and says where the value goes', () => {
    expect(() => parseOptions(['up', '--import=C:\\x.pdf'])).toThrow(/after a space/);
  });

  it('refuses a misspelled flag rather than ignoring it', () => {
    expect(() => parseOptions(['up', '--imports', 'C:\\x.pdf'])).toThrow(
      /--imports is not a flag/,
    );
  });

  it('refuses a flag whose value is missing, which would otherwise be dropped', () => {
    expect(() => parseOptions(['up', '--import'])).toThrow(/no value after it/);
  });

  it('refuses a stray token that is no flag at all', () => {
    expect(() => parseOptions(['up', 'C:\\x.pdf'])).toThrow(/is not a flag/);
  });
});

/** The same refusal on the two verbs that read no option, where it was a shrug. */
describe('assertNoOptions', () => {
  const ignored: [string, string[]][] = [
    ['down', ['down', '--import', 'C:\\x.pdf']],
    ['status', ['status', '--api-port', '1']],
    ['down', ['down', 'up']],
  ];

  it.each(['down', 'status'])('accepts %s on its own', (verb) => {
    expect(() => assertNoOptions(verb, [verb])).not.toThrow();
  });

  it.each(ignored)('refuses what %s would otherwise have ignored', (verb, argv) => {
    expect(() => assertNoOptions(verb, argv)).toThrow(/takes no options/);
  });
});

/** I4. */
/**
 * Where the check's own statements land. FINTO_HOME decides the database and it does
 * NOT decide the statements folder on its own: DOCUMENT_STORE_PATH beats it, and the
 * child inherits the owner's environment and then reads backend/.env on top of that.
 * So an owner who had set that variable had a check upload its fixture CSVs into the
 * folder holding their real bank statements.
 *
 * Blank and not absent is the whole of the fix: dotenv fills in a key that is missing
 * from process.env and leaves a key that is present alone.
 */
describe('backendEnv', () => {
  const env = backendEnv({ home: path.join(os.tmpdir(), 'finto-check', 'ab12cd34', 'home'), apiPort: 4300 });

  it('sends the run its own home', () => {
    expect(env.FINTO_HOME).toBe(path.join(os.tmpdir(), 'finto-check', 'ab12cd34', 'home'));
    expect(env.PORT).toBe('4300');
  });

  it.each(['DOCUMENT_STORE_PATH', 'DATABASE_URL'])(
    'blanks %s rather than leaving it out, so neither the shell nor backend/.env decides it',
    (key) => {
      expect(Object.keys(env)).toContain(key);
      expect(env[key]).toBe('');
    },
  );
});

describe('assertRunPaths', () => {
  const repoRoot = 'C:\\Dev\\Finto';
  const outside = path.join(os.tmpdir(), 'finto-check', 'ab12cd34');
  const ok = { repoRoot, runDir: outside, home: path.join(outside, 'home') };

  it('accepts a run directory outside the repository', () => {
    expect(() => assertRunPaths(ok)).not.toThrow();
  });

  it('refuses a run directory inside the repository', () => {
    expect(() => assertRunPaths({ ...ok, runDir: 'C:\\Dev\\Finto\\tmp\\run' })).toThrow(/inside the repository/);
  });

  it('refuses a run directory that differs from the repository only in case', () => {
    expect(() => assertRunPaths({ ...ok, runDir: 'c:\\dev\\finto\\tmp\\run' })).toThrow(/inside the repository/);
  });

  /**
   * The regex names the branch, not the label: the owner-documents arm is
   * unreachable without the repository arm also matching, so that is the whole
   * assertion.
   */
  it('refuses the owner\u2019s document store itself', () => {
    expect(() => assertRunPaths({ ...ok, home: 'C:\\Dev\\Finto\\backend\\data' })).toThrow(
      /at or inside the owner's document store/,
    );
  });

  it('refuses anything under the owner\u2019s document store', () => {
    expect(() =>
      assertRunPaths({ ...ok, home: 'C:\\Dev\\Finto\\backend\\data\\documents' }),
    ).toThrow(/at or inside the owner's document store/);
  });

  it('refuses the repository root itself', () => {
    expect(() => assertRunPaths({ ...ok, runDir: repoRoot })).toThrow(/inside the repository/);
  });
});

/** I5. */
describe('reuseVerdict', () => {
  const live = { record: record(), verdict: { kill: true } as const };
  const dead = { record: record({ pid: 1 }), verdict: { kill: false, reason: 'gone' } as const };
  const stolen = {
    record: record({ pid: 2 }),
    verdict: { kill: false, reason: 'not-ours', detail: 'command line differs' } as const,
  };

  it('lets up clean up after a run whose processes are all dead', () => {
    expect(reuseVerdict([dead, dead])).toEqual({ ok: true });
  });

  it('refuses to start over a stack that is still running', () => {
    expect(reuseVerdict([live, dead])).toEqual({ ok: false, blocking: [live] });
  });

  it('refuses to clean up quietly after a manifest that points at somebody else', () => {
    expect(reuseVerdict([stolen, dead])).toEqual({ ok: false, blocking: [stolen] });
  });
});

/**
 * `taskkill` answers 128 both for a pid that was already gone and for one it was
 * refused, so the exit code cannot decide this and the second observation does.
 */
describe('killOutcome', () => {
  it('calls a kill that returned success stopped', () => {
    expect(killOutcome({ killed: true, stillObserved: false })).toBe('stopped');
  });

  it('calls a failed kill whose pid is gone already dead, not a failure', () => {
    expect(killOutcome({ killed: false, stillObserved: false })).toBe('alreadyDead');
  });

  it('calls a failed kill whose pid is still there a failure', () => {
    expect(killOutcome({ killed: false, stillObserved: true })).toBe('failed');
  });

  it('does not answer the same thing for a refused kill and a child that exited on its own', () => {
    expect(killOutcome({ killed: false, stillObserved: true })).not.toBe(
      killOutcome({ killed: false, stillObserved: false }),
    );
  });

  it('feeds the counts a teardown reports, so all three outcomes reach the sentence', () => {
    const sentence = teardownSentence({ killed: 1, alreadyDead: 1, notOurs: 0, failed: 1 });
    expect(sentence).toContain('3 recorded');
    expect(sentence).toContain('1 already dead');
    expect(sentence).toContain('1 could not be stopped');
  });
});

describe('teardownSentence', () => {
  const nothing = { killed: 0, alreadyDead: 0, notOurs: 0, failed: 0 };

  it('does not say the same thing about a teardown and an empty one', () => {
    expect(teardownSentence({ ...nothing, killed: 2 })).not.toBe(teardownSentence(nothing));
  });

  it('does not say the same thing about nothing recorded and nothing alive', () => {
    expect(teardownSentence({ ...nothing, alreadyDead: 2 })).not.toBe(teardownSentence(nothing));
  });

  it('does not say nothing was recorded when a recorded process was left alone', () => {
    expect(teardownSentence({ ...nothing, notOurs: 1 })).not.toBe(teardownSentence(nothing));
    expect(teardownSentence({ ...nothing, notOurs: 1 })).toContain('NOT OURS');
  });

  it('does not say the same thing about a kill that failed and a child that was never recorded', () => {
    const survived = { ...nothing, killed: 1, failed: 1 };
    expect(teardownSentence(survived)).not.toBe(teardownSentence({ ...nothing, killed: 1 }));
    expect(teardownSentence(survived)).toContain('2 recorded');
    expect(teardownSentence(survived)).toContain('1 could not be stopped');
  });

  it('is not the sentence down prints when no run exists at all', () => {
    for (const n of [
      nothing,
      { ...nothing, alreadyDead: 2 },
      { ...nothing, killed: 2 },
      { ...nothing, notOurs: 2 },
      { ...nothing, failed: 2 },
    ]) {
      expect(teardownSentence(n)).not.toBe(NOTHING_TO_TEAR_DOWN);
    }
  });

  it('counts every recorded process, so "equal" and "compared nothing" cannot read alike', () => {
    const sentence = teardownSentence({ killed: 2, alreadyDead: 1, notOurs: 3, failed: 1 });
    expect(sentence).toContain('7 recorded');
    expect(sentence).toContain('2 stopped');
    expect(sentence).toContain('1 already dead');
    expect(sentence).toContain('3 left alone');
    expect(sentence).toContain('1 could not be stopped');
  });
});

/** What is kept, what is printed about it and the exit code all read this one predicate. */
describe('teardownIncomplete', () => {
  const finished = { notOurs: 0, failed: 0, busyPorts: 0 };
  const unfinished: [string, typeof finished][] = [
    ['a process left alone as NOT OURS', { ...finished, notOurs: 1 }],
    ['a kill that failed', { ...finished, failed: 1 }],
    ['a port still answering afterwards', { ...finished, busyPorts: 1 }],
  ];

  it('lets a teardown that accounted for everything remove its own record', () => {
    expect(teardownIncomplete(finished)).toBe(false);
  });

  it.each(unfinished)('keeps the evidence after %s', (_what, n) => {
    expect(teardownIncomplete(n)).toBe(true);
  });
});

/**
 * The guards are unit-testable only while importing them starts nothing, and
 * "nobody imports the entry file" is a convention held by reading. This reads the
 * module as source: the modules it names must be exactly `node:path` - pg, the
 * config and the spawn live in check-stack.ts, which no test imports - and its top
 * level must do nothing at all. Neither half is redundant. `require` reaches
 * `node:child_process` without an import, and `backend/` is CommonJS under tsx, so
 * a top-level `require('node:child_process').spawnSync('taskkill.exe', …)` is in
 * this package's own idiom; an inventory admitting every `node:` builtin admits it.
 */
describe('check-stack-guards.ts starts nothing when a test imports it', () => {
  const SOURCE = 'scripts/check-stack-guards.ts';
  const parse = (text: string): ts.SourceFile =>
    ts.createSourceFile(SOURCE, text, ts.ScriptTarget.Latest, true);

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

  /**
   * Recursive over the container kinds, and over both halves of a property: a
   * computed key is an arbitrary expression in a position a walk over values alone
   * never visits, which is the same call one brace deeper than the last hole.
   */
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

  const guards = parse(fs.readFileSync(path.resolve(process.cwd(), SOURCE), 'utf8'));

  it('imports node:path and nothing else, by import or by require', () => {
    expect(specifiersOf(guards)).toEqual(['node:path']);
  });

  it('runs nothing at its top level, so importing it cannot start or kill anything', () => {
    expect(running(guards)).toEqual([]);
  });

  it('reads a file that has imports and statements at all, so neither check is vacuous', () => {
    expect(specifiersOf(guards).length).toBeGreaterThan(0);
    expect(guards.statements.length).toBeGreaterThan(0);
  });

  /**
   * The predicate against the positions a call can sit in rather than against
   * spellings of one shape: what a mutation table proves is the axis it varies.
   */
  const holes: [string, string][] = [
    ['a bare call', "export const HOLE = path.resolve('.');"],
    ['a call inside an object literal', "export const HOLE = { root: path.resolve('.') };"],
    ['a call inside an array literal', "export const HOLE = [path.resolve('.')];"],
    ['a call two containers deep', "export const HOLE = [{ a: { b: path.resolve('.') } }];"],
    ['a call inside a computed key', "export const HOLE = { [path.resolve('.')]: 1 };"],
    [
      'a require reaching spawnSync from inside an object',
      "export const HOLE = { cp: require('node:child_process').spawnSync('cmd.exe', ['/c', 'ver']) };",
    ],
    ['an IIFE', 'export const HOLE = (() => 1)();'],
    ['a bare statement', "console.log('x');"],
  ];

  it.each(holes)('sees %s at the top level as running', (_what, line) => {
    expect(running(parse(line))).not.toEqual([]);
  });

  /** Refusing every computed key closes the hole above and reds this, which is why it is not the fix. */
  it('sees a computed key that computes nothing as inert', () => {
    expect(running(parse("export const OK = { ['api']: 4300 };"))).toEqual([]);
  });

  it('sees the shapes this module is actually made of as inert', () => {
    const shapes = [
      "import path from 'node:path';",
      "export const A = 'x';",
      'export const B = 4300;',
      'export const C = /^finto_check_[0-9a-f]{8}$/;',
      'export const D: readonly number[] = [4000, 5432];',
      "export const E = { flags: ['--import'], port: 4300 };",
      'export const F = (n: number): number => n;',
      'export type G = { a: string };',
      'export function h(): number { return process.pid; }',
    ].join('\n');
    expect(running(parse(shapes))).toEqual([]);
  });

  /**
   * The other half of the same hole: `node:child_process` inside a container is
   * reached by the specifier walk, so the list has to be the inventory the module
   * header claims and not "nothing but a node: builtin", which admits it.
   */
  it('names a module hidden inside a container literal', () => {
    expect(specifiersOf(parse("export const HOLE = { cp: require('node:child_process') };"))).toEqual([
      'node:child_process',
    ]);
  });
});
