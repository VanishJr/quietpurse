/**
 * CSV provider: "any bank" via a statement. POST /api/csv/import takes the CSV
 * text + a column mapping (or a preset name) and pushes the rows through the same
 * pipeline as the bank APIs: insertTransactions -> reclassifyAll ->
 * backfillBaseAmounts. The classifier doesn't care where a transaction came from.
 *
 * CSV takes no part in periodic syncing (it's a push model), so it isn't in
 * SYNC_PROVIDERS - see providers/provider.ts.
 *
 * Deduplication: a CSV row carries no bank reference, so this parser supplies no
 * dedupKey and insertTransactions computes one from the row's stable fields. That
 * requires the whole file to be inserted in one call, which it is - a statement
 * covers whole days, so every group of identical rows arrives complete.
 *
 * Ahead of all that sits the file itself: every import is recorded in `imports`,
 * and a file already imported into this workspace is recognised by its hash and
 * never parsed a second time (ROADMAP 4.3, 4.4).
 */
import crypto from 'crypto';
import { categorize } from '../categorizer';
import {
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

/**
 * Bumped whenever a change here would parse an existing file differently. Nothing
 * reads it yet; it is recorded per import so that re-parsing can be targeted
 * later ("re-run everything below CSV parser v2").
 */
export const CSV_PARSER_VERSION = 1;

// ---------- CSV parsing ----------

/** RFC 4180-compatible parsing: quotes, "" inside quotes, CRLF. */
export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^\ufeff/, ''); // BOM from Excel

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

/** Delimiter picked from the header row: whichever yields more columns. */
export function detectDelimiter(text: string): string {
  const header = text.replace(/^﻿/, '').split(/\r?\n/, 1)[0] ?? '';
  const candidates = [';', ',', '\t'];
  let best = ';';
  let bestCount = 0;
  for (const d of candidates) {
    const count = parseCsv(header, d)[0]?.length ?? 0;
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

// ---------- column mapping ----------

/**
 * Mapping: column names from the file's header (case-insensitive).
 * description can be a list - the columns are joined with a space
 * (Sparkasse: payee + payment purpose).
 */
export interface CsvMapping {
  date: string;
  amount: string;
  description: string | string[];
  /** the row's currency column; if absent, the currency comes from the request */
  currency?: string;
  /**
   * date format: iso = YYYY-MM-DD[ time], dmy = DD.MM.YYYY or DD.MM.YY,
   * auto (default) - whichever of the two the value matches
   */
  dateFormat?: 'iso' | 'dmy' | 'auto';
  /** decimal separator; auto - by the last of . or , in the number */
  decimal?: ',' | '.' | 'auto';
  /** column delimiter; auto - from the header */
  delimiter?: string;
  /** keep only rows where a column equals a value (Revolut: State=COMPLETED) */
  onlyWhen?: { column: string; equals: string };
}

/**
 * Presets for specific banks. generic picks up the usual column names
 * (date/amount/description and their German/Ukrainian variants) - see below.
 */
export const CSV_PRESETS: Record<string, { title: string; mapping: CsvMapping }> = {
  sparkasse: {
    title: 'Sparkasse (CAMT CSV)',
    mapping: {
      date: 'Buchungstag',
      amount: 'Betrag',
      description: ['Beguenstigter/Zahlungspflichtiger', 'Verwendungszweck'],
      currency: 'Waehrung',
      dateFormat: 'dmy',
      decimal: ',',
      delimiter: ';',
    },
  },
  dkb: {
    title: 'DKB (Girokonto CSV)',
    mapping: {
      date: 'Buchungsdatum',
      amount: 'Betrag (€)',
      description: ['Zahlungsempfänger*in', 'Verwendungszweck'],
      dateFormat: 'dmy',
      decimal: ',',
      delimiter: ';',
    },
  },
  revolut: {
    title: 'Revolut (Statement CSV)',
    mapping: {
      date: 'Completed Date',
      amount: 'Amount',
      description: 'Description',
      currency: 'Currency',
      dateFormat: 'iso',
      decimal: '.',
      delimiter: ',',
      onlyWhen: { column: 'State', equals: 'COMPLETED' },
    },
  },
};

/** Candidate column names for the generic preset. */
const GENERIC_CANDIDATES: Record<'date' | 'amount' | 'description' | 'currency', string[]> = {
  date: ['date', 'datum', 'buchungstag', 'дата', 'booking date'],
  amount: ['amount', 'betrag', 'сумма', 'сума', 'value'],
  description: ['description', 'verwendungszweck', 'purpose', 'payee', 'описание', 'опис', 'text'],
  currency: ['currency', 'waehrung', 'währung', 'валюта'],
};

/** generic: look for the usual column names in the header. null = required ones not found. */
export function genericMapping(header: string[]): CsvMapping | null {
  const lower = header.map((h) => h.trim().toLowerCase());
  const find = (candidates: string[]): string | undefined => {
    const i = lower.findIndex((h) => candidates.includes(h));
    return i >= 0 ? header[i] : undefined;
  };
  const date = find(GENERIC_CANDIDATES.date);
  const amount = find(GENERIC_CANDIDATES.amount);
  const description = find(GENERIC_CANDIDATES.description);
  if (!date || !amount || !description) return null;
  return { date, amount, description, currency: find(GENERIC_CANDIDATES.currency) };
}

// ---------- value parsing ----------

/** "1.234,56", "1,234.56", "-1140,57" -> a number. null = not a number. */
export function parseAmount(raw: string, decimal: CsvMapping['decimal'] = 'auto'): number | null {
  let s = raw.trim().replace(/\s| /g, '');
  if (!s) return null;
  let dec = decimal;
  if (dec === 'auto' || dec === undefined) {
    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');
    dec = lastComma > lastDot ? ',' : '.';
  }
  if (dec === ',') {
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    s = s.replace(/,/g, '');
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Row date -> ISO 8601. null = could not be parsed.
 *
 * The default is 'auto', which matters for the generic preset: it detects the columns
 * but knows nothing about the file's locale, and a German statement (05.01.2026) is at
 * least as likely as an ISO one. The two shapes can't be confused — ISO uses dashes and
 * a 4-digit year first, dmy uses dots — so trying both is safe rather than a guess.
 */
export function parseCsvDate(raw: string, format: CsvMapping['dateFormat'] = 'auto'): string | null {
  const s = raw.trim();
  if (!s) return null;

  if (format === 'dmy' || format === 'auto') {
    const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2}(?:\d{2})?)$/);
    if (m) {
      const year = m[3].length === 2 ? `20${m[3]}` : m[3];
      return `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}T00:00:00.000Z`;
    }
    if (format === 'dmy') return null;
  }

  // iso: YYYY-MM-DD, optionally with a time ("2026-01-05 12:34:56")
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const time = m[4] ? `${m[4]}:${m[5]}:${m[6] ?? '00'}` : '00:00:00';
  return `${m[1]}-${m[2]}-${m[3]}T${time}.000Z`;
}

// ---------- import ----------

export interface CsvImportRequest {
  /** the account name in the app ("Sparkasse Giro"); the account id is derived from it */
  accountName: string;
  /** the account's currency (if the file has no currency column) */
  currency: string;
  /** a preset name from CSV_PRESETS; generic - auto-detect the columns */
  preset?: string;
  /** a custom mapping (overrides the preset) */
  mapping?: Partial<CsvMapping>;
  /** the file contents */
  csv: string;
  /** the uploaded file's name, if the caller has one */
  originalFilename?: string;
  /** the signed-in user (recorded on the import, not a foreign key) */
  uploadedBy?: string;
}

export interface CsvImportResult {
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
 * Parses the CSV and inserts the transactions. Classification and currency
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
export async function importCsv(req: CsvImportRequest): Promise<CsvImportResult> {
  const accountId = `csv:${slugify(req.accountName)}`;
  const fileHash = crypto.createHash('sha256').update(Buffer.from(req.csv, 'utf8')).digest('hex');

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

  const record = await createImport({
    fileHash,
    sourceType: 'csv',
    parserVersion: CSV_PARSER_VERSION,
    originalFilename: req.originalFilename,
    uploadedBy: req.uploadedBy,
  });
  try {
    return await parseAndStore(req, accountId, record.id);
  } catch (e) {
    await failImport(record.id, (e as Error).message);
    throw e;
  }
}

async function parseAndStore(
  req: CsvImportRequest,
  accountId: string,
  importId: string,
): Promise<CsvImportResult> {
  const problems: string[] = [];

  let mapping: CsvMapping | null = null;
  if (req.preset && req.preset !== 'generic') {
    const preset = CSV_PRESETS[req.preset];
    if (!preset) throw new Error(`unknown preset: ${req.preset}`);
    mapping = { ...preset.mapping };
  }

  const delimiter =
    req.mapping?.delimiter ?? mapping?.delimiter ?? detectDelimiter(req.csv);
  const rows = parseCsv(req.csv, delimiter);
  if (rows.length < 2) throw new Error('the file has no data rows (header only, or empty)');

  const header = rows[0].map((h) => h.trim());
  if (!mapping) {
    mapping = genericMapping(header);
    if (!mapping && !req.mapping?.date) {
      throw new Error(
        `could not find date/amount/description columns in the header: ${header.join(', ')} - set a mapping or pick a preset`,
      );
    }
  }
  const effective: CsvMapping = { ...(mapping ?? ({} as CsvMapping)), ...req.mapping };
  if (!effective.date || !effective.amount || !effective.description) {
    throw new Error('mapping must specify the date, amount and description columns');
  }

  const colIndex = (name: string): number => {
    const i = header.findIndex((h) => h.toLowerCase() === name.trim().toLowerCase());
    if (i < 0) throw new Error(`column "${name}" is not in the header: ${header.join(', ')}`);
    return i;
  };
  const dateCol = colIndex(effective.date);
  const amountCol = colIndex(effective.amount);
  const descCols = (Array.isArray(effective.description)
    ? effective.description
    : [effective.description]
  ).map(colIndex);
  const currencyCol = effective.currency ? colIndex(effective.currency) : -1;
  const onlyWhen = effective.onlyWhen
    ? { col: colIndex(effective.onlyWhen.column), equals: effective.onlyWhen.equals }
    : null;

  const txs: NewTransaction[] = [];
  let skipped = 0;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (onlyWhen && (row[onlyWhen.col] ?? '').trim() !== onlyWhen.equals) {
      skipped++;
      continue;
    }
    const date = parseCsvDate(row[dateCol] ?? '', effective.dateFormat);
    const amount = parseAmount(row[amountCol] ?? '', effective.decimal);
    if (date === null || amount === null || amount === 0) {
      skipped++;
      if (problems.length < 5) {
        problems.push(`row ${i + 1}: could not parse the date "${row[dateCol]}" or the amount "${row[amountCol]}"`);
      }
      continue;
    }
    const description = descCols
      .map((c) => (row[c] ?? '').trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ');
    const currency =
      currencyCol >= 0 && (row[currencyCol] ?? '').trim()
        ? row[currencyCol].trim().toUpperCase()
        : req.currency.toUpperCase();

    txs.push({
      accountId,
      provider: 'csv',
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
    provider: 'csv',
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
    total: rows.length - 1,
    problems,
    importId,
  };
}
