/**
 * The storage seam and the envelope (ROADMAP 4.5).
 *
 * Almost everything here is about refusing rather than returning: a truncated
 * file, a flipped byte, an envelope version this server does not know, the wrong
 * key, a document copied out of another workspace's directory, bytes that do not
 * match the file the import recorded. Any one of those returned quietly is a
 * re-parser importing the wrong statement, which is the failure encrypting the
 * documents at all is meant to make impossible.
 */
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { runWithWorkspace } from '../src/db';
import {
  CURRENT_KEY_VERSION,
  DocumentRef,
  deleteDocument,
  deriveDocumentKey,
  getDocument,
  openDocument,
  putDocument,
  sealDocument,
} from '../src/documents';
import {
  assertStorageWritable,
  deleteObject,
  getObject,
  putObject,
  storageRoot,
} from '../src/storage';
import { TEST_WORKSPACE_ID } from './pglite';

const bytes = (s: string): Buffer => Buffer.from(s, 'utf8');

const sha256 = (b: Buffer): string => crypto.createHash('sha256').update(b).digest('hex');

/** Where a document for an import id actually sits - spelled out, not asked for. */
const onDisk = (importId: string): string =>
  path.join(storageRoot(), TEST_WORKSPACE_ID, importId);

const rootEntries = async (): Promise<string[]> => {
  try {
    return (await fs.readdir(storageRoot())).sort();
  } catch {
    return [];
  }
};

describe('the storage seam', () => {
  it('stores and returns the exact bytes, and reports a missing key rather than throwing', async () => {
    await putObject('seam-ws/seam-one', bytes('hello'));
    expect(await getObject('seam-ws/seam-one')).toEqual(bytes('hello'));

    expect(await getObject('seam-ws/never-written')).toBeUndefined();
    expect(await deleteObject('seam-ws/never-written')).toBe(false);
    expect(await deleteObject('seam-ws/seam-one')).toBe(true);
    expect(await getObject('seam-ws/seam-one')).toBeUndefined();
  });

  it('refuses every key outside the charset, and writes nothing while doing it', async () => {
    const before = await rootEntries();
    const refused = [
      '..',
      'a/../b',
      '/absolute/path',
      'C:/windows',
      'a\0b',
      '',
      'a/',
      '/',
      'x'.repeat(65),
      '.tmp-sneaky',
      'space here',
      'ws/statement.csv',
    ];
    for (const key of refused) {
      await expect(putObject(key, bytes('nope'))).rejects.toThrow(/not a valid storage key/);
      await expect(getObject(key)).rejects.toThrow(/not a valid storage key/);
      await expect(deleteObject(key)).rejects.toThrow(/not a valid storage key/);
    }
    expect(await rootEntries()).toEqual(before);
  });

  it('the boot check fails on a root that cannot be written to', async () => {
    // a plain FILE where the root should be: no chmod, and the same result on
    // Windows and Linux. mkdir itself already throws on this one, so this case
    // does NOT distinguish the probe from a bare mkdir -p - the case below is the
    // one that does
    await fs.mkdir(storageRoot(), { recursive: true });
    const asFile = path.join(storageRoot(), 'boot-check-root');
    await fs.writeFile(asFile, 'not a directory');

    const before = config.documentStorePath;
    try {
      config.documentStorePath = asFile;
      await expect(assertStorageWritable()).rejects.toThrow(/is not writable/);
    } finally {
      config.documentStorePath = before;
      await fs.rm(asFile, { force: true });
    }
    await expect(assertStorageWritable()).resolves.toBeUndefined();
  });

  /**
   * The whole reason the check writes a probe instead of trusting mkdir -p: a
   * directory that exists and cannot be written to - a named volume arriving
   * owned by root while the image runs as USER node. mkdir -p returns clean on
   * it, the server boots, and every import is refused at runtime instead.
   *
   * Skipped rather than passed for the wrong reason where the fixture cannot
   * bite: chmod does not remove write access on Windows, and root ignores 0o500.
   * CI (ubuntu-latest, no container, non-root) is where this case first runs.
   */
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'the boot check fails on a root that exists but cannot be written to',
    async () => {
      const readOnly = path.join(storageRoot(), 'boot-check-read-only');
      await fs.mkdir(readOnly, { recursive: true });
      await fs.chmod(readOnly, 0o500);

      const before = config.documentStorePath;
      try {
        config.documentStorePath = readOnly;
        await expect(assertStorageWritable()).rejects.toThrow(/is not writable/);
      } finally {
        config.documentStorePath = before;
        await fs.chmod(readOnly, 0o700);
        await fs.rm(readOnly, { recursive: true, force: true });
      }
    },
  );
});

describe('the envelope', () => {
  const KEY = 'env-ws/env-import';

  it('round-trips, and what it produces is not the plaintext', () => {
    const plain = bytes('date,amount\n2026-01-01,-9.99\n');
    const sealed = sealDocument(plain, KEY);

    expect(sealed[0]).toBe(1);
    expect(sealed[1]).toBe(deriveDocumentKey(config.documentEncryptionKey).id);
    expect(sealed.length).toBe(30 + plain.length);
    expect(sealed.includes(plain)).toBe(false);
    expect(openDocument(sealed, KEY)).toEqual(plain);

    // the same bytes sealed twice differ: the IV is fresh per document
    expect(sealDocument(plain, KEY).equals(sealed)).toBe(false);
  });

  it('a truncated file throws instead of decrypting what is left', () => {
    const sealed = sealDocument(bytes('some statement'), KEY);
    expect(() => openDocument(sealed.subarray(0, 29), KEY)).toThrow(/truncated/);
    expect(() => openDocument(Buffer.alloc(0), KEY)).toThrow(/truncated/);
    // a tail the header alone cannot notice - that one is the tag's job
    expect(() => openDocument(sealed.subarray(0, sealed.length - 1), KEY)).toThrow(
      /integrity check/,
    );
  });

  it('a flipped ciphertext byte throws', () => {
    const sealed = sealDocument(bytes('some statement'), KEY);
    sealed[35] ^= 0xff;
    expect(() => openDocument(sealed, KEY)).toThrow(/integrity check/);
  });

  it('an envelope version this server does not know is named, not attempted', () => {
    const sealed = sealDocument(bytes('some statement'), KEY);
    sealed[0] = 2;
    expect(() => openDocument(sealed, KEY)).toThrow(/envelope version 2/);
  });

  it('the wrong key is diagnosed as the wrong key, before any decrypt', () => {
    const mine = deriveDocumentKey(config.documentEncryptionKey);
    const theirs = deriveDocumentKey('a completely different document key');
    // without this the assertion below could pass through the tag path on a
    // 1-in-256 id collision - green, and testing what the corruption case covers
    expect(theirs.id).not.toBe(mine.id);

    const sealed = sealDocument(bytes('some statement'), KEY, theirs);
    expect(() => openDocument(sealed, KEY, mine)).toThrow(
      /key id \d+ and this server holds key id \d+ - DOCUMENT_ENCRYPTION_KEY/,
    );
  });

  it('a document is bound to the key it was sealed under', () => {
    const sealed = sealDocument(bytes('workspace A statement'), 'ws-a/imp-1');
    expect(() => openDocument(sealed, 'ws-b/imp-1')).toThrow(/integrity check/);
    expect(openDocument(sealed, 'ws-a/imp-1')).toEqual(bytes('workspace A statement'));
  });
});

describe('documents: the domain layer', () => {
  it('a stored document reads back byte-identical and is removed on request', async () => {
    const plain = bytes('date,amount,description\n2026-02-02,-1.00,Coffee\n');
    const importId = 'doc-domain-roundtrip';
    const keyVersion = await putDocument(importId, plain);
    expect(keyVersion).toBe(CURRENT_KEY_VERSION);

    const ref: DocumentRef = { importId, keyVersion, fileHash: sha256(plain) };
    expect(await getDocument(ref)).toEqual(plain);
    // what is on disk at the derived key is the ciphertext, not the statement
    expect(await fs.readFile(onDisk(importId))).not.toEqual(plain);

    expect(await deleteDocument(importId)).toBe(true);
    expect(await deleteDocument(importId)).toBe(false);
    await expect(getDocument(ref)).rejects.toThrow(/no bytes at/);
  });

  it('a document that does not match the file the import recorded is refused', async () => {
    const importId = 'doc-domain-mismatch';
    const keyVersion = await putDocument(importId, bytes('the statement that was uploaded'));
    await expect(
      getDocument({ importId, keyVersion, fileHash: sha256(bytes('a different file')) }),
    ).rejects.toThrow(/does not match the file/);
  });

  it('a key layout this server does not know is refused, never read as layout 1', async () => {
    const importId = 'doc-domain-future-layout';
    await putDocument(importId, bytes('written by this build'));
    await expect(getDocument({ importId, keyVersion: 99, fileHash: 'whatever' })).rejects.toThrow(
      /key layout 99/,
    );
  });

  /**
   * The other direction of the charset guard: it is safe because every segment is an
   * id this server generated, and nothing else asserts that those ids are inside it.
   * An id that falls outside refuses every upload in that workspace with
   * DOCUMENT_STORE_REFUSED, whose text sends the user and the operator to the disk.
   * Every other workspace id in this suite is hand-written, so this is the only place
   * production-shaped ids reach putDocument at all.
   */
  it('the ids this server generates are inside the storage charset', async () => {
    const workspaceId = crypto.randomUUID();
    const importId = crypto.randomUUID();
    const plain = bytes('date,amount,description\n2026-09-09,-4.00,Generated ids\n');

    await runWithWorkspace(workspaceId, async () => {
      const keyVersion = await putDocument(importId, plain);
      expect(await getDocument({ importId, keyVersion, fileHash: sha256(plain) })).toEqual(plain);
      // both ids reached the disk verbatim - neither hashed nor cleaned up
      await expect(
        fs.access(path.join(storageRoot(), workspaceId, importId)),
      ).resolves.toBeUndefined();
    });
  });
});
