/**
 * The instrument a comment-only claim is held by, and the census its figures are
 * quoted from.
 *
 *   npm --prefix /path/to/quietpurse/backend run check:comments -- compare --base origin/main backend/src
 *   npm --prefix /path/to/quietpurse/backend run check:comments -- compare --base 9e5f459 --head 8b184dd web/src
 *   npm --prefix /path/to/quietpurse/backend run check:comments -- count backend/src/*.ts
 *
 * Paths are relative to the repository root whichever package they are in, because
 * that is what `git show <rev>:<path>` takes and the tool reads both trees. Without
 * `--head` the work side is the working tree. Every walk, verdict and count lives in
 * comment-tokens.ts, which a test can import without any of this running.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { censusOf, compareSources, type Census, type Verdict } from './comment-tokens';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const SOURCE_SUFFIXES: readonly string[] = ['.ts', '.tsx'];

const USAGE =
  'usage: check:comments -- compare --base <rev> [--head <rev>] <path>...\n' +
  '       check:comments -- count [--head <rev>] <path>...\n' +
  'paths are relative to the repository root';

type Options = { verb: 'compare' | 'count'; base?: string; head?: string; roots: string[] };

function parseOptions(argv: string[]): Options {
  const verb = argv[0];
  if (verb !== 'compare' && verb !== 'count') throw new Error(USAGE);
  const roots: string[] = [];
  let base: string | undefined;
  let head: string | undefined;
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--base' || token === '--head') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${token} was given with no revision after it`);
      if (token === '--base') base = value;
      else head = value;
      i += 1;
      continue;
    }
    if (token.startsWith('-')) throw new Error(`${token} is not a flag this script takes.\n${USAGE}`);
    roots.push(token);
  }
  if (roots.length === 0) throw new Error(`no paths were given.\n${USAGE}`);
  if (verb === 'compare' && base === undefined) {
    throw new Error(`compare needs --base <rev>: there is no default base side.\n${USAGE}`);
  }
  if (verb === 'count' && base !== undefined) throw new Error('count takes --head, never --base');
  return { verb, base, head, roots };
}

/** stderr piped rather than inherited: a file absent from a rev is reported as ADDED, not as git's fatal. */
const git = (args: string[]): string =>
  execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/**
 * Resolved once, ahead of every file: a typo in --base otherwise reports every file
 * as absent on the base side and reads like a catastrophic diff rather than a typo.
 */
function assertRevision(flag: string, rev: string): void {
  try {
    git(['rev-parse', '--verify', `${rev}^{commit}`]);
  } catch {
    throw new Error(`${flag} ${rev} is not a commit this checkout can resolve`);
  }
}

const isSource = (file: string): boolean => SOURCE_SUFFIXES.some((s) => file.endsWith(s));

function walkWorkingTree(root: string): string[] {
  const absolute = path.resolve(REPO_ROOT, root);
  if (!fs.existsSync(absolute)) throw new Error(`${root} does not exist in the working tree`);
  const found: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (isSource(entry.name)) found.push(path.relative(REPO_ROOT, child));
    }
  };
  if (fs.statSync(absolute).isDirectory()) visit(absolute);
  else if (isSource(absolute)) found.push(path.relative(REPO_ROOT, absolute));
  return found;
}

const listAtRevision = (rev: string, roots: string[]): string[] =>
  git(['ls-tree', '-r', '--name-only', rev, '--', ...roots])
    .split('\n')
    .filter(isSource);

const listFiles = (rev: string | undefined, roots: string[]): string[] =>
  rev === undefined ? roots.flatMap(walkWorkingTree) : listAtRevision(rev, roots);

/** `undefined` is a file absent from that side, which is a finding and not an error. */
function readAt(rev: string | undefined, file: string): string | undefined {
  if (rev === undefined) {
    const absolute = path.resolve(REPO_ROOT, file);
    return fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : undefined;
  }
  try {
    return git(['show', `${rev}:${file}`]);
  } catch {
    return undefined;
  }
}

const toPosix = (file: string): string => file.split(path.sep).join('/');

function compare(options: Options): number {
  assertRevision('--base', options.base as string);
  if (options.head !== undefined) assertRevision('--head', options.head);
  const files = [
    ...new Set([
      ...listFiles(options.head, options.roots).map(toPosix),
      ...listFiles(options.base, options.roots).map(toPosix),
    ]),
  ].sort();
  let identical = 0;
  let tokens = 0;
  let findings = 0;
  for (const file of files) {
    const base = readAt(options.base, file);
    const work = readAt(options.head, file);
    if (base === undefined || work === undefined) {
      console.log(`${base === undefined ? 'ADDED    ' : 'REMOVED  '} ${file}`);
      findings += 1;
      continue;
    }
    let verdict: Verdict;
    try {
      verdict = compareSources(file, base, work);
    } catch (e) {
      console.log(`UNPARSED  ${file}  ${e instanceof Error ? e.message : String(e)}`);
      findings += 1;
      continue;
    }
    if (verdict.same) {
      identical += 1;
      tokens += verdict.count;
      console.log(`IDENTICAL ${file}  ${verdict.count} tokens`);
      continue;
    }
    findings += 1;
    console.log(
      `DIFFERENT ${file}  at ${verdict.index}: ${JSON.stringify(verdict.base)} vs ${JSON.stringify(verdict.work)}`,
    );
  }
  console.log(
    `\n${files.length} file(s): ${identical} IDENTICAL, ${findings} not — ${tokens} leaf tokens across the identical ones`,
  );
  console.log(`base ${options.base}   work ${options.head ?? 'working tree'}`);
  return findings === 0 ? 0 : 1;
}

const share = (c: Census): string =>
  c.nonBlank === 0 ? '0.0%' : `${((c.commentLines / c.nonBlank) * 100).toFixed(1)}%`;

function count(options: Options): number {
  if (options.head !== undefined) assertRevision('--head', options.head);
  const files = [...new Set(listFiles(options.head, options.roots).map(toPosix))].sort();
  const total: Census = { commentLines: 0, nonBlank: 0, blocks: 0 };
  let findings = 0;
  for (const file of files) {
    const text = readAt(options.head, file);
    if (text === undefined) {
      console.log(`UNREAD    ${file}`);
      findings += 1;
      continue;
    }
    let census: Census;
    try {
      census = censusOf(file, text);
    } catch (e) {
      console.log(`UNPARSED  ${file}  ${e instanceof Error ? e.message : String(e)}`);
      findings += 1;
      continue;
    }
    total.commentLines += census.commentLines;
    total.nonBlank += census.nonBlank;
    total.blocks += census.blocks;
    console.log(
      `${String(census.commentLines).padStart(6)} ${String(census.nonBlank).padStart(6)} ${share(census).padStart(6)} ${String(census.blocks).padStart(5)}  ${file}`,
    );
  }
  console.log(
    `\n${files.length} file(s): ${total.commentLines} comment lines / ${total.nonBlank} non-blank / ${share(total)} / ${total.blocks} blocks`,
  );
  console.log(`read from ${options.head ?? 'the working tree'}`);
  return findings === 0 ? 0 : 1;
}

function main(): number {
  const options = parseOptions(process.argv.slice(2));
  return options.verb === 'compare' ? compare(options) : count(options);
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (e) {
    console.error(`check:comments failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
