/**
 * The document routes (ROADMAP 4.5, 6.1): downloading the uploaded statement back,
 * and deleting it while the import row, its transactions and its provenance stay.
 *
 * Driven over real HTTP, like upload.test.ts: what these routes are about is the
 * wire - the status, the headers a download goes out under, and the sentence a
 * refusal carries.
 */
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app, attachmentDisposition } from '../src/app';
import { clearImportDocument, createImport, recordImportDocument, seedDefaults } from '../src/db';
import { freshTestDb } from './pglite';
import {
  DOCUMENT_DELETE_REFUSED,
  DOCUMENT_NOT_READABLE,
  DOCUMENT_READ_REFUSED,
  putDocument,
} from '../src/documents';
import { storageRoot } from '../src/storage';

const csvFor = (label: string): Buffer =>
  Buffer.from(['date,amount,description', `2026-03-01,-10.00,${label}`].join('\n'), 'utf8');

let agent: request.Agent;

interface Uploaded {
  importId: string;
  bytes: Buffer;
}

/** An empty account over the door that creates one, which is where every account comes from since row 26b. */
const makeAccount = async (name: string): Promise<string> => {
  const res = await agent.post('/api/accounts').send({ name, currency: 'EUR' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
};

async function upload(label: string, filename = 'statement.csv'): Promise<Uploaded> {
  const bytes = csvFor(label);
  const res = await agent
    .post('/api/imports')
    .field('accountId', await makeAccount(label))
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

/**
 * Where the file for an upload named `statement.csv` sits - spelled out, not asked
 * for, because the name in the folder is the contract a person reads.
 */
const blobOf = (importId: string, stem = 'statement'): string =>
  path.join(storageRoot(), `${stem}_${importId}.csv`);

const blobExists = (importId: string, stem = 'statement'): Promise<boolean> =>
  fs
    .access(blobOf(importId, stem))
    .then(() => true)
    .catch(() => false);

/**
 * Everything asserted below is exact, so the file truncates and re-seeds for itself.
 * test/setup.ts already does that pair before every test file; repeating it here is
 * deliberate, because a file whose assertions are whole sets should rest on a line in
 * the file rather than on a setup file it never names.
 */
beforeAll(async () => {
  await freshTestDb();
  await seedDefaults();
  agent = request.agent(app);
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
   * One sentence for an absent id and for a row with no readable document: they are
   * one code path, and a sentence per case would make the route an existence oracle.
   * Asserted by identity - it must keep saying READ rather than "kept", because a
   * row's claim outlives the disk it was made on.
   */
  it('answers one 404 for an unknown import and for a row with no readable document', async () => {
    const unknown = await agent.get('/api/imports/no-such-import/document');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe(DOCUMENT_NOT_READABLE);

    const pointerless = await createImport({
      fileHash: 'no-document-at-all',
      sourceType: 'csv',
      parserVersion: 1,
    });
    const res = await agent.get(`/api/imports/${pointerless.id}/document`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe(DOCUMENT_NOT_READABLE);
  });

  /**
   * A backup carries rows and no files, so a restore onto another machine leaves rows
   * that claim a document with nothing under the key. That is an ordinary state and
   * not a fault: it joins the 404 above rather than answering 500, or a person who
   * restores their backup onto a new laptop meets an internal error per import.
   *
   * The file is removed under the row here, which is the same state a restore lands
   * in and the only way to reach it without a second machine. The 500 arm is held
   * separately below, so a route that answered 404 for everything would still red.
   */
  it('a row whose file is not on this disk is the same 404, not a fault', async () => {
    const { importId } = await committed('Restored Elsewhere Bank');
    expect(await blobExists(importId)).toBe(true);
    await fs.rm(blobOf(importId));

    const res = await agent.get(`/api/imports/${importId}/document`);
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body.error).toBe(DOCUMENT_NOT_READABLE);

    // the row still says it has one: the list reports the CLAIM, and the route is
    // what reports what can actually be read
    expect((await importRow(importId))!.documentAvailable).toBe(true);
  });

  /** The imports that went wrong are exactly the ones the input is wanted for. */
  it('downloads the document of a failed and of a discarded import', async () => {
    const unparseable = Buffer.from(['col a;col b;col c', '05.02.2026;-11,00;Kiosk'].join('\n'), 'utf8');
    const failed = await agent
      .post('/api/imports')
      .field('accountId', await makeAccount('Failed Bank'))
      .field('preset', 'generic')
      .attach('file', unparseable, 'broken.csv');
    expect(failed.status).toBe(400);

    const failedRow = (await importRows()).find((i) => i.status === 'failed')!;
    expect(failedRow.documentAvailable).toBe(true);
    const failedDoc = await agent.get(`/api/imports/${failedRow.id}/document`);
    expect(failedDoc.status).toBe(200);
    expect(failedDoc.body).toEqual(unparseable);
    // and it is in the folder under the name the person gave it
    expect(await blobExists(failedRow.id, 'broken')).toBe(true);

    const staged = await upload('Discarded Bank');
    expect((await agent.post(`/api/imports/${staged.importId}/discard`)).status).toBe(200);
    const discardedDoc = await agent.get(`/api/imports/${staged.importId}/document`);
    expect(discardedDoc.status).toBe(200);
    expect(discardedDoc.body).toEqual(staged.bytes);
  });

  /**
   * The other half of the split above, and the half that IS a fault: the file is
   * there and it is not the file the import recorded. The folder is the person's, so
   * an edit in it is the ordinary way that happens, and the answer must be 500 and
   * not the 404 an absent file gets - otherwise "restored elsewhere" and "somebody
   * changed my statement" arrive at the screen as the same sentence. The sentence
   * carries no path, no errno and no filename - those are the log's.
   */
  it('answers 500 when the file under the row is not the one it recorded', async () => {
    const { importId } = await committed('Edited Bank');
    await fs.writeFile(blobOf(importId), 'date,amount,description\n2026-03-01,-99.00,Edited\n');

    const res = await agent.get(`/api/imports/${importId}/document`);
    expect(res.status, JSON.stringify(res.body)).toBe(500);
    expect(res.body.error).toBe(DOCUMENT_READ_REFUSED);
    expect(res.body.error).not.toMatch(/[A-Za-z]:\\|\/tmp\/|ENOENT|statement\.csv/);
  });
});

describe('DELETE /api/imports/:id/document', () => {
  it('removes the file and keeps the import, its transactions and its provenance', async () => {
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
   * whose pointer was already cleared - and those are the rows most likely to still
   * have a file (restored, or crashed between the put and recordImportDocument).
   */
  it('is idempotent, and runs on a row that never claimed a document', async () => {
    const { importId } = await committed('Twice Bank');

    const first = await agent.delete(`/api/imports/${importId}/document`);
    expect(first.body).toEqual({ deleted: true, importId, bytesRemoved: true });
    const second = await agent.delete(`/api/imports/${importId}/document`);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ deleted: true, importId, bytesRemoved: false });

    const never = await createImport({
      fileHash: 'never-had-a-document',
      sourceType: 'csv',
      parserVersion: 1,
    });
    const res = await agent.delete(`/api/imports/${never.id}/document`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, importId: never.id, bytesRemoved: false });
    expect(await importRow(never.id)).toBeDefined();
  });

  it('answers 404 for an id no import has', async () => {
    const res = await agent.delete('/api/imports/no-such-import/document');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('import not found');
  });

  /**
   * The existence check runs before any disk access. With it after deleteDocument,
   * an id with no row still unlinks whatever file that id names - the orphan a
   * restore produces, since it replaces the import rows while the files stay - and
   * then answers "not found": destroyed, and the answer says nothing happened. The
   * case above cannot see this, because no file exists for that id.
   */
  it('does not touch the disk for an id no row has', async () => {
    await putDocument(
      { importId: 'orphan-no-row', originalFilename: null, sourceType: 'csv' },
      csvFor('Orphan'),
    );
    expect(await blobExists('orphan-no-row')).toBe(true);

    const res = await agent.delete('/api/imports/orphan-no-row/document');
    expect(res.status).toBe(404);
    expect(await blobExists('orphan-no-row')).toBe(true);
  });

  /**
   * The ordering invariant, and the only thing holding it: the file goes first and
   * the pointer only once it is gone. Swap the two statements and this goes red
   * while every other case here stays green - the route still answers 500, but the
   * row has already stopped claiming a document whose file is still on disk, and
   * nothing would ever revisit it.
   *
   * The failure is forced with a non-empty directory where the file belongs, so the
   * unlink fails with something that is not ENOENT on every platform this runs on.
   */
  it('leaves the pointer alone when the file cannot be removed', async () => {
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
 * ROADMAP 6.1: an account delete is the second path that removes stored documents,
 * and the only one that removes several at once. The file goes for EVERY import it
 * destroys whatever the pointer said - document_stored records whether a document
 * can be READ, never whether a file is on disk, and the rows most likely to still
 * have one are exactly the ones whose pointer is cleared.
 */
describe('DELETE /api/accounts/:id takes the stored statements with it', () => {
  const statement = (amount: string, label: string): Buffer =>
    Buffer.from(['date,amount,description', `2026-03-01,${amount},${label}`].join('\n'), 'utf8');

  const commitInto = async (accountId: string, bytes: Buffer) => {
    const res = await agent
      .post('/api/imports')
      .field('accountId', accountId)
      .field('preset', 'generic')
      .attach('file', bytes, 'statement.csv');
    expect(res.status, `upload failed: ${JSON.stringify(res.body)}`).toBe(200);
    const summary = res.body.summary as { importId: string; accountId: string };
    const confirmed = await agent.post(`/api/imports/${summary.importId}/confirm`);
    expect(confirmed.status, `confirm failed: ${JSON.stringify(confirmed.body)}`).toBe(200);
    return summary;
  };

  it('removes the file of a readable document and of one whose pointer is gone', async () => {
    const account = await makeAccount('Blob Account');
    const readable = await commitInto(account, statement('-21.00', 'blob one'));
    const pointerless = await commitInto(account, statement('-22.00', 'blob two'));
    expect(pointerless.accountId).toBe(readable.accountId);

    // the pointer alone, leaving the file where it is: what a restored backup
    // produces (restoreBackup strips the column), and the row a delete filtered on
    // the pointer would leave a bank statement on disk for
    await clearImportDocument(pointerless.importId);
    expect((await importRow(pointerless.importId))!.documentAvailable).toBe(false);
    expect(await blobExists(readable.importId)).toBe(true);
    expect(await blobExists(pointerless.importId)).toBe(true);

    const res = await agent.delete(`/api/accounts/${readable.accountId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // two imports destroyed and one document counted - the number the panel showed
    // the user - while the files go for both
    expect(res.body).toEqual({ deleted: true, transactions: 2, imports: 2, documents: 1 });

    expect(await blobExists(readable.importId)).toBe(false);
    expect(await blobExists(pointerless.importId)).toBe(false);
    expect((await agent.get(`/api/imports/${readable.importId}/document`)).status).toBe(404);
    expect((await agent.get(`/api/imports/${pointerless.importId}/document`)).status).toBe(404);
    expect(await importRow(readable.importId)).toBeUndefined();
    expect(await importRow(pointerless.importId)).toBeUndefined();
  });
});

/**
 * original_filename is a string the user chose and it becomes a header value: a
 * CRLF splits the response, a `"` ends the quoted string early, a `..\` is a path
 * the client would save under, and anything above U+00FF makes setHeader throw.
 * The emitted value is asserted, not the status code - a 200 says nothing about
 * what the header contains.
 */
describe('the Content-Disposition a user-chosen filename produces', () => {
  const csv = {
    importId: 'imp-1',
    originalFilename: null,
    sourceType: 'csv',
    documentStored: true,
  } as const;
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
    // app minted, so the fallback is not trusted either
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
   * global handler on a download that had already read the file.
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

  /**
   * End to end, so Node's own header validation is in the loop rather than assumed -
   * and the same hostile name is what the file lands under in the folder, where the
   * path, the quote and the line break are gone and the Cyrillic is not.
   */
  it('a hostile filename survives the real route, and the folder', async () => {
    const bytes = csvFor('Hostile Filename Bank');
    const hostile = '..\\..\\ev"il\r\nвиписка.csv';
    const record = await createImport({
      fileHash: crypto.createHash('sha256').update(bytes).digest('hex'),
      sourceType: 'csv',
      parserVersion: 1,
      originalFilename: hostile,
    });
    await putDocument({ importId: record.id, originalFilename: hostile, sourceType: 'csv' }, bytes);
    await recordImportDocument(record.id);
    expect(await blobExists(record.id, 'ev_il__виписка')).toBe(true);

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
    // the pointer is answered as a fact about readability, never as the column
    expect(row).not.toHaveProperty('documentStored');

    // NULL is legal and the screen has to render it: nothing reached the parse here
    const bare = await createImport({
      fileHash: 'no-account-name',
      sourceType: 'csv',
      parserVersion: 1,
    });
    expect(await importRow(bare.id)).toMatchObject({
      accountName: null,
      documentAvailable: false,
    });
  });
});
