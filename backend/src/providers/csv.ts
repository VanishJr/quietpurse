/**
 * CSV frontend: the text side of a statement - decoding, RFC 4180 parsing, the
 * column mapping and the presets. The rows go on to the shared seam and from there
 * through providers/statement.ts, which owns the file, the import record and the
 * pipeline.
 *
 * Everything below works on strings and knows nothing about how the bytes arrived.
 */

/**
 * Bumped whenever a change here would parse an existing file differently. Nothing
 * reads it yet; it is recorded per import so that re-parsing can be targeted
 * later ("re-run everything below CSV parser v2").
 */
export const CSV_PARSER_VERSION = 1;

// ---------- decoding ----------

/**
 * The uploaded bytes as text. Two decoders and no charset detection: a BOM is
 * believed, otherwise UTF-8 is tried in fatal mode and a hard failure - which no
 * valid UTF-8 file can produce - falls back to windows-1252, the encoding German
 * bank exports actually use. Guessing by frequency would be worse, and getting it
 * wrong is cosmetic anyway: the description is not part of the dedup key (4.2).
 *
 * The hash is over the raw bytes, never over the result of this.
 */
export function decodeCsv(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

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
