import crypto from 'crypto';
import { config } from './config';
import { currentWorkspaceId } from './db/workspace';
import { causeChain, logImport } from './logger';
import { deleteObject, getObject, putObject } from './storage';

/**
 * Deliberately narrow: a layout may depend only on what deleteImport can supply from
 * the row it is deleting, so widening this type and widening that select are one
 * change tsc will not let happen by halves.
 */
type DocumentKeyContext = { workspaceId: string; importId: string };

/** Entries are never removed: a row may still record an old layout, and deleteDocument tries them all. */
const DOCUMENT_KEY_LAYOUTS: Record<number, (ctx: DocumentKeyContext) => string> = {
  1: ({ workspaceId, importId }) => `${workspaceId}/${importId}`,
};

const KEY_VERSIONS = Object.keys(DOCUMENT_KEY_LAYOUTS).map(Number);

export const CURRENT_KEY_VERSION = Math.max(...KEY_VERSIONS);

export const knowsKeyVersion = (version: number): boolean => version in DOCUMENT_KEY_LAYOUTS;

const ENVELOPE_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** version | key id | IV | tag, then the ciphertext. */
const HEADER_BYTES = 2 + IV_BYTES + TAG_BYTES;

const KEY_SALT = 'finto-document-store-v1';

export interface DocumentKey {
  key: Buffer;
  /** the byte stamped at offset 1 of the envelope */
  id: number;
}

/**
 * Key and id come out of one secret together, in a frozen object: there is no way to
 * hold a key without its id, and no way to seal with key A while stamping id B. HKDF
 * rather than a fixed-length secret, so whatever a password manager produced works.
 *
 * The id is derived rather than written down so that a changed DOCUMENT_ENCRYPTION_KEY
 * is diagnosed as the wrong key instead of as a corrupted file, and so that it moves
 * by itself when the salt, the info strings or the derivation do. Its honest limit: one
 * byte means a mismatch proves the key is wrong and a match proves nothing - the GCM
 * tag stays the authority.
 */
export function deriveDocumentKey(secret: string): DocumentKey {
  const hkdf = (info: string, length: number): Buffer =>
    Buffer.from(crypto.hkdfSync('sha256', secret, KEY_SALT, info, length));
  return Object.freeze({
    key: hkdf('aes-256-gcm-key', 32),
    id: hkdf('document-key-id', 1)[0],
  });
}

let cached: DocumentKey | undefined;
let cachedSecret: string | undefined;

function documentKeys(): DocumentKey {
  if (!cached || cachedSecret !== config.documentEncryptionKey) {
    cachedSecret = config.documentEncryptionKey;
    cached = deriveDocumentKey(cachedSecret);
  }
  return cached;
}

/**
 * The storage key is in the AEAD so a document copied from one workspace's directory
 * into another's fails its tag before anything is decrypted, and so editing the version
 * or key id byte to reach a different reader breaks it too.
 */
const aad = (header: Buffer, storageKey: string): Buffer =>
  Buffer.concat([header.subarray(0, 2), Buffer.from(storageKey, 'utf8')]);

/**
 * AES-256-GCM in a self-describing envelope, so a truncated file, a corrupted file
 * or the wrong key throws on read instead of yielding plausible bytes for a
 * re-parser to import:
 *
 *    0   1  envelope version
 *    1   1  key id
 *    2  12  IV, fresh per document
 *   14  16  GCM tag
 *   30   N  ciphertext
 *
 * The tag is in the header rather than appended - equally safe, and it puts the
 * ciphertext at a fixed offset with no arithmetic measured from the end, so no
 * truncation can produce a slice that is accidentally well-formed.
 */
export function sealDocument(plain: Buffer, storageKey: string, keys = documentKeys()): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  header[0] = ENVELOPE_VERSION;
  header[1] = keys.id;
  const iv = crypto.randomBytes(IV_BYTES);
  iv.copy(header, 2);

  const cipher = crypto.createCipheriv('aes-256-gcm', keys.key, iv);
  cipher.setAAD(aad(header, storageKey));
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  cipher.getAuthTag().copy(header, 2 + IV_BYTES);
  return Buffer.concat([header, ciphertext]);
}

/**
 * Everything throws; nothing degrades. Version and key id are checked BEFORE any
 * decrypt, so the message names the real problem instead of a tag failure.
 */
export function openDocument(sealed: Buffer, storageKey: string, keys = documentKeys()): Buffer {
  if (sealed.length < HEADER_BYTES) {
    throw new Error(
      `stored document is truncated (${sealed.length} bytes, the header alone is ${HEADER_BYTES})`,
    );
  }
  if (sealed[0] !== ENVELOPE_VERSION) {
    throw new Error(
      `stored document has envelope version ${sealed[0]}, which this server cannot read`,
    );
  }
  if (sealed[1] !== keys.id) {
    throw new Error(
      `stored document was sealed with key id ${sealed[1]} and this server holds key id ${keys.id} - DOCUMENT_ENCRYPTION_KEY is not the key this document was written with`,
    );
  }

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    keys.key,
    sealed.subarray(2, 2 + IV_BYTES),
  );
  decipher.setAAD(aad(sealed, storageKey));
  decipher.setAuthTag(sealed.subarray(2 + IV_BYTES, HEADER_BYTES));
  try {
    return Buffer.concat([decipher.update(sealed.subarray(HEADER_BYTES)), decipher.final()]);
  } catch (e) {
    throw new Error('stored document failed its integrity check', { cause: e });
  }
}

/** The file hash travels with the ref so getDocument can check what it decrypted against what the import recorded. */
export interface DocumentRef {
  importId: string;
  keyVersion: number;
  fileHash: string;
}

/**
 * A constant, so the sentence is asserted by equality: a regex over paths and errnos
 * passes a message somebody has "improved" to splice in a cause chain that happens to
 * carry no drive letter, and that is how a filesystem path reaches a screen. It is
 * actionable in the only way this failure is - the bytes are still the user's to
 * re-upload - because committing without the document would claim the file hash forever.
 */
export const DOCUMENT_STORE_REFUSED =
  "could not store the uploaded file, so the import was refused - nothing was written, and the same file can be uploaded again once the server's storage is working";

/** Says READ, never "kept": a restored row's pointer is stripped while its bytes are still on disk. */
export const DOCUMENT_NOT_READABLE = 'this import has no document this server can read';

/**
 * Neither names an action, because there is none for the user to take; what they do say
 * is which way the state went, so nobody is told a statement is gone while it is held.
 */
export const DOCUMENT_READ_REFUSED =
  "the stored copy of this file could not be read, so nothing was sent - your imported data is unaffected, and the server's log names the reason";

export const DOCUMENT_DELETE_REFUSED =
  "the stored copy of this file could not be removed, so nothing was changed - it is still held, and the server's log names the reason";

function keyFor(version: number, workspaceId: string, importId: string): string {
  const layout = DOCUMENT_KEY_LAYOUTS[version];
  if (!layout) {
    // never fall back to version 1: that reads a different file's bytes under a
    // plausible-looking key
    throw new Error(
      `import ${importId} records a document written under key layout ${version}, and this server knows ${KEY_VERSIONS.join(', ')}`,
    );
  }
  return layout({ workspaceId, importId });
}

/**
 * Answers the layout the bytes went under, so the row cannot claim a version the
 * writer did not use. The cause goes to the log whole; the user gets a sentence with
 * no path, no errno and no filename in it.
 */
export async function putDocument(importId: string, bytes: Buffer): Promise<number> {
  // outside the try on purpose: "no workspace context" has to surface as itself
  // rather than be flattened into a storage refusal (db/workspace.ts)
  const workspaceId = currentWorkspaceId();
  const key = keyFor(CURRENT_KEY_VERSION, workspaceId, importId);
  try {
    await putObject(key, sealDocument(bytes, key));
  } catch (e) {
    logImport.error({ err: e }, `document ${key} could not be stored: ${causeChain(e)}`);
    throw new Error(DOCUMENT_STORE_REFUSED, { cause: e });
  }
  return CURRENT_KEY_VERSION;
}

/**
 * The decrypted bytes or a throw, never an empty value: a row claiming bytes that are
 * gone is a lie, and a re-parse job must meet a throw rather than something it can
 * read as "nothing to do".
 *
 * The key is DERIVED from the current workspace and the import id, never read out of
 * the row - a stored key is a string a crafted backup gets to choose, and one
 * workspace would then read another's statement through a path no WHERE clause is near.
 */
export async function getDocument(ref: DocumentRef): Promise<Buffer> {
  const key = keyFor(ref.keyVersion, currentWorkspaceId(), ref.importId);
  const sealed = await getObject(key);
  if (!sealed) {
    throw new Error(
      `import ${ref.importId} records a stored document, but there are no bytes at ${key}`,
    );
  }
  const plain = openDocument(sealed, key);
  const hash = crypto.createHash('sha256').update(plain).digest('hex');
  if (hash !== ref.fileHash) {
    throw new Error(
      `the stored document at ${key} does not match the file import ${ref.importId} recorded`,
    );
  }
  return plain;
}

/**
 * Takes no key version and tries every layout: there is no argument a caller can get
 * wrong and no pointer to consult. A delete filtered on the pointer would skip exactly
 * the rows most likely to still have bytes, and leave those bank statements on disk
 * with no path that ever revisits them.
 *
 * A missing object is not a failure.
 */
export async function deleteDocument(importId: string): Promise<boolean> {
  const workspaceId = currentWorkspaceId();
  let removed = false;
  const failures: { key: string; error: unknown }[] = [];
  for (const layout of Object.values(DOCUMENT_KEY_LAYOUTS)) {
    const key = layout({ workspaceId, importId });
    try {
      if (await deleteObject(key)) removed = true;
    } catch (e) {
      failures.push({ key, error: e });
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `the stored document at ${failures.map((f) => f.key).join(', ')} could not be removed`,
      { cause: failures[0].error },
    );
  }
  return removed;
}
