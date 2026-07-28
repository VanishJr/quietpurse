/**
 * XLSX frontend (ROADMAP 5.2): a workbook in, a Sheet of typed cells out. From
 * there the mapping, the row loop and the pipeline are the CSV path's, so a
 * workbook and a CSV of the same statement produce the same transactions.
 *
 * A worksheet cell is not a scalar. Formulas, rich text, hyperlinks and errors all
 * arrive as objects and the seam admits none of them, so they are normalised here
 * - by cell TYPE, never through cell.text, which renders a date with
 * Date.toString(). A formula's cached result is normalised in turn: a computed
 * amount column is common in bank exports and has to stay a number.
 *
 * Where the workbook loses a cell for a reason of its own - a formula the writer
 * cached no result for, an #N/A - the reason travels with the sheet as a note, so
 * the mapper can report that instead of "could not parse the amount". No preset
 * will ever fix a workbook whose amounts were never computed.
 */
import ExcelJS from 'exceljs';
import { Cell, MAX_DATA_ROWS, Sheet, cellText, hasContent } from './sheet';

/**
 * Bumped whenever a change here would parse an existing file differently. Per
 * parser, keyed by imports.source_type - see CSV_PARSER_VERSION.
 */
export const XLSX_PARSER_VERSION = 1;

/** How far down a sheet the header may hide behind a title or an account block. */
const HEADER_SCAN_ROWS = 20;

/**
 * Cheap early-out only, deliberately far above MAX_DATA_ROWS: rowCount counts rows
 * carrying nothing but formatting, and formatting a whole column is something
 * people do. The cap that decides an import is the mapper's, over kept data rows.
 */
const MAX_SHEET_ROWS = 10 * MAX_DATA_ROWS;

/** The reason the closest row was rejected is the user's, but not at any length. */
const CLOSEST_CLAUSE_MAX = 300;

const UNCACHED_FORMULA =
  'is a formula with no stored result - open the file in Excel, re-save it, and upload again';

interface Normalised {
  value: Cell;
  /** set when the cell was blanked for a reason worth telling the user */
  note?: string;
}

interface RawRow {
  sheetRow: number;
  cells: Cell[];
  notes: Map<number, string>;
}

/** The row that came nearest to being the header, kept for the failure message. */
interface Candidate {
  sheet: string;
  sheetRow: number;
  filled: number;
  error: string;
}

/**
 * The workbook's rows, from the header down. isHeader is the mapper's own column
 * resolution: the scan must accept exactly the rows the mapper can read, or it
 * settles on a row above the real header and every data row is read against the
 * wrong columns - a partial import that answers 200. Acceptance is ok alone; the
 * reason travels with it only so that a file which matches nothing can say why.
 */
export async function readXlsx(
  bytes: Buffer,
  isHeader: (header: string[]) => { ok: boolean; error?: string },
): Promise<Sheet> {
  const workbook = new ExcelJS.Workbook();
  try {
    // the cast is exceljs's typings, which declare their own ArrayBuffer-shaped
    // Buffer; the loader reads a Node Buffer
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  } catch {
    throw new Error(
      'this is a zip archive but not an Excel workbook (.xlsx) - .ods and .numbers are not supported; export the statement as .xlsx or CSV',
    );
  }
  const date1904 = workbook.properties?.date1904 === true;

  const tried: string[] = [];
  const tooLarge: string[] = [];
  let closest: Candidate | null = null;

  for (const worksheet of workbook.worksheets) {
    // a hidden sheet is hidden for a reason: never the statement
    if (worksheet.state === 'hidden' || worksheet.state === 'veryHidden') continue;
    tried.push(worksheet.name);
    // an implausible sheet is disqualified the way a hidden one is, not the
    // workbook with it: a cover sheet formatted to the bottom must not refuse the
    // statement sitting behind it. Before readRows - never walking such a sheet is
    // the whole point of the early-out.
    if (worksheet.rowCount > MAX_SHEET_ROWS) {
      tooLarge.push(`${worksheet.name} (${worksheet.rowCount} rows)`);
      continue;
    }
    const rows = readRows(worksheet);
    let header = -1;
    for (let i = 0; i < rows.length && i < HEADER_SCAN_ROWS; i++) {
      const cells = rows[i].cells.map((c) => cellText(c).trim());
      const verdict = isHeader(cells);
      if (verdict.ok) {
        header = i;
        break;
      }
      // the widest row wins, and strictly, so the header beats the data rows that
      // tie with it; under two cells it is a preamble title, not a near miss
      const filled = cells.filter(Boolean).length;
      if (verdict.error && filled >= 2 && filled > (closest?.filled ?? 0)) {
        const { sheetRow } = rows[i];
        closest = { sheet: worksheet.name, sheetRow, filled, error: verdict.error };
      }
    }
    if (header < 0) continue;
    // kept[0] is the header row: rowLabel and note are only ever asked about 1..n
    const kept = rows.slice(header);
    return {
      rows: kept.map((r) => r.cells),
      rowLabel: (i) => kept[i]?.sheetRow ?? i + 1,
      note: (row, col) => kept[row]?.notes.get(col),
      date1904,
    };
  }
  throw new Error(
    `could not find a header row in any sheet of the workbook (looked at: ${tried.join(', ')}) - the columns must include a date, an amount and a description, or pick a preset` +
      closestClause(closest) +
      (tooLarge.length ? ` - skipped as too large to read: ${tooLarge.join(', ')}` : ''),
  );
}

/**
 * Why the nearest thing to a header was not one. Without it a mismatched preset
 * reads as "pick a preset", which is what the user just did - the CSV of the same
 * statement names the missing column, and this is where that sentence went.
 */
function closestClause(candidate: Candidate | null): string {
  if (!candidate) return '';
  const clause = ` - the closest row (sheet "${candidate.sheet}", row ${candidate.sheetRow}) does not match: ${candidate.error}`;
  return clause.length > CLOSEST_CLAUSE_MAX ? `${clause.slice(0, CLOSEST_CLAUSE_MAX)}...` : clause;
}

/** Rows that carry something, in sheet order, each remembering where it came from. */
function readRows(worksheet: ExcelJS.Worksheet): RawRow[] {
  const rows: RawRow[] = [];
  worksheet.eachRow((row, sheetRow) => {
    const cells: Cell[] = [];
    const notes = new Map<number, string>();
    for (let c = 1; c <= row.cellCount; c++) {
      const { value, note } = normalise(row.getCell(c));
      cells[c - 1] = value;
      if (note) notes.set(c - 1, note);
    }
    if (hasContent(cells)) rows.push({ sheetRow, cells, notes });
  });
  return rows;
}

function normalise(cell: ExcelJS.Cell): Normalised {
  switch (cell.type) {
    case ExcelJS.ValueType.Number:
    case ExcelJS.ValueType.String:
    case ExcelJS.ValueType.SharedString:
    case ExcelJS.ValueType.Date:
      return { value: cell.value as Cell };
    // a boolean as text, so an onlyWhen filter on such a column still matches
    case ExcelJS.ValueType.Boolean:
      return { value: cell.value ? 'TRUE' : 'FALSE' };
    case ExcelJS.ValueType.RichText:
      return { value: joinRichText(cell.value as ExcelJS.CellRichTextValue) };
    case ExcelJS.ValueType.Hyperlink:
      return { value: String((cell.value as ExcelJS.CellHyperlinkValue).text ?? '') };
    case ExcelJS.ValueType.Error:
      return { value: null, note: errorNote(cell.value as ExcelJS.CellErrorValue) };
    case ExcelJS.ValueType.Formula:
      return fromResult((cell.value as ExcelJS.CellFormulaValue).result);
    // a merged cell: exceljs hands back the master's value, which has its own type
    case ExcelJS.ValueType.Merge:
      return cell.master && cell.master !== cell ? normalise(cell.master) : { value: null };
    default:
      return { value: null };
  }
}

/** A formula's cached result carries no cell type of its own - go by its shape. */
function fromResult(result: unknown): Normalised {
  if (result === null || result === undefined) return { value: null, note: UNCACHED_FORMULA };
  if (result instanceof Date) return { value: result };
  if (typeof result === 'number') return { value: Number.isFinite(result) ? result : null };
  if (typeof result === 'string') return { value: result };
  if (typeof result === 'boolean') return { value: result ? 'TRUE' : 'FALSE' };
  if (typeof result === 'object') {
    if ('error' in result) return { value: null, note: errorNote(result as ExcelJS.CellErrorValue) };
    if ('richText' in result) return { value: joinRichText(result as ExcelJS.CellRichTextValue) };
  }
  return { value: null };
}

const joinRichText = (v: ExcelJS.CellRichTextValue): string =>
  v.richText.map((part) => part.text).join('');

const errorNote = (v: ExcelJS.CellErrorValue): string => `contains ${String(v.error)}`;
