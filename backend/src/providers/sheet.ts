import { CsvMapping, parseAmount, parseCsvDate } from './csv';

export type Cell = string | number | Date | null;

export interface Sheet {
  rows: Cell[][];
  rowLabel: (i: number) => number;
  note?: (row: number, col: number) => string | undefined;
  notices?: string[];
  /** the workbook's date system: serial day 0 is 1904-01-01, not 1899-12-30 */
  date1904?: boolean;
}

export const MAX_DATA_ROWS = 50_000;

export function cellText(c: Cell | undefined): string {
  if (c === null || c === undefined) return '';
  if (c instanceof Date) return c.toISOString().slice(0, 10);
  return String(c);
}

/** false = nothing but formatting; such a row never reaches the mapper's counts. */
export const hasContent = (row: Cell[]): boolean =>
  row.some((c) => cellText(c).trim() !== '');

/**
 * Excel serial -> instant. Day 0 is 1899-12-30 (1904-01-01 in the Mac 1904 date
 * system, 1462 days later). exceljs applies this itself to a cell formatted as a
 * date; a General-formatted date column comes back as a plain number and lands here.
 */
const serialToDate = (serial: number, date1904 = false): Date =>
  new Date(Math.round((serial - 25569 + (date1904 ? 1462 : 0)) * 86400000));

/**
 * Serials a date column can plausibly hold: 1954 to 2119. A number outside it is one
 * the user meant as a number: a statement writing the date as 20260105 must not be
 * read as the year 57424.
 */
const SERIAL_MIN = 20000;
const SERIAL_MAX = 80000;

/**
 * Row date -> ISO 8601. null = the cell holds no date this parser can read.
 *
 * UTC throughout: local-time getters shift the calendar day by one for half the
 * world's timezones, and the shifted day goes into the dedup key. The same statement
 * re-imported from another machine would then duplicate every row.
 */
export function cellDate(
  c: Cell | undefined,
  format: CsvMapping['dateFormat'],
  date1904?: boolean,
): string | null {
  if (c === null || c === undefined) return null;
  if (c instanceof Date) return c.toISOString();
  if (typeof c === 'number') {
    return c >= SERIAL_MIN && c <= SERIAL_MAX ? serialToDate(c, date1904).toISOString() : null;
  }
  return parseCsvDate(c, format);
}

/**
 * Row amount -> a decimal number. A numeric cell is passed through untouched and
 * never re-parsed as text: insertTransactions rounds it with toCents, which is the
 * one place that knows 12.339999999999999 is 12.34.
 */
export function cellAmount(c: Cell | undefined, decimal: CsvMapping['decimal']): number | null {
  if (typeof c === 'number') return Number.isFinite(c) ? c : null;
  if (typeof c === 'string') return parseAmount(c, decimal);
  return null;
}
