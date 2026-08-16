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
import { describe, expect, it, vi } from 'vitest';
import {
  ERROR_DETAIL_MAX,
  listAccounts,
  listImports,
  listTransactions,
} from '../src/db';
import { logImport } from '../src/logger';
import { accountFor, importAndConfirm, rejectionOf } from './helpers';
import { CSV_PRESETS, type CsvMapping } from '../src/providers/csv';
import { importStatement, readSheet } from '../src/providers/statement';
import { MAX_DATA_ROWS } from '../src/providers/sheet';
import { MAX_SHEET_ROWS } from '../src/providers/xlsx';

const utc = (day: string): Date => new Date(`${day}T00:00:00.000Z`);

/** The one mark both cuts in xlsx.ts carry, spelled out here rather than imported. */
const MARK = '…';

async function xlsx(build: (wb: ExcelJS.Workbook) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const importFile = async (name: string, bytes: Buffer) =>
  importAndConfirm({ accountId: await accountFor(name), bytes });

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

  /**
   * The error text is the FILE's, not the type's: CellErrorValue['error'] is seven
   * string literals at compile time and exceljs never checks the bytes it read against
   * them, so a workbook no spreadsheet wrote carries whatever it likes into the note.
   * Without errorNote's cut this composed 432 characters, past the 159 the derivation
   * above statement.ts's CELL_QUOTE_MAX declares - and a row reason that long evicts
   * noRowsParsed's notice about a different part of the file whole.
   */
  it('an error text the seven literals do not cover is cut, not carried', async () => {
    const forged = `#${'A'.repeat(400)}!`;
    const book = await xlsx((wb) => {
      const ws = wb.addWorksheet('Forged');
      ws.addRow(['date', 'amount', 'description']);
      ws.addRow([utc('2026-05-01'), -10, 'fine']);
      const broken = ws.addRow([utc('2026-05-02'), null, 'forged error']);
      broken.getCell(2).value = { error: forged } as ExcelJS.CellErrorValue;
    });

    const r = await importFile('Forged Error Bank', book);
    expect([r.total, r.inserted, r.skipped]).toEqual([2, 1, 1]);
    // 22 A's: the cut spelled out independently of ERROR_TEXT_MAX, mark included
    expect(r.problems[0]).toBe(`row 3: the amount cell contains #${'A'.repeat(22)}${MARK}`);
    expect(r.problems[0].length).toBeLessThanOrEqual(159);
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

  /**
   * Row 56's I3, on the path that runs the column resolver most: readXlsx calls it once
   * per candidate row, and this file makes most of those calls rejections. None of them
   * builds a descriptor - genericMapping answers null for "Kontoauszug 2026" and for
   * "Datum | irgendwas", so resolveColumns returns ok: false above the site that builds
   * one. What this case pins is the outcome: the header the scan settled on is the
   * header the summary names.
   *
   * importStatement and not importFile: the confirming shim reads named fields and drops
   * the summary, so there would be nothing to assert.
   */
  it('the summary names the header the scan settled on, not the near-header above it', async () => {
    const book = await xlsx((wb) => {
      const ws = wb.addWorksheet('Kontoauszug');
      ws.addRow(['Kontoauszug 2026']);
      ws.addRow(['Datum', 'irgendwas']);
      ws.addRow([
        'Buchungstag',
        'Betrag',
        'Beguenstigter/Zahlungspflichtiger',
        'Verwendungszweck',
        'Waehrung',
      ]);
      ws.addRow([utc('2026-04-01'), -12.5, 'Baecker Mueller', 'Broetchen', 'EUR']);
      ws.addRow([utc('2026-04-05'), -30, 'Stadtwerke', 'Strom', 'EUR']);
    });

    const staged = await importStatement({
      accountId: await accountFor('Near Header Bank'),
      bytes: book,
    });
    if (staged.outcome !== 'awaiting_confirmation') throw new Error('the workbook was refused');
    expect(staged.summary.readAs).toEqual({
      kind: 'auto-detected',
      columns: { date: 'Buchungstag', amount: 'Betrag', description: ['Verwendungszweck'] },
    });
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
    // Cover was looked at and had no header, so it is announced like any other sheet
    // the import left behind; Notes is hidden, and a hidden sheet is never named
    expect(r.problems).toEqual([
      'these rows come from "Transactions" - "Cover" was not imported - save it as a separate file to import it',
    ]);
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
    const failed = (await listImports()).imports.filter((i) =>
      /could not find a header row/.test(i.errorDetail ?? ''),
    );
    expect(failed).toHaveLength(1);
    // the import records which parser ran and at which version, not just that one did
    expect(failed[0]).toMatchObject({
      status: 'failed',
      sourceType: 'xlsx',
      parserVersion: 3,
      transactions: 0,
    });
    expect(await listTransactions({ accountId: await accountFor('Odd Columns Bank') })).toEqual([]);

    // a failed import does not claim the file - only a committed one does
    const retried = await importAndConfirm({
      accountId: await accountFor('Odd Columns Bank'),
      bytes: book,
      mapping: { date: 'when', amount: 'how much', description: 'what' },
    });
    expect(retried.duplicate).toBeUndefined();
    expect(retried.inserted).toBe(1);
  });

  /**
   * Every sheet hidden means no sheet was ever eligible to have columns, so the
   * usual refusal blames a header row that was never read - and lists the sheets it
   * looked at, of which there are none. A refusal has to name its own cause.
   */
  it('a workbook with no visible sheet is refused as that, not as a column problem', async () => {
    const book = await xlsx((wb) => {
      const notes = wb.addWorksheet('Notes', { state: 'hidden' });
      notes.addRow(['date', 'amount', 'description']);
      notes.addRow([utc('2026-01-02'), -9, 'never read']);
      const secret = wb.addWorksheet('Statement', { state: 'veryHidden' });
      secret.addRow(['date', 'amount', 'description']);
      secret.addRow([utc('2026-01-03'), -8, 'also never read']);
    });

    const thrown = await rejectionOf(importFile('All Hidden Bank', book));
    expect(thrown.message).toBe(
      'this workbook has no visible sheet - unhide the sheet holding the statement, or export the statement again',
    );
    expect(thrown.message).not.toMatch(/looked at|the columns must include/);

    // the loader had to open the file to find this out, so it does leave a failed row
    const failed = (await listImports()).imports.filter((i) =>
      /no visible sheet/.test(i.errorDetail ?? ''),
    );
    expect(failed).toHaveLength(1);
    expect(failed[0].errorDetail).toBe(thrown.message);
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
        accountId: await accountFor('Wrong Preset Bank'),
        preset: 'sparkasse',
        bytes: book,
      }),
    ).rejects.toThrow(/no column matched for date \(tried "Buchungstag"\)/);
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
    // by the ids this file adds, not by the sentence: the empty-workbook case below
    // is answered with the same string on purpose, and the truncation is per file
    const before = (await listImports()).imports.map((i) => i.id);
    await expect(importFile('Ods Bank', notAWorkbook)).rejects.toThrow(
      /zip archive but not an Excel workbook/,
    );
    const added = (await listImports()).imports.filter((i) => !before.includes(i.id));
    expect(added).toHaveLength(1);
    expect(added[0].errorDetail).toMatch(/zip archive/);
  });

  /**
   * The other half of that file: a real .zip holding something that is not a
   * workbook loads clean, and leaves no worksheets behind. It used to fall through
   * to the refusal for a workbook whose sheets are all hidden - telling the user to
   * unhide a sheet in a file that has none. One question, one answer.
   */
  it('a workbook with no worksheets is refused as a zip, not as sheets to unhide', async () => {
    const book = await xlsx(() => {});
    const before = (await listImports()).imports.map((i) => i.id);

    const thrown = await rejectionOf(importFile('Empty Workbook Bank', book));
    expect(thrown.message).toBe(
      'this is a zip archive but not an Excel workbook (.xlsx) - .ods and .numbers are not supported; export the statement as .xlsx or CSV',
    );
    expect(thrown.message).not.toMatch(/unhide|looked at/);

    const added = (await listImports()).imports.filter((i) => !before.includes(i.id));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ status: 'failed', errorDetail: thrown.message });
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
   * Why one name resolves to one id whatever parser ran, and the rows keep one
   * provider: the same bank exported as CSV one month and as XLSX the next has to
   * land in ONE account. Two accounts would mean two dedup namespaces - the unique
   * index is (workspace, account, dedup_key) - and every overlapping row would
   * insert a second time, silently duplicating real history. The ids are compared
   * to each other rather than to a literal: what matters is that they agree, and an
   * id nothing derives has no literal to be written down as.
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
    const accountId = await accountFor('Huge Bank');
    const attempt = () => importStatement({ accountId, bytes });

    await expect(attempt()).rejects.toThrow(/50001 data rows/);
    expect(await listTransactions({ accountId })).toHaveLength(0);
    // no committed import claims the hash, so the same bytes are parsed again
    await expect(attempt()).rejects.toThrow(/50001 data rows/);

    const refused = (await listImports()).imports.filter((i) => /data rows/.test(i.errorDetail ?? ''));
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
    expect(await listTransactions({ accountId: r.accountId })).toHaveLength(3);
    // the counts above are what pins it: the notice is a fact about the file, not a row
    expect(r.problems).toEqual([
      'sheet "Cover" (600000 rows) was too large to read and was skipped - these rows come from "Statement"',
    ]);
  });

  /**
   * The reason it is said on the success path and not only in the refusal: a
   * Januar/Februar workbook whose January sheet is formatted past the cap imports
   * February and answers 200. Without the notice the user reads a success card and
   * believes January is loaded.
   */
  it('a skipped sheet is announced even when another sheet imports', async () => {
    const book = await xlsx((wb) => {
      const januar = wb.addWorksheet('Januar');
      januar.addRow(['date', 'amount', 'description']);
      januar.addRow([utc('2026-01-05'), -10, 'never read']);
      januar.getRow(600_000).height = 20;
      const februar = wb.addWorksheet('Februar');
      februar.addRow(['date', 'amount', 'description']);
      februar.addRow([utc('2026-02-05'), -20, 'februar one']);
      februar.addRow([utc('2026-02-06'), -21, 'februar two']);
    });

    const r = await importFile('Two Months Bank', book);
    expect([r.total, r.inserted, r.skipped]).toEqual([2, 2, 0]);
    expect(r.problems).toEqual([
      'sheet "Januar" (600000 rows) was too large to read and was skipped - these rows come from "Februar"',
    ]);
    expect((await rowsOf(r.accountId)).map((row) => row[2])).toEqual([
      'februar one',
      'februar two',
    ]);
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
    const accountId = await accountFor('Oversized Bank');
    const attempt = () => importFile('Oversized Bank', book);

    await expect(attempt()).rejects.toThrow(/skipped as too large to read: Huge \(600000 rows\)/);
    expect(await listTransactions({ accountId })).toEqual([]);
    // no committed import claims the hash, so the same bytes are read again
    await expect(attempt()).rejects.toThrow(/skipped as too large to read/);

    const refused = (await listImports()).imports.filter((i) =>
      /too large to read/.test(i.errorDetail ?? ''),
    );
    expect(refused).toHaveLength(2);
    expect(refused.every((i) => i.status === 'failed' && i.transactions === 0)).toBe(true);
  });

  /**
   * Both clauses at once is where the message used to overrun what error_detail
   * stores, and it lost its tail in the most informative case. The clause that says
   * a sheet was never read comes first and survives whole; the one that refines a
   * sentence already true is what gets shortened.
   */
  it('a refusal carrying both clauses fits what the import stores', async () => {
    const header = Array.from({ length: 12 }, (_, i) => `Spalte-sehr-ausfuehrlich-${i}`);
    const book = await xlsx((wb) => {
      const huge = wb.addWorksheet('Huge');
      huge.getRow(600_000).height = 20;
      const ws = wb.addWorksheet('Statement');
      ws.addRow(header);
      ws.addRow(header.map(() => 'x'));
    });

    const thrown = await rejectionOf(importFile('Both Clauses Bank', book));
    expect(thrown.message.length).toBeLessThanOrEqual(ERROR_DETAIL_MAX);
    expect(thrown.message).toContain(' - skipped as too large to read: Huge (600000 rows)');
    expect(thrown.message).toMatch(
      new RegExp(` - the closest row \\(sheet "Statement", row 1\\) does not match: .*${MARK}$`),
    );
    // and it names only columns the workbook has: the cut falls between two entries,
    // which is what the `...` this used to pin said nothing whatever about
    const listed = thrown.message.slice(thrown.message.lastIndexOf(': ') + 2);
    expect(header).toEqual(expect.arrayContaining(listed.slice(0, -MARK.length).split(', ')));

    // nothing was cut on the way into the database, which is the whole point
    const failed = (await listImports()).imports.filter((i) =>
      /Spalte-sehr-ausfuehrlich-0/.test(i.errorDetail ?? ''),
    );
    expect(failed).toHaveLength(1);
    expect(failed[0].errorDetail).toBe(thrown.message);
  });

  /**
   * The budget is spent in order, so the list that spends first has to leave the one
   * behind it room for its own last resort - which is a count, and a count is still
   * characters. Nine oversized sheets is where the too-large list ate all but two of
   * them and the base list emitted its count anyway, five characters past what
   * error_detail keeps.
   */
  it('a workbook of nothing but oversized sheets still fits what the import stores', async () => {
    const book = await xlsx((wb) => {
      for (let i = 1; i <= 9; i++) {
        wb.addWorksheet(`Kontoauszug 0${i}-2026`).getRow(600_000).height = 20;
      }
    });

    const thrown = await rejectionOf(importFile('Nine Sheets Bank', book));
    expect(thrown.message.length).toBeLessThanOrEqual(ERROR_DETAIL_MAX);
    expect(thrown.message).toContain(
      ' - skipped as too large to read: Kontoauszug 01-2026 (600000 rows)',
    );

    const failed = (await listImports()).imports.filter((i) =>
      /Kontoauszug 01-2026/.test(i.errorDetail ?? ''),
    );
    expect(failed).toHaveLength(1);
    expect(failed[0].errorDetail).toBe(thrown.message);
  });

  /**
   * When nothing parsed the user reads one sentence - the client cuts at 200
   * characters - and it has to be the one they can act on. A workbook whose amounts
   * are formulas with no stored result says so; that a sheet was skipped follows.
   */
  it('nothing parsed: the row reason comes first and the notice follows it', async () => {
    const book = await xlsx((wb) => {
      const januar = wb.addWorksheet('Januar');
      januar.getRow(600_000).height = 20;
      const februar = wb.addWorksheet('Februar');
      februar.addRow(['date', 'amount', 'description']);
      for (const day of ['2026-02-05', '2026-02-06']) {
        const row = februar.addRow([utc(day), null, 'uncached amount']);
        row.getCell(2).value = { formula: 'D1*2' } as ExcelJS.CellFormulaValue;
      }
    });

    const thrown = await rejectionOf(importFile('No Rows Bank', book));
    expect(thrown.message).toBe(
      'no row could be parsed (2 skipped): row 2: the amount cell is a formula with no stored result - open the file in Excel, re-save it, and upload again' +
        ' - sheet "Januar" (600000 rows) was too large to read and was skipped - these rows come from "Februar"',
    );
  });

  /**
   * The other arm: a notice that no longer fits behind the row's reason. It is dropped
   * whole rather than cut - and the fact it carried is not lost with it, because the
   * log runs at the parser and not on the successful path. On a refusal `problems` is
   * never sent and the `imports` row stores only the message.
   *
   * It used to be built on a 400-character date cell, and it cannot be any more: every
   * cell describeRow quotes is bounded now, so noRowsParsed's head is at most 199 and a
   * NOTICE_MAX-bounded notice with its join at most 293 - 492 of the 500, which is
   * exactly what that derivation is for. The one clause left that can still overrun is
   * the too-large list, which sheetNotice leaves unbounded and which xlsx.ts names as
   * the one that wins. Twelve oversized sheets put that list alone past error_detail
   * whatever the head is, so the drop is
   * forced by the clause and not by the length of the row's reason - a wording change
   * upstream cannot quietly stop exercising this arm.
   */
  it('nothing parsed and no room for the notice: it is dropped, and logged instead', async () => {
    const book = await xlsx((wb) => {
      for (let i = 1; i <= 12; i++) {
        const name = `Kontoauszug ${String(i).padStart(2, '0')}-2026`;
        wb.addWorksheet(name).getRow(600_000).height = 20;
      }
      const februar = wb.addWorksheet('Februar');
      februar.addRow(['date', 'amount', 'description']);
      februar.addRow(['Widerspruch', 'xx', 'the only row']);
    });

    const warn = vi.spyOn(logImport, 'warn').mockImplementation(() => {});
    const thrown = await rejectionOf(importFile('Dropped Notice Bank', book));
    // read before restoring: mockRestore clears the calls with the implementation
    const logged = warn.mock.calls.map((args) => String(args[0]));
    warn.mockRestore();

    // the head alone, to the character: dropped whole is the rule, and a cut notice
    // would satisfy a toContain on the reason just as well
    expect(thrown.message).toBe(
      'no row could be parsed (1 skipped): row 2: could not parse the date "Widerspruch" or the amount "xx"',
    );
    expect(thrown.message.length).toBeLessThanOrEqual(ERROR_DETAIL_MAX);

    const failed = (await listImports()).imports.filter((i) =>
      /Widerspruch/.test(i.errorDetail ?? ''),
    );
    expect(failed).toHaveLength(1);
    expect(failed[0].errorDetail).toBe(thrown.message);

    // and the notice really was composed, all twelve of it, so the assertion above
    // cannot be passing because there was nothing to drop
    expect(logged).toContainEqual(
      expect.stringContaining('"Kontoauszug 01-2026" (600000 rows)'),
    );
    expect(logged).toContainEqual(
      expect.stringContaining('"Kontoauszug 12-2026" (600000 rows)'),
    );
  });

  /**
   * A notice and row problems both up against the cap - the combination no case
   * covered. The notice keeps the head of the array, where the client's window is,
   * and costs the rows one slot rather than pushing the total to six.
   */
  it('a notice and row problems share one cap, the notice first', async () => {
    const book = await xlsx((wb) => {
      wb.addWorksheet('Januar').getRow(600_000).height = 20;
      const februar = wb.addWorksheet('Februar');
      februar.addRow(['date', 'amount', 'description']);
      februar.addRow([utc('2026-02-01'), -10, 'the one that parses']);
      for (let i = 1; i <= 6; i++) februar.addRow(['not a date', 'not a number', `bad ${i}`]);
    });

    const r = await importFile('Capped Problems Bank', book);
    expect([r.total, r.inserted, r.skipped]).toEqual([7, 1, 6]);
    expect(r.problems).toHaveLength(5);
    expect(r.problems[0]).toBe(
      'sheet "Januar" (600000 rows) was too large to read and was skipped - these rows come from "Februar"',
    );
    expect(r.problems.slice(1)).toEqual(
      [3, 4, 5, 6].map(
        (row) => `row ${row}: could not parse the date "not a date" or the amount "not a number"`,
      ),
    );
  });
});

/**
 * One sheet is imported and the rest are not (ROADMAP 5.3). The import is a success
 * either way, so the only thing standing between the user and a half-loaded history
 * is the sentence the summary carries - and it must not be the one that sends them
 * back to the upload button, because those bytes are claimed once this is confirmed.
 */
describe('xlsx: the sheets that were not used', () => {
  it('a two-month workbook imports January and says February was not', async () => {
    const book = await xlsx((wb) => {
      const januar = wb.addWorksheet('Januar');
      januar.addRow(['date', 'amount', 'description']);
      januar.addRow([utc('2026-01-05'), -10, 'januar one']);
      const februar = wb.addWorksheet('Februar');
      februar.addRow(['date', 'amount', 'description']);
      februar.addRow([utc('2026-02-05'), -20, 'februar one']);
    });

    const r = await importFile('Two Sheets Bank', book);
    expect([r.total, r.inserted, r.skipped]).toEqual([1, 1, 0]);
    expect((await rowsOf(r.accountId)).map((row) => row[2])).toEqual(['januar one']);
    expect(r.problems).toEqual([
      'these rows come from "Januar" - "Februar" was not imported - save it as a separate file to import it',
    ]);
  });

  /**
   * The list is metadata only - the loop never opens a sheet it did not import. A
   * header peek would name the sheets whose columns resolve and silence the ones
   * whose do not, which is exactly backwards: a February sheet the mapper cannot
   * read is missing from the import AND from the notice.
   */
  it('a second sheet the mapper could not have read is named all the same', async () => {
    const book = await xlsx((wb) => {
      const januar = wb.addWorksheet('Januar');
      januar.addRow(['date', 'amount', 'description']);
      januar.addRow([utc('2026-01-06'), -11, 'januar one']);
      const februar = wb.addWorksheet('Februar');
      februar.addRow(['when', 'how much', 'what']);
      februar.addRow([utc('2026-02-06'), -21, 'februar one']);
    });

    const r = await importFile('Odd Second Sheet Bank', book);
    expect(r.problems).toEqual([
      'these rows come from "Januar" - "Februar" was not imported - save it as a separate file to import it',
    ]);
  });

  /**
   * A sheet positioned after the statement is never visited, so it is named as not
   * imported and never as too large: "too large" is a disposition the loop reached,
   * and claiming it here would assert a cause that never happened. It is also the
   * case a shared visible-and-small predicate would drop from both lists at once,
   * leaving the workbook to import in silence.
   */
  it('a sheet behind the statement is named as unused even when it is oversized', async () => {
    const book = await xlsx((wb) => {
      const januar = wb.addWorksheet('Januar');
      januar.addRow(['date', 'amount', 'description']);
      januar.addRow([utc('2026-01-07'), -12, 'januar one']);
      const februar = wb.addWorksheet('Februar');
      februar.addRow(['date', 'amount', 'description']);
      februar.addRow([utc('2026-02-07'), -22, 'februar one']);
      februar.getRow(600_000).height = 20;
    });

    const r = await importFile('Oversized Second Sheet Bank', book);
    expect(r.problems).toEqual([
      'these rows come from "Januar" - "Februar" was not imported - save it as a separate file to import it',
    ]);
    expect(r.problems[0]).not.toContain('too large');
  });

  /** A blank Tabelle3 is in half the workbooks people export: a notice about it is noise. */
  it('a trailing sheet with no rows is not announced', async () => {
    const book = await xlsx((wb) => {
      const januar = wb.addWorksheet('Januar');
      januar.addRow(['date', 'amount', 'description']);
      januar.addRow([utc('2026-01-08'), -13, 'januar one']);
      wb.addWorksheet('Tabelle3');
    });

    // the premise: the empty sheet survives the round trip, so this is the exclusion
    // being exercised rather than a sheet exceljs dropped on the way out
    const reloaded = await new ExcelJS.Workbook().xlsx.load(book as unknown as ArrayBuffer);
    expect(reloaded.worksheets.map((w) => [w.name, w.state, w.rowCount])).toEqual([
      ['Januar', 'visible', 2],
      ['Tabelle3', 'visible', 0],
    ]);

    const r = await importFile('Empty Trailing Sheet Bank', book);
    expect([r.total, r.inserted, r.skipped]).toEqual([1, 1, 0]);
    expect(r.problems).toEqual([]);
  });

  /**
   * Both causes at once, in one entry. Two entries would cost a row-level problem a
   * slot in the window the client renders (three of five), and the row-level half is
   * the actionable one.
   */
  it('a sheet skipped for size and one simply unused compose into one sentence', async () => {
    const book = await xlsx((wb) => {
      wb.addWorksheet('Cover').getRow(600_000).height = 20;
      const januar = wb.addWorksheet('Januar');
      januar.addRow(['date', 'amount', 'description']);
      januar.addRow([utc('2026-01-09'), -14, 'januar one']);
      const februar = wb.addWorksheet('Februar');
      februar.addRow(['date', 'amount', 'description']);
      februar.addRow([utc('2026-02-09'), -24, 'februar one']);
    });

    const r = await importFile('Both Causes Bank', book);
    expect([r.total, r.inserted, r.skipped]).toEqual([1, 1, 0]);
    expect(r.problems).toEqual([
      'sheet "Cover" (600000 rows) was too large to read and was skipped - these rows come from "Januar" - "Februar" was not imported - save it as a separate file to import it',
    ]);
    // the sheet skipped for size is named by its own clause and never again by the
    // other one, and the sheet the rows came from is named once
    expect(r.problems[0].match(/Cover/g)).toHaveLength(1);
    expect(r.problems[0].match(/Januar/g)).toHaveLength(1);
  });

  /**
   * A workbook with a sheet per month would otherwise compose a notice long enough
   * that noRowsParsed drops it - so the fact would exist on the success path and
   * never on the failure path, which is the corner that costs the most.
   */
  it('a workbook of many sheets names what it can and counts the rest', async () => {
    const spare = (wb: ExcelJS.Workbook): void => {
      for (let i = 1; i <= 20; i++) {
        wb.addWorksheet(`Tabelle${String(i).padStart(2, '0')}`).addRow(['Notiz']);
      }
    };
    const book = await xlsx((wb) => {
      const januar = wb.addWorksheet('Januar');
      januar.addRow(['date', 'amount', 'description']);
      januar.addRow([utc('2026-01-10'), -15, 'januar one']);
      spare(wb);
    });

    const r = await importFile('Many Sheets Bank', book);
    expect(r.inserted).toBe(1);
    // the exact list, so that the bound is observable at its value: ten names and a
    // count of the rest is what UNUSED_LIST_MAX buys, and a ceiling asserted with
    // slack is a ceiling the suite watches nobody cross
    expect(r.problems).toEqual([
      'these rows come from "Januar" - "Tabelle01", "Tabelle02", "Tabelle03", "Tabelle04", "Tabelle05", "Tabelle06", "Tabelle07", "Tabelle08", "Tabelle09", "Tabelle10" and 10 more were not imported - save them as separate files to import them',
    ]);
    // the notice's own ceiling, restated rather than imported: when the constant
    // moves this is where a human should be made to look at the arithmetic again
    expect(r.problems[0].length).toBeLessThanOrEqual(290);

    // and the same notice still fits behind a row reason on the path where nothing
    // parsed, which is where it is dropped whole rather than shortened
    const unreadable = await xlsx((wb) => {
      const januar = wb.addWorksheet('Januar');
      januar.addRow(['date', 'amount', 'description']);
      januar.addRow(['not a date', 'not a number', 'the only row']);
      spare(wb);
    });

    const before = (await listImports()).imports.map((i) => i.id);
    const thrown = await rejectionOf(importFile('Many Sheets Nothing Parsed Bank', unreadable));
    expect(thrown.message.length).toBeLessThanOrEqual(ERROR_DETAIL_MAX);
    expect(thrown.message).toContain('more were not imported');
    const failed = (await listImports()).imports.filter((i) => !before.includes(i.id));
    expect(failed).toHaveLength(1);
    expect(failed[0].errorDetail).toBe(thrown.message);
  });

  /**
   * The too-large list is unbounded and predates this clause, so it alone can spend
   * the whole budget. What is appended is included whole or not at all: half of
   * `"Februar", "Ma` names a sheet the workbook has not got, which is worse than
   * saying nothing. The clause that yields is the new one.
   */
  it('the unused clause is dropped whole when the skipped list leaves it no room', async () => {
    const skipped = Array.from({ length: 5 }, (_, i) => `Kontoauszug 0${i + 1}-2026`);
    const book = await xlsx((wb) => {
      for (const name of skipped) wb.addWorksheet(name).getRow(600_000).height = 20;
      const ws = wb.addWorksheet('Statement');
      ws.addRow(['date', 'amount', 'description']);
      ws.addRow([utc('2026-01-11'), -16, 'the statement']);
      const februar = wb.addWorksheet('Februar');
      februar.addRow(['date', 'amount', 'description']);
      februar.addRow([utc('2026-02-11'), -26, 'februar one']);
    });

    const r = await importFile('No Room Bank', book);
    expect(r.inserted).toBe(1);
    expect(r.problems).toEqual([
      `sheets ${skipped.map((n) => `"${n}" (600000 rows)`).join(', ')} were too large to read and were skipped - these rows come from "Statement"`,
    ]);
    // dropped, not cut: no fragment of a sheet name survives anywhere in it
    expect(r.problems[0]).not.toContain('not imported');
    expect(r.problems[0]).not.toContain('Februar');
  });

  /**
   * Where NOTICE_MAX is set from, and the only place the suite can see it move. On
   * the nothing-parsed path the notice is weighed against error_detail behind the
   * row's own reason, and it is appended whole or not at all - so a notice a single
   * character too long does not lose its own clause, it loses the too-large one as
   * well, which reached the user before this task existed. Two summary sheets
   * formatted to the bottom, a sheet per month, and a reference number in the date
   * column is where both halves are longest at once.
   */
  it('the skipped clause still reaches error_detail behind the longest row reason', async () => {
    const months = 'Jan Feb Mar Apr Mai Jun Jul Aug Sep Okt Nov Dez'.split(' ');
    const book = await xlsx((wb) => {
      for (const name of ['Jahresuebersicht', 'Kategorien 2026']) {
        wb.addWorksheet(name).getRow(600_000).height = 20;
      }
      for (const month of months) {
        const ws = wb.addWorksheet(`${month} 2026`);
        ws.addRow(['date', 'amount', 'description']);
        // a reference number where the date should be: the mis-picked column this
        // message exists for, and the longest reason the parser composes
        ws.addRow([1234567890123456, -10, 'Verwendungszweck']);
      }
    });

    const before = (await listImports()).imports.map((i) => i.id);
    const thrown = await rejectionOf(importFile('Jahresdatei Bank', book));

    // the whole of it, both clauses: the row's reason first because it is the half
    // the user can act on, and the two skipped sheets still named behind it
    expect(thrown.message).toBe(
      'no row could be parsed (1 skipped): row 2: the date cell holds the number 1234567890123456, which this parser will not read as a date - format that column as a date and upload again' +
        ' - sheets "Jahresuebersicht" (600000 rows), "Kategorien 2026" (600000 rows) were too large to read and were skipped - these rows come from "Jan 2026" - "Feb 2026", "Mar 2026", "Apr 2026", "Mai 2026", "Jun 2026" and 6 more were not imported - save them as separate files to import them',
    );
    expect(thrown.message.length).toBeLessThanOrEqual(ERROR_DETAIL_MAX);

    const failed = (await listImports()).imports.filter((i) => !before.includes(i.id));
    expect(failed).toHaveLength(1);
    expect(failed[0].errorDetail).toBe(thrown.message);
  });
});

/**
 * The size cap is decidable from the bytes, so it is refused before an `imports`
 * row exists at all: nothing was parsed and nothing could have been written, and
 * `failed` means "an import did not complete", not "the user picked the wrong
 * file". The PDF byte cap is the same band, and the PDF PAGE cap deliberately is
 * not - see the band comment in statement.ts.
 */
describe('the workbook size cap', () => {
  it('a workbook past the cap is refused before an import row exists', async () => {
    const oversized = Buffer.alloc(11 * 1024 * 1024);
    Buffer.from([0x50, 0x4b, 0x03, 0x04]).copy(oversized);
    const before = (await listImports()).imports.length;
    const attempt = () => importFile('Fat Workbook Bank', oversized);

    await expect(attempt()).rejects.toThrow(/the workbook is larger than 10 MB/);
    expect((await listImports()).imports).toHaveLength(before);
    // nothing recorded the hash, so this is a second refusal and not a duplicate
    await expect(attempt()).rejects.toThrow(/the workbook is larger than 10 MB/);
    expect((await listImports()).imports).toHaveLength(before);
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

/**
 * Where a refusal is cut (ROADMAP 21). The closest-row clause carries a reason
 * composed for a budget it does not know about, and the cut used to land wherever
 * the 300 characters ran out: inside a quoted accepted name, inside an unquoted
 * header cell, or through the dump noColumnMatched appends whole or not at all.
 * What reached the user then named a column called `S`.
 *
 * Swept over the PREFIX rather than sampled over the reason, because the prefix is
 * the variable: ` - the closest row (sheet "…", row …) does not match: ` is 52
 * characters of fixed prose plus the user's sheet name plus up to six digits of row
 * label, and every one of those pushes the cut one character further in. Row 20's
 * holder in csv.test.ts - "no preset composes an xlsx refusal that is cut through a
 * column name" - asserts an even quote count over both headers and every preset and
 * was green while all of this was live, because its workbook is named `Statement`
 * with the header at row 1 and so pins the one input the invariant is about. It
 * stays exactly as written; this is its generalisation, not its successor.
 */
describe('a refusal is cut at a boundary or not at all', () => {
  /** Excel's own ceiling for a worksheet name: the widest prefix a sheet can buy. */
  const SHEET_NAME_MAX = 31;
  const LONG_SHEET = 'Kontoauszug-2026-Januar-Umsatze';
  /** 1 digit, 2 digits, 6 - the label reaches the message as its digits and nothing else. */
  const ROW_LABELS = [1, 12, 100_000];
  const REASON = ' does not match: ';
  const HEADERS = [
    ['date', 'amount', 'description'],
    ['nothing', 'matches', 'here'],
  ];
  /** Every preset, and the arm a user reaches without having chosen anything. */
  const ARMS = [...Object.keys(CSV_PRESETS), null];
  /** The one pair that is not a refusal at all: the generic mapper reads this header. */
  const reads = (key: string | null, header: string[]): boolean =>
    key === null && header[0] === 'date';

  const named = (key: string) => ({ key, ...CSV_PRESETS[key] });

  /**
   * One visible sheet named to `length`, carrying a candidate header row at `label`
   * and nothing else. Header-only deliberately: a data row under a header at
   * MAX_SHEET_ROWS puts rowCount one past the cap, the sheet is skipped as too large
   * and no closest-row clause is composed at all.
   */
  const candidateSheet = async (length: number, label: number, header: string[]): Promise<Buffer> =>
    xlsx((wb) => {
      const row = wb.addWorksheet(LONG_SHEET.slice(0, length)).getRow(label);
      header.forEach((cell, i) => {
        row.getCell(i + 1).value = cell;
      });
    });

  /**
   * What the parser composes for these bytes, or null when it finds a header row.
   * Through readSheet rather than importStatement: only a delivered message says
   * where it was cut, this path never reads the destination, and the sweep below is
   * then a parse each rather than a database round trip each.
   */
  async function refusalFor(
    bytes: Buffer,
    key: string | null,
    mapping?: Partial<CsvMapping>,
  ): Promise<string | null> {
    try {
      const preset = key === null ? null : named(key);
      await readSheet({ accountId: 'unread on this path', bytes, mapping }, 'xlsx', preset);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }

  /**
   * The reason itself, whole. The same function composes it from the same header and
   * the same preset on the CSV path, where it is thrown as it stands instead of being
   * carried inside a clause with a budget - which is the asymmetry this row closes,
   * and which makes that path the oracle every cut below is checked against.
   */
  async function wholeReason(key: string | null, header: string[]): Promise<string> {
    const delimiter = key === null ? ',' : (CSV_PRESETS[key].mapping.delimiter ?? ',');
    const rows = [header.join(delimiter), header.map(() => 'x').join(delimiter)];
    const thrown = await rejectionOf(
      importStatement({
        accountId: await accountFor(`Reason ${key ?? 'generic'} ${header[0]}`),
        preset: key ?? undefined,
        bytes: Buffer.from(rows.join('\n'), 'utf8'),
      }),
    );
    return thrown.message;
  }

  /**
   * The names a preset would try, spelled as noColumnMatched quotes them. Fee and
   * balance are resolved without ever being reported, so no refusal names them.
   */
  function acceptedNames(key: string | null): string[] {
    if (key === null) return [];
    const m = CSV_PRESETS[key].mapping;
    return [
      ...m.date,
      ...m.amount,
      ...m.description.flat(),
      ...(m.currency ?? []),
      ...(m.onlyWhen?.column ?? []),
    ];
  }

  /**
   * The unquoted comma lists a refusal carries, found by the prose introducing each:
   * the generic arm's header and the dump. The slot list beside them is prose and
   * not names - `amount (tried "Betrag"` states something true about a column that
   * exists, and the paren it leaves dangling fabricates nothing.
   */
  function headerList(message: string): string[] {
    const lists: [string, string | null][] = [
      ['columns in the header: ', ' - set a mapping or pick a preset'],
      ['; the header reads: ', null],
    ];
    const entries: string[] = [];
    for (const [lead, tail] of lists) {
      const at = message.indexOf(lead);
      if (at < 0) continue;
      const listed = message.slice(at + lead.length);
      const end = tail === null ? -1 : listed.indexOf(tail);
      const text = end < 0 ? listed : listed.slice(0, end);
      entries.push(...text.replace(new RegExp(`${MARK}$`), '').split(', '));
    }
    return entries;
  }

  /**
   * Everything the message names, against everything the workbook has. Both halves
   * are owed and neither holds it alone: a quoted run cut short is still a real
   * accepted name, so membership waves `status (tried "State` through, and the
   * generic arm's list carries no quotes at all for the parity to see.
   */
  function misnamed(message: string, allowed: Set<string>): string[] {
    const found: string[] = [];
    const parts = message.split('"');
    if (parts.length % 2 === 0) found.push('a quoted run that never closed');
    for (let i = 1; i < parts.length; i += 2) {
      if (!allowed.has(parts[i])) found.push(`quoted "${parts[i]}"`);
    }
    for (const entry of headerList(message)) {
      if (!allowed.has(entry)) found.push(`listed "${entry}"`);
    }
    return found;
  }

  /**
   * The whole reason, or a prefix of it stopping exactly where a separator did, with
   * the mark. Nothing else: a cut anywhere else delivers half of whatever it landed
   * in, and a clause carrying no whole unit at all is a fragment however long it is.
   */
  function cutAtBoundary(delivered: string, whole: string): boolean {
    if (delivered === whole) return true;
    if (!delivered.endsWith(MARK)) return false;
    const kept = delivered.slice(0, -MARK.length);
    return whole.startsWith(kept) && /^[,;] /.test(whole.slice(kept.length));
  }

  const clauseOf = (message: string): string =>
    message.slice(message.indexOf(REASON) + REASON.length);

  it('no sheet name and no row label cuts a refusal through a name', async () => {
    expect(LONG_SHEET).toHaveLength(SHEET_NAME_MAX);
    const oracle = new Map<string, string>();
    for (const header of HEADERS) {
      for (const key of ARMS) {
        if (reads(key, header)) continue;
        oracle.set(`${key} ${header[0]}`, await wholeReason(key, header));
      }
    }

    const bad: string[] = [];
    let cut = 0;
    let entire = 0;
    let notRefused = 0;
    for (let length = 1; length <= SHEET_NAME_MAX; length++) {
      const sheet = LONG_SHEET.slice(0, length);
      for (const label of ROW_LABELS) {
        for (const header of HEADERS) {
          const bytes = await candidateSheet(length, label, header);
          for (const key of ARMS) {
            const message = await refusalFor(bytes, key);
            const where = `${key ?? 'generic'} sheet=${length} row=${label} ${header[0]}`;
            if (reads(key, header)) {
              expect(message, where).toBeNull();
              notRefused++;
              continue;
            }
            // trap 3: the clause is there at all, before anything is said about its
            // shape, or every assertion under this one passes by vacancy
            if (message === null || !message.includes(REASON)) {
              bad.push(`${where}: no closest-row clause`);
              continue;
            }
            expect(message.length, where).toBeLessThanOrEqual(ERROR_DETAIL_MAX);
            expect(message, where).toContain(`(looked at: ${sheet})`);
            const allowed = new Set([...header, ...acceptedNames(key), sheet]);
            for (const m of misnamed(message, allowed)) bad.push(`${where}: ${m}`);
            const delivered = clauseOf(message);
            const whole = oracle.get(`${key} ${header[0]}`) ?? '';
            if (!cutAtBoundary(delivered, whole)) bad.push(`${where}: ...${delivered.slice(-48)}`);
            if (delivered === whole) entire++;
            else cut++;
          }
        }
      }
    }

    expect(notRefused).toBe(SHEET_NAME_MAX * ROW_LABELS.length);
    // both arms of cutAtBoundary are exercised, so neither is green by never running
    expect(entire).toBeGreaterThan(0);
    expect(cut).toBeGreaterThan(0);
    const report = `${bad.length} findings over ${entire + cut} refusals`;
    expect(bad.length, `${report}:\n${bad.slice(0, 6).join('\n')}`).toBe(0);
  });

  /**
   * A column name the REQUEST spelled, with a separator inside it. resolveColumns is
   * the header scan's predicate as well as the mapper's, so a mapping reaches this
   * clause quoted - and both of the separators the cut looks for are legal inside a
   * name. Nothing else in the sentence puts one there: no accepted name in
   * CSV_PRESETS carries a comma or a semicolon, which is why a cutter that reads
   * neither quote passes every other case in this file.
   */
  it('a separator inside a quoted name is not a place to cut', async () => {
    const header = HEADERS[1];
    const bytes = await candidateSheet(SHEET_NAME_MAX, 12, header);

    for (const separator of [', ', '; ']) {
      const spelling = (slot: string): string =>
        `${slot} der Buchung${separator}wie die Bank es schreibt`;
      const mapping = {
        date: spelling('Datum'),
        amount: spelling('Betrag'),
        description: spelling('Zweck'),
      };

      const message = (await refusalFor(bytes, null, mapping)) ?? '';
      expect(message, separator).toContain(`(tried "${mapping.date}")`);
      const allowed = new Set([...header, ...Object.values(mapping), LONG_SHEET]);
      expect(misnamed(message, allowed), separator).toEqual([]);
    }
  });

  /**
   * The widest row label a sheet can carry, from the constant that bounds it rather
   * than from a literal beside the assertion. Six digits of prefix is what pushed
   * the cut two characters into `"State"` and delivered a column called `S`.
   */
  it(`a row label at MAX_SHEET_ROWS still names only real columns`, async () => {
    const header = HEADERS[1];
    const bytes = await candidateSheet(SHEET_NAME_MAX, MAX_SHEET_ROWS, header);
    const message = await refusalFor(bytes, 'revolut');

    expect(message).toContain(`row ${MAX_SHEET_ROWS})${REASON}`);
    const allowed = new Set([...header, ...acceptedNames('revolut'), LONG_SHEET]);
    expect(misnamed(message ?? '', allowed)).toEqual([]);
    expect(cutAtBoundary(clauseOf(message ?? ''), await wholeReason('revolut', header))).toBe(true);
  });

  /**
   * noColumnMatched appends the header dump whole or not at all, and says so in its
   * own comment; on this path it was appended and then cut by someone else. The seam
   * is the first thing the clause gives up and it gives it up entire.
   */
  it('the header dump is dropped whole rather than cut through', async () => {
    // Two headers, because the rule is not "stop at the last separator that fits".
    // Four long cells is the shape this defect was measured on and it puts the dump's
    // first comma out of the budget's reach; twenty short ones put it inside, which is
    // where a cutter treating the seam as one more entry stops - and delivers a dump
    // that is neither absent nor whole
    const headers = [
      Array.from({ length: 4 }, (_, i) => `Spalte-sehr-ausfuehrlich-${i}`),
      Array.from({ length: 20 }, (_, i) => `Feld${String(i).padStart(2, '0')}`),
    ];

    for (const header of headers) {
      const bytes = await xlsx((wb) => {
        const row = wb.addWorksheet('Statement').getRow(1);
        header.forEach((cell, i) => {
          row.getCell(i + 1).value = cell;
        });
      });

      // the dump WAS composed for this header - the same reason, off the path that
      // carries it whole - so its absence below is a drop and not a coincidence
      expect(await wholeReason('dkb', header)).toContain('; the header reads: ');

      const message = (await refusalFor(bytes, 'dkb')) ?? '';
      expect(message, header[0]).not.toContain('; the header reads');
      expect(message, header[0]).toMatch(
        new RegExp(`- pick a different preset or set a mapping${MARK}$`),
      );
    }
  });

  /**
   * A clause whose own prose no longer fits is dropped, not delivered headless.
   * CLOSEST_CLAUSE_MIN's 60 was measured against one shape of the sentence: the
   * prefix is 52 characters plus the sheet name plus the row label, so 62 at
   * `Statement`/row 1 and 85 at Excel's ceiling and row 12, and between those two the
   * constant guarded nothing at all. Three oversized sheets spend the budget down to
   * where the difference shows.
   *
   * The pair is what keeps the numbers honest: the same workbook, the same oversized
   * sheets, the same candidate row, and a candidate sheet named 4 characters instead
   * of 31.
   */
  it('a clause that cannot carry its reason is absent, not headless', async () => {
    const build = async (candidate: string): Promise<Buffer> =>
      xlsx((wb) => {
        for (let i = 1; i <= 3; i++) {
          wb.addWorksheet(`Kontoauszug-2026-Monat0${i}`).getRow(600_000).height = 20;
        }
        const row = wb.addWorksheet(candidate).getRow(12);
        HEADERS[1].forEach((cell, i) => {
          row.getCell(i + 1).value = cell;
        });
      });

    const roomy = (await refusalFor(await build(LONG_SHEET.slice(0, 4)), 'revolut')) ?? '';
    const tight = (await refusalFor(await build(LONG_SHEET), 'revolut')) ?? '';

    expect(roomy).toContain(`${REASON}no column matched for date (tried "Completed Date"`);
    expect(tight).toContain(' - skipped as too large to read: Kontoauszug-2026-Monat01');
    expect(tight).toContain(`${LONG_SHEET})`);
    expect(tight).not.toContain(REASON);
    expect(tight.length).toBeLessThanOrEqual(ERROR_DETAIL_MAX);
  });
});
