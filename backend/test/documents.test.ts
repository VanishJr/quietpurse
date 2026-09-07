/**
 * The storage seam and the stored statements above it.
 *
 * Two things are held here that nothing else can. The file a person finds in their
 * statements folder is the file they uploaded, byte for byte, under a name they can
 * recognise - that is the whole reason the folder is theirs to open. And a name is
 * derived from user input for the first time in this application, so the derivation
 * is exercised against every shape a filename can arrive in rather than trusted.
 */
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { config } from '../src/config';
import {
  DocumentRef,
  deleteDocument,
  documentKey,
  documentStem,
  getDocument,
  putDocument,
  STEM_MAX,
} from '../src/documents';
import {
  assertStorageWritable,
  deleteObject,
  getObject,
  putObject,
  storageRoot,
} from '../src/storage';

const bytes = (s: string): Buffer => Buffer.from(s, 'utf8');

const sha256 = (b: Buffer): string => crypto.createHash('sha256').update(b).digest('hex');

const rootEntries = async (): Promise<string[]> => {
  try {
    return (await fs.readdir(storageRoot())).sort();
  } catch {
    return [];
  }
};

describe('the storage seam', () => {
  it('stores and returns the exact bytes, and reports a missing key rather than throwing', async () => {
    await putObject('seam/seam-one.csv', bytes('hello'));
    expect(await getObject('seam/seam-one.csv')).toEqual(bytes('hello'));

    expect(await getObject('seam/never-written.csv')).toBeUndefined();
    expect(await deleteObject('seam/never-written.csv')).toBe(false);
    expect(await deleteObject('seam/seam-one.csv')).toBe(true);
    expect(await getObject('seam/seam-one.csv')).toBeUndefined();
  });

  it('refuses every key outside the shape, and writes nothing while doing it', async () => {
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
      'x'.repeat(161),
      '.tmp-sneaky',
      'a\\b',
      'a<b',
      'a*b',
      'a:b',
      'a\nb',
      // Windows drops a trailing dot or space, so a name ending in one is a name
      // that reads back under another
      'trailing-space ',
      'trailing-dot.',
    ];
    for (const key of refused) {
      await expect(putObject(key, bytes('nope'))).rejects.toThrow(/not a valid storage key/);
      await expect(getObject(key)).rejects.toThrow(/not a valid storage key/);
      await expect(deleteObject(key)).rejects.toThrow(/not a valid storage key/);
    }
    expect(await rootEntries()).toEqual(before);
  });

  it('accepts the names a cleaned statement is written under', async () => {
    for (const key of ['Виписка по рахунку_imp-1.pdf', 'a..b_imp-2.csv', 'Q1 2026 (Revolut)_x.xlsx']) {
      await putObject(key, bytes('yes'));
      expect(await getObject(key)).toEqual(bytes('yes'));
      expect(await deleteObject(key)).toBe(true);
    }
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
   * directory that exists and cannot be written to. mkdir -p returns clean on it,
   * the app starts, and every import is refused at runtime instead.
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

/**
 * The name on disk is derived from three fields of the import row and the user's
 * filename is one of them. Every row below is a filename somebody could upload, and
 * the expectation is the stem the folder shows for it.
 */
describe('the stem a filename becomes', () => {
  it.each([
    ['statement.csv', 'statement'],
    ['Revolut Statement Q1 2026.xlsx', 'Revolut Statement Q1 2026'],
    ['Виписка по рахунку.pdf', 'Виписка по рахунку'],
    ['report.2026-08.csv', 'report.2026-08'],
    ['Statement (1).pdf', 'Statement (1)'],
    // `)` closes a storage key segment and opens none, so it cannot lead a stem
    [')statement.csv', 'statement'],
    [') (2).csv', '(2)'],
    // a device name that a dot inside the stem would end the name at: prefixed, and
    // only that shape - `CON` alone is safe because the id follows it before any dot
    ['con.txt.csv', '_con.txt'],
    ['COM1 .backup.csv', '_COM1 .backup'],
    // a path, whichever way its separators lean: only the last segment is a name
    ['..\\..\\evil.csv', 'evil'],
    ['../../etc/passwd', 'passwd'],
    ['/tmp/../statement.csv', 'statement'],
    // the characters no filesystem or shell takes kindly, each one replaced
    ['a<b>c:d"e|f?g*h.csv', 'a_b_c_d_e_f_g_h'],
    ['state\r\nment.csv', 'state__ment'],
    ['nul\0byte.csv', 'nul_byte'],
    // a hidden file, a bare extension, and a name that is nothing but dots
    ['.hidden.csv', 'hidden'],
    ['.csv', 'statement'],
    ['...', 'statement'],
    ['', 'statement'],
    // Windows strips trailing dots and spaces on its own; nothing here may rely on it
    ['trailing.   .csv', 'trailing'],
    ['  padded  .csv', 'padded'],
    ['many     spaces.csv', 'many spaces'],
    // an unpaired surrogate, which a restored backup's JSON can legally carry
    ['bad\ud800name.csv', 'badname'],
  ])('%j becomes %j', (original, stem) => {
    expect(documentStem(original)).toBe(stem);
  });

  it('null becomes the plain word, since an upload without a name is one', () => {
    expect(documentStem(null)).toBe('statement');
  });

  it('is bounded by code points, and never ends on a space the cap left behind', () => {
    const long = `${'a'.repeat(STEM_MAX - 1)} ${'b'.repeat(40)}.csv`;
    const stem = documentStem(long);
    expect(Array.from(stem)).toHaveLength(STEM_MAX - 1);
    expect(stem).toBe('a'.repeat(STEM_MAX - 1));
    // a letter outside the basic plane is one code point and two UTF-16 units, so a
    // cap counted in units would land on half of one
    const astral = `${'\u{1d538}'.repeat(STEM_MAX + 5)}.csv`;
    expect(Array.from(documentStem(astral))).toHaveLength(STEM_MAX);
    expect(documentStem(astral).length).toBe(STEM_MAX * 2);
  });

  /**
   * `CON`, `NUL`, `AUX`, `COM1` and the like are device names on Windows whatever
   * extension follows them, and every one of them is a name a user can type. What
   * keeps them out is not a list - it is that the stem never stands alone: the id
   * follows it before the first dot, so the name Windows would resolve is `CON_<id>`.
   */
  it.each(['CON', 'NUL', 'AUX', 'PRN', 'COM1', 'LPT9', 'con.txt'])(
    'a Windows device name %s is never a whole name',
    (name) => {
      const key = documentKey({ importId: 'imp-1', originalFilename: `${name}.csv`, sourceType: 'csv' });
      expect(key.split('.')[0].toUpperCase()).not.toMatch(/^(CON|PRN|AUX|NUL|COM\d|LPT\d)$/);
      expect(key).toBe(`${documentStem(`${name}.csv`)}_imp-1.csv`);
    },
  );

  /**
   * The property, not another example. documentStem and the storage seam live in
   * different files and agree only through SEGMENT_START, so this drives the stem's
   * whole character set through both doors - one character at a time, and in every
   * position, because a class that is wrong at the head alone is green in the middle
   * and at the tail. `)` is the character that was wrong: it is legal inside a key
   * segment and closes one, and it opens none, so `)statement.csv` built a key
   * resolveKey threw on and the upload was refused as an unwritable folder, forever.
   *
   * getObject is the door, because resolveKey is not exported: a key it refuses
   * throws, where a key it accepts and cannot find answers undefined.
   */
  const STEM_ALPHABET = [
    'a',
    'Z',
    '\u042f',
    '\u{1d538}',
    '\u0301',
    '5',
    '\u0663',
    '_',
    '.',
    '(',
    ')',
    '-',
    ' ',
    '<',
  ];

  it.each(STEM_ALPHABET)('a stem built around %j is a key the storage seam opens', async (c) => {
    for (const around of [c, `${c}${c}`, `${c}x`, `x${c}`, `${c}x${c}`, `x${c}x`]) {
      for (const original of [around, `${around}.csv`, `${around}.name.csv`]) {
        const key = documentKey({
          importId: 'imp-property',
          originalFilename: original,
          sourceType: 'csv',
        });
        await expect(
          getObject(key),
          `${JSON.stringify(original)} became the key ${JSON.stringify(key)}`,
        ).resolves.toBeUndefined();
      }
    }
  });

  it('an id a backup carried is hashed into the name rather than written into a path', () => {
    const key = documentKey({ importId: '../evil', originalFilename: null, sourceType: 'csv' });
    expect(key).toMatch(/^statement_[0-9a-f]{32}\.csv$/);
    // and two foreign ids never share a name
    const other = documentKey({ importId: '../evil2', originalFilename: null, sourceType: 'csv' });
    expect(other).not.toBe(key);
  });

  /**
   * The pair a restored backup would use to aim one row at another row's file. `_`
   * is the separator, so an id carrying one would give the key a second reading;
   * the hash arm is what takes that away, and the assertion is inequality rather
   * than a shape, because the defect IS the two being equal.
   */
  it('a name and an id that read as each other do not derive the same key', () => {
    const mine = documentKey({
      importId: 'b_c',
      originalFilename: 'a.csv',
      sourceType: 'csv',
    });
    const theirs = documentKey({
      importId: 'c',
      originalFilename: 'a_b.csv',
      sourceType: 'csv',
    });
    expect(mine).not.toBe(theirs);
  });

  it('a minted id is written into the key verbatim, so no stored file is renamed', () => {
    const id = crypto.randomUUID();
    const key = documentKey({ importId: id, originalFilename: 'statement.csv', sourceType: 'csv' });
    expect(key).toBe(`statement_${id}.csv`);
  });
});

describe('documents: the domain layer', () => {
  const locator = (importId: string, originalFilename: string | null = null) => ({
    importId,
    originalFilename,
    sourceType: 'csv',
  });

  it('a stored document is the uploaded file, byte for byte, under a name a person can read', async () => {
    const plain = bytes('date,amount,description\n2026-02-02,-1.00,Coffee\n');
    const importId = 'doc-domain-roundtrip';
    const doc = locator(importId, 'Revolut March.csv');
    await putDocument(doc, plain);

    const ref: DocumentRef = { ...doc, fileHash: sha256(plain) };
    expect(await getDocument(ref)).toEqual(plain);
    // what is on disk is the statement itself, where the folder says it is
    expect(await fs.readFile(path.join(storageRoot(), `Revolut March_${importId}.csv`))).toEqual(
      plain,
    );

    expect(await deleteDocument(doc)).toBe(true);
    expect(await deleteDocument(doc)).toBe(false);
    await expect(getDocument(ref)).rejects.toThrow(/no file at/);
  });

  /**
   * The file is the person's to open, and also the person's to edit by accident. A
   * file that no longer hashes to what the import recorded is refused rather than
   * handed back as the statement that was uploaded.
   */
  it('a file that no longer matches what the import recorded is refused', async () => {
    const importId = 'doc-domain-mismatch';
    const doc = locator(importId);
    await putDocument(doc, bytes('the statement that was uploaded'));
    await fs.writeFile(path.join(storageRoot(), `statement_${importId}.csv`), 'edited in Excel');
    await expect(
      getDocument({ ...doc, fileHash: sha256(bytes('the statement that was uploaded')) }),
    ).rejects.toThrow(/is not the one import/);
  });

  /**
   * The name is derived from the row, never stored, so a row whose filename or type
   * were changed underneath it addresses a different file - which is what makes a
   * crafted backup unable to point at somebody's statement by writing a path.
   */
  it('the name is a function of the row, so nothing on it may move after the put', async () => {
    const importId = 'doc-domain-moved';
    const doc = locator(importId, 'before.csv');
    await putDocument(doc, bytes('written under one name'));
    expect(await getDocument({ ...doc, fileHash: sha256(bytes('written under one name')) })).toEqual(
      bytes('written under one name'),
    );
    await expect(
      getDocument({ ...doc, originalFilename: 'after.csv', fileHash: 'whatever' }),
    ).rejects.toThrow(/no file at/);
    expect(await deleteDocument({ ...doc, originalFilename: 'after.csv' })).toBe(false);
    expect(await deleteDocument(doc)).toBe(true);
  });

  it('the ids this app mints reach the folder verbatim', async () => {
    const importId = crypto.randomUUID();
    const plain = bytes('date,amount,description\n2026-09-09,-4.00,Generated ids\n');
    const doc = locator(importId, 'generated.csv');
    await putDocument(doc, plain);
    await expect(
      fs.access(path.join(storageRoot(), `generated_${importId}.csv`)),
    ).resolves.toBeUndefined();
    expect(await deleteDocument(doc)).toBe(true);
  });
});
