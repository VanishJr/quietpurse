import ExcelJS from 'exceljs';
import { ERROR_DETAIL_MAX } from '../db';
import { Cell, MAX_DATA_ROWS, Sheet, cellText, hasContent } from './sheet';

export const XLSX_PARSER_VERSION = 4;

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

/**
 * One mark for both cuts in this file, and the one bounded() marks with over in
 * statement.ts: a message that was shortened must not read as a finished one. One
 * code unit rather than three, because every character the mark costs is a character
 * of the list it just cut.
 */
const CUT_MARK = '…';

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
 * therefore the exact bound; the margin is there because this number has been got
 * wrong before.
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
 * that, failImport's own cut takes the tail, and the tail is where the clauses are.
 * The fixed prose is never shortened - only the sheet lists and the closest-row
 * clause, in that order of preference. A sheet that was never read is a refusal
 * cause with no other channel; the closest row only refines a sentence that is
 * already true, so it yields first. The preference is the only thing standing
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
 * The longest prefix of `text` that fits `budget` and stops where a reader cannot be
 * misled, marked - or null, when there is no such prefix and the caller has to drop
 * what it was about to say.
 *
 * joinBounded above composes its own list and so never has to ask whether a comma
 * separates two entries or sits inside one; this is handed a sentence somebody else
 * composed and can only cut at a separator it can see. Hence the preference order,
 * which is the one noColumnMatched states for that same sentence one level up:
 * everything behind the first `; ` yields first and yields whole, then whole entries
 * off the end, then the lot. A `"` in these sentences is a name delimiter that
 * noColumnMatched does not escape, so the tracking holds only while no name carries
 * one, and an unquoted header list it cannot see at all.
 *
 * It cannot split a surrogate pair either, and that is structural rather than
 * promised: it never cuts anywhere but immediately before an ASCII separator.
 */
function cutBounded(text: string, budget: number): string | null {
  if (text.length <= budget) return text;
  const room = budget - CUT_MARK.length;
  if (room <= 0) return null;
  let quoted = false;
  let entry = -1;
  for (let i = 0; i <= room; i++) {
    if (text[i] === '"') quoted = !quoted;
    else if (!quoted && text[i + 1] === ' ') {
      if (text[i] === ';') return text.slice(0, i) + CUT_MARK;
      if (text[i] === ',') entry = i;
    }
  }
  return entry < 0 ? null : text.slice(0, entry) + CUT_MARK;
}

/**
 * Why the nearest thing to a header was not one. Without it a mismatched preset
 * reads as "pick a preset", which is what the user just did - the CSV of the same
 * statement names the missing column, and this is where that sentence went.
 *
 * Both halves of the budget are measured rather than guessed at. The prose in front
 * of the reason is fixed and its WIDTH is not - the sheet name is the user's and the
 * row label is up to six digits - so what the reason may spend is what composing that
 * prose leaves, and a clause whose own prose no longer fits is dropped before a
 * reason is cut to go in it. That `room <= 0` reads as redundant and is not:
 * cutBounded answers null for the same inputs, so deleting it would leave this
 * clause's own precondition resting on another function's null semantics. Then
 * cutBounded answers a whole unit of that reason or nothing: ` - the closest row
 * (sheet "Umsä` names a sheet the workbook has not got and `does not match: no `
 * carries none of the reason it promised, and neither of those is a number of
 * characters that a constant could have stood for.
 */
function closestClause(candidate: Candidate | null, budget: number): string {
  if (!candidate) return '';
  const prefix = ` - the closest row (sheet "${candidate.sheet}", row ${candidate.sheetRow}) does not match: `;
  const room = Math.min(CLOSEST_CLAUSE_MAX, budget) - prefix.length;
  if (room <= 0) return '';
  const reason = cutBounded(candidate.error, room);
  return reason === null ? '' : prefix + reason;
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
  const cut =
    text.length <= ERROR_TEXT_MAX
      ? text
      : `${text.slice(0, ERROR_TEXT_MAX - CUT_MARK.length)}${CUT_MARK}`;
  return `contains ${cut}`;
};
