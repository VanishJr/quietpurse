/**
 * The one ingestion surface: POST /api/imports hands the raw bytes here, this file
 * decides what they are, picks a parser, and stages the rows behind a summary the user
 * has to accept. Confirm is what runs the rest of the pipeline - insertTransactions ->
 * reclassifyAll -> backfillBaseAmounts - and it lives in the data layer
 * (confirmImport, db/index.ts) because it is one database transaction.
 *
 * Deduplication: a statement row carries no bank reference, so this parser supplies no
 * dedupKey and insertTransactions computes one from the row's stable fields. That
 * requires the whole file to be inserted in one call, which it is - a statement covers
 * whole days, so every group of identical rows arrives complete.
 */
import crypto from 'crypto';
import { categorize } from '../categorizer';
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
import { PDF_PARSER_VERSION, PdfFee, PdfLimits, StatementBalances, readPdf } from './pdf';
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
      `the workbook is larger than ${mb} MB - export a narrower date range, or save it as CSV`,
  },
  /** pdfjs holds the document whole, exactly as exceljs holds the workbook. */
  pdf: {
    max: 10 * MB,
    tooLarge: (mb) =>
      `the PDF is larger than ${mb} MB - export a narrower date range, or export the statement as CSV or Excel (.xlsx)`,
  },
};

const FORMAT_NAME: Record<ImportSourceType, string> = {
  csv: 'CSV',
  xlsx: 'Excel (.xlsx)',
  pdf: 'PDF',
};

const FORMAT_NAMES = Object.values(FORMAT_NAME);
/** "CSV, Excel (.xlsx) or PDF" - the list a refusal names, derived and never typed out. */
const FORMATS = `${FORMAT_NAMES.slice(0, -1).join(', ')} or ${FORMAT_NAMES[FORMAT_NAMES.length - 1]}`;

/**
 * And a page cap as well, because the byte cap does not bound the page count even
 * loosely: compressed streams are the point of the format, so a plausible statement
 * fits in a few megabytes however many pages it has. Enforced inside readPdf and not
 * here, because numPages needs the document open - see the band comment below.
 */
const MAX_PDF_PAGES = 200;

/**
 * And a deadline, because neither cap bounds the WORK: how long a parse holds the only
 * thread this process has is the document's to decide, not the byte count's.
 *
 * What it does not bound. The check runs between pdfjs calls and cannot interrupt one, and
 * a document may put everything on a single page; what a compressed stream expands to is
 * bounded by neither cap. Opening the document is outside it the same way - charged to the
 * budget, not interruptible by it. So this bounds accidental pathology and not someone who
 * is trying. Closing that needs an execution context that can be terminated, which is a
 * second thread, and the argument that the workspace store is safe rests on there being
 * none. Sustained load across many uploads is a rate limit and not this.
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
 * What one cell describeRow quotes back at the user may spend - and the one place
 * the 199 that NOTICE_MAX (xlsx.ts) and NOTE_MAX (pdf.ts) are both derived against
 * is written whole. Three files each carried half of that derivation, each half was
 * locally checkable, and nobody owned the sum: which is how BOTH premises of the
 * sentence in xlsx.ts came to be false while its number stayed right.
 *
 * 199 = noRowsParsed's head at MAX_DATA_ROWS skipped, 40, plus the longest reason
 * describeRow composes, 159. NOTICE_MAX is what ERROR_DETAIL_MAX leaves after those
 * two, the 3 characters that join them, and 8 of margin.
 *
 * The 159, at the extreme of every number it carries. The lead is `row `, the label
 * and `: `, and the label is whatever the path's rowLabel emits:
 *   xlsx   kept[i].sheetRow, and never past MAX_SHEET_ROWS = 500000, because a
 *          worksheet with more rows than that is skipped before readRows walks it -
 *          so Excel's own 1048576 is NOT reachable, however the file was written
 *   csv    i + 1, so MAX_DATA_ROWS + 1
 *   pdf    i, so MAX_DATA_ROWS
 * against the arms:
 *   numeric date   String(n) for a double is 25 characters at its widest
 *                  (-0.0000010352999999999999), not the 24 of -Number.MAX_VALUE.
 *                  Bounded here, which is what makes 159 hold at a seven-digit label
 *                  instead of only at the six the xlsx gate happens to allow: 158
 *                  under a six-digit label, 159 at Excel's unreachable one
 *   a note         the wider of the two arms that quote one spends 22 of fixed prose
 *                  (`the amount cell `; the date one is 20), so what a note MAY spend
 *                  - the budget a producer is writing against - is what 159 leaves
 *                  after that and the label: 131 under xlsx's six digits, 132 under
 *                  the five pdf and csv can reach. The two cannot be traded: a
 *                  132-character note at a six-digit label composes 160, so 131 is
 *                  the only figure safe on every path.
 *                  Spent today: pdf's NOTE_MAX is 132 and composes 159 exactly; csv
 *                  produces no note at all; xlsx produces two, UNCACHED_FORMULA at 89
 *                  composing 117, and errorNote at 33 composing 61 - and what holds
 *                  errorNote inside the budget is the CUT at ERROR_TEXT_MAX in
 *                  xlsx.ts. Not its type: CellErrorValue['error'] is a union of seven
 *                  literals that nothing checks the file against, so before that cut
 *                  the note was 9 plus whatever the bytes said, and a workbook a
 *                  spreadsheet did not write composed past 400 here - evicting
 *                  noRowsParsed's notice about a different part of the file whole.
 *                  NOT held: that a note producer added later respects its path's
 *                  budget. Nothing checks it, and a blanket bounded() here cannot -
 *                  it would have to cut at 131, which is under what pdf already
 *                  spends. DEBT.md carries it
 *   no movement    the on-top arm quotes two cells at this bound: 159 under a
 *                  six-digit label, and it is spent to the character. included is
 *                  pdf-only, 142; not-stated is every path's, 133 under a six-digit
 *                  label
 *   fall-through   two cells at this bound: 104 under a six-digit label
 */
const CELL_QUOTE_MAX = 24;

/**
 * What one column name may spend in the summary's readAs. A RENDER bound, and the one
 * number in this band that is NOT part of the ERROR_DETAIL_MAX derivation the three
 * above share: readAs is a field of the summary, never a problem and never an
 * error_detail.
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
 * exclusivity - there is nothing left to be exclusive with - they hold `src/`:
 * app.ts annotates `let destination: StatementDestination`, so a product call site
 * that built a name arm fails tsc, including one that builds the object in a
 * variable first, where an excess-property check would not run. They hold NOTHING
 * under test/, which this tsconfig does not compile.
 */
export type StatementDestination = { accountId: string; accountName?: never; currency?: never };

export type StatementImportRequest = StatementDestination & {
  preset?: string;
  mapping?: Partial<CsvMapping>;
  bytes: Buffer;
  originalFilename?: string;
  uploadedBy?: string;
};

export const ACCOUNT_NOT_FOUND =
  'no such account in this workspace - pick one of your accounts, or create a new one';
export const ACCOUNT_REMOVED =
  'this account has been removed from the app - restore it, then upload the file again';

declare const checked: unique symbol;

export type CheckedTotals = readonly { currency: string; net: number }[] & {
  readonly [checked]: true;
};

export type SeriesCounts = { summed: number; checked: number };

export type CheckedBalances = {
  opening: number;
  closing: number;
  currency: string;
  series?: SeriesCounts;
} & { readonly [checked]: true };

/**
 * Why no opening/closing pair is shown for a file that DOES state a running balance.
 * Absent together with `balances` means the format states none, and the two must not
 * spell the same: after this row a third state exists - a preset
 * declared a balance column, it resolved, and the check could not be completed.
 *
 * A slug over the wire with the sentence in the client dictionary, which is this
 * codebase's own idiom for a value a screen renders as prose.
 */
export type BalancesNotShown =
  | 'rows-outside-the-balance'
  | 'rows-without-a-balance'
  | 'balance-closes-on-itself'
  | 'more-than-one-currency';

/** date, amount and description: the three slots every reader fills, and no others. */
export interface ReadColumns {
  date: string;
  amount: string;
  description: string[];
}

export type SheetReadAs =
  | { kind: 'preset'; preset: string; title: string; columns: ReadColumns }
  | { kind: 'auto-detected'; columns: ReadColumns }
  | { kind: 'request-mapping'; columns: ReadColumns };

export type ReadAs = SheetReadAs | { kind: 'pdf-template'; title: string };

/** The one place either brand is applied, and it is private to this module. */
const check = <T>(value: T): T & { readonly [checked]: true } =>
  value as T & { readonly [checked]: true };

export interface ImportSummary {
  importId: string;
  accountId: string;
  accountName: string;
  total: number;
  accepted: number;
  /** dropped rows, the sum of the three below, and what imports.rows_rejected stores */
  skipped: number;
  /** of those, the ones this importer failed on - an unreadable fee, or no date or amount */
  unreadable: number;
  /** read fine, and dropped by a rule: the statement's own status column says so */
  filtered: number;
  /** read fine, and moving no money once the fee is taken - nothing to insert */
  noMovement: number;
  problems: string[];
  /**
   * Of `accepted`, how many are not already in the database - the number the user
   * reads before deciding. A snapshot: another import committing between now and
   * Confirm can take one of these slots, and the confirm reports what landed.
   */
  newRows: number;
  alreadyPresent: number;
  from: string;
  to: string;
  totals: CheckedTotals;
  readAs: ReadAs;
  balances?: CheckedBalances;
  /** set only when the file states a running balance and no pair came out of it */
  balancesNotShown?: BalancesNotShown;
  supersededImportId?: string;
}

export type StatementImportResult =
  | {
      outcome: 'duplicate';
      importId: string;
      accountId: string;
      accountIds: string[];
      uploadedAt: string;
      skipped: number;
      total: number;
    }
  | { outcome: 'awaiting_confirmation'; summary: ImportSummary };

/**
 * What the bytes are, by content only - never by the extension or the browser's
 * Content-Type, both of which the user's bank chose and neither of which is checked
 * anywhere. Everything this refuses gets a message saying what to do instead.
 *
 * It answers a type and nothing else, deliberately: a classifier with no bytes to
 * hand back cannot give a caller a buffer different from the one it was passed, so
 * the bytes hashed, the bytes stored and the bytes parsed stay one buffer even for a
 * file whose document starts at an offset.
 */
export function sniff(bytes: Buffer): ImportSourceType {
  const starts = (...signature: number[]): boolean =>
    signature.every((b, i) => bytes[i] === b);

  if (bytes.length === 0) throw new Error('the uploaded file is empty');
  if (starts(0x50, 0x4b, 0x03, 0x04)) return 'xlsx';
  if (starts(0x25, 0x50, 0x44, 0x46)) return 'pdf';
  if (starts(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) {
    throw new Error(
      'this is the older Excel format (.xls) - open it and save as .xlsx, or export the statement as CSV',
    );
  }
  if (starts(0x1f, 0x8b)) {
    throw new Error('this file is compressed - unpack it and upload the statement itself');
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
      `this looks like XML or HTML, not a ${FORMATS} statement - CAMT.053 and MT940 are not supported yet`,
    );
  }
      // A bank's own export can be a signed container: the whole statement inside a CMS
      // envelope, with `%PDF-` at an offset rather than at 0. Answered on the header being
      // FOUND and never on the lead-in - "it starts like an ASN.1 SEQUENCE" is not evidence
      // a statement is in there. 0x30 is also ASCII `0`, so a CSV whose first cell is a
      // dotted date reaches this line; the second byte is what parts them, and only because
      // 0x80-0x84 are UTF-8 continuation bytes, which cannot follow an ASCII digit in a text
      // file. Short form says the whole value is at most 127 bytes and cannot hold a
      // document; 0x80 is BER indefinite length, which a signer that streams emits. A rule
      // narrowed to the one length byte the documents in hand happen to carry would pass
      // every test written from them and refuse the same bank's next file.
      //
      // Searched whole rather than within a window: readPdf gets this same buffer, and
      // pdfjs finds the header at any offset - past its own find() window it reconstructs
      // the xref - so a window here would make the classifier stricter than the reader it
      // feeds and refuse a file this product can read. Only a file that already matched the
      // lead-in gets this far, so no CSV pays for the search.
  if (bytes[0] === 0x30 && bytes[1] >= 0x80 && bytes[1] <= 0x84 && bytes.includes(PDF_HEADER)) {
    return 'pdf';
  }
  if (bytes.subarray(0, NUL_SCAN_BYTES).includes(0)) {
    throw new Error(
      `this file is not a ${FORMATS} statement - export the statement in one of those from your online banking and upload that`,
    );
  }
  return 'csv';
}

/**
 * Parses the statement and stages what it read. Nothing reaches `transactions`
 * here, and nothing on any screen moves until confirmImport runs.
 *
 * Order of operations: hash and check before parsing, so a
 * re-upload costs nothing; write the import row before touching anything else, so
 * a failure leaves a failed import rather than nothing at all. The import row is
 * deliberately NOT in a transaction with the parse - a rollback would take the
 * failure record with it.
 *
 * The catch is around the staging as well as the parse: a throw after some rows
 * have been staged leaves them attached to a failed import, which is recoverable
 * (delete it and they go too), where leaving them unattributed would not be.
 */
export async function importStatement(
  req: StatementImportRequest,
): Promise<StatementImportResult> {
  const fileHash = crypto.createHash('sha256').update(req.bytes).digest('hex');

  const already = await findCommittedImportByHash(fileHash);
  if (already) {
    // the account this upload asked for is not necessarily where the rows are - the
    // file was imported into whatever account it was given the first time
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
  // whatever the file turns out to be, and it is the only one of the three the user
  // cannot discover by looking at the file - so a .docx dropped into a removed
  // account is told the account is gone rather than told the format is unreadable.
  // Both are true; this one is the one worth saying first. Moved below the size cap
  // it would also leave an `imports` row for an upload that was never going to land.
  const account = await uploadDestination(req);

  // What leaves no `imports` row at all is everything decidable without opening the
  // file: a type the sniffer recognises and refuses, a file past the size cap, a
  // preset that does not exist. Nothing was parsed and nothing could have been
  // written, and `failed` means "an import did not complete", not "the user picked
  // the wrong file". What does leave a failed row is everything the loader has to
  // open the file to discover - a zip that turns out not to be a workbook, a sheet
  // with no header, a PDF that is password-protected, past MAX_PDF_PAGES or still
  // being read at the deadline in PDF_LIMITS - because the bytes alone cannot tell.
  // It is the opening that decides the band and not how much was parsed: an
  // encrypted PDF parses nothing either.
  const sourceType = sniff(req.bytes);
  const cap = SIZE_CAP[sourceType];
  if (cap && req.bytes.length > cap.max) throw new Error(cap.tooLarge(cap.max / MB));
  const preset = presetMapping(req.preset);

  const record = await createImport({
    fileHash,
    sourceType,
    parserVersion: PARSER_VERSION[sourceType],
    originalFilename: req.originalFilename,
    uploadedBy: req.uploadedBy,
  });
  try {
    // The file itself, before the parse and inside the same catch.
    // Before, because the imports that FAILED are precisely the ones support needs
    // the input for - so a failed import keeps its document, and so does a `pending`
    // one left by a process that died between here and the parse.
    //
    // If it cannot be stored the import is refused rather than committed with a
    // warning: committing would claim the file hash forever, and the same bytes
    // would then answer "already imported" on every retry, so the one artefact that
    // cannot be recovered later could never be captured for that file at all. The
    // throw lands in the catch below - a `failed` row with no transactions, and
    // bytes that stay re-uploadable because only `committed` blocks.
    await recordImportDocument(record.id, await putDocument(record.id, req.bytes));
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
  // .mapping is undefined - which reaches readSheet as a preset and dies there on
  // `preset.mapping.delimiter`, an internal TypeError in error_detail.
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
      // PDF has neither for them to name - so a chip the user may not remember
      // picking must not decide whether their statement imports.
      return {
        kind: 'pdf',
        sheet: parsed.sheet,
        preset: null,
        mapping: parsed.columns,
        template: parsed.template,
        title: parsed.title,
        fee: parsed.fee,
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
 * unresolved slot refuses the whole file - where a Revolut export whose header has no
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
 * The series column is a refinement and never a precondition - a file that states one
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

/**
 * Which column is which, for one header row. The XLSX header scan and the mapper
 * call this same function: a scan with a laxer predicate would settle on a row
 * above the real header, and the mapper would then read every data row against the
 * wrong columns and report a plausible-looking count as a success.
 */
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
        error: `could not find date/amount/description columns in the header: ${header.join(', ')} - set a mapping or pick a preset`,
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
  // this function is also the XLSX header scan's predicate - so header[-1] would make
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
 * into the same refusal - against a file they cannot edit.
 *
 * The slots and what was tried come first and the header dump last, because the dump
 * is unbounded and error_detail's cap cuts the tail: what the user acts on is the
 * names, not their own header read back to them. Appended whole or not at all - a
 * truncated dump names columns the file has not got.
 */
function noColumnMatched(unresolved: Unresolved[], header: string[]): string {
  const slots = unresolved
    .map((u) => `${u.slot} (tried ${u.tried.map((n) => `"${n}"`).join(', ')})`)
    .join(', ');
  const head = `no column matched for ${slots} - pick a different preset or set a mapping`;
  const dump = `; the header reads: ${header.join(', ')}`;
  return head.length + dump.length <= ERROR_DETAIL_MAX ? head + dump : head;
}

type FeeCell = { ok: true; fee: number | null } | { ok: false; text: string };

/**
 * A fee one row of the file stated, and WHICH OF THE TWO THINGS IT IS.
 *
 * The discriminant travels with the number because the two conventions move the
 * movement in opposite directions: an on-top fee is subtracted to get what the
 * account did, an included one is already inside it. Until this row that fact lived
 * in a doc comment on CsvPresetMapping.fee and was implemented by an unconditional
 * subtraction - correct while a sheet was the only producer, and silently wrong money
 * the moment a second one arrived with the other convention. On the one file measured
 * a PDF fee subtracted a second time takes the net from 192.45 to 192.01 and the
 * reconciliation gate refuses the whole import in a sentence about balances that names
 * nothing about fees.
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
 * whole. Until this row the mapper computed the reason, threw it away, and handed
 * describeRow two nullables out of which "the movement was zero" is not expressible -
 * so every zero-movement row was told that neither of its cells could be read, about
 * cells that had both parsed.
 */
export type RowRefusal =
  | ({ kind: 'unread'; date: string | null; amount: number | null } & {
      readonly [refused]: true;
    })
  | ({ kind: 'no-movement'; stated: StatedFee } & { readonly [refused]: true });

/**
 * And the arm that is not a refusal, which carries the two values out non-null. The
 * guard this replaced decided the row AND narrowed date and amount for everything
 * below it; a verdict that answered only the refusals would have thrown the narrowing
 * away and needed a second test to get it back - a predicate written twice, which is
 * the shape of defect this row exists to remove one level up.
 */
export type RowVerdict =
  | RowRefusal
  | ({ kind: 'import'; date: string; amount: number } & { readonly [refused]: true });

/** The one place this brand is applied, and it is private to this module. */
const refuse = <T>(value: T): T & { readonly [refused]: true } =>
  value as T & { readonly [refused]: true };

/**
 * Whether a row imports and, when it does not, WHY - decided once, where both are
 * known, and carried to the sentence whole.
 *
 * The brand is what makes the ordering below a rule rather than a convention: no
 * other file can build a RowVerdict at all, so no caller can claim `no-movement` for
 * a row whose date or amount never parsed - the nullness test comes first here, once,
 * and the zero arm is reachable only past it. It stops an accident, not a determined
 * caller: `as unknown as RowRefusal` still compiles, which is all `check` claims
 * either.
 *
 * `amount` is the MOVEMENT, after applyFee, where describeRow used to be handed the
 * cell. Safe because amount === null iff rawAmount === null at the call site: applyFee
 * returns a number on every arm, so the only null is the caller's own rawAmount guard.
 * That equivalence is obvious for exactly as long as applyFee has no fourth arm.
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
       * same predicate - measured true of the real export, where all three pending
       * rows leave the cell empty. This is the detector for the day a bank diverges
       * from it, and it is carried per row rather than as a count because a dropped
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
   * only for deciding which rows belong to the same running balance - `Current` and
   * `current` are one series and must not become two - so it may not reach a sentence
   * a person reads beside their own statement (the status values are quoted the same
   * way, and for the same reason).
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
 * What the file stated for one row's fee. null is "it stated nothing" - an empty
 * cell - and never a zero this importer invented; the empty test is on the text and
 * comes first, exactly as the currency column's does, because parseAmount('') answers
 * null and so does a cell full of rubbish.
 *
 * A cell that is there and unreadable refuses the row rather than the file, and a
 * negative one with it: subtracted, it would INCREASE the movement, and no source in
 * this tree states such a thing. Refusing the file instead would leave the user one
 * route - the generic preset, which resolves no fee column at all and would import
 * every row of that statement pre-fee, silently. That is the defect this reader
 * exists to remove, so the louder refusal is the one that costs more.
 */
function readFee(c: Cell | undefined, decimal: CsvMapping['decimal']): FeeCell {
  const text = cellText(c).trim();
  if (!text) return { ok: true, fee: null };
  const fee = cellAmount(c, decimal);
  return fee === null || fee < 0 ? { ok: false, text } : { ok: true, fee };
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
 * Where each refusal lands. A fourth RowRefusal kind does not compile until it names
 * a bucket - but the failure this table is really guarding is the WRONG mapping, not
 * the missing one. `unread: 'noMovement'` type-checks, keeps `skipped` exact, and
 * empties the clause balanceBreaks composes about the lines this importer could not
 * read - the one sentence that tells a user where their missing money went.
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
  if (sheet.rows.length < 2) throw new Error('the file has no data rows (header only, or empty)');

  const header = sheet.rows[0].map((c) => cellText(c).trim());
  const resolved = resolveColumns(header, preset, parsed.mapping);
  if (!resolved.ok) throw new Error(resolved.error);
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
  // And resolveColumns HAS answered a SheetReadAs here even on the pdf path - readSheet
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

  const total = sheet.rows.length - 1;
  if (total > MAX_DATA_ROWS) {
    throw new Error(
      `the statement has ${total} data rows, more than the ${MAX_DATA_ROWS} this importer reads in one file - split it and upload the parts`,
    );
  }

  // Pairs rather than two arrays, and txs is derived from them below: what the gate
  // checks and what the file stated beside it are read in one loop and cannot come
  // apart by an index.
  const accepted: { tx: NewTransaction; stated: StatedRow }[] = [];
    // a notice is a fact about the file, not a rejected row: it goes in front of the
    // row problems and touches no count. The two
  // are kept apart so that neither has to be recovered from the other by index -
  // an extra notice would silently make problems[0] the wrong kind of sentence
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
  // read the same way for a row that is dropped as for one that is kept: the two have
  // to agree on which running balance a row belongs to, and a dropped row that read
  // its currency differently would name a run that does not exist
  const rowCurrency = (row: Cell[]): string =>
    currencyCol >= 0 && cellText(row[currencyCol]).trim()
      ? cellText(row[currencyCol]).trim().toUpperCase()
      : account.currency.toUpperCase();

  for (let i = 1; i < sheet.rows.length; i++) {
    const row = sheet.rows[i];
    // first in the loop and it must stay there: the rows this drops are the ones the
    // bank has not finished, and their date cell is empty - filtered later, each of
    // them spends a MAX_PROBLEMS slot on a date it was never going to have.
    //
    // A row is kept only if its folded value IS in the accepted set. Inverted - skip
    // the known-pending ones - it would import every reverted, declined and pending
    // row shipped in a language nobody has listed yet, as money that never moved.
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
    // alike - and the two paths reach it from opposite directions, which is why the
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
    const description = descCols
      .map((c) => cellText(row[c]).trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ');
    const currency = rowCurrency(row);

    accepted.push({
      tx: {
        accountId: account.id,
        provider: 'upload',
        amount: verdict.amount,
        currency,
        date: verdict.date,
        description,
        category: categorize(undefined, description, verdict.amount),
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
  // all. It can fire only on a bug in this file - never on a cell of the user's - and
  // it is what makes the card's own "Read N of M rows" true rather than merely
  // consistent with the three counts printed under it.
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
  // here rather than at confirm: confirm inserts a subset - an overlapping
  // statement's rows are already present and are skipped - so a gate re-run there
  // would refuse every legitimate overlapping import, which is the common case.
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
  // reverse order is the one that costs something - two staged copies of one file
  // coexist safely, where a discarded original and no replacement is a summary the
  // user lost.
  //
  // "Safely" is load-bearing and it is not free: it holds because the supersede is
  // strictly one-directional (see supersedeStagedImports). Discarding any *other*
  // outstanding copy is symmetric, so two uploads racing would each take the other
  // and leave nothing confirmable at all. With only an older one taken, the worst
  // case is two confirmable copies, and the second confirm meets
  // imports_file_hash_unique and answers 409 rather than importing anything twice.
  const superseded = await supersedeStagedImports(fileHash, importId);

  const days = txs.map((t) => t.date.slice(0, 10)).sort();
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
    // the aggregate sits ahead of the row problems and inside the few the client
    // renders: a further per-row reason refines a picture the user already has, where
    // "some of your rows were dropped, and these are the values that did it" is the
    // only line saying the import is partial at all. The cut cannot reach a notice -
    // one is the most any sheet produces
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
 * Neither bound is reached by anything in the tree - the upload route takes three
 * letters, and a PDF's codes are literals in the template that read it. They exist
 * because the sentence below carries four amounts and up to four codes and is asserted
 * against ERROR_DETAIL_MAX: an assertion over a value nothing bounds is an assertion
 * about the day it was written.
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
  return `this ${title} statement does not add up: its opening balance of ${money(openingCents, currency)} plus the ${lineCount(accepted)} read comes to ${money(openingCents + net, currency)}, where the statement's own closing balance is ${money(closingCents, currency)} - a difference of ${money(Math.abs(openingCents + net - closingCents), currency)}${cause} - export the same statement as CSV or Excel (.xlsx) from your online banking and upload that`;
};

/**
 * It fires only when the ends match and the halves do not, and the wording leads with
 * that: a single dropped row fails both checks, and the net one runs first because it
 * names the missing amount where this one names a discrepancy in a subtotal (row 035,
 * R1). So the only thing left for this sentence is the compensating pair - money out
 * and money in that the parser never saw, cancelling into a clean net.
 *
 * All four figures, signed, rather than the two differences: which side to look at in
 * the document is what the person holding it needs, and a magnitudes-only sentence
 * under a backwards `signs` declaration would print the same number twice and read as
 * a refusal naming two identical figures. "of the same size" is exact rather than a
 * hedge - the net matched, so the two shortfalls are equal by arithmetic.
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
  return `this ${title} statement's opening and closing balance agree, but its two halves do not: it states ${money(printed.outgoingCents, currency)} out and ${money(printed.incomingCents, currency)} in, where the ${lineCount(accepted)} read come to ${money(outCents, currency)} out and ${money(inCents, currency)} in${cause} - export the same statement as CSV or Excel (.xlsx) from your online banking and upload that`;
};

const mixedCurrencies = (title: string, currency: string, found: string[]): string =>
  `this ${title} statement states its balances in ${bounded(currency, CURRENCY_CODE_MAX)}, but the lines read are in ${currencyList(found)} - this importer cannot check a statement that mixes currencies - export the same statement as CSV or Excel (.xlsx) from your online banking and upload that`;

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
 * a permutation of the file's rows - a bank exporting newest-first - gives the same
 * verdict and the same pair.
 *
 * Removing an interior row splits the run in two, which shows up as a second
 * component and as a second value with an excess. That is the whole content of the
 * check, and it is deliberately NOT `opening + net = closing`: over endpoints derived
 * from these same rows that is an identity and holds however many rows are missing.
 *
 * It is blind at the ENDS, and the blindness is structural: losing the first or last
 * row of a run does not break it, it moves where it starts or stops. Measured on the
 * real export, 3 of 70 single-row removals pass that way and every one is a boundary
 * row - which is why the confirmation screen may claim the run and may not claim the
 * statement is complete.
 *
 * Connectivity is load-bearing rather than decoration: 100->110, 110->130 plus a
 * detached 500->600, 600->500 has balanced degrees at every value and is two runs.
 *
 * A row whose movement rounds to zero cents needs no special case and gets none: its
 * pre equals its post, so it is a self-loop, which changes no degree and joins no two
 * values. Dropping it - as the `amount === 0` guard does - leaves the run intact.
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
 * verdict already called broken, and one always exists there - a run whose every
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
    ? `this statement's own running balance breaks:${where} the line stating ${money(at.after.postCents, currency)} does not follow the one stating ${money(at.before.postCents, currency)} - ${money(Math.abs(at.after.preCents - at.before.postCents), currency)} is unaccounted for between them`
    : `this statement's own running balance breaks: the lines read${where} do not form one unbroken run`;
  return `${head}${cause} - export the same statement again from your online banking and upload it`;
};

/**
 * The sheet arm's verdict for the whole file, per running balance and then over all
 * of them.
 *
 * A break refuses whatever else is true of the OTHER runs: the file's own arithmetic
 * says money is missing from what was read, and a statement short by a row staged for
 * confirmation is the failure CLAUDE.md ranks above a crash. One blank cell in a
 * pocket the user barely uses may not disarm the refusal for the account it sits
 * beside.
 *
 * "Whatever else is true of the others" is doing the work in that sentence, because a
 * run this importer cannot use is never examined for a break at all - and that is
 * where R10's protection sits. Both ways it happens take their hole out of ONE run
 * and leave its links a subset by construction: a balance cell this parser could not
 * read is a link it never built, and a row the status filter dropped is a step of that
 * series the gate never sees. What is left of either run breaks, and the break is ours
 * rather than the file's. A locale whose balances this `decimal` setting misreads, and
 * a bank that prints a running balance on its pending rows, are the two files that
 * live there - both import today, both must keep importing, and neither may cost a
 * refusal on the one path with nowhere further to fall back to.
 *
 * Everything past the loop is only whether a pair can honestly be shown.
 */
function checkSheet(running: Map<string, RunningBalance>, stated: StatedBalances): SheetBalances {
  if (stated.kind === 'none') return { kind: 'none' };
  const coveredRuns = new Set(stated.coveredButSkipped.map((c) => runKey(c.series, c.currency)));
  // a dropped row naming a running balance that no accepted row belongs to has no run
  // to disarm - and "has a balance" and "is accepted" have still come apart, which is
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
  // about their denominator. Every exit above is a whole-file one - one incomplete,
  // covered or endpointless run takes the entire file to `unusable` - so by the time
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
 * The three states a sheet's balances can be in, and there is no fourth:
 * "this file states no running balance" and "it stated one and it could not be used"
 * are different variants, so collapsing the second into the first cannot happen by
 * omission - it would have to be written out - and the exhaustive switch below makes
 * a state added here a `tsc` error rather than a review finding.
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
 * The net movement of the file per currency, and - for a format that states its own
 * balances - the check that the rows actually run from the opening one to the
 * closing one, and that each half of them comes to what the document printed for it.
 *
 * The two are one pass on purpose. The number a person reads before confirming and
 * the number the gate checks have to come out of the same loop, or they drift with
 * nothing failing until somebody reads a wrong one - the same argument that has
 * `newRows` come from the key generator the confirm uses.
 *
 * Summed in minor units rather than decimals for the reason money.ts gives, and here
 * it is not theoretical: a real statement's amounts summed as decimals miss its
 * closing balance by a fraction of a cent, and an exact comparison refuses that.
 * Exactly, with no tolerance anywhere - one cent of slack hides a systematically
 * dropped fee on a small statement and lets a drifted template import plausible
 * numbers, which is the one outcome worse than refusing.
 *
 * `stated` is required and not optional at the call site: an optional
 * one forgotten at a sheet caller reads as "this format states no balances", which is
 * exactly the collapse the type below exists to prevent. The pdf path passes
 * `{ kind: 'none' }`, which is true of it - the sheet mapper stated nothing for a PDF
 * - and the pdf arm never looks at it.
 *
 * Exported for the test, like readSheet and noRowsParsed and for the same reason:
 * the mixed-currency arm is unreachable through today's one template, which declares
 * a single currency symbol, so nothing else can watch it throw.
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
  // is exactly one currency and it is the balances' - said here rather than there
  // because this is where the fact is relied on.
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
  return `${lead} "${bounded(status.column, STATUS_QUOTE_MAX)}" value is not one of the accepted ones - ${statusList(entries)}`;
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
  const notice = notices.length ? ` - ${notices.join(' - ')}` : '';
  return head.length + notice.length <= ERROR_DETAIL_MAX ? head + notice : head;
}

/**
 * Exported for the test, like readSheet and applyFee and for the same reason: neither
 * `never` below is worth anything unless something has watched it throw, and the
 * lengths this composes are bounded by an assertion rather than by a type, so that
 * assertion has to be able to reach every arm. Not API surface anyone asked for.
 *
 * `feeCol` is the column statedFeeOf actually read, not resolveColumns's - on the PDF
 * path the latter is the synthetic header's and quoting it would name a column the
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
          return `row ${label}: the date cell holds the number ${bounded(String(row[dateCol]), CELL_QUOTE_MAX)}, which this parser will not read as a date - format that column as a date and upload again`;
        }
      }
      if (refusal.amount === null) {
        const note = sheet.note?.(i, amountCol);
        if (note) return `row ${label}: the amount cell ${note}`;
      }
      return `row ${label}: could not parse the date ${quote(row[dateCol])} or the amount ${quote(row[amountCol])}`;
    }
    case 'no-movement': {
      // keyed to the convention rather than flattened into this switch, so a fourth
      // StatedFee arm is a compile error here and not a row told about somebody
      // else's convention - applyFee's guarantee, extended to the sentence
      switch (refusal.stated.kind) {
        case 'not-stated':
          return `row ${label}: the amount cell reads ${quote(row[amountCol])} and no fee is stated - the row is skipped rather than imported as a zero`;
        case 'on-top':
          // the direction of the subtraction, not "they cancel": a fee cell reading
          // 0.00 states a zero and cancels nothing, and the sign is what the guard is
          // for - a -5.00 row with a 5.00 fee is a -10.00 movement
          return `row ${label}: the amount cell ${quote(row[amountCol])} less the fee cell ${quote(row[feeCol])} is zero - the row is skipped rather than imported as a zero`;
        case 'included':
          return `row ${label}: the amount cell reads ${quote(row[amountCol])} and it already carries the fee - the row is skipped rather than imported as a zero`;
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

export const feeRefused = (sheet: Sheet, i: number, text: string): string =>
  `row ${sheet.rowLabel(i)}: the fee cell reads "${bounded(text, FEE_QUOTE_MAX)}", which this parser cannot read as a fee - the row is skipped rather than imported without it`;
