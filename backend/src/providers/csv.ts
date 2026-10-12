
/** Bumped whenever a change here would parse an existing file differently. */
export const CSV_PARSER_VERSION = 4;

/**
 * The uploaded bytes as text. Two decoders and no charset detection: a BOM is
 * believed, otherwise UTF-8 is tried in fatal mode and a hard failure - which no
 * valid UTF-8 file can produce - falls back to windows-1252, the encoding German
 * bank exports actually use. Guessing by frequency would be worse, and getting it
 * wrong is cosmetic anyway: the description is not part of the dedup key.
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
  /**
   * keep only rows where a column holds one of these values (Revolut:
   * State=COMPLETED). A list because one bank ships one export in several
   * languages; the comparison is folded, so case is not part of it
   */
  onlyWhen?: { column: string; equals: string | string[] };
}

/** A list that cannot be empty: an accepted-name list with no names matches nothing. */
type NonEmpty<T> = readonly [T, ...T[]];

export interface CsvPresetMapping {
  readonly date: NonEmpty<string>;
  readonly amount: NonEmpty<string>;
  readonly description: NonEmpty<NonEmpty<string>>;
  readonly currency?: NonEmpty<string>;
  readonly fee?: NonEmpty<string>;
  readonly balance?: {
    readonly column: NonEmpty<string>;
    /** absent = the file states one running balance for the whole statement */
    readonly series?: NonEmpty<string>;
  };
  readonly dateFormat?: CsvMapping['dateFormat'];
  readonly decimal?: CsvMapping['decimal'];
  readonly delimiter?: string;
  readonly onlyWhen?: { readonly column: NonEmpty<string>; readonly equals: NonEmpty<string> };
}

export const CSV_PRESETS: Record<string, { title: string; mapping: CsvPresetMapping }> = {
  sparkasse: {
    title: 'Sparkasse (CAMT CSV)',
    mapping: {
      date: ['Buchungstag'],
      amount: ['Betrag'],
      description: [['Beguenstigter/Zahlungspflichtiger'], ['Verwendungszweck']],
      currency: ['Waehrung'],
      dateFormat: 'dmy',
      decimal: ',',
      delimiter: ';',
    },
  },
  dkb: {
    title: 'DKB (Girokonto CSV)',
    mapping: {
      date: ['Buchungsdatum'],
      amount: ['Betrag (€)'],
      description: [['Zahlungsempfänger*in'], ['Verwendungszweck']],
      dateFormat: 'dmy',
      decimal: ',',
      delimiter: ';',
    },
  },
  revolut: {
    title: 'Revolut (Statement CSV)',
    mapping: {
      date: ['Completed Date', 'Дата выполнения'],
      amount: ['Amount', 'Сумма'],
      description: [['Description', 'Описание']],
      currency: ['Currency', 'Валюта'],
      // stated on top of Amount, never inside it: the amount less the fee is what
      // reproduces both halves the PDF of the same month prints about itself, where the
      // amount alone is short by exactly the fees on the outgoing side
      fee: ['Fee', 'Комиссия'],
      // the series column beside it is not a convenience: one file states two running
      // balances under one column, and a check that inferred the split from the numbers
      // could not tell a second product from a lost row
      balance: { column: ['Balance', 'Остаток средств'], series: ['Product', 'Продукт'] },
      dateFormat: 'iso',
      decimal: '.',
      delimiter: ',',
      // the Russian export leaves this column named in English and translates its
      // values, which is why the shape is a name list and a value list, not a preset
      // per language
      onlyWhen: { column: ['State'], equals: ['COMPLETED', 'ВЫПОЛНЕНО'] },
    },
  },
};

/**
 * Case-folding for every column and status comparison in the importer, both sides of
 * it. toLowerCase and never toLocaleLowerCase: the latter maps I to a dotless ı under
 * a Turkish locale, and every English header would stop matching on a server whose
 * locale someone changed.
 */
export const fold = (s: string): string => s.trim().toLowerCase();

/**
 * The first accepted name the header carries, answered in the file's own spelling.
 *
 * Whole-cell equality, never a prefix or a substring: "Дата начала" is when a Revolut
 * transaction *started* and sits two columns from "Дата выполнения", so a matcher that
 * settles for a prefix imports dates that can be days off - and the date is in the
 * dedup key, so re-importing after the mistake is found duplicates the
 * statement rather than recognising it.
 *
 * The candidate list breaks a tie, not the header's order: the list's author knows
 * which name is the true one, where column order is the bank's arbitrary choice.
 */
export function matchColumn(
  header: readonly string[],
  candidates: readonly string[],
): string | undefined {
  const folded = header.map(fold);
  for (const name of candidates) {
    const i = folded.indexOf(fold(name));
    if (i >= 0) return header[i];
  }
  return undefined;
}

/**
 * Candidate column names for the generic preset.
 *
 * Deliberately no fee, and it is not an omission to tidy up: the generic mapper runs
 * against banks nobody here has measured, and a guessed fee column that a bank in
 * fact already includes in its amount gets subtracted a second time - on every row of
 * every file from that bank, in silence, with no gate on this path to notice. A fee
 * is declared by a preset whose file a human has read, and nowhere else.
 */
const GENERIC_CANDIDATES: Record<'date' | 'amount' | 'description' | 'currency', string[]> = {
  // 'дата выполнения' sits before 'дата' and the position is load-bearing: candidate
  // order decides a tie, so the general name ahead of the specific one takes the
  // *started* date out of a Revolut-shaped header. Appending a name here for tidiness
  // is how that silently comes back.
  date: ['date', 'datum', 'buchungstag', 'дата выполнения', 'дата', 'booking date'],
  amount: ['amount', 'betrag', 'сумма', 'сума', 'value'],
  description: ['description', 'verwendungszweck', 'purpose', 'payee', 'описание', 'опис', 'text'],
  currency: ['currency', 'waehrung', 'währung', 'валюта'],
};

/** generic: look for the usual column names in the header. null = required ones not found. */
export function genericMapping(header: string[]): CsvMapping | null {
  const date = matchColumn(header, GENERIC_CANDIDATES.date);
  const amount = matchColumn(header, GENERIC_CANDIDATES.amount);
  const description = matchColumn(header, GENERIC_CANDIDATES.description);
  if (!date || !amount || !description) return null;
  return { date, amount, description, currency: matchColumn(header, GENERIC_CANDIDATES.currency) };
}

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
 * Row date -> ISO 8601. null = the text has no date shape. A shape whose day or time does
 * not exist (30.02.2026, 25:99) comes back as read: mapAndStore refuses the whole import
 * over it, where a null here would drop that one row and import the rest.
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
