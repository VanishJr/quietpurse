/**
 * Every refusal the check stack makes, as pure functions over strings and numbers.
 * Separate from check-stack.ts because a test that imports the entry point spawns
 * servers and drops databases to reach one predicate: nothing here may run at
 * import time or reach a module but `node:path`, and check-stack.test.ts holds both.
 */
import path from 'node:path';

/**
 * Ports the owner's stack is on or drifts onto: a Vite without `--strictPort`
 * walks up from a busy 5173, and a check on one of these clicks the owner's app.
 */
export const RESERVED_PORTS: readonly number[] = [4000, 5173, 5174, 5175];

/** Here rather than in check-stack.ts so the case keeping them off the reserved set reads them. */
export const DEFAULT_API_PORT = 4300;
export const DEFAULT_APP_PORT = 5473;

export function assertCheckPort(role: 'api' | 'app', port: number): number {
  if (!Number.isInteger(port) || port < 1024 || port > 49151) {
    throw new Error(
      `--${role}-port ${port} is not a usable port: give a whole number between 1024 and 49151 ` +
        `(above that is Windows' ephemeral range, which the OS hands out on its own)`,
    );
  }
  if (RESERVED_PORTS.includes(port)) {
    throw new Error(
      `--${role}-port ${port} is one the owner's stack uses or drifts onto ` +
        `(${RESERVED_PORTS.join(', ')}) - the check stack exists to stay off those`,
    );
  }
  return port;
}

export type Options = { apiPort: number; appPort: number; importFile?: string };

const OPTION_FLAGS: readonly string[] = ['--api-port', '--app-port', '--import'];

const unknownToken = (token: string): string =>
  token.startsWith('--') && token.includes('=')
    ? `${token} is not a flag this script takes: a value goes after a space, never after an "=" ` +
      `(--import C:\\Dev\\Finto\\backend\\data\\statement.pdf). The flags are ${OPTION_FLAGS.join(', ')}.`
    : `${token} is not a flag this script takes. The flags are ${OPTION_FLAGS.join(', ')}, each ` +
      `followed by its value.`;

/**
 * A refusal rather than a shrug at every token it does not recognise: an indexOf
 * lookup drops `--import=<path>` in silence, and `up` then reports ready over an
 * empty database with one missing summary line as the only tell.
 */
export function parseOptions(argv: string[]): Options {
  const values = new Map<string, string>();
  const tokens = argv.slice(1);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!OPTION_FLAGS.includes(token)) throw new Error(unknownToken(token));
    const value = tokens[i + 1];
    if (value === undefined) {
      throw new Error(`${token} was given with no value after it, so it would have been ignored`);
    }
    values.set(token, value);
    i += 1;
  }
  const port = (flag: string, fallback: number): number => {
    const raw = values.get(flag);
    return raw === undefined ? fallback : Number(raw);
  };
  return {
    apiPort: port('--api-port', DEFAULT_API_PORT),
    appPort: port('--app-port', DEFAULT_APP_PORT),
    importFile: values.get('--import'),
  };
}

export function assertNoOptions(verb: string, argv: string[]): void {
  const extra = argv.slice(1);
  if (extra.length === 0) return;
  throw new Error(
    `${verb} takes no options, so ${extra.join(' ')} would have been ignored. ` +
      `${OPTION_FLAGS.join(', ')} are read by \`up\` alone.`,
  );
}

/**
 * The marker every child carries in its own command line, in argv rather than the
 * environment: nothing on this platform reads another process's environment back,
 * so a marker there cannot be compared by the process deciding whether to kill it.
 */
export const markerFor = (runId: string): string => `finto-check-${runId}`;

const markerArgs = (marker: string): string[] => ['--', '--finto-check-run', marker];

/**
 * tsx is two processes and the server runs in the grandchild; the arguments after
 * the entry reach both, so either is identifiable from its command line alone.
 */
export function backendArgv(o: { tsxCli: string; entry: string; marker: string }): string[] {
  return [o.tsxCli, o.entry, ...markerArgs(o.marker)];
}

/**
 * The backend child's environment, and every override in it is there because
 * something in the parent's would otherwise decide where the check writes.
 *
 * FINTO_HOME alone is NOT enough, which is what this exists to correct: the
 * statements folder is `DOCUMENT_STORE_PATH || FINTO_HOME/statements`, so an owner
 * who set that variable in their shell or in backend/.env had the check upload its
 * fixtures into their real folder, beside their own bank statements. The child
 * inherits the parent's whole environment, and backend/.env is read by the child on
 * top of it, so the only way to be sure is to blank the two that can redirect it.
 *
 * Blank rather than deleted, because deleting is not enough: `dotenv` fills in a key
 * that is ABSENT from process.env and leaves a key that is present alone, so an
 * empty string is what keeps backend/.env out. config.ts reads both with `||`, and
 * an empty string is falsy there - the same mechanism DATABASE_URL already used.
 */
export function backendEnv(o: { home: string; apiPort: number }): NodeJS.ProcessEnv {
  return {
    PORT: String(o.apiPort),
    FINTO_HOME: o.home,
    DATABASE_URL: '',
    DOCUMENT_STORE_PATH: '',
  };
}

/**
 * `--strictPort` makes a busy port a failure instead of a drift onto the next one.
 * Vite refuses an unrecognised flag, which is why the marker goes after `--`.
 */
export function webArgv(o: {
  viteBin: string;
  port: number;
  host: string;
  marker: string;
}): string[] {
  return [
    o.viteBin,
    '--port',
    String(o.port),
    '--strictPort',
    '--host',
    o.host,
    ...markerArgs(o.marker),
  ];
}

export type ChildKind = 'backend' | 'web';

export type ChildRecord = {
  kind: ChildKind;
  pid: number;
  port: number;
  /** as the OS reported it at `up`, not as it was spawned - the two differ in quoting */
  commandLine: string;
  creationDate: string;
  logPath: string;
};

export type Observed = { pid: number; commandLine: string; creationDate: string };

export type KillVerdict =
  | { kill: true }
  | { kill: false; reason: 'gone' }
  | { kill: false; reason: 'not-ours'; detail: string };

/**
 * A verdict rather than a boolean: a caller that treats "already dead" and "that
 * pid belongs to somebody else now" alike turns a stale manifest into a silent
 * success one way and into the taskkill incident the other. Identity is the whole
 * triple, so a child recorded before its identity read matches nothing live.
 */
export function shouldKill(recorded: ChildRecord, observed: Observed | undefined): KillVerdict {
  if (!observed) return { kill: false, reason: 'gone' };
  const mismatch: string[] = [];
  if (observed.pid !== recorded.pid) {
    mismatch.push(`pid ${observed.pid}, recorded ${recorded.pid}`);
  }
  if (observed.creationDate !== recorded.creationDate) {
    mismatch.push(`started ${observed.creationDate || '(unknown)'}, recorded ${recorded.creationDate || '(never captured)'}`);
  }
  if (observed.commandLine !== recorded.commandLine) {
    mismatch.push(
      `command line ${JSON.stringify(observed.commandLine)}, recorded ${JSON.stringify(recorded.commandLine)}`,
    );
  }
  if (mismatch.length > 0) return { kill: false, reason: 'not-ours', detail: mismatch.join('; ') };
  return { kill: true };
}

export type KillOutcome = 'stopped' | 'alreadyDead' | 'failed';

/**
 * `taskkill` exits 128 both for a pid that was already gone and for one it was
 * refused, and the stderr that tells the two apart is written in whatever language
 * the machine is in - so what discriminates them is a second look at the pid.
 * Reading that exit as `alreadyDead` is a teardown reporting success over a
 * process it could not stop; reading it as `failed` blocks the next `up` over a
 * child that in fact exited on its own.
 */
export function killOutcome(o: { killed: boolean; stillObserved: boolean }): KillOutcome {
  if (o.killed) return 'stopped';
  return o.stillObserved ? 'failed' : 'alreadyDead';
}

/**
 * The lower-casing is not cosmetic: `C:\dev\finto` and `C:\Dev\Finto` are one
 * directory here, so a raw compare is a guard a differently-cased path walks past.
 */
function comparable(p: string): string {
  return path
    .resolve(p)
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

const isAtOrInside = (child: string, parent: string): boolean => {
  const c = comparable(child);
  const p = comparable(parent);
  return c === p || c.startsWith(`${p}/`);
};

/**
 * Nothing this script writes may land in the repository. `.gitignore` blankets
 * `*.log`, `*.csv` and `*.pdf` repository-wide, so a log written inside the tree
 * would not show in `git status` either. The home folder is checked on its own even
 * though it sits inside the run directory today: the day one moves, the other check
 * still stands.
 */
export function assertRunPaths(o: { repoRoot: string; runDir: string; home: string }): void {
  const ownerDocuments = path.join(o.repoRoot, 'backend', 'data');
  const places: [string, string][] = [
    ['run directory', o.runDir],
    ['home folder', o.home],
  ];
  for (const [what, p] of places) {
    if (isAtOrInside(p, ownerDocuments)) {
      throw new Error(
        `the check stack's ${what} resolves to ${p}, at or inside the owner's document store ` +
          `(${ownerDocuments}) - a check must not write among the statements this repository ships`,
      );
    }
    if (isAtOrInside(p, o.repoRoot)) {
      throw new Error(
        `the check stack's ${what} resolves to ${p}, inside the repository (${o.repoRoot}) - ` +
          `everything it writes would land in the diff, and .gitignore hides logs from git status`,
      );
    }
  }
}

export type Observation = { record: ChildRecord; verdict: KillVerdict };

export type ReuseVerdict = { ok: true } | { ok: false; blocking: Observation[] };

/** Takes verdicts, not a filtered list: filtering is where `not-ours` collapses into "dead". */
export function reuseVerdict(observations: readonly Observation[]): ReuseVerdict {
  const blocking = observations.filter((o) => o.verdict.kill || o.verdict.reason === 'not-ours');
  return blocking.length === 0 ? { ok: true } : { ok: false, blocking };
}

export const NOTHING_TO_TEAR_DOWN = 'there was nothing to tear down: no check stack is recorded';

/**
 * "Nothing was there" and "none of what was there was mine" are different results,
 * and one sentence for both is a green report that should have been red - the shape
 * of a comparison saying "no change" without saying what it compared.
 */
export function teardownSentence(n: {
  killed: number;
  alreadyDead: number;
  notOurs: number;
  failed: number;
}): string {
  const recorded = n.killed + n.alreadyDead + n.notOurs + n.failed;
  if (recorded === 0) return 'no processes were recorded, so none were stopped';
  const parts = [`${n.killed} stopped`, `${n.alreadyDead} already dead`];
  if (n.notOurs > 0) parts.push(`${n.notOurs} left alone as NOT OURS`);
  if (n.failed > 0) parts.push(`${n.failed} could not be stopped`);
  return `of ${recorded} recorded process(es): ${parts.join(', ')}`;
}

/**
 * Whether a teardown finished. What is kept, what is printed about it and the exit
 * code must agree; they drifted apart once.
 */
export function teardownIncomplete(n: {
  notOurs: number;
  failed: number;
  busyPorts: number;
}): boolean {
  return n.notOurs > 0 || n.failed > 0 || n.busyPorts > 0;
}
