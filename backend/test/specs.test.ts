import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * A SPEC.md sits beside the module it describes, so nothing imports it and nothing
 * typechecks it. What rots in one is a coordinate that has moved, a path somebody
 * renamed, a pointer to a file only this machine has, and a status a reader cannot
 * see - and prose that has rotted is read as settled.
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
const SPEC_DIRS = ['backend/src/db', 'backend/src/providers', 'backend/test', 'web/src'];

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
 * cannot see one - and `.agents/tasks/` is the pointer this whole file was raised
 * about.
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
        // matches a name at any depth, which is what carries *.pdf into backend/data/
        anchored: rooted || pattern.includes('/'),
        re: toRegex(pattern),
      };
    });

/**
 * git's model rather than substring containment: every prefix of the path, every
 * pattern in file order, last match wins, a `!` line un-ignores. Containment would
 * refuse `.agents/README.md`, which is published; matching only the full path would
 * permit `.agents/tasks/<id>/decisions.md`, which is not, because what excludes it is
 * the pattern hitting its parent directory.
 *
 * A file under an excluded directory cannot be re-included, so a level that comes out
 * ignored ends the walk.
 *
 * A trailing slash is how a caller says the last level is a directory - a directory
 * citation in a spec, and this file's own walk. Without it `backend/data/` is tested
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
 * SPEC_DIRS holds one direction and only one: a spec that was deleted. The other is a
 * spec that was written and not declared, which no clause here reads and which
 * therefore rots with the suite green. The walk skips what isIgnored denies rather
 * than a second skip list by hand - an unpublished spec is out of scope by the rule the
 * rest of this file already uses - and skips .git, which is not the tree git tracks.
 */
const findSpecs = (dir: string, prefix = ''): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') return [];
      return isIgnored(`${rel}/`, RULES) ? [] : findSpecs(path.join(dir, entry.name), rel);
    }
    return entry.name === 'SPEC.md' && !isIgnored(rel, RULES) ? [rel] : [];
  });

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
});
