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
import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { initAuth } from '../src/auth';
import { dbInstance, setWorkspaceFallback } from '../src/db';
import { TEST_WORKSPACE_ID } from './pglite';

const csvFile = (label: string): Buffer =>
  Buffer.from(['date,amount,description', `2026-03-01,-10.00,${label}`].join('\n'), 'utf8');

async function xlsxFile(label: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Statement');
  ws.addRow(['date', 'amount', 'description']);
  ws.addRow([new Date('2026-04-01T00:00:00.000Z'), -20.5, label]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

let agent: request.Agent;

/** The workspace's imports, newest first. */
const imports = async (): Promise<{ sourceType: string; originalFilename: string | null }[]> =>
  (await agent.get('/api/imports')).body.imports;

beforeAll(async () => {
  initAuth(dbInstance());
  setWorkspaceFallback(undefined);

  agent = request.agent(app);
  const res = await agent
    .post('/api/auth/sign-up/email')
    .send({ email: 'uploader@example.com', password: 'correct-horse-battery', name: 'uploader' });
  expect(res.status, `sign-up failed: ${JSON.stringify(res.body)}`).toBeLessThan(300);
});

afterAll(() => {
  // the fallback is process-wide - the rest of the run expects it armed
  setWorkspaceFallback(TEST_WORKSPACE_ID);
});

describe('POST /api/imports', () => {
  it('takes a CSV as multipart and answers with the import result', async () => {
    const res = await agent
      .post('/api/imports')
      .field('accountName', 'Http Bank')
      .field('currency', 'EUR')
      .field('preset', 'generic')
      .attach('file', csvFile('HTTP groceries'), 'statement.csv');

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      accountId: 'csv:http-bank',
      accountIds: ['csv:http-bank'],
      inserted: 1,
      skipped: 0,
      total: 1,
      problems: [],
    });
    expect(res.body.importId).toEqual(expect.any(String));

    const [latest] = await imports();
    expect(latest).toMatchObject({ sourceType: 'csv', originalFilename: 'statement.csv' });
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
    expect(res.body).toMatchObject({ accountId: 'csv:workbook-bank', inserted: 1, total: 1 });

    const [latest] = await imports();
    expect(latest.sourceType).toBe('xlsx');
  });

  it('the same file twice answers duplicate without parsing it again', async () => {
    const upload = () =>
      agent
        .post('/api/imports')
        .field('accountName', 'Twice Over Http')
        .field('currency', 'EUR')
        .attach('file', csvFile('sent twice'), 'twice.csv');

    const first = await upload();
    expect(first.body.inserted).toBe(1);
    const second = await upload();
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ duplicate: true, inserted: 0, importId: first.body.importId });
    expect(second.body.uploadedAt).toEqual(expect.any(String));
  });

  it('a PDF is refused with a message that says what to do, and creates no import', async () => {
    const before = (await imports()).length;
    const res = await agent
      .post('/api/imports')
      .field('accountName', 'Pdf Bank')
      .field('currency', 'EUR')
      .attach('file', Buffer.from('%PDF-1.4\n1 0 obj\n<< >>\n', 'utf8'), 'statement.pdf');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/PDF statements are not supported yet - export the statement/);
    expect(await imports()).toHaveLength(before);
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
    expect(xml.body.error).toMatch(/XML or HTML.*CAMT\.053 and MT940 are not supported yet/);

    const binary = await send(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a, 0x0a]), 'chart.png');
    expect(binary.status).toBe(400);
    expect(binary.body.error).toBe('this file is neither a CSV nor an Excel workbook (.xlsx)');
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
    expect(unknownKey.body.error).toMatch(/date_format/);

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
  });

  it('the JSON CSV endpoints are gone', async () => {
    expect((await agent.post('/api/csv/import').send({ csv: 'a,b' })).status).toBe(404);
    expect((await agent.get('/api/csv/presets')).status).toBe(404);
  });
});
