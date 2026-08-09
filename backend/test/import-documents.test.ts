/**
 * The document routes (ROADMAP 4.5, 6.1): downloading the uploaded statement back,
 * and deleting it while the import row, its transactions and its provenance stay.
 *
 * Driven over real HTTP with a real session, like upload.test.ts - a document is
 * reached through a key whose first segment is the CURRENT workspace, so which
 * workspace the request landed in is half of what these routes are. The
 * process-wide fallback is cleared for the duration for the same reason it is
 * there: with it armed a request that never entered a context would answer from
 * the test workspace instead of throwing.
 */
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { app, attachmentDisposition } from '../src/app';
import { initAuth } from '../src/auth';
import {
  clearImportDocument,
  createImport,
  dbInstance,
  recordImportDocument,
  runWithWorkspace,
  setWorkspaceFallback,
} from '../src/db';
import {
  DOCUMENT_DELETE_REFUSED,
  DOCUMENT_NOT_READABLE,
  DOCUMENT_READ_REFUSED,
  putDocument,
} from '../src/documents';
import { logImport } from '../src/logger';
import { storageRoot } from '../src/storage';
import { TEST_WORKSPACE_ID } from './pglite';

const csvFor = (label: string): Buffer =>
  Buffer.from(['date,amount,description', `2026-03-01,-10.00,${label}`].join('\n'), 'utf8');

let agent: request.Agent;
/** The signed-up user's own workspace - where the blobs on disk actually are. */
let workspaceId: string;

interface Uploaded {
  importId: string;
  bytes: Buffer;
}

async function upload(label: string, filename = 'statement.csv'): Promise<Uploaded> {
  const bytes = csvFor(label);
  const res = await agent
    .post('/api/imports')
    .field('accountName', label)
    .field('currency', 'EUR')
    .field('preset', 'generic')
    .attach('file', bytes, filename);
  expect(res.status, `upload failed: ${JSON.stringify(res.body)}`).toBe(200);
  return { importId: res.body.summary.importId as string, bytes };
}

async function committed(label: string, filename = 'statement.csv'): Promise<Uploaded> {
  const up = await upload(label, filename);
  const res = await agent.post(`/api/imports/${up.importId}/confirm`);
  expect(res.status, `confirm failed: ${JSON.stringify(res.body)}`).toBe(200);
  return up;
}

interface ImportRow {
  id: string;
  status: string;
  accountName: string | null;
  originalFilename: string | null;
  documentAvailable: boolean;
  transactions: number;
}

const importRows = async (): Promise<ImportRow[]> =>
  (await agent.get('/api/imports')).body.imports as ImportRow[];

const importRow = async (id: string): Promise<ImportRow | undefined> =>
  (await importRows()).find((i) => i.id === id);

/** Where this workspace's blob for an import sits - spelled out, not asked for. */
const blobOf = (importId: string): string => path.join(storageRoot(), workspaceId, importId);

const blobExists = (importId: string): Promise<boolean> =>
  fs
    .access(blobOf(importId))
    .then(() => true)
    .catch(() => false);

beforeAll(async () => {
  initAuth(dbInstance());
  setWorkspaceFallback(undefined);

  agent = request.agent(app);
  const signUp = await agent
    .post('/api/auth/sign-up/email')
    .send({ email: 'documents@example.com', password: 'correct-horse-battery', name: 'documents' });
  expect(signUp.status, `sign-up failed: ${JSON.stringify(signUp.body)}`).toBeLessThan(300);

  const seed = await committed('Workspace Probe');
  const found = (await dbInstance().execute(
    sql`SELECT workspace_id FROM imports WHERE id = ${seed.importId}`,
  )) as unknown as { rows: { workspace_id: string }[] };
  workspaceId = found.rows[0].workspace_id;
});

afterAll(() => {
  // the fallback is process-wide - the rest of the run expects it armed
  setWorkspaceFallback(TEST_WORKSPACE_ID);
});

describe('GET /api/imports/:id/document', () => {
  it('answers the uploaded bytes, as an attachment nothing will sniff', async () => {
    const { importId, bytes } = await committed('Download Bank');

    const res = await agent.get(`/api/imports/${importId}/document`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual(bytes);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="statement.csv"; filename*=UTF-8''statement.csv`,
    );
  });

  /**
   * One sentence for an absent id, a neighbour's id and a row with no readable
   * document: the select is workspace-scoped, so they are one code path, and a
   * sentence per case would make the route an existence oracle. Asserted by
   * identity - it must keep saying READ rather than "kept" (a restored row has its
   * pointer stripped while its bytes are still on disk).
   */
  it('answers one 404 for an unknown import and for a row with no readable document', async () => {
    const unknown = await agent.get('/api/imports/no-such-import/document');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe(DOCUMENT_NOT_READABLE);

    const pointerless = await runWithWorkspace(workspaceId, () =>
      createImport({ fileHash: 'no-document-at-all', sourceType: 'csv', parserVersion: 1 }),
    );
    const res = await agent.get(`/api/imports/${pointerless.id}/document`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe(DOCUMENT_NOT_READABLE);
  });

  /** The imports that went wrong are exactly the ones the input is wanted for. */
  it('downloads the document of a failed and of a discarded import', async () => {
    const unparseable = Buffer.from(['col a;col b;col c', '05.02.2026;-11,00;Kiosk'].join('\n'), 'utf8');
    const failed = await agent
      .post('/api/imports')
      .field('accountName', 'Failed Bank')
      .field('currency', 'EUR')
      .field('preset', 'generic')
      .attach('file', unparseable, 'broken.csv');
    expect(failed.status).toBe(400);

    const failedRow = (await importRows()).find((i) => i.status === 'failed')!;
    expect(failedRow.documentAvailable).toBe(true);
    const failedDoc = await agent.get(`/api/imports/${failedRow.id}/document`);
    expect(failedDoc.status).toBe(200);
    expect(failedDoc.body).toEqual(unparseable);

    const staged = await upload('Discarded Bank');
    expect((await agent.post(`/api/imports/${staged.importId}/discard`)).status).toBe(200);
    const discardedDoc = await agent.get(`/api/imports/${staged.importId}/document`);
    expect(discardedDoc.status).toBe(200);
    expect(discardedDoc.body).toEqual(staged.bytes);
  });

  /**
   * The row claims a readable document and the bytes are gone: 500, not 400 and not
   * a 200 with something in it. The user's file is not at fault, and the sentence
   * carries no path, no errno and no filename - those are the log's.
   */
  it('answers 500 when the row claims a document whose bytes are gone', async () => {
    const { importId } = await committed('Vanished Bank');
    await fs.rm(blobOf(importId), { force: true });

    const res = await agent.get(`/api/imports/${importId}/document`);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe(DOCUMENT_READ_REFUSED);
    expect(res.body.error).not.toMatch(/[A-Za-z]:\\|\/tmp\/|ENOENT|statement\.csv/);
  });
});

describe('DELETE /api/imports/:id/document', () => {
  it('removes the bytes and keeps the import, its transactions and its provenance', async () => {
    const { importId } = await committed('Delete Document Bank');
    const before = (await importRow(importId))!;
    expect(before.documentAvailable).toBe(true);
    expect(await blobExists(importId)).toBe(true);

    const res = await agent.delete(`/api/imports/${importId}/document`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ deleted: true, importId, bytesRemoved: true });
    expect(await blobExists(importId)).toBe(false);

    const after = (await importRow(importId))!;
    expect(after.documentAvailable).toBe(false);
    expect(after).toMatchObject({
      status: before.status,
      accountName: before.accountName,
      originalFilename: before.originalFilename,
      transactions: before.transactions,
    });
    expect(after.transactions).toBe(1);
    expect((await agent.get(`/api/imports/${importId}/document`)).status).toBe(404);
  });

  /**
   * The second call has nothing to remove and must still answer 200: the 404 is on
   * the ROW, never on the pointer, or a retention policy silently retains every row
   * whose pointer was already NULL - and those are the rows most likely to still
   * have bytes (restored, or crashed between the put and recordImportDocument).
   */
  it('is idempotent, and runs on a row that never claimed a document', async () => {
    const { importId } = await committed('Twice Bank');

    const first = await agent.delete(`/api/imports/${importId}/document`);
    expect(first.body).toEqual({ deleted: true, importId, bytesRemoved: true });
    const second = await agent.delete(`/api/imports/${importId}/document`);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ deleted: true, importId, bytesRemoved: false });

    const never = await runWithWorkspace(workspaceId, () =>
      createImport({ fileHash: 'never-had-a-document', sourceType: 'csv', parserVersion: 1 }),
    );
    const res = await agent.delete(`/api/imports/${never.id}/document`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, importId: never.id, bytesRemoved: false });
    expect(await importRow(never.id)).toBeDefined();
  });

  it('answers 404 for an import this workspace does not hold', async () => {
    const res = await agent.delete('/api/imports/no-such-import/document');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('import not found');
  });

  /**
   * The existence check runs before any disk access. With it after deleteDocument,
   * an id with no row here still unlinks the blob at <this workspace>/<id> - the
   * orphan a restore produces, since it replaces the imports rows while the bytes
   * stay - and then answers "not found": destroyed, and the answer says nothing
   * happened. The case above cannot see this, because no blob exists for that id.
   */
  it('does not touch the disk for an id this workspace has no row for', async () => {
    await runWithWorkspace(workspaceId, () => putDocument('orphan-no-row', csvFor('Orphan')));
    expect(await blobExists('orphan-no-row')).toBe(true);

    const res = await agent.delete('/api/imports/orphan-no-row/document');
    expect(res.status).toBe(404);
    expect(await blobExists('orphan-no-row')).toBe(true);
  });

  /**
   * The one place this route knowingly leaves bytes on disk with the pointer
   * cleared: deleteDocument tried every layout this server knows and the row's is
   * not one of them. That trade was accepted only because the log names it, so the
   * log is what this asserts - an operator with the import id is the whole recovery.
   *
   * Seeded with createImport alone, deliberately: a real upload behind it puts real
   * bytes at the layout-1 key, deleteDocument removes those, bytesRemoved comes back
   * true and the case stops describing the branch.
   */
  it('logs a key layout it cannot address, and still answers 200', async () => {
    const row = await runWithWorkspace(workspaceId, async () => {
      const created = await createImport({
        fileHash: 'unknown-layout-row',
        sourceType: 'csv',
        parserVersion: 1,
      });
      await recordImportDocument(created.id, 99);
      return created;
    });

    const err = vi.spyOn(logImport, 'error').mockImplementation(() => {});
    const res = await agent.delete(`/api/imports/${row.id}/document`);
    // read before restoring: mockRestore clears the calls with the implementation
    const logged = err.mock.calls.map((args) => String(args[0]));
    err.mockRestore();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, importId: row.id, bytesRemoved: false });
    expect((await importRow(row.id))!.documentAvailable).toBe(false);
    expect(logged.join(' | ')).toContain('key layout 99');
  });

  /**
   * The ordering invariant, and the only thing holding it: the bytes go first and
   * the pointer only once they are gone. Swap the two statements and this goes red
   * while every other case here stays green - the route still answers 500, but the
   * row has already stopped claiming a document whose bytes are still on disk, and
   * nothing would ever revisit them.
   *
   * The failure is forced with a non-empty directory where the blob belongs, so the
   * unlink fails with something that is not ENOENT on every platform this runs on
   * (imports.test.ts uses the same trick).
   */
  it('leaves the pointer alone when the bytes cannot be removed', async () => {
    const { importId } = await committed('Stuck Delete Bank');
    const blob = blobOf(importId);
    await fs.rm(blob, { force: true });
    await fs.mkdir(path.join(blob, 'inner'), { recursive: true });

    try {
      const res = await agent.delete(`/api/imports/${importId}/document`);
      expect(res.status).toBe(500);
      expect(res.body.error).toBe(DOCUMENT_DELETE_REFUSED);
      // still there, and the row still says so: the user has NOT been told it is gone
      expect((await importRow(importId))!.documentAvailable).toBe(true);
      expect(await blobExists(importId)).toBe(true);
    } finally {
      await fs.rm(blob, { recursive: true, force: true });
    }
  });
});

/**
 * original_filename is a string the user chose and it becomes a header value: a
 * CRLF splits the response, a `"` ends the quoted string early, a `..\` is a path
 * the client would save under, and anything above U+00FF makes setHeader throw.
 * The emitted value is asserted, not the status code - a 200 says nothing about
 * what the header contains.
 */
/**
 * ROADMAP 6.1: an account delete is the second path that removes stored documents,
 * and the only one that removes several at once. The bytes go for EVERY import it
 * destroys whatever the pointer said - document_key_version records whether a
 * document can be READ, never whether bytes are on disk, and the rows most likely
 * to still have some are exactly the ones whose pointer is NULL.
 */
describe('DELETE /api/accounts/:id takes the stored statements with it', () => {
  const statement = (amount: string, label: string): Buffer =>
    Buffer.from(['date,amount,description', `2026-03-01,${amount},${label}`].join('\n'), 'utf8');

  const commitInto = async (accountName: string, bytes: Buffer) => {
    const res = await agent
      .post('/api/imports')
      .field('accountName', accountName)
      .field('currency', 'EUR')
      .field('preset', 'generic')
      .attach('file', bytes, 'statement.csv');
    expect(res.status, `upload failed: ${JSON.stringify(res.body)}`).toBe(200);
    const { importId, accountId } = res.body.summary as { importId: string; accountId: string };
    const confirmed = await agent.post(`/api/imports/${importId}/confirm`);
    expect(confirmed.status, `confirm failed: ${JSON.stringify(confirmed.body)}`).toBe(200);
    return { importId, accountId };
  };

  it('removes the bytes of a readable document and of one whose pointer is gone', async () => {
    const readable = await commitInto('Blob Account', statement('-21.00', 'blob one'));
    const pointerless = await commitInto('Blob Account', statement('-22.00', 'blob two'));
    expect(pointerless.accountId).toBe(readable.accountId);

    // the pointer alone, leaving the bytes where they are: what a restored backup
    // produces (restoreBackup strips the column), and the row a delete filtered on
    // the pointer would leave a bank statement on disk for
    await runWithWorkspace(workspaceId, () => clearImportDocument(pointerless.importId));
    expect((await importRow(pointerless.importId))!.documentAvailable).toBe(false);
    expect(await blobExists(readable.importId)).toBe(true);
    expect(await blobExists(pointerless.importId)).toBe(true);

    const res = await agent.delete(`/api/accounts/${readable.accountId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // two imports destroyed and one document counted - the number the panel showed
    // the user - while the bytes go for both
    expect(res.body).toEqual({ deleted: true, transactions: 2, imports: 2, documents: 1 });

    expect(await blobExists(readable.importId)).toBe(false);
    expect(await blobExists(pointerless.importId)).toBe(false);
    expect((await agent.get(`/api/imports/${readable.importId}/document`)).status).toBe(404);
    expect((await agent.get(`/api/imports/${pointerless.importId}/document`)).status).toBe(404);
    expect(await importRow(readable.importId)).toBeUndefined();
    expect(await importRow(pointerless.importId)).toBeUndefined();
  });
});

describe('the Content-Disposition a user-chosen filename produces', () => {
  const csv = { keyVersion: 1, originalFilename: null, sourceType: 'csv' } as const;
  const withName = (originalFilename: string) => ({ ...csv, originalFilename });

  it('strips a path before either encoding', () => {
    expect(attachmentDisposition('imp-1', withName('..\\..\\evil.csv'))).toBe(
      `attachment; filename="evil.csv"; filename*=UTF-8''evil.csv`,
    );
    expect(attachmentDisposition('imp-1', withName('../../evil.csv'))).toBe(
      `attachment; filename="evil.csv"; filename*=UTF-8''evil.csv`,
    );
  });

  it('a CRLF cannot reach the header at all', () => {
    const value = attachmentDisposition('imp-1', withName('state\r\nment.csv'));
    expect(value).toBe(`attachment; filename="statement.csv"; filename*=UTF-8''statement.csv`);
    expect(value).not.toMatch(/[\r\n]/);
  });

  it('a quote cannot end the quoted string early', () => {
    const value = attachmentDisposition('imp-1', withName('a"b.csv'));
    expect(value).toBe(`attachment; filename="a_b.csv"; filename*=UTF-8''a%22b.csv`);
    expect(value.match(/"/g)).toHaveLength(2);
  });

  it('a name with nothing ASCII in it still produces both halves', () => {
    const value = attachmentDisposition('imp-1', withName('виписка.csv'));
    expect(value).toBe(
      `attachment; filename="_______.csv"; filename*=UTF-8''%D0%B2%D0%B8%D0%BF%D0%B8%D1%81%D0%BA%D0%B0.csv`,
    );
    // printable ASCII only: what Node's setHeader accepts at all
    expect(value).toMatch(/^[ -~]+$/);
  });

  it('falls back to the import id, through the same two encodings', () => {
    expect(attachmentDisposition('imp-1', csv)).toBe(
      `attachment; filename="import-imp-1.csv"; filename*=UTF-8''import-imp-1.csv`,
    );
    // an id from a restored backup is a foreign JSON's string, not a UUID this
    // server minted, so the fallback is not trusted either
    expect(attachmentDisposition('../evil', csv)).toBe(
      `attachment; filename="import-..evil.csv"; filename*=UTF-8''import-..evil.csv`,
    );
    // no row at all: the id is still an honest name for what is being downloaded
    expect(attachmentDisposition('imp-1')).toBe(
      `attachment; filename="import-imp-1"; filename*=UTF-8''import-imp-1`,
    );
  });

  /**
   * The length cap is by code point and an unpaired surrogate never reaches
   * encodeURIComponent, which throws on one - and a throw here is a 500 from the
   * global handler on a download that had already decrypted the file.
   */
  it('a cap that lands mid-character, and a name a restore made unpaired', () => {
    const a99 = 'a'.repeat(99);
    expect(attachmentDisposition('imp-1', withName(`${a99}\u{1f600}.csv`))).toBe(
      `attachment; filename="${a99}__"; filename*=UTF-8''${a99}%F0%9F%98%80`,
    );
    expect(attachmentDisposition('imp-1', withName('bad\ud800name.csv'))).toBe(
      `attachment; filename="badname.csv"; filename*=UTF-8''badname.csv`,
    );
  });

  it('a name that sanitises away leaves a name behind, never an empty one', () => {
    expect(attachmentDisposition('imp-1', withName('..'))).toBe(
      `attachment; filename="import-imp-1.csv"; filename*=UTF-8''import-imp-1.csv`,
    );
  });

  /** End to end, so Node's own header validation is in the loop rather than assumed. */
  it('a hostile filename survives the real route', async () => {
    const bytes = csvFor('Hostile Filename Bank');
    const hostile = '..\\..\\ev"il\r\nвиписка.csv';
    const record = await runWithWorkspace(workspaceId, async () => {
      const created = await createImport({
        fileHash: crypto.createHash('sha256').update(bytes).digest('hex'),
        sourceType: 'csv',
        parserVersion: 1,
        originalFilename: hostile,
      });
      await recordImportDocument(created.id, await putDocument(created.id, bytes));
      return created;
    });

    const res = await agent.get(`/api/imports/${record.id}/document`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual(bytes);
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="ev_il_______.csv"; filename*=UTF-8''ev%22il%D0%B2%D0%B8%D0%BF%D0%B8%D1%81%D0%BA%D0%B0.csv`,
    );
  });
});

describe('GET /api/imports carries what a history screen reads', () => {
  it('names the account the upload asked for and whether a document can be read', async () => {
    const { importId } = await committed('History Bank', 'history.csv');
    const row = (await importRow(importId))!;
    expect(row).toMatchObject({
      accountName: 'History Bank',
      originalFilename: 'history.csv',
      documentAvailable: true,
    });
    // the storage layout is not the client's business: a client that can read the
    // version is one that can be tempted to build a key
    expect(row).not.toHaveProperty('documentKeyVersion');

    // NULL is legal and the screen has to render it: nothing reached the parse here
    const bare = await runWithWorkspace(workspaceId, () =>
      createImport({ fileHash: 'no-account-name', sourceType: 'csv', parserVersion: 1 }),
    );
    expect(await importRow(bare.id)).toMatchObject({
      accountName: null,
      documentAvailable: false,
    });
  });

  /**
   * A production build reads the API cross-origin, and Content-Disposition is not
   * a CORS-safelisted response header - without this the client cannot see the
   * filename of a blob it fetched. Invisible under the same-origin dev proxy, so
   * nothing but this notices it going away.
   */
  it('exposes Content-Disposition to an allowlisted cross-origin caller', async () => {
    const { importId } = await committed('Cors Bank');
    const res = await agent
      .get(`/api/imports/${importId}/document`)
      .set('Origin', 'http://localhost:5173');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-expose-headers']).toBe('Content-Disposition');
  });
});
