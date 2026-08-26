import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { config } from './config';
import { causeChain } from './logger';

/**
 * NOT a sanitiser: nothing is cleaned up into something acceptable, anything outside
 * the charset throws, so `..`, absolute paths, drive letters, NULs and empty segments
 * are outside it by construction rather than by removal.
 *
 * What makes a key safe is not this pattern but where its segments come from -
 * documents.ts builds every one of them from an id this server generated. `CON`,
 * `NUL`, `AUX` and `COM1` all match here and are device names on Windows, so an
 * original_filename or any other string a user chose must never be passed through in
 * the belief that this guard covers it.
 */
const KEY = /^[A-Za-z0-9_-]{1,64}(\/[A-Za-z0-9_-]{1,64})*$/;

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
 * Writes under a temp name in the DESTINATION directory and renames into place:
 * rename is atomic within a filesystem, a copy across one is not, and a crash
 * mid-write must never leave a truncated blob under a name a row already points
 * at. The temp name is unique per write - two concurrent puts under different keys
 * would otherwise collide on it - and starts with a dot, which puts it outside KEY
 * so no get can resolve it.
 *
 * An existing object is overwritten silently: the only route to a collision is a
 * repeated import id, and those are crypto.randomUUID(). An existence check would
 * close a hole that is not open.
 *
 * No fsync. A power loss that leaves a zero-length or partial file is caught loudly
 * by the length check and the AEAD tag on read; the failure mode is a refusal, not
 * plausible bytes. A crash between the write and the rename leaves the temp file
 * behind forever - it is ciphertext, it is unreachable, and no sweeper is in scope.
 */
export async function putObject(key: string, bytes: Buffer): Promise<void> {
  const target = resolveKey(key);
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true });
  const temp = path.join(dir, `.tmp-${crypto.randomUUID()}`);
  try {
    await fs.writeFile(temp, bytes);
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
 * imports that never had a document, and an error line per delete trains the operator
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

/**
 * The root exists AND can be written to. mkdir alone is not the check - it succeeds on
 * an existing directory whatever its permissions, which is exactly the failure this
 * exists to catch: a named volume that arrives owned by root while the image runs as a
 * non-root user, so the server boots clean and refuses every import at runtime instead.
 *
 * The probe's name starts with a dot, so it is outside KEY by construction and no get
 * can address it. The resolved path belongs in this message: it is a boot failure on
 * the operator's console, not the user-facing surface.
 */
export async function assertStorageWritable(): Promise<void> {
  const root = storageRoot();
  const probe = path.join(root, `.writable-${crypto.randomUUID()}`);
  try {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(probe, 'finto');
    await fs.unlink(probe);
  } catch (e) {
    throw new Error(
      `the source document store at ${root} is not writable (DOCUMENT_STORE_PATH): ${causeChain(e)}`,
      { cause: e },
    );
  }
}
