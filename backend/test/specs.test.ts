import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { commentsOf, type Comment } from '../scripts/comment-tokens';

/**
 * A SPEC.md sits beside the module it describes, so nothing imports it and nothing
 * typechecks it. What rots in one is a coordinate that has moved, a path somebody
 * renamed, a pointer to a file only this machine has, and a status a reader cannot
 * see - and prose that has rotted is read as settled. A comment in source is prose
 * too, and the same four things rot in it, so the clauses that can run over a
 * comment run over every one the tree carries.
 *
 * The unpublished set is DERIVED from .gitignore, never listed here. The rule is
 * "ignored by .gitignore" and never "is a root-level .md": AGENTS.md is a root-level
 * .md and is published, and .claude/agents/ is un-ignored by a negation sitting
 * beside the pattern that ignores its parent. A list maintained by hand beside the
 * thing it describes gets both of those backwards and still looks right.
 */
const ROOT = path.resolve(process.cwd(), '..');

/**
 * Literal, not a glob: a glob asserts nothing about a spec that was deleted, which is
 * the one edit this whole file is powerless against if it enumerates by looking.
 */
const SPEC_DIRS = [
  'backend/src',
  'backend/src/db',
  'backend/src/providers',
  'backend/src/wire',
  'backend/test',
  'web/src',
];

/** One list, because a path is a path: the citation clause and the existence clause read it. */
const EXTENSIONS = [
  'tsx',
  'ts',
  'jsx',
  'js',
  'md',
  'json',
  'sql',
  'css',
  'html',
  'yaml',
  'yml',
  'pdf',
  'csv',
];

const EXT = EXTENSIONS.join('|');
/**
 * What has to stand in front of a token for it to be a pointer, read by both extractors
 * because a path is a path. A token carrying a scheme is a URL rather than a path, which
 * is one condition and not an obstacle; the boundary is what stops the tail of one from
 * reading as a path once the head has been refused, and without it
 * https://example.com/schema.json yields example.com/schema.json.
 *
 * It stops there, and the limit is stated rather than answered: a host written without a
 * scheme produces that same token and always will, because nothing in the text tells a
 * host from a path. A list of hosts would be a hand-written list beside the thing it
 * describes, which is what this file exists to refuse.
 *
 * A lookbehind can only ever take matches away, so a real path dropped by it looks
 * exactly like a tightening. The per-spec counts in the titles below are the control.
 */
const BOUNDARY = '(?<![\\w@.\\-:/])';
const PATH_TOKEN = new RegExp(`${BOUNDARY}[\\w@.-]+(?:/[\\w@.-]+)*\\.(?:${EXT})\\b`, 'g');
/**
 * The second shape a pointer takes. A directory carries no extension, so PATH_TOKEN
 * cannot see one - and a pointer into the task directories is what this whole file
 * was raised about.
 */
const DIR_TOKEN = new RegExp(`${BOUNDARY}[\\w@.-]+(?:/[\\w@.-]+)*/`, 'g');
/** No boundary, deliberately: this one refuses rather than resolves, so a lookbehind could
 * only ever let a real coordinate through, and a false positive is one word to rephrase. */
const CITATION = new RegExp(`[\\w@./-]+\\.(?:${EXT}):\\d+`, 'g');
const BACKTICKED = /`([^`\n]+)`/g;
/** git's short sha sets the floor. Raising it to dodge the English words that are all hex
 * letters would let a real citation through, and a false positive here is one word to rephrase. */
const SHA = /^[0-9a-f]{7,40}$/;

const STATUSES = ['Status: draft', 'Status: reviewed'];

const abs = (p: string): string => path.resolve(ROOT, p);
const read = (p: string): string => fs.readFileSync(abs(p), 'utf8');

/**
 * Every path-shaped token, wherever it stands. Requiring backticks would exempt a
 * path written in a markdown link or bare in a sentence, and a spec that writes them
 * that way contributes nothing to the existence clause while reporting success.
 */
const extractPaths = (text: string): string[] => [...new Set(text.match(PATH_TOKEN) ?? [])];

/** A file path yields its parent too, which is true rather than noise: the parent is a
 * directory the spec names and a reader can be sent to one that has moved. */
const extractDirs = (text: string): string[] => [...new Set(text.match(DIR_TOKEN) ?? [])];

const extractCitations = (text: string): string[] => [...new Set(text.match(CITATION) ?? [])];

const extractBackticked = (text: string): string[] =>
  [...text.matchAll(BACKTICKED)].map((m) => m[1].trim());

/**
 * Every way prose in this tree names the plan without a path: the plan by name; a
 * row, item, finding, decision, trap, question or stage by number; an invariant by
 * number or lettered; a pull request; a round of reviewing or of fixing; a decision,
 * invariant, review finding, question or settled item by its letter and number, and a
 * lettered decision; a section; a zero-padded task id with an optional stage letter. No
 * boundary can be loosened to dodge a real hit, and a false positive is one word to
 * rephrase.
 *
 * The lookbehinds are what let a stored value written in quotes, a decimal, a grouped
 * thousand and a figure with a thin space through, and the stage-letter range is what
 * keeps a word that begins with a capital and digits from reading as a reference.
 * Case-sensitive on the letters: a lower-case letter and a digit is a variable, not a
 * reference. What the pattern cannot see is stated in backend/test/SPEC.md.
 */
const PLAN = new RegExp(
  [
    String.raw`\b(?:ROADMAP|[Rr]oadmap)\b`,
    String.raw`\b(?:[Rr]ows?|[Ii]tems?|[Ff]indings?|[Dd]ecisions?|[Tt]raps?|[Qq]uestions?|[Ss]tages?)\s+\d+[a-e]?`,
    String.raw`\b[Ii]nvariants?\s+(?:\d+|\([a-z]\))`,
    String.raw`\bPR\s?#\d+`,
    String.raw`\b(?:review|fix) rounds?\b`,
    String.raw`(?<!#)\b(?:D|I|R|Q|S|MD)-?\d+[a-e]?\b`,
    String.raw`\bD-[A-Z]\b`,
    String.raw`§\s?\d+`,
    String.raw`(?<![\w.,'"])(?<!\d\s)0\d\d[a-e]?\b`,
  ].join('|'),
  'g',
);

type Hit = { token: string; offset: number };

/** Offsets and not a Set of tokens, because a hit is reported on the line it sits on. */
const extractPlan = (text: string): Hit[] =>
  [...text.matchAll(PLAN)].map((m) => ({ token: m[0], offset: m.index }));

interface IgnoreRule {
  readonly source: string;
  readonly negated: boolean;
  readonly dirOnly: boolean;
  readonly anchored: boolean;
  readonly re: RegExp;
}

const META = new Set(['.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\']);

/**
 * One left-to-right pass, never a chain of .replace calls: a chain reads its own
 * output, and the group a doubled star expands to carries a star and a question mark
 * of its own that the later steps then eat. A pattern compiled that way matches
 * nothing at all, drops out of the deny set in silence, and the derivation still looks
 * populated - the same shape as a pattern carrying a trailing carriage return, by a
 * second route and with no crafted case pointed at it until now.
 */
const toRegex = (pattern: string): RegExp => {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern.startsWith('**/', i)) {
      source += '(?:[^/]+/)*';
      i += 2;
    } else if (pattern.startsWith('**', i)) {
      source += '.*';
      i += 1;
    } else if (pattern[i] === '*') {
      source += '[^/]*';
    } else if (pattern[i] === '?') {
      source += '[^/]';
    } else {
      source += META.has(pattern[i]) ? `\\${pattern[i]}` : pattern[i];
    }
  }
  return new RegExp(`^${source}$`);
};

/** Split on \r?\n and trimmed: this tree is checked out CRLF, and a pattern carrying a
 * trailing carriage return matches nothing while the derivation still looks populated. */
const parseGitignore = (text: string): IgnoreRule[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      const negated = line.startsWith('!');
      let pattern = negated ? line.slice(1) : line;
      const dirOnly = pattern.endsWith('/');
      if (dirOnly) pattern = pattern.slice(0, -1);
      const rooted = pattern.startsWith('/');
      if (rooted) pattern = pattern.slice(1);
      return {
        source: line,
        negated,
        dirOnly,
        // an interior slash anchors a pattern to the repository root; without one it
        // matches a name at any depth, which is what carries *.pdf into the data folder
        anchored: rooted || pattern.includes('/'),
        re: toRegex(pattern),
      };
    });

/**
 * git's model rather than substring containment: every prefix of the path, every
 * pattern in file order, last match wins, a `!` line un-ignores. Containment would
 * refuse `.agents/README.md`, which is published; matching only the full path would
 * permit a decisions file two levels inside the ignored directory beside it, which is
 * not, because what excludes it is the pattern hitting its parent directory.
 *
 * A file under an excluded directory cannot be re-included, so a level that comes out
 * ignored ends the walk.
 *
 * A trailing slash is how a caller says the last level is a directory - a directory
 * citation in a spec, and this file's own walk. Without it the data folder is tested
 * as a file and every dirOnly pattern declines to look at it.
 */
const isIgnored = (p: string, rules: readonly IgnoreRule[]): boolean => {
  const parts = p.split('/').filter((part) => part !== '');
  const trailing = p.endsWith('/');
  let ignored = false;
  for (let i = 0; i < parts.length; i += 1) {
    if (ignored) return true;
    const prefix = parts.slice(0, i + 1).join('/');
    const isDir = trailing || i < parts.length - 1;
    for (const rule of rules) {
      if (rule.dirOnly && !isDir) continue;
      if (rule.re.test(rule.anchored ? prefix : parts[i])) ignored = !rule.negated;
    }
  }
  return ignored;
};

const GITIGNORE = read('.gitignore');
const RULES = parseGitignore(GITIGNORE);

/**
 * NOT the deny set - that one is derived. This is what the derivation has to come out denying, so
 * a .gitignore that stops ignoring them empties it rather than passing over every spec in silence.
 * Each is present and untracked here, which is why existence separates none of them from a
 * published file.
 */
const KNOWN_UNPUBLISHED = [
  'ROADMAP.md',
  'DEBT.md',
  'CLAUDE.md',
  'REDESIGN-BACK-DEBT.md',
  'Report.md',
  'Strategy.md',
];

/**
 * The one walk two sets are read off: the specs on disk, and every source file whose
 * comments are read below. It skips what isIgnored denies rather than a second skip
 * list by hand - an unpublished file is out of scope by the rule the rest of this file
 * already uses, and a file the walk visits and a path a comment names are judged by
 * the same derivation - and skips .git, which is not the tree git tracks, and
 * node_modules by name even if the rule that ignores it were to go.
 */
const findFiles = (dir: string, keep: (name: string) => boolean, prefix = ''): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') return [];
      return isIgnored(`${rel}/`, RULES) ? [] : findFiles(path.join(dir, entry.name), keep, rel);
    }
    return keep(entry.name) && !isIgnored(rel, RULES) ? [rel] : [];
  });

/**
 * SPEC_DIRS holds one direction and only one: a spec that was deleted. The other is a
 * spec that was written and not declared, which no clause here reads and which
 * therefore rots with the suite green.
 */
const findSpecs = (dir: string): string[] => findFiles(dir, (name) => name === 'SPEC.md');

type Source = { file: string; comments: readonly Comment[] };

/**
 * Enumerated through the comment tool's own walk and never a walk or a line scan of
 * this file's own: a second enumerator drifts from the first in its control table
 * before it drifts in its code, and a line scan cannot tell a comment from the
 * product's own refusal strings.
 */
const SOURCES: Source[] = findFiles(ROOT, (name) => /\.tsx?$/.test(name)).map((file) => ({
  file,
  comments: commentsOf(file, read(file)),
}));

const lineOf = (c: Comment, offset: number): number =>
  c.line + c.text.slice(0, offset).split('\n').length - 1;

const at = (file: string, c: Comment, offset: number): string => `${file}:${lineOf(c, offset)}`;

const deadPathsIn = ({ file, comments }: Source): string[] =>
  comments.flatMap((c) =>
    [...extractPaths(c.text), ...extractDirs(c.text)]
      .filter((token) => isIgnored(token, RULES))
      .map(
        (token) =>
          `${at(file, c, c.text.indexOf(token))} names ${token}, which .gitignore keeps out of the tree - it exists here and nowhere a reader is; state the rule and cite nothing`,
      ),
  );

const planReferencesIn = ({ file, comments }: Source): string[] =>
  comments.flatMap((c) =>
    extractPlan(c.text).map(
      ({ token, offset }) =>
        `${at(file, c, offset)} says "${token}" - the plan is not in the tree a reader has; write the reason the reference stood for, or nothing`,
    ),
  );

const coordinatesIn = ({ file, comments }: Source): string[] =>
  comments.flatMap((c) => [
    ...extractCitations(c.text).map(
      (token) =>
        `${at(file, c, c.text.indexOf(token))} cites ${token} - a line number is the coordinate that rots first; name the symbol and let the reader look`,
    ),
    ...extractBackticked(c.text)
      .filter((token) => SHA.test(token))
      .map(
        (token) =>
          `${at(file, c, c.text.indexOf(token))} names the commit ${token} - a comment describes the code as it is, and a sha describes it as it was`,
      ),
  ]);

/** A trailing slash is a claim about the kind: a directory citation that resolves to a
 * file is as dead a pointer as one that resolves to nothing. */
const resolvesTo = (target: string, token: string): boolean =>
  fs.existsSync(target) && (!token.endsWith('/') || fs.statSync(target).isDirectory());

const declared = SPEC_DIRS.map((dir) => ({ dir, file: `${dir}/SPEC.md` }));
const missing = declared.filter((s) => !fs.existsSync(abs(s.file))).map((s) => s.file);
const specs = declared
  .filter((s) => fs.existsSync(abs(s.file)))
  .map((s) => ({ ...s, text: read(s.file) }));

describe('every SPEC.md this repository declares', () => {
  it('reads the repository root it means to read', () => {
    for (const anchor of ['AGENTS.md', '.gitignore']) {
      expect(
        fs.existsSync(abs(anchor)),
        `${anchor} is not in ${ROOT} - process.cwd() is the backend package root and the repository root is its parent; if that is wrong every clause below passes over nothing`,
      ).toBe(true);
    }
  });

  it('exists', () => {
    expect(
      missing,
      'a declared spec is not on disk - write it, or take its directory out of SPEC_DIRS in the same edit that deletes it',
    ).toEqual([]);
  });

  it('is the whole set of them, and no spec on disk is declared by nobody', () => {
    const found = findSpecs(ROOT).sort();
    const declaredFiles = declared.map((s) => s.file).sort();
    const undeclared = found.filter((f) => !declaredFiles.includes(f));
    expect(
      found,
      `SPEC_DIRS and the tree disagree, undeclared: ${undeclared.join(', ') || 'none'} - a spec no clause above reads is a document nothing has checked, and it reports success by being invisible`,
    ).toEqual(declaredFiles);
  });

  it('carries no line citation and no commit sha', () => {
    const found = specs.flatMap((spec) => [
      ...extractCitations(spec.text).map(
        (token) =>
          `${spec.file} cites ${token} - a line number is the coordinate that rots first; name the symbol or the file and let the reader look`,
      ),
      ...extractBackticked(spec.text)
        .filter((token) => SHA.test(token))
        .map(
          (token) =>
            `${spec.file} names the commit ${token} - a spec describes the module as it is, and a sha describes it as it was`,
        ),
    ]);
    expect(found).toEqual([]);
  });

  it('names no row, item, task, decision or finding of the plan', () => {
    const found = specs.flatMap((spec) =>
      extractPlan(spec.text).map(
        ({ token }) =>
          `${spec.file} says "${token}" - the plan is not in the tree a reader has; write the reason the reference stood for, or nothing`,
      ),
    );
    expect(found).toEqual([]);
  });

  for (const spec of specs) {
    const files = extractPaths(spec.text);
    const dirs = extractDirs(spec.text);
    const named = [...files, ...dirs];

    it(`${spec.file} names ${files.length} files and ${dirs.length} directories, and every one of them is on disk`, () => {
      // per spec, because one spec naming a path satisfies a repository-wide count
      // while the other contributes nothing and is checked by nothing
      expect(
        named.length,
        `${spec.file} names no file and no directory at all - the existence clause is green over nothing for it`,
      ).toBeGreaterThan(0);

      const dead = named
        .filter((token) => {
          if (resolvesTo(abs(token), token)) return false;
          // a bare name beside a spec has one obvious meaning; anything carrying a
          // path is repository-root-relative and has exactly one
          const bare = !token.replace(/\/$/, '').includes('/');
          return !bare || !resolvesTo(path.resolve(abs(spec.dir), token), token);
        })
        .map(
          (token) =>
            `${spec.file} names ${token}, which resolves from neither ${ROOT} nor ${spec.dir} - paths in a spec are repository-root-relative, a bare name may also sit beside the spec, a trailing slash means it has to be a directory, and existsSync is case-insensitive here and not in CI`,
        );
      expect(dead).toEqual([]);
    });
  }

  it('names nothing a reader of the public tree cannot open', () => {
    const dead = specs.flatMap((spec) =>
      [...extractPaths(spec.text), ...extractDirs(spec.text)]
        .filter((token) => isIgnored(token, RULES))
        .map(
          (token) =>
            `${spec.file} names ${token}, which .gitignore keeps out of the tree - it exists here and nowhere a reader is; state the rule and cite nothing`,
        ),
    );
    expect(dead).toEqual([]);
  });

  it('declares a status above its first section, and it is one of two values', () => {
    for (const spec of specs) {
      const cut = spec.text.search(/^##/m);
      const header = cut < 0 ? spec.text : spec.text.slice(0, cut);
      const lines = header
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith('Status:'));

      expect(
        lines,
        `${spec.file} states its status ${lines.length} times above its first heading - without exactly one, a reader takes a draft for a settled document`,
      ).toHaveLength(1);
      expect(
        STATUSES,
        `${spec.file} reads "${lines[0]}" - the flip out of draft is the owner's review and there is no third value to hide it behind`,
      ).toContain(lines[0]);
    }
  });
});

describe('every comment in the .ts and .tsx files .gitignore leaves in the tree', () => {
  it('reads the whole tree, the config files beside the packages included, and enters nothing ignored', () => {
    const files = SOURCES.map((s) => s.file);
    // one from every directory the walk is meant to reach, written out: a future ignore
    // line matching one of them by name drops the directory with every clause green
    for (const anchor of [
      'backend/drizzle.config.ts',
      'backend/vitest.config.ts',
      'web/vite.config.ts',
      'web/vitest.config.ts',
      'backend/src/app.ts',
      'backend/scripts/comment-tokens.ts',
      'backend/test/specs.test.ts',
      'web/src/main.tsx',
    ]) {
      expect(files, `${anchor} is not in the walked set - the clauses below pass over it`).toContain(
        anchor,
      );
    }
    const entered = files.filter((f) =>
      f.split('/').some((part) => part === 'node_modules' || part === 'dist'),
    );
    expect(entered).toEqual([]);
  });

  it('names nothing a reader of the public tree cannot open', () => {
    expect(SOURCES.flatMap(deadPathsIn)).toEqual([]);
  });

  it('names no row, item, task, decision or finding of the plan', () => {
    expect(SOURCES.flatMap(planReferencesIn)).toEqual([]);
  });

  it('carries no line citation and no commit sha in any comment', () => {
    expect(SOURCES.flatMap(coordinatesIn)).toEqual([]);
  });
});

/**
 * The clauses above run over documents written by the agent that wrote the clauses.
 * These run the same functions over text crafted to break them, which is where a hole
 * in an extractor shows: a spec that contributes no tokens passes every clause.
 */
describe('the rules those clauses are built from', () => {
  it('permits what the public tree carries', () => {
    const denied = [
      'AGENTS.md',
      '.agents/README.md',
      '.claude/agents/reviewer.md',
      'backend/src/db/schema.ts',
    ].filter((p) => isIgnored(p, RULES));
    expect(
      denied,
      'these are tracked and published - a negation beside an ignore pattern is what makes two of them so, and dropping it makes this check stricter than the rule it states',
    ).toEqual([]);
  });

  it('denies what only this machine can open', () => {
    const permitted = [
      ...KNOWN_UNPUBLISHED,
      '.agents/tasks/048-summary-per-account/decisions.md',
      '.claude/settings.local.json',
      'backend/data/report_03-09-2026_11-22-33.pdf',
    ].filter((p) => !isIgnored(p, RULES));
    expect(permitted).toEqual([]);
  });

  it('empties rather than passes over nothing when .gitignore stops ignoring', () => {
    const commented = GITIGNORE.split(/\r?\n/)
      .map((line) => `# ${line}`)
      .join('\r\n');
    const none = parseGitignore(commented);

    expect(none).toEqual([]);
    expect(
      KNOWN_UNPUBLISHED.filter((p) => !isIgnored(p, none)),
      'with nothing derived the deny clause is green over every spec, which is what a length check on the derived set would report as success',
    ).toEqual(KNOWN_UNPUBLISHED);
  });

  const CRAFTED = [
    '# crafted',
    '',
    'Status: draft',
    '',
    '## body',
    '',
    'Backticked: `backend/src/db/dedup.ts`.',
    'Bare in a sentence: backend/test/pglite.ts, mid-clause.',
    'In a link: [the harness](backend/test/helpers.ts).',
    'Cited: backend/src/app.ts:12.',
    'A directory, backticked: `backend/data/`.',
    'A directory, bare: .agents/tasks/048-summary-per-account/ and text after it.',
    'A directory in a link: [the module](backend/src/db/).',
    'A URL to a file: https://example.com/schema.json, which is no pointer at all.',
    'A URL to a directory: https://example.com/docs/, which is no pointer either.',
  ].join('\n');

  /**
   * Control first, because "no ** in .gitignore today" is not the same finding as
   * "nothing is wrong with **". A pattern that compiles to a regex matching nothing
   * leaves the deny set silently while the derivation still looks populated.
   */
  const COMPILED: ReadonlyArray<readonly [string, string, boolean]> = [
    ['.claude/*', '.claude/agents', true],
    ['.claude/*', '.claude/agents/reviewer.md', false],
    ['*.pdf', 'report.pdf', true],
    ['*.pdf', 'report.md', false],
    ['**/build', 'build', true],
    ['**/build', 'a/build', true],
    ['**/build', 'a/b/c/build', true],
    ['**/build', 'build/a', false],
    ['**', 'a', true],
    ['**', 'a/b', true],
    ['docs/**', 'docs/a', true],
    ['docs/**', 'docs/a/b', true],
    ['docs/**', 'docs', false],
  ];

  it('compiles a glob to what git matches with it, ** included', () => {
    const wrong = COMPILED.filter(([pattern, p, expected]) => toRegex(pattern).test(p) !== expected)
      .map(([pattern, p, expected]) => `${pattern} ${expected ? 'must' : 'must not'} match ${p}`);
    expect(wrong).toEqual([]);
  });

  it('reads a path however a document happens to write one, and a URL as no path', () => {
    expect(extractPaths(CRAFTED)).toEqual([
      'backend/src/db/dedup.ts',
      'backend/test/pglite.ts',
      'backend/test/helpers.ts',
      'backend/src/app.ts',
    ]);
    expect(extractCitations(CRAFTED)).toEqual(['backend/src/app.ts:12']);
  });

  it('reads a directory as the pointer it is, and a URL as no pointer at all', () => {
    expect(extractDirs(CRAFTED)).toEqual([
      'backend/src/db/',
      'backend/test/',
      'backend/src/',
      'backend/data/',
      '.agents/tasks/048-summary-per-account/',
    ]);
  });

  it('denies a directory only this machine can open', () => {
    const permitted = ['backend/data/', '.agents/tasks/048-summary-per-account/', 'docs/'].filter(
      (p) => !isIgnored(p, RULES),
    );
    expect(
      permitted,
      'a dirOnly pattern declines to look at a path whose last level it reads as a file, so without the trailing slash a directory citation ships the dead pointer this clause exists to stop',
    ).toEqual([]);
  });

  /**
   * One fixture per way the plan gets named, each run on its own through extractPlan:
   * joined into one text, a fixture that stopped matching hides behind its neighbours.
   */
  const REFERENCES = [
    'ROADMAP 4.2',
    'roadmap item 10',
    'row 54',
    'rows 26a, 26b',
    'Row 65',
    "item 10's D23",
    'finding 6',
    'findings 8, 13',
    'settled decision 2',
    'Trap 9',
    'trap 3',
    'question 4',
    'stage 8',
    'Stages 2, 3 and 8',
    'invariant 3',
    'invariant (a)',
    'PR #75',
    'PR#75',
    'review round',
    'four review rounds',
    'fix round',
    'D3',
    'I4(a)',
    'I2b',
    'Q1',
    'R10',
    'S3',
    'MD8',
    "D-A's evidence",
    "row 25's §20",
    'see §7',
    '054 D19',
    '052b',
    '(007 D5)',
    'pre-037a',
    'since row 021',
    "011b's",
  ];

  /** The shapes the tree writes beside a capital, a hyphen, a digit or a zero that are not references. */
  const NOT_REFERENCES = [
    'the first row',
    'the header row',
    "Excel's last row",
    'the capture stage',
    'stages the upload before the read',
    'the invariant a test holds',
    'UTF-16',
    'N26',
    'C24',
    'DE00',
    'TS2578',
    'V8',
    'COM1',
    'ES2022',
    'SHA-256',
    'I18n',
    '#D50000',
    'A-Z stand for 10..35',
    '" [A-Z]{3}"',
    'D-Day',
    "'007'",
    '1.005',
    '1,000',
    '1,200,000',
    '1,082 EUR',
    '10_000',
    '5 000-character',
    '0700 on a directory',
    'U+0020',
    '0x30',
    '2026-08-08',
    '100.00',
    'md5 of the bytes',
    'r2 is the second remainder',
  ];

  it('refuses every way a comment names the plan', () => {
    const missed = REFERENCES.filter((text) => extractPlan(`// ${text}`).length === 0);
    expect(missed, 'a reference the pattern no longer sees').toEqual([]);
  });

  it('lets a number, a code and a name that are not references through', () => {
    const hit = NOT_REFERENCES.filter((text) => extractPlan(`// ${text}`).length > 0).map(
      (text) => `${text}: ${extractPlan(`// ${text}`).map((h) => h.token).join(', ')}`,
    );
    expect(hit, 'a false positive is one word to rephrase, and these are the words the tree uses').toEqual(
      [],
    );
  });

  const crafted = (fileName: string, lines: string[]): Source => ({
    file: fileName,
    comments: commentsOf(fileName, lines.join('\n')),
  });

  it('reads comments and never strings, in .ts and in .tsx', () => {
    const source = crafted('crafted.ts', [
      "const refusal = 'row 2: could not parse the date';",
      "const bank = 'Q1 Bank';",
      'const doc = `/** ROADMAP row 65 */`;',
      "const where = '.agents/tasks/054-x/decisions.md';",
      '// row 54',
      'const a = 1;',
      '/** see DEBT.md */',
      'const b = 2;',
    ]);
    expect(source.comments.map((c) => [c.line, c.text])).toEqual([
      [5, '// row 54'],
      [7, '/** see DEBT.md */'],
    ]);
    expect(planReferencesIn(source)).toEqual([
      'crafted.ts:5 says "row 54" - the plan is not in the tree a reader has; write the reason the reference stood for, or nothing',
    ]);
    expect(deadPathsIn(source)).toEqual([
      'crafted.ts:7 names DEBT.md, which .gitignore keeps out of the tree - it exists here and nowhere a reader is; state the rule and cite nothing',
    ]);

    const jsx = crafted('crafted.tsx', [
      "const label = 'row 2';",
      'export const x = <p>{/* row 54 */}{label}</p>;',
    ]);
    expect(jsx.comments.map((c) => [c.line, c.text])).toEqual([[2, '/* row 54 */']]);
    expect(planReferencesIn(jsx).map((r) => r.split(' - ')[0])).toEqual([
      'crafted.tsx:2 says "row 54"',
    ]);
  });

  it('reports a hit on the line of a docblock it sits on, not the line the block opens on', () => {
    const source = crafted('crafted.ts', [
      '/**',
      ' * The reason, stated.',
      ' * Then a pointer at row 54, and',
      ' * a citation of app.ts:12.',
      ' */',
      'const a = 1;',
    ]);
    expect(planReferencesIn(source).map((r) => r.split(' says')[0])).toEqual(['crafted.ts:3']);
    expect(coordinatesIn(source).map((r) => r.split(' cites')[0])).toEqual(['crafted.ts:4']);
  });

  it('denies a path only this machine can open inside a comment, and permits a published one', () => {
    const source = crafted('crafted.ts', [
      '/** see DEBT.md */',
      'const a = 1;',
      '// .agents/tasks/054-x/decisions.md',
      'const b = 2;',
      '/* backend/data/ */',
      'const c = 3;',
      '// .agents/README.md and backend/src/app.ts',
      'const d = 4;',
    ]);
    expect(deadPathsIn(source).map((r) => r.split(',')[0])).toEqual([
      'crafted.ts:1 names DEBT.md',
      'crafted.ts:3 names .agents/tasks/054-x/decisions.md',
      'crafted.ts:3 names .agents/tasks/054-x/',
      'crafted.ts:5 names backend/data/',
    ]);
  });

  it('refuses a line citation and a commit sha inside a comment, and not a file or a name', () => {
    const red = crafted('crafted.ts', ['// see app.ts:12', 'const a = 1;', '// since `cefb277`', 'const b = 2;']);
    expect(coordinatesIn(red).map((r) => r.split(' - ')[0])).toEqual([
      'crafted.ts:1 cites app.ts:12',
      'crafted.ts:3 names the commit cefb277',
    ]);
    const green = crafted('crafted.ts', ['// see app.ts', 'const a = 1;', '// the `abc` helper', 'const b = 2;']);
    expect(coordinatesIn(green)).toEqual([]);
  });
});
