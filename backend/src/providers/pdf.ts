/**
 * A statement PDF in, a Sheet out - the same seam the CSV and XLSX frontends hand their
 * rows to, so the same statement imported as a PDF and as a CSV produces the same
 * transactions.
 *
 * A PDF has glyphs at coordinates, handed back in the order the generator drew them,
 * which is not the order they are read in: two columns of a statement interleave in
 * getTextContent's array, and a row assembled from array position gives a transaction
 * whose amount belongs to its neighbour - parsed, accepted, plausible and wrong. So
 * everything below groups by coordinate and never by position.
 *
 * Which coordinate means which column is a TEMPLATE, per layout rather than per bank,
 * and there is no way to derive one: it is measured off a document somebody has had in
 * front of them, and nothing in this repository checks a template against a second
 * document. A layout no template matches is refused by name rather than read against
 * the nearest fit - a template that matches too eagerly reports plausible numbers,
 * which is the one outcome worse than a refusal.
 */
import { toCents } from '../money';
import { CsvMapping, parseAmount } from './csv';
import { ISSUERS, issuerName } from './issuer';
import { loadPdfjs } from './pdfjsloader';
import { Cell, Sheet, cellText } from './sheet';

/** Bumped whenever a change here would parse an existing file differently. */
export const PDF_PARSER_VERSION = 6;

export interface StatementBalances {
  openingCents: number;
  closingCents: number;
  /** what each side came to, on the rows' own convention: outgoing negative */
  gross:
    | { kind: 'printed'; outgoingCents: number; incomingCents: number }
    | { kind: 'not-printed' };
  currency: string;
}

export interface PdfStatement {
  sheet: Sheet;
  template: string;
  title: string;
  columns: Partial<CsvMapping>;
  fee: PdfFee;
  balances: StatementBalances;
}

export type PdfFee = { kind: 'none' } | { kind: 'included'; col: number };

const MIN_CHARS_PER_PAGE = 50;

/**
 * The whole of what a note may spend ON THIS PATH: 132 under a five-digit label
 * composes exactly the 159 derived above statement.ts's CELL_QUOTE_MAX. The budget is
 * per path and this is not the smallest - the same 132 under xlsx's six digits is 160.
 */
export const NOTE_MAX = 132;

const CELL_QUOTE_MAX = 24;

const ENCRYPTED =
  'this PDF is password-protected - open it with its password and save an unprotected copy, or download the statement again from your online banking';

const NOT_A_PDF =
  'this file looks like a PDF but could not be opened as one - download the statement again from your online banking, or export it as CSV or Excel (.xlsx)';

const NOT_RECOGNISED_TAIL =
  'layout is not one this importer recognises yet - export the same statement as CSV or Excel (.xlsx) from the same online banking and upload that; those import today';

const NOT_RECOGNISED = `this statement's ${NOT_RECOGNISED_TAIL}`;

const notRecognisedFrom = (name: string): string =>
  `this looks like a statement from ${name}, and its ${NOT_RECOGNISED_TAIL}`;

const SCANNED =
  'this looks like a scan - this importer reads the text layer of a PDF and this one has none; download the statement again from your online banking, or export it as CSV or Excel (.xlsx)';

const ambiguousLayout = (titles: string[]): string =>
  `this statement matches more than one of the layouts this importer knows (${titles.map(quote).join(' and ')}) - export the same statement as CSV or Excel (.xlsx) from your online banking and upload that; those import today`;

const tooManyPages = (pages: number, max: number): string =>
  `this PDF has ${pages} pages, more than the ${max} this importer reads in one file - export a narrower date range, or export the statement as CSV or Excel (.xlsx)`;

const tookTooLong = (read: number, pages: number, seconds: number): string =>
  `this PDF was taking longer than ${seconds} seconds to read, so reading it was stopped after ${read} of its ${pages} pages - it may simply be a very large statement; export a narrower date range, or export the statement as CSV or Excel (.xlsx) from your online banking and upload that`;

const unreadableTable = (title: string, cell: string): string =>
  `this ${title} statement has a table this importer cannot read (${cell}) - export the same statement as CSV or Excel (.xlsx) from your online banking and upload that`;

const noTransactionLines = (title: string): string =>
  `this ${title} statement has no transaction lines in it - if the statement is really empty then nothing is missing; otherwise export it as CSV or Excel (.xlsx) from your online banking`;

const noBalanceBox = (title: string, label: string, found: number): string =>
  `this ${title} statement has a balance summary this importer could not read: it expects exactly one "${label}" line and found ${found} - export the same statement as CSV or Excel (.xlsx) from your online banking and upload that`;

const unplacedBalanceBox = (title: string, opens: string): string =>
  `this ${title} statement's balance summary is one this importer could not place: it reads the summary of the section headed "${opens}", and this document prints no such heading - export the same statement as CSV or Excel (.xlsx) from your online banking and upload that`;

const noStatementPeriod = (title: string, found: number): string =>
  `this ${title} statement's rows carry a day and a month and no year, so this template reads the year off the period the statement covers - and it expects exactly one such line and found ${found} - export the same statement as CSV or Excel (.xlsx) from your online banking and upload that`;

const twoFeeLines = (title: string, label: string): string =>
  `this ${title} statement prints more than one "${label}" line under one transaction, where this template reads one fee per transaction - export the same statement as CSV or Excel (.xlsx) from your online banking and upload that`;

const unreadableFee = (title: string, label: string, cell: string, example: string): string =>
  `this ${title} statement's "${label}" line reads ${quote(cell)} after its label, where this template reads an amount like "${example}" - export the same statement as CSV or Excel (.xlsx) from your online banking and upload that`;

type BalanceRole = 'opening balance' | 'closing balance' | 'outgoing total' | 'incoming total';

const ROLES: readonly BalanceRole[] = [
  'opening balance',
  'closing balance',
  'outgoing total',
  'incoming total',
];

const unreadableBalance = (
  title: string,
  which: BalanceRole,
  label: string,
  cell: string,
  example: string,
): string =>
  `this ${title} statement's ${which} cell reads ${quote(cell)} on its "${label}" line, where this template reads an amount like "${example}" - export the same statement as CSV or Excel (.xlsx) from your online banking and upload that`;

const mixedBalanceCurrencies = (
  title: string,
  a: { role: BalanceRole; label: string; currency: string },
  b: { role: BalanceRole; label: string; currency: string },
): string =>
  `this ${title} statement's ${a.role} (${quote(a.label)}) is stated in ${a.currency} and its ${b.role} (${quote(b.label)}) in ${b.currency} - this importer cannot check a statement that mixes currencies; export the same statement as CSV or Excel (.xlsx) from your online banking and upload that`;

const bounded = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

const quote = (text: string): string => `"${bounded(text, CELL_QUOTE_MAX)}"`;

/** [left, right) in PDF user units. An item is assigned by the x of its left edge. */
type Span = readonly [number, number];

interface RowCells {
  date: string;
  description: string;
}

type DebitCreditHeader = Readonly<{
  date: string;
  description: string;
  debit: string;
  credit: string;
}>;

type SignedHeader = Readonly<{ date: string; description: string; amount: string }>;

interface DebitCreditTable {
  header: DebitCreditHeader;
  collect: boolean;
}

interface SignedTable {
  header: SignedHeader;
  collect: boolean;
}

type TableLayout =
  | {
      amounts: 'debit-credit';
      columns: Readonly<{ date: Span; description: Span; debit: Span; credit: Span }>;
      tables: readonly DebitCreditTable[];
    }
  | {
      amounts: 'signed';
      columns: Readonly<{ date: Span; description: Span; amount: Span }>;
      tables: readonly SignedTable[];
    };

type AmountCurrency =
  | { kind: 'in-the-cell'; symbols: Readonly<Record<string, string>> }
  | { kind: 'per-column'; code: string };

interface AmountFormat {
  /** group 1 the number; group 2 the currency symbol, on the `in-the-cell` arm only */
  pattern: RegExp;
  decimal: CsvMapping['decimal'];
  currency: AmountCurrency;
  example: string;
}

type RowExtent =
  | { kind: 'one-line' }
  | { kind: 'continuations'; drop: readonly string[] }
  | { kind: 'labelled-continuations'; keep: readonly string[] };

/**
 * Where this layout prints a per-transaction fee, and what that fee is against the
 * amount on the dated line above it.
 *
 * `included` is the whole vocabulary measured - the dated line's amount IS the movement
 * and the fee sits inside it - so a layout whose fee is taken ON TOP is not writable at
 * all rather than spelled by omission. That is deliberate: the sheet path already has
 * that convention, the two corrupt money in opposite directions, and an author who meets
 * an on-top PDF has to add an arm HERE and is dragged by tsc into adding its case at the
 * mapper in the same edit.
 *
 * The fee's number is in the LABEL'S OWN CELL and not in an amount column: on the layout
 * measured the amount column of a fee line carries the merchant's share of the charge, so
 * a reader taking that column stores a fee that is almost the whole movement, and no
 * CHECK, no gate and no screen can see it.
 */
type FeeLine = { kind: 'none' } | { kind: 'included'; label: string };

type GrossSigns = 'signed' | 'magnitudes';

type NoGrossTotals = { kind: 'not-printed' };

type GrossSpans =
  | { kind: 'printed'; signs: GrossSigns; outgoing: Span; incoming: Span }
  | NoGrossTotals;

type GrossLabels =
  | { kind: 'printed'; signs: GrossSigns; outgoing: string; incoming: string }
  | NoGrossTotals;

type BalanceScope =
  | { kind: 'whole-document' }
  | {
      kind: 'section';
      opens: string;
      closes: readonly [string, ...string[]];
    };

/**
 * Where the layout states the statement's own opening and closing balance, and what each
 * side came to, for the whole document rather than for one of its products.
 *
 * The two balances have no variant meaning "this layout states none": that is what would
 * let a template author who could not find the box write it away, and the weakest parser
 * in the product would then ship with its only check switched off by a data literal - on
 * exactly the layouts whose author was least sure of what they were reading. A document
 * that does not state its balances is refused by simply not being a template.
 *
 * `gross` is the one place that argument does not reach, so it has a named arm saying
 * this layout prints no per-side totals.
 *
 * `scope` and `gross` are nested here rather than sitting beside `balances` on
 * PdfTemplate because both are resolved at the `label` span this node declares, and a
 * span declared on one node and read from another is a cross-field inconsistency tsc
 * cannot see. Spans against a two-lines box would be x-intervals with no line to read
 * them off; nested, they cannot be written.
 */
type BalanceBox = { scope: BalanceScope } & (
  | {
      kind: 'one-line';
      total: string;
      label: Span;
      opening: Span;
      closing: Span;
      gross: GrossSpans;
    }
  | {
      kind: 'two-lines';
      label: Span;
      value: Span;
      opening: string;
      closing: string;
      gross: GrossLabels;
    }
);

export type PdfTemplate = TableLayout & {
  id: string;
  title: string;
  issuer: readonly string[];
  marker: { column: keyof RowCells; text: string };
  dates: DateSource;
  amount: AmountFormat;
  rows: RowExtent;
  fee: FeeLine;
  balances: BalanceBox;
};

type DateFormat = 'ru-abbrev' | 'de-numeric' | 'de-day-month-pair';

type DateSource =
  | { format: 'ru-abbrev' | 'de-numeric' }
  /**
   * it does not, and this is where the year is read from instead: the one line of the
   * balance box's scope whose whole text is the period the statement covers. Groups 1..3
   * are the first day, month and year; 4..6 the last. No `g` and no `y` flag - this is
   * matched once per line over the whole scope, and a sticky or global regex keeps
   * `lastIndex` and answers true, false, true for the same line.
   */
  | { format: 'de-day-month-pair'; period: RegExp };

/**
 * Groups 1..3 of `shape` are the day, the month and the year, in that order, in every
 * vocabulary whose cell carries a year - stated once here rather than per entry, because
 * it is what readDate below reads them as. A `no-year` vocabulary states its own group
 * order in its own entry.
 *
 * `shape` is also what decides whether a line is a transaction at all - one regex rather
 * than two, or the anchor and the parser drift and a line that looks like a row is
 * dropped as furniture. A line that matches the shape and not the month table is a
 * SKIPPED row with a reason, never a dropped one.
 */
type DateVocabulary =
  | { kind: 'named-month'; shape: RegExp; months: Readonly<Record<string, number>> }
  | { kind: 'numeric'; shape: RegExp }
  | { kind: 'no-year'; shape: RegExp };

const DATE_FORMATS = {
  // Never Intl at parse time: a Node built with small-icu has no ru data, and a date
  // that parses on one machine and not another duplicates a statement rather than
  // recognising it.
  'ru-abbrev': {
    kind: 'named-month',
    shape: /^(\d{1,2}) (\S+) (\d{4})г\.$/u,
    months: {
      'янв.': 1,
      'февр.': 2,
      'мар.': 3,
      'апр.': 4,
      мая: 5,
      'июн.': 6,
      'июл.': 7,
      'авг.': 8,
      'сент.': 9,
      'окт.': 10,
      'нояб.': 11,
      'дек.': 12,
    },
  },
  'de-numeric': { kind: 'numeric', shape: /^(\d{2})\.(\d{2})\.(\d{4})$/u },
  // Groups 1 and 2 are the BOOKING day and month, which is what every date on that
  // layout's statement is defined on; groups 3 and 4 are the value date and are read by
  // nothing. They are in the shape rather than left out of it so that a row printing only
  // one of the two is not a transaction at all. The whole cell is matched, which is what
  // stops a wider date column turning a description into a row.
  'de-day-month-pair': { kind: 'no-year', shape: /^(\d{2})\.(\d{2})\. (\d{2})\.(\d{2})\.$/u },
} satisfies Record<DateFormat, DateVocabulary>;

/**
 * UTC throughout and never `new Date(string)`: the calendar day goes into the dedup key,
 * and a local-time parse shifts it by one for half the world's timezones - so the same
 * statement imported from another machine would duplicate every row.
 *
 * The round trip is the check that the components are a real date: Date.UTC rolls 31
 * February over into March rather than refusing it. One function, so the two callers - a
 * cell that carries its year and a period line that carries two - cannot come to disagree
 * about which day-month pairs exist.
 */
function utcDate(day: number, month: number, year: number): Date | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCDate() === day && date.getUTCMonth() === month - 1 ? date : null;
}

function readDate(
  vocabulary: Exclude<DateVocabulary, { kind: 'no-year' }>,
  m: RegExpExecArray,
): Date | null {
  const month = vocabulary.kind === 'named-month' ? vocabulary.months[m[2]] : Number(m[2]);
  if (month === undefined) return null;
  return utcDate(Number(m[1]), month, Number(m[3]));
}

interface StatementPeriod {
  text: string;
  from: Date;
  to: Date;
}

interface DateReader {
  shape: RegExp;
  read: (m: RegExpExecArray) => { date: Date } | { date: null; note: string };
}

const cannotRead = (m: RegExpExecArray): { date: null; note: string } => ({
  date: null,
  note: `reads ${quote(m[0])}, which this template cannot read as a date`,
});

function statementPeriod(
  template: PdfTemplate,
  period: RegExp,
  scoped: TextLine[],
): StatementPeriod {
  const found = new Map<string, StatementPeriod>();
  for (const line of scoped) {
    const m = period.exec(line.items.map((i) => i.text).join(' '));
    if (!m) continue;
    const from = utcDate(Number(m[1]), Number(m[2]), Number(m[3]));
    const to = utcDate(Number(m[4]), Number(m[5]), Number(m[6]));
    if (from && to && from <= to) found.set(m[0], { text: m[0], from, to });
  }
  if (found.size !== 1) throw new Error(noStatementPeriod(template.title, found.size));
  return [...found.values()][0];
}

/**
 * The year of a row whose cell carries none: the ONE year in the period's own range for
 * which the day and month are a real date inside the period. Zero or more than one is no
 * date at all - a skipped row with a note - and there is no fallback, no walk back a year
 * and no default to the period's end year. The gate sums amounts and cannot see a date,
 * so a row given the wrong year reconciles to the cent, imports, and lands in the wrong
 * month on the Transactions screen, in the analytics buckets and in the dedup key. A
 * skipped row makes the sum short and doesNotAddUp refuses out loud.
 *
 * Both ends of the period are INCLUSIVE. A bank books its interest and its fees on the
 * period's last day by construction, so an exclusive comparison would skip every such row
 * and refuse the import of documents that are perfectly correct.
 */
const inPeriod = (
  m: RegExpExecArray,
  period: StatementPeriod,
): { date: Date } | { date: null; note: string } => {
  const day = Number(m[1]);
  const month = Number(m[2]);
  const found: Date[] = [];
  for (let year = period.from.getUTCFullYear(); year <= period.to.getUTCFullYear(); year++) {
    const date = utcDate(day, month, year);
    if (date && date >= period.from && date <= period.to) found.push(date);
  }
  if (found.length === 1) return { date: found[0] };
  return {
    date: null,
    note:
      found.length === 0
        ? `reads ${quote(m[0])}, which this statement's period (${period.text}) does not contain`
        : `reads ${quote(m[0])}, which this statement's period (${period.text}) contains in more than one year`,
  };
};

function dateReader(template: PdfTemplate, scoped: TextLine[]): DateReader {
  const { dates } = template;
  if (dates.format === 'de-day-month-pair') {
    const period = statementPeriod(template, dates.period, scoped);
    return {
      shape: DATE_FORMATS[dates.format].shape,
      read: (m) => inPeriod(m, period),
    };
  }
  const vocabulary = DATE_FORMATS[dates.format];
  return {
    shape: vocabulary.shape,
    read: (m) => {
      const date = readDate(vocabulary, m);
      return date === null ? cannotRead(m) : { date };
    },
  };
}

/**
 * The synthetic header the mapper resolves, and the mapping that names it, from one set
 * of names so the two cannot drift.
 *
 * The `pdf:` spelling is deliberate and is the opposite of a tidy choice. Named
 * `date`/`amount`/`description` the header would also resolve through genericMapping, so
 * dropping the override would leave the path working and the rule "a PDF's columns come
 * from the template" silently vacuous. Prefixed, nothing but the override can resolve
 * them and dropping it produces a loud refusal.
 */
const HEADER = ['pdf:date', 'pdf:amount', 'pdf:description', 'pdf:currency', 'pdf:fee'];
const DATE = 0;
const AMOUNT = 1;
const DESCRIPTION = 2;
const CURRENCY = 3;
const FEE = 4;

/**
 * The fee is deliberately absent: COLUMNS is a Partial<CsvMapping> and CsvMapping has no
 * `fee`. The mapper is told which cell carries one by PdfStatement.fee, which carries the
 * convention with it - a name here would be a column resolved twice and a convention
 * resolved nowhere.
 */
const COLUMNS: Partial<CsvMapping> = {
  date: HEADER[DATE],
  amount: HEADER[AMOUNT],
  description: HEADER[DESCRIPTION],
  currency: HEADER[CURRENCY],
};

/**
 * A switch with one case per arm and NO default, and that is the whole reason this is a
 * function rather than an expression at the return. The two-way ternary it replaced is
 * silent under tsc the day FeeLine gains an arm, and an on-top layout would then be
 * handed to the mapper declared `included`: its fee never subtracted, every fee-bearing
 * row's movement wrong by its fee, and reconcile unable to see it because the amounts the
 * document printed still agree. Without a default, a new arm makes the endpoint reachable
 * and tsc refuses this function (TS2366).
 */
function feeOf(fee: FeeLine): PdfFee {
  switch (fee.kind) {
    case 'none':
      return { kind: 'none' };
    case 'included':
      return { kind: 'included', col: FEE };
  }
}

export interface TextLine {
  page: number;
  y: number;
  items: { x: number; text: string }[];
}

/**
 * How far two baselines may sit apart and still be one line.
 *
 * What a row splitting in two costs is silent: the date and the amount would form their
 * own line, that line's date cell still matches the shape, and the transaction imports
 * with the right day, the right amount and an empty description - reconciling to the
 * cent.
 *
 * Not a template field, though it is a fact about a layout: the grouping is what a
 * template is matched against, so it is fixed before any template is known.
 */
const TOLERANCE = 2;

/**
 * What bounds a parse, in one object because two bare numbers in a row transpose silently.
 * Total, so a bound added later breaks every call site rather than inheriting a value
 * nobody chose.
 */
export interface PdfLimits {
  maxPages: number;
  deadlineMs: number;
}

/**
 * The document's text, one array of lines in reading order.
 *
 * Grouped by baseline and not by array position (see the file header), then sorted by
 * descending y because a PDF's origin is the bottom left, and within a line by ascending
 * x. pdfjs emits a zero-height whitespace item between placed runs; those are dropped
 * before grouping, or they decide a line's baseline.
 */
async function readLines(
  bytes: Buffer,
  limits: PdfLimits,
): Promise<{ lines: TextLine[]; pages: number; chars: number }> {
  // Read before anything is loaded, so a document that is slow to open spends the budget
  // rather than escaping it. Compared against on this function's own code path and never
  // raced with a timer: whether the event loop turns during a parse is a property of the
  // document, and the uploader chooses the document.
  const deadline = performance.now() + limits.deadlineMs;
  const { getDocument, PasswordException, VerbosityLevel } = await loadPdfjs();
  // A copy, not a view: getDocument detaches the array it is given, and a small Node
  // Buffer is a window onto a shared pool that other allocations sit in. It refuses a
  // Buffer outright for the same reason.
  const task = getDocument({
    data: new Uint8Array(bytes),
    verbosity: VerbosityLevel.ERRORS,
  });
  try {
    const doc = await task.promise.catch((e: unknown) => {
      throw new Error(e instanceof PasswordException ? ENCRYPTED : NOT_A_PDF);
    });
    const pages = doc.numPages;
    if (pages > limits.maxPages) throw new Error(tooManyPages(pages, limits.maxPages));

    const seconds = Math.round(limits.deadlineMs / 1000);
    // Expiry throws rather than destroying the task. destroy() resolves while the getPage or
    // getTextContent it interrupted settles neither way, so the frame suspended at that await
    // - and the copy of the file it holds - would be retained for the life of the process.
    // The throw unwinds through the destroy() below with no pdfjs call in flight.
    const stopIfLate = (read: number): void => {
      if (performance.now() > deadline) throw new Error(tookTooLong(read, pages, seconds));
    };

    const lines: TextLine[] = [];
    let chars = 0;
    for (let p = 1; p <= pages; p++) {
      stopIfLate(p - 1);
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const onPage: TextLine[] = [];
      // At a stride, because the find below is a scan of the lines already placed and a page
      // may carry enough baselines for that to square into seconds of its own.
      let seen = 0;
      for (const item of content.items) {
        if ((seen++ & 1023) === 0) stopIfLate(p - 1);
        if (!('str' in item)) continue;
        const text = item.str.trim();
        if (!text) continue;
        chars += text.length;
        const x = item.transform[4];
        const y = item.transform[5];
        const line = onPage.find((l) => Math.abs(l.y - y) <= TOLERANCE);
        if (line) line.items.push({ x, text });
        else onPage.push({ page: p, y, items: [{ x, text }] });
      }
      onPage.sort((a, b) => b.y - a.y);
      for (const line of onPage) line.items.sort((a, b) => a.x - b.x);
      lines.push(...onPage);
      page.cleanup();
    }
    return { lines, pages, chars };
  } finally {
    await task.destroy();
  }
}

const cellAt = (line: TextLine, span: Span): string =>
  line.items
    .filter((i) => i.x >= span[0] && i.x < span[1])
    .map((i) => i.text)
    .join(' ');

interface ReadAmount {
  value: number | null;
  currency: string;
  note?: string;
}

interface OpenTable {
  collect: boolean;
  amount: (line: TextLine) => ReadAmount;
  blank: (line: TextLine) => boolean;
}

function readLine(
  template: PdfTemplate,
  line: TextLine,
): { cells: RowCells; table: OpenTable | undefined } {
  const cells: RowCells = {
    date: cellAt(line, template.columns.date),
    description: cellAt(line, template.columns.description),
  };
  switch (template.amounts) {
    case 'debit-credit': {
      const { debit, credit } = template.columns;
      const found = template.tables.find(
        (t) =>
          t.header.date === cells.date &&
          t.header.description === cells.description &&
          t.header.debit === cellAt(line, debit) &&
          t.header.credit === cellAt(line, credit),
      );
      return {
        cells,
        table: found && {
          collect: found.collect,
          amount: (l) =>
            debitCredit(template, found.header, cellAt(l, debit), cellAt(l, credit)),
          blank: (l) => cellAt(l, debit) === '' && cellAt(l, credit) === '',
        },
      };
    }
    case 'signed': {
      const { amount } = template.columns;
      const found = template.tables.find(
        (t) =>
          t.header.date === cells.date &&
          t.header.description === cells.description &&
          t.header.amount === cellAt(line, amount),
      );
      return {
        cells,
        table: found && {
          collect: found.collect,
          amount: (l) => signed(template, found.header.amount, cellAt(l, amount)),
          blank: (l) => cellAt(l, amount) === '',
        },
      };
    }
  }
}

function matches(template: PdfTemplate, lines: TextLine[]): boolean {
  const first = lines.filter((l) => l.page === 1);
  const text = first.map((l) => l.items.map((i) => i.text).join(' ')).join('\n');
  if (!template.issuer.every((term) => text.includes(term))) return false;
  return first.some((l) => readLine(template, l).table?.collect === true);
}

/**
 * Which template claims the document, over ALL of them and never the first to match.
 *
 * Stopping early is what makes array order into a silent tie-break that no reviewer reads
 * as ordering. Two templates share half a fingerprint the day a second layout for one
 * bank is added, and the day one of them is loosened for a near miss the earlier entry
 * would win and a statement would be read against another layout's columns: parsed,
 * accepted, plausible and wrong. The throw makes that impossible rather than unlikely.
 */
export function selectTemplate(
  templates: readonly PdfTemplate[],
  lines: TextLine[],
): PdfTemplate | undefined {
  const claimed = templates.filter((t) => matches(t, lines));
  if (claimed.length > 1) throw new Error(ambiguousLayout(claimed.map((t) => t.title)));
  return claimed[0];
}

function debitCredit(
  template: PdfTemplate,
  header: DebitCreditHeader,
  debit: string,
  credit: string,
): ReadAmount {
  if (debit && credit) {
    return {
      value: null,
      currency: '',
      note: `holds ${quote(debit)} and ${quote(credit)} - a line carries a debit or a credit, not both`,
    };
  }
  if (!debit && !credit) {
    return {
      value: null,
      currency: '',
      note: `is empty in both the ${quote(header.debit)} and ${quote(header.credit)} columns`,
    };
  }
  const read = amountCell(template, debit || credit);
  if (read.value === null || !debit) return read;
  return { ...read, value: -read.value };
}

function signed(template: PdfTemplate, heading: string, amount: string): ReadAmount {
  if (!amount) {
    return { value: null, currency: '', note: `is empty in the ${quote(heading)} column` };
  }
  return amountCell(template, amount);
}

const currencyOf = (currency: AmountCurrency, m: RegExpExecArray): string | undefined =>
  currency.kind === 'in-the-cell' ? currency.symbols[m[2]] : currency.code;

function amountCell(template: PdfTemplate, raw: string): ReadAmount {
  const unreadable = {
    value: null,
    currency: '',
    note: `reads ${quote(raw)}, where this template reads an amount like "${template.amount.example}"`,
  };
  const m = template.amount.pattern.exec(raw);
  if (!m) return unreadable;
  const currency = currencyOf(template.amount.currency, m);
  if (currency === undefined) {
    return {
      value: null,
      currency: '',
      note: `reads ${quote(raw)}, and ${quote(m[2])} is not a currency symbol this template knows`,
    };
  }
  const value = parseAmount(m[1], template.amount.decimal);
  return value === null ? unreadable : { value, currency };
}

function wanted(rows: Exclude<RowExtent, { kind: 'one-line' }>, description: string): boolean {
  switch (rows.kind) {
    case 'continuations':
      return !rows.drop.some((label) => description.startsWith(label));
    case 'labelled-continuations':
      return rows.keep.some((label) => description.startsWith(label));
  }
}

function readRows(
  template: PdfTemplate,
  lines: TextLine[],
  dates: DateReader,
): { rows: Cell[][]; notes: Map<string, string> } {
  const { shape } = dates;
  const rows: Cell[][] = [];
  const notes = new Map<string, string>();
  let table: OpenTable | null = null;
  let open: { row: Cell[]; page: number; fee: boolean } | null = null;

  for (const line of lines) {
    const { cells, table: header } = readLine(template, line);
    const m = shape.exec(cells.date);
    if (!m) {
      if (cells[template.marker.column] === template.marker.text) {
        if (!header) throw new Error(unreadableTable(template.title, quote(cells.date)));
        table = header;
        open = null;
        continue;
      }
      // A line that attaches to the row above it: nothing in the date column, something
      // in the description one, and on the page that row's dated line was read on. TWO
      // things attach - a continuation and a fee line - and they share this condition
      // rather than restating it.
      //
      // The page test is not decoration. Pages 2..n of a statement may repeat the title
      // and the period in the description column with both other cells empty, which is a
      // continuation's exact shape, and without it those lines would be appended to the
      // last transaction of the page before. What it costs is stated rather than hidden:
      // a transaction split across a page break would lose its tail, and no transaction
      // in any document measured is split.
      //
      // The two arms diverge on `blank()` and on `rows.kind`, and both belong to the
      // continuation. A continuation is required to write nothing in an amount column; a
      // fee line WRITES there, so it is the one attaching line that may look at a line
      // with an amount, and it looks at the description cell of it. `one-line` gates the
      // continuation only: a layout whose transactions are one line each may still print
      // a fee line, and what decides that is `template.fee`.
      //
      // `else if` and not two ifs: a line carrying the fee label can then never reach a
      // description, for any template and any keep list. Descriptions are not in the
      // dedup key, so a fee label appended to one is caught by nothing.
      if (
        open !== null &&
        table !== null &&
        open.page === line.page &&
        cells.date === '' &&
        cells.description !== ''
      ) {
        if (template.fee.kind === 'included' && cells.description.startsWith(template.fee.label)) {
          if (open.fee) throw new Error(twoFeeLines(template.title, template.fee.label));
          open.fee = true;
          const raw = cells.description.slice(template.fee.label.length).trim();
          const read = amountCell(template, raw);
          if (read.value === null) {
            throw new Error(
              unreadableFee(template.title, template.fee.label, raw, template.amount.example),
            );
          }
          // Two conditions and one drop, silent where the refusals above are loud.
          //
          // fee_cents carries no currency column, so a fee stated in another one would be
          // stored as the row's; and a SIGNED fee is a convention nobody here has
          // measured - it may point at the fee or at the movement - so it is dropped and
          // never Math.abs'd, which is guessing which. Without the sign half a negative
          // reaches readFee, which refuses the cell and SKIPS the row, taking the file to
          // doesNotAddUp - a sentence about balances that names nothing about a fee.
          if (read.value >= 0 && read.currency === cellText(open.row[CURRENCY])) {
            open.row[FEE] = read.value;
          }
        } else if (
          template.rows.kind !== 'one-line' &&
          table.blank(line) &&
          wanted(template.rows, cells.description)
        ) {
          open.row[DESCRIPTION] = `${cellText(open.row[DESCRIPTION])} ${cells.description}`;
        }
      }
      continue;
    }
    if (!table?.collect) {
      open = null;
      continue;
    }

    // rows[] becomes sheet.rows[1..n]: the synthetic header takes index 0
    const i = rows.length + 1;
    const note = (col: number, text: string): void => {
      notes.set(`${i}:${col}`, bounded(text, NOTE_MAX));
    };

    const date = dates.read(m);
    if (date.date === null) note(DATE, date.note);
    const amount = table.amount(line);
    if (amount.note) note(AMOUNT, amount.note);

    const row: Cell[] = [];
    row[DATE] = date.date;
    row[AMOUNT] = amount.value;
    row[DESCRIPTION] = cells.description;
    row[CURRENCY] = amount.currency;
    // null and never 0: the source stated no fee, which is not a fee of nothing
    row[FEE] = null;
    rows.push(row);
    open = { row, page: line.page, fee: false };
  }
  return { rows, notes };
}

interface Balance {
  value: number;
  currency: string;
  label: string;
  role: BalanceRole;
}

function scopeOf(template: PdfTemplate, lines: TextLine[]): TextLine[] {
  const { balances } = template;
  if (balances.scope.kind === 'whole-document') return lines;
  const { opens, closes } = balances.scope;
  const label = (line: TextLine): string => cellAt(line, balances.label);
  const from = lines.findIndex((l) => label(l).startsWith(opens));
  if (from === -1) throw new Error(unplacedBalanceBox(template.title, opens));
  const rest = lines.slice(from + 1);
  const to = rest.findIndex((l) => closes.some((c) => label(l).startsWith(c)));
  return to === -1 ? rest : rest.slice(0, to);
}

/**
 * What the document says it started and ended with, and what it says each side came to,
 * off the line - or the lines - that state it for the whole statement.
 *
 * Exactly one line per label is required WITHIN THE SCOPE, not the first of several: a
 * layout that repeats a label inside one section is a layout nobody has measured, and
 * taking the first is the guess this parser exists not to make.
 *
 * There is deliberately no header assertion fingerprinting this box the way `matches`
 * fingerprints the transaction table, and the reason is measured rather than economic: in
 * the first document this was written against, the closing column's heading wraps onto
 * two baselines either side of the header row, so the assertion could only ever be
 * partial - and a table named in half its columns is a table whose shape is not known.
 * What stands in its place is the gate, which makes the locator self-checking per side as
 * well as end to end. Any misread of the box - a column inserted, two values swapped, the
 * wrong line matched - changes the arithmetic and refuses the import.
 */
function readBalances(template: PdfTemplate, scoped: TextLine[]): StatementBalances {
  const { balances } = template;

  const only = (label: string): TextLine => {
    const found = scoped.filter((l) => cellAt(l, balances.label) === label);
    if (found.length !== 1) throw new Error(noBalanceBox(template.title, label, found.length));
    return found[0];
  };

  const read = (line: TextLine, span: Span, label: string, role: BalanceRole): Balance => {
    const raw = cellAt(line, span);
    const m = template.amount.pattern.exec(raw);
    const currency = m ? currencyOf(template.amount.currency, m) : undefined;
    const value = m ? parseAmount(m[1], template.amount.decimal) : null;
    if (currency === undefined || value === null) {
      throw new Error(unreadableBalance(template.title, role, label, raw, template.amount.example));
    }
    return { value, currency, label, role };
  };

  const box = (
    opening: Balance,
    closing: Balance,
    gross: { signs: GrossSigns; outgoing: Balance; incoming: Balance } | null,
  ): StatementBalances => {
    const rest = gross ? [closing, gross.outgoing, gross.incoming] : [closing];
    for (const cell of rest) {
      if (cell.currency !== opening.currency) {
        throw new Error(mixedBalanceCurrencies(template.title, opening, cell));
      }
    }
    return {
      openingCents: toCents(opening.value),
      closingCents: toCents(closing.value),
      // onto the rows' own convention, so the gate compares two numbers in one
      // convention rather than normalising until they agree. A plain negation and never
      // Math.abs: a signed cell under a `magnitudes` declaration comes out positive and
      // refuses, where Math.abs would have accepted it
      gross: gross
        ? {
            kind: 'printed',
            outgoingCents:
              gross.signs === 'magnitudes'
                ? -toCents(gross.outgoing.value)
                : toCents(gross.outgoing.value),
            incomingCents: toCents(gross.incoming.value),
          }
        : { kind: 'not-printed' },
      currency: opening.currency,
    };
  };

  switch (balances.kind) {
    case 'one-line': {
      const line = only(balances.total);
      const opening = read(line, balances.opening, balances.total, 'opening balance');
      const closing = read(line, balances.closing, balances.total, 'closing balance');
      const { gross } = balances;
      return box(
        opening,
        closing,
        gross.kind === 'printed'
          ? {
              signs: gross.signs,
              outgoing: read(line, gross.outgoing, balances.total, 'outgoing total'),
              incoming: read(line, gross.incoming, balances.total, 'incoming total'),
            }
          : null,
      );
    }
    case 'two-lines': {
      const opening = read(
        only(balances.opening),
        balances.value,
        balances.opening,
        'opening balance',
      );
      const closing = read(
        only(balances.closing),
        balances.value,
        balances.closing,
        'closing balance',
      );
      const { gross } = balances;
      return box(
        opening,
        closing,
        gross.kind === 'printed'
          ? {
              signs: gross.signs,
              outgoing: read(only(gross.outgoing), balances.value, gross.outgoing, 'outgoing total'),
              incoming: read(only(gross.incoming), balances.value, gross.incoming, 'incoming total'),
            }
          : null,
      );
    }
  }
}

/**
 * The document's text as issuerName reads it: one entry per page of the DOCUMENT,
 * including a page that produced no lines at all, because that page is part of what
 * "on every page" is counted against.
 */
const pageLines = (lines: TextLine[], pages: number): string[][] => {
  const byPage: string[][] = Array.from({ length: pages }, () => []);
  for (const line of lines) byPage[line.page - 1]?.push(line.items.map((i) => i.text).join(' '));
  return byPage;
};

export async function readPdf(
  bytes: Buffer,
  limits: PdfLimits,
  templates: readonly PdfTemplate[] = TEMPLATES,
): Promise<PdfStatement> {
  const { lines, pages, chars } = await readLines(bytes, limits);

  const template = selectTemplate(templates, lines);
  if (!template) {
    if (chars / pages < MIN_CHARS_PER_PAGE) throw new Error(SCANNED);
    const name = issuerName(pageLines(lines, pages));
    throw new Error(name === null ? NOT_RECOGNISED : notRecognisedFrom(name));
  }

  const scoped = scopeOf(template, lines);
  const dates = dateReader(template, scoped);
  const { rows, notes } = readRows(template, lines, dates);
  if (rows.length === 0) throw new Error(noTransactionLines(template.title));
  const balances = readBalances(template, scoped);

  return {
    sheet: {
      rows: [HEADER, ...rows],
      rowLabel: (i) => i,
      note: (row, col) => notes.get(`${row}:${col}`),
    },
    template: template.id,
    title: template.title,
    columns: COLUMNS,
    fee: feeOf(template.fee),
    balances,
  };
}

export const TEMPLATES: readonly PdfTemplate[] = [
  {
    id: 'revolut-ru',
    title: 'Revolut',
    issuer: ['Revolut Bank UAB'],
    amounts: 'debit-credit',
    columns: {
      date: [35, 120],
      description: [120, 330],
      debit: [330, 410],
      credit: [410, 500],
    },
    marker: { column: 'description', text: 'Описание' },
    tables: [
      {
        header: {
          date: 'Дата',
          description: 'Описание',
          debit: 'Списания',
          credit: 'Пополнения',
        },
        collect: true,
      },
      {
        header: {
          date: 'Дата начала',
          description: 'Описание',
          debit: 'Списания',
          credit: 'Пополнения',
        },
        collect: false,
      },
    ],
    dates: { format: 'ru-abbrev' },
    amount: {
      pattern: /^(\d{1,3}(?: \d{3})*,\d{2})([^\s\d]+)$/u,
      decimal: ',',
      currency: { kind: 'in-the-cell', symbols: { '€': 'EUR' } },
      example: '1 234,56€',
    },
    rows: {
      kind: 'labelled-continuations',
      keep: ['Получатель:', 'Реквизиты:', 'Отправитель:'],
    },
    // "Комиссия:" is deliberately NOT in the keep list above and must not be added to
    // it: a fee line is read here and reaches no description.
    fee: { kind: 'included', label: 'Комиссия:' },
    balances: {
      scope: { kind: 'whole-document' },
      kind: 'one-line',
      total: 'Итого',
      label: [35, 120],
      opening: [250, 330],
      // over the running-balance column that every transaction line carries, which is
      // safe only because the line is found by its label first and never by scanning here
      closing: [500, 596],
      gross: {
        kind: 'printed',
        signs: 'magnitudes',
        // Two independent measurements that happen to equal `columns.debit` and
        // `columns.credit` today, and they must NOT be turned into a reference to them.
        // This box is a row of the balance summary table and not of the transaction
        // table: two of the four spans here correspond to no column of it at all -
        // `opening` sits inside its description span and `closing` past its last column.
        // A redesign that moved one table alone would break a reference while both
        // literals were still individually correct.
        outgoing: [330, 410],
        incoming: [410, 500],
      },
    },
  },
  {
    id: 'n26-de',
    title: 'N26',
    // The generator's own German wording twice, plus the bank's own BIC out of the
    // footer. Never the account holder's IBAN, which sits in the same text item: a
    // fingerprint that falls back to a per-customer value is a stop-and-report. The word
    // "N26" is deliberately not here - on page 1 it is vector art, and every occurrence
    // of the string is a transaction DESCRIPTION, which another month would not carry.
    issuer: ['Kontoauszug Nr.', 'Erstellt am', 'BIC: NTSBDEB1XXX'],
    amounts: 'signed',
    columns: {
      description: [0, 330],
      date: [330, 460],
      amount: [460, 596],
    },
    marker: { column: 'description', text: 'Beschreibung' },
    tables: [
      { header: { description: 'Beschreibung', date: 'Verbuchungsdatum', amount: 'Betrag' }, collect: true },
      { header: { description: 'Beschreibung', date: '', amount: '' }, collect: false },
    ],
    dates: { format: 'de-numeric' },
    amount: {
      pattern: /^([+-]\d{1,3}(?:\.\d{3})*,\d{2})([^\s\d]+)$/u,
      decimal: ',',
      currency: { kind: 'in-the-cell', symbols: { '€': 'EUR' } },
      example: '-1.234,56€',
    },
    // The one line dropped is the counterparty's IBAN and BIC. Other people's
    // identifiers do not belong in a column the categoriser, the transfer detector and
    // the export all read, and "the bytes are already stored" is a different fact - the
    // stored document is encrypted and not queryable. The label alone is the rule: the
    // shape this was written as before matched the value's character class, so a grouped
    // IBAN or a line missing its BIC half landed whole in the column.
    //
    // What that costs: the unit is the LINE, so a reference printed after the identifier
    // on the same line goes with it, with nothing refusing and nothing noting it.
    rows: { kind: 'continuations', drop: ['IBAN:'] },
    fee: { kind: 'none' },
    balances: {
      scope: { kind: 'whole-document' },
      kind: 'two-lines',
      label: [0, 330],
      value: [460, 596],
      opening: 'Dein alter Kontostand',
      closing: 'Dein neuer Kontostand',
      gross: {
        kind: 'printed',
        signs: 'signed',
        outgoing: 'Ausgehende Transaktionen',
        incoming: 'Einkommende Transaktionen',
      },
    },
  },
  /*
   * The two entries below are ONE layout in two locales: the same bank prints the same
   * statement in Ukrainian and in English, and the two files share no heading, no balance
   * label and no marker. A CSV preset per language would be a dropdown somebody has to
   * find their own locale in; a PDF template is chosen by the document, so the second
   * entry costs a user nothing. Nothing here is factored into a shared vocabulary,
   * because a data literal that repeats is not a correctness cost and a vocabulary two
   * templates read through is a way for one to move the other.
   *
   * The geometry is NOT shareable either, and the reason is not stylistic: every column
   * here is CENTRED, so both of its edges move with the content and the left edge a span
   * assigns on is a function of how wide the text happens to be. The two files print the
   * same numbers and different words, so the three columns' centres agree and their
   * left-edge ranges do not. Each span below is measured off its own document.
   */
  {
    id: 'universalbank-uk',
    title: 'АТ «УНІВЕРСАЛ БАНК»',
    issuer: ['АТ «УНІВЕРСАЛ БАНК»', 'Рух коштів по картці'],
    amounts: 'signed',
    columns: { date: [35, 41], description: [50, 190], amount: [215, 272] },
    marker: { column: 'description', text: 'Деталі операції' },
    tables: [
      // The `i` in "Дата i час" is ASCII U+0069, not Cyrillic U+0456, on both this
      // document and its English twin. It looks like a typo in the generator and it is
      // the generator's; correcting it here would stop the header matching and refuse the
      // whole document.
      //
      // The `''` is what this baseline really reads - the amount column's own heading
      // wraps across the other baselines of the heading block - and inventing a heading
      // it does not carry would make the fingerprint a fiction.
      {
        header: { date: 'Дата i час', description: 'Деталі операції', amount: '' },
        collect: true,
      },
    ],
    dates: { format: 'de-numeric' },
    amount: {
      // The trailing code is a literal " UAH" and NOT " [A-Z]{3}": a balance printed in
      // another currency has to fail this pattern and refuse loudly, where a generic
      // three-letter group would read it as UAH and import somebody's dollar statement as
      // hryvnia. It is optional because the transaction cells carry no code at all - the
      // currency is in the column heading, which is what `per-column` supplies.
      pattern: /^(-?\d{1,3}(?: \d{3})*\.\d{2})(?: UAH)?$/u,
      decimal: '.',
      currency: { kind: 'per-column', code: 'UAH' },
      example: '-1 234.56',
    },
    rows: {
      kind: 'continuations',
      drop: ['Операційний директор', 'Вклади гарантуються', 'Детальна інформація'],
    },
    fee: { kind: 'none' },
    balances: {
      scope: { kind: 'whole-document' },
      kind: 'two-lines',
      label: [0, 133],
      value: [133, 596],
      opening: 'Баланс на початок періоду:',
      closing: 'Баланс на кінець періоду:',
      gross: {
        kind: 'printed',
        signs: 'magnitudes',
        outgoing: 'Сума витрат за період:',
        incoming: 'Сума зарахувань за період:',
      },
    },
  },
  {
    id: 'universalbank-en',
    title: 'UNIVERSAL BANK JSC',
    issuer: ['UNIVERSAL BANK JSC', 'Cash flow on the card'],
    amounts: 'signed',
    columns: { date: [30, 42], description: [50, 190], amount: [215, 272] },
    marker: { column: 'description', text: 'Description' },
    tables: [
      {
        header: { date: 'Date and time', description: 'Description', amount: 'currency' },
        collect: true,
      },
    ],
    dates: { format: 'de-numeric' },
    amount: {
      pattern: /^(-?\d{1,3}(?: \d{3})*\.\d{2})(?: UAH)?$/u,
      decimal: '.',
      currency: { kind: 'per-column', code: 'UAH' },
      example: '-1 234.56',
    },
    rows: {
      kind: 'continuations',
      drop: ['Operating Director', 'Deposits are guaranteed', 'Details in the Reference'],
    },
    fee: { kind: 'none' },
    balances: {
      scope: { kind: 'whole-document' },
      kind: 'two-lines',
      label: [0, 133],
      value: [133, 596],
      opening: 'Balance at the beginning of the period:',
      closing: 'Balance at the end of the period:',
      gross: {
        kind: 'printed',
        signs: 'magnitudes',
        outgoing: 'Amount of expenses for the period:',
        incoming: 'Amount of charges for the period:',
      },
    },
  },
  {
    id: 'c24-de',
    title: 'C24 Bank GmbH',
    issuer: ['C24 Bank GmbH', 'Ust.-ID DE 322 469 451'],
    amounts: 'signed',
    // `date`'s left edge is BELOW the leftmost thing this document draws, and that is
    // deliberate rather than slack: it puts every line the layout writes in the left
    // margin - the summary labels, the section headings, the footer, the whole of the
    // legal page - inside the date cell, where a non-empty date cell is what stops
    // readRows taking any of them for a continuation. Tightening it to the leftmost drawn
    // item makes the footer's address line one, measured.
    //
    // `description`'s right edge is what separates the footer's own legal name from a
    // transaction's detail line - see `rows` below. Its cost is real: a description drawn
    // as a SECOND run beginning past that edge would be dropped silently.
    //
    // `amount` reaches much further left than the widest amount this document contains,
    // because the column is right-aligned and an item is assigned by its LEFT edge: a
    // span drawn for the amounts this file happens to print would read an empty amount
    // cell for every four-figure movement, skip the row and refuse an ordinary month. The
    // obvious lower bound - the footer's own page number - is not available, because a
    // four-figure amount begins within a point of it.
    columns: { date: [40, 135], description: [135, 250], amount: [460, 596] },
    marker: { column: 'description', text: 'Transaktionsinformation' },
    tables: [
      // "Buchung" and "Valuta" are two headings in one span, joined by cellAt exactly as
      // the two date cells under them are - so the fourth column is NAMED, and a redesign
      // that renames or moves it stops this template matching rather than reading rows
      // against columns that have shifted.
      {
        header: {
          date: 'Buchung Valuta',
          description: 'Transaktionsinformation',
          amount: 'Betrag',
        },
        collect: true,
      },
    ],
    dates: {
      format: 'de-day-month-pair',
      period: /^(\d{2})\.(\d{2})\.(\d{4}) - (\d{2})\.(\d{2})\.(\d{4})$/u,
    },
    amount: {
      // The sign is OPTIONAL and cannot be otherwise. readBalances reads this layout's
      // balance cells with this same pattern and they are unsigned, so a required sign
      // would refuse the balance box. What that costs, said plainly: a dropped "+" is
      // arithmetically invisible while a dropped "-" flips a debit into a credit, and the
      // only thing standing between a narrow amount span and wrong money is the per-side
      // check.
      //
      // The space after the sign is real. A credit's sign is a text run of its own with
      // its digits in a second run, and cellAt joins runs with a space, so the cell
      // arrives as "+ 0,08 €" where the summary line writes "+0,08 €" as one run.
      // parseAmount strips whitespace before it parses, so the pattern is the only place
      // this matters - and it still matches the WHOLE cell, which is what stops
      // "1234,56-" being read as positive.
      pattern: /^([+-]? ?\d{1,3}(?:\.\d{3})*,\d{2}) ([^\s\d]+)$/u,
      decimal: ',',
      currency: { kind: 'in-the-cell', symbols: { '€': 'EUR' } },
      example: '-1.234,56 €',
    },
    // `drop` is EMPTY, and that is the whole point of the description span's right edge.
    // The bank's own legal name appears twice on page 1: once as transaction 1's own
    // first detail line, and once as the page footer, on the same page as the last
    // transaction and blank in the amount column - a continuation's exact shape. The two
    // texts are byte-identical and differ only in x, so no rule over the description TEXT
    // can separate them: a drop list naming it takes the real detail line with the
    // footer, which is a silent truncation of a real description. Only a rule keyed on x
    // can tell them apart, and the span is that rule.
    rows: { kind: 'continuations', drop: [] },
    fee: { kind: 'none' },
    balances: {
      scope: { kind: 'section', opens: 'Kontoauszug', closes: ['Rechnungsabschluss'] },
      kind: 'two-lines',
      // Two independent measurements that happen to equal two of `columns` and must NOT
      // be turned into references to them. This box is not a row of the transaction
      // table: its labels and its values each sit a few points off the transaction
      // table's own columns, measured, which is the proof they are two columns.
      label: [0, 135],
      value: [460, 596],
      opening: 'Startsaldo',
      closing: 'Endsaldo',
      gross: {
        kind: 'printed',
        signs: 'signed',
        outgoing: 'Kontobelastungen',
        incoming: 'Kontogutschriften',
      },
    },
  },
];

/**
 * Every sentence in the refusal set, composed at its own extreme out of every template's
 * own literals - the title a refusal names the layout by, the balance labels it quotes
 * back, the currency codes it declares and the example it offers - and out of the issuer
 * directory's own longest entry, for the one refusal that names a bank rather than a
 * layout.
 *
 * It composes rather than measures because a measurement is true only on the day it is
 * taken: a template added with a long label moves the longest sentence, and a number
 * written down once would go on passing over one that had grown past what error_detail
 * keeps.
 *
 * What it does not hold is a refusal added above and not added here. Nothing structural
 * can - the set is a list of literals and builders with different signatures - so it is
 * one list beside another and this comment is the whole of the warning.
 */
export function refusals(templates: readonly PdfTemplate[] = TEMPLATES): string[] {
  const cell = 'W'.repeat(CELL_QUOTE_MAX + 2);
  const found = 999_999;
  const longest = (xs: string[]): string => xs.reduce((a, b) => (a.length >= b.length ? a : b), '');

  const all = [
    ENCRYPTED,
    NOT_A_PDF,
    NOT_RECOGNISED,
    notRecognisedFrom(longest(Object.values(ISSUERS))),
    SCANNED,
    tooManyPages(found, found),
    tookTooLong(found, found, found),
    ambiguousLayout(templates.map((t) => t.title)),
  ];
  const role = longest([...ROLES]) as BalanceRole;

  for (const t of templates) {
    const label = longest(
      t.balances.kind === 'one-line'
        ? [t.balances.total]
        : [
            t.balances.opening,
            t.balances.closing,
            ...(t.balances.gross.kind === 'printed'
              ? [t.balances.gross.outgoing, t.balances.gross.incoming]
              : []),
          ],
    );
    const code = longest(
      t.amount.currency.kind === 'in-the-cell'
        ? Object.values(t.amount.currency.symbols)
        : [t.amount.currency.code],
    );
    all.push(
      unreadableTable(t.title, quote(cell)),
      noTransactionLines(t.title),
      noBalanceBox(t.title, label, found),
      ...ROLES.map((r) => unreadableBalance(t.title, r, label, cell, t.amount.example)),
      mixedBalanceCurrencies(
        t.title,
        { role, label, currency: code },
        { role, label, currency: code },
      ),
    );
    if (t.balances.scope.kind === 'section') {
      all.push(unplacedBalanceBox(t.title, t.balances.scope.opens));
    }
    if (t.dates.format === 'de-day-month-pair') all.push(noStatementPeriod(t.title, found));
    if (t.fee.kind !== 'none') {
      all.push(
        twoFeeLines(t.title, t.fee.label),
        unreadableFee(t.title, t.fee.label, cell, t.amount.example),
      );
    }
  }
  return all;
}
