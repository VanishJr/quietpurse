import crypto from 'crypto';
import { causeChain, logImport } from './logger';
import { SEGMENT_START, deleteObject, getObject, putObject } from './storage';
import { IMPORT_SOURCE_TYPES } from './wire';

/**
 * What names a stored statement on disk. Every field is on the import row and none
 * of them changes after the row is written, so the name can be derived again at read
 * and delete time rather than stored - a stored name is a path a crafted backup gets
 * to choose.
 */
export interface DocumentLocator {
  importId: string;
  originalFilename: string | null;
  sourceType: string;
}

/** The file hash travels with the locator so getDocument can check what it read against what the import recorded. */
export interface DocumentRef extends DocumentLocator {
  fileHash: string;
}

/** Code points, not UTF-16 units: a cap counted in units can end on half an emoji. */
export const STEM_MAX = 60;

const STEM_CHAR = /[\p{L}\p{M}\p{N}_.()\- ]/u;

/**
 * The stem cut to the edges storage.ts will accept. The tail rule is the filesystem's
 * - no name ends in a dot or a space - and the head rule is SEGMENT_START's, read off
 * storage.ts rather than copied: `.`, ` ` and `)` are all legal INSIDE a key segment
 * and none of the three opens one, so a stem beginning with any of them builds a key
 * resolveKey throws on, and the upload is refused for the wrong reason forever.
 */
const trimEdges = (s: string): string => {
  const chars = Array.from(s.replace(/[. ]+$/, ''));
  let head = 0;
  while (head < chars.length && !SEGMENT_START.test(chars[head])) head += 1;
  return chars.slice(head).join('');
};

/**
 * Windows resolves a name whose part before the first dot is one of these to the
 * device, whatever follows - `con.txt` is CON. The superscript digits are in the
 * list because Windows is.
 */
const WINDOWS_DEVICE = /^(?:CON|PRN|AUX|NUL|COM[0-9\u00b9\u00b2\u00b3]|LPT[0-9\u00b9\u00b2\u00b3]) *$/i;

/**
 * The user's filename reduced to what every filesystem accepts: the last path
 * segment, its extension dropped, every other character replaced.
 *
 * Prefixed whenever the part before the stem's first dot is a device name. Only a stem
 * with a dot in it needs that, since otherwise the id follows the device name before
 * any dot; but narrowing the test to that shape renames the stored file of every upload
 * it stops matching, and a renamed key reads as a statement that is not on this disk.
 */
export function documentStem(originalFilename: string | null): string {
  const base = (originalFilename ?? '').split(/[\\/]/).pop() ?? '';
  const stem = base.replace(/\.[^.]*$/, '');
  const cleaned = Array.from(stem)
    .filter((c) => c.length > 1 || c < '\ud800' || c > '\udfff')
    .map((c) => (STEM_CHAR.test(c) ? c : '_'))
    .join('')
    .replace(/\s+/g, ' ');
  const bounded = trimEdges(Array.from(trimEdges(cleaned)).slice(0, STEM_MAX).join(''));
  if (!bounded) return 'statement';
  return WINDOWS_DEVICE.test(bounded.split('.')[0]) ? `_${bounded}` : bounded;
}

/**
 * No `_`, no capital letter, and never the digest's own shape: those absences are
 * half of what makes a key name one row. A key is read from its right: the format
 * back to the last `.`, the id back to the last `_` before it, the stem the rest. So
 * the id may not carry `_` and the format may not carry `.`; documentKey holds the
 * format's half.
 *
 * `_` is what documentKey puts between the stem and the id, and the stem may contain
 * one. If the id could too, one key would have two readings: a row carrying
 * `original_filename` "a_b" and id "c" and a row carrying "a" and id "b_c" both
 * derive one key. A restored backup chooses both fields, so it could aim a row at
 * a statement it does not own and have DELETE unlink that one instead.
 *
 * The disk decides whether two keys are one file, and the default disks on macOS and
 * Windows do not tell case apart: written verbatim, a minted id with its letters
 * capitalised is another row and the same file. So both arms emit lowercase only,
 * where a case-blind disk and a byte comparison agree, and the verbatim arm never
 * spells a digest, so two different ids never share a segment.
 *
 * Nothing is given up. Every id this server mints is a crypto.randomUUID(), which is
 * lowercase hex and dashes, so no key this code has ever produced changes - and an id
 * that fails the shape still names a file, by the hash arm below.
 */
const ID_SHAPE = /^(?![0-9a-f]{32}$)[a-z0-9-]{1,64}$/;

/** An id this server minted goes in verbatim; one a restored backup carried is hashed so it can still name a file. */
const idSegment = (importId: string): string =>
  ID_SHAPE.test(importId)
    ? importId
    : crypto.createHash('sha256').update(importId).digest('hex').slice(0, 32);

/**
 * Refuses a format outside the list rather than trusting the column: the format ends
 * the name, so one carrying a `.` or `_` would let this row's fields spell another
 * row's file, and the column's check is missing from every database created before it.
 */
const storedFormat = (sourceType: string): boolean =>
  (IMPORT_SOURCE_TYPES as readonly string[]).includes(sourceType);

export const documentKey = (doc: DocumentLocator): string => {
  if (!storedFormat(doc.sourceType)) {
    throw new Error(`import ${doc.importId} records a format this app does not store files under`);
  }
  return `${documentStem(doc.originalFilename)}_${idSegment(doc.importId)}.${doc.sourceType}`;
};

/**
 * A constant, so the sentence is asserted by equality: a regex over paths and errnos
 * passes a message somebody has "improved" to splice in a cause chain that happens to
 * carry no drive letter, and that is how a filesystem path reaches a screen. It is
 * actionable in the only way this failure is - the bytes are still the user's to
 * re-upload - because committing without the document would claim the file hash forever.
 */
export const DOCUMENT_STORE_REFUSED =
  "could not store the uploaded file, so the import was refused - nothing was written, and the same file can be uploaded again once the statements folder is writable";

/**
 * Says READ, never "kept": the row's claim survives a restore, and the file it names
 * is on the disk it was uploaded to and on no other. This is the answer for both -
 * a row that never had a document, and a restored row whose file is elsewhere.
 */
export const DOCUMENT_NOT_READABLE = 'this import has no file this app can read';

/**
 * There is no file under the row's key. Separated from every other read failure by a
 * class rather than by a message, because the two get different status codes: nothing
 * is wrong with a restored row whose statement was left on the other machine, and a
 * message match would break the moment somebody improves the sentence.
 */
export class DocumentMissing extends Error {}

/**
 * Neither names an action, because there is none for the user to take; what they do say
 * is which way the state went, so nobody is told a statement is gone while it is held.
 */
export const DOCUMENT_READ_REFUSED =
  "the stored copy of this file could not be read, so nothing was sent - your imported data is unaffected, and the log names the reason";

export const DOCUMENT_DELETE_REFUSED =
  "the stored copy of this file could not be removed, so nothing was changed - it is still held, and the log names the reason";

/** The cause goes to the log whole; the user gets a sentence with no path, no errno and no filename in it. */
export async function putDocument(doc: DocumentLocator, bytes: Buffer): Promise<void> {
  const key = documentKey(doc);
  try {
    await putObject(key, bytes);
  } catch (e) {
    logImport.error({ err: e }, `document ${key} could not be stored: ${causeChain(e)}`);
    throw new Error(DOCUMENT_STORE_REFUSED, { cause: e });
  }
}

/**
 * The bytes or a throw, never an empty value: a row claiming bytes that are gone is a
 * lie, and a re-parse job must meet a throw rather than something it can read as
 * "nothing to do". The hash check is what turns a file edited in the folder into a
 * refusal instead of a re-import of somebody's edits.
 */
export async function getDocument(ref: DocumentRef): Promise<Buffer> {
  const key = documentKey(ref);
  const bytes = await getObject(key);
  if (!bytes) {
    throw new DocumentMissing(
      `import ${ref.importId} records a stored document, but there is no file at ${key}`,
    );
  }
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  if (hash !== ref.fileHash) {
    throw new Error(`the file at ${key} is not the one import ${ref.importId} recorded`);
  }
  return bytes;
}

/** A missing file is not a failure: most imports never had one, or the user removed it by hand. */
export async function deleteDocument(doc: DocumentLocator): Promise<boolean> {
  // nothing to remove rather than a refusal: no upload ever stored a file under such a
  // format, the name it derives may be another row's file, and refusing would leave
  // the row's account impossible to delete
  if (!storedFormat(doc.sourceType)) return false;
  const key = documentKey(doc);
  try {
    return await deleteObject(key);
  } catch (e) {
    throw new Error(`the stored document at ${key} could not be removed`, { cause: e });
  }
}
