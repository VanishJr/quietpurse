/**
 * Source documents: the uploaded statement itself, kept encrypted at rest
 * (ROADMAP 4.5, 6.1) so that a better parser can re-run it later and so that "my
 * import came out wrong" is diagnosable at all. One document per `imports` row,
 * keyed by the import id and dying with it - never keyed by the file hash, which
 * would let a failed import and a committed one of the same bytes share a blob.
 *
 * The states this ordering produces, and which of them are accepted:
 *  - a document whose import row never existed CANNOT happen: the put is strictly
 *    after createImport;
 *  - bytes on disk with `document_key_version` not yet set is the one crash
 *    window, and it is on the garbage side rather than the lie side - nothing
 *    claims a document that is not there, and deleteImport removes the blob
 *    whatever the pointer says, so it stays collectable;
 *  - a `pending` or a `failed` import holding a document is not a defect. The
 *    failed case is the point (4.5): the input is what support needs;
 *  - a blob whose row no longer exists at all - a restore deletes the workspace's
 *    `imports` rows - is reachable by nothing. No sweeper is in scope; it is
 *    written up for ROADMAP 6.1 rather than fixed here.
 */
import crypto from 'crypto';
import { config } from './config';
import { currentWorkspaceId } from './db/workspace';
import { causeChain, logImport } from './logger';
import { deleteObject, getObject, putObject } from './storage';

/**
 * What a key may be built from. Deliberately narrow: deleteImport has to address a
 * document for a row whose pointer is NULL, so a layout may depend only on what it
 * can supply from the row it is deleting. A layout wanting more - say
 * `<workspace>/<yyyy>/<importId>` - has to widen this type AND widen the select in
 * deleteImport in the same change, and tsc will not let one happen without the other.
 */
type DocumentKeyContext = { workspaceId: string; importId: string };

/**
 * Every key layout this server has ever written, by version. Adding one is adding
 * an entry here: putDocument writes under the newest, the row records which one,
 * and deleteDocument tries all of them - so there is no version list anywhere that
 * can be forgotten.
 *
 * The workspace segment is the raw id rather than a hash of it: hashing would
 * guarantee the segment always satisfies the storage charset, which turns "a
 * workspace id this system did not expect" from a loud refusal into a silently
 * accepted value, and an operator answering "delete everything for workspace X"
 * could no longer do it with ls and rm.
 */
const DOCUMENT_KEY_LAYOUTS: Record<number, (ctx: DocumentKeyContext) => string> = {
  1: ({ workspaceId, importId }) => `${workspaceId}/${importId}`,
};

const KEY_VERSIONS = Object.keys(DOCUMENT_KEY_LAYOUTS).map(Number);

/** The layout new documents are written under: the newest the registry holds. */
export const CURRENT_KEY_VERSION = Math.max(...KEY_VERSIONS);

/** Whether a version a row claims is one this server can address at all. */
export const knowsKeyVersion = (version: number): boolean => version in DOCUMENT_KEY_LAYOUTS;

const ENVELOPE_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** version | key id | IV | tag, then the ciphertext. */
const HEADER_BYTES = 2 + IV_BYTES + TAG_BYTES;

const KEY_SALT = 'finto-document-store-v1';

export interface DocumentKey {
  /** the AES-256-GCM key */
  key: Buffer;
  /** the byte stamped at offset 1 of the envelope */
  id: number;
}

/**
 * Key and id from one secret, in one frozen object: there is no way to hold a key
 * without its id, and no way to seal with key A while stamping id B. HKDF rather
 * than "the env var must be exactly 32 base64 bytes" - whatever
 * `openssl rand -base64 32` or a password manager produced works, the same
 * paste-anything ergonomics as BETTER_AUTH_SECRET.
 *
 * The id is derived rather than a constant so that a changed DOCUMENT_ENCRYPTION_KEY
 * - the single most likely operational mistake, and the one assertProductionConfig
 * actively pushes an operator to make on their first deploy - is diagnosed as
 * "sealed with key id N, this server holds M" instead of as a corrupted file. It
 * moves by itself if the salt, the info strings or the derivation ever change; a
 * literal would have to be remembered.
 *
 * The honest limit: one byte is 256 values, so a mismatching id proves the key is
 * wrong and a matching one proves nothing. The GCM tag stays the authority, and in
 * the 1-in-256 case the reader falls through to the integrity message - which is
 * what it would have said anyway.
 *
 * Rotation's exit, recorded before it is needed: the day a second key is held the
 * reader picks by id, and two keys whose derived ids collide are indistinguishable.
 * The envelope byte cannot be widened for documents already written, so the exit is
 * that boot refuses two configured keys with the same derived id and the operator
 * regenerates one.
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
 * The two header bytes followed by the storage key. Binding the key into the AEAD
 * is a third net under a crafted restore: a document copied from one workspace's
 * directory into another's fails its tag before anything is decrypted. It also
 * pins the version and key id bytes - editing either to reach a different reader
 * breaks the tag.
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
 * The tag sits in the header rather than being appended (the usual convention, and
 * equally safe) for one reason: the ciphertext is then buf.subarray(30), with no
 * arithmetic measured from the end, so no truncation can produce a slice that is
 * accidentally well-formed.
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
 * Everything throws; nothing degrades. The version and key id are checked BEFORE
 * any decrypt is attempted, so the message names the actual problem instead of
 * reporting a tag failure - ROADMAP 6.4 is on the record about what a wrong
 * diagnostic costs here.
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

/**
 * What a reader needs to open a document. The file hash travels with it so that
 * getDocument can check what it decrypted against what the import recorded, and
 * the only honest way to obtain one is getImportDocumentRef (db/index.ts) - there
 * is no overload that skips the check.
 */
export interface DocumentRef {
  importId: string;
  keyVersion: number;
  fileHash: string;
}

/**
 * What a user is told when the document cannot be stored. A constant, because the
 * test asserts equality with it: a regex for paths and errnos passes on a message
 * that has been "improved" to splice in a cause chain which happens not to contain
 * a drive letter, and that is how a filesystem path reaches a screen one refactor
 * from now.
 *
 * It is actionable in the only way this failure is actionable - the bytes are
 * still the user's to re-upload, which is the fact a refusal exists to preserve:
 * committing without the document would claim the file hash forever.
 */
export const DOCUMENT_STORE_REFUSED =
  "could not store the uploaded file, so the import was refused - nothing was written, and the same file can be uploaded again once the server's storage is working";

/**
 * The 404 on the download route. It says READ, never "kept": NULL in
 * `document_key_version` records readability, and a row restored from a backup has
 * its pointer stripped while its bytes are still on disk - so asserting that no
 * document is held would be a claim this server cannot make.
 */
export const DOCUMENT_NOT_READABLE = 'this import has no document this server can read';

/**
 * The two operator-caused refusals, constants for DOCUMENT_STORE_REFUSED's reason.
 * Neither names an action, because there is none for the user to take; what they do
 * say is which way the state went, so nobody is told a statement is gone while it is
 * still held.
 */
export const DOCUMENT_READ_REFUSED =
  "the stored copy of this file could not be read, so nothing was sent - your imported data is unaffected, and the server's log names the reason";

export const DOCUMENT_DELETE_REFUSED =
  "the stored copy of this file could not be removed, so nothing was changed - it is still held, and the server's log names the reason";

function keyFor(version: number, workspaceId: string, importId: string): string {
  const layout = DOCUMENT_KEY_LAYOUTS[version];
  if (!layout) {
    // never fall back to version 1: that reads a different file's bytes under a
    // plausible-looking key. A row written by a newer build then rolled back
    throw new Error(
      `import ${importId} records a document written under key layout ${version}, and this server knows ${KEY_VERSIONS.join(', ')}`,
    );
  }
  return layout({ workspaceId, importId });
}

/**
 * Stores the uploaded bytes for an import and answers which layout they went
 * under - the caller hands that straight to recordImportDocument, so the row
 * cannot claim a version the writer did not use.
 *
 * The cause goes to the log, including the whole chain (ROADMAP 6.4) and at
 * `error`; the user gets a sentence with no path, no errno and no filename in it.
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
 * The decrypted bytes, or a throw - never an empty value. A row that claims a
 * document whose bytes are gone (a silently erased volume, a blob removed by hand)
 * is a lie, and a re-parse job must meet a throw rather than something it can read
 * as "nothing to do".
 *
 * The key is DERIVED from (current workspace, import id) and never read out of the
 * row: a stored key is a string a crafted backup gets to choose, and one workspace
 * would then read another's statement through a path no WHERE clause is near.
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
 * Removes an import's document under EVERY layout this server knows, and takes no
 * key version - there is no argument a caller can get wrong and no pointer to
 * consult. That is deliberate: `document_key_version` says whether a document can
 * be READ, never whether bytes exist, and the rows most likely to still have some
 * are exactly the ones whose pointer is NULL (restored, or crashed between the put
 * and recordImportDocument). A delete filtered on the pointer would leave those
 * bank statements on disk with no path that ever revisits them.
 *
 * Answers whether anything was removed. A missing object is not a failure.
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
