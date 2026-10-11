import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { commentsOf, type Comment } from '../scripts/comment-tokens';

/**
 * A spec sits beside the module it describes, or at the root when it describes the
 * whole, and nothing imports it and nothing typechecks it. What rots in one is a
 * coordinate that has moved, a path somebody renamed, a pointer to a file only this
 * machine has, and a status a reader cannot see - and prose that has rotted is read as
 * settled. A comment in source is prose too, and the same four things rot in it, so
 * the clauses that can run over a comment run over every one the tree carries.
 *
 * The frontmatter is what the tool that indexes this tree reads a spec by, and it is
 * read here under a grammar of this file's own rather than a YAML parser: the tool
 * reads YAML whole, and every form it reads differently from this file - or drops in
 * silence - is a field filled in and then trusted. The grammar is the subset both read
 * one way, and everything outside it is refused by name.
 *
 * The unpublished set is DERIVED from .gitignore, never listed here. The rule is
 * "ignored by .gitignore" and never "is a root-level .md": AGENTS.md is a root-level
 * .md and is published, beside root-level notes that are not. A list maintained by
 * hand beside the thing it describes gets that backwards and still looks right.
 */
const ROOT = path.resolve(process.cwd(), '..');

/**
 * Literal, not a glob: a glob asserts nothing about a spec that was deleted, which is
 * the one edit this whole file is powerless against if it enumerates by looking. The
 * one at the root describes the whole and is the top of the tree the parents form.
 */
const SPEC_FILES = [
  'ARCHITECTURE.md',
  'backend/src/SPEC.md',
  'backend/src/db/SPEC.md',
  'backend/src/providers/SPEC.md',
  'backend/src/wire/SPEC.md',
  'backend/test/SPEC.md',
  'web/src/SPEC.md',
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

/**
 * The only keys a spec here may carry: a key outside the list is filled in, read by
 * nothing, and then trusted. A file is a spec to the tool that indexes this tree when
 * the block carries an id and a type.
 */
const FIELDS = ['id', 'type', 'status', 'title', 'parent', 'depends-on', 'references', 'implements'] as const;
type Field = (typeof FIELDS)[number];
const REQUIRED: readonly Field[] = ['id', 'type', 'status', 'title'];
const LIST_FIELDS: readonly Field[] = ['depends-on', 'references', 'implements'];
const LINK_LISTS: readonly Field[] = ['depends-on', 'references', 'implements'];
/**
 * The durable kinds. A task-spec is a working file the tool keeps under a directory
 * .gitignore keeps out of the tree.
 */
const TYPES = ['architecture-design', 'module-design', 'submodule-design'];
const ROOT_TYPE = 'architecture-design';
/** A new or edited spec is draft, and the flip is the owner's review. */
const STATUSES = ['draft', 'active'];

const abs = (p: string): string => path.resolve(ROOT, p);
const read = (p: string): string => fs.readFileSync(abs(p), 'utf8');

type Block = { lines: string[]; body: string; bodyLine: number };

/**
 * The tool's own reading of where the block is, in one function for the detector and
 * the grammar so the two cannot disagree: a fence is a line that trims to three dashes,
 * the first line has to be one, and the first later one closes.
 */
const splitFrontmatter = (text: string): Block | undefined => {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return undefined;
  const close = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  if (close < 0) return undefined;
  return { lines: lines.slice(1, close), body: lines.slice(close + 1).join('\n'), bodyLine: close + 2 };
};

/**
 * What makes a file a spec to the tool that indexes this tree: a fenced block carrying
 * an id and a type. Read off the lines rather than off a YAML parse, and read wide on
 * purpose - a line naming the key indented, quoted, spaced before its colon or with its
 * value on the line below is a candidate - so a spec written and not declared is found
 * here first and refused by the grammar by name second. Where this can still disagree
 * with the tool, the direction that stays open is a form YAML reads as an identity and
 * this pattern does not; the other, a candidate the tool would not read, costs a
 * refusal by name and never a silence.
 */
const IDENTITY = (key: string): RegExp => new RegExp(`^\\s*["']?${key}["']?\\s*:`);
const hasIdentity = (text: string): boolean => {
  const block = splitFrontmatter(text);
  return block !== undefined && ['id', 'type'].every((key) => block.lines.some((line) => IDENTITY(key).test(line)));
};

type Frontmatter = Partial<Record<Field, string | string[]>>;
type Parsed = { fm: Frontmatter; faults: string[] };

const isField = (key: string): key is Field => (FIELDS as readonly string[]).includes(key);
/** What YAML reads as something other than the text written: an indicator in front, a
 * mapping or a comment inside, a bare word, a figure or a special float it types for you.
 * A colon is a mapping before whitespace or at the end, a hash a comment after
 * whitespace - a tab and a line end count, not the space alone. */
const INDICATOR = /^[-?:,[\]{}#&*!|>'"%@`]/;
const MAPPING = /:(?:\s|$)/;
const COMMENT = /\s#/;
const TYPED_WORD = /^(?:true|false|null|~|yes|no|on|off)$/i;
const TYPED_NUMBER =
  /^[+-]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$|^0[xo][\da-fA-F_]+$|^[+-]?\.(?:inf|Inf|INF)$|^\.(?:nan|NaN|NAN)$/;

const scalarFault = (value: string): string | undefined => {
  if (value === '' || value !== value.trim()) return 'is empty or carries whitespace at an end - a value is written whole';
  if (INDICATOR.test(value) || /[[\]{}]/.test(value) || MAPPING.test(value) || COMMENT.test(value))
    return 'a colon before whitespace or at the end of a value is a mapping and a hash after whitespace is a comment to YAML, and a leading quote, bracket or indicator is a form this holder does not read; rephrase';
  if (TYPED_WORD.test(value) || TYPED_NUMBER.test(value))
    return 'is what YAML reads as a number, a boolean or a null and the spec tools then spell back as text or drop, or what a YAML 1.1 reader would - the spec tools read YAML 1.2, which leaves yes and no as the words written, and a reader on 1.1 does not; write a word';
  return undefined;
};

/**
 * The grammar: a key at column zero, a colon, one space, a value; a value is one
 * scalar or an inline list of them; each key once and from FIELDS; a list field is
 * written as a list and a scalar field as a scalar. A line outside it is named, never
 * skipped, because the tool skips a null and refuses a file whole on a duplicate key
 * or a stray indent, and both leave the index in silence.
 */
const parseFrontmatter = (file: string, block: Block): Parsed => {
  const fm: Frontmatter = {};
  const faults: string[] = [];
  block.lines.forEach((raw, i) => {
    const where = `${file}:${i + 2}`;
    const bare = /^([\w-]+):\s*$/.exec(raw);
    if (bare) {
      faults.push(
        `${where} writes ${bare[1]} with nothing after the colon - a block list below it or a null, and the spec tools read the first their own way and drop the second in silence; write it inline, [a, b], or delete the key`,
      );
      return;
    }
    const m = /^([\w-]+): (.*)$/.exec(raw);
    if (!m) {
      faults.push(
        `${where} reads "${raw}" - a frontmatter line is a key, a colon, one space and a value, and nothing else; anything else is YAML the spec tools read their own way or not at all`,
      );
      return;
    }
    const [, key, value] = m;
    if (!isField(key)) {
      faults.push(`${where} names ${key}, which nothing in this tree reads - a field nothing reads is filled in and then trusted`);
      return;
    }
    if (key in fm) {
      faults.push(`${where} names ${key} a second time - YAML refuses the file whole, and the spec drops out of the index in silence`);
      return;
    }
    const list = /^\[(.*)\]$/.exec(value);
    if (LIST_FIELDS.includes(key) && !list) {
      faults.push(`${where} writes ${key} as one value - the spec tools read a list of one there; write it inline, [a, b], so one written form is what both read`);
      return;
    }
    if (!LIST_FIELDS.includes(key) && list) {
      faults.push(`${where} writes ${key} as a list - the spec tools read no value there at all`);
      return;
    }
    if (list) {
      if (list[1] === '') {
        faults.push(`${where} writes ${key} as an empty list - a field with nothing in it is a field to delete`);
        return;
      }
      const items = list[1].split(', ');
      const bad = items.map((item) => (item.includes(',') ? 'an item carries a comma - items are parted by a comma and a space' : scalarFault(item))).find((f) => f !== undefined);
      if (bad) {
        faults.push(`${where} reads "${value}" for ${key} - ${bad}`);
        return;
      }
      fm[key] = items;
      return;
    }
    const bad = scalarFault(value);
    if (bad) {
      faults.push(`${where} reads "${value}" for ${key} - ${bad}`);
      return;
    }
    fm[key] = value;
  });
  return { fm, faults };
};

const parseSpec = (file: string, text: string): Parsed & { block: Block | undefined } => {
  const block = splitFrontmatter(text);
  if (block === undefined) {
    return {
      fm: {},
      block,
      faults: [
        `${file} does not open with a frontmatter block, a fence on the first line and a second to close it - the title and the status live there now, and a document without one is one the spec tools do not index and this holder does not read`,
      ],
    };
  }
  return { ...parseFrontmatter(file, block), block };
};

const scalarOf = (fm: Frontmatter, key: Field): string | undefined => {
  const value = fm[key];
  return typeof value === 'string' ? value : undefined;
};
const listOf = (fm: Frontmatter, key: Field): readonly string[] => {
  const value = fm[key];
  return Array.isArray(value) ? value : [];
};

const fieldFaults = (file: string, fm: Frontmatter): string[] => {
  const status = scalarOf(fm, 'status');
  const type = scalarOf(fm, 'type');
  return [
    ...REQUIRED.filter((key) => scalarOf(fm, key) === undefined).map(
      (key) => `${file} declares no ${key} - every spec here carries an id, a type, a status and a title`,
    ),
    ...(status !== undefined && !STATUSES.includes(status)
      ? [`${file} reads status "${status}" - the flip out of draft is the owner's review and there is no third value to hide it behind`]
      : []),
    ...(type !== undefined && !TYPES.includes(type)
      ? [
          `${file} reads type "${type}" - the durable types are the reading; a task-spec is a working file the spec tools keep in a directory .gitignore keeps out of the tree`,
        ]
      : []),
  ];
};

type Node = { file: string; fm: Frontmatter };

/** Pure over a list, so the crafted trees below run through the same function the tree does. */
const idFaults = (nodes: readonly Node[]): string[] => {
  const seen = new Map<string, string>();
  return nodes.flatMap(({ file, fm }) => {
    const id = scalarOf(fm, 'id');
    if (id === undefined) return [];
    const other = seen.get(id);
    if (other !== undefined) return [`${file} carries id "${id}", which ${other} carries too - an id names one document`];
    seen.set(id, file);
    return [];
  });
};

const parentFaults = (nodes: readonly Node[]): string[] => {
  const ids = new Set(nodes.map((n) => scalarOf(n.fm, 'id')));
  const byId = new Map(nodes.map((n) => [scalarOf(n.fm, 'id'), n]));
  const isRoot = (n: Node): boolean => scalarOf(n.fm, 'type') === ROOT_TYPE;
  const roots = nodes.filter(isRoot);
  const faults =
    roots.length === 1 ? [] : [`the tree has ${roots.length} roots: ${roots.map((r) => r.file).join(', ') || 'none'} - one root`];
  for (const n of nodes) {
    const parent = scalarOf(n.fm, 'parent');
    if (isRoot(n) && parent !== undefined) faults.push(`${n.file} declares a parent and is the root - the root hangs off nothing`);
    if (!isRoot(n) && parent === undefined) faults.push(`${n.file} declares no parent - every spec but the root hangs off one`);
    if (parent !== undefined && !ids.has(parent)) faults.push(`${n.file} hangs off "${parent}", which no declared spec carries - a branch in the air`);
  }
  // a cycle never reaches the root and never dangles, so neither line above sees it
  for (const n of nodes) {
    const chain = [n.file];
    const visited = new Set(chain);
    let cur: Node | undefined = n;
    while (cur !== undefined && !isRoot(cur)) {
      const parent = scalarOf(cur.fm, 'parent');
      cur = parent === undefined ? undefined : byId.get(parent);
      if (cur === undefined) break;
      if (visited.has(cur.file)) {
        faults.push(`${n.file}'s parent chain never reaches the root: ${[...chain, cur.file].join(' -> ')} - a cycle is a tree with no root`);
        break;
      }
      visited.add(cur.file);
      chain.push(cur.file);
    }
  }
  return faults;
};

const linkFaults = (nodes: readonly Node[]): string[] => {
  const ids = new Set(nodes.map((n) => scalarOf(n.fm, 'id')));
  return nodes.flatMap(({ file, fm }) =>
    LINK_LISTS.flatMap((kind) =>
      listOf(fm, kind)
        .filter((target) => !ids.has(target))
        .map(
          (target) =>
            `${file} ${kind} "${target}", which no declared spec carries - a link to nothing is what the tool's own validator reports and this holder refuses`,
        ),
    ),
  );
};

/** An H1 or a Status line in the body, however markdown lets either be dressed, is a
 * second copy of what the frontmatter holds; a setext underline is an H1 unread here. */
const bodyCopies = (file: string, block: Block): string[] =>
  block.body
    .split('\n')
    .flatMap((line, i) =>
      /^(?:\s{0,3}#[ \t]|\W*[Ss]tatus\s*:)/.test(line)
        ? [`${file}:${i + block.bodyLine} reads "${line}" - the title and the status live in the frontmatter, once; a heading or a Status line in the body is a second copy that drifts`]
        : [],
    );

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
 * invariant, review finding, question, settled item or memo finding by its letter and
 * number, and a lettered decision; a section; a zero-padded task id with an optional
 * stage letter. No boundary can be loosened to dodge a real hit, and a false positive
 * is one word to rephrase.
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
    String.raw`(?<!#)\b(?:D|I|R|Q|S|MD|M)-?\d+[a-e]?\b`,
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
 * refuse a published path that merely contains an ignored name; matching only the full
 * path would permit a decisions file two levels inside an ignored directory, which is
 * not published, because what excludes it is the pattern hitting its parent directory.
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
 * the same derivation - and skips .git, which is not the tree git tracks, node_modules
 * by name even if the rule that ignores it were to go, and a symlink, which a read
 * would follow to wherever it points.
 */
const findFiles = (dir: string, keep: (name: string) => boolean, prefix = ''): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) return [];
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') return [];
      return isIgnored(`${rel}/`, RULES) ? [] : findFiles(path.join(dir, entry.name), keep, rel);
    }
    return keep(entry.name) && !isIgnored(rel, RULES) ? [rel] : [];
  });

/**
 * SPEC_FILES holds one direction and only one: a spec that was deleted. The other is a
 * spec that was written and not declared, which no clause here reads and which
 * therefore rots with the suite green - and the tool that indexes this tree takes any
 * markdown file whose frontmatter carries an id and a type, wherever it sits and
 * whatever it is called, so that is what the walk looks for.
 */
const findSpecs = (dir: string): string[] =>
  findFiles(dir, (name) => name.endsWith('.md')).filter((file) => hasIdentity(read(file)));

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

const declared = SPEC_FILES.map((file) => ({ file, dir: path.posix.dirname(file) }));
const missing = declared.filter((s) => !fs.existsSync(abs(s.file))).map((s) => s.file);
const specs = declared
  .filter((s) => fs.existsSync(abs(s.file)))
  .map((s) => {
    const text = read(s.file);
    return { ...s, text, ...parseSpec(s.file, text) };
  });

describe('every spec this repository declares', () => {
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
      'a declared spec is not on disk - write it, or take its path out of SPEC_FILES in the same edit that deletes it',
    ).toEqual([]);
  });

  it('is the whole set of them, and no spec on disk is declared by nobody', () => {
    const found = findSpecs(ROOT).sort();
    const declaredFiles = declared.map((s) => s.file).sort();
    const undeclared = found.filter((f) => !declaredFiles.includes(f));
    expect(
      found,
      `SPEC_FILES and the tree disagree, undeclared: ${undeclared.join(', ') || 'none'} - a document whose frontmatter carries an id and a type is a spec to the tool that indexes this tree whether or not anything here declares it, and a spec no clause here reads reports success by being invisible`,
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

  it('opens with frontmatter this holder reads whole, and the spec tools read the same way', () => {
    expect(specs.flatMap((spec) => spec.faults)).toEqual([]);
  });

  it('declares an id, a type, a status and a title, and the type and the status are values this tree has a reading for', () => {
    expect(specs.flatMap((spec) => fieldFaults(spec.file, spec.fm))).toEqual([]);
  });

  it('carries an id no other spec carries', () => {
    expect(idFaults(specs)).toEqual([]);
  });

  it('hangs off one parent that is a declared spec, and the root hangs off nothing and is the only one', () => {
    expect(parentFaults(specs)).toEqual([]);
  });

  it('links, where it links at all, to a declared spec', () => {
    expect(linkFaults(specs)).toEqual([]);
  });

  it('states its title and its status once, in the frontmatter, and not again in the body', () => {
    expect(specs.flatMap((spec) => (spec.block === undefined ? [] : bodyCopies(spec.file, spec.block)))).toEqual([]);
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
      'CONTRIBUTING.md',
      '.github/ISSUE_TEMPLATE/bug.md',
      'backend/src/db/schema.ts',
    ].filter((p) => isIgnored(p, RULES));
    expect(denied, 'these are tracked and published').toEqual([]);
  });

  it('denies what only this machine can open', () => {
    const permitted = [
      ...KNOWN_UNPUBLISHED,
      '.agents/tasks/048-summary-per-account/decisions.md',
      '.claude/agents/reviewer.md',
      '.claude/settings.local.json',
      '.thinkrail/context/TASK-x.md',
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
    '---',
    'id: crafted',
    'type: module-design',
    'status: draft',
    'title: crafted',
    'parent: architecture',
    '---',
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

  const CANON = [
    '---',
    'id: module-x',
    'type: module-design',
    'status: draft',
    'title: x — what it is, and what it is not',
    'parent: architecture',
    'depends-on: [module-y, module-z]',
    '---',
    '',
    '## Responsibility',
    '',
  ].join('\n');

  it('reads the frontmatter this tree writes, and the same one under CRLF and a BOM', () => {
    for (const [label, text] of [
      ['LF', CANON],
      ['CRLF', CANON.replace(/\n/g, '\r\n')],
      ['BOM', `\uFEFF${CANON}`],
    ] as const) {
      expect(hasIdentity(text), label).toBe(true);
      const { fm, faults, block } = parseSpec('crafted.md', text);
      expect(faults, label).toEqual([]);
      expect(fm, label).toEqual({
        id: 'module-x',
        type: 'module-design',
        status: 'draft',
        title: 'x — what it is, and what it is not',
        parent: 'architecture',
        'depends-on': ['module-y', 'module-z'],
      });
      expect(block?.body.split('\n')[1], label).toBe('## Responsibility');
      expect(block?.bodyLine, label).toBe(9);
    }
  });

  const fenced = (lines: string[]): string => ['---', ...lines, '---', '', '## body', ''].join('\n');
  const HEAD = ['id: a', 'type: module-design', 'status: draft', 'title: t'];

  /**
   * One row per form the tool reads differently from this file or not at all, each run
   * on its own. The reason a row is here is the tool's own behaviour on it: a block
   * list is read, a null is dropped, a duplicate key or a stray indent refuses the file
   * whole, a bare word, a figure or a special float comes back typed, a hash after
   * whitespace is a comment, a colon before whitespace or at the end is a mapping, a
   * scalar in a list field is a list of one, and a key the
   * tool reads and nothing here does is filled in and then trusted.
   */
  const REFUSED: ReadonlyArray<readonly [string, string, string]> = [
    ['a block list', fenced([...HEAD, 'depends-on:', '  - x']), 'nothing after the colon'],
    ['a null', fenced([...HEAD, 'parent:']), 'nothing after the colon'],
    ['a nested map', fenced([...HEAD, 'depends-on:', '  b: c']), 'a frontmatter line is a key'],
    ['no space after the colon', fenced(['id:a', ...HEAD.slice(1)]), 'a frontmatter line is a key'],
    ['an indented key', fenced([' id: a', ...HEAD.slice(1)]), 'a frontmatter line is a key'],
    ['a blank line inside the block', fenced([...HEAD, '']), 'a frontmatter line is a key'],
    ['a key written twice', fenced([...HEAD, 'id: b']), 'a second time'],
    ['a key nothing reads', fenced([...HEAD, 'depends_on: [x]']), 'nothing in this tree reads'],
    ['a colon-space inside a value', fenced([...HEAD.slice(0, 3), 'title: foo: bar']), 'rephrase'],
    ['a space-hash inside a value', fenced([...HEAD.slice(0, 3), 'title: foo #bar']), 'rephrase'],
    ['a quoted value', fenced([...HEAD.slice(0, 3), 'title: "quoted"']), 'rephrase'],
    ['a figure', fenced([...HEAD.slice(0, 3), 'title: 2026']), 'write a word'],
    ['a bare word YAML types', fenced([...HEAD.slice(0, 2), 'status: True', 'title: t']), 'write a word'],
    ['a bare word a YAML 1.1 reader types', fenced([...HEAD.slice(0, 2), 'status: yes', 'title: t']), 'write a word'],
    ['an empty list', fenced([...HEAD, 'depends-on: []']), 'an empty list'],
    ['a list with no space after the comma', fenced([...HEAD, 'depends-on: [a,b]']), 'a comma'],
    ['a list field written as one value', fenced([...HEAD, 'depends-on: a']), 'as one value'],
    ['a scalar field written as a list', fenced([...HEAD.slice(0, 3), 'title: [t]']), 'as a list'],
    ['whitespace at the end of a value', fenced([...HEAD.slice(0, 3), 'title: t ']), 'at an end'],
    ['no closing fence', ['---', ...HEAD, '', '## body'].join('\n'), 'a fence on the first line'],
    ['a fence not on the first line', ['', ...fenced(HEAD).split('\n')].join('\n'), 'a fence on the first line'],
    ['a trailing colon', fenced([...HEAD.slice(0, 3), 'title: foo:']), 'rephrase'],
    ['a colon-tab inside a value', fenced([...HEAD.slice(0, 3), 'title: foo:\tbar']), 'rephrase'],
    ['a tab-hash inside a value', fenced([...HEAD.slice(0, 3), 'title: foo\t#bar']), 'rephrase'],
    ['a trailing colon inside a list item', fenced([...HEAD, 'depends-on: [a, b:]']), 'rephrase'],
    ['a special float', fenced([...HEAD.slice(0, 3), 'title: .inf']), 'write a word'],
    ['a field the spec tools read and nothing here does', fenced([...HEAD, 'tags: [a]']), 'nothing in this tree reads'],
  ];

  /**
   * The forms beside each refusal that both parsers read to the same text, so a
   * refusal cannot widen to the whole character: an interior colon or hash, and a
   * leading dot that spells a word rather than a float.
   */
  const ACCEPTED: ReadonlyArray<readonly [string, string]> = [
    ['an interior colon', fenced([...HEAD.slice(0, 3), 'title: http://x/y'])],
    ['a clock', fenced([...HEAD.slice(0, 3), 'title: 1:30'])],
    ['an interior hash', fenced([...HEAD.slice(0, 3), 'title: foo#bar'])],
    ['a leading dot that spells a word', fenced([...HEAD.slice(0, 3), 'title: .agents'])],
  ];

  it('refuses every frontmatter shape the spec tools read differently, or not at all', () => {
    expect(parseSpec('crafted.md', fenced(HEAD)).faults).toEqual([]);
    const refused = ACCEPTED.filter(([, text]) => parseSpec('crafted.md', text).faults.length > 0).map(
      ([label, text]) => `${label}: ${parseSpec('crafted.md', text).faults.join(' | ')}`,
    );
    expect(refused, 'a form both parsers read to the same text, refused for nothing').toEqual([]);
    const missed = REFUSED.filter(
      ([, text, fragment]) => !parseSpec('crafted.md', text).faults.some((f) => f.includes(fragment)),
    ).map(([label, text]) => `${label}: ${parseSpec('crafted.md', text).faults.join(' | ') || 'no fault at all'}`);
    expect(missed, 'a form the grammar has stopped refusing').toEqual([]);
  });

  it('tells a spec from a document that merely opens with frontmatter', () => {
    // a real frontmatter with keys of its own, read off disk: the issue templates
    expect(hasIdentity(read('.github/ISSUE_TEMPLATE/bug.md'))).toBe(false);
    expect(hasIdentity(fenced(HEAD))).toBe(true);
    for (const [label, text] of [
      ['an id alone', fenced(['id: a'])],
      ['a type alone', fenced(['type: module-design'])],
      ['an id after the closing fence', ['---', 'type: module-design', '---', 'id: a'].join('\n')],
      ['no fence at all', ['# a', '', 'id: a', 'type: module-design'].join('\n')],
    ] as const) {
      expect(hasIdentity(text), label).toBe(false);
    }
  });

  it('finds an identity however YAML lets one be written, and the grammar then refuses the form by name', () => {
    // each is a spec to the spec tools and outside the grammar: found by the walk
    // first, refused by name second, never passed over
    for (const [label, text, fragment] of [
      ['the whole block indented', fenced(HEAD.map((line) => ` ${line}`)), 'a frontmatter line is a key'],
      ['a space before the colon', fenced(['id : a', ...HEAD.slice(1)]), 'a frontmatter line is a key'],
      ['a key in double quotes', fenced(['"id": a', ...HEAD.slice(1)]), 'a frontmatter line is a key'],
      ['a key in single quotes', fenced(["'id': a", ...HEAD.slice(1)]), 'a frontmatter line is a key'],
      ['the value on the next line', fenced(['id:', '  a', ...HEAD.slice(1)]), 'nothing after the colon'],
    ] as const) {
      expect(hasIdentity(text), label).toBe(true);
      expect(parseSpec('crafted.md', text).faults.join(), label).toContain(fragment);
    }
    // what over-reading costs: a candidate the spec tools do not read, and the
    // grammar refuses it by name rather than the walk passing over it
    const nothing = fenced(['id:', ...HEAD.slice(1)]);
    expect(hasIdentity(nothing)).toBe(true);
    expect(parseSpec('crafted.md', nothing).faults.join()).toContain('nothing after the colon');
  });

  it('refuses a task-spec, a type it has no reading for, a third status and a missing field', () => {
    const full = { id: 'a', type: 'module-design', status: 'draft', title: 't' } as const;
    expect(fieldFaults('c.md', full)).toEqual([]);
    expect(fieldFaults('c.md', { ...full, type: 'task-spec' }).join()).toContain('working file');
    expect(fieldFaults('c.md', { ...full, type: 'banana' }).join()).toContain('reads type "banana"');
    expect(fieldFaults('c.md', { ...full, status: 'reviewed' }).join()).toContain('no third value');
    expect(fieldFaults('c.md', { id: 'a', type: 'module-design' })).toHaveLength(2);
  });

  const node = (file: string, fm: Frontmatter): Node => ({ file, fm });
  const root = node('root.md', { id: 'root', type: 'architecture-design', status: 'draft', title: 'r' });
  const under = (id: string, parent: string, more: Frontmatter = {}): Node =>
    node(`${id}.md`, { id, type: 'module-design', status: 'draft', title: id, parent, ...more });

  it('refuses a dangling parent, a second root, a root with a parent, a cycle and a dangling link', () => {
    const clean = [root, under('a', 'root'), under('b', 'a', { 'depends-on': ['a'] })];
    expect([...idFaults(clean), ...parentFaults(clean), ...linkFaults(clean)]).toEqual([]);

    const shapes: ReadonlyArray<readonly [string, readonly Node[], (n: readonly Node[]) => string[], string]> = [
      ['a dangling parent', [root, under('a', 'nope')], parentFaults, 'a branch in the air'],
      ['no parent', [root, node('a.md', { id: 'a', type: 'module-design' })], parentFaults, 'declares no parent'],
      ['a root with a parent', [node('root.md', { ...root.fm, parent: 'a' }), under('a', 'root')], parentFaults, 'is the root'],
      ['two roots', [root, node('root2.md', { ...root.fm, id: 'root2' })], parentFaults, 'roots:'],
      ['no root', [under('a', 'b'), under('b', 'a')], parentFaults, 'roots: none'],
      ['a cycle', [root, under('a', 'b'), under('b', 'a')], parentFaults, 'never reaches the root'],
      ['a dangling link', [root, under('a', 'root', { references: ['zz'] })], linkFaults, 'a link to nothing'],
      ['an id twice', [root, under('a', 'root'), node('a2.md', { ...under('a', 'root').fm })], idFaults, 'an id names one document'],
    ];
    const missed = shapes
      .filter(([, nodes, check, fragment]) => !check(nodes).some((f) => f.includes(fragment)))
      .map(([label, nodes, check]) => `${label}: ${check(nodes).join(' | ') || 'no fault at all'}`);
    expect(missed).toEqual([]);
  });

  it('finds a title or a status written again in the body', () => {
    const block = splitFrontmatter(
      [
        '---',
        ...HEAD,
        '---',
        '',
        '# a',
        '',
        'Status: draft',
        '',
        '#\ta',
        '',
        '   # a',
        '',
        '**Status:** draft',
        '',
        'Status : draft',
        '',
        ' Status: draft',
        '',
        'status: draft',
        '',
        '## body',
        '',
        'The status: draft',
        '',
      ].join('\n'),
    );
    expect(block && bodyCopies('c.md', block).map((f) => f.split(' - ')[0])).toEqual([
      'c.md:8 reads "# a"',
      'c.md:10 reads "Status: draft"',
      'c.md:12 reads "#\ta"',
      'c.md:14 reads "   # a"',
      'c.md:16 reads "**Status:** draft"',
      'c.md:18 reads "Status : draft"',
      'c.md:20 reads " Status: draft"',
      'c.md:22 reads "status: draft"',
    ]);
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
    'M6',
    "the memo's M3",
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
      '// .github/ISSUE_TEMPLATE/bug.md and backend/src/app.ts',
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
