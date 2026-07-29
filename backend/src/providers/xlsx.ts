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
import { ERROR_DETAIL_MAX } from '../db';
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

/** Under this what is left buys a fragment, not a clause - and a fragment misnames. */
const CLOSEST_CLAUSE_MIN = 60;

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

/** A sheet the early-out disqualified: named whether or not another one worked out. */
interface Oversized {
  name: string;
  rowCount: number;
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
  const tooLarge: Oversized[] = [];
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
      tooLarge.push({ name: worksheet.name, rowCount: worksheet.rowCount });
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
      notices: tooLarge.length ? [skippedNotice(tooLarge, worksheet.name)] : undefined,
    };
  }
  throw new Error(notFound(tried, tooLarge, closest));
}

/**
 * A sheet that was never read is reported on the way out as well as on the way
 * down. A workbook whose January sheet is formatted past the cap imports February,
 * answers 200 and shows a success card; without this nothing the user is shown says
 * that a month is missing. importStatement warns per notice, but a log answers a
 * support question, not the person looking at their own statement, and the `imports`
 * row records nothing about a skipped sheet at all. One entry however many sheets
 * were skipped - it shares the problems array with the row-level messages.
 */
function skippedNotice(tooLarge: Oversized[], used: string): string {
  const names = tooLarge.map((s) => `"${s.name}" (${s.rowCount} rows)`).join(', ');
  return tooLarge.length === 1
    ? `sheet ${names} was too large to read and was skipped - these rows come from "${used}"`
    : `sheets ${names} were too large to read and were skipped - these rows come from "${used}"`;
}

/**
 * Why the workbook yielded nothing, composed to the length error_detail keeps: past
 * that, failImport's slice cuts the tail, and the tail is where the clauses are.
 * The fixed prose is never shortened - only the sheet lists and the closest-row
 * clause, in that order of preference. A sheet that was never read is a refusal
 * cause with no other channel; the closest row only refines a sentence that is
 * already true, so it yields first. The client renders the whole of this budget
 * (MAX_ERROR_CHARS in web/src/api.ts), so the preference is the only thing standing
 * between a clause and the reader: what yields here is gone, not further down.
 */
function notFound(tried: string[], tooLarge: Oversized[], closest: Candidate | null): string {
  // no sheet was ever eligible to have columns, so naming them is a false diagnosis
  // and the list they would be named beside is empty
  if (tried.length === 0) {
    return 'this workbook has no visible sheet - unhide the sheet holding the statement, or export the statement again';
  }
  const head = 'could not find a header row in any sheet of the workbook (looked at: ';
  const tail = ') - the columns must include a date, an amount and a description, or pick a preset';
  const largeHead = ' - skipped as too large to read: ';

  let left = ERROR_DETAIL_MAX - head.length - tail.length - (tooLarge.length ? largeHead.length : 0);
  const listed = tooLarge.map((s) => `${s.name} (${s.rowCount} rows)`);
  // joinBounded's last resort is a count, and a count still costs characters: hold
  // back what the base list will spend on one even if it can afford no name at all,
  // or a workbook of nothing but oversized sheets composes past what error_detail keeps
  const floor = sheetCount(tried.length).length;
  const large = tooLarge.length ? joinBounded(listed, left - floor) : '';
  left -= large.length;
  const looked = joinBounded(tried, left);
  left -= looked.length;

  return head + looked + tail + (large ? largeHead + large : '') + closestClause(closest, left);
}

/**
 * As many names as the budget leaves, then a count of the rest. A workbook may carry
 * any number of sheets, and without this it is the actionable half of the sentence
 * that falls off the end rather than the list.
 */
function joinBounded(names: string[], budget: number): string {
  let out = '';
  for (let i = 0; i < names.length; i++) {
    const next = out ? `${out}, ${names[i]}` : names[i];
    const rest = names.length - i - 1;
    if (next.length + (rest ? ` and ${rest} more`.length : 0) > budget) {
      return out ? `${out} and ${names.length - i} more` : sheetCount(names.length);
    }
    out = next;
  }
  return out;
}

/**
 * The count string in one place: notFound reserves exactly what joinBounded's last
 * resort will spend, so a plural fixed in one and not the other leaks a character
 * off the budget at one sheet - which is the arm no test with several can see.
 */
const sheetCount = (n: number): string => `${n} sheet${n === 1 ? '' : 's'}`;

/**
 * Why the nearest thing to a header was not one. Without it a mismatched preset
 * reads as "pick a preset", which is what the user just did - the CSV of the same
 * statement names the missing column, and this is where that sentence went. Dropped
 * whole when what is left buys only a fragment: ` - the closest row (sheet "Umsä`
 * names a sheet that does not exist.
 */
function closestClause(candidate: Candidate | null, budget: number): string {
  if (!candidate) return '';
  const clause = ` - the closest row (sheet "${candidate.sheet}", row ${candidate.sheetRow}) does not match: ${candidate.error}`;
  const room = Math.min(CLOSEST_CLAUSE_MAX, budget);
  if (room < CLOSEST_CLAUSE_MIN) return '';
  return clause.length <= room ? clause : `${clause.slice(0, room - 3)}...`;
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
