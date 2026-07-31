/**
 * The one ingestion surface (ROADMAP 5.1): POST /api/imports hands the raw bytes
 * here, this file decides what they are, picks a parser, and stages the rows behind
 * a summary the user has to accept. Confirm is what runs the rest of the pipeline -
 * insertTransactions -> reclassifyAll -> backfillBaseAmounts - and it lives in the
 * data layer (confirmImport, db/index.ts) because it is one database transaction.
 * The classifier doesn't care where a transaction came from.
 *
 * This is the only way data enters the product: an upload is a push, so nothing
 * here polls or schedules (ROADMAP 5.4 deleted the direct bank integrations).
 *
 * Deduplication: a statement row carries no bank reference, so this parser supplies
 * no dedupKey and insertTransactions computes one from the row's stable fields. That
 * requires the whole file to be inserted in one call, which it is - a statement
 * covers whole days, so every group of identical rows arrives complete.
 *
 * Ahead of all that sits the file itself: every import is recorded in `imports`,
 * and a file already imported into this workspace is recognised by the hash of its
 * bytes and never parsed a second time (ROADMAP 4.3, 4.4).
 */
import crypto from 'crypto';
import { uploadAccountId } from '../accountid';
import { categorize } from '../categorizer';
import {
  ERROR_DETAIL_MAX,
  ImportSourceType,
  countNewKeys,
  createImport,
  failImport,
  findCommittedImportByHash,
  getAccount,
  listImportAccountIds,
  recordImportDocument,
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
import { PDF_PARSER_VERSION, readPdf } from './pdf';
import { Cell, MAX_DATA_ROWS, Sheet, cellAmount, cellDate, cellText } from './sheet';
import { XLSX_PARSER_VERSION, readXlsx } from './xlsx';

const PARSER_VERSION: Record<ImportSourceType, number> = {
  csv: CSV_PARSER_VERSION,
  xlsx: XLSX_PARSER_VERSION,
  pdf: PDF_PARSER_VERSION,
};

const MB = 1024 * 1024;

/**
 * What a format may weigh, and what it is told when it does not fit. Total over
 * ImportSourceType rather than a chain of ifs: a loader that holds the whole file
 * in memory and is added beside one that does gets no cap and nothing says so. A
 * format with no cap of its own has to say that here.
 *
 * The sentence travels with the number so the limit enforced and the limit printed
 * cannot come apart.
 */
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

/**
 * And a page cap as well, because the byte cap does not bound the page count even
 * loosely: 500 pages of dense transactions is 3.6 MB before compression, and
 * compressed streams are the point of the format. A yearly retail statement runs
 * 40-80 pages, so this is 2-3x the plausible maximum for one document; above it the
 * file is almost certainly not one statement. Enforced inside readPdf and not here,
 * because numPages needs the document open - see the band comment below.
 */
const MAX_PDF_PAGES = 200;

/** How many bytes of a text file are searched for the NUL that says it is not one. */
const NUL_SCAN_BYTES = 8192;

/** Notices and row problems share this budget - the client renders the first three. */
const MAX_PROBLEMS = 5;

/**
 * What the status column's name may spend inside its quotes, and what the whole list
 * of refused values may. Budgets, not facts about status columns: noRowsParsed's head
 * costs 40 at MAX_DATA_ROWS skipped, the reason's fixed prose 55, and 40 + 55 + 24 +
 * 72 = 191 against the 199 that xlsx.ts's NOTICE_MAX is derived from. Raising either
 * for a longer status value pushes past that number without anything saying so, and
 * the unused-sheet notice then starts falling off workbooks with no status column at
 * all. The list's own last resort - a count of the values that did not fit - is inside
 * the second bound, so a file whose status column is really a description costs the
 * same as one with two values.
 */
const STATUS_QUOTE_MAX = 24;
const STATUS_LIST_MAX = 72;

export interface StatementImportRequest {
  /** the account name in the app ("Sparkasse Giro"); the account id is derived from it */
  accountName: string;
  /** the account's currency (if the file has no currency column) */
  currency: string;
  /** a preset name from CSV_PRESETS; generic - auto-detect the columns */
  preset?: string;
  /** a custom mapping (overrides the preset) */
  mapping?: Partial<CsvMapping>;
  /** the uploaded file, exactly as it arrived */
  bytes: Buffer;
  /** the uploaded file's name, if the caller has one */
  originalFilename?: string;
  /** the signed-in user (recorded on the import, not a foreign key) */
  uploadedBy?: string;
}

/**
 * What was read, for the user to accept or reject. Nothing here is in the database
 * yet: the rows are staged (ROADMAP 5.3) and become data only on Confirm.
 */
export interface ImportSummary {
  /** the import awaiting confirmation - Confirm and Discard address it */
  importId: string;
  /** where the rows will go: the derived id, the name as typed, and whether it exists */
  accountId: string;
  accountName: string;
  accountExists: boolean;
  /** data rows in the file */
  total: number;
  /** rows that became staged transactions */
  accepted: number;
  /** rows the parser could not use */
  skipped: number;
  /** the first parsing errors, plus any notice about the file itself */
  problems: string[];
  /**
   * Of `accepted`, how many are not already in the database - the number the user
   * reads before deciding. A snapshot: another import committing between now and
   * Confirm can take one of these slots, and the confirm reports what landed.
   */
  newRows: number;
  alreadyPresent: number;
  /** earliest and latest row date, YYYY-MM-DD */
  from: string;
  to: string;
  /** net total per currency: a file with a currency column can carry more than one */
  totals: { currency: string; net: number }[];
  /**
   * An earlier upload of these same bytes was still awaiting confirmation and has
   * been discarded to make room for this one. A field rather than a sentence: the
   * REST API is the contract iOS and Android read too, and an optional field is
   * something a test can assert the absence of.
   */
  supersededImportId?: string;
}

/**
 * Nothing is imported by an upload any more. Either the file is one this workspace
 * already committed - which is not something to confirm, and must not render as an
 * empty summary - or it is parsed, staged, and waiting for the user.
 */
export type StatementImportResult =
  | {
      outcome: 'duplicate';
      /** the earlier import that already holds the file */
      importId: string;
      /** accountIds[0], or the requested account when that import owns no rows */
      accountId: string;
      /**
       * Where the earlier import's rows are, which need not be the account this
       * upload asked for. Empty means it owns none because an even earlier import
       * had already written every one of them - not that nothing was imported.
       */
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
      'this looks like XML or HTML, not a CSV or Excel statement - CAMT.053 and MT940 are not supported yet',
    );
  }
  if (bytes.subarray(0, NUL_SCAN_BYTES).includes(0)) {
    throw new Error('this file is neither a CSV nor an Excel workbook (.xlsx)');
  }
  return 'csv';
}

/**
 * Parses the statement and stages what it read. Nothing reaches `transactions`
 * here, and nothing on any screen moves until confirmImport runs.
 *
 * Order of operations (ROADMAP 5.1): hash and check before parsing, so a
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
  const accountId = uploadAccountId(req.accountName);
  const fileHash = crypto.createHash('sha256').update(req.bytes).digest('hex');

  const already = await findCommittedImportByHash(fileHash);
  if (already) {
    // the account this upload asked for may not exist at all - the file was
    // imported under whatever name it was given the first time
    const accountIds = await listImportAccountIds(already.id);
    return {
      outcome: 'duplicate',
      accountId: accountIds[0] ?? accountId,
      accountIds,
      skipped: already.rowsRejected,
      total: already.rowsAccepted + already.rowsRejected,
      importId: already.id,
      uploadedAt: already.uploadedAt,
    };
  }

  // What leaves no `imports` row at all is everything decidable without opening the
  // file: a type the sniffer recognises and refuses, a file past the size cap, a
  // preset that does not exist. Nothing was parsed and nothing could have been
  // written, and `failed` means "an import did not complete", not "the user picked
  // the wrong file". What does leave a failed row is everything the loader has to
  // open the file to discover - a zip that turns out not to be a workbook, a sheet
  // with no header, a PDF that is password-protected or past MAX_PDF_PAGES -
  // because the bytes alone cannot tell. It is the opening that decides the band and
  // not how much was parsed: an encrypted PDF parses nothing either.
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
    // The file itself, before the parse and inside the same catch (ROADMAP 4.5).
    // Before, because the imports that FAILED are precisely the ones support needs
    // the input for - so a failed import keeps its document, and so does a `pending`
    // one left by a process that died between here and the parse.
    //
    // If it cannot be stored the import is refused rather than committed with a
    // warning: committing would claim the file hash forever, and the same bytes
    // would then answer "already imported" on every retry, so the one artefact that
    // cannot be recovered later could never be captured for that file at all. The
    // throw lands in the catch below - a `failed` row with no transactions, and
    // bytes that stay re-uploadable because only `committed` blocks (ROADMAP 4.3).
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
    // sentence saying it could not be (Ruling 4). It reaches the screen in 6b.
    if (parsed.template) logImport.info(`import ${record.id}: read as ${parsed.template}`);
    return await mapAndStore(req, parsed, accountId, record.id, fileHash);
  } catch (e) {
    await failImport(record.id, (e as Error).message);
    throw e;
  }
}

function presetMapping(preset: string | undefined): CsvPresetMapping | null {
  if (!preset || preset === 'generic') return null;
  const known = CSV_PRESETS[preset];
  if (!known) throw new Error(`unknown preset: ${preset}`);
  return known.mapping;
}

/**
 * What a frontend answered with, and what the mapper is to read it against. The
 * preset and the mapping travel with the sheet rather than being read off the
 * request a second time, because for one format they are not the request's to
 * decide - see the pdf arm below.
 */
interface ParsedFile {
  sheet: Sheet;
  preset: CsvPresetMapping | null;
  mapping: Partial<CsvMapping> | undefined;
  /** which template read it, for the log - only the PDF path has one */
  template?: string;
}

/**
 * Exported for the test, like noRowsParsed below and for the same reason - the
 * `never` default is worth nothing unless something has watched it throw, and
 * nothing else can reach it. Not API surface anyone asked for.
 */
export async function readSheet(
  req: StatementImportRequest,
  sourceType: ImportSourceType,
  preset: CsvPresetMapping | null,
): Promise<ParsedFile> {
  switch (sourceType) {
    case 'xlsx':
      return {
        sheet: await readXlsx(req.bytes, (header) => resolveColumns(header, preset, req.mapping)),
        preset,
        mapping: req.mapping,
      };
    case 'csv': {
      const text = decodeCsv(req.bytes);
      const delimiter = req.mapping?.delimiter ?? preset?.delimiter ?? detectDelimiter(text);
      return {
        sheet: { rows: parseCsv(text, delimiter), rowLabel: (i) => i + 1 },
        preset,
        mapping: req.mapping,
      };
    }
    case 'pdf': {
      const parsed = await readPdf(req.bytes, MAX_PDF_PAGES);
      // A PDF's columns come from the template that matched, and from nothing the
      // request said. `preset` names header text and `mapping` names columns, and a
      // PDF has neither for them to name - so a chip the user may not remember
      // picking must not decide whether their statement imports (Ruling 3).
      return {
        sheet: parsed.sheet,
        preset: null,
        mapping: parsed.columns,
        template: parsed.template,
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
  dateCol: number;
  amountCol: number;
  descCols: number[];
  currencyCol: number;
  /** the accepted values folded once here, so the row loop compares and nothing else */
  onlyWhen: { col: number; column: string; accepted: ReadonlySet<string> } | null;
}

type Resolved = { ok: true; columns: Columns } | { ok: false; error: string };

/** A slot no name filled, and everything that was tried for it. */
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
 * Which column is which, for one header row. The XLSX header scan and the mapper
 * call this same function: a scan with a laxer predicate would settle on a row
 * above the real header, and the mapper would then read every data row against the
 * wrong columns and report a plausible-looking count as a success.
 */
function resolveColumns(
  header: string[],
  preset: CsvPresetMapping | null,
  override: Partial<CsvMapping> | undefined,
): Resolved {
  const unresolved: Unresolved[] = [];
  let mapping: Partial<CsvMapping> | null = null;
  if (preset) {
    const resolved = resolvePreset(preset, header, override);
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

  const colIndex = (slot: string, name: string): number => {
    const i = header.findIndex((h) => fold(h) === fold(name));
    if (i < 0) unresolved.push({ slot, tried: [name] });
    return i;
  };
  const columns: Columns = {
    mapping: effective,
    dateCol: colIndex('date', effective.date),
    amountCol: colIndex('amount', effective.amount),
    descCols: (Array.isArray(effective.description)
      ? effective.description
      : [effective.description]
    ).map((name) => colIndex('description', name)),
    currencyCol: effective.currency ? colIndex('currency', effective.currency) : -1,
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

async function mapAndStore(
  req: StatementImportRequest,
  parsed: ParsedFile,
  accountId: string,
  importId: string,
  fileHash: string,
): Promise<StatementImportResult> {
  const { sheet, preset } = parsed;
  if (sheet.rows.length < 2) throw new Error('the file has no data rows (header only, or empty)');

  const header = sheet.rows[0].map((c) => cellText(c).trim());
  const resolved = resolveColumns(header, preset, parsed.mapping);
  if (!resolved.ok) throw new Error(resolved.error);
  const { mapping, dateCol, amountCol, descCols, currencyCol, onlyWhen } = resolved.columns;

  const total = sheet.rows.length - 1;
  if (total > MAX_DATA_ROWS) {
    throw new Error(
      `the statement has ${total} data rows, more than the ${MAX_DATA_ROWS} this importer reads in one file - split it and upload the parts`,
    );
  }

  const txs: NewTransaction[] = [];
  // a notice is a fact about the file, not a rejected row: it goes in front of the
  // row problems (the client shows the first three) and touches no count. The two
  // are kept apart so that neither has to be recovered from the other by index -
  // an extra notice would silently make problems[0] the wrong kind of sentence
  const notices = sheet.notices ?? [];
  const rowProblems: string[] = [];
  // what the status filter dropped, by the value the file wrote: a half-recognised
  // vocabulary otherwise produces a partial import that reads as a complete one
  const statusSkips = new Map<string, number>();
  let skipped = 0;
  let statusSkipped = 0;

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
        skipped++;
        statusSkipped++;
        statusSkips.set(value, (statusSkips.get(value) ?? 0) + 1);
        continue;
      }
    }
    const date = cellDate(row[dateCol], mapping.dateFormat, sheet.date1904);
    const amount = cellAmount(row[amountCol], mapping.decimal);
    if (date === null || amount === null || amount === 0) {
      skipped++;
      if (notices.length + rowProblems.length < MAX_PROBLEMS) {
        rowProblems.push(describeRow(sheet, i, { dateCol, amountCol, date, amount }));
      }
      continue;
    }
    const description = descCols
      .map((c) => cellText(row[c]).trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ');
    const currency =
      currencyCol >= 0 && cellText(row[currencyCol]).trim()
        ? cellText(row[currencyCol]).trim().toUpperCase()
        : req.currency.toUpperCase();

    txs.push({
      accountId,
      provider: 'upload',
      amount,
      currency,
      date,
      description,
      category: categorize(undefined, description, amount),
    });
  }

  const status: StatusSkips | null =
    onlyWhen && statusSkips.size
      ? { column: onlyWhen.column, counts: statusSkips, skipped: statusSkipped }
      : null;

  if (txs.length === 0) {
    throw new Error(noRowsParsed(skipped, rowProblems, notices, status));
  }

  // The account is deliberately NOT created here. One created now would stand on
  // Overview with a balance of 0 before the user confirmed anything, and would
  // outlive a discard permanently - there is no account delete yet. So the name and
  // the currency go on the `imports` row and the account appears at confirm.
  //
  const newRows = await countNewKeys(txs);
  await stageImport(importId, txs, skipped, {
    name: req.accountName,
    currency: req.currency.toUpperCase(),
  });
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
      accountId,
      accountName: req.accountName,
      accountExists: (await getAccount(accountId)) !== undefined,
      total,
      accepted: txs.length,
      skipped,
      // the aggregate sits ahead of the row problems and inside the three the client
      // renders: a fifth per-row reason after four others refines a picture the user
      // already has, where "some of your rows were dropped, and these are the values
      // that did it" is the only line saying the import is partial at all. The cut
      // cannot reach a notice - one is the most any sheet produces
      problems: [
        ...notices,
        ...(status ? [`${rowCount(status.skipped)} skipped: ${statusReason('the', status)}`] : []),
        ...rowProblems,
      ].slice(0, MAX_PROBLEMS),
      newRows,
      alreadyPresent: txs.length - newRows,
      from: days[0],
      to: days[days.length - 1],
      totals: netByCurrency(txs),
      ...(superseded[0] ? { supersededImportId: superseded[0] } : {}),
    },
  };
}

/**
 * The net movement of the file, per currency. Summed in minor units rather than in
 * decimals for the same reason the database stores them that way - a sum of floats
 * drifts (see money.ts). One line for the overwhelming case; a file with a currency
 * column carries more than one, and a single labelled number would be wrong for it.
 */
function netByCurrency(txs: NewTransaction[]): { currency: string; net: number }[] {
  const cents = new Map<string, number>();
  for (const t of txs) {
    cents.set(t.currency, (cents.get(t.currency) ?? 0) + toCents(t.amount));
  }
  return [...cents.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, sum]) => ({ currency, net: fromCents(sum) }));
}

/**
 * The distinct values the status filter refused, and how many rows each cost.
 *
 * Exported for the budget test, like noRowsParsed below and for the same reason -
 * not API surface anyone asked for.
 */
export interface StatusSkips {
  column: string;
  counts: Map<string, number>;
  skipped: number;
}

const rowCount = (n: number): string => `${n} row${n === 1 ? '' : 's'}`;

/** Cut with a mark, so a value with more behind it does not read as the whole one. */
const bounded = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/**
 * Why rows were filtered out, aggregated - one line however many rows. There is
 * deliberately no second vocabulary of known-bad statuses behind this: it names the
 * values that actually caused skips, so a language nobody has listed yet needs no
 * maintenance to be reported. The values are quoted as the file spelled them, since
 * folding is only for the accept test and two casings of one word are worth seeing.
 */
function statusReason(lead: string, status: StatusSkips): string {
  const entries = [...status.counts.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([value, n]) => `"${bounded(value, STATUS_QUOTE_MAX)}" (${n})`);
  return `${lead} "${bounded(status.column, STATUS_QUOTE_MAX)}" value is not one of the accepted ones - ${statusList(entries)}`;
}

/**
 * As many values as STATUS_LIST_MAX buys, then a count of the rest - cut between
 * whole entries and never inside one, because half a status value names a status the
 * file has not got and sends the reader looking for it. The first entry is always
 * kept: both bounds above are sized so that it and a count fit.
 *
 * At least one entry is a precondition, not a branch: statusReason is reached only
 * when the filter refused something, so an empty list is a caller that has invented
 * a StatusSkips - which only the budget test can do.
 */
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

/**
 * Why nothing parsed, ordered by what yields rather than by what is read first: the
 * client renders the whole of what error_detail keeps (MAX_ERROR_CHARS in
 * web/src/api.ts), so the last clause is the one that gets dropped, not the one that
 * goes unread. The row's own reason is the actionable half - "the amount cells are
 * formulas with no stored result" is something the user can fix, "these rows come
 * from Februar" is not - so the sheet notice is what yields, and only whole. The
 * `problems` array is not reordered: there the notice stays at the head, which is
 * the window the client renders.
 *
 * The status filter owns the reason when it accounts for every skipped row, and only
 * then: "no row could be parsed (72 skipped)" with nothing else said sends the user
 * to the preset chips, and no chip fixes a status value nobody has listed. The two
 * are exclusive - a row dropped for its date or its amount is not one the filter took
 * - so the sentence never carries both and its ceiling stays one clause.
 *
 * Exported for the budget test: what this composes at its extreme is the number
 * xlsx.ts's NOTICE_MAX is subtracted from, and a measurement made by hand is true
 * only on the day it is taken.
 */
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
 * Why a row was dropped. A cell the frontend blanked for a reason of its own - an
 * uncached formula, an #N/A - is reported as that reason rather than as an
 * unreadable value: the generic message sends the user to the preset chips, and no
 * preset can fix a workbook whose amounts were never computed.
 */
function describeRow(
  sheet: Sheet,
  i: number,
  parsed: { dateCol: number; amountCol: number; date: string | null; amount: number | null },
): string {
  const label = sheet.rowLabel(i);
  const row: Cell[] = sheet.rows[i];
  const { dateCol, amountCol } = parsed;

  if (parsed.date === null) {
    const note = sheet.note?.(i, dateCol);
    if (note) return `row ${label}: the date cell ${note}`;
    if (typeof row[dateCol] === 'number') {
      return `row ${label}: the date cell holds the number ${row[dateCol]}, which this parser will not read as a date - format that column as a date and upload again`;
    }
  }
  if (parsed.amount === null) {
    const note = sheet.note?.(i, amountCol);
    if (note) return `row ${label}: the amount cell ${note}`;
  }
  return `row ${label}: could not parse the date "${cellText(row[dateCol])}" or the amount "${cellText(row[amountCol])}"`;
}
