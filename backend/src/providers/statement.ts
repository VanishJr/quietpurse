import crypto from 'crypto';
import { categorize } from '../categorizer';
import { CURRENCY_CODE, currencyKey } from '../currency';
import {
  ERROR_DETAIL_MAX,
  ImportSourceType,
  type StagedAccount,
  countNewKeys,
  createImport,
  failImport,
  findCommittedImportByHash,
  listImportAccountIds,
  recordImportDocument,
  resolveUploadAccount,
  stageImport,
  supersedeStagedImports,
} from '../db';
import { putDocument } from '../documents';
import { logImport } from '../logger';
import { fromCents, toCents } from '../money';
import { NewTransaction } from '../types';
import {
  type BalancesNotShown,
  type CalendarDay,
  calendarDay,
  type ImportSummary as WireImportSummary,
  type ReadAs,
  type ReadColumns,
  type SeriesCounts,
  type StatementBalances as WireBalances,
  type StatementImportResult as WireImportResult,
  type StatementTotal,
} from '../wire';
import {
  CSV_PARSER_VERSION,
  CSV_PRESETS,
  CsvMapping,
  CsvPresetMapping,
  decodeCsv,
  detectDelimiter,
  fold,
  genericMapping,
  matchColumn,
  parseCsv,
} from './csv';
import {
  PDF_PARSER_VERSION,
  PdfFee,
  PdfLimits,
  PdfMcc,
  StatementBalances,
  readPdf,
} from './pdf';
import { Cell, MAX_DATA_ROWS, Sheet, cellAmount, cellDate, cellText } from './sheet';
import { XLSX_PARSER_VERSION, readXlsx } from './xlsx';

const PARSER_VERSION: Record<ImportSourceType, number> = {
  csv: CSV_PARSER_VERSION,
  xlsx: XLSX_PARSER_VERSION,
  pdf: PDF_PARSER_VERSION,
};

const MB = 1024 * 1024;

interface SizeCap {
  max: number;
  tooLarge: (mb: number) => string;
}

const SIZE_CAP: Record<ImportSourceType, SizeCap | null> = {
  // decodeCsv holds the text and nothing expands: MAX_UPLOAD_BYTES is the only cap
  csv: null,
  /** exceljs reads a workbook whole, so the zip and everything it expands to is held at once. */
  xlsx: {
    max: 10 * MB,
    tooLarge: (mb) =>
      `the workbook is larger than ${mb} MB. Export a narrower date range, or save it as CSV`,
  },
  /** pdfjs holds the document whole, exactly as exceljs holds the workbook. */
  pdf: {
    max: 10 * MB,
    tooLarge: (mb) =>
      `the PDF is larger than ${mb} MB. Export a narrower date range, or export the statement as CSV or Excel (.xlsx)`,
  },
};

const FORMAT_NAME: Record<ImportSourceType, string> = {
  csv: 'CSV',
  xlsx: 'Excel (.xlsx)',
  pdf: 'PDF',
};

const FORMAT_NAMES = Object.values(FORMAT_NAME);
/** The list a refusal names, derived and never typed out. */
const FORMATS = `${FORMAT_NAMES.slice(0, -1).join(', ')} or ${FORMAT_NAMES[FORMAT_NAMES.length - 1]}`;

/**
 * And a page cap as well, because the byte cap does not bound the page count even
 * loosely: compressed streams are the point of the format, so a plausible statement
 * fits in a few megabytes however many pages it has. Enforced inside readPdf and not
 * here, because numPages needs the document open; which refusals leave an imports row
 * and which leave none is in SPEC.md.
 */
const MAX_PDF_PAGES = 200;

/**
 * And a deadline, because neither cap bounds the WORK: how long a parse holds the only
 * thread this process has is the document's to decide, not the byte count's.
 *
 * What it does not bound. The check runs between pdfjs calls and cannot interrupt one, and
 * a document may put everything on a single page; what a compressed stream expands to is
 * bounded by neither cap. Opening the document is outside it the same way: it is charged
 * to the budget but cannot be interrupted by it. So this bounds accidental pathology and
 * not someone who is trying. Sustained load across many uploads is a rate limit and not
 * this.
 */
const PDF_LIMITS: PdfLimits = { maxPages: MAX_PDF_PAGES, deadlineMs: 20_000 };

/** How far into a text file the NUL that says it is not one is searched for. */
export const NUL_SCAN_BYTES = 8192;

/** The five bytes pdfjs itself searches for (PDF_HEADER_SIGNATURE), dash included. */
const PDF_HEADER = '%PDF-';

/** Notices and row problems share this budget; the client renders only the first few. */
const MAX_PROBLEMS = 5;

const STATUS_QUOTE_MAX = 24;
const STATUS_LIST_MAX = 72;

const FEE_QUOTE_MAX = 24;

const SERIES_QUOTE_MAX = 24;

/**
 * What one cell describeRow quotes back at the user may spend. This is also the one
 * place where the 199 that NOTICE_MAX (xlsx.ts) and NOTE_MAX (pdf.ts) are both
 * derived against is written whole. Three files each carried half of that
 * derivation, each half was locally checkable, and nobody owned the sum: which is
 * how BOTH premises of the sentence in xlsx.ts came to be false while its number
 * stayed right.
 *
 * 199 = noRowsParsed's head at MAX_DATA_ROWS skipped, 40, plus the longest reason
 * describeRow composes, 159. NOTICE_MAX is what ERROR_DETAIL_MAX leaves after those
 * two, the 2 characters that join them, and 8 of margin.
 *
 * The 159, at the extreme of every number it carries. The lead is `row `, the label
 * and `: `, and the label is whatever the path's rowLabel emits:
 *   xlsx   kept[i].sheetRow, and never past MAX_SHEET_ROWS = 500000, because a
 *          worksheet with more rows than that is skipped before readRows walks it.
 *          So Excel's own 1048576 is NOT reachable, however the file was written
 *   csv    i + 1, so MAX_DATA_ROWS + 1
 *   pdf    i, so MAX_DATA_ROWS
 * against the arms:
 *   numeric date   String(n) for a double is 25 characters at its widest
 *                  (-0.0000010352999999999999), not the 24 of -Number.MAX_VALUE.
 *                  Bounded here, which is what makes 159 hold at a seven-digit label
 *                  instead of only at the six the xlsx gate happens to allow: 158
 *                  under a six-digit label, 159 at Excel's unreachable one
 *   a note         the wider of the two arms that quote one spends 22 of fixed prose
 *                  (`the amount cell `; the date one is 20). What a note MAY spend,
 *                  the budget a producer is writing against, is what 159 leaves
 *                  after that and the label: 131 under xlsx's six digits, 132 under
 *                  the five pdf and csv can reach. The two cannot be traded: a
 *                  132-character note at a six-digit label composes 160, so 131 is
 *                  the only figure safe on every path.
 *                  What holds a note inside that budget on the xlsx path is the CUT
 *                  at ERROR_TEXT_MAX in xlsx.ts and not a type: CellErrorValue's
 *                  error is a union of literals nothing checks the file against, so
 *                  an error cell's own text is whatever the bytes say, and without
 *                  the cut it composes past the budget and evicts noRowsParsed's
 *                  notice about a different part of the file whole.
 *                  NOT held: that a note producer added later respects its path's
 *                  budget. Nothing checks it, and a blanket bounded() here cannot:
 *                  it would have to cut at 131, which is under what pdf already
 *                  spends.
 *   no movement    the on-top arm quotes two cells at this bound: 159 under a
 *                  six-digit label, and it is spent to the character. included is
 *                  pdf-only, 142; not-stated is every path's, 133 under a six-digit
 *                  label
 *   fall-through   two cells at this bound: 104 under a six-digit label
 */
const CELL_QUOTE_MAX = 24;

/**
 * What one column name may spend in the summary's readAs. A RENDER bound: readAs is a
 * field of the summary, never a problem and never an error_detail.
 *
 * The NUMBER of description names is deliberately not bounded. A truncated list of
 * column names reads exactly like a complete one, and a "+N more" tail is a fifth state
 * on a type whose whole point is that two states are never spelled the same way. The
 * per-name bound is the one that is safe.
 */
const COLUMN_NAME_MAX = 40;

/**
 * Where an upload's rows go: an account the caller already has. Creating one is
 * POST /api/accounts and nothing else.
 *
 * The absent keys stay, carried as optional `never`. They no longer hold
 * exclusivity, since there is nothing left to be exclusive with. What they hold is
 * every typed call site: app.ts annotates `const destination: StatementDestination`,
 * so a product call site that built a name arm fails tsc, including one that builds
 * the object in a variable first, where an excess-property check would not run. A
 * direct call under test/ fails the same way, in the tsconfig that checks test/. They
 * hold NOTHING over the wire, because a multipart field carries no type.
 */
export type StatementDestination = { accountId: string; accountName?: never; currency?: never };

export type StatementImportRequest = StatementDestination & {
  preset?: string;
  mapping?: Partial<CsvMapping>;
  bytes: Buffer;
  originalFilename?: string;
};

export const ACCOUNT_NOT_FOUND =
  'no such account. Pick one of your accounts, or create a new one';
export const ACCOUNT_REMOVED =
  'this account is hidden. Unhide it, then upload the file again';

export type { BalancesNotShown, ReadAs, ReadColumns, SeriesCounts } from '../wire';

declare const checked: unique symbol;

export type CheckedTotals = readonly StatementTotal[] & { readonly [checked]: true };

export type CheckedBalances = WireBalances & { readonly [checked]: true };

export type SheetReadAs = Exclude<ReadAs, { kind: 'pdf-template' }>;

/** The one place either brand is applied, and it is private to this module. */
const check = <T>(value: T): T & { readonly [checked]: true } =>
  value as T & { readonly [checked]: true };

/** The wire's summary with the brand on the two fields only reconcile may fill. */
export type ImportSummary = Omit<WireImportSummary, 'totals' | 'balances'> & {
  totals: CheckedTotals;
  balances?: CheckedBalances;
};

export type StatementImportResult =
  | Extract<WireImportResult, { outcome: 'duplicate' }>
  | { outcome: 'awaiting_confirmation'; summary: ImportSummary };

export function sniff(bytes: Buffer): ImportSourceType {
  const starts = (...signature: number[]): boolean =>
    signature.every((b, i) => bytes[i] === b);

  if (bytes.length === 0) {
    throw new Error(
      'this file is empty. Export the statement again from your online banking and upload the new file',
    );
  }
  if (starts(0x50, 0x4b, 0x03, 0x04)) return 'xlsx';
  if (starts(0x25, 0x50, 0x44, 0x46)) return 'pdf';
  if (starts(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) {
    throw new Error(
      'this is the older Excel format (.xls). Open it and save as .xlsx, or export the statement as CSV',
    );
  }
  if (starts(0x1f, 0x8b)) {
    throw new Error('this file is compressed. Unpack it and upload the statement itself');
  }
  // UTF-16 ahead of the NUL scan below, which every UTF-16 file would otherwise
  // trip: Excel's own "Unicode Text" export is UTF-16LE with a BOM, and decodeCsv
  // reads exactly the BOM'd forms
  if (starts(0xff, 0xfe) || starts(0xfe, 0xff)) return 'csv';

  const blank = new Set([0x09, 0x0a, 0x0d, 0x20]);
  let i = starts(0xef, 0xbb, 0xbf) ? 3 : 0;
  while (i < bytes.length && blank.has(bytes[i])) i++;
  if (bytes[i] === 0x3c) {
    throw new Error(
      `this looks like XML or HTML, not a ${FORMATS} statement. CAMT.053 and MT940 are not supported yet`,
    );
  }
  // A bank's own export can be a signed container: the whole statement inside a CMS
  // envelope, with `%PDF-` at an offset rather than at 0. Answered on the header being
  // FOUND and never on the lead-in, because "it starts like an ASN.1 SEQUENCE" is not
  // evidence that a statement is in there. 0x30 is also ASCII `0`, so a CSV whose first
  // cell is a dotted date reaches this line; the second byte is what parts them, and only
  // because 0x80-0x84 are UTF-8 continuation bytes, which cannot follow an ASCII digit in
  // a text file. Short form says the whole value is at most 127 bytes and cannot hold a
  // document; 0x80 is BER indefinite length, which a signer that streams emits. A rule
  // narrowed to the one length byte the documents in hand happen to carry would pass
  // every test written from them and refuse the same bank's next file.
  //
  // Searched whole rather than within a window: readPdf gets this same buffer, and pdfjs
  // finds the header at any offset, because past its own find() window it reconstructs
  // the xref. So a window here would make the classifier stricter than the reader it
  // feeds, and refuse a file this product can read. Only a file that already matched the
  // lead-in gets this far, so no CSV pays for the search.
  if (bytes[0] === 0x30 && bytes[1] >= 0x80 && bytes[1] <= 0x84 && bytes.includes(PDF_HEADER)) {
    return 'pdf';
  }
  if (bytes.subarray(0, NUL_SCAN_BYTES).includes(0)) {
    throw new Error(
      `this file is not a ${FORMATS} statement. Export the statement in one of those formats from your online banking and upload that`,
    );
  }
  return 'csv';
}

export async function importStatement(
  req: StatementImportRequest,
): Promise<StatementImportResult> {
  const fileHash = crypto.createHash('sha256').update(req.bytes).digest('hex');

  const already = await findCommittedImportByHash(fileHash);
  if (already) {
    // the account this upload asked for is not necessarily where the rows are: the
    // file went into whatever account it was given the first time
    const accountIds = await listImportAccountIds(already.id);
    return {
      outcome: 'duplicate',
      // and the requested id must not stand in for it: this field says where the
      // EARLIER import's rows are, and that import may have put them somewhere else
      // entirely
      accountId: accountIds[0] ?? '',
      accountIds,
      skipped: already.rowsRejected,
      total: already.rowsAccepted + already.rowsRejected,
      importId: already.id,
      uploadedAt: already.uploadedAt,
    };
  }

  // below the duplicate short-circuit, and it must stay there: a re-upload of a
  // committed file resolves nothing and mints nothing.
  //
  // Above `sniff` is a choice and not a necessity. The destination refusal is true
  // whatever the file turns out to be, and unlike the format and size refusals, the
  // user cannot discover it by looking at the file. So a .docx dropped into a removed
  // account is told the account is gone rather than told the format is unreadable.
  // Both are true; this one is the one worth saying first. Moved below createImport
  // it would also leave an `imports` row for an upload that was never going to land.
  const account = await uploadDestination(req);

  const sourceType = sniff(req.bytes);
  const cap = SIZE_CAP[sourceType];
  if (cap && req.bytes.length > cap.max) throw new Error(cap.tooLarge(cap.max / MB));
  const preset = presetMapping(req.preset);

  const record = await createImport({
    fileHash,
    sourceType,
    parserVersion: PARSER_VERSION[sourceType],
    originalFilename: req.originalFilename,
  });
  try {
    // The file itself, before the parse and inside the same catch.
    // Before, because the imports that FAILED are precisely the ones support needs
    // the input for. So a failed import keeps its document, and so does a `pending`
    // one left by a process that died between here and the parse.
    //
    // If it cannot be stored the import is refused rather than committed with a
    // warning: committing would claim the file hash forever, and the same bytes
    // would then answer "already imported" on every retry, so the one artefact that
    // cannot be recovered later could never be captured for that file at all. The
    // throw lands in the catch below, which leaves a `failed` row with no transactions
    // and bytes that stay re-uploadable, because only `committed` blocks.
    await putDocument(
      { importId: record.id, originalFilename: record.originalFilename, sourceType },
      req.bytes,
    );
    await recordImportDocument(record.id);
    const parsed = await readSheet(req, sourceType, preset);
    // logged here rather than in the route because the route only sees the
    // successful path: `problems` is never sent on a failure and nothing about a
    // skipped sheet is stored, so this is the only trace when the import throws
    for (const notice of parsed.sheet.notices ?? []) {
      logImport.warn(`import ${record.id}: ${notice}`);
    }
    // which layout read it is genuinely useful to someone about to confirm, and it
    // still does not go in `problems`: the client renders those under "N rows
    // couldn't be read", so "read as a Revolut statement" would land under a
    // sentence saying it could not be. What the layout DID reach the
    // screen with is its balances, as a field of the summary and not a sentence.
    if (parsed.kind === 'pdf') logImport.info(`import ${record.id}: read as ${parsed.template}`);
    return await mapAndStore(req, parsed, account, record.id, fileHash);
  } catch (e) {
    await failImport(record.id, (e as Error).message);
    throw e;
  }
}

/**
 * The one place an upload decides where its rows go, and the one place either
 * destination refusal is thrown. Both are plain throws above createImport, so a
 * refused upload leaves no `imports` row, no stored document and no history entry.
 */
async function uploadDestination(req: StatementImportRequest): Promise<StagedAccount> {
  const found = await resolveUploadAccount(req.accountId);
  if (!found.ok) {
    throw new Error(found.reason === 'hidden' ? ACCOUNT_REMOVED : ACCOUNT_NOT_FOUND);
  }
  return found.account;
}

interface NamedPreset {
  key: string;
  title: string;
  mapping: CsvPresetMapping;
}

function presetMapping(preset: string | undefined): NamedPreset | null {
  if (!preset || preset === 'generic') return null;
  // hasOwn and not CSV_PRESETS[preset]: the record is a plain object literal, so
  // `toString` and every other Object.prototype member reads as a truthy entry whose
  // .mapping is undefined. That entry reaches readSheet as a preset and dies there on
  // `preset.mapping.delimiter`, with an internal TypeError in error_detail.
  const known = Object.hasOwn(CSV_PRESETS, preset) ? CSV_PRESETS[preset] : undefined;
  if (!known) throw new Error(`unknown preset: ${preset}`);
  return { key: preset, ...known };
}

export type ParsedFile =
  | {
      kind: 'sheet';
      sheet: Sheet;
      preset: NamedPreset | null;
      mapping: Partial<CsvMapping> | undefined;
    }
  | {
      kind: 'pdf';
      sheet: Sheet;
      preset: null;
      mapping: Partial<CsvMapping>;
      template: string;
      title: string;
      fee: PdfFee;
      mcc: PdfMcc;
      balances: StatementBalances;
    };

export async function readSheet(
  req: StatementImportRequest,
  sourceType: ImportSourceType,
  preset: NamedPreset | null,
): Promise<ParsedFile> {
  switch (sourceType) {
    case 'xlsx':
      return {
        kind: 'sheet',
        sheet: await readXlsx(req.bytes, (header) => resolveColumns(header, preset, req.mapping)),
        preset,
        mapping: req.mapping,
      };
    case 'csv': {
      const text = decodeCsv(req.bytes);
      const delimiter =
        req.mapping?.delimiter ?? preset?.mapping.delimiter ?? detectDelimiter(text);
      return {
        kind: 'sheet',
        sheet: { rows: parseCsv(text, delimiter), rowLabel: (i) => i + 1 },
        preset,
        mapping: req.mapping,
      };
    }
    case 'pdf': {
      const parsed = await readPdf(req.bytes, PDF_LIMITS);
      // A PDF's columns come from the template that matched, and from nothing the
      // request said. `preset` names header text and `mapping` names columns, and a
      // PDF has neither for them to name. So a chip the user may not remember
      // picking must not decide whether their statement imports.
      return {
        kind: 'pdf',
        sheet: parsed.sheet,
        preset: null,
        mapping: parsed.columns,
        template: parsed.template,
        title: parsed.title,
        fee: parsed.fee,
        mcc: parsed.mcc,
        balances: parsed.balances,
      };
    }
    default: {
      const unreachable: never = sourceType;
      throw new Error(`unhandled source type: ${String(unreachable)}`);
    }
  }
}

interface Columns {
  mapping: CsvMapping;
  readAs: SheetReadAs;
  dateCol: number;
  amountCol: number;
  descCols: number[];
  currencyCol: number;
  /** -1 = the file states no fees, which is every format but a Revolut sheet */
  feeCol: number;
  /** -1 = the file states no running balance, so there is nothing to check against */
  balanceCol: number;
  /** -1 = one running balance for the whole file; only read when balanceCol is not */
  seriesCol: number;
  /** the accepted values folded once here, so the row loop compares and nothing else */
  onlyWhen: { col: number; column: string; accepted: ReadonlySet<string> } | null;
}

type Resolved = { ok: true; columns: Columns } | { ok: false; error: string };

interface Unresolved {
  slot: string;
  tried: readonly string[];
}

/**
 * A preset's candidate lists against one header. A slot the override supplies is not
 * resolved at all: an override is how a user fixes a preset that does not quite fit
 * their file, and reporting the slot it replaces as missing would refuse the very
 * request that carried the fix.
 */
function resolvePreset(
  preset: CsvPresetMapping,
  header: string[],
  override: Partial<CsvMapping> | undefined,
): { mapping: Partial<CsvMapping>; unresolved: Unresolved[] } {
  const unresolved: Unresolved[] = [];
  const match = (slot: string, tried: readonly string[]): string | undefined => {
    const found = matchColumn(header, tried);
    if (found === undefined) unresolved.push({ slot, tried });
    return found;
  };

  const mapping: Partial<CsvMapping> = {
    dateFormat: preset.dateFormat,
    decimal: preset.decimal,
    delimiter: preset.delimiter,
  };
  if (override?.date === undefined) mapping.date = match('date', preset.date);
  if (override?.amount === undefined) mapping.amount = match('amount', preset.amount);
  if (override?.description === undefined) {
    const cols = preset.description.map((names) => match('description', names));
    if (cols.every((c): c is string => c !== undefined)) mapping.description = cols;
  }
  if (preset.currency && override?.currency === undefined) {
    mapping.currency = match('currency', preset.currency);
  }
  if (preset.onlyWhen && override?.onlyWhen === undefined) {
    const column = match('status', preset.onlyWhen.column);
    if (column !== undefined) mapping.onlyWhen = { column, equals: [...preset.onlyWhen.equals] };
  }
  return { mapping, unresolved };
}

/**
 * The fee column, or -1. Resolved from the preset here rather than in resolvePreset,
 * and through neither match() nor colIndex: both record an Unresolved, and a single
 * unresolved slot refuses the whole file, while a Revolut export whose header has no
 * fee column has to import. resolveColumns is also the XLSX header scan's predicate,
 * so a slot that can fail would move which row the scan settles on and every data row
 * would then be read against the wrong columns. There is no header for which this
 * changes the answer resolveColumns gives. currency's shape, one field further from
 * the user: a fee is a preset fact and no request can name one.
 */
function feeColumn(header: string[], preset: CsvPresetMapping | null): number {
  if (!preset?.fee) return -1;
  const name = matchColumn(header, preset.fee);
  return name === undefined ? -1 : header.findIndex((h) => fold(h) === fold(name));
}

/**
 * The running balance column and the one naming its series, or -1 each. feeColumn's
 * shape and for feeColumn's reason, which binds harder here: a Revolut export whose
 * header has no Balance column imports today, and a slot that could refuse a header
 * would also move which row the XLSX header scan settles on.
 *
 * The series column is a refinement and never a precondition: a file that states one
 * running balance and does not say so has one series, which is the correct reading.
 */
function balanceColumns(
  header: string[],
  preset: CsvPresetMapping | null,
): { balanceCol: number; seriesCol: number } {
  const index = (candidates: readonly string[] | undefined): number => {
    if (!candidates) return -1;
    const name = matchColumn(header, candidates);
    return name === undefined ? -1 : header.findIndex((h) => fold(h) === fold(name));
  };
  const balanceCol = index(preset?.balance?.column);
  return { balanceCol, seriesCol: balanceCol < 0 ? -1 : index(preset?.balance?.series) };
}

function resolveColumns(
  header: string[],
  preset: NamedPreset | null,
  override: Partial<CsvMapping> | undefined,
): Resolved {
  const unresolved: Unresolved[] = [];
  let mapping: Partial<CsvMapping> | null = null;
  if (preset) {
    const resolved = resolvePreset(preset.mapping, header, override);
    mapping = resolved.mapping;
    unresolved.push(...resolved.unresolved);
  } else {
    mapping = genericMapping(header);
    if (!mapping && !override?.date) {
      return {
        ok: false,
        error: `could not find date/amount/description columns in the header: ${header.join(', ')}. Set a mapping or pick a preset`,
      };
    }
  }
  // one spread at the top level, so an override's onlyWhen replaces the preset's
  // whole rather than merging field by field: a request naming its own status column
  // must not inherit accepted values that belong to the column it just replaced
  const merged = { ...(mapping ?? {}), ...override };
  // ahead of the malformed-mapping check below, so a preset that simply does not fit
  // the file never reports itself as a mapping the user got wrong
  if (unresolved.length) return { ok: false, error: noColumnMatched(unresolved, header) };

  const { date, amount, description } = merged;
  if (!date || !amount || !description) {
    return { ok: false, error: 'mapping must specify the date, amount and description columns' };
  }
  const effective: CsvMapping = { ...merged, date, amount, description };
  const descNames = Array.isArray(effective.description)
    ? effective.description
    : [effective.description];

  // From `effective` and never from header[dateCol]: the descriptor is built above the
  // unresolved check below, colIndex answers -1 for a slot the header has not got, and
  // this function is also the XLSX header scan's predicate. So header[-1] would make
  // bounded() throw on the first non-header row of every workbook. Bounded here, at the
  // one construction site, so an unbounded ReadColumns never exists as a value.
  const readColumns: ReadColumns = {
    date: bounded(effective.date, COLUMN_NAME_MAX),
    amount: bounded(effective.amount, COLUMN_NAME_MAX),
    description: descNames.map((name) => bounded(name, COLUMN_NAME_MAX)),
  };
  // A preset with an override still reads as the preset: even with all three column
  // slots replaced, the preset is the only source of the fee and balance columns, which
  // a request cannot name at all, and those decide what the totals came to and whether
  // the file reconciled.
  // The names above are the EFFECTIVE ones, so the sentence stays true where the arm
  // is a simplification. On the preset and auto-detected arms a name is the file's own
  // header cell (matchColumn answers header[i]); on request-mapping it is the caller's
  // spelling, which matches the header only up to fold().
  const requested =
    override?.date !== undefined ||
    override?.amount !== undefined ||
    override?.description !== undefined;
  const readAs: SheetReadAs = preset
    ? { kind: 'preset', preset: preset.key, title: preset.title, columns: readColumns }
    : requested
      ? { kind: 'request-mapping', columns: readColumns }
      : { kind: 'auto-detected', columns: readColumns };

  const colIndex = (slot: string, name: string): number => {
    const i = header.findIndex((h) => fold(h) === fold(name));
    if (i < 0) unresolved.push({ slot, tried: [name] });
    return i;
  };
  const columns: Columns = {
    mapping: effective,
    readAs,
    dateCol: colIndex('date', effective.date),
    amountCol: colIndex('amount', effective.amount),
    descCols: descNames.map((name) => colIndex('description', name)),
    currencyCol: effective.currency ? colIndex('currency', effective.currency) : -1,
    feeCol: feeColumn(header, preset?.mapping ?? null),
    ...balanceColumns(header, preset?.mapping ?? null),
    onlyWhen: effective.onlyWhen
      ? {
          col: colIndex('status', effective.onlyWhen.column),
          column: effective.onlyWhen.column,
          accepted: acceptedValues(effective.onlyWhen.equals),
        }
      : null,
  };
  return unresolved.length === 0
    ? { ok: true, columns }
    : { ok: false, error: noColumnMatched(unresolved, header) };
}

const acceptedValues = (equals: string | string[]): ReadonlySet<string> =>
  new Set((Array.isArray(equals) ? equals : [equals]).map(fold));

/**
 * Why the columns could not be filled. Every unresolved slot, not the first: with a
 * list of accepted names per column a header in a language nobody has listed misses
 * four slots at once, and naming one invites the user to fix one name and upload
 * into the same refusal, against a file they cannot edit.
 *
 * The slots and what was tried come first and the header dump last, because the dump
 * is unbounded and error_detail's cap cuts the tail: what the user acts on is the
 * names, not their own header read back to them. Appended whole or not at all, since
 * a truncated dump names columns the file has not got.
 */
function noColumnMatched(unresolved: Unresolved[], header: string[]): string {
  const slots = unresolved
    .map((u) => `${u.slot} (tried ${u.tried.map((n) => `"${n}"`).join(', ')})`)
    .join(', ');
  const head = `no column matched for ${slots}. Pick a different preset or set a mapping`;
  const dump = `; the header reads: ${header.join(', ')}`;
  return head.length + dump.length <= ERROR_DETAIL_MAX ? head + dump : head;
}

type FeeCell = { ok: true; fee: number | null } | { ok: false; text: string };

/**
 * A fee one row of the file stated, and WHICH OF THE TWO THINGS IT IS.
 *
 * A union rather than a number beside a boolean, for the reason TableLayout,
 * AmountCurrency, RowExtent and StatedBalances are unions: a producer cannot state a
 * fee without stating its convention, and applyFee below switches over the lot.
 */
export type StatedFee =
  | { kind: 'not-stated' }
  /** the amount cell is already the movement and the fee sits inside it: every PDF */
  | { kind: 'included'; fee: number }
  /** the bank took it on top, so the movement is amount - fee: a Revolut sheet */
  | { kind: 'on-top'; fee: number };

type StatedFeeCell = { ok: true; fee: StatedFee } | { ok: false; text: string };

const NOT_STATED: StatedFeeCell = { ok: true, fee: { kind: 'not-stated' } };

type FeeSource = PdfFee | { kind: 'on-top'; col: number };

/**
 * The movement and what the source stated, out of ONE switch, so the amount and the
 * fee cannot come to disagree about which convention was applied.
 *
 * Exported for the test, like readSheet and noRowsParsed and for the same reason: the
 * `never` default is worth nothing unless something has watched it throw, and no
 * caller in this file can reach it. Not API surface anyone asked for.
 */
export function applyFee(raw: number, stated: StatedFee): { amount: number; fee: number | null } {
  switch (stated.kind) {
    case 'not-stated':
      return { amount: raw, fee: null };
    case 'included':
      return { amount: raw, fee: stated.fee };
    case 'on-top':
      // In decimals and rounded once, at toCents downstream: subtracting in cents
      // would round twice and change what a sub-cent amount does, which reconcile's
      // "an amount that rounded to zero cents would land on the incoming side" relies
      // on.
      return { amount: raw - stated.fee, fee: stated.fee };
    default: {
      const unreachable: never = stated;
      throw new Error(`unhandled fee convention: ${String(unreachable)}`);
    }
  }
}

declare const refused: unique symbol;

/**
 * WHY a row was not imported, decided where it is known and carried to the sentence
 * whole. Two nullables handed to describeRow instead cannot express "the movement was
 * zero": every zero-movement row would be told that neither of its cells could be
 * read, about cells that had both parsed.
 */
export type RowRefusal =
  | ({ kind: 'unread'; date: string | null; amount: number | null } & {
      readonly [refused]: true;
    })
  | ({ kind: 'no-movement'; stated: StatedFee } & { readonly [refused]: true });

/**
 * And the arm that is not a refusal, which carries the two values out non-null. The
 * verdict decides the row AND narrows date and amount for everything below it. One
 * that answered only the refusals would throw the narrowing away and need a second
 * test to get it back: a predicate written twice, which is the shape of defect
 * RowRefusal removes one level up.
 */
export type RowVerdict =
  | RowRefusal
  | ({ kind: 'import'; date: string; amount: number } & { readonly [refused]: true });

/** The one place this brand is applied, and it is private to this module. */
const refuse = <T>(value: T): T & { readonly [refused]: true } =>
  value as T & { readonly [refused]: true };

/**
 * Whether a row imports and, when it does not, WHY. Both are decided once, where both
 * are known, and carried to the sentence whole.
 *
 * The brand is what makes the ordering below a rule rather than a convention. No
 * other file can build a RowVerdict at all, so no caller can claim `no-movement` for
 * a row whose date or amount never parsed: the nullness test comes first here, once,
 * and the zero arm is reachable only past it. It stops an accident, not a determined
 * caller: `as unknown as RowRefusal` still compiles, which is all `check` claims
 * either.
 *
 * `amount` is the MOVEMENT, after applyFee, and not the cell. Safe because
 * amount === null iff rawAmount === null at the call site: applyFee returns a number
 * on every arm, so the only null is the caller's own rawAmount guard. That equivalence
 * is obvious for exactly as long as applyFee gains no new arm.
 */
export function rowVerdict(
  date: string | null,
  amount: number | null,
  stated: StatedFee,
): RowVerdict {
  if (date === null || amount === null) return refuse({ kind: 'unread', date, amount });
  if (amount === 0) return refuse({ kind: 'no-movement', stated });
  return refuse({ kind: 'import', date, amount });
}

/**
 * What the sheet stated beside the rows it accepted, on its way to reconcile and
 * nowhere else. Not on Sheet, not on ParsedFile's sheet arm, not on NewTransaction
 * and not on a table: these are cells of the file, read
 * by the one loop that builds the transactions and thrown away once the gate has run.
 */
export type StatedBalances =
  | { kind: 'none' }
  | {
      kind: 'stated';
      /** one per element of txs, at the same index */
      rows: readonly StatedRow[];
      /**
       * The series and currency of every row the status filter dropped that stated a
       * balance anyway. The gate covers exactly the rows `onlyWhen` accepts, and that
       * alignment holds only while "has a running balance" and "is accepted" are the
       * same predicate. That was measured true of the real export, whose pending rows
       * leave the cell empty. This is the detector for the day a bank diverges from
       * it, and it is carried per row rather than as a count because a dropped
       * row punches its hole in ONE running balance: which one it names decides
       * whether a break somewhere else in the file is explained by it or not.
       */
      coveredButSkipped: readonly { series: string; currency: string }[];
      unreadable: number;
    };

export interface StatedRow {
  /** the folded series cell, '' when no series column resolved */
  series: string;
  /**
   * And the same cell as the file spelled it, for the refusal to quote. Folding is
   * only for deciding which rows belong to the same running balance, where `Current`
   * and `current` are one series and must not become two. So a folded value may not
   * reach a sentence a person reads beside their own statement. The status values are
   * quoted as the file spelled them too, for the same reason.
   */
  label: string;
  /** the balance stated after this row, in cents; null = empty or unreadable */
  postCents: number | null;
}

/**
 * What the file stated for one accepted row's running balance. An empty cell and an
 * unreadable one are both null and neither refuses the row: a balance cell this
 * parser cannot read costs the check, never the transaction. The text test comes
 * first for readFee's reason.
 */
function readBalance(c: Cell | undefined, decimal: CsvMapping['decimal']): number | null {
  if (!cellText(c).trim()) return null;
  const value = cellAmount(c, decimal);
  return value === null ? null : toCents(value);
}

/**
 * What the file stated for one row's fee. null is "it stated nothing", meaning an
 * empty cell, and never a zero this importer invented. The empty test is on the text
 * and comes first, exactly as the currency column's does, because parseAmount('')
 * answers null and so does a cell full of rubbish.
 *
 * A cell that is there and unreadable refuses the row rather than the file, and a
 * negative one with it: subtracted, it would INCREASE the movement, and no source in
 * this tree states such a thing. Refusing the file instead would leave the user one
 * route: the generic preset, which resolves no fee column at all and would silently
 * import every row of that statement pre-fee. That is the defect this reader exists
 * to remove, so the louder refusal is the one that costs more.
 */
function readFee(c: Cell | undefined, decimal: CsvMapping['decimal']): FeeCell {
  const text = cellText(c).trim();
  if (!text) return { ok: true, fee: null };
  const fee = cellAmount(c, decimal);
  return fee === null || fee < 0 ? { ok: false, text } : { ok: true, fee };
}

/**
 * What the file stated for one row's merchant category code. undefined is "it stated
 * nothing this parser will use", and a cell that is not exactly four digits gets the
 * same answer as an empty one. That is deliberate, and nothing is refused, noted or
 * counted.
 *
 * An MCC is a categorisation hint whose fallback is exactly today's behaviour,
 * categorize(undefined, ...). Refusing a file over one would cost the user their whole
 * import to protect a hint; contrast the fee, which refuses because a misread fee
 * corrupts the movement and no gate can see it. Nothing about an MCC can corrupt money.
 *
 * The rule lives here and not in pdf.ts because "an MCC is four digits" is a fact about
 * MCCs and not about a layout. The day a preset names an MCC column, it is this function
 * that reads that column too. Going through cellText for the same reason: an XLSX column
 * hands over the number 5411 where a CSV hands over '5411', and both are the same input.
 *
 * 0000 is excluded because 0 is not an MCC and a fact column must not carry one this
 * importer invented. A leading-zero code reads as its number: '0742' is 742, which is
 * what that MCC is.
 */
function readMcc(c: Cell | undefined): number | undefined {
  const text = cellText(c).trim();
  if (!/^\d{4}$/u.test(text)) return undefined;
  const mcc = Number(text);
  return mcc === 0 ? undefined : mcc;
}

/**
 * The same cell, tagged with the convention its source declared. Each arm names its
 * own, at the one place that knows it, and an arm added to FeeSource without one is a
 * function that does not return.
 *
 * The `ok: false` arm is the sheet path's, and it is held there rather than read off
 * one template's regex: a PDF's fee cell is a number this parser produced out of the
 * template's own amount format, a fee line that format cannot read refuses the file in
 * pdf.ts before a cell is written, and one it reads as negative is dropped there for
 * the reason written at that drop site. Both of readFee's refusals are unreachable
 * from this arm by a rule and not by coincidence.
 */
function statedFeeOf(
  row: Cell[],
  source: FeeSource,
  decimal: CsvMapping['decimal'],
): StatedFeeCell {
  switch (source.kind) {
    case 'none':
      return NOT_STATED;
    case 'on-top': {
      const read = readFee(row[source.col], decimal);
      if (!read.ok) return read;
      return read.fee === null ? NOT_STATED : { ok: true, fee: { kind: 'on-top', fee: read.fee } };
    }
    case 'included': {
      const read = readFee(row[source.col], decimal);
      if (!read.ok) return read;
      return read.fee === null
        ? NOT_STATED
        : { ok: true, fee: { kind: 'included', fee: read.fee } };
    }
  }
}

/**
 * Which bucket a dropped row falls in, as the user reads the cause. A kind is added
 * here only if one sentence stays true of every site that names it.
 */
type DropKind = 'unreadable' | 'filtered' | 'noMovement';

/**
 * Where each refusal lands. A new RowRefusal kind does not compile until it names a
 * bucket. But the failure this table really guards against is the WRONG mapping, not
 * the missing one. `unread: 'noMovement'` type-checks, keeps `skipped` exact, and
 * empties the clause balanceBreaks composes about the lines this importer could not
 * read. That clause is the one sentence that tells a user where their missing money
 * went.
 */
const DROP_OF: Record<RowRefusal['kind'], DropKind> = {
  unread: 'unreadable',
  'no-movement': 'noMovement',
};

async function mapAndStore(
  req: StatementImportRequest,
  parsed: ParsedFile,
  account: StagedAccount,
  importId: string,
  fileHash: string,
): Promise<StatementImportResult> {
  const { sheet, preset } = parsed;
  if (sheet.rows.length === 0) throw new Error(NO_TRANSACTIONS);

  const header = sheet.rows[0].map((c) => cellText(c).trim());
  const resolved = resolveColumns(header, preset, parsed.mapping);
  if (!resolved.ok) throw new Error(resolved.error);
  // after the header resolves: a lone line that does not is a transaction with no header
  // above it, and telling that file it has no transactions would be false
  if (sheet.rows.length < 2) throw new Error(NO_TRANSACTIONS);
  const {
    mapping,
    dateCol,
    amountCol,
    descCols,
    currencyCol,
    feeCol,
    balanceCol,
    seriesCol,
    onlyWhen,
  } = resolved.columns;

  // Which reader the summary names. `req` is deliberately unread on the pdf arm: the
  // chip persists across files and a PDF's outcome does not depend on it, so
  // a descriptor built from the request would state, in the one place the user is asked
  // to trust, something the parser did not do.
  //
  // And resolveColumns HAS answered a SheetReadAs here, even on the pdf path: readSheet
  // hands the mapper a synthetic pdf:date/pdf:amount/pdf:description header, which comes
  // out as request-mapping. That value is dropped by this switch on purpose: those three
  // strings are this importer's own invented words, not the document's. Deleting the
  // switch and taking resolved.columns.readAs compiles, keeps every PDF summary equal to
  // every other, and prints them at the user.
  const readAs: ReadAs = ((): ReadAs => {
    switch (parsed.kind) {
      case 'pdf':
        return { kind: 'pdf-template', title: parsed.title };
      case 'sheet':
        return resolved.columns.readAs;
      default: {
        const unreachable: never = parsed;
        throw new Error(`unhandled parsed file: ${String(unreachable)}`);
      }
    }
  })();

  // Which cell states a fee and on which convention, resolved once from the producer
  // that knows. A PDF's is a fact about the layout its template read; a sheet's is a
  // preset's, and a request can name neither.
  const feeSource: FeeSource = ((): FeeSource => {
    switch (parsed.kind) {
      case 'pdf':
        return parsed.fee;
      case 'sheet':
        return feeCol >= 0 ? { kind: 'on-top', col: feeCol } : { kind: 'none' };
      default: {
        const unreachable: never = parsed;
        throw new Error(`unhandled parsed file: ${String(unreachable)}`);
      }
    }
  })();

  // and which column that was, for the sentence to quote: the cell the arithmetic
  // read, never resolveColumns's feeCol, which on the pdf path names a header this
  // importer invented
  const statedFeeCol = feeSource.kind === 'none' ? -1 : feeSource.col;

  // Which cell states a merchant category code, feeSource's shape and for its reason.
  // The sheet arm is 'none' because no preset declares an MCC column yet. The bank whose
  // PDF template reads an MCC prints one in its CSV exports too, but none of them is
  // importable at all today. So a CsvPresetMapping.mcc built here would be a field with
  // no preset to read it.
  const mccSource: PdfMcc = ((): PdfMcc => {
    switch (parsed.kind) {
      case 'pdf':
        return parsed.mcc;
      case 'sheet':
        return { kind: 'none' };
      default: {
        const unreachable: never = parsed;
        throw new Error(`unhandled parsed file: ${String(unreachable)}`);
      }
    }
  })();

  const total = sheet.rows.length - 1;
  if (total > MAX_DATA_ROWS) {
    throw new Error(
      `the statement has ${total} data rows, more than the ${MAX_DATA_ROWS} this importer reads in one file. Split it and upload the parts`,
    );
  }

  // Pairs rather than two arrays, and txs is derived from them below: what the gate
  // checks and what the file stated beside it are read in one loop and cannot come
  // apart by an index.
  const accepted: { tx: NewTransaction; day: CalendarDay; stated: StatedRow }[] = [];
  // a notice is a fact about the file, not a rejected row: it goes in front of the
  // row problems and touches no count. The two are kept apart so that neither has to
  // be recovered from the other by index: an extra notice would silently make
  // problems[0] the wrong kind of sentence
  const notices = sheet.notices ?? [];
  const rowProblems: string[] = [];
  // what the status filter dropped, by the value the file wrote: a half-recognised
  // vocabulary otherwise produces a partial import that reads as a complete one
  const statusSkips = new Map<string, number>();
  const coveredButSkipped: { series: string; currency: string }[] = [];
  // One tally, and `skipped` derived from it after the loop rather than incremented
  // beside it: there is no mutable total in scope while the loop runs, so a drop site
  // reaches the count only through `drop` and only by naming its bucket. A row the
  // status filter took and a row dropped for a zero movement were both read perfectly,
  // and a refusal naming either as a line it could not read names a cause that is not
  // the cause
  const dropped: Record<DropKind, number> = { unreadable: 0, filtered: 0, noMovement: 0 };
  const drop = (kind: DropKind): void => {
    dropped[kind]++;
  };
  const statedCurrency = (row: Cell[]): string =>
    currencyCol >= 0 ? cellText(row[currencyCol]).trim() : '';
  // read the same way for a row that is dropped as for one that is kept: the two have
  // to agree on which running balance a row belongs to, and a dropped row that read
  // its currency differently would name a run that does not exist
  const rowCurrency = (row: Cell[]): string =>
    currencyKey(statedCurrency(row) || account.currency);

  for (let i = 1; i < sheet.rows.length; i++) {
    const row = sheet.rows[i];
    // first in the loop and it must stay there: the rows this drops are the ones the
    // bank has not finished, and their date cell is empty. Filtered later, each of
    // them would spend a MAX_PROBLEMS slot on a date it was never going to have.
    //
    // A row is kept only if its folded value IS in the accepted set. The inverted
    // rule, skipping the known-pending values, would import every reverted, declined
    // and pending row shipped in a language nobody has listed yet, as money that
    // never moved.
    if (onlyWhen) {
      const value = cellText(row[onlyWhen.col]).trim();
      if (!onlyWhen.accepted.has(fold(value))) {
        drop('filtered');
        statusSkips.set(value, (statusSkips.get(value) ?? 0) + 1);
        // recorded and nothing more: no sentence, no MAX_PROBLEMS slot, and the filter
        // stays first in the loop. A row the bank has not finished which nevertheless
        // states a balance means the balance column covers a row this import drops, so
        // the running balance it names has a hole in it that is not missing money
        if (balanceCol >= 0 && cellText(row[balanceCol]).trim()) {
          coveredButSkipped.push({
            series: seriesCol >= 0 ? fold(cellText(row[seriesCol])) : '',
            currency: rowCurrency(row),
          });
        }
        continue;
      }
    }
    const date = cellDate(row[dateCol], mapping.dateFormat, sheet.date1904);
    const rawAmount = cellAmount(row[amountCol], mapping.decimal);
    // read only for a row that would otherwise import: one already refused for its
    // date or its amount keeps the sentence it has always had
    const statedFee: StatedFeeCell =
      date !== null && rawAmount !== null
        ? statedFeeOf(row, feeSource, mapping.decimal)
        : NOT_STATED;
    if (!statedFee.ok) {
      drop('unreadable');
      if (notices.length + rowProblems.length < MAX_PROBLEMS) {
        rowProblems.push(feeRefused(sheet, i, statedFee.text));
      }
      continue;
    }
    // The amount is the movement of the account: what the statement's own running
    // balance moves by, fees included. That is what it means for CSV, XLSX and PDF
    // alike. The two paths reach it from opposite directions, which is why the
    // arithmetic is applyFee's and not written out here. A sheet states the fee on top
    // and the movement is the cell minus it; a PDF prints the movement already and the
    // fee is a second reading of the same charge. One call, both outputs, so no site
    // can subtract twice or store a fee against an amount it was not taken from.
    const { amount, fee } =
      rawAmount === null ? { amount: null, fee: null } : applyFee(rawAmount, statedFee.fee);
    const verdict = rowVerdict(date, amount, statedFee.fee);
    if (verdict.kind !== 'import') {
      drop(DROP_OF[verdict.kind]);
      if (notices.length + rowProblems.length < MAX_PROBLEMS) {
        const cols = { dateCol, amountCol, feeCol: statedFeeCol };
        rowProblems.push(describeRow(sheet, i, cols, verdict));
      }
      continue;
    }
    const day = calendarDay(verdict.date.slice(0, 10));
    if (day === null || calendarDay(verdict.date) === null) {
      throw new Error(notADate(sheet, i, row[dateCol], day === null ? 'day' : 'time'));
    }
    const description = descCols
      .map((c) => cellText(row[c]).trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ');
    // Only a currency the file states. The account's own, taken for an empty cell, is
    // not checked: an earlier version may have stored one this pattern refuses, and
    // refusing it would refuse every file without a currency column for that account.
    const stated = statedCurrency(row);
    if (stated && !CURRENCY_CODE.test(stated)) {
      throw new Error(notACurrency(sheet, i, row[currencyCol]));
    }
    const currency = rowCurrency(row);
    // One local, two uses, in one edit. The column and the argument to categorize have
    // to be the same value: reclassifyAll recomputes the category from the stored mcc
    // on every production path, so a row stored with a category no rule produces is one
    // that two sites disagree about, even on a path that never reclassifies.
    const mcc = mccSource.kind === 'none' ? undefined : readMcc(row[mccSource.col]);

    accepted.push({
      day,
      tx: {
        accountId: account.id,
        provider: 'upload',
        amount: verdict.amount,
        currency,
        date: verdict.date,
        description,
        mcc,
        category: categorize(mcc, description, verdict.amount),
        fee,
      },
      stated: {
        series: seriesCol >= 0 ? fold(cellText(row[seriesCol])) : '',
        label: seriesCol >= 0 ? cellText(row[seriesCol]).trim() : '',
        postCents: balanceCol >= 0 ? readBalance(row[balanceCol], mapping.decimal) : null,
      },
    });
  }

  const txs = accepted.map((a) => a.tx);
  // reduced rather than summed term by term: a fourth DropKind joins the total here on
  // the day it is declared, where a three-term sum would compile and leave it out
  const skipped = Object.values(dropped).reduce((a, b) => a + b, 0);
  // The last hole `drop` cannot close: a continue added later that counts nothing at
  // all. It can fire only on a bug in this file, never on a cell of the user's, and it
  // is what makes the card's own "Read N of M rows" true rather than merely consistent
  // with the counts printed under it.
  if (txs.length + skipped !== total) {
    throw new Error(
      `internal: ${total} rows read as ${txs.length} accepted and ${skipped} dropped`,
    );
  }
  const status: StatusSkips | null =
    onlyWhen && statusSkips.size
      ? { column: onlyWhen.column, counts: statusSkips, skipped: dropped.filtered }
      : null;

  if (txs.length === 0) {
    throw new Error(noRowsParsed(skipped, rowProblems, notices, status));
  }

  // Ahead of the staging, so a statement that will be refused stages nothing. And
  // here rather than at confirm, because confirm inserts a subset: an overlapping
  // statement's rows are already present and are skipped. A gate re-run there would
  // refuse every legitimate overlapping import, which is the common case.
  const reconciled = reconcile(
    parsed,
    txs,
    skipped,
    balanceCol < 0
      ? { kind: 'none' }
      : {
          kind: 'stated',
          rows: accepted.map((a) => a.stated),
          coveredButSkipped,
          unreadable: dropped.unreadable,
        },
  );

  // Staged as uploadDestination handed it back, not re-uppercased: this IS the
  // account's own column read back, and normalising it would put a restored 'eur'
  // onto the imports row as 'EUR' on an import that asked for nothing of the kind.
  const newRows = await countNewKeys(txs);
  await stageImport(importId, txs, skipped, account);
  // Last, and after the staging rather than before it: a failure anywhere above must
  // not have taken the outstanding import the user is still looking at with it. The
  // reverse order is the one that costs something. Two staged copies of one file
  // coexist safely, while a discarded original and no replacement is a summary the
  // user lost.
  //
  // "Safely" is load-bearing and it is not free: it holds because the supersede is
  // strictly one-directional (see supersedeStagedImports). Discarding any *other*
  // outstanding copy is symmetric, so two uploads racing would each take the other
  // and leave nothing confirmable at all. With only an older one taken, the worst
  // case is two confirmable copies, and the second confirm meets
  // imports_file_hash_unique and answers 409 rather than importing anything twice.
  const superseded = await supersedeStagedImports(fileHash, importId);

  const days = accepted.map((a) => a.day).sort();
  return {
    outcome: 'awaiting_confirmation',
    summary: {
      importId,
      accountId: account.id,
      accountName: account.name,
      total,
      accepted: txs.length,
      skipped,
      // spread, not three transcribed fields: the tally and the wire cannot come apart,
      // and a fourth kind reaches the response rather than being dropped in silence
      ...dropped,
      // the status aggregate sits ahead of the row problems and inside the few the
      // client renders. A further per-row reason refines a picture the user already
      // has, while the aggregate, which says rows were dropped and names the values
      // that did it, is the only line saying the import is partial at all. The cut
      // cannot reach a notice, because no sheet produces more than one
      problems: [
        ...notices,
        ...(status ? [`${rowCount(status.skipped)} skipped: ${statusReason('the', status)}`] : []),
        ...rowProblems,
      ].slice(0, MAX_PROBLEMS),
      newRows,
      alreadyPresent: txs.length - newRows,
      from: days[0],
      to: days[days.length - 1],
      totals: reconciled.totals,
      readAs,
      ...(reconciled.balances ? { balances: reconciled.balances } : {}),
      ...(reconciled.balancesNotShown ? { balancesNotShown: reconciled.balancesNotShown } : {}),
      ...(superseded[0] ? { supersededImportId: superseded[0] } : {}),
    },
  };
}

/**
 * How many codes a refusal names before it counts the rest, and what one may spend.
 * They exist because the sentence below carries four amounts and up to four codes and
 * is asserted against ERROR_DETAIL_MAX: an assertion over a value nothing bounds is an
 * assertion about the day it was written.
 *
 * The code bound is exported for exactly that assertion, which builds its codes FROM it
 * rather than beside it: a literal wide enough today stops reaching the bound the moment
 * the bound is raised, and the assertion then goes on passing over a sentence that has
 * grown past what error_detail keeps.
 */
const CURRENCY_LIST_MAX = 3;
export const CURRENCY_CODE_MAX = 6;

const currencyList = (codes: string[]): string => {
  const shown = codes.slice(0, CURRENCY_LIST_MAX).map((c) => bounded(c, CURRENCY_CODE_MAX));
  const rest = codes.length - shown.length;
  return rest ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
};

const lineCount = (n: number): string => `${n} transaction line${n === 1 ? '' : 's'}`;

/**
 * How a statement's own amounts are written back to the person holding it. A dot and
 * an ISO code, not the document's own separator: the layout's decimal convention is
 * a fact about the template, which this module cannot see and the next template will
 * spell differently.
 */
const money = (cents: number, currency: string): string =>
  `${fromCents(cents).toFixed(2)} ${bounded(currency, CURRENCY_CODE_MAX)}`;

const doesNotAddUp = (
  title: string,
  balances: StatementBalances,
  net: number,
  accepted: number,
  skipped: number,
): string => {
  const { openingCents, closingCents, currency } = balances;
  const cause = skipped
    ? `, and the ${lineCount(skipped)} this importer could not read are probably where it went`
    : ', so an operation is probably missing';
  return `this ${title} statement does not add up: its opening balance of ${money(openingCents, currency)} plus the ${lineCount(accepted)} read comes to ${money(openingCents + net, currency)}, where the statement's own closing balance is ${money(closingCents, currency)}, a difference of ${money(Math.abs(openingCents + net - closingCents), currency)}${cause}. Export the same statement as CSV or Excel (.xlsx) from your online banking and upload that`;
};

/**
 * It fires only when the ends match and the halves do not, and the wording leads with
 * that: a single dropped row fails both checks, and the net one runs first because it
 * names the missing amount where this one names a discrepancy in a subtotal. So the
 * only thing left for this sentence is the compensating pair: money out and money in
 * that the parser never saw, cancelling into a clean net.
 *
 * All four figures, signed, rather than the two differences: which side to look at in
 * the document is what the person holding it needs, and a magnitudes-only sentence
 * under a backwards `signs` declaration would print the same number twice and read as
 * a refusal naming two identical figures. "of the same size" is exact rather than a
 * hedge. The net matched, so the two shortfalls are equal by arithmetic.
 */
const sidesDoNotAddUp = (
  title: string,
  printed: { outgoingCents: number; incomingCents: number },
  outCents: number,
  inCents: number,
  currency: string,
  accepted: number,
  skipped: number,
): string => {
  const cause = skipped
    ? `, and the ${lineCount(skipped)} this importer could not read are probably where they went`
    : ', so an operation out and an operation in of the same size are probably both missing';
  return `this ${title} statement's opening and closing balance agree, but its two halves do not: it states ${money(printed.outgoingCents, currency)} out and ${money(printed.incomingCents, currency)} in, where the ${lineCount(accepted)} read come to ${money(outCents, currency)} out and ${money(inCents, currency)} in${cause}. Export the same statement as CSV or Excel (.xlsx) from your online banking and upload that`;
};

const mixedCurrencies = (title: string, currency: string, found: string[]): string =>
  `this ${title} statement states its balances in ${bounded(currency, CURRENCY_CODE_MAX)}, but the lines read are in ${currencyList(found)}. This importer cannot check a statement that mixes currencies. Export the same statement as CSV or Excel (.xlsx) from your online banking and upload that`;

/**
 * One accepted row as an edge of the running balance it belongs to: the balance the
 * file states after it, and the one it must have had before, which the file does not
 * state and which is `post - movement`.
 */
interface Link {
  preCents: number;
  postCents: number;
}

interface RunningBalance {
  /** the series as the file spelled it, taken from the row that opened the run */
  label: string;
  currency: string;
  /** an accepted row of this one stated no balance this parser could read */
  incomplete: boolean;
  /** in the file's own order, which the verdict never reads and the diagnostic does */
  links: Link[];
}

/**
 * Which running balance a row belongs to: the series the file names AND the row's
 * currency. Built here for both the accepted rows and the skipped ones that stated a
 * balance, so the two cannot be keyed differently and quietly stop meeting.
 */
const runKey = (series: string, currency: string): string => `${series}\u0000${currency}`;

/** `circuit` is unbroken and endpointless; `broken` is the one that refuses. */
type Verdict =
  | { kind: 'path'; openingCents: number; closingCents: number }
  | { kind: 'circuit' }
  | { kind: 'broken' };

/**
 * Whether the links of one running balance form a single unbroken run of it.
 *
 * The property is an Eulerian path over the balance VALUES, and stating it that way
 * is what makes it order-independent rather than order-independent by convention: a
 * complete series has every link in one connected component, exactly one value with
 * one more link leaving it than entering (the opening) and exactly one with one more
 * entering than leaving (the closing). Degrees and components are multiset facts, so
 * a permutation of the file's rows, such as a bank exporting newest-first, gives the
 * same verdict and the same pair.
 *
 * Removing an interior row splits the run in two, which shows up as a second
 * component and as a second value with an excess. That is the whole content of the
 * check, and it is deliberately NOT `opening + net = closing`: over endpoints derived
 * from these same rows that is an identity and holds however many rows are missing.
 *
 * It is blind at the ENDS, and the blindness is structural: losing the first or last
 * row of a run does not break it but moves where it starts or stops. That is why the
 * confirmation screen may claim the run and may not claim the statement is complete.
 *
 * Connectivity is load-bearing rather than decoration: 100->110, 110->130 plus a
 * detached 500->600, 600->500 has exactly the degrees of one unbroken run and is two
 * runs.
 *
 * A row whose movement rounds to zero cents needs no special case and gets none: its
 * pre equals its post, so it is a self-loop, which changes no degree and joins no two
 * values. Dropping it, as the `amount === 0` guard does, leaves the run intact.
 */
function runsAsOne(links: readonly Link[]): Verdict {
  const out = new Map<number, number>();
  const into = new Map<number, number>();
  const parent = new Map<number, number>();
  const find = (v: number): number => {
    let root = v;
    for (let p = parent.get(root); p !== undefined && p !== root; p = parent.get(root)) root = p;
    for (let n = v; n !== root; ) {
      const next = parent.get(n) ?? n;
      parent.set(n, root);
      n = next;
    }
    return root;
  };
  for (const { preCents, postCents } of links) {
    out.set(preCents, (out.get(preCents) ?? 0) + 1);
    into.set(postCents, (into.get(postCents) ?? 0) + 1);
    if (!parent.has(preCents)) parent.set(preCents, preCents);
    if (!parent.has(postCents)) parent.set(postCents, postCents);
    const a = find(preCents);
    const b = find(postCents);
    if (a !== b) parent.set(a, b);
  }

  const excessOut: number[] = [];
  const excessIn: number[] = [];
  let wild = false;
  for (const value of parent.keys()) {
    const degree = (out.get(value) ?? 0) - (into.get(value) ?? 0);
    if (degree === 1) excessOut.push(value);
    else if (degree === -1) excessIn.push(value);
    else if (degree !== 0) wild = true;
  }
  const roots = new Set([...parent.keys()].map(find));
  if (wild || excessOut.length > 1 || roots.size > 1) return { kind: 'broken' };
  // balanced everywhere: the run is provably unbroken and the balances alone cannot
  // say which value it starts at. Nothing here says money is missing
  if (excessOut.length === 0) return { kind: 'circuit' };
  return { kind: 'path', openingCents: excessOut[0], closingCents: excessIn[0] };
}

/**
 * Where the run breaks, in the file's own order, or undefined.
 *
 * The verdict above is order-independent and this is not, deliberately: what a person
 * holding the statement needs is two lines they can find. Reached only for a run the
 * verdict already called broken, and a break always exists there: a run whose every
 * adjacent pair links is a single walk, and a walk is an Eulerian path or a circuit,
 * neither of which is broken. The undefined arm is what stops that argument being
 * load-bearing at runtime; balanceBreaks below composes a true sentence without it.
 */
function firstBreak(links: readonly Link[]): { before: Link; after: Link } | undefined {
  for (let i = 1; i < links.length; i++) {
    if (links[i].preCents !== links[i - 1].postCents) {
      return { before: links[i - 1], after: links[i] };
    }
  }
  return undefined;
}

export const balanceBreaks = (
  label: string,
  currency: string,
  at: { before: Link; after: Link } | undefined,
  unreadable: number,
): string => {
  const where = label ? ` in "${bounded(label, SERIES_QUOTE_MAX)}"` : '';
  const cause = unreadable
    ? `, and the ${lineCount(unreadable)} this importer could not read are probably where it went`
    : ', so an operation is probably missing';
  const head = at
    ? `this statement's own running balance breaks:${where} the line stating ${money(at.after.postCents, currency)} does not follow the one stating ${money(at.before.postCents, currency)}, and ${money(Math.abs(at.after.preCents - at.before.postCents), currency)} is unaccounted for between them`
    : `this statement's own running balance breaks: the lines read${where} do not form one unbroken run`;
  return `${head}${cause}. Export the same statement again from your online banking and upload it`;
};

/**
 * The sheet arm's verdict for the whole file, per running balance and then over all
 * of them.
 *
 * A run this importer cannot use is never examined for a break at all, and that is what
 * keeps a file the parser reads imperfectly from being refused for it. Both ways it
 * happens take their hole out of ONE run and leave its links a subset by construction:
 * a balance cell this parser could not read is a link it never built, and a row the
 * status filter dropped is a step of that series the gate never sees. What is left of
 * either run breaks, and the break is ours rather than the file's. A locale whose
 * balances this `decimal` setting misreads, and a bank that prints a running balance on
 * its pending rows, are the files that live there. Both import today and must keep
 * importing, and neither may cost a refusal on the one path with nowhere further to
 * fall back to.
 *
 * Everything past the loop is only whether a pair can honestly be shown.
 */
function checkSheet(running: Map<string, RunningBalance>, stated: StatedBalances): SheetBalances {
  if (stated.kind === 'none') return { kind: 'none' };
  const coveredRuns = new Set(stated.coveredButSkipped.map((c) => runKey(c.series, c.currency)));
  // a dropped row naming a running balance that no accepted row belongs to has no run
  // to disarm. But "has a balance" and "is accepted" have still come apart, and that is
  // the fact the discriminator exists to carry
  let covered = [...coveredRuns].some((key) => !running.has(key));

  // `links` rides along because how much of the run the verdict could have failed on is
  // a fact about the run and is gone by the time the pairs are summed
  const pairs: {
    openingCents: number;
    closingCents: number;
    currency: string;
    links: number;
  }[] = [];
  let incomplete = false;
  let circuit = false;
  for (const [key, run] of running) {
    if (run.incomplete) {
      incomplete = true;
      continue;
    }
    if (coveredRuns.has(key)) {
      covered = true;
      continue;
    }
    const verdict = runsAsOne(run.links);
    if (verdict.kind === 'broken') {
      throw new Error(
        balanceBreaks(run.label, run.currency, firstBreak(run.links), stated.unreadable),
      );
    }
    if (verdict.kind === 'circuit') circuit = true;
    else pairs.push({ ...verdict, currency: run.currency, links: run.links.length });
  }
  if (incomplete) return { kind: 'unusable', reason: 'rows-without-a-balance' };
  if (covered) return { kind: 'unusable', reason: 'rows-outside-the-balance' };
  // one run with no endpoints leaves the sum without them too, and a pair summed over
  // the rest would be a pair of a part of the statement presented as the whole
  if (circuit || pairs.length === 0) {
    return { kind: 'unusable', reason: 'balance-closes-on-itself' };
  }
  const currencies = new Set(pairs.map((p) => p.currency));
  if (currencies.size !== 1) return { kind: 'unusable', reason: 'more-than-one-currency' };
  // Both counts are defined here and at no other exit, which is what makes them agree
  // about their denominator. Every exit above is a whole-file one: one incomplete,
  // covered or endpointless run takes the entire file to `unusable`. So by the time
  // this returns, every run produced exactly one pair and every pair is a path. A
  // circuit is in neither number because a circuit never reaches here at all.
  return {
    kind: 'checked',
    openingCents: pairs.reduce((sum, p) => sum + p.openingCents, 0),
    closingCents: pairs.reduce((sum, p) => sum + p.closingCents, 0),
    currency: pairs[0].currency,
    series: { summed: pairs.length, checked: pairs.filter((p) => p.links > 1).length },
  };
}

/**
 * The states a sheet's balances can be in, and there is no other:
 * "this file states no running balance" and "it stated one and it could not be used"
 * are different variants. Collapsing the second into the first cannot happen by
 * omission, only by being written out, and the exhaustive switch below makes a state
 * added here a `tsc` error rather than a review finding.
 */
type SheetBalances =
  | { kind: 'none' }
  | {
      kind: 'checked';
      openingCents: number;
      closingCents: number;
      currency: string;
      series: SeriesCounts;
    }
  | { kind: 'unusable'; reason: BalancesNotShown };

/**
 * The net movement of the file per currency. For a format that states its own
 * balances, also the check that the rows actually run from the opening one to the
 * closing one, and that each half of them comes to what the document printed for it.
 *
 * Summed in minor units rather than decimals for the reason money.ts gives, and here
 * it is not theoretical: a real statement's amounts summed as decimals miss its
 * closing balance by a fraction of a cent, and an exact comparison refuses that.
 * Exactly, with no tolerance anywhere: one cent of slack hides a systematically
 * dropped fee on a small statement and lets a drifted template import plausible
 * numbers, which is the one outcome worse than refusing.
 *
 * `stated` is required and not optional at the call site: an optional
 * one forgotten at a sheet caller reads as "this format states no balances", which is
 * exactly the collapse SheetBalances exists to prevent. The pdf path passes
 * `{ kind: 'none' }`, which is true of it because the sheet mapper stated nothing for
 * a PDF, and the pdf arm never looks at it.
 *
 * Exported for the test, like readSheet and noRowsParsed and for the same reason:
 * every template declares one currency, so the mixed-currency arm is unreachable
 * through a template and nothing else can watch it throw.
 */
export function reconcile(
  parsed: ParsedFile,
  txs: NewTransaction[],
  skipped: number,
  stated: StatedBalances,
): { totals: CheckedTotals; balances?: CheckedBalances; balancesNotShown?: BalancesNotShown } {
  // The two are aligned by index and by nothing else, and the failure of that is
  // silent in the direction that matters: a caller that filters `txs` between building
  // the pairs and calling this builds every link from the wrong row's balance and the
  // gate then refuses good files or passes broken ones without ever indexing past the
  // end. A length is the cheapest thing that can be true here, so it is checked.
  if (stated.kind === 'stated' && stated.rows.length !== txs.length) {
    throw new Error('stated balances and transactions are not the same length');
  }
  const cents = new Map<string, number>();
  // the file's own two halves, out of the same loop as the net for the reason above.
  // Currency-blind, which is safe only because the pdf arm below refuses unless there
  // is exactly one currency and it is the balances'. That is said here rather than
  // there because this is where the fact is relied on.
  //
  // Two branches and not three: a row whose amount is 0 is skipped before it ever
  // becomes a transaction, and an amount that rounded to zero cents would land on the
  // incoming side adding nothing to it. There is no case for a guard to catch.
  let outCents = 0;
  let inCents = 0;
  // and the file's own running balances out of it too, for the same reason: the
  // movement every link is built from is the toCents this loop already computed, so
  // the number the gate checks and the number the user reads cannot drift
  const running = new Map<string, RunningBalance>();
  for (let i = 0; i < txs.length; i++) {
    const t = txs[i];
    const c = toCents(t.amount);
    cents.set(t.currency, (cents.get(t.currency) ?? 0) + c);
    if (c < 0) outCents += c;
    else inCents += c;
    if (stated.kind === 'none') continue;
    // series AND currency: a Revolut pocket per currency carries its own running
    // balance under one Product, and keying on the product alone would interleave two
    // of them into one chain and refuse a file that imports today. It cannot split a
    // bank that keeps one converted balance across currencies by accident, because the
    // balance column is preset-declared and nothing guesses it
    const row = stated.rows[i];
    const key = runKey(row.series, t.currency);
    let run = running.get(key);
    if (!run) {
      run = { label: row.label, currency: t.currency, incomplete: false, links: [] };
      running.set(key, run);
    }
    if (row.postCents === null) run.incomplete = true;
    else run.links.push({ preCents: row.postCents - c, postCents: row.postCents });
  }
  const totals = check(
    [...cents.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, sum]) => ({ currency, net: fromCents(sum) })),
  );

  switch (parsed.kind) {
    case 'sheet': {
      const sheet = checkSheet(running, stated);
      switch (sheet.kind) {
        case 'none':
          return { totals };
        case 'unusable':
          return { totals, balancesNotShown: sheet.reason };
        case 'checked':
          return {
            totals,
            balances: check({
              opening: fromCents(sheet.openingCents),
              closing: fromCents(sheet.closingCents),
              currency: sheet.currency,
              series: sheet.series,
            }),
          };
        default: {
          const unreachable: never = sheet;
          throw new Error(`unhandled sheet balances: ${String(unreachable)}`);
        }
      }
    }
    case 'pdf': {
      const { balances, title } = parsed;
      const net = cents.get(balances.currency);
      if (net === undefined || cents.size !== 1) {
        throw new Error(mixedCurrencies(title, balances.currency, [...cents.keys()].sort()));
      }
      if (balances.openingCents + net !== balances.closingCents) {
        throw new Error(doesNotAddUp(title, balances, net, txs.length, skipped));
      }
      // Second, and never first: a single dropped row fails both, and the sentence
      // above names the missing amount where this one names a discrepancy in a
      // subtotal. Reordering these hands the common case the weaker diagnostic.
      if (balances.gross.kind === 'printed') {
        const { outgoingCents, incomingCents } = balances.gross;
        if (outgoingCents !== outCents || incomingCents !== inCents) {
          throw new Error(
            sidesDoNotAddUp(
              title,
              balances.gross,
              outCents,
              inCents,
              balances.currency,
              txs.length,
              skipped,
            ),
          );
        }
      }
      return {
        totals,
        balances: check({
          opening: fromCents(balances.openingCents),
          closing: fromCents(balances.closingCents),
          currency: balances.currency,
        }),
      };
    }
    default: {
      const unreachable: never = parsed;
      throw new Error(`unhandled parsed file: ${String(unreachable)}`);
    }
  }
}

export interface StatusSkips {
  column: string;
  counts: Map<string, number>;
  skipped: number;
}

const rowCount = (n: number): string => `${n} row${n === 1 ? '' : 's'}`;

const bounded = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** A cell as the file spelled it, at the width CELL_QUOTE_MAX derives. */
const quote = (c: Cell | undefined): string => `"${bounded(cellText(c), CELL_QUOTE_MAX)}"`;

function statusReason(lead: string, status: StatusSkips): string {
  const entries = [...status.counts.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([value, n]) => `"${bounded(value, STATUS_QUOTE_MAX)}" (${n})`);
  return `${lead} "${bounded(status.column, STATUS_QUOTE_MAX)}" value is not an accepted one. Found: ${statusList(entries)}`;
}

function statusList(entries: string[]): string {
  let out = entries[0];
  for (let i = 1; i < entries.length; i++) {
    const rest = entries.length - i - 1;
    const next = `${out}, ${entries[i]}`;
    if (next.length + (rest ? ` and ${rest} more`.length : 0) > STATUS_LIST_MAX) {
      return `${out} and ${entries.length - i} more`;
    }
    out = next;
  }
  return out;
}

export function noRowsParsed(
  skipped: number,
  rowProblems: string[],
  notices: string[],
  status: StatusSkips | null,
): string {
  const reason =
    status && status.skipped === skipped ? statusReason("every row's", status) : rowProblems[0];
  const head = `no row could be parsed (${skipped} skipped)${reason ? ': ' + reason : ''}`;
  const sentences = notices.map((n) => n.charAt(0).toUpperCase() + n.slice(1));
  const notice = notices.length ? `. ${sentences.join('. ')}` : '';
  return head.length + notice.length <= ERROR_DETAIL_MAX ? head + notice : head;
}

/**
 * Exported for the test, like readSheet and applyFee and for the same reason: neither
 * `never` below is worth anything unless something has watched it throw, and the
 * lengths this composes are bounded by an assertion rather than by a type, so that
 * assertion has to be able to reach every arm. Not API surface anyone asked for.
 *
 * `feeCol` is the column statedFeeOf actually read, not resolveColumns's. On the PDF
 * path the latter is the synthetic header's, and quoting it would name a column the
 * document has not got.
 */
export function describeRow(
  sheet: Sheet,
  i: number,
  cols: { dateCol: number; amountCol: number; feeCol: number },
  refusal: RowRefusal,
): string {
  const label = sheet.rowLabel(i);
  const row: Cell[] = sheet.rows[i];
  const { dateCol, amountCol, feeCol } = cols;

  switch (refusal.kind) {
    case 'unread': {
      if (refusal.date === null) {
        const note = sheet.note?.(i, dateCol);
        if (note) return `row ${label}: the date cell ${note}`;
        if (typeof row[dateCol] === 'number') {
          return `row ${label}: the date cell holds the number ${bounded(String(row[dateCol]), CELL_QUOTE_MAX)}, which this parser will not read as a date. Format that column as a date, and upload again`;
        }
      }
      if (refusal.amount === null) {
        const note = sheet.note?.(i, amountCol);
        if (note) return `row ${label}: the amount cell ${note}`;
      }
      return `row ${label}: could not parse the date ${quote(row[dateCol])} or the amount ${quote(row[amountCol])}`;
    }
    case 'no-movement': {
      // keyed to the convention rather than flattened into this switch, so a new
      // StatedFee arm is a compile error here and not a row told about somebody
      // else's convention. This is applyFee's guarantee, extended to the sentence
      switch (refusal.stated.kind) {
        case 'not-stated':
          return `row ${label}: the amount cell reads ${quote(row[amountCol])} and no fee is stated. The row is skipped, rather than imported as a zero`;
        case 'on-top':
          // the direction of the subtraction, not "they cancel": a fee cell reading
          // 0.00 states a zero and cancels nothing, and the sign is what the guard is
          // for. A -5.00 row with a 5.00 fee is a -10.00 movement
          return `row ${label}: the amount cell ${quote(row[amountCol])} less the fee cell ${quote(row[feeCol])} is zero. The row is skipped, rather than imported as a zero`;
        case 'included':
          return `row ${label}: the amount cell reads ${quote(row[amountCol])} and it already carries the fee. The row is skipped, rather than imported as a zero`;
        default: {
          const unreachable: never = refusal.stated;
          throw new Error(`unhandled fee convention: ${String(unreachable)}`);
        }
      }
    }
    default: {
      const unreachable: never = refusal;
      throw new Error(`unhandled row refusal: ${String(unreachable)}`);
    }
  }
}

const NO_TRANSACTIONS =
  'this file has no transactions in it. Export the statement again from your online banking for a period with transactions, and upload the new file';

const notADate = (sheet: Sheet, i: number, cell: Cell | undefined, wrong: 'day' | 'time'): string =>
  `row ${sheet.rowLabel(i)}: the date cell reads ${quote(cell)}, ${wrong === 'day' ? 'which is not a day on the calendar' : 'whose time of day does not exist'}. Nothing was imported: correct the date in the file, and upload it again`;

export const notACurrency = (sheet: Sheet, i: number, cell: Cell | undefined): string =>
  `row ${sheet.rowLabel(i)}: the currency is ${quote(cell)}, but it must be a three-letter code such as EUR or USD. Nothing was imported. Correct the currency in the file and upload it again`;

export const feeRefused = (sheet: Sheet, i: number, text: string): string =>
  `row ${sheet.rowLabel(i)}: the fee cell reads "${bounded(text, FEE_QUOTE_MAX)}", which this parser cannot read as a fee. The row is skipped, rather than imported without it`;
