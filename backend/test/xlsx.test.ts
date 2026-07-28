/**
 * The XLSX parser (ROADMAP 5.2), through the same entry point the endpoint uses.
 *
 * Every fixture is built here with exceljs and never committed as a binary: a
 * checked-in .xlsx is a file nobody can read in a diff, and the cases that matter
 * are all about cell TYPES, which is exactly what the writer lets us state.
 *
 * The case this suite exists for is the mixed sheet. A workbook where only some
 * dates are typed as dates imports half a statement and answers 200 - louder
 * failures announce themselves, that one does not.
 */
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { getAccount, listAccounts, listImports, listTransactions } from '../src/db';
import { importStatement } from '../src/providers/statement';
import { MAX_DATA_ROWS } from '../src/providers/sheet';
import { XLSX_PARSER_VERSION } from '../src/providers/xlsx';

const utc = (day: string): Date => new Date(`${day}T00:00:00.000Z`);

async function xlsx(build: (wb: ExcelJS.Workbook) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const importFile = (accountName: string, bytes: Buffer) =>
  importStatement({ accountName, currency: 'EUR', bytes });

/** date, amount and description of an account's rows, oldest first. */
async function rowsOf(accountId: string): Promise<unknown[][]> {
  const txs = await listTransactions({ accountId, limit: 500 });
  return txs
    .map((t) => [t.date, t.amount, t.description, t.category])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
}

describe('xlsx: typed cells', () => {
  it('produces the same transactions as the CSV of the same statement', async () => {
    const rows: [Date, number, string][] = [
      [utc('2026-01-05'), -900, 'Miete Januar'],
      [utc('2026-01-06'), -23.45, 'REWE SAGT DANKE'],
      [utc('2026-01-07'), 1234.56, 'Gehalt Januar'],
      // a float the file cannot store exactly: toCents owns the rounding, not the parser
      [utc('2026-01-08'), 0.1 + 0.2, 'Rounding'],
    ];
    const book = await xlsx((wb) => {
      const ws = wb.addWorksheet('Statement');
      ws.addRow(['date', 'amount', 'description']);
      for (const row of rows) ws.addRow(row);
    });

    const fromXlsx = await importFile('Xlsx Bank', book);
    expect(fromXlsx.inserted).toBe(4);
    expect(fromXlsx.skipped).toBe(0);

    const csv = [
      'date,amount,description',
      ...rows.map(([d, a, t]) => `${d.toISOString().slice(0, 10)},${a},${t}`),
    ].join('\n');
    const fromCsv = await importFile('Csv Twin Bank', Buffer.from(csv, 'utf8'));
    expect(fromCsv.inserted).toBe(4);

    expect(await rowsOf(fromXlsx.accountId)).toEqual(await rowsOf(fromCsv.accountId));
    const stored = await rowsOf(fromXlsx.accountId);
    expect(stored[0][0]).toBe('2026-01-05T00:00:00.000Z');
    expect(stored[3][1]).toBe(0.3);
  });

  /**
   * Trap 5, the partial-rejection case: a sheet where the export typed some dates
   * and left the rest as text. Rejecting the untyped half would import half a
   * statement and report success.
   */
  it('a sheet mixing typed and text cells imports every row', async () => {
    const book = await xlsx((wb) => {
      const ws = wb.addWorksheet('Mixed');
      ws.addRow(['date', 'amount', 'description']);
      ws.addRow([utc('2026-02-01'), -10.5, 'typed date, typed amount']);
      ws.addRow(['02.02.2026', '-23,45', 'text date, text amount']);
      ws.addRow([utc('2026-02-03'), '-1.140,57', 'typed date, text amount']);
      ws.addRow(['2026-02-04', -7.25, 'text date, typed amount']);
    });

    const r = await importFile('Mixed Bank', book);
    expect([r.total, r.inserted, r.skipped]).toEqual([4, 4, 0]);
    const stored = await rowsOf(r.accountId);
    expect(stored.map((row) => row[0])).toEqual([
      '2026-02-01T00:00:00.000Z',
      '2026-02-02T00:00:00.000Z',
      '2026-02-03T00:00:00.000Z',
      '2026-02-04T00:00:00.000Z',
    ]);
    expect(stored.map((row) => row[1])).toEqual([-10.5, -23.45, -1140.57, -7.25]);
  });

  /**
   * The dates are the point: read with local-time getters, half the world's
   * timezones would shift the calendar day, and the shifted day goes into the
   * dedup key - so the same statement re-imported elsewhere would duplicate.
   */
  it('a 1904-date-system workbook lands on the same calendar days', async () => {
    // a General-formatted date column comes back as a raw serial; in the 1904
    // system it counts from a day 1462 later
    const serial1904 = (d: Date): number => d.getTime() / 86400000 + 25569 - 1462;
    const book = await xlsx((wb) => {
      wb.properties.date1904 = true;
      const ws = wb.addWorksheet('Mac');
      ws.addRow(['date', 'amount', 'description']);
      ws.addRow([utc('2026-08-01'), -14, 'typed date']);
      ws.addRow([serial1904(utc('2026-08-02')), -15, 'raw serial']);
    });

    const r = await importFile('Mac Bank', book);
    expect(r.inserted).toBe(2);
    expect((await rowsOf(r.accountId)).map((row) => row[0])).toEqual([
      '2026-08-01T00:00:00.000Z',
      '2026-08-02T00:00:00.000Z',
    ]);
  });

  /** A number the parser will not read as a date has to say so: no preset can fix it. */
  it('a number in the date column that is not a serial names its own cause', async () => {
    const book = await xlsx((wb) => {
      const ws = wb.addWorksheet('Numbers');
      ws.addRow(['date', 'amount', 'description']);
      ws.addRow([utc('2026-09-05'), -10, 'fine']);
      ws.addRow([20260106, -11, 'a date written as a number']);
    });

    const r = await importFile('Number Date Bank', book);
    expect([r.total, r.inserted, r.skipped]).toEqual([2, 1, 1]);
    expect(r.problems[0]).toBe(
      'row 3: the date cell holds the number 20260106, which this parser will not read as a date - format that column as a date and upload again',
    );
  });
});

describe('xlsx: cells that are not scalars', () => {
  it('formulas, rich text and hyperlinks land as values; a lost cell says why', async () => {
    const book = await xlsx((wb) => {
      const ws = wb.addWorksheet('Fancy');
      ws.addRow(['date', 'amount', 'description']);
      const computed = ws.addRow([utc('2026-04-01'), null, null]);
      computed.getCell(2).value = { formula: 'E2*2', result: -12.5 };
      computed.getCell(3).value = { richText: [{ text: 'REWE ' }, { text: 'Markt' }] };
      const linked = ws.addRow([utc('2026-04-02'), -8.4, null]);
      linked.getCell(3).value = { text: 'Amazon order', hyperlink: 'https://example.com/x' };
      const uncached = ws.addRow([utc('2026-04-03'), null, 'no cached result']);
      uncached.getCell(2).value = { formula: 'E4*2' } as ExcelJS.CellFormulaValue;
      const broken = ws.addRow([utc('2026-04-04'), null, 'error cell']);
      broken.getCell(2).value = { error: '#N/A' } as ExcelJS.CellErrorValue;
    });

    const r = await importFile('Fancy Bank', book);
    expect([r.total, r.inserted, r.skipped]).toEqual([4, 2, 2]);

    const stored = await rowsOf(r.accountId);
    expect(stored.map((row) => row[2])).toEqual(['REWE Markt', 'Amazon order']);
    // a computed amount column is common in bank exports: it must stay a number
    expect(stored[0][1]).toBe(-12.5);

    // and the two it dropped are reported as what they are, not as "could not parse"
    expect(r.problems).toEqual([
      'row 4: the amount cell is a formula with no stored result - open the file in Excel, re-save it, and upload again',
      'row 5: the amount cell contains #N/A',
    ]);
  });
});

describe('xlsx: finding the statement', () => {
  it('finds the header under a title block, and reports the real sheet row', async () => {
    const book = await xlsx((wb) => {
      const ws = wb.addWorksheet('Kontoauszug');
      ws.addRow(['Kontoauszug 2026']);
      ws.mergeCells('A1:C1');
      ws.addRow(['Konto', 'DE1234', '']);
      ws.addRow([]);
      ws.addRow(['date', 'amount', 'description']);
      ws.addRow([utc('2026-03-01'), -10, 'first']);
      ws.addRow(['not a date', 'not a number', 'broken']);
    });

    const r = await importFile('Preamble Bank', book);
    expect([r.total, r.inserted, r.skipped]).toEqual([2, 1, 1]);
    expect(r.problems[0]).toBe(
      'row 6: could not parse the date "not a date" or the amount "not a number"',
    );
  });

  it('reads the first visible sheet that has a header, not simply the first', async () => {
    const book = await xlsx((wb) => {
      const notes = wb.addWorksheet('Notes');
      notes.state = 'hidden';
      notes.addRow(['date', 'amount', 'description']);
      notes.addRow([utc('2026-06-01'), -99, 'must not be imported']);
      const cover = wb.addWorksheet('Cover');
      cover.addRow(['Your statement']);
      cover.addRow(['generated', '2026-06-30']);
      const ws = wb.addWorksheet('Transactions');
      ws.addRow(['date', 'amount', 'description']);
      ws.addRow([utc('2026-06-02'), -11, 'real row']);
    });

    const r = await importFile('Cover Bank', book);
    expect(r.inserted).toBe(1);
    expect((await rowsOf(r.accountId)).map((row) => row[2])).toEqual(['real row']);
  });

  it('blank and formatting-only rows are counted nowhere', async () => {
    const book = await xlsx((wb) => {
      const ws = wb.addWorksheet('Gaps');
      ws.addRow(['date', 'amount', 'description']);
      ws.addRow([utc('2026-05-01'), -5, 'one']);
      ws.addRow([]);
      const styled = ws.addRow(['', '', '']);
      styled.getCell(1).font = { bold: true };
      ws.addRow([utc('2026-05-02'), -6, 'two']);
    });

    const r = await importFile('Gaps Bank', book);
    expect([r.total, r.inserted, r.skipped]).toEqual([2, 2, 0]);
  });

  /**
   * A statement that ends in "Total  1.234,56". It is not blank, so it survives
   * into the counts and shows the client's "rows couldn't be read" warning - which
   * is exactly what a CSV of the same statement does today. Asserted so the next
   * person meets it here rather than in a bug report.
   */
  it('a trailing summary row is skipped and reported', async () => {
    const book = await xlsx((wb) => {
      const ws = wb.addWorksheet('Summed');
      ws.addRow(['date', 'amount', 'description']);
      ws.addRow([utc('2026-11-01'), -12, 'one']);
      ws.addRow([utc('2026-11-02'), -22, 'two']);
      ws.addRow(['Total', '-34,00', '']);
    });

    const r = await importFile('Summed Bank', book);
    expect([r.total, r.inserted, r.skipped]).toEqual([3, 2, 1]);
    expect(r.problems[0]).toBe('row 4: could not parse the date "Total" or the amount "-34,00"');
  });

  it('no header anywhere leaves a failed import, and the same bytes may be retried', async () => {
    const book = await xlsx((wb) => {
      const ws = wb.addWorksheet('Sheet1');
      ws.addRow(['when', 'how much', 'what']);
      ws.addRow([utc('2026-07-01'), -10, 'Bakery']);
    });

    // and it carries the reason the nearest row was not a header - the header row
    // itself, which beats the data row it ties with on width
    await expect(importFile('Odd Columns Bank', book)).rejects.toThrow(
      /could not find a header row in any sheet of the workbook \(looked at: Sheet1\).*- the closest row \(sheet "Sheet1", row 1\) does not match: could not find date\/amount\/description columns in the header: when, how much, what/,
    );
    const failed = (await listImports()).filter((i) =>
      /could not find a header row/.test(i.errorDetail ?? ''),
    );
    expect(failed).toHaveLength(1);
    // the import records which parser ran and at which version, not just that one did
    expect(failed[0]).toMatchObject({
      status: 'failed',
      sourceType: 'xlsx',
      parserVersion: XLSX_PARSER_VERSION,
      transactions: 0,
    });
    expect(await getAccount('csv:odd-columns-bank')).toBeUndefined();

    // a failed import does not claim the file - only a committed one does
    const retried = await importStatement({
      accountName: 'Odd Columns Bank',
      currency: 'EUR',
      bytes: book,
      mapping: { date: 'when', amount: 'how much', description: 'what' },
    });
    expect(retried.duplicate).toBeUndefined();
    expect(retried.inserted).toBe(1);
  });

  /**
   * The XLSX path used to answer "pick a preset" to a user who had picked one. The
   * CSV of the same statement names the column that is missing; the scan computes
   * that sentence for every row it rejects, so it costs nothing to report it.
   */
  it('a preset that does not match names the missing column, as the CSV path does', async () => {
    const book = await xlsx((wb) => {
      const ws = wb.addWorksheet('Statement');
      ws.addRow(['date', 'amount', 'description']);
      ws.addRow([utc('2026-10-09'), -5, 'one']);
    });

    await expect(
      importStatement({
        accountName: 'Wrong Preset Bank',
        currency: 'EUR',
        preset: 'sparkasse',
        bytes: book,
      }),
    ).rejects.toThrow(/column "Buchungstag" is not in the header: date, amount, description/);
  });

  /**
   * The sniffer sees a zip and cannot know more than that. Unlike a PDF or an
   * .xls - refused before any import row exists - this one fails inside the
   * loader, so it does leave a failed import. That asymmetry is deliberate.
   */
  it('a zip that is not a workbook fails with a message about zips', async () => {
    const notAWorkbook = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from('this is not a spreadsheet', 'utf8'),
    ]);
    await expect(importFile('Ods Bank', notAWorkbook)).rejects.toThrow(
      /zip archive but not an Excel workbook/,
    );
    expect(
      (await listImports()).filter((i) => /zip archive/.test(i.errorDetail ?? '')),
    ).toHaveLength(1);
  });
});

describe('xlsx: the same statement in two formats', () => {
  it('the same file twice is recognised by its hash and never parsed again', async () => {
    const book = await xlsx((wb) => {
      const ws = wb.addWorksheet('Twice');
      ws.addRow(['date', 'amount', 'description']);
      ws.addRow([utc('2026-12-01'), -31, 'once']);
    });

    const first = await importFile('Twice Bank', book);
    expect(first.inserted).toBe(1);
    const second = await importFile('Twice Bank', book);
    expect(second.duplicate).toBe(true);
    expect(second.importId).toBe(first.importId);
    expect(second.inserted).toBe(0);
  });

  /**
   * Why the account id keeps its `csv:` prefix and the rows keep one provider
   * whatever parser ran: the same bank exported as CSV one month and as XLSX the
   * next has to land in ONE account. Two accounts would mean two dedup namespaces
   * - the unique index is (workspace, account, dedup_key) - and every overlapping
   * row would insert a second time, silently duplicating real history.
   */
  it('a statement uploaded as CSV and again as XLSX lands in one account', async () => {
    const rows: [string, number, string][] = [
      ['2026-01-20', -19.99, 'Cross format one'],
      ['2026-01-21', -29.99, 'Cross format two'],
    ];
    const csv = ['date,amount,description', ...rows.map((r) => r.join(','))].join('\n');
    const book = await xlsx((wb) => {
      const ws = wb.addWorksheet('Both');
      ws.addRow(['date', 'amount', 'description']);
      for (const [day, amount, description] of rows) ws.addRow([utc(day), amount, description]);
    });

    const asCsv = await importFile('Cross Format Bank', Buffer.from(csv, 'utf8'));
    expect(asCsv.inserted).toBe(2);
    const asXlsx = await importFile('Cross Format Bank', book);
    expect(asXlsx.duplicate).toBeUndefined();
    expect(asXlsx.inserted).toBe(0);
    expect(asXlsx.accountId).toBe(asCsv.accountId);

    const accounts = (await listAccounts()).filter((a) => a.name === 'Cross Format Bank');
    expect(accounts).toHaveLength(1);
    expect(accounts[0].provider).toBe('upload');
    expect(await listTransactions({ accountId: asCsv.accountId })).toHaveLength(2);
  });
});

describe('the row guard', () => {
  /**
   * Over the cap the import aborts before a single row is written. Truncating at
   * the cap and answering 200 would import a partial statement and report success.
   */
  it('a statement over the cap is refused, and the bytes stay uploadable', async () => {
    const csv = [
      'date,amount,description',
      ...Array.from({ length: MAX_DATA_ROWS + 1 }, (_, i) => `2026-09-01,-1.00,row ${i}`),
    ].join('\n');
    const bytes = Buffer.from(csv, 'utf8');
    const attempt = () => importStatement({ accountName: 'Huge Bank', currency: 'EUR', bytes });

    await expect(attempt()).rejects.toThrow(/50001 data rows/);
    expect(await getAccount('csv:huge-bank')).toBeUndefined();
    // no committed import claims the hash, so the same bytes are parsed again
    await expect(attempt()).rejects.toThrow(/50001 data rows/);

    const refused = (await listImports()).filter((i) => /data rows/.test(i.errorDetail ?? ''));
    expect(refused).toHaveLength(2);
    expect(refused.every((i) => i.status === 'failed' && i.transactions === 0)).toBe(true);
  });

  /**
   * rowCount counts rows carrying nothing but formatting, and formatting a whole
   * column is something people do. A guard on it alone would refuse a 200-row
   * statement with a "too many rows" message and no recourse.
   */
  it('a sheet formatted far past its data still imports', async () => {
    const book = await xlsx((wb) => {
      const ws = wb.addWorksheet('Formatted');
      ws.addRow(['date', 'amount', 'description']);
      for (let i = 0; i < 200; i++) ws.addRow([utc('2026-10-01'), -(i + 1), `row ${i}`]);
      ws.getRow(60_000).height = 20;
    });

    const r = await importFile('Formatted Bank', book);
    expect([r.total, r.inserted, r.skipped]).toEqual([200, 200, 0]);
  });

  /**
   * A sheet nobody can read is disqualified the way a hidden one is - it is not
   * the statement. Refusing the workbook for it would turn a cover sheet somebody
   * formatted to the bottom into a statement that cannot be imported at all.
   */
  it('an oversized sheet is skipped, and the statement behind it still imports', async () => {
    const book = await xlsx((wb) => {
      const cover = wb.addWorksheet('Cover');
      cover.getRow(600_000).height = 20;
      const ws = wb.addWorksheet('Statement');
      ws.addRow(['date', 'amount', 'description']);
      ws.addRow([utc('2026-10-05'), -1, 'one']);
      ws.addRow([utc('2026-10-06'), -2, 'two']);
      ws.addRow([utc('2026-10-07'), -3, 'three']);
    });

    const r = await importFile('Cover Sheet Bank', book);
    expect([r.total, r.inserted, r.skipped]).toEqual([3, 3, 0]);
    expect(await getAccount('csv:cover-sheet-bank')).toBeDefined();
  });

  /**
   * With nothing behind it the workbook is still refused - but as what it is. "Could
   * not find a header row" would send the user looking at their column names for a
   * sheet that was never read.
   */
  it('a workbook of nothing but an oversized sheet says it was too large to read', async () => {
    const book = await xlsx((wb) => {
      const ws = wb.addWorksheet('Huge');
      ws.addRow(['date', 'amount', 'description']);
      ws.addRow([utc('2026-10-08'), -4, 'one']);
      ws.getRow(600_000).height = 20;
    });
    const attempt = () => importFile('Oversized Bank', book);

    await expect(attempt()).rejects.toThrow(/skipped as too large to read: Huge \(600000 rows\)/);
    expect(await getAccount('csv:oversized-bank')).toBeUndefined();
    // no committed import claims the hash, so the same bytes are read again
    await expect(attempt()).rejects.toThrow(/skipped as too large to read/);

    const refused = (await listImports()).filter((i) =>
      /too large to read/.test(i.errorDetail ?? ''),
    );
    expect(refused).toHaveLength(2);
    expect(refused.every((i) => i.status === 'failed' && i.transactions === 0)).toBe(true);
  });
});

/**
 * The size cap is decidable from the bytes, so it is refused in the same band as a
 * PDF: no `imports` row at all. A user who picks a 12 MB workbook made the same
 * kind of mistake as one who picks a PDF, and neither is an import that failed.
 */
describe('the workbook size cap', () => {
  it('a workbook past the cap is refused before an import row exists', async () => {
    const oversized = Buffer.alloc(11 * 1024 * 1024);
    Buffer.from([0x50, 0x4b, 0x03, 0x04]).copy(oversized);
    const before = (await listImports()).length;
    const attempt = () => importFile('Fat Workbook Bank', oversized);

    await expect(attempt()).rejects.toThrow(/the workbook is larger than 10 MB/);
    expect(await listImports()).toHaveLength(before);
    // nothing recorded the hash, so this is a second refusal and not a duplicate
    await expect(attempt()).rejects.toThrow(/the workbook is larger than 10 MB/);
    expect(await listImports()).toHaveLength(before);
  });

  /**
   * The cap is the workbook's alone: the upload limit is 25 MB, so dropping the
   * source-type condition would refuse every CSV between the two.
   */
  it('a CSV larger than the workbook cap is not refused by it', async () => {
    const padding = 'x'.repeat(10 * 1024 * 1024 + 1024);
    const csv = [
      'date,amount,description,notes',
      `2026-10-10,-1.00,one,${padding}`,
      '2026-10-11,-2.00,two,',
      '2026-10-12,-3.00,three,',
    ].join('\n');

    const r = await importFile('Fat Csv Bank', Buffer.from(csv, 'utf8'));
    expect([r.total, r.inserted, r.skipped]).toEqual([3, 3, 0]);
    expect((await rowsOf(r.accountId)).map((row) => row[2])).toEqual(['one', 'two', 'three']);
  });
});
