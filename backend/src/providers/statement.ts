/**
 * The one ingestion surface (ROADMAP 5.1): POST /api/imports hands the raw bytes
 * here, this file decides what they are, picks a parser, and pushes the rows
 * through the same pipeline as the bank APIs: insertTransactions -> reclassifyAll
 * -> backfillBaseAmounts. The classifier doesn't care where a transaction came from.
 *
 * An uploaded statement is a provider too, but a push-model one: it has no sync,
 * so it is not in the SYNC_PROVIDERS registry - see providers/provider.ts.
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
import { categorize } from '../categorizer';
import {
  ImportSourceType,
  commitImport,
  createImport,
  failImport,
  findCommittedImportByHash,
  insertTransactions,
  listImportAccountIds,
  recalcAccountBalanceFromTransactions,
  upsertAccount,
} from '../db';
import { NewTransaction } from '../types';
import {
  CSV_PARSER_VERSION,
  CSV_PRESETS,
  CsvMapping,
  decodeCsv,
  detectDelimiter,
  genericMapping,
  parseCsv,
} from './csv';
import { Cell, MAX_DATA_ROWS, Sheet, cellAmount, cellDate, cellText } from './sheet';
import { XLSX_PARSER_VERSION, readXlsx } from './xlsx';

const PARSER_VERSION: Record<ImportSourceType, number> = {
  csv: CSV_PARSER_VERSION,
  xlsx: XLSX_PARSER_VERSION,
};

/** exceljs reads a workbook whole, so the zip and everything it expands to is held at once. */
const MAX_XLSX_BYTES = 10 * 1024 * 1024;

/** How many bytes of a text file are searched for the NUL that says it is not one. */
const NUL_SCAN_BYTES = 8192;

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

export interface StatementImportResult {
  /** accountIds[0], or the requested account when the import owns no rows */
  accountId: string;
  /**
   * Where the rows are. On a duplicate this is the earlier import's accounts,
   * which need not be the account this upload asked for. Empty means the import
   * owns no rows because an earlier one had already written every one of them -
   * not that nothing was imported.
   */
  accountIds: string[];
  /** new transactions */
  inserted: number;
  /** rows skipped (unparsable or filtered out) */
  skipped: number;
  /** total data rows in the file */
  total: number;
  /** the first parsing errors - so the user can see what went wrong */
  problems: string[];
  /** the import this upload created, or the earlier one that already holds the file */
  importId: string;
  /** this file was already imported: nothing was parsed and nothing was written */
  duplicate?: boolean;
  /** when the earlier import happened (duplicates only) */
  uploadedAt?: string;
}

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'account';

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
  if (starts(0x25, 0x50, 0x44, 0x46)) {
    throw new Error(
      'PDF statements are not supported yet - export the statement as CSV or Excel (.xlsx) from your online banking',
    );
  }
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
 * Parses the statement and inserts the transactions. Classification and currency
 * conversion are the caller's job (the endpoint calls reclassifyAll afterwards).
 *
 * Order of operations (ROADMAP 5.1): hash and check before parsing, so a
 * re-upload costs nothing; write the import row before touching transactions, so
 * a failure leaves a failed import rather than nothing at all. The import row is
 * deliberately NOT in a transaction with the parse - a rollback would take the
 * failure record with it.
 *
 * The catch is around the inserts as well as the parse: a throw after some rows
 * have landed leaves them attached to a failed import, which is recoverable
 * (delete it and they go too), where leaving them unattributed would not be.
 */
export async function importStatement(
  req: StatementImportRequest,
): Promise<StatementImportResult> {
  // the prefix is an opaque id, not a claim about the format: one bank uploaded as
  // CSV one month and as XLSX the next has to land in one account, or every
  // overlapping row inserts twice (ROADMAP 4.2)
  const accountId = `csv:${slugify(req.accountName)}`;
  const fileHash = crypto.createHash('sha256').update(req.bytes).digest('hex');

  const already = await findCommittedImportByHash(fileHash);
  if (already) {
    // the account this upload asked for may not exist at all - the file was
    // imported under whatever name it was given the first time
    const accountIds = await listImportAccountIds(already.id);
    return {
      accountId: accountIds[0] ?? accountId,
      accountIds,
      inserted: 0,
      skipped: already.rowsRejected,
      total: already.rowsAccepted + already.rowsRejected,
      problems: [],
      importId: already.id,
      duplicate: true,
      uploadedAt: already.uploadedAt,
    };
  }

  // What leaves no `imports` row at all is everything decidable without opening the
  // file: a type the sniffer recognises and refuses, a workbook past the size cap,
  // a preset that does not exist. Nothing was parsed and nothing could have been
  // written, and `failed` means "an import did not complete", not "the user picked
  // the wrong file". What does leave a failed row is everything the loader has to
  // open the file to discover - a zip that turns out not to be a workbook, a sheet
  // with no header - because the bytes alone cannot tell.
  const sourceType = sniff(req.bytes);
  if (sourceType === 'xlsx' && req.bytes.length > MAX_XLSX_BYTES) {
    throw new Error(
      `the workbook is larger than ${MAX_XLSX_BYTES / 1024 / 1024} MB - export a narrower date range, or save it as CSV`,
    );
  }
  const preset = presetMapping(req.preset);

  const record = await createImport({
    fileHash,
    sourceType,
    parserVersion: PARSER_VERSION[sourceType],
    originalFilename: req.originalFilename,
    uploadedBy: req.uploadedBy,
  });
  try {
    const sheet = await readSheet(req, sourceType, preset);
    return await mapAndStore(req, sheet, preset, accountId, record.id);
  } catch (e) {
    await failImport(record.id, (e as Error).message);
    throw e;
  }
}

function presetMapping(preset: string | undefined): CsvMapping | null {
  if (!preset || preset === 'generic') return null;
  const known = CSV_PRESETS[preset];
  if (!known) throw new Error(`unknown preset: ${preset}`);
  return { ...known.mapping };
}

async function readSheet(
  req: StatementImportRequest,
  sourceType: ImportSourceType,
  preset: CsvMapping | null,
): Promise<Sheet> {
  if (sourceType === 'xlsx') {
    return readXlsx(req.bytes, (header) => resolveColumns(header, preset, req.mapping));
  }
  const text = decodeCsv(req.bytes);
  const delimiter = req.mapping?.delimiter ?? preset?.delimiter ?? detectDelimiter(text);
  return { rows: parseCsv(text, delimiter), rowLabel: (i) => i + 1 };
}

interface Columns {
  mapping: CsvMapping;
  dateCol: number;
  amountCol: number;
  descCols: number[];
  currencyCol: number;
  onlyWhen: { col: number; equals: string } | null;
}

type Resolved = { ok: true; columns: Columns } | { ok: false; error: string };

/**
 * Which column is which, for one header row. The XLSX header scan and the mapper
 * call this same function: a scan with a laxer predicate would settle on a row
 * above the real header, and the mapper would then read every data row against the
 * wrong columns and report a plausible-looking count as a success.
 */
function resolveColumns(
  header: string[],
  preset: CsvMapping | null,
  override: Partial<CsvMapping> | undefined,
): Resolved {
  let mapping = preset;
  if (!mapping) {
    mapping = genericMapping(header);
    if (!mapping && !override?.date) {
      return {
        ok: false,
        error: `could not find date/amount/description columns in the header: ${header.join(', ')} - set a mapping or pick a preset`,
      };
    }
  }
  const effective: CsvMapping = { ...(mapping ?? ({} as CsvMapping)), ...override };
  if (!effective.date || !effective.amount || !effective.description) {
    return { ok: false, error: 'mapping must specify the date, amount and description columns' };
  }

  let missing: string | null = null;
  const colIndex = (name: string): number => {
    const i = header.findIndex((h) => h.toLowerCase() === name.trim().toLowerCase());
    if (i < 0 && missing === null) {
      missing = `column "${name}" is not in the header: ${header.join(', ')}`;
    }
    return i;
  };
  const columns: Columns = {
    mapping: effective,
    dateCol: colIndex(effective.date),
    amountCol: colIndex(effective.amount),
    descCols: (Array.isArray(effective.description)
      ? effective.description
      : [effective.description]
    ).map(colIndex),
    currencyCol: effective.currency ? colIndex(effective.currency) : -1,
    onlyWhen: effective.onlyWhen
      ? { col: colIndex(effective.onlyWhen.column), equals: effective.onlyWhen.equals }
      : null,
  };
  return missing === null ? { ok: true, columns } : { ok: false, error: missing };
}

async function mapAndStore(
  req: StatementImportRequest,
  sheet: Sheet,
  preset: CsvMapping | null,
  accountId: string,
  importId: string,
): Promise<StatementImportResult> {
  if (sheet.rows.length < 2) throw new Error('the file has no data rows (header only, or empty)');

  const header = sheet.rows[0].map((c) => cellText(c).trim());
  const resolved = resolveColumns(header, preset, req.mapping);
  if (!resolved.ok) throw new Error(resolved.error);
  const { mapping, dateCol, amountCol, descCols, currencyCol, onlyWhen } = resolved.columns;

  const total = sheet.rows.length - 1;
  if (total > MAX_DATA_ROWS) {
    throw new Error(
      `the statement has ${total} data rows, more than the ${MAX_DATA_ROWS} this importer reads in one file - split it and upload the parts`,
    );
  }

  const txs: NewTransaction[] = [];
  const problems: string[] = [];
  let skipped = 0;

  for (let i = 1; i < sheet.rows.length; i++) {
    const row = sheet.rows[i];
    if (onlyWhen && cellText(row[onlyWhen.col]).trim() !== onlyWhen.equals) {
      skipped++;
      continue;
    }
    const date = cellDate(row[dateCol], mapping.dateFormat, sheet.date1904);
    const amount = cellAmount(row[amountCol], mapping.decimal);
    if (date === null || amount === null || amount === 0) {
      skipped++;
      if (problems.length < 5) {
        problems.push(describeRow(sheet, i, { dateCol, amountCol, date, amount }));
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

  if (txs.length === 0) {
    throw new Error(
      `no row could be parsed (${skipped} skipped)${problems.length ? ': ' + problems[0] : ''}`,
    );
  }

  await upsertAccount({
    id: accountId,
    provider: 'upload',
    name: req.accountName,
    currency: req.currency.toUpperCase(),
    balance: 0,
  });
  const inserted = await insertTransactions(txs, importId);
  // a statement carries no balance - the best approximation is the sum of the account's transactions
  await recalcAccountBalanceFromTransactions(accountId);
  await commitImport(importId, txs.length, skipped);

  return {
    accountId,
    accountIds: [accountId],
    inserted,
    skipped,
    total,
    problems,
    importId,
  };
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
