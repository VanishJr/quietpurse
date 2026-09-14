import fs from 'fs/promises';
import path from 'path';
import { config } from './config';
import { OWNER_ONLY_DIR, OWNER_ONLY_FILE } from './storage';

/**
 * A claim is an open and then a write, so a file read empty is most likely one whose
 * write has not landed; only a file that stays empty this long is a crash's leftover.
 */
const EMPTY_WAIT_STEPS = 30;
const EMPTY_WAIT_MS = 10;
/** A takeover is a read and an unlink, so a marker held longer than this is one nobody is inside. */
const MARKER_WAIT_STEPS = 300;
const MARKER_WAIT_MS = 10;

const NO_FILE = Symbol('no file');
type Holder = string | typeof NO_FILE;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Read from config when called, never at load: a test points each case at a folder of its own. */
const lockPath = (): string => path.join(config.home, 'finto.lock');
const markerPath = (lockFile: string): string => `${lockFile}.takeover`;

/** EPERM is a process that exists under another account, so it is alive. */
export const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

// only ENOENT is an answer; a file this process cannot read may hold a live pid
const readText = (lockFile: string): Promise<Holder> =>
  fs.readFile(lockFile, 'utf8').catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return NO_FILE;
    throw e;
  });

async function readHolder(lockFile: string): Promise<Holder> {
  let held = await readText(lockFile);
  for (let i = 0; i < EMPTY_WAIT_STEPS && held === ''; i += 1) {
    await sleep(EMPTY_WAIT_MS);
    held = await readText(lockFile);
  }
  return held;
}

/**
 * Removes a stale file only under an exclusive marker directory beside it, and only
 * if it still reads as what the caller saw - so two starts that both found a dead pid
 * cannot each remove the other's fresh claim. EEXIST on the marker alone means another
 * taker is inside; anything else is a disk that refused and is thrown.
 */
async function takeOver(lockFile: string, seen: string): Promise<void> {
  const marker = markerPath(lockFile);
  for (let i = 0; ; i += 1) {
    try {
      await fs.mkdir(marker, { mode: OWNER_ONLY_DIR });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    if (i >= MARKER_WAIT_STEPS) return;
    await sleep(MARKER_WAIT_MS);
  }
  try {
    if ((await readHolder(lockFile)) !== seen) return;
    await fs.rm(lockFile, { force: true });
  } finally {
    await fs.rmdir(marker).catch(() => undefined);
  }
}

export async function acquireLock(): Promise<void> {
  if (config.databaseUrl) return;
  const lockFile = lockPath();
  await fs.mkdir(config.home, { recursive: true, mode: OWNER_ONLY_DIR });
  // twice, and no more: one pass to claim, one to claim what a dead holder left. A
  // third would be a spin against another Finto starting at the same instant
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // wx and never a look first: two Fintos started together both look at nothing
      await fs.writeFile(lockFile, String(process.pid), { flag: 'wx', mode: OWNER_ONLY_FILE });
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const held = await readHolder(lockFile);
    if (held === NO_FILE) continue;
    const pid = parseInt(held, 10);
    // 0 and a negative number are a process group to kill(), never a Finto
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && pidAlive(pid)) {
      throw new Error(
        `another Finto (pid ${pid}) is already running on ${config.home} - stop it first, or delete ${lockFile} if that process is gone`,
      );
    }
    await takeOver(lockFile, held);
  }
  throw new Error(
    `could not claim ${lockFile}: another Finto took it while this one was starting - start again, or delete ${markerPath(lockFile)} if it is still there and no Finto is starting`,
  );
}

/** Removes the file only when it holds this process's pid; never throws. */
export async function releaseLock(): Promise<void> {
  if (config.databaseUrl) return;
  const lockFile = lockPath();
  const held = await readText(lockFile).catch(() => undefined);
  if (held !== String(process.pid)) return;
  await fs.rm(lockFile, { force: true }).catch(() => undefined);
}
