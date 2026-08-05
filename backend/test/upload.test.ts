/**
 * The ingestion surface over real HTTP (ROADMAP 5.1): one multipart endpoint that
 * decides what the file is from its bytes.
 *
 * Driven through supertest with a real session, because the parts worth testing
 * only exist in the middleware chain - that the multipart parser sits BEHIND the
 * session check, and that a file the app cannot read is refused with something the
 * user can act on rather than a generic 400.
 *
 * The process-wide test fallback is cleared for the duration, as in
 * http-auth.test.ts: with it armed a request that never entered a workspace
 * context would answer from the test workspace instead of throwing.
 */
import http from 'http';
import { AddressInfo } from 'net';
import { sql } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { initAuth } from '../src/auth';
import { dbInstance, setWorkspaceFallback } from '../src/db';
import { ACCOUNT_NOT_FOUND, ACCOUNT_REMOVED } from '../src/providers/statement';
import { buildPdf, buildSignedContainer } from './pdffixture';
import { TEST_WORKSPACE_ID } from './pglite';

const csvFile = (label: string): Buffer =>
  Buffer.from(['date,amount,description', `2026-03-01,-10.00,${label}`].join('\n'), 'utf8');

async function xlsxFile(label: string, skippedSheet = false): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  // formatted past the row guard, so it is never read and the parser has to say so
  if (skippedSheet) wb.addWorksheet('Cover').getRow(600_000).height = 20;
  const ws = wb.addWorksheet('Statement');
  ws.addRow(['date', 'amount', 'description']);
  ws.addRow([new Date('2026-04-01T00:00:00.000Z'), -20.5, label]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

let agent: request.Agent;
/** The same session as `agent`, for the requests driven without supertest. */
let sessionCookie: string;

/** The workspace's imports, newest first. */
const imports = async (): Promise<
  {
    sourceType: string;
    originalFilename: string | null;
    status: string;
    documentAvailable: boolean;
    errorDetail: string | null;
  }[]
> => (await agent.get('/api/imports')).body.imports;

/** An upload only stages - this is what makes its rows the workspace's data. */
const confirm = (importId: string) => agent.post(`/api/imports/${importId}/confirm`);

beforeAll(async () => {
  initAuth(dbInstance());
  setWorkspaceFallback(undefined);

  agent = request.agent(app);
  const res = await agent
    .post('/api/auth/sign-up/email')
    .send({ email: 'uploader@example.com', password: 'correct-horse-battery', name: 'uploader' });
  expect(res.status, `sign-up failed: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  sessionCookie = (res.headers['set-cookie'] as unknown as string[])
    .map((c) => c.split(';')[0])
    .join('; ');
});

afterAll(() => {
  // the fallback is process-wide - the rest of the run expects it armed
  setWorkspaceFallback(TEST_WORKSPACE_ID);
});

describe('POST /api/imports', () => {
  it('takes a CSV as multipart and answers with a summary to confirm', async () => {
    const res = await agent
      .post('/api/imports')
      .field('accountName', 'Http Bank')
      .field('currency', 'EUR')
      .field('preset', 'generic')
      .attach('file', csvFile('HTTP groceries'), 'statement.csv');

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.outcome).toBe('awaiting_confirmation');
    expect(res.body.summary).toMatchObject({
      accountName: 'Http Bank',
      accountExists: false,
      total: 1,
      accepted: 1,
      skipped: 0,
      newRows: 1,
      alreadyPresent: 0,
      problems: [],
    });
    expect(res.body.summary.importId).toEqual(expect.any(String));

    const [latest] = await imports();
    expect(latest).toMatchObject({ sourceType: 'csv', originalFilename: 'statement.csv' });

    const confirmed = await confirm(res.body.summary.importId);
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    // the confirm lands in the account the summary named, which is what the id
    // recorded on the import is for - neither end derives it from the name
    expect(confirmed.body).toMatchObject({
      accountId: res.body.summary.accountId,
      accountIds: [res.body.summary.accountId],
      inserted: 1,
      skipped: 0,
      total: 1,
    });
  });

  /**
   * The filename is the one part of a multipart request that arrives as bytes with
   * no charset of its own. multer read them as latin1, so this name was stored as
   * "Ð²Ñ‹Ð¿Ð¸ÑÐºÐ°.xlsx" - 19 characters, one per byte - and nothing failed. The
   * assertion reads the column back out of the database rather than a header the
   * route composed from this test's own string, which would agree with itself.
   */
  it('stores a non-ASCII filename as the browser sent it', async () => {
    const res = await agent
      .post('/api/imports')
      .field('accountName', 'Cyrillic Name Bank')
      .field('currency', 'EUR')
      .attach('file', await xlsxFile('выписка'), 'выписка.xlsx');

    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const stored = (await dbInstance().execute(
      sql`SELECT original_filename FROM imports WHERE id = ${res.body.summary.importId}`,
    )) as unknown as { rows: { original_filename: string }[] };

    expect(stored.rows[0].original_filename).toBe('выписка.xlsx');
    expect(stored.rows[0].original_filename).toHaveLength(12);
  });

  /**
   * The file type comes from the bytes, never from the name: this workbook is
   * uploaded as "statement.csv" and still goes to the XLSX parser. A bank that
   * names its Excel export .csv is not a hypothetical.
   */
  it('takes an XLSX, sniffed by content rather than by its name', async () => {
    const res = await agent
      .post('/api/imports')
      .field('accountName', 'Workbook Bank')
      .field('currency', 'EUR')
      .attach('file', await xlsxFile('HTTP workbook'), 'statement.csv');

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.summary).toMatchObject({ accepted: 1, total: 1 });
    expect((await confirm(res.body.summary.importId)).body.inserted).toBe(1);

    const [latest] = await imports();
    expect(latest.sourceType).toBe('xlsx');
  });

  /**
   * The response body is the wire contract, and toMatchObject would not notice a key
   * added to it. A sheet the parser never read reaches the client in `problems` and
   * nowhere else - the same sentence sent twice under two names is the contract
   * drifting, which is the thing a mobile client cannot follow.
   */
  it('a skipped sheet reaches the client in problems, and adds no field to the body', async () => {
    const res = await agent
      .post('/api/imports')
      .field('accountName', 'Skipped Sheet Bank')
      .field('currency', 'EUR')
      .attach('file', await xlsxFile('behind the cover', true), 'statement.xlsx');

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['outcome', 'summary']);
    expect(Object.keys(res.body.summary).sort()).toEqual([
      'accepted',
      'accountExists',
      'accountId',
      'accountName',
      'alreadyPresent',
      'from',
      'importId',
      'newRows',
      'problems',
      'readAs',
      'skipped',
      'to',
      'total',
      'totals',
    ]);
    // without this the key set would also pass in the world where the notice stopped
    // reaching the client at all
    expect(res.body.summary.problems[0]).toMatch(
      /^sheet "Cover" \(600000 rows\) was too large to read and was skipped/,
    );
  });

  it('the same file twice answers duplicate without parsing it again', async () => {
    const upload = () =>
      agent
        .post('/api/imports')
        .field('accountName', 'Twice Over Http')
        .field('currency', 'EUR')
        .attach('file', csvFile('sent twice'), 'twice.csv');

    const first = await upload();
    // only a committed import claims the hash, so the confirm is what makes the
    // second upload a duplicate rather than a second staged copy
    expect((await confirm(first.body.summary.importId)).body.inserted).toBe(1);
    const second = await upload();
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      outcome: 'duplicate',
      importId: first.body.summary.importId,
    });
    expect(second.body.uploadedAt).toEqual(expect.any(String));
  });

  /**
   * The PDF path opens the file now (ROADMAP 6a), so this moved bands: the same
   * bytes that used to be refused by the sniffer with no `imports` row are a
   * `pdf` import that failed, and the row and its stored document are what make
   * the miss diagnosable. What stays pinned is that the message says what to do -
   * the byte cap, which is still decidable without opening anything, holds the
   * no-row half of the rule from the other side (pdf.test.ts).
   */
  it('a file that says %PDF and is not one fails as a pdf import, not as a CSV', async () => {
    const before = (await imports()).length;
    const res = await agent
      .post('/api/imports')
      .field('accountName', 'Pdf Bank')
      .field('currency', 'EUR')
      .attach('file', Buffer.from('%PDF-1.4\n1 0 obj\n<< >>\n', 'utf8'), 'statement.pdf');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/looks like a PDF but could not be opened as one/);
    const after = await imports();
    expect(after).toHaveLength(before + 1);
    expect(after[0]).toMatchObject({
      sourceType: 'pdf',
      originalFilename: 'statement.pdf',
      status: 'failed',
      documentAvailable: true,
    });
  });

  /**
   * Row 33, and it is a band change asserted rather than discovered: these bytes used
   * to be refused inside `sniff`, before createImport, so they left no import row and
   * no stored document. A container is a PDF now, so the file is opened, the document
   * is kept, and the miss is a `failed` import someone can download - which is what
   * row 31 builds the third template from.
   */
  it('a statement inside a signed container fails as a pdf import, naming the layout', async () => {
    const before = (await imports()).length;
    const inner = buildPdf([
      [
        { x: 39.7, y: 27.1, text: 'Sparkasse Hamburg' },
        { x: 42.7, y: 700, text: 'Buchungstag' },
        { x: 124.8, y: 700, text: 'Verwendungszweck' },
        { x: 335.1, y: 700, text: 'Betrag' },
        { x: 42.7, y: 680, text: '02.07.2026' },
        { x: 124.8, y: 680, text: 'REWE SAGT DANKE' },
        { x: 335.1, y: 680, text: '-5,68' },
      ],
    ]);

    const res = await agent
      .post('/api/imports')
      .field('accountName', 'Wrapped Bank')
      .field('currency', 'EUR')
      .attach('file', buildSignedContainer(inner), 'report.pdf');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/layout is not one this importer recognises yet/);
    // and not what a person holding a readable statement used to be told
    expect(res.body.error).not.toMatch(/not a CSV, Excel \(\.xlsx\) or PDF statement/);

    const after = await imports();
    expect(after).toHaveLength(before + 1);
    expect(after[0]).toMatchObject({
      sourceType: 'pdf',
      originalFilename: 'report.pdf',
      status: 'failed',
      documentAvailable: true,
    });
    expect(after[0].errorDetail).toMatch(/layout is not one this importer recognises yet/);
  });

  /**
   * What the container rule has to keep out of: a DER SEQUENCE opens 0x30, which is
   * ASCII `0`, and this file's leading index column starts with one. What this case
   * pins is that such a CSV imports, and nothing about which half of the rule parted
   * it from a container - the file carries no `%PDF-` anywhere, so the header search
   * refuses it on its own. The second byte is held by pdf.test.ts's lead-byte loop,
   * which is where a classifier boundary belongs.
   */
  it('a CSV whose first byte is the zero a container tag shares still imports', async () => {
    const csv = Buffer.from(
      ['0;date;amount;description', '1;01.07.2026;-10,00;REWE SAGT DANKE'].join('\n'),
      'utf8',
    );
    expect(csv[0]).toBe(0x30);

    const res = await agent
      .post('/api/imports')
      .field('accountName', 'Zero Led Bank')
      .field('currency', 'EUR')
      .attach('file', csv, 'statement.csv');

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.summary).toMatchObject({ total: 1, accepted: 1, skipped: 0 });
  });

  it('a legacy .xls is refused with the message for that format', async () => {
    const res = await agent
      .post('/api/imports')
      .field('accountName', 'Old Excel Bank')
      .field('currency', 'EUR')
      .attach(
        'file',
        Buffer.concat([
          Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
          Buffer.alloc(64),
        ]),
        'statement.xls',
      );

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/the older Excel format \(\.xls\)/);
  });

  it('an XML file and an unreadable binary each get their own message', async () => {
    const send = (bytes: Buffer, name: string) =>
      agent
        .post('/api/imports')
        .field('accountName', 'Odd Bytes Bank')
        .field('currency', 'EUR')
        .attach('file', bytes, name);

    const xml = await send(
      Buffer.from('<?xml version="1.0"?><Document><BkToCstmrStmt/></Document>', 'utf8'),
      'camt.xml',
    );
    expect(xml.status).toBe(400);
    expect(xml.body.error).toMatch(
      /XML or HTML, not a CSV, Excel \(\.xlsx\) or PDF statement.*CAMT\.053 and MT940 are not supported yet/,
    );

    const binary = await send(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a, 0x0a]), 'chart.png');
    expect(binary.status).toBe(400);
    expect(binary.body.error).toBe(
      'this file is not a CSV, Excel (.xlsx) or PDF statement - export the statement in one of those from your online banking and upload that',
    );
  });

  it('rejects a request with no file, a bad currency or a mapping that is not an object', async () => {
    const noFile = await agent
      .post('/api/imports')
      .field('accountName', 'No File Bank')
      .field('currency', 'EUR');
    expect(noFile.status).toBe(400);
    expect(noFile.body.error).toMatch(/file field required/);

    const badCurrency = await agent
      .post('/api/imports')
      .field('accountName', 'Bad Currency Bank')
      .field('currency', 'euro')
      .attach('file', csvFile('x'), 'statement.csv');
    expect(badCurrency.status).toBe(400);
    expect(badCurrency.body.error).toMatch(/currency field required/);

    const badMapping = await agent
      .post('/api/imports')
      .field('accountName', 'Bad Mapping Bank')
      .field('currency', 'EUR')
      .field('mapping', 'date')
      .attach('file', csvFile('x'), 'statement.csv');
    expect(badMapping.status).toBe(400);
    expect(badMapping.body.error).toBe('mapping must be a JSON object');
  });

  /**
   * The mapping is the one part of the request a caller writes by hand. Cast rather
   * than checked, {"date":1} reached the parser, threw "name.trim is not a
   * function", and that string was stored in the import's error_detail.
   */
  it('a mapping with the wrong field types or an unknown key is refused, with no import row', async () => {
    const before = (await imports()).length;
    const send = (accountName: string, mapping: string) =>
      agent
        .post('/api/imports')
        .field('accountName', accountName)
        .field('currency', 'EUR')
        .field('mapping', mapping)
        .attach('file', csvFile('x'), 'statement.csv');

    const wrongType = await send('Typed Mapping Bank', '{"date":1,"amount":"a","description":"b"}');
    expect(wrongType.status).toBe(400);
    expect(wrongType.body.error).toBe('mapping.date must be a string');

    // stripping it instead would import the file against the wrong date format and
    // answer 200 with a plausible count
    const unknownKey = await send(
      'Unknown Key Bank',
      '{"date":"d","amount":"a","description":"x","date_format":"dmy"}',
    );
    expect(unknownKey.status).toBe(400);
    expect(unknownKey.body.error).toBe('mapping has an unknown field: "date_format"');

    // an unknown key one level down has to name the level it is on
    const nestedKey = await send(
      'Nested Key Bank',
      '{"date":"d","amount":"a","description":"x","onlyWhen":{"column":"State","equals":"OK","nope":1}}',
    );
    expect(nestedKey.status).toBe(400);
    expect(nestedKey.body.error).toBe('mapping.onlyWhen has an unknown field: "nope"');

    // the one mapping error that used to answer with zod's own wording and no field
    const emptyList = await send('Empty List Bank', '{"date":"d","amount":"a","description":[]}');
    expect(emptyList.status).toBe(400);
    expect(emptyList.body.error).toBe(
      'mapping.description must be a column name or a list of column names',
    );

    // accept nothing filters every row away, and the answer would then be "no row
    // could be parsed" - the caller's own input, zeroed and reported back as a fault
    // in the file. tsc cannot see this bound: without .min(1) the suite stays green
    const noAcceptedValues = await send(
      'Empty Accept List Bank',
      '{"date":"d","amount":"a","description":"x","onlyWhen":{"column":"State","equals":[]}}',
    );
    expect(noAcceptedValues.status).toBe(400);
    expect(noAcceptedValues.body.error).toBe(
      'mapping.onlyWhen.equals must be a status value or a list of status values',
    );

    expect(await imports()).toHaveLength(before);
  });

  it('a file under the wrong field name is still reported as the file field', async () => {
    const res = await agent
      .post('/api/imports')
      .field('accountName', 'Wrong Field Bank')
      .field('currency', 'EUR')
      .attach('statement', csvFile('x'), 'statement.csv');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('the upload must carry exactly one file field named "file"');
  });

  /** A text field over multer's limit is a problem with that field, not with the file. */
  it('an oversized text field names the field', async () => {
    const res = await agent
      .post('/api/imports')
      .field('accountName', 'Fat Field Bank')
      .field('currency', 'EUR')
      .field('mapping', 'x'.repeat(2 * 1024 * 1024))
      .attach('file', csvFile('x'), 'statement.csv');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/"mapping" field is larger than 1 MB/);
    expect(res.body.error).not.toMatch(/exactly one file field/);
  });

  /**
   * Trap 1: mounted globally, or above the session check, the multipart parser
   * would let anyone who can reach the port make the server buffer megabytes.
   */
  it('an unauthenticated upload is refused by the session check', async () => {
    const res = await request(app)
      .post('/api/imports')
      .field('accountName', 'Stranger')
      .field('currency', 'EUR')
      .attach('file', csvFile('should never be read'), 'statement.csv');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/sign in required/);
  });
});

/**
 * The wire half of the destination union (ROADMAP row 26a). Multipart fields carry no
 * type, so the exclusive union `importStatement` takes cannot hold anything here -
 * these eight cases are what a mobile client and curl meet, and the REST API is the
 * contract the picker is only one client of.
 */
describe('POST /api/imports picks an account by id', () => {
  /** An empty account over the same door the Accounts screen uses. */
  const makeAccount = async (name: string): Promise<string> => {
    const res = await agent.post('/api/accounts').send({ name, currency: 'EUR' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
  };

  /**
   * Distinct bytes per case, and not for tidiness: the hash short-circuit sits above
   * the destination resolution and stays there (024's D1), so bytes a committed
   * import already holds answer `duplicate` with a 200 before any of these refusals
   * is reached.
   */
  const uploadWith = (label: string, fields: Record<string, string>) => {
    let req = agent.post('/api/imports');
    for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
    return req.attach('file', csvFile(label), 'statement.csv');
  };

  it('imports into the picked account, under its own name', async () => {
    const id = await makeAccount('Picked Over Http');

    const res = await uploadWith('picked by id', { accountId: id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.summary).toMatchObject({
      accountId: id,
      accountName: 'Picked Over Http',
      accountExists: true,
      accepted: 1,
    });

    const confirmed = await confirm(res.body.summary.importId);
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body).toMatchObject({ accountId: id, accountIds: [id], inserted: 1 });
  });

  it('refuses a request that carries both an id and a name', async () => {
    const id = await makeAccount('Both Arms Bank');
    const res = await uploadWith('both arms', {
      accountId: id,
      accountName: 'Both Arms Bank',
      currency: 'EUR',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not both/);
  });

  it('refuses a request that carries neither', async () => {
    const res = await uploadWith('neither arm', { currency: 'EUR' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('accountId or accountName field required');
  });

  /**
   * An existing account owns its currency (ROADMAP 26(b)). Accepting one here and
   * then reading the account's instead is a field the caller believes in and nothing
   * uses - which is how "Savings" stayed EUR through a USD statement and reported it.
   */
  it('refuses a currency sent alongside an id', async () => {
    const id = await makeAccount('Own Currency Bank');
    const res = await uploadWith('own currency', { accountId: id, currency: 'USD' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/keeps its own currency/);
  });

  it('refuses an id no account answers to', async () => {
    const res = await uploadWith('unknown id', { accountId: 'not-an-account' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(ACCOUNT_NOT_FOUND);
  });

  /**
   * The row's own defect at the upload gate, and the half a status code cannot show:
   * the refusal is above createImport, so it leaves no `imports` row, no stored
   * document and no history entry for the user to wonder about.
   */
  it('refuses a removed account, and leaves no import row behind', async () => {
    const id = await makeAccount('Removed Over Http');
    expect((await agent.patch(`/api/accounts/${id}`).send({ hidden: true })).status).toBe(200);
    const before = (await imports()).length;

    const res = await uploadWith('removed by id', { accountId: id });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(ACCOUNT_REMOVED);
    expect(res.body.error).toMatch(/restore it/);
    expect(await imports()).toHaveLength(before);
  });

  /**
   * multer turns a repeated multipart field into an array, so a presence test written
   * as `typeof x === 'string'` reads a repeat as ABSENT: this request used to answer
   * 200 as the name arm, staging the rows against a freshly minted id for an account
   * the caller never picked - one Confirm from existing, with no account delete to
   * undo it. Unreachable from the picker, which is not the argument: the REST API is
   * the contract (row 24).
   */
  it('refuses a repeated accountId sent alongside a name', async () => {
    const id = await makeAccount('Repeated With Name');
    const before = (await imports()).length;

    const res = await agent
      .post('/api/imports')
      .field('accountId', id)
      .field('accountId', id)
      .field('accountName', 'Some Other Bank')
      .field('currency', 'EUR')
      .attach('file', csvFile('repeated id and a name'), 'statement.csv');

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error).toMatch(/not both/);
    expect(await imports()).toHaveLength(before);
  });

  /**
   * Refused, not normalised - picking the first or the last of two values the caller
   * may not agree on is the guess the exclusivity refusal exists to prevent. The
   * sentence names the field, because "accountId or accountName field required" is
   * false of a request that sent one twice.
   */
  it('refuses a repeated accountId sent alone, naming the field', async () => {
    const id = await makeAccount('Repeated Alone');

    const res = await agent
      .post('/api/imports')
      .field('accountId', id)
      .field('accountId', id)
      .attach('file', csvFile('repeated id alone'), 'statement.csv');

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error).toMatch(/accountId/);
    expect(res.body.error).not.toMatch(/field required/);
  });
});

describe('POST /api/imports/:id/confirm and /discard', () => {
  const stage = async (accountName: string, label: string) => {
    const res = await agent
      .post('/api/imports')
      .field('accountName', accountName)
      .field('currency', 'EUR')
      .attach('file', csvFile(label), `${label}.csv`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.summary as { importId: string };
  };

  const transactions = async (): Promise<{ description: string }[]> =>
    (await agent.get('/api/transactions?limit=500')).body;

  /**
   * The export is a read path like any other, and the one a person reaches for when
   * they want "everything I have". A staged row must not be in it.
   */
  it('a staged import is in neither the transaction list nor the CSV export', async () => {
    const { importId } = await stage('Export Bank', 'not yet exported');

    expect((await transactions()).filter((t) => /not yet exported/.test(t.description))).toEqual(
      [],
    );
    const before = await agent.get('/api/export.csv');
    expect(before.status).toBe(200);
    expect(before.text).not.toMatch(/not yet exported/);

    expect((await confirm(importId)).status).toBe(200);
    const after = await agent.get('/api/export.csv');
    expect(after.text).toMatch(/not yet exported/);
  });

  it('a second confirm is 409 and names the state', async () => {
    const { importId } = await stage('Second Confirm Bank', 'confirmed once');
    expect((await confirm(importId)).status).toBe(200);

    const again = await confirm(importId);
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already been confirmed/);
    expect((await transactions()).filter((t) => /confirmed once/.test(t.description))).toHaveLength(
      1,
    );
  });

  it('discard is 200 twice, and 409 on an import that is already data', async () => {
    const { importId } = await stage('Http Discard Bank', 'discarded over http');
    const first = await agent.post(`/api/imports/${importId}/discard`);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ discarded: true, importId });
    expect((await agent.post(`/api/imports/${importId}/discard`)).status).toBe(200);

    const live = await stage('Http Committed Bank', 'committed over http');
    expect((await confirm(live.importId)).status).toBe(200);
    const refused = await agent.post(`/api/imports/${live.importId}/discard`);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/delete it instead of discarding it/);
  });

  /**
   * The confirm's guards refuse a broken invariant, which is nothing the user did -
   * so the status stays 5xx, or the operator's alerting would read a failure the
   * server caused as one the file caused (ROADMAP 6.4). What must not stay is the
   * body: `internal error` on the one screen whose job is saying whether the data
   * landed reads as transient, so the person presses Confirm again forever.
   */
  it('a guard inside the confirm answers with the way out, not "internal error"', async () => {
    const { importId } = await stage('Broken Invariant Bank', 'staged then broken');
    // by import id alone: these rows belong to the signed-up session's own
    // organization, not to TEST_WORKSPACE_ID
    await dbInstance().execute(
      sql`DELETE FROM staged_transactions WHERE import_id = ${importId}`,
    );

    const res = await confirm(importId);
    expect(res.status).toBe(500);
    expect(res.body.error).not.toMatch(/internal error/);
    expect(res.body.error).toMatch(/Discard it and upload the file again/);
    // still discardable, so the way out the sentence names actually works
    expect((await agent.post(`/api/imports/${importId}/discard`)).status).toBe(200);
  });

  it('an unknown import id is 404 on both routes', async () => {
    expect((await confirm('no-such-import')).status).toBe(404);
    expect((await agent.post('/api/imports/no-such-import/discard')).status).toBe(404);
  });

  it('confirming without a session is refused', async () => {
    const { importId } = await stage('Stranger Confirm Bank', 'not yours');
    const res = await request(app).post(`/api/imports/${importId}/confirm`);
    expect(res.status).toBe(401);
    expect((await confirm(importId)).status).toBe(200);
  });
});

describe('the routes around it', () => {
  it('GET /api/imports/presets lists generic plus the bank presets', async () => {
    const res = await agent.get('/api/imports/presets');
    expect(res.status).toBe(200);
    expect(res.body.presets.map((p: { key: string }) => p.key)).toEqual([
      'generic',
      'sparkasse',
      'dkb',
      'revolut',
    ]);
    // the string web/src/imports.ts's GENERIC_PRESET_TITLE is a prefix of: the chip
    // renders this title and the summary's sentence names the short form, and the two
    // stop being the same reader the moment this stops starting with it
    const generic = res.body.presets.find((p: { key: string }) => p.key === 'generic');
    expect(generic.title.startsWith('Any statement')).toBe(true);
  });

  it('the JSON CSV endpoints are gone', async () => {
    expect((await agent.post('/api/csv/import').send({ csv: 'a,b' })).status).toBe(404);
    expect((await agent.get('/api/csv/presets')).status).toBe(404);
  });
});

// ---------- the workspace context and how the body arrives ----------

const BOUNDARY = '----fintoChunkedBoundary';

/** A multipart body built by hand, so the test owns exactly which bytes go out when. */
function multipartBody(fields: Record<string, string>, filename: string, bytes: Buffer): Buffer {
  const parts = Object.entries(fields).map(([name, value]) =>
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      'utf8',
    ),
  );
  parts.push(
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        'Content-Type: text/csv\r\n\r\n',
      'utf8',
    ),
    bytes,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`, 'utf8'),
  );
  return Buffer.concat(parts);
}

/**
 * One request over a real socket, with the body written in `pieces` writes and the
 * event loop turning between them. supertest hands its body to the socket in one
 * go, so it cannot express this - and this is the only variable that matters here.
 */
async function sendInPieces(
  path: string,
  contentType: string,
  body: Buffer,
  pieces: number,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  try {
    const { port } = server.address() as AddressInfo;
    return await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path,
          agent: false,
          headers: {
            'content-type': contentType,
            'content-length': String(body.length),
            connection: 'close',
            cookie: sessionCookie,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : {} });
          });
        },
      );
      req.on('error', reject);
      const size = Math.ceil(body.length / pieces);
      void (async () => {
        for (let at = 0; at < body.length; at += size) {
          if (at > 0) await new Promise((r) => setTimeout(r, 15));
          req.write(body.subarray(at, at + size));
        }
        req.end();
      })();
    });
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
}

/**
 * A body that arrives in more than one socket read.
 *
 * The session middleware wraps next() in runWithWorkspace(), and that store is live
 * for the synchronous run plus whatever inherits from it. The socket was created
 * when the connection was accepted - outside the run - so a parser that finishes on
 * a later socket read calls next() from the socket's context, with an empty store,
 * and the handler's first db call throws. A browser streams a multipart body, so
 * this is every real upload; supertest's fixtures fit one read, which is why the
 * suite never saw it.
 *
 * The trigger is the number of reads, not the size of the body: 60 bytes in three
 * writes reproduces it and 58 KB in one write does not. The primary case below
 * therefore drives the delivery itself rather than betting that this machine's
 * receive buffer is smaller than some fixture.
 */
describe('a body that spans socket reads keeps its workspace', () => {
  it('a multipart upload written in three pieces still imports', async () => {
    const body = multipartBody(
      { accountName: 'Chunked Bank', currency: 'EUR', preset: 'generic' },
      'chunked.csv',
      csvFile('chunked groceries'),
    );
    // the fixture is tiny on purpose: a megabyte one would be asserting the size of
    // this machine's socket buffer instead of the mechanism
    expect(body.length).toBeLessThan(1024);

    const res = await sendInPieces(
      '/api/imports',
      `multipart/form-data; boundary=${BOUNDARY}`,
      body,
      3,
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const summary = res.body.summary as { importId: string; accountId: string; total: number };
    expect(summary).toMatchObject({ total: 1 });
    expect((await confirm(summary.importId)).body.inserted).toBe(1);
    // the answer alone is not enough - the row has to be in this workspace
    const rows = (await agent.get('/api/transactions?limit=200')).body as { description: string }[];
    expect(rows.filter((t) => /chunked groceries/.test(t.description))).toHaveLength(1);
  });

  /**
   * The delivery the user actually hit: one .attach() large enough that supertest's
   * own write does not reach the server in a single read. Cheaper to read and weaker
   * to trust - the size at which it trips belongs to the operating system - so it
   * stands beside the case above, never instead of it.
   */
  it('a 256 KB upload through supertest still imports', async () => {
    const padded = Buffer.from(
      [
        'date,amount,description,note',
        // the padding sits in a column no mapping reads, so the bulk never reaches the database
        `2026-05-01,-12.34,padded statement,${'x'.repeat(256 * 1024)}`,
      ].join('\n'),
      'utf8',
    );

    const res = await agent
      .post('/api/imports')
      .field('accountName', 'Big Body Bank')
      .field('currency', 'EUR')
      .attach('file', padded, 'big.csv');

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.summary).toMatchObject({ total: 1 });
    expect((await confirm(res.body.summary.importId)).body.inserted).toBe(1);
    const rows = (await agent.get('/api/transactions?limit=200')).body as { description: string }[];
    expect(rows.filter((t) => /padded statement/.test(t.description))).toHaveLength(1);
  });

  /**
   * The JSON and raw paths, chunked the same way. Both of these pass on the code the
   * case above fails, and they are not redundant: body-parser hands next() a plain
   * callback exactly as multer does, and the only reason it survives is that raw-body
   * binds that callback through AsyncResource itself. That is a property of a
   * transitive dependency, not of this app. These two exist to fail the day it stops
   * being true - and that is the only day they will look worth their keep.
   *
   * The backup carries no tables, so it restores nothing and leaves the rows above
   * alone: what is under test is the context restoreBackup runs in, not the restore.
   */
  const emptyBackup = Buffer.from(
    JSON.stringify({ format: 'finto-backup', version: 1, tables: {} }),
    'utf8',
  );

  it('a chunked JSON body keeps its workspace', async () => {
    const res = await sendInPieces('/api/restore', 'application/json', emptyBackup, 4);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ restored: true });
  });

  it('a chunked octet-stream body keeps its workspace', async () => {
    const res = await sendInPieces('/api/restore', 'application/octet-stream', emptyBackup, 4);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ restored: true });
  });
});
