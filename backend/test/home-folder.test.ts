/**
 * The folder on the person's own disk.
 *
 * Two things nothing else holds. A folder that cannot be written to has to say so in
 * words a person can act on, and for the database that means saying it BEFORE the
 * migration runs - drizzle wraps every driver error, so a failure that reaches the
 * migration is reported as the SQL it was running with every bound value in it, and
 * the permission that actually stopped it is two levels down on `cause`.
 *
 * And the sealing under a server key went with the hosted product, so the mode on the
 * folder is now the whole of what stands between a bank statement and a second account
 * on the machine. It is asserted on the disk, because a mode passed to mkdir on a directory
 * that already exists does nothing and would look identical in the source.
 */
import fs from 'fs/promises';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { openDatabase } from '../src/db';
import { putDocument } from '../src/documents';
import { reasonFirst } from '../src/logger';
import { assertStorageWritable, storageRoot } from '../src/storage';

const modeOf = async (p: string): Promise<string> =>
  ((await fs.stat(p)).mode & 0o777).toString(8);

/** chmod does not remove write access on Windows, and root ignores every mode. */
const ownerOnly = it.skipIf(process.platform === 'win32' || process.getuid?.() === 0);

describe('the folder Finto keeps everything in', () => {
  /**
   * The database probe, aimed at the message and not only at the throw. `Failed
   * query` is drizzle's wrapper talking, and it is what this route answered before:
   * the person read the whole CREATE SCHEMA statement and nothing about permissions.
   */
  it('refuses an unwritable database folder by its path, and never with SQL', async () => {
    const asFile = path.join(storageRoot(), 'db-as-a-file');
    await fs.mkdir(storageRoot(), { recursive: true });
    await fs.writeFile(asFile, 'not a directory');

    const before = config.databaseDir;
    try {
      config.databaseDir = asFile;
      await expect(openDatabase()).rejects.toThrow(
        new RegExp(`the database folder .* at ${asFile.replace(/[.\\\\]/g, '\\\\$&')} is not writable`),
      );
      await expect(openDatabase()).rejects.not.toThrow(/Failed query|params:/);
      // the errno survives to the sentence: it is the half that says WHICH failure
      await expect(openDatabase()).rejects.toThrow(/ENOTDIR|EEXIST|ENOENT/);
    } finally {
      config.databaseDir = before;
      await fs.rm(asFile, { force: true });
    }
  });

  ownerOnly('creates the statements folder readable by nobody else', async () => {
    const root = path.join(storageRoot(), 'mode-check');
    await fs.rm(root, { recursive: true, force: true });

    const before = config.documentStorePath;
    try {
      config.documentStorePath = root;
      await assertStorageWritable();
      expect(await modeOf(root)).toBe('700');
    } finally {
      config.documentStorePath = before;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  /**
   * The arm the case above cannot reach. mkdir's mode applies to what it CREATES, so
   * a folder made by an earlier build - or by a person - keeps whatever it had, and
   * every install predating the mode carried it forward. The repair is on the boot
   * path rather than on an install step because there is no install step.
   */
  ownerOnly('narrows a statements folder that already existed readable by others', async () => {
    const root = path.join(storageRoot(), 'mode-repair');
    await fs.rm(root, { recursive: true, force: true });
    await fs.mkdir(root, { recursive: true });
    await fs.chmod(root, 0o755);
    expect(await modeOf(root)).toBe('755');

    const before = config.documentStorePath;
    try {
      config.documentStorePath = root;
      await assertStorageWritable();
      expect(await modeOf(root)).toBe('700');
    } finally {
      config.documentStorePath = before;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  ownerOnly('writes a stored statement readable by nobody else', async () => {
    const doc = { importId: 'mode-check-import', originalFilename: 'modes.csv', sourceType: 'csv' };
    await putDocument(doc, Buffer.from('date,amount,description\n2026-01-01,-1.00,Mode\n', 'utf8'));
    expect(await modeOf(path.join(storageRoot(), 'modes_mode-check-import.csv'))).toBe('600');
  });
});

/**
 * The one line a person reads off a console when the app refuses to start.
 *
 * These are the two shapes a boot failure actually arrives in, and they want opposite
 * orderings from causeChain: a wrapper whose own message is the SQL, and a boot check
 * whose own message is already the actionable sentence.
 */
describe('the sentence a failed start prints', () => {
  /**
   * drizzle-orm's shape, measured on a squashed migration rather than invented: the
   * wrapper's message is the whole CREATE TABLE with every bound value, and the news
   * is five words on `cause`. Reported outermost-first, the person reads a screen of
   * SQL and stops before the reason.
   */
  it('leads with the reason when the wrapper is a failed query', () => {
    const reason = Object.assign(new Error('relation "accounts" already exists'), { code: '42P07' });
    const wrapped = new Error('Failed query: CREATE TABLE "accounts" (...);\nparams: ', {
      cause: reason,
    });
    const line = reasonFirst(wrapped);
    expect(line.startsWith('relation "accounts" already exists')).toBe(true);
    expect(line).toContain('Failed query');
  });

  /**
   * A boot check composes its cause into its own message on purpose, so that the
   * thrown error stands alone wherever it is logged. Printing the chain would then
   * say the errno at both ends, which reads as two different failures.
   */
  it('does not say a cause twice when the thrower already composed it in', () => {
    const errno = new Error("ENOTDIR: not a directory, mkdir '/x'");
    const composed = new Error(
      `the database folder (FINTO_HOME/db) at /x is not writable: ${errno.message}`,
      { cause: errno },
    );
    expect(reasonFirst(composed)).toBe(
      "the database folder (FINTO_HOME/db) at /x is not writable: ENOTDIR: not a directory, mkdir '/x'",
    );
  });

  it('answers a bare error with its own message, and an empty chain with nothing', () => {
    expect(reasonFirst(new Error('port 4000 is taken'))).toBe('port 4000 is taken');
    expect(reasonFirst(undefined)).toBe('');
  });
});
