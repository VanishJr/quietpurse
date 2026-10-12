/**
 * The ingestion surface over real HTTP: one multipart endpoint that
 * decides what the file is from its bytes.
 *
 * Driven through supertest, because the parts worth testing only exist in the
 * middleware chain: what the multipart parser refuses, and that a file the app
 * cannot read is refused with something the user can act on rather than a generic
 * 400.
 */
import http from 'http';
import { AddressInfo } from 'net';
import { sql } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { dbInstance, seedDefaults } from '../src/db';
import { type Agent, listening, serve } from './loopback';
import { freshTestDb } from './pglite';
import { ACCOUNT_NOT_FOUND, ACCOUNT_REMOVED } from '../src/providers/statement';
import { buildPdf, buildSignedContainer } from './pdffixture';

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

let agent: Agent;

/** Every import, newest first. */
const imports = async (): Promise<
  {
    sourceType: string;
    parserVersion: number;
    originalFilename: string | null;
    status: string;
    documentAvailable: boolean;
    errorDetail: string | null;
  }[]
> => (await agent.get('/api/imports')).body.imports;

/** An upload only stages its rows. The confirm is what makes them the person's data. */
const confirm = (importId: string) => agent.post(`/api/imports/${importId}/confirm`);

/**
 * Everything asserted below is exact, so the file starts from an empty database. The
 * setup file already truncates and seeds before every file; this pair is here anyway,
 * so the exactness rests on a line in this file rather than on a setup file this one
 * does not name.
 */
beforeAll(async () => {
  await freshTestDb();
  await seedDefaults();
  agent = await serve(app);
});

/**
 * An empty account over the same door the Accounts screen uses, which is where every
 * account in this file comes from since the upload stopped taking a name: the door is
 * what this file is about.
 */
const makeAccount = async (name: string, currency = 'EUR'): Promise<string> => {
  const res = await agent.post('/api/accounts').send({ name, currency });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
};

describe('POST /api/imports', () => {
  it.each([
    ['30.02.2026', 'which is not a day on the calendar'],
    ['2026-01-05 25:99', 'whose time of day does not exist'],
  ])('refuses the whole statement over the date %j: the import ends failed, with no row staged', async (cell, why) => {
    const accountId = await makeAccount(`Impossible Bank ${cell}`);
    const file = Buffer.from(
      ['date,amount,description', '2026-03-01,-10.00,Ordinary row', `${cell},-4.00,Impossible row`].join('\n'),
      'utf8',
    );
    const refusal = `row 3: the date cell reads "${cell}", ${why}. Nothing was imported: correct the date in the file, and upload it again`;

    const res = await agent.post('/api/imports').field('accountId', accountId).field('preset', 'generic').attach('file', file, 'impossible.csv');

    expect(res.status).toBe(400);
    expect(res.body.error).toContain(refusal);
    const [latest] = (await agent.get('/api/imports')).body.imports as { id: string }[];
    expect(latest).toMatchObject({ originalFilename: 'impossible.csv', status: 'failed', errorDetail: refusal });
    const staged = (await dbInstance().execute(
      sql`SELECT COUNT(*) AS n FROM staged_transactions WHERE import_id = ${latest.id}`,
    )) as unknown as { rows: { n: number | string }[] };
    expect(Number(staged.rows[0].n)).toBe(0);
  });

  it('a confirm of rows an earlier version staged with a date that does not exist sends the user to upload again', async () => {
    const accountId = await makeAccount('Staged Earlier Bank');
    const res = await agent
      .post('/api/imports')
      .field('accountId', accountId)
      .field('preset', 'generic')
      .attach('file', csvFile('Staged by an earlier version'), 'earlier.csv');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const importId = res.body.summary.importId as string;
    // what an earlier version staged, which no upload stages any more
    await dbInstance().execute(
      sql`UPDATE staged_transactions SET date = '2026-02-30T00:00:00.000Z' WHERE import_id = ${importId}`,
    );

    const refused = await confirm(importId);

    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(
      'nothing was imported: an earlier version read this file and kept the date "2026-02-30T00:00:00.000Z", which is not a real day or time. Discard this import and upload the file again, and the upload will name the row to correct',
    );
    expect((await agent.get('/api/transactions').query({ accountId })).body).toEqual([]);
    // rolled back whole: still waiting, its row still staged, so Discard is a way out
    const waiting = ((await agent.get('/api/imports')).body.imports as { id: string; status: string }[])
      .find((r) => r.id === importId);
    expect(waiting?.status).toBe('awaiting_confirmation');
    const staged = (await dbInstance().execute(
      sql`SELECT COUNT(*) AS n FROM staged_transactions WHERE import_id = ${importId}`,
    )) as unknown as { rows: { n: number | string }[] };
    expect(Number(staged.rows[0].n)).toBe(1);
    expect((await agent.post(`/api/imports/${importId}/discard`)).status).toBe(200);
  });

  it.each(['EURO', '€', '978', 'грн'])(
    'refuses the whole statement over the currency %j: the import ends failed, with no row staged',
    async (cell) => {
      const accountId = await makeAccount(`Currency Bank ${cell}`);
      const file = Buffer.from(
        [
          'Date,Description,Amount,Currency',
          '2026-09-01,Invented shop,-12.50,EUR',
          `2026-09-02,Invented salary,1000.00,${cell}`,
        ].join('\n'),
        'utf8',
      );
      const refusal = `row 3: the currency is "${cell}", but it must be a three-letter code such as EUR or USD. Nothing was imported. Correct the currency in the file and upload it again`;

      const res = await agent.post('/api/imports').field('accountId', accountId).field('preset', 'generic').attach('file', file, 'currency.csv');

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: refusal });
      const [latest] = (await agent.get('/api/imports')).body.imports as { id: string }[];
      expect(latest).toMatchObject({ originalFilename: 'currency.csv', status: 'failed', errorDetail: refusal });
      const staged = (await dbInstance().execute(
        sql`SELECT COUNT(*) AS n FROM staged_transactions WHERE import_id = ${latest.id}`,
      )) as unknown as { rows: { n: number | string }[] };
      expect(Number(staged.rows[0].n)).toBe(0);
    },
  );

  it('takes a currency code in either case and stores it upper-cased', async () => {
    const accountId = await makeAccount('Lower Case Bank');
    const file = Buffer.from(['Date,Description,Amount,Currency', '2026-09-01,Invented shop,-12.50,usd'].join('\n'), 'utf8');

    const res = await agent.post('/api/imports').field('accountId', accountId).field('preset', 'generic').attach('file', file, 'lower.csv');

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.summary.totals).toEqual([{ currency: 'USD', net: -12.5 }]);
    expect((await confirm(res.body.summary.importId)).status).toBe(200);
    const [row] = (await agent.get('/api/transactions').query({ accountId })).body as { currency: string }[];
    expect(row.currency).toBe('USD');
  });

  it.each([
    ['EURO', 'EURO'],
    ['E'.repeat(600), `${'E'.repeat(23)}…`],
  ])('a confirm of rows an earlier version staged with the currency %j sends the user to upload again', async (kept, quoted) => {
    const accountId = await makeAccount(`Staged Currency Bank ${kept.length}`);
    const res = await agent
      .post('/api/imports')
      .field('accountId', accountId)
      .field('preset', 'generic')
      .attach('file', csvFile(`Staged currency ${kept.length}`), 'earlier-currency.csv');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const importId = res.body.summary.importId as string;
    await dbInstance().execute(
      sql`UPDATE staged_transactions SET currency = ${kept} WHERE import_id = ${importId}`,
    );

    const refused = await confirm(importId);

    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe(
      `nothing was imported: an earlier version read this file and kept the currency "${quoted}", which is not a three-letter code. Discard this import and upload the file again, and the upload will name the row to correct`,
    );
    expect((await agent.get('/api/transactions').query({ accountId })).body).toEqual([]);
    const waiting = ((await agent.get('/api/imports')).body.imports as { id: string; status: string }[])
      .find((r) => r.id === importId);
    expect(waiting?.status).toBe('awaiting_confirmation');
    expect((await agent.post(`/api/imports/${importId}/discard`)).status).toBe(200);
  });

  it('an account whose currency an earlier version stored as an unmapped numeric code still imports a file without a currency column', async () => {
    const accountId = await makeAccount('Digits Bank');
    await dbInstance().execute(sql`UPDATE accounts SET currency = '933' WHERE id = ${accountId}`);

    const res = await agent
      .post('/api/imports')
      .field('accountId', accountId)
      .field('preset', 'generic')
      .attach('file', csvFile('Digits row'), 'digits.csv');

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.summary.totals).toEqual([{ currency: '933', net: -10 }]);
    const confirmed = await confirm(res.body.summary.importId);
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body).toMatchObject({ inserted: 1 });
    const [row] = (await agent.get('/api/transactions').query({ accountId })).body as { currency: string }[];
    expect(row.currency).toBe('933');
  });

  it.each([
    ['933', '933'],
    ['euro', 'EURO'],
  ])(
    'an account an earlier version stored in %j imports a file whose currency column says %j, as the confirm takes it',
    async (stored, cell) => {
      const accountId = await makeAccount(`Stated Own Currency Bank ${stored}`);
      await dbInstance().execute(sql`UPDATE accounts SET currency = ${stored} WHERE id = ${accountId}`);
      const file = (currency: string) =>
        Buffer.from(['Date,Description,Amount,Currency', `2026-09-01,Invented shop,-12.50,${currency}`].join('\n'), 'utf8');
      const send = (currency: string) =>
        agent
          .post('/api/imports')
          .field('accountId', accountId)
          .field('preset', 'generic')
          .attach('file', file(currency), `own-currency-${currency}.csv`);

      const res = await send(cell);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.summary.totals).toEqual([{ currency: cell, net: -12.5 }]);
      const confirmed = await confirm(res.body.summary.importId);
      expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
      expect(confirmed.body).toMatchObject({ inserted: 1 });
      const [row] = (await agent.get('/api/transactions').query({ accountId })).body as { currency: string }[];
      expect(row.currency).toBe(cell);

      const other = await send('934');
      expect(other.status).toBe(400);
      expect(other.body.error).toMatch(/^row 2: the currency is "934", but it must be a three-letter code/);
    },
  );

  it('an empty file is refused with what to do, and leaves no import', async () => {
    const before = (await imports()).length;

    const res = await agent
      .post('/api/imports')
      .field('accountId', await makeAccount('Empty File Bank'))
      .attach('file', Buffer.alloc(0), 'empty.csv');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'this file is empty. Export the statement again from your online banking and upload the new file',
    });
    expect(await imports()).toHaveLength(before);
  });

  it.each([
    ['a header and no rows under it', 'date,amount,description\n'],
    ['nothing but blank lines', '\n   \n'],
  ])('a file with %s is refused with what to do', async (_, text) => {
    const res = await agent
      .post('/api/imports')
      .field('accountId', await makeAccount(`No Rows Bank ${text.length}`))
      .field('preset', 'generic')
      .attach('file', Buffer.from(text, 'utf8'), 'no-rows.csv');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error:
        'this file has no transactions in it. Export the statement again from your online banking for a period with transactions, and upload the new file',
    });
  });

  it('a lone transaction with no header above it is refused for its header, not as a file with no transactions', async () => {
    const res = await agent
      .post('/api/imports')
      .field('accountId', await makeAccount('Lone Line Bank'))
      .field('preset', 'generic')
      .attach('file', Buffer.from('2026-03-01,-10.00,Invented shop\n', 'utf8'), 'lone.csv');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/^could not find date\/amount\/description columns in the header/);
  });

  it('takes a CSV as multipart and answers with a summary to confirm', async () => {
    const res = await agent
      .post('/api/imports')
      .field('accountId', await makeAccount('Http Bank'))
      .field('preset', 'generic')
      .attach('file', csvFile('HTTP groceries'), 'statement.csv');

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.outcome).toBe('awaiting_confirmation');
    expect(res.body.summary).toMatchObject({
      accountName: 'Http Bank',
      total: 1,
      accepted: 1,
      skipped: 0,
      newRows: 1,
      alreadyPresent: 0,
      problems: [],
    });
    expect(res.body.summary.importId).toEqual(expect.any(String));

    const [latest] = await imports();
    expect(latest).toMatchObject({
      sourceType: 'csv',
      parserVersion: 4,
      originalFilename: 'statement.csv',
    });

    const confirmed = await confirm(res.body.summary.importId);
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    // the confirm lands in the account the summary named. That is what the id recorded
    // on the import is for: neither end derives the account from its name
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
   * no charset of its own. multer read them as latin1, one character per byte, so this
   * name was stored as "Ð²Ñ‹Ð¿Ð¸ÑÐºÐ°.xlsx" and nothing failed. The assertion reads the
   * column back out of the database rather than a header the route composed from this
   * test's own string, which would agree with itself.
   */
  it('stores a non-ASCII filename as the browser sent it', async () => {
    const res = await agent
      .post('/api/imports')
      .field('accountId', await makeAccount('Cyrillic Name Bank'))
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
   * uploaded under a .csv name and still goes to the XLSX parser. A bank that
   * names its Excel export .csv is not a hypothetical.
   */
  it('takes an XLSX, sniffed by content rather than by its name', async () => {
    const res = await agent
      .post('/api/imports')
      .field('accountId', await makeAccount('Workbook Bank'))
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
   * nowhere else. The same sentence sent twice under two names is the contract
   * drifting, and a mobile client cannot follow that.
   */
  it('a skipped sheet reaches the client in problems, and adds no field to the body', async () => {
    const res = await agent
      .post('/api/imports')
      .field('accountId', await makeAccount('Skipped Sheet Bank'))
      .attach('file', await xlsxFile('behind the cover', true), 'statement.xlsx');

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['outcome', 'summary']);
    expect(Object.keys(res.body.summary).sort()).toEqual([
      'accepted',
      'accountId',
      'accountName',
      'alreadyPresent',
      'filtered',
      'from',
      'importId',
      'newRows',
      'noMovement',
      'problems',
      'readAs',
      'skipped',
      'to',
      'total',
      'totals',
      'unreadable',
    ]);
    // without this the key set would also pass in the world where the notice stopped
    // reaching the client at all
    expect(res.body.summary.problems[0]).toMatch(
      /^sheet "Cover" \(600000 rows\) was too large to read and was skipped/,
    );
  });

  it('the same file twice answers duplicate without parsing it again', async () => {
    const accountId = await makeAccount('Twice Over Http');
    const upload = () =>
      agent
        .post('/api/imports')
        .field('accountId', accountId)
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
   * The duplicate answer composes its counts from the import row and the confirm answer
   * composes them from the confirm's outcome, so the two are held to each other here as
   * well as to the file.
   */
  it('the same file twice answers the skipped and total counts its confirm answered', async () => {
    const accountId = await makeAccount('Counted Twice Http');
    const bytes = Buffer.from(
      [
        'date,amount,description',
        '2026-05-01,-12.00,counted on the first',
        '2026-05-02,-7.50,counted on the second',
        '2026-05-03,40.00,counted on the third',
        '2026-05-04,0.00,moved nothing on the fourth',
      ].join('\n'),
      'utf8',
    );
    const upload = () =>
      agent
        .post('/api/imports')
        .field('accountId', accountId)
        .field('preset', 'generic')
        .attach('file', bytes, 'counted.csv');

    const first = await upload();
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.summary).toMatchObject({ total: 4, accepted: 3, skipped: 1 });

    const confirmed = await confirm(first.body.summary.importId);
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body).toMatchObject({ inserted: 3, skipped: 1, total: 4 });

    const second = await upload();
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body).toMatchObject({
      outcome: 'duplicate',
      importId: first.body.summary.importId,
      skipped: 1,
      total: 4,
    });
    expect({ skipped: second.body.skipped, total: second.body.total }).toEqual({
      skipped: confirmed.body.skipped,
      total: confirmed.body.total,
    });
  });

  /**
   * The PDF path opens the file now, so this moved bands: the same bytes that used to
   * be refused by the sniffer with no `imports` row are a `pdf` import that failed, and
   * the row and its stored document are what make the miss diagnosable. What stays
   * pinned here is that the message says what to do. The byte cap, which is still
   * decidable without opening anything, holds the no-row half of the rule from the
   * other side (pdf.test.ts).
   */
  it('a file that says %PDF and is not one fails as a pdf import, not as a CSV', async () => {
    const before = (await imports()).length;
    const res = await agent
      .post('/api/imports')
      .field('accountId', await makeAccount('Pdf Bank'))
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
   * A band change asserted rather than discovered: these bytes used to be refused
   * inside `sniff`, before createImport, so they left no import row and no stored
   * document. A container is a PDF now, so the file is opened and the document is
   * kept. The miss is a `failed` import someone can download, and such a download is
   * what a new PDF template is built from.
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
      .field('accountId', await makeAccount('Wrapped Bank'))
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
   * ASCII `0`, and this file's leading index column starts with one. This case pins
   * only that such a CSV imports, not which half of the rule parted it from a
   * container. The file carries no `%PDF-` anywhere, so the header search refuses it on
   * its own. The second byte is held by pdf.test.ts's lead-byte loop, which is where a
   * classifier boundary belongs.
   */
  it('a CSV whose first byte is the zero a container tag shares still imports', async () => {
    const csv = Buffer.from(
      ['0;date;amount;description', '1;01.07.2026;-10,00;REWE SAGT DANKE'].join('\n'),
      'utf8',
    );
    expect(csv[0]).toBe(0x30);

    const res = await agent
      .post('/api/imports')
      .field('accountId', await makeAccount('Zero Led Bank'))
      .attach('file', csv, 'statement.csv');

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.summary).toMatchObject({ total: 1, accepted: 1, skipped: 0 });
  });

  it('a legacy .xls is refused with the message for that format', async () => {
    const res = await agent
      .post('/api/imports')
      .field('accountId', await makeAccount('Old Excel Bank'))
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
    const accountId = await makeAccount('Odd Bytes Bank');
    const send = (bytes: Buffer, name: string) =>
      agent.post('/api/imports').field('accountId', accountId).attach('file', bytes, name);

    const xml = await send(
      Buffer.from('<?xml version="1.0"?><Document><BkToCstmrStmt/></Document>', 'utf8'),
      'camt.xml',
    );
    expect(xml.status).toBe(400);
    expect(xml.body.error).toBe(
      'this looks like XML or HTML, not a CSV, Excel (.xlsx) or PDF statement. Export the statement in one of those formats from your online banking and upload that. CAMT.053 and MT940 are not supported yet',
    );

    const binary = await send(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a, 0x0a]), 'chart.png');
    expect(binary.status).toBe(400);
    expect(binary.body.error).toBe(
      'this file is not a CSV, Excel (.xlsx) or PDF statement. Export the statement in one of those formats from your online banking and upload that',
    );
  });

  it('rejects a request with no file, or a mapping that is not an object', async () => {
    const noFile = await agent
      .post('/api/imports')
      .field('accountId', await makeAccount('No File Bank'));
    expect(noFile.status).toBe(400);
    expect(noFile.body.error).toMatch(/file field required/);

    const badMapping = await agent
      .post('/api/imports')
      .field('accountId', await makeAccount('Bad Mapping Bank'))
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
    const send = async (name: string, mapping: string) =>
      agent
        .post('/api/imports')
        .field('accountId', await makeAccount(name))
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

    // an empty `equals` accepts nothing and filters every row away. The answer would
    // then be "no row could be parsed", which reports the caller's own input back as a
    // fault in the file. tsc cannot see this bound: without .min(1) the suite stays green
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
      .field('accountId', await makeAccount('Wrong Field Bank'))
      .attach('statement', csvFile('x'), 'statement.csv');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('the upload must carry exactly one file field named "file"');
  });

  /** A text field over multer's limit is a problem with that field, not with the file. */
  it('an oversized text field names the field', async () => {
    const res = await agent
      .post('/api/imports')
      .field('accountId', await makeAccount('Fat Field Bank'))
      .field('mapping', 'x'.repeat(2 * 1024 * 1024))
      .attach('file', csvFile('x'), 'statement.csv');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/"mapping" field is larger than 1 MB/);
    expect(res.body.error).not.toMatch(/exactly one file field/);
  });

});

/**
 * The wire half of a destination that has one member. Multipart fields carry no type, so
 * the `never` keys on StatementDestination hold nothing here. These cases are what a
 * mobile client and curl meet, and the REST API is the contract: the picker is only one
 * of its clients. The retired fields are refused rather than ignored, so that a caller
 * still sending them is told where an account comes from instead of having half its
 * request dropped.
 */
describe('POST /api/imports picks an account by id', () => {
  /**
   * Distinct bytes per case, and not for tidiness: the hash short-circuit sits above
   * the destination resolution and stays there, so bytes a committed
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
      accepted: 1,
    });

    const confirmed = await confirm(res.body.summary.importId);
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body).toMatchObject({ accountId: id, accountIds: [id], inserted: 1 });
  });

  /**
   * accountName is refused rather than ignored. Ignoring it would silently drop one of
   * the two destinations a request stated, which is the guess the old exclusivity
   * refusal existed to prevent. The sentence has to say where an account comes from
   * now, because a caller sending this field believes an upload still makes one.
   */
  it('refuses accountName, and names the door that creates an account', async () => {
    const id = await makeAccount('Retired Name Arm');
    const before = (await imports()).length;

    const res = await uploadWith('a name arm', { accountId: id, accountName: 'A New Bank' });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error).toMatch(/POST \/api\/accounts/);
    // and nothing was staged on the way to the refusal
    expect(await imports()).toHaveLength(before);
  });

  it('refuses accountName even when it is the only destination sent', async () => {
    const res = await uploadWith('a name alone', { accountName: 'Nobody Made This' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/POST \/api\/accounts/);
  });

  it('refuses a request that carries neither', async () => {
    const res = await uploadWith('neither arm', {});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('accountId field required');
  });

  /**
   * An existing account owns its currency. Accepting one here and then reading the
   * account's instead makes it a field the caller believes in and nothing uses. That is
   * how "Savings" stayed EUR through a USD statement and reported it.
   *
   * Refused ahead of the accountId check, so a request carrying only this field reads
   * the sentence about currency rather than one about a field it did not send.
   */
  it('refuses a currency sent alongside an id', async () => {
    const id = await makeAccount('Own Currency Bank');
    const res = await uploadWith('own currency', { accountId: id, currency: 'USD' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/keeps its own currency/);
    expect(res.body.error).toMatch(/POST \/api\/accounts/);
  });

  it('refuses a currency sent alone, without asking for an accountId first', async () => {
    const res = await uploadWith('currency alone', { currency: 'USD' });

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
    expect(res.body.error).toMatch(/Unhide it/);
    expect(await imports()).toHaveLength(before);
  });

  /**
   * Refused, not normalised. Picking the first or the last of two values the caller
   * may not agree on is a guess about where a statement goes. The sentence names the
   * field, because "accountId field required" is false of a request that sent one
   * twice.
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
      .field('accountId', await makeAccount(accountName))
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
    expect(refused.body.error).toMatch(/Delete it instead of discarding it/);
  });

  /**
   * The confirm's guards refuse a broken invariant, which is nothing the user did. So
   * the status stays 5xx, or the operator's alerting would read a failure the server
   * caused as one the file caused. What must not stay is the body: `internal error` on
   * the one screen whose job is saying whether the data landed reads as transient, so
   * the person presses Confirm again forever.
   */
  it('a guard inside the confirm answers with the way out, not "internal error"', async () => {
    const { importId } = await stage('Broken Invariant Bank', 'staged then broken');
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

/**
 * GET /api/imports over the wire. The totals matter here rather
 * than at the data layer for one reason: they cross JSON.stringify. SUM() over
 * bigint is numeric and both drivers hand numeric over as a string, so an
 * unconverted total is the number 7 on PGlite and the string "7" in the Postgres CI
 * job. The client's `=== 1` plural tests would silently stop matching the string. The
 * toEqual against numeric literals below is what makes the two jobs disagree loudly.
 */
describe('GET /api/imports: the filter and the totals', () => {
  /** Distinct amounts across files as well as within one: equal rows deduplicate. */
  let mark = 0;
  const rows = (label: string, n: number): Buffer => {
    mark += 1;
    return Buffer.from(
      [
        'date,amount,description',
        ...Array.from(
          { length: n },
          (_, i) => `2026-07-01,-${mark * 100 + i + 1}.00,${label} ${i + 1}`,
        ),
      ].join('\n'),
      'utf8',
    );
  };

  /** An upload into `accountId`, confirmed so that its rows and its import are real data. */
  const importInto = async (accountId: string, label: string, n: number): Promise<string> => {
    const res = await agent
      .post('/api/imports')
      .field('accountId', accountId)
      .attach('file', rows(label, n), `${label}.csv`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const { importId } = res.body.summary;
    expect((await confirm(importId)).status).toBe(200);
    return importId as string;
  };

  it('filters the page and counts the filtered set, not every import', async () => {
    const mine = await makeAccount('Totals Mine');
    const other = await makeAccount('Totals Other');
    const stripped = await importInto(mine, 'totals-mine-a', 4);
    await importInto(mine, 'totals-mine-b', 3);
    await importInto(other, 'totals-other', 9);
    // one of mine keeps its bytes and stops claiming a readable document, so
    // totals.documents cannot just be totals.imports wearing another name
    expect((await agent.delete(`/api/imports/${stripped}/document`)).status).toBe(200);

    const res = await agent.get(`/api/imports?accountId=${encodeURIComponent(mine)}`);
    expect(res.status).toBe(200);
    // numeric literals on purpose: "7" passes nothing here
    expect(res.body.totals).toEqual({ imports: 2, documents: 1, transactions: 7 });
    expect(res.body.imports.map((r: { accountId: string }) => r.accountId)).toEqual([mine, mine]);
    // and the page is whole, so the total is the sum of what it carries
    expect(
      res.body.imports.reduce((n: number, r: { transactions: number }) => n + r.transactions, 0),
    ).toBe(7);
    expect(res.body.imports.filter((r: { documentAvailable: boolean }) => r.documentAvailable))
      .toHaveLength(1);

    // the other account's nine are in the unfiltered answer and in neither of mine
    const all = await agent.get('/api/imports');
    expect(all.status).toBe(200);
    expect(all.body.totals.imports).toBeGreaterThan(2);
    expect(all.body.totals.transactions).toBeGreaterThanOrEqual(16);
  });

  /**
   * The page is built by a hand-written alias list handed to rowsOf<T>, which
   * asserts the shape rather than deriving it: a dropped alias typechecks, and the
   * field it filled becomes undefined. This is the only layer where that is visible:
   * rowToImport builds an object literal, so the key survives an undefined value
   * everywhere until JSON.stringify drops it here.
   */
  it('sends every field of an import, none of them lost on the way out', async () => {
    const mine = await makeAccount('Totals Fields');
    await importInto(mine, 'totals-fields', 2);

    const res = await agent.get(`/api/imports?accountId=${encodeURIComponent(mine)}`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.imports[0]).sort()).toEqual([
      'accountId',
      'accountName',
      'documentAvailable',
      'errorDetail',
      'fileHash',
      'id',
      'originalFilename',
      'parserVersion',
      'rowsAccepted',
      'rowsRejected',
      'sourceType',
      'status',
      'transactions',
      'uploadedAt',
    ]);
  });

  it('an accountId that matches no account is an empty answer, not an error', async () => {
    const res = await agent.get('/api/imports?accountId=not-an-account');
    expect(res.status).toBe(200);
    expect(res.body.imports).toEqual([]);
    expect(res.body.totals).toEqual({ imports: 0, documents: 0, transactions: 0 });
  });

  it('an empty accountId is refused rather than read as every account', async () => {
    const res = await agent.get('/api/imports?accountId=');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('accountId must be sent once, as a single value');
  });

  it('a repeated accountId is refused rather than one of the two being picked', async () => {
    const res = await agent.get('/api/imports?accountId=a&accountId=b');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('accountId must be sent once, as a single value');
  });

  /**
   * Recorded, not endorsed. A bare express() gets Express 5's DEFAULT `simple` query
   * parser, and app.ts sets no other. That parser puts the brackets in the KEY, so
   * nothing called `accountId` arrives and this reads as every account. Switching to
   * the `extended` parser turns `accountId[]=x` into an array, and this test goes red
   * instead of the filter silently widening to every import there is.
   */
  it('bracket syntax is not an accountId under the simple query parser', async () => {
    const res = await agent.get('/api/imports?accountId[]=x');
    expect(res.status).toBe(200);
    const all = await agent.get('/api/imports');
    expect(res.body.totals).toEqual(all.body.totals);
  });
});

// ---------- how the body arrives ----------

const BOUNDARY = '----quietpurseChunkedBoundary';

/** A multipart body built by hand, so the test owns exactly which bytes go out when. */
function multipartBody(fields: Record<string, string>, filename: string, bytes: Buffer): Buffer {
  const parts: Buffer[] = Object.entries(fields).map(([name, value]) =>
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
 * go, so it cannot express this, and the number of writes is the only variable that
 * matters here.
 */
async function sendInPieces(
  path: string,
  contentType: string,
  body: Buffer,
  pieces: number,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { port } = (await listening(app)).address() as AddressInfo;
  return new Promise((resolve, reject) => {
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
}

/**
 * A body that arrives in more than one socket read.
 *
 * A browser streams a multipart body, so every real upload arrives this way, while
 * supertest's fixtures fit one read. That is how a parser mounted so that it lost its
 * request context on the second read once shipped green. The context went away with
 * the tenancy, but this delivery is still one the suite would otherwise never drive.
 *
 * The trigger is the number of reads, not the size of the body: a small body written
 * in pieces reproduces it and a large one written once does not. The primary case
 * below therefore drives the delivery itself rather than betting that this machine's
 * receive buffer is smaller than some fixture.
 */
describe('a body that spans socket reads still imports', () => {
  it('a multipart upload written in three pieces still imports', async () => {
    const body = multipartBody(
      { accountId: await makeAccount('Chunked Bank'), preset: 'generic' },
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
    // the row has to be there, not only the answer
    const rows = (await agent.get('/api/transactions?limit=200')).body as { description: string }[];
    expect(rows.filter((t) => /chunked groceries/.test(t.description))).toHaveLength(1);
  });

  /**
   * The delivery the user actually hit: one .attach() large enough that supertest's
   * own write does not reach the server in a single read. It is cheaper to read and
   * weaker to trust, because the size at which it trips belongs to the operating
   * system. So it stands beside the case above, never instead of it.
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
      .field('accountId', await makeAccount('Big Body Bank'))
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
   * transitive dependency, not of this app. They exist to fail the day it stops being
   * true, which is the only day they will look worth their keep.
   *
   * The backup carries no tables, so it restores nothing and leaves the rows above
   * alone: what is under test is the context restoreBackup runs in, not the restore.
   */
  const emptyBackup = Buffer.from(
    JSON.stringify({ format: 'quietpurse-backup', version: 1, tables: {} }),
    'utf8',
  );

  it('a chunked JSON body still restores', async () => {
    const res = await sendInPieces('/api/restore', 'application/json', emptyBackup, 4);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ restored: true });
  });

  it('a chunked octet-stream body still restores', async () => {
    const res = await sendInPieces('/api/restore', 'application/octet-stream', emptyBackup, 4);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ restored: true });
  });
});
