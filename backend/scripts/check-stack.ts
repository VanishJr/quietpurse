/**
 * A throwaway Finto stack for a manual check: its own home folder (database and
 * statements), its own ports, and a teardown that stops only what it started.
 *
 *   npm --prefix C:\Dev\Finto\backend run check:stack -- up
 *   npm --prefix C:\Dev\Finto\backend run check:stack -- up --import <absolute file>
 *   npm --prefix C:\Dev\Finto\backend run check:stack -- status
 *   npm --prefix C:\Dev\Finto\backend run check:stack -- down
 *
 * `up` returns once both servers answer, so the caller gets its shell back and the
 * children outlive the invocation. Options: --api-port, --app-port, --import.
 *
 * The owner's `npm run dev` and the ~/Finto folder it runs on are out of reach by
 * construction, not by care: every path goes through assertRunPaths and every kill
 * through shouldKill. Those live in check-stack-guards.ts, which a test can import
 * without any of this running. `.agents/concepts/check-stack.md` is the mechanism
 * written out.
 */
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../src/config';
import {
  assertCheckPort,
  assertNoOptions,
  assertRunPaths,
  backendEnv,
  backendArgv,
  killOutcome,
  markerFor,
  NOTHING_TO_TEAR_DOWN,
  parseOptions,
  reuseVerdict,
  RESERVED_PORTS,
  shouldKill,
  teardownIncomplete,
  teardownSentence,
  webArgv,
  type ChildKind,
  type ChildRecord,
  type KillOutcome,
  type Observation,
  type Observed,
  type Options,
} from './check-stack-guards';

const run = promisify(execFile);

const BACKEND_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(BACKEND_DIR, '..');
const WEB_DIR = path.join(REPO_ROOT, 'web');
const TSX_CLI = path.join(BACKEND_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const VITE_BIN = path.join(WEB_DIR, 'node_modules', 'vite', 'bin', 'vite.js');

/** Outside the repository, held by assertRunPaths rather than by this constant. */
const STACK_ROOT = path.join(os.tmpdir(), 'finto-check');
const MANIFEST_PATH = path.join(STACK_ROOT, 'manifest.json');

/** A host the owner's dev app is not served on, so the two are not one origin in a browser's history. */
const HOST = 'localhost';

const READY_TIMEOUT_MS = 90_000;

type Manifest = {
  version: 1;
  runId: string;
  marker: string;
  startedAt: string;
  repoRoot: string;
  runDir: string;
  /** The run's FINTO_HOME: its database and its statements, nothing of the owner's. */
  home: string;
  chromeProfileDir: string;
  appUrl: string;
  apiUrl: string;
  children: ChildRecord[];
};

// ---------- observation ----------

/**
 * A refusal rather than a fallback: identity comes from Win32_Process and the kill
 * is taskkill /T, and a guess at the POSIX equivalents would be the one part of
 * this script nobody has ever run.
 */
function assertSupportedPlatform(): void {
  if (process.platform === 'win32') return;
  throw new Error(
    `check-stack has only ever run on Windows and this is ${process.platform}: process identity ` +
      `comes from Win32_Process and the kill is taskkill /T. Port both before running it here.`,
  );
}

const CIM_QUERY =
  'Get-CimInstance Win32_Process | ForEach-Object { [PSCustomObject]@{ ' +
  'ProcessId = $_.ProcessId; ' +
  "CreationDate = $(if ($_.CreationDate) { $_.CreationDate.ToString('o') } else { '' }); " +
  "CommandLine = $(if ($_.CommandLine) { $_.CommandLine } else { '' }) } } | " +
  'ConvertTo-Json -Compress -Depth 2';

/**
 * Every process on the machine, by pid, in one query; the kill that follows is by
 * recorded pid alone. A filter over `node.exe` would be harmless to read and is
 * the taskkill incident to kill by, so this file never builds one at all.
 */
async function observeAll(): Promise<Map<number, Observed>> {
  const { stdout } = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', CIM_QUERY],
    { maxBuffer: 64 * 1024 * 1024, windowsHide: true },
  );
  const raw = JSON.parse(stdout) as
    | { ProcessId: number; CreationDate: string; CommandLine: string }[]
    | { ProcessId: number; CreationDate: string; CommandLine: string };
  const rows = Array.isArray(raw) ? raw : [raw];
  const byPid = new Map<number, Observed>();
  for (const r of rows) {
    byPid.set(r.ProcessId, {
      pid: r.ProcessId,
      creationDate: r.CreationDate ?? '',
      commandLine: r.CommandLine ?? '',
    });
  }
  return byPid;
}

const observeChildren = (children: ChildRecord[], live: Map<number, Observed>): Observation[] =>
  children.map((record) => ({ record, verdict: shouldKill(record, live.get(record.pid)) }));

async function killTree(pid: number): Promise<KillOutcome> {
  try {
    await run('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    return killOutcome({ killed: true, stillObserved: false });
  } catch (e) {
    // the pid is observed again rather than the exit code read: a child that exits
    // between the identity snapshot above and this kill is not a failed teardown
    const stillObserved = (await observeAll()).has(pid);
    const outcome = killOutcome({ killed: false, stillObserved });
    if (outcome === 'failed') {
      console.error(`  taskkill on pid ${pid} failed and it is still there: ${(e as Error).message}`);
    }
    return outcome;
  }
}

// ---------- ports ----------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Anything answering on the port, on either loopback family. */
async function listening(port: number): Promise<boolean> {
  const probe = (host: string): Promise<boolean> =>
    new Promise((resolve) => {
      const socket = net.connect({ host, port });
      const done = (answer: boolean): void => {
        socket.destroy();
        resolve(answer);
      };
      socket.setTimeout(500);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
    });
  return (await probe('127.0.0.1')) || (await probe('::1'));
}

/**
 * taskkill returns before Windows has released the listening socket, so probing
 * the port on the next line reports a stack that is gone as one still up - which
 * is what this script's own first teardown printed about 5473, on a port that was
 * free by the time the shell came back.
 */
async function portFreed(port: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await listening(port))) return true;
    await sleep(250);
  }
  return false;
}

// ---------- manifest ----------

function readManifest(): Manifest | undefined {
  if (!fs.existsSync(MANIFEST_PATH)) return undefined;
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;
}

function writeManifest(m: Manifest): void {
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(m, null, 2)}\n`);
}

// ---------- teardown ----------

type TeardownReport = {
  killed: number;
  alreadyDead: number;
  failed: number;
  notOurs: { record: ChildRecord; detail: string }[];
  runDir: 'removed' | 'absent' | 'kept as evidence';
  runDirPath: string;
  busyPorts: number[];
};

/** A Record so a fourth outcome is a typecheck failure rather than one nothing counts. */
const COUNTED_AS: Record<KillOutcome, 'killed' | 'alreadyDead' | 'failed'> = {
  stopped: 'killed',
  alreadyDead: 'alreadyDead',
  failed: 'failed',
};

const incomplete = (report: TeardownReport): boolean =>
  teardownIncomplete({
    notOurs: report.notOurs.length,
    failed: report.failed,
    busyPorts: report.busyPorts.length,
  });

async function teardown(m: Manifest): Promise<TeardownReport> {
  const live = await observeAll();
  const observations = observeChildren(m.children, live);
  const report: TeardownReport = {
    killed: 0,
    alreadyDead: 0,
    failed: 0,
    notOurs: [],
    runDir: 'absent',
    runDirPath: m.runDir,
    busyPorts: [],
  };
  for (const { record, verdict } of observations) {
    if (verdict.kill) {
      report[COUNTED_AS[await killTree(record.pid)]] += 1;
    } else if (verdict.reason === 'gone') {
      report.alreadyDead += 1;
    } else {
      report.notOurs.push({ record, detail: verdict.detail });
    }
  }
  for (const child of m.children) {
    if (!(await portFreed(child.port))) report.busyPorts.push(child.port);
  }
  assertRunPaths({ repoRoot: m.repoRoot, runDir: m.runDir, home: m.home, ownerHome: config.home });
  // a teardown that did not finish - a process left alone as NOT OURS, a kill that
  // failed, a port still held afterwards - is the one outcome that leaves evidence
  // worth reading, and removing the manifest is what would make the next `down` say
  // "nothing was recorded" one command after this one said otherwise
  if (incomplete(report)) {
    report.runDir = fs.existsSync(m.runDir) ? 'kept as evidence' : 'absent';
    return report;
  }
  if (fs.existsSync(m.runDir)) {
    fs.rmSync(m.runDir, { recursive: true, force: true });
    report.runDir = 'removed';
  }
  fs.rmSync(MANIFEST_PATH, { force: true });
  return report;
}

function printTeardown(report: TeardownReport): void {
  console.log(teardownSentence({ ...report, notOurs: report.notOurs.length }));
  console.log(`  run directory: ${report.runDir}`);
  for (const { record, detail } of report.notOurs) {
    console.error(
      `  NOT OURS: the ${record.kind} pid ${record.pid} is a different process now and was left ` +
        `alone - ${detail}`,
    );
  }
  for (const port of report.busyPorts) {
    console.error(`  STILL BUSY: something is listening on ${port} after the teardown`);
  }
  // by cause: a busy port is held by something the manifest does not account for,
  // so it is repaired by stopping that and running the verb again - where a process
  // this run could not stop is repaired by nobody
  const unaccounted = report.notOurs.length > 0 || report.failed > 0;
  if (report.busyPorts.length > 0 && !unaccounted) {
    console.error(
      `  every process this run recorded is accounted for, so what holds ` +
        `${report.busyPorts.join(' and ')} was not started by it: stop that and run \`down\` again ` +
        `to finish the teardown. The manifest (${MANIFEST_PATH}) and the run directory ` +
        `(${report.runDirPath}) were kept meanwhile.`,
    );
  }
  if (unaccounted) {
    console.error(
      `  the teardown did not finish, so the manifest (${MANIFEST_PATH}) and the run directory ` +
        `(${report.runDirPath}) were kept: they are the only record of what was left running, and ` +
        `the logs beside them are the only account of what it was doing - read them, then delete ` +
        `both by hand.`,
    );
  }
}

// ---------- readiness ----------

async function apiHealthy(apiUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${apiUrl}/api/health`);
    if (res.status !== 200) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}

async function appServed(appUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${appUrl}/`);
    if (res.status !== 200) return false;
    return (await res.text()).includes('<div id="root">');
  } catch {
    return false;
  }
}

/**
 * Both halves answering, never a line in a log: a server that printed its banner
 * and then failed to bind writes the same line as one that came up.
 */
async function waitReady(apiUrl: string, appUrl: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let api = false;
  let app = false;
  while (Date.now() < deadline) {
    if (!api) api = await apiHealthy(apiUrl);
    if (!app) app = await appServed(appUrl);
    if (api && app) return;
    await sleep(250);
  }
  throw new Error(
    `nothing was ready inside ${READY_TIMEOUT_MS / 1000}s: api ${api ? 'ok' : 'silent'}, ` +
      `app ${app ? 'ok' : 'silent'}`,
  );
}

function printLogTail(label: string, file: string, lines = 40): void {
  console.error(`--- ${label} (${file}) ---`);
  if (!fs.existsSync(file)) {
    console.error('(no log file)');
    return;
  }
  const all = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  console.error(all.slice(-lines).join('\n'));
}

// ---------- the API calls up makes ----------

const call = (apiUrl: string, route: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`${apiUrl}${route}`, init);

async function importStatement(apiUrl: string, file: string): Promise<number> {
  if (!path.isAbsolute(file)) throw new Error(`--import needs an absolute path, got ${file}`);
  const bytes = fs.readFileSync(file);

  const accountRes = await call(apiUrl, '/api/accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Check account' }),
  });
  if (accountRes.status !== 201) {
    throw new Error(`could not create the account (${accountRes.status}): ${await accountRes.text()}`);
  }
  const account = (await accountRes.json()) as { id: string };

  const form = new FormData();
  form.append('accountId', account.id);
  form.append('file', new Blob([new Uint8Array(bytes)]), path.basename(file));
  const stageRes = await call(apiUrl, '/api/imports', { method: 'POST', body: form });
  if (!stageRes.ok) throw new Error(`upload refused (${stageRes.status}): ${await stageRes.text()}`);
  const staged = (await stageRes.json()) as
    | { outcome: 'duplicate'; importId: string }
    | { outcome: 'awaiting_confirmation'; summary: { importId: string } };
  if (staged.outcome === 'duplicate') {
    throw new Error(`the server answered "duplicate" on a home folder it created a minute ago`);
  }

  const confirmRes = await call(apiUrl, `/api/imports/${staged.summary.importId}/confirm`, {
    method: 'POST',
  });
  if (!confirmRes.ok) throw new Error(`confirm refused (${confirmRes.status}): ${await confirmRes.text()}`);
  const confirmed = (await confirmRes.json()) as { inserted: number; skipped: number; total: number };
  if (confirmed.inserted === 0) {
    throw new Error(
      `--import committed 0 rows of ${confirmed.total} (${confirmed.skipped} skipped), so the ` +
        `stack is ready with nothing in it and every check run against it would pass on no data`,
    );
  }
  return confirmed.inserted;
}

// ---------- verbs ----------

/**
 * Incident 3: a save under the owner's `tsx watch` restarts their server, and
 * startup recomputes every category whose rules signature moved. Warning rather
 * than refusing, because the machine the owner is working on is where most checks
 * are run - and repeated by `status`, because a warning printed once at `up` is out
 * of the scrollback by the time the check happens.
 */
async function warnAboutOwnerStack(): Promise<void> {
  const answering: number[] = [];
  for (const port of RESERVED_PORTS) {
    if (await listening(port)) answering.push(port);
  }
  if (answering.length === 0) return;
  console.warn(
    `\nWARNING: the owner's stack is answering on ${answering.join(', ')}. This script never touches it, ` +
      `but editing a file under backend/src while their \`npm run dev\` watches it restarts their ` +
      `server, and startup re-tags every transaction whose rules signature moved.`,
  );
}

async function up(options: Options): Promise<void> {
  const existing = readManifest();
  if (existing) {
    const observations = observeChildren(existing.children, await observeAll());
    const verdict = reuseVerdict(observations);
    if (!verdict.ok) {
      for (const o of verdict.blocking) {
        const why = o.verdict.kill ? 'still alive' : 'NOT OURS';
        console.error(`  ${o.record.kind} pid ${o.record.pid} on ${o.record.port}: ${why}`);
      }
      throw new Error(
        `a check stack from run ${existing.runId} is still recorded and not all of it is gone ` +
          `(above). Run \`down\` and read what it says before starting another.`,
      );
    }
    console.log(`cleaning up after run ${existing.runId}, whose processes are all dead:`);
    const cleaned = await teardown(existing);
    printTeardown(cleaned);
    // the manifest that cleanup kept is the record of what it could not finish, and
    // the next `up` writes over that path: a stack on other ports would start fine
    // and take the evidence with it
    if (incomplete(cleaned)) {
      throw new Error(
        `cleaning up after run ${existing.runId} did not finish (above), so its manifest was kept ` +
          `and starting another stack would write over it. Read it, then delete it by hand.`,
      );
    }
  }

  assertCheckPort('api', options.apiPort);
  assertCheckPort('app', options.appPort);
  for (const [role, port] of [
    ['api', options.apiPort],
    ['app', options.appPort],
  ] as const) {
    if (await listening(port)) {
      throw new Error(
        `the ${role} port ${port} is already taken. The check stack refuses a busy port rather ` +
          `than drifting onto the next one - stop whatever holds it, or pass --${role}-port.`,
      );
    }
  }

  // proving the identity source answers, before anything exists to be identified: a
  // machine where this query fails would otherwise spawn both servers and then die
  // on the same call, leaving two children `down` refuses to kill
  await observeAll();

  const runId = crypto.randomBytes(4).toString('hex');
  const marker = markerFor(runId);
  const runDir = path.join(STACK_ROOT, runId);
  const home = path.join(runDir, 'home');
  const chromeProfileDir = path.join(runDir, 'chrome');
  assertRunPaths({ repoRoot: REPO_ROOT, runDir, home, ownerHome: config.home });

  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(chromeProfileDir, { recursive: true });
  const backendLog = path.join(runDir, 'backend.log');
  const webLog = path.join(runDir, 'web.log');

  const apiUrl = `http://${HOST}:${options.apiPort}`;
  const appUrl = `http://${HOST}:${options.appPort}`;

  const manifest: Manifest = {
    version: 1,
    runId,
    marker,
    startedAt: new Date().toISOString(),
    repoRoot: REPO_ROOT,
    runDir,
    home,
    chromeProfileDir,
    appUrl,
    apiUrl,
    children: [],
  };

  // written before the first spawn and again after each one, so there is no window
  // in which a running child is unrecorded. The state `down` cannot recover from is
  // narrower and one step later: a child spawned but not yet identified is recorded
  // with an empty command line, which shouldKill answers `not-ours` and down then
  // refuses to kill. Nothing between here and the identity read may throw
  writeManifest(manifest);

  const spawnChild = (
    kind: ChildKind,
    cwd: string,
    argv: string[],
    env: NodeJS.ProcessEnv,
    log: string,
    port: number,
  ): void => {
    const fd = fs.openSync(log, 'a');
    const child = spawn(process.execPath, argv, {
      cwd,
      // the marker goes into the environment as well as argv, where nothing reads
      // it: Win32_Process exposes no environment block, so argv is what `down` can
      // actually compare against
      env: { ...process.env, ...env, FINTO_CHECK_RUN: marker },
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
    });
    child.unref();
    if (child.pid === undefined) throw new Error(`the ${kind} child did not start`);
    manifest.children.push({
      kind,
      pid: child.pid,
      port,
      commandLine: '',
      creationDate: '',
      logPath: log,
    });
    writeManifest(manifest);
  };

  spawnChild(
    'backend',
    BACKEND_DIR,
    backendArgv({ tsxCli: TSX_CLI, entry: path.join(BACKEND_DIR, 'src', 'index.ts'), marker }),
    // see backendEnv: FINTO_HOME alone is not enough, because DOCUMENT_STORE_PATH
    // overrides the folder it derives, and the check inherits the owner's environment
    backendEnv({ home, apiPort: options.apiPort }),
    backendLog,
    options.apiPort,
  );
  spawnChild(
    'web',
    WEB_DIR,
    webArgv({ viteBin: VITE_BIN, port: options.appPort, host: HOST, marker }),
    // resolved on the machine running Vite, never in a browser, so the loopback
    // literal is right here
    { BACKEND_URL: `http://127.0.0.1:${options.apiPort}` },
    webLog,
    options.appPort,
  );

  const live = await observeAll();
  for (const child of manifest.children) {
    const seen = live.get(child.pid);
    if (seen) {
      child.commandLine = seen.commandLine;
      child.creationDate = seen.creationDate;
    }
  }
  writeManifest(manifest);

  try {
    await waitReady(apiUrl, appUrl);
  } catch (e) {
    console.error(`\n${(e as Error).message}`);
    printLogTail('backend', backendLog);
    printLogTail('web', webLog);
    console.error('\ntearing down what this run started:');
    printTeardown(await teardown(manifest));
    process.exit(1);
  }

  let imported: number | undefined;
  try {
    if (options.importFile) imported = await importStatement(apiUrl, options.importFile);
  } catch (e) {
    console.error(`\n${(e as Error).message}`);
    console.error('\ntearing down what this run started:');
    printTeardown(await teardown(manifest));
    process.exit(1);
  }

  console.log(`
check stack ${runId} is up
  app            ${appUrl}
  api            ${apiUrl}
  home           ${home} (its database in db/, its statements in statements/)
  chrome profile ${chromeProfileDir}
  logs           ${backendLog}
                 ${webLog}
  manifest       ${MANIFEST_PATH}${imported === undefined ? '' : `\n  imported       ${imported} rows from ${options.importFile}`}

  classification inherited from backend/.env: OWNER_NAMES=${JSON.stringify(config.ownerNames)} FAMILY_NAMES=${JSON.stringify(config.familyNames)} BASE_CURRENCY=${config.baseCurrency}
  a browser you launch yourself (the claude-in-chrome tools attach to the owner's Chrome and cannot use this profile):
    chrome.exe --user-data-dir=${chromeProfileDir} --no-first-run --no-default-browser-check ${appUrl}
  tear it down:  npm --prefix ${BACKEND_DIR} run check:stack -- down`);
  await warnAboutOwnerStack();
}

async function down(): Promise<void> {
  const manifest = readManifest();
  if (!manifest) {
    console.log(NOTHING_TO_TEAR_DOWN);
    return;
  }
  const report = await teardown(manifest);
  console.log(`run ${manifest.runId}:`);
  printTeardown(report);
  if (incomplete(report)) process.exit(1);
}

async function status(): Promise<void> {
  const manifest = readManifest();
  if (!manifest) {
    console.log(`no check stack is recorded (${MANIFEST_PATH} does not exist)`);
    await warnAboutOwnerStack();
    return;
  }
  const observations = observeChildren(manifest.children, await observeAll());
  console.log(`run ${manifest.runId}, started ${manifest.startedAt}`);
  for (const { record, verdict } of observations) {
    const identity = verdict.kill ? 'ours' : verdict.reason === 'gone' ? 'dead' : `NOT OURS: ${verdict.detail}`;
    const port = (await listening(record.port)) ? 'answering' : 'silent';
    console.log(`  ${record.kind.padEnd(8)} pid ${record.pid} ${identity}; port ${record.port} ${port}`);
  }
  console.log(`  home ${manifest.home} ${fs.existsSync(manifest.home) ? 'exists' : 'absent'}`);
  console.log(`  run directory ${manifest.runDir} ${fs.existsSync(manifest.runDir) ? 'exists' : 'absent'}`);
  console.log(`  app ${manifest.appUrl}   api ${manifest.apiUrl}`);
  await warnAboutOwnerStack();
}

async function main(): Promise<void> {
  assertSupportedPlatform();
  const argv = process.argv.slice(2);
  const verb = argv[0];
  switch (verb) {
    case 'up':
      return up(parseOptions(argv));
    case 'down':
      assertNoOptions(verb, argv);
      return down();
    case 'status':
      assertNoOptions(verb, argv);
      return status();
    default:
      throw new Error(`usage: check:stack -- <up|down|status> [--api-port n] [--app-port n] [--import <absolute path>]`);
  }
}

/**
 * An AggregateError's `.message` is the empty string - a port probe that fails on
 * both loopback families throws one - so the line an operator sees would be
 * `check-stack failed: ` and nothing after the colon. Every inner error is in
 * `.errors`, and `String(e)` alone is the bare word "AggregateError".
 */
main().catch((e: unknown) => {
  const message = e instanceof Error ? e.message : '';
  console.error(`check-stack failed: ${message || String(e)}`);
  if (e instanceof AggregateError) {
    for (const inner of e.errors as unknown[]) {
      console.error(`  ${inner instanceof Error ? inner.message : String(inner)}`);
    }
  }
  process.exit(1);
});
