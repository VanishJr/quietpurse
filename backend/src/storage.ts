import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { config } from './config';
import { causeChain, logger } from './logger';

/**
 * NOT a sanitiser: nothing is cleaned up into something acceptable, anything outside
 * the shape throws, so `..`, absolute paths, drive letters, NULs, empty segments and a
 * segment ending in a dot or a space are outside it by construction rather than by
 * removal.
 *
 * The three classes differ, and the middle one is the widest: `.`, `)` and ` ` are
 * legal inside a segment and `)` closes one, but none of the three OPENS one. That
 * asymmetry is why SEGMENT_START is exported - documentStem cuts a user's filename to
 * it rather than to a second copy of the class, so a name this file refuses cannot be
 * a name that file produces. The agreement is held by documents.test.ts's property
 * case over the stem's whole character set, not by the two comments matching.
 */
const START = '\\p{L}\\p{M}\\p{N}_(-';
const MIDDLE = '\\p{L}\\p{M}\\p{N}_.() -';
const END = '\\p{L}\\p{M}\\p{N}_)-';
const SEGMENT = `[${START}](?:[${MIDDLE}]{0,158}[${END}])?`;
const KEY = new RegExp(`^${SEGMENT}(?:/${SEGMENT})*$`, 'u');

/** One code point, and whether a key segment may begin with it. */
export const SEGMENT_START = new RegExp(`^[${START}]$`, 'u');

/** A relative DOCUMENT_STORE_PATH is resolved from backend/. */
export function storageRoot(): string {
  const p = config.documentStorePath;
  return path.isAbsolute(p) ? p : path.join(__dirname, '..', p);
}

function resolveKey(key: string): string {
  if (!KEY.test(key)) {
    throw new Error(`not a valid storage key: ${JSON.stringify(key.slice(0, 80))}`);
  }
  return path.join(storageRoot(), ...key.split('/'));
}

/**
 * Nobody but this user. The statements are bank statements and the database beside
 * them is every transaction in them, and the sealing under a server key went with the
 * hosted product, because on a personal machine that key would have sat beside the
 * files it guarded - so the only thing left between them and a second account on the
 * machine is the mode: set where a file is created, and re-checked on every boot for a
 * folder that was not.
 *
 * 0700 on a directory is the load-bearing half: PGlite writes its own files inside
 * the database folder under its own modes, and a folder nobody else may traverse
 * covers them whatever they are. An umask can only take permissions away here, never
 * add them.
 *
 * mkdir applies this to what it CREATES and leaves an existing directory at whatever
 * mode it has, so the create-time mode alone leaves every folder made before this
 * code existed open. assertWritableDir repairs instead of refusing: refusing would
 * turn a folder the user already has data in into a server that will not boot.
 */
export const OWNER_ONLY_DIR = 0o700;
export const OWNER_ONLY_FILE = 0o600;

/**
 * The directory exists AND can be written to. mkdir alone is not the check - it
 * succeeds on an existing directory whatever its permissions, and a folder that
 * cannot be written to would otherwise be discovered by the first upload that is
 * refused, or by a migration that reports the SQL it failed on.
 *
 * The probe's name starts with a dot, so it is outside KEY by construction and no get
 * can address it. The resolved path belongs in this message: it is a boot failure on
 * the console, not the user-facing surface, and a path plus an errno is the whole of
 * what makes it actionable.
 */
export async function assertWritableDir(dir: string, what: string): Promise<void> {
  const probe = path.join(dir, `.writable-${crypto.randomUUID()}`);
  try {
    await fs.mkdir(dir, { recursive: true, mode: OWNER_ONLY_DIR });
    // A directory that already existed kept its own mode, so the create-time mode
    // above says nothing about this one. Widened bits are cleared on every boot
    // rather than once at install: whatever set them can set them again.
    const { mode } = await fs.stat(dir);
    if (mode & 0o077) {
      await fs.chmod(dir, OWNER_ONLY_DIR);
      logger.warn(`${what} at ${dir} was readable by other accounts; set to 0700`);
    }
    await fs.writeFile(probe, 'finto', { mode: OWNER_ONLY_FILE });
    await fs.unlink(probe);
  } catch (e) {
    throw new Error(`${what} at ${dir} is not writable: ${causeChain(e)}`, { cause: e });
  }
}

/**
 * Writes under a temp name in the DESTINATION directory and renames into place:
 * rename is atomic within a filesystem, a copy across one is not, and a crash
 * mid-write must never leave a truncated file under a name a row already points
 * at. The temp name is unique per write - two concurrent puts under different keys
 * would otherwise collide on it - and starts with a dot, which puts it outside KEY
 * so no get can resolve it.
 *
 * An existing object is overwritten silently: the only route to a collision is a
 * repeated import id, and those are crypto.randomUUID(). An existence check would
 * close a hole that is not open.
 *
 * No fsync. A power loss that leaves a zero-length or partial file is caught loudly
 * by the hash check on read; the failure mode is a refusal, not plausible bytes. A
 * crash between the write and the rename leaves the temp file behind - unreachable
 * by any key, and no sweeper is in scope.
 */
export async function putObject(key: string, bytes: Buffer): Promise<void> {
  const target = resolveKey(key);
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true, mode: OWNER_ONLY_DIR });
  const temp = path.join(dir, `.tmp-${crypto.randomUUID()}`);
  try {
    await fs.writeFile(temp, bytes, { mode: OWNER_ONLY_FILE });
    await fs.rename(temp, target);
  } catch (e) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw e;
  }
}

/** The stored bytes, or undefined when there is no object under that key. */
export async function getObject(key: string): Promise<Buffer | undefined> {
  const target = resolveKey(key);
  try {
    return await fs.readFile(target);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

/**
 * "Not there" is not an error and must not be reported as one: most deletes reach
 * imports that never had a document, and an error line per delete trains the reader
 * to ignore the one that matters.
 */
export async function deleteObject(key: string): Promise<boolean> {
  const target = resolveKey(key);
  try {
    await fs.unlink(target);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}

/** The statements folder, named for the setting that moves it. */
export async function assertStorageWritable(): Promise<void> {
  await assertWritableDir(storageRoot(), 'the statements folder (DOCUMENT_STORE_PATH)');
}
