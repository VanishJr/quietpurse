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
 *
 * "Here" is not only this file: a workbook's columns are resolved by the presets and
 * resolveColumns that the CSV path uses, so a change to either parses a .xlsx export
 * differently for exactly the same reason and moves this number too.
 */
export const XLSX_PARSER_VERSION = 3;

/** How far down a sheet the header may hide behind a title or an account block. */
const HEADER_SCAN_ROWS = 20;

/**
 * Cheap early-out only, deliberately far above MAX_DATA_ROWS: rowCount counts rows
 * carrying nothing but formatting, and formatting a whole column is something
 * people do. The cap that decides an import is the mapper's, over kept data rows.
 *
 * Exported because it is also the widest row LABEL a sheet can carry, and every
 * xlsx figure in the derivation above statement.ts's CELL_QUOTE_MAX is read at that
 * ceiling: the budget sweep imports this rather than keeping a second copy, or it
 * goes on measuring the old ceiling, green, after this one moves.
 */
export const MAX_SHEET_ROWS = 10 * MAX_DATA_ROWS;

/** The reason the closest row was rejected is the user's, but not at any length. */
const CLOSEST_CLAUSE_MAX = 300;

/** Under this what is left buys a fragment, not a clause - and a fragment misnames. */
const CLOSEST_CLAUSE_MIN = 60;

/** A twelve-month workbook would name every month; the rest becomes a count. */
const UNUSED_LIST_MAX = 150;

/**
 * What an error cell's own text may spend, cut here rather than trusted.
 * CellErrorValue['error'] is seven string literals at compile time and the loader
 * never checks the file it read against them, so String(v.error) is whatever the
 * bytes say - a workbook no spreadsheet wrote is still a workbook this parser opens.
 * The note errorNote composes is `contains ` plus this, 33, against the 131 an xlsx
 * note may spend (derived above statement.ts's CELL_QUOTE_MAX), and THIS CUT is what
 * holds that number: neither the union nor the two `as ExcelJS.CellErrorValue` casts
 * hold anything about the file. 24 because every error code a spreadsheet writes is
 * 7 characters or fewer, and a cell's own text is quoted at 24 across this parser.
 */
const ERROR_TEXT_MAX = 24;

/**
 * What the whole notice may spend. noRowsParsed appends it behind the row's own
 * reason whole or not at all, so a notice past this costs the too-large clause as
 * well as the unused one - and that clause reached the user before this one existed.
 * What ERROR_DETAIL_MAX leaves after the longest reason the parser composes from
 * fixed prose, the 3 characters that join the two, and 8 of margin. That reason is
 * 199 - MAX_DATA_ROWS skipped, plus the 159 derived in full above statement.ts's
 * CELL_QUOTE_MAX, which is the one place that number is now written whole. 298 is
 * therefore the exact bound - the margin is there because this number has been
 * derived three times and been wrong twice.
 *
 * Both premises this comment used to state were among those wrongs, and they cancelled:
 * the row label cannot reach Excel's own ceiling (MAX_SHEET_ROWS above stops it at
 * six digits), and -Number.MAX_VALUE is not the widest String(n). Read the
 * derivation there, not here. The too-large list is not bounded by this number and
 * predates it, so when the two together do not fit it is the unused clause that yields.
 */
const NOTICE_MAX = ERROR_DETAIL_MAX - 210;

const UNCACHED_FORMULA =
  'is a formula with no stored result - open the file in Excel, re-save it, and upload again';

const NOT_A_WORKBOOK =
  'this is a zip archive but not an Excel workbook (.xlsx) - .ods and .numbers are not supported; export the statement as .xlsx or CSV';

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
  /** the key the notice excludes it by, so no sheet is named in both of its clauses */
  id: number;
  name: string;
  rowCount: number;
}

/**
 * The one definition of a sheet this importer can see: the selection loop's skip and
 * the notice's list both read it, so the two cannot disagree about which sheets a
 * workbook has. Positive rather than `!== 'hidden'` - a state exceljs has yet to
 * learn would otherwise read as a statement.
 */
const isVisible = (ws: ExcelJS.Worksheet): boolean => ws.state === 'visible';

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
    throw new Error(NOT_A_WORKBOOK);
  }
  // a .zip holding anything else loads clean and empty rather than throwing above:
  // the same file, so the same answer - it has no sheet to be told to unhide
  const sheets = workbook.worksheets;
  if (sheets.length === 0) throw new Error(NOT_A_WORKBOOK);
  const date1904 = workbook.properties?.date1904 === true;

  const tried: string[] = [];
  const tooLarge: Oversized[] = [];
  let closest: Candidate | null = null;

  for (const worksheet of sheets) {
    // a hidden sheet is hidden for a reason: never the statement
    if (!isVisible(worksheet)) continue;
    tried.push(worksheet.name);
    // an implausible sheet is disqualified the way a hidden one is, not the
    // workbook with it: a cover sheet formatted to the bottom must not refuse the
    // statement sitting behind it. Before readRows - never walking such a sheet is
    // the whole point of the early-out.
    if (worksheet.rowCount > MAX_SHEET_ROWS) {
      tooLarge.push({ id: worksheet.id, name: worksheet.name, rowCount: worksheet.rowCount });
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
    const note = sheetNotice(sheets, worksheet, tooLarge);
    return {
      rows: kept.map((r) => r.cells),
      rowLabel: (i) => kept[i]?.sheetRow ?? i + 1,
      note: (row, col) => kept[row]?.notes.get(col),
      date1904,
      notices: note ? [note] : undefined,
    };
  }
  throw new Error(notFound(tried, tooLarge, closest));
}

/**
 * A sheet that was never read is reported on the way out as well as on the way
 * down. A workbook whose January sheet is formatted past the cap imports February,
 * answers 200 and shows a success card; without this nothing the user is shown says
 * that a month is missing. The loop above returns at the first sheet whose header
 * resolves, so the same silence covers every sheet behind that one - a two-month
 * workbook imports January and says nothing whatever about February, which is why
 * the unused list is derived here from the workbook rather than from `tried`.
 * importStatement warns per notice, but a log answers a support question, not the
 * person looking at their own statement, and the `imports` row records nothing about
 * a skipped sheet at all. Hidden and empty sheets are never named: the selector will
 * not read a hidden sheet either, and a blank Tabelle2 rides along in half the
 * workbooks people export - naming either puts a notice on an import with nothing
 * wrong with it. One entry however many sheets and however many causes - it shares
 * the problems array with the row-level messages.
 *
 * Re-uploading the file is deliberately not offered: once this import is confirmed
 * the same bytes answer "already imported" without being parsed, so the only exit
 * that works is saving the other sheets as files of their own.
 */
function sheetNotice(
  sheets: ExcelJS.Worksheet[],
  used: ExcelJS.Worksheet,
  tooLarge: Oversized[],
): string | undefined {
  const oversized = new Set(tooLarge.map((s) => s.id));
  const unused = sheets
    .filter((w) => w.id !== used.id && isVisible(w) && w.rowCount > 0 && !oversized.has(w.id))
    .map((w) => `"${w.name}"`);
  if (!tooLarge.length && !unused.length) return undefined;

  const names = tooLarge.map((s) => `"${s.name}" (${s.rowCount} rows)`).join(', ');
  const skipped =
    tooLarge.length === 0
      ? ''
      : tooLarge.length === 1
        ? `sheet ${names} was too large to read and was skipped - `
        : `sheets ${names} were too large to read and were skipped - `;
  const base = `${skipped}these rows come from "${used.name}"`;
  if (!unused.length) return base;

  const tail =
    unused.length === 1
      ? ' was not imported - save it as a separate file to import it'
      : ' were not imported - save them as separate files to import them';
  const clause = (listed: string): string => ` - ${listed}${tail}`;
  // what the too-large list left, and never less than joinBounded's last resort
  // costs: a clause that cannot afford even a count is dropped whole, because half a
  // sheet name is a sheet the workbook has not got
  const room = Math.min(UNUSED_LIST_MAX, NOTICE_MAX - base.length - clause('').length);
  if (room < sheetCount(unused.length).length) return tooLarge.length ? base : undefined;
  return base + clause(joinBounded(unused, room));
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

const errorNote = (v: ExcelJS.CellErrorValue): string => {
  const text = String(v.error);
  const cut = text.length <= ERROR_TEXT_MAX ? text : `${text.slice(0, ERROR_TEXT_MAX - 3)}...`;
  return `contains ${cut}`;
};
