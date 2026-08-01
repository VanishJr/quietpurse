/**
 * PDF frontend (ROADMAP 5.2, row 6a): a statement PDF in, a Sheet out - the same
 * seam the CSV and XLSX frontends hand their rows to, so the same statement
 * imported as a PDF and as a CSV produces the same transactions.
 *
 * A PDF has no columns and no header row. It has glyphs at coordinates, handed
 * back in the order the generator drew them, which is not the order they are read
 * in: two columns of a statement interleave in getTextContent's array, and a row
 * assembled from array position gives a transaction whose amount belongs to its
 * neighbour - parsed, accepted, plausible and wrong. So everything below groups by
 * coordinate and never by position.
 *
 * Which coordinate means which column is a TEMPLATE, per layout rather than per
 * bank, and there is no way to derive one: it is measured off a document somebody
 * has had in front of them. A layout no template matches is refused by name rather
 * than read against the nearest fit - a template that matches too eagerly reports
 * plausible numbers, which is the one outcome worse than a refusal (ROADMAP 5.2).
 */
import { getDocument, PasswordException, VerbosityLevel } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { toCents } from '../money';
import { CsvMapping, parseAmount } from './csv';
import { Cell, Sheet, cellText } from './sheet';

/**
 * Bumped whenever a change here would parse an existing file differently. Per
 * parser, keyed by imports.source_type - see CSV_PARSER_VERSION.
 */
export const PDF_PARSER_VERSION = 4;

/**
 * What the document says it started and ended with, for the whole statement rather
 * than for one of the products inside it.
 *
 * Minor units, because the gate that compares these to the rows compares integers.
 * The real statement's 70 amounts summed as decimals come to 123.45000000000002,
 * which against a closing balance of 579.85 is a refused import and a wrong one
 * (ROADMAP 4.6). A field named `openingCents` cannot be compared with a decimal sum
 * by accident.
 */
export interface StatementBalances {
  openingCents: number;
  closingCents: number;
  /** the ISO code the box's own cells carry, through the template's amount map */
  currency: string;
}

/**
 * What the PDF frontend answers with (ROADMAP row 6a, Ruling 1). A Sheet the shared
 * mapper reads, and the facts only this format carries. The opening and closing
 * balance and the statement currency attach HERE rather than to Sheet, and required
 * rather than optional, so that "this format has no balances" and "the template was
 * supposed to find the closing balance and did not" cannot be spelled the same way.
 * Sheet is produced by three frontends and two of them can never carry one. The IBAN
 * is the same argument and is not extracted yet: nothing stores it (row 6b).
 */
export interface PdfStatement {
  sheet: Sheet;
  /** which template matched - a log line, never a row problem (Ruling 4) */
  template: string;
  /** the same template's `title`: what a refusal composed downstream names it by */
  title: string;
  /** the columns of `sheet`, named by this module and never by the request */
  columns: Partial<CsvMapping>;
  balances: StatementBalances;
}

/**
 * A statement's text layer runs to thousands of characters a page; a scan's runs to
 * none. Two orders of magnitude below the first and one above the second, so the
 * threshold has room to be wrong. It decides which sentence a document that matched
 * no template is refused with, never whether an import happens: templates are
 * matched first, so a recognised layout imports however sparse its text is.
 */
const MIN_CHARS_PER_PAGE = 50;

/**
 * What one note may spend. describeRow's longest lead is `row 50000: the amount
 * cell ` at 27 characters, and 27 + 132 is the 159 xlsx.ts measured as the longest
 * describeRow output - which noRowsParsed's own lead carries to the 199 its
 * NOTICE_MAX subtracts from. So a note past this moves a number that decides
 * whether an unrelated workbook keeps its unused-sheet notice.
 *
 * Exported for the test, like readSheet in statement.ts and for the same reason: a
 * bound written as a literal beside the assertion is free to move, and the next
 * template with a long example would move it. error-budget.test.ts holds only the
 * cross-package cap; what holds this is the 'diagnostic budget' case in
 * test/pdf.test.ts. Not API surface anyone asked for.
 */
export const NOTE_MAX = 132;

/** What a cell quoted back at the user may spend inside its quotes. */
const CELL_QUOTE_MAX = 24;

/**
 * Every way THIS PARSER can refuse, in one place so that no two of them can come to
 * read alike. All of them are composed inside ERROR_DETAIL_MAX, at the extreme of the
 * one number and the one quote any of them carries and of a template's own literals -
 * its title, its balance labels, its currency codes and its example.
 *
 * There is deliberately no measurement written down here. `refusals` at the foot of
 * this file composes the lot from every template's own values and the 'diagnostic
 * budget' case asserts the longest, so a template added with a longer label moves the
 * number in a test that goes red rather than in a comment that stops being true
 * (rows 6a D14, 6b D2 and D10, and this one).
 *
 * Not every way an import of a PDF can refuse: the reconciliation gate's two
 * sentences live beside `reconcile` in statement.ts, because they name counts of
 * MAPPED rows - how many lines became transactions, how many were skipped - which
 * this module never sees. Keeping them here would mean exporting message builders to
 * be called with numbers from the other side of the seam, which couples the two
 * modules for the sake of one file (row 6b, D2).
 *
 * The first two are what the document turned out not to be, the next three what the
 * template list could not settle on, and the rest what a template found and could
 * not finish. Each says what to do instead, and none of them is a dead end: CSV and
 * Excel from the same online banking import today, which for as long as the
 * template list is short is the common path rather than a rough edge (ROADMAP,
 * "'Import finished' does not mean every bank").
 */
const ENCRYPTED =
  'this PDF is password-protected - open it with its password and save an unprotected copy, or download the statement again from your online banking';

const NOT_A_PDF =
  'this file starts with %PDF but could not be opened as one - download the statement again from your online banking, or export it as CSV or Excel (.xlsx)';

const NOT_RECOGNISED =
  "this statement's layout is not one this importer recognises yet - export the same statement as CSV or Excel (.xlsx) from the same online banking and upload that; those import today";

const SCANNED =
  'this looks like a scan - this importer reads the text layer of a PDF and this one has none; download the statement again from your online banking, or export it as CSV or Excel (.xlsx)';

/**
 * Named by title and never by id (Ruling 4). Which two layouts collided is the only
 * part of this a person can act on - and it is the same thing the report of a
 * fingerprint that has been loosened needs to say.
 */
const ambiguousLayout = (titles: string[]): string =>
  `this statement matches more than one of the layouts this importer knows (${titles.map(quote).join(' and ')}) - export the same statement as CSV or Excel (.xlsx) from your online banking and upload that; those import today`;

const tooManyPages = (pages: number, max: number): string =>
  `this PDF has ${pages} pages, more than the ${max} this importer reads in one file - export a narrower date range, or export the statement as CSV or Excel (.xlsx)`;

const unreadableTable = (title: string, cell: string): string =>
  `this looks like a ${title} statement but it has a table this importer cannot read (${cell}) - export the same statement as CSV or Excel (.xlsx) from your online banking and upload that`;

/**
 * mapAndStore's own "no data rows (header only, or empty)" names a header, to
 * someone holding a document that has not got one.
 */
const noTransactionLines = (title: string): string =>
  `this looks like a ${title} statement but no transaction lines were found in it - if the statement is really empty then nothing is missing; otherwise export it as CSV or Excel (.xlsx) from your online banking`;

const noBalanceBox = (title: string, label: string, found: number): string =>
  `this looks like a ${title} statement but this importer could not read its balance summary: it expects exactly one "${label}" line and found ${found} - export the same statement as CSV or Excel (.xlsx) from your online banking and upload that`;

const unreadableBalance = (
  title: string,
  which: 'opening' | 'closing',
  label: string,
  cell: string,
  example: string,
): string =>
  `this looks like a ${title} statement but the ${which} balance cell of its "${label}" line reads ${quote(cell)}, where this template reads an amount like "${example}" - export the same statement as CSV or Excel (.xlsx) from your online banking and upload that`;

/**
 * Each balance is named by the line it was read off, because a layout may state the
 * two under two labels on two lines and one that does has no single label to name.
 */
const mixedBalanceCurrencies = (
  title: string,
  opening: { label: string; currency: string },
  closing: { label: string; currency: string },
): string =>
  `this looks like a ${title} statement but its opening balance (${quote(opening.label)}) is stated in ${opening.currency} and its closing balance (${quote(closing.label)}) in ${closing.currency} - this importer cannot check a statement that mixes currencies; export the same statement as CSV or Excel (.xlsx) from your online banking and upload that`;

/** Cut with a mark, so a value with more behind it does not read as the whole one. */
const bounded = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

const quote = (text: string): string => `"${bounded(text, CELL_QUOTE_MAX)}"`;

// ---------- what a template is ----------

/** [left, right) in PDF user units. An item is assigned by the x of its left edge. */
type Span = readonly [number, number];

/**
 * The two cells every layout writes, whichever way it writes its amounts. A line's
 * amount cells are deliberately not here: they are read through the table that
 * declared them (see OpenTable), so the x-intervals a cell is read at and the
 * headings a refusal names can never come from different halves of the union below.
 */
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

/**
 * One of the tables a layout writes, by the heading each of its columns carries.
 * Total over the layout's own columns rather than partial: a table this importer has
 * looked at and named only three columns of is a table it does not actually know the
 * shape of.
 *
 * `collect: false` is what keeps Revolut's "В статусе ожидания" block out of the
 * import. Those rows are money that has not moved, and the CSV path drops them
 * through State != COMPLETED - a PDF import that took them would disagree with the
 * CSV of the same weeks, which is the one comparison this row can be checked by. The
 * N26 layout's summary page is the same shape: one heading is all that tells its four
 * total lines from four transactions.
 */
interface DebitCreditTable {
  header: DebitCreditHeader;
  collect: boolean;
}

interface SignedTable {
  header: SignedHeader;
  collect: boolean;
}

/**
 * How this layout writes an amount, as a shape rather than as fields that may or may
 * not be filled in: Revolut states a debit column and a credit column and the column
 * IS the sign; N26 states one `Betrag` and writes the sign in the cell. The columns
 * and the table headings sit inside the same union node, so a template cannot claim
 * one shape in its x-intervals and the other in its headers, and `tsc` refuses a
 * half-specified one rather than the reader falling through to whichever branch
 * `undefined` lands in (row 6c, R1).
 */
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

/**
 * How this layout writes an amount. The pattern must match the whole cell: a bank
 * that writes "1234,56-" for a debit hands parseFloat a number it reads as positive
 * and stops, so an amount is validated by shape before it is parsed, never after.
 */
interface AmountFormat {
  /** group 1 the number, group 2 the currency symbol */
  pattern: RegExp;
  decimal: CsvMapping['decimal'];
  /** the symbols this layout writes, and the ISO code each of them means */
  currency: Readonly<Record<string, string>>;
  /** what a cell that matched nothing is told an amount looks like */
  example: string;
}

/**
 * What one transaction's extent is. Revolut and N26 both write several lines per
 * transaction, and each names the lines it does not want by the LABEL the generator
 * writes on them - never by a pattern over the value beside it. A label is what the
 * generator holds constant; the value is what varies, so a rule anchored on the
 * value's character class misses the grouped, the truncated and the half-written
 * form of the same line and lands the whole of it in a queried column, with nothing
 * refusing (row 6c, D17 finding 2). A prefix over the label cannot near-miss,
 * because the value is not in the rule at all.
 *
 * Two directions, because the two layouts measured cannot be expressed by one. A
 * layout whose detail lines are ALL labelled takes `labelled-continuations` and
 * names what it keeps; an unmeasured line is then dropped, which is a short
 * description - visible and recoverable. A layout whose detail lines are largely
 * unlabelled has no such list and takes `continuations`, which obliges its author to
 * enumerate what the layout writes BELOW its transactions: Revolut prints ~800
 * characters of deposit-insurance footer per page in the description column with
 * every other cell empty, which is a continuation's exact shape and has no label to
 * name it by. Nothing structural stops a labelled layout reaching for the permissive
 * arm; the tree carries one template of each, side by side.
 *
 * A label naming a line that writes in an amount column can never take effect either
 * way: `blank()` is tested first, and a line writing an amount is a row's own or
 * nothing.
 */
type RowExtent =
  | { kind: 'one-line' }
  /** every continuation line, minus those whose description starts with a label here */
  | { kind: 'continuations'; drop: readonly string[] }
  /** only the continuation lines whose description starts with a label here */
  | { kind: 'labelled-continuations'; keep: readonly string[] };

/**
 * Where the layout states the statement's own opening and closing balance, for the
 * whole document rather than for one of its products.
 *
 * Required and total, the same way a table's header is total over its columns. A
 * variant meaning "this layout states no balances" is what would let a template
 * author who could not find the box write it away, and the weakest parser in the
 * product would then ship with its only check switched off by a data literal - on
 * exactly the layouts whose author was least sure of what they were reading. A
 * document that does not state its balances is not importable today (ROADMAP 5.3,
 * row 3 of the table) and is refused by simply not being a template.
 *
 * Two kinds, because the second layout measured put its two balances on two lines 79
 * user units apart under two different labels, which the one-line shape cannot say at
 * all. Both variants are populated: neither is a way to write "none".
 */
type BalanceBox =
  | {
      /** one line states both, under one label */
      kind: 'one-line';
      /** the literal that line carries in `label` */
      total: string;
      label: Span;
      opening: Span;
      closing: Span;
    }
  | {
      /** a line each, under a label each, and the value in one column */
      kind: 'two-lines';
      label: Span;
      value: Span;
      /** the literal the opening balance's line carries in `label` */
      opening: string;
      closing: string;
    };

/** Exported for the tests that hand readPdf and selectTemplate a list of their own. */
export type PdfTemplate = TableLayout & {
  /** reaches logImport.info, never the user */
  id: string;
  /** the one sentence that names the layout to the user */
  title: string;
  /**
   * Literal text page 1 must carry. Half of the fingerprint; the other half is a
   * `collect` table header found on page 1, asserted at the x-intervals `columns`
   * claims - so "this is that layout" and "the columns are where I think they are"
   * are one assertion rather than two, and a redesign that moves a column fails
   * detection by construction (ROADMAP 5.2: decay has to be loud).
   */
  issuer: readonly string[];
  /**
   * The heading that says a line is a table header at all, whichever table it is.
   * Narrowed to the two columns every layout has, so reading it is one expression
   * over the union rather than a switch - and it removes a freedom no layout uses.
   */
  marker: { column: keyof RowCells; text: string };
  dateFormat: DateFormat;
  amount: AmountFormat;
  rows: RowExtent;
  balances: BalanceBox;
};

// ---------- dates ----------

type DateFormat = 'ru-abbrev' | 'de-numeric';

/**
 * How a layout writes a date. A named vocabulary rather than a callback per
 * template: the reader owns the parsing and a template says which rule it is written
 * in, so a second layout widens this list instead of shipping a parser inside a data
 * literal (row 6c, R1).
 *
 * Groups 1..3 of `shape` are the day, the month and the year, in that order and in
 * every vocabulary - stated once here rather than per entry, because it is what
 * readDate below reads them as.
 *
 * `shape` is also what decides whether a line is a transaction at all - one regex
 * rather than two, or the anchor and the parser drift and a line that looks like a
 * row is dropped as furniture. A line that matches the shape and not the month
 * table is a SKIPPED row with a reason, never a dropped one: a month abbreviation
 * this table has wrong would otherwise make that month's transactions vanish with
 * nothing said.
 */
type DateVocabulary =
  | { kind: 'named-month'; shape: RegExp; months: Readonly<Record<string, number>> }
  | { kind: 'numeric'; shape: RegExp };

const DATE_FORMATS: Record<DateFormat, DateVocabulary> = {
  // "2 июл. 2026г." - the abbreviations are CLDR's ru formatting-context set,
  // which is what the sample's "июл." is, and the year suffix is the generator's
  // own. Never Intl at parse time: a Node built with small-icu has no ru data,
  // and a date that parses on one machine and not another duplicates a statement
  // rather than recognising it (ROADMAP 4.2).
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
  // "01.07.2026", zero-padded throughout the N26 statement measured. Both digits
  // required: a layout that writes 1.7.2026 is a layout nobody has measured, and
  // the round trip below is what refuses 31.02.2026 rather than rolling it over.
  'de-numeric': { kind: 'numeric', shape: /^(\d{2})\.(\d{2})\.(\d{4})$/u },
};

/**
 * UTC throughout and never `new Date(string)`: the calendar day goes into the dedup
 * key, and a local-time parse shifts it by one for half the world's timezones - so
 * the same statement imported from another machine would duplicate every row
 * (ROADMAP 4.2, and the same reason sheet.ts's cellDate is written in UTC).
 *
 * The round trip is the check that the components are a real date: Date.UTC rolls
 * 31 February over into March rather than refusing it.
 */
function readDate(format: DateFormat, m: RegExpExecArray): Date | null {
  const vocabulary = DATE_FORMATS[format];
  const month =
    vocabulary.kind === 'named-month' ? vocabulary.months[m[2]] : Number(m[2]);
  if (month === undefined) return null;
  const day = Number(m[1]);
  const year = Number(m[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCDate() === day && date.getUTCMonth() === month - 1 ? date : null;
}

// ---------- the sheet this frontend produces ----------

/**
 * The synthetic header the mapper resolves, and the mapping that names it, from one
 * set of names so the two cannot drift.
 *
 * The `pdf:` spelling is deliberate and is the opposite of a tidy choice. Named
 * `date`/`amount`/`description` the header would also resolve through
 * genericMapping, so dropping the override would leave the path working and the
 * rule "a PDF's columns come from the template" silently vacuous. Prefixed, nothing
 * but the override can resolve them and dropping it produces a loud refusal.
 */
const HEADER = ['pdf:date', 'pdf:amount', 'pdf:description', 'pdf:currency'];
const DATE = 0;
const AMOUNT = 1;
const DESCRIPTION = 2;
const CURRENCY = 3;

const COLUMNS: Partial<CsvMapping> = {
  date: HEADER[DATE],
  amount: HEADER[AMOUNT],
  description: HEADER[DESCRIPTION],
  currency: HEADER[CURRENCY],
};

/** Exported for the test that hands selectTemplate two templates and one document. */
export interface TextLine {
  page: number;
  y: number;
  items: { x: number; text: string }[];
}

/**
 * How far two baselines may sit apart and still be one line.
 *
 * Two layouts have been measured against it and they do not agree about how much of
 * it a row needs. Revolut draws a transaction's cells on one baseline exactly - its
 * rows vary by 0.000 and only its legal footer reaches 1.880. N26 draws the
 * description on one baseline and the date and the amount 1.95 below it, every row,
 * so a row's own items vary by 1.960 against this 2. The margin is 2%, not the
 * order of magnitude an earlier reading of one document suggested, and what a row
 * splitting in two costs is silent: the date and the amount would form their own
 * line, that line's date cell still matches the shape, and the transaction imports
 * with the right day, the right amount and an empty description - reconciling to
 * the cent (row 6c, D5). The pitch is what still buys the headroom: the closest two
 * baselines the two documents put on separate lines are 13.27 apart.
 *
 * Not a template field, though it is a fact about a layout: the grouping is what a
 * template is matched against, so it is fixed before any template is known.
 */
const TOLERANCE = 2;

/**
 * The document's text, one array of lines in reading order.
 *
 * Grouped by baseline and not by array position (see the file header), then sorted
 * by descending y because a PDF's origin is the bottom left, and within a line by
 * ascending x. pdfjs emits a zero-height whitespace item between placed runs; those
 * are dropped before grouping, or they decide a line's baseline.
 */
async function readLines(
  bytes: Buffer,
  maxPages: number,
): Promise<{ lines: TextLine[]; pages: number; chars: number }> {
  // A copy, not a view: getDocument detaches the array it is given, and a Node
  // Buffer under 8 KB is a window onto a shared pool that other allocations sit in.
  // It refuses a Buffer outright for the same reason.
  const task = getDocument({
    data: new Uint8Array(bytes),
    // pdfjs logs through console; this project logs through pino
    verbosity: VerbosityLevel.ERRORS,
  });
  try {
    const doc = await task.promise.catch((e: unknown) => {
      throw new Error(e instanceof PasswordException ? ENCRYPTED : NOT_A_PDF);
    });
    const pages = doc.numPages;
    // Bytes do not bound what a PDF expands to - compressed streams are the point
    // of the format - and numPages is known before any text is extracted.
    if (pages > maxPages) throw new Error(tooManyPages(pages, maxPages));

    const lines: TextLine[] = [];
    let chars = 0;
    for (let p = 1; p <= pages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const onPage: TextLine[] = [];
      for (const item of content.items) {
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

/**
 * One of the layout's tables, once the header line that opens it has been found.
 *
 * Both readers are bound HERE, to the table that declared them, rather than looked
 * up again when a row is read. Two things follow that a later lookup cannot give:
 * the x-intervals a cell is read at and the headings a refusal names always come
 * from the same half of TableLayout, and a single-column layout has no way to
 * compose a sentence naming two columns it has not got - which is ROADMAP rows 20(a)
 * and 23 a third time if it could (row 6c, Trap 3).
 */
interface OpenTable {
  collect: boolean;
  /** what this line writes in the table's amount column(s), named by its headings */
  amount: (line: TextLine) => ReadAmount;
  /** and whether it writes nothing at all in them: the shape a continuation has */
  blank: (line: TextLine) => boolean;
}

/**
 * A line's date and description cells, and - if the line is one of this layout's
 * table headers - that table.
 *
 * One switch over the layout's amount shape rather than one per call site: a table
 * is recognised by whole-cell equality on every heading it names, and the cells
 * compared are read at that same half of the union's own x-intervals.
 */
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

/**
 * Whether this is the layout. Both halves are needed: the issuer alone would let a
 * redesigned Revolut statement be read against columns that have moved, and the
 * table header alone would let any bank whose generic table happens to sit at these
 * x-intervals through.
 */
function matches(template: PdfTemplate, lines: TextLine[]): boolean {
  const first = lines.filter((l) => l.page === 1);
  const text = first.map((l) => l.items.map((i) => i.text).join(' ')).join('\n');
  if (!template.issuer.every((term) => text.includes(term))) return false;
  return first.some((l) => readLine(template, l).table?.collect === true);
}

/**
 * Which template claims the document, over ALL of them and never the first to match.
 *
 * Detection is O(templates) and §5.2 already paid for that, so there is no runtime
 * argument for stopping early - and stopping early is what makes array order into a
 * silent tie-break that no reviewer reads as ordering. Two templates share half a
 * fingerprint the day a second Revolut layout is added, and the day one of them is
 * loosened for a near miss the earlier entry would win and a statement would be read
 * against another layout's columns: parsed, accepted, plausible and wrong. The throw
 * makes that impossible rather than unlikely (row 6c, R2).
 *
 * Exported, and taking the list as a parameter, for the test - like readSheet in
 * statement.ts and for the same reason. Not API surface anyone asked for.
 */
export function selectTemplate(
  templates: readonly PdfTemplate[],
  lines: TextLine[],
): PdfTemplate | undefined {
  const claimed = templates.filter((t) => matches(t, lines));
  if (claimed.length > 1) throw new Error(ambiguousLayout(claimed.map((t) => t.title)));
  return claimed[0];
}

/**
 * One of the two amount columns, and which one it was is the sign. A line with a
 * value in both or in neither is a SKIPPED row carrying the reason, never a row
 * built from whichever column happened to be filled: a shifted row is a
 * transaction whose amount belongs to its neighbour.
 */
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

/**
 * One column, and the sign is in the cell. The pattern is what carries the sign, so
 * a template whose layout writes it some other way - trailing, or in brackets -
 * refuses the cell rather than handing parseFloat something it reads as positive.
 */
function signed(template: PdfTemplate, heading: string, amount: string): ReadAmount {
  if (!amount) {
    return { value: null, currency: '', note: `is empty in the ${quote(heading)} column` };
  }
  return amountCell(template, amount);
}

/** A cell that is there, against the layout's amount format. */
function amountCell(template: PdfTemplate, raw: string): ReadAmount {
  const unreadable = {
    value: null,
    currency: '',
    note: `reads ${quote(raw)}, where this template reads an amount like "${template.amount.example}"`,
  };
  const m = template.amount.pattern.exec(raw);
  if (!m) return unreadable;
  const currency = template.amount.currency[m[2]];
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

/** Whether the layout wants this continuation line, by the label it starts with. */
function wanted(rows: Exclude<RowExtent, { kind: 'one-line' }>, description: string): boolean {
  switch (rows.kind) {
    case 'continuations':
      return !rows.drop.some((label) => description.startsWith(label));
    case 'labelled-continuations':
      return rows.keep.some((label) => description.startsWith(label));
  }
}

/**
 * The transaction lines, in document order.
 *
 * A line is a data row only if its date cell has the shape of the template's date
 * format AND a `collect` table header has been passed. Everything else - the
 * address block, the balance box, the per-transaction detail lines, the legal
 * footer - is not a candidate and is not counted as skipped: `total` stays the
 * number of transaction lines, which is the number the summary shows a user.
 *
 * A table header the template does not name refuses the whole document rather than
 * being passed over. Skipping it silently is the failure this project cares about
 * most - rows the importer could not read, in an import reported as complete - and
 * a section whose columns are not where the template thinks they are cannot be read
 * correctly anyway. A section that reuses a header the template DOES name is read,
 * which is how Revolut's vault transactions come in beside the account's.
 *
 * On a multi-line layout the furniture is not all furniture: the lines under a
 * dated line carry the counterparty and the reference, and dropping them is a
 * truncation nothing downstream can see - the reconciliation gate sums amounts, so a
 * statement with every description cut to its first line reconciles to the cent and
 * imports (row 6c, R4). So they are appended, and which of them are appended is
 * named by the template rather than decided here.
 */
function readRows(
  template: PdfTemplate,
  lines: TextLine[],
): { rows: Cell[][]; notes: Map<string, string> } {
  const { shape } = DATE_FORMATS[template.dateFormat];
  const rows: Cell[][] = [];
  const notes = new Map<string, string>();
  let table: OpenTable | null = null;
  // the row still taking continuation lines, and the page its dated line was on
  let open: { row: Cell[]; page: number } | null = null;

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
      // A continuation of the row above it: nothing in the date column, nothing in
      // the amount column, something in the description one, and on the page that
      // row's dated line was read on.
      //
      // The page test is not decoration. Pages 2..n of the N26 statement repeat the
      // title and the period in the description column with both other cells empty,
      // which is a continuation's exact shape, and without it those two lines would
      // be appended to the last transaction of the page before. What it costs is
      // stated rather than hidden - a transaction split across a page break would
      // lose its tail - and no transaction in the document measured is split. A
      // layout that does split one is a finding for a later row.
      if (
        template.rows.kind !== 'one-line' &&
        open !== null &&
        table !== null &&
        open.page === line.page &&
        cells.date === '' &&
        cells.description !== '' &&
        table.blank(line) &&
        wanted(template.rows, cells.description)
      ) {
        open.row[DESCRIPTION] = `${cellText(open.row[DESCRIPTION])} ${cells.description}`;
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

    const date = readDate(template.dateFormat, m);
    if (date === null) {
      note(DATE, `reads ${quote(cells.date)}, which this template cannot read as a date`);
    }
    const amount = table.amount(line);
    if (amount.note) note(AMOUNT, amount.note);

    const row: Cell[] = [];
    row[DATE] = date;
    row[AMOUNT] = amount.value;
    row[DESCRIPTION] = cells.description;
    row[CURRENCY] = amount.currency;
    rows.push(row);
    open = { row, page: line.page };
  }
  return { rows, notes };
}

/** One balance, and the label of the line it was read off. */
interface Balance {
  value: number;
  currency: string;
  label: string;
}

/**
 * What the document says it started and ended with, off the line - or the two lines -
 * that state it for the whole statement.
 *
 * Exactly one line per label is required, not the first of several. A layout that
 * repeats a label is a layout nobody has measured, and taking the first is the guess
 * this parser exists not to make.
 *
 * There is no header assertion fingerprinting this box the way `matches` fingerprints
 * the transaction table, and the reason is measured rather than economic: in the first
 * document this was written against, the closing column's heading wraps onto two
 * baselines either side of the header row, so the assertion could only ever be
 * partial - and a table named in half its columns is a table whose shape is not
 * known. What stands in its place is stronger: the gate makes the locator
 * self-checking. Any misread of the box - a column inserted, the two values swapped,
 * the wrong line matched - changes the arithmetic and refuses the import.
 */
function readBalances(template: PdfTemplate, lines: TextLine[]): StatementBalances {
  const { balances } = template;

  const only = (label: string): TextLine => {
    const found = lines.filter((l) => cellAt(l, balances.label) === label);
    if (found.length !== 1) throw new Error(noBalanceBox(template.title, label, found.length));
    return found[0];
  };

  // the same pattern, decimal and currency map the transaction amounts are read
  // with, so a balance in a shape this template does not read is refused exactly as
  // an amount cell is. Whether a sign is accepted here is the template's pattern and
  // nothing else: Revolut's carries none because the transaction columns decide the
  // sign, N26's requires one because the document writes one in every cell, and a
  // balance in a shape neither reads is refused loudly with its cell quoted back
  // rather than given an invented sign (row 6b, D5).
  const read = (
    line: TextLine,
    span: Span,
    label: string,
    which: 'opening' | 'closing',
  ): Balance => {
    const raw = cellAt(line, span);
    const m = template.amount.pattern.exec(raw);
    const currency = m ? template.amount.currency[m[2]] : undefined;
    const value = m ? parseAmount(m[1], template.amount.decimal) : null;
    if (currency === undefined || value === null) {
      throw new Error(
        unreadableBalance(template.title, which, label, raw, template.amount.example),
      );
    }
    return { value, currency, label };
  };

  // Unreachable through either template in this file - both declare a single currency
  // symbol, so both cells are read through the one map and can only agree - and it is
  // here rather than absent because the alternative is taking one cell's currency for
  // both, which is a check against a number that is not the one printed. What makes it
  // reachable at all is readPdf's `templates` parameter, which the test hands a
  // two-symbol template (ROADMAP row 6c: it owes this arm a test, not a document).
  const both = (opening: Balance, closing: Balance): StatementBalances => {
    if (opening.currency !== closing.currency) {
      throw new Error(mixedBalanceCurrencies(template.title, opening, closing));
    }
    return {
      openingCents: toCents(opening.value),
      closingCents: toCents(closing.value),
      currency: opening.currency,
    };
  };

  switch (balances.kind) {
    case 'one-line': {
      const line = only(balances.total);
      return both(
        read(line, balances.opening, balances.total, 'opening'),
        read(line, balances.closing, balances.total, 'closing'),
      );
    }
    case 'two-lines':
      return both(
        read(only(balances.opening), balances.value, balances.opening, 'opening'),
        read(only(balances.closing), balances.value, balances.closing, 'closing'),
      );
  }
}

/**
 * Bytes to rows. maxPages is passed in rather than declared here so that it is read
 * beside the byte cap it does not replace (see SIZE_CAP in statement.ts).
 *
 * Everything this throws leaves a `failed` import with its document, because all of
 * it needed the file opened - which is what makes a miss diagnosable, and what
 * ROADMAP 5.2 means by recording which template to build next.
 *
 * `templates` defaults to the whole list and production never passes it, exactly as
 * readSheet is exported for its `never` default: two of the refusals below can be
 * reached by no document either template in this file matches, and an arm nothing
 * has watched throw is worth nothing (row 6c, D6).
 */
export async function readPdf(
  bytes: Buffer,
  maxPages: number,
  templates: readonly PdfTemplate[] = TEMPLATES,
): Promise<PdfStatement> {
  const { lines, pages, chars } = await readLines(bytes, maxPages);

  const template = selectTemplate(templates, lines);
  if (!template) throw new Error(chars / pages < MIN_CHARS_PER_PAGE ? SCANNED : NOT_RECOGNISED);

  const { rows, notes } = readRows(template, lines);
  if (rows.length === 0) throw new Error(noTransactionLines(template.title));
  // last, because everything above is "this is not the document I know" and the box
  // is the last thing read - so a document that refuses for one of those reasons goes
  // on refusing for it
  const balances = readBalances(template, lines);

  return {
    sheet: {
      rows: [HEADER, ...rows],
      // the nth transaction line of the statement: a PDF has no row numbers of its
      // own, and rowLabel answers with a number
      rowLabel: (i) => i,
      note: (row, col) => notes.get(`${row}:${col}`),
    },
    template: template.id,
    title: template.title,
    columns: COLUMNS,
    balances,
  };
}

// ---------- the templates ----------

/**
 * Every number and every literal below was measured off a real statement, one per
 * template, and nothing in this repository checks either against another document:
 * the fixtures in pdf.test.ts are written to match these templates, so a green suite
 * proves the reader works and not that a layout is right. The evidence for a layout
 * is a manual check against a document - for revolut-ru the CSV export of the same
 * weeks importing to the same rows, and for n26-de the statement's own printed
 * summary, since N26 offers no CSV. The second is the weaker of the two and saying so
 * is part of it.
 *
 * One per LAYOUT and not per bank: the Revolut export in English is a third template
 * and not a flag on the first, and a layout nobody has seen is not written from
 * imagination (ROADMAP 5.2, row 6c).
 *
 * Exported for the near-miss case in test/pdf.test.ts, like readSheet in statement.ts
 * and for the same reason: a case that bounds a drop label has to read the label off
 * the template rather than copy it, or the copy drifts and the case goes on passing
 * against a rule that is no longer there.
 */
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
      // the account's own transactions, and the vaults' - one header, both real
      {
        header: {
          date: 'Дата',
          description: 'Описание',
          debit: 'Списания',
          credit: 'Пополнения',
        },
        collect: true,
      },
      // "В статусе ожидания": authorised, not settled. Whole-cell equality on the
      // date heading is the only thing between the two tables, and it is the same
      // reason matchColumn refuses a prefix - "Дата начала" is two columns and
      // several days from "Дата выполнения" in this bank's CSV.
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
    dateFormat: 'ru-abbrev',
    amount: {
      // "5,96€", "1 742,18€" - the group separator is an ASCII space, and the
      // symbol carries none, so "5,68 EUR" is a cell in the wrong shape rather
      // than a currency this template has not met
      pattern: /^(\d{1,3}(?: \d{3})*,\d{2})([^\s\d]+)$/u,
      decimal: ',',
      currency: { '€': 'EUR' },
      example: '1 234,56€',
    },
    // A transaction is a dated line plus one to three detail lines, and every one of
    // them carries one of exactly four labels: over the whole document measured,
    // "Получатель:" 54, "Карта:" 49, "Реквизиты:" 17, "Отправитель:" 13, and no
    // unlabelled detail line anywhere. So this layout names what it KEEPS. The 54
    // unlabelled lines of that shape are all deposit-insurance footer, printed at the
    // bottom of each page in the description column with every other cell empty - a
    // continuation's exact shape, on the same page as the transaction it would attach
    // to, so the page test above cannot see it. Under a drop list it added ~800
    // characters to whichever transaction was open and took the longest description
    // to 946; here it is excluded by having no label rather than by anybody reading
    // what it says.
    //
    // "Карта:" is the one label named and not kept: a masked PAN, one distinct value
    // on all 49 occurrences, so it cannot tell two transactions apart, and the CSV
    // export of the same month carries no card number at all. The other three carry
    // the merchant's trading name, the counterparty and the sender's reference, which
    // is what the categoriser, the transfer detector and the export are for - the
    // dated line alone says "REWE.de" where the document prints "Получатель: Rewe
    // Markt Mueller, Hamburg" (ROADMAP row 34).
    rows: {
      kind: 'labelled-continuations',
      keep: ['Получатель:', 'Реквизиты:', 'Отправитель:'],
    },
    // "Сведения о балансе" states a pair per product - the account, then the
    // wallets - and an "Итого" line under them that is the sum of both. It is the
    // Итого pair and never the account's: the account's own transactions and the
    // wallets' come in through the one `collect: true` header above, so a transfer
    // into a wallet is two of the rows summed, and checked against the account's
    // pair alone the statement would be out by exactly those transfers.
    balances: {
      kind: 'one-line',
      total: 'Итого',
      // the date column's interval, and deliberately as narrow: the description
      // column starts at 124.8, so a transaction whose description is the word
      // "Итого" cannot reach the label cell
      label: [35, 120],
      // the box's values are left-aligned, so a wider number extends right and the
      // left edge does not move. That is a property of THIS layout and not of the
      // format - see n26-de's amount column, which is right-aligned
      opening: [250, 330],
      // over the running-balance column that every transaction line carries, which
      // is safe only because the line is found by its label first and never by
      // scanning here. 596 is the page width
      closing: [500, 596],
    },
  },
  {
    id: 'n26-de',
    title: 'N26',
    // The generator's own German wording twice, plus the bank's own BIC out of the
    // footer. Never the account holder's IBAN, which sits in the same text item: a
    // fingerprint that falls back to a per-customer value is R3's stop-and-report,
    // and this one does not. The word "N26" is deliberately not here - on page 1 it
    // is vector art, and every occurrence of the string is a transaction
    // DESCRIPTION, which another month would not carry. The cost is stated: an N26
    // account on some other BIC is refused by name, which is the good failure - it
    // says which layout was expected and it is one template edit from working.
    issuer: ['Kontoauszug Nr.', 'Erstellt am', 'BIC: NTSBDEB1XXX'],
    amounts: 'signed',
    // Three columns, headed at 44.5 / 341.7 / 515.1, and the boundaries sit in the
    // gaps between what the columns actually write: descriptions start at 42.8-44.5
    // and the widest ends at 321.8; dates run 389.1-448.0; amounts 491.2-551.5.
    //
    // The amount column is measured WIDE because it is right-aligned - "-1.140,57€"
    // starts at 499.5 where "-4,90€" starts at 515.8, a 16-point spread, because the
    // number grows leftwards from a fixed right edge. An item is assigned by its
    // left edge, so a span narrow enough for the short amounts would drop the long
    // ones. What that would cost is a short sum and a refused import, because the
    // gate sums what was read - and the same is true of the date column. The
    // description column is the one a wrong boundary damages silently, which is why
    // the continuation rule below gets its own test.
    columns: {
      description: [0, 330],
      date: [330, 460],
      amount: [460, 596],
    },
    marker: { column: 'description', text: 'Beschreibung' },
    tables: [
      { header: { description: 'Beschreibung', date: 'Verbuchungsdatum', amount: 'Betrag' }, collect: true },
      // The summary page repeats "Beschreibung" alone, so it IS a table header line
      // and readRows refuses the document over one it does not name. Naming it here
      // with `collect: false` is what keeps its four total lines - "Dein alter
      // Kontostand", "Ausgehende Transaktionen", "Einkommende Transaktionen", "Dein
      // neuer Kontostand" - out of the import, and one empty heading is all that
      // tells the two tables apart.
      { header: { description: 'Beschreibung', date: '', amount: '' }, collect: false },
    ],
    dateFormat: 'de-numeric',
    amount: {
      // "+0,13€", "-1.140,57€" - "." groups thousands, "," is the decimal and the
      // sign is required rather than optional: an unsigned cell is a cell in a shape
      // this layout does not write, and a skipped row with its reason is louder than
      // a positive number that was meant to be a debit
      pattern: /^([+-]\d{1,3}(?:\.\d{3})*,\d{2})([^\s\d]+)$/u,
      decimal: ',',
      currency: { '€': 'EUR' },
      example: '-1.234,56€',
    },
    // A transaction is a dated line plus one to five detail lines, all in the
    // description column with the other two cells empty: the wrapped tail of the
    // name, a category word, the counterparty's IBAN and BIC, a free-text reference
    // and a "Wertstellung" value date. Ten of the nineteen rows in the document
    // measured carry the SAME name on the dated line and are told apart only by
    // their reference line, so dropping the detail would make them read identically -
    // and it is the reference, not the name, that a categoriser can use.
    //
    // Most of them carry no label at all - "Belastungen", "Wertstellung 01.07.2026",
    // "LOHN / GEHALT 07/26" - so this layout cannot name what it keeps and names what
    // it drops instead. It has to be read as an obligation to enumerate what the
    // layout writes below its transactions; N26's own footer writes in the amount
    // column, so `blank()` already refuses it, and that is a measurement rather than
    // a promise.
    //
    // The one line dropped is the counterparty's IBAN and BIC. Other people's
    // identifiers do not belong in a column the categoriser, the transfer detector
    // and the export all read, and "the bytes are already stored" is a different fact
    // - the stored document is encrypted and not queryable. The label alone is the
    // rule: the shape this was written as before matched the value's character class,
    // so a grouped IBAN or a line missing its BIC half landed whole in the column.
    //
    // What that costs: the unit is the LINE, so a reference printed after the
    // identifier on the same line goes with it. None of the 17 lines on the document
    // measured carries one, and a statement that starts writing "IBAN: DE…
    // Verwendungszweck …" loses the reference with nothing refusing and nothing
    // noting it.
    rows: { kind: 'continuations', drop: ['IBAN:'] },
    // Two lines 79 units apart under two different labels, on the summary page, with
    // two other lines between them - which is why BalanceBox has a second kind at
    // all. Each label occurs exactly once in the whole document.
    balances: {
      kind: 'two-lines',
      // the description column, because that is where this layout writes its labels.
      // Unlike revolut-ru's, it cannot be narrowed to a column no transaction
      // reaches: a transaction described exactly "Dein alter Kontostand" makes the
      // count 2 and the import is refused rather than misread
      label: [0, 330],
      value: [460, 596],
      opening: 'Dein alter Kontostand',
      closing: 'Dein neuer Kontostand',
    },
  },
];

/**
 * Every sentence in the refusal set, composed at its own extreme out of every
 * template's own literals: the title a refusal names the layout by, the balance
 * labels it quotes back, the currency codes it declares and the example it offers,
 * against the widest cell a quote may hold and the widest count one may carry.
 *
 * Exported for the 'diagnostic budget' case in test/pdf.test.ts, like readSheet in
 * statement.ts and for the same reason. It composes rather than measures because a
 * measurement is true only on the day it is taken: a template added with a long
 * label moves the longest sentence, and a number written down once would go on
 * passing over one that had grown past what error_detail keeps (ROADMAP row 21).
 *
 * What it does not hold is a refusal added above and not added here. Nothing
 * structural can - the set is a list of literals and builders with different
 * signatures - so it is one list beside another and the comment is the whole of the
 * warning.
 */
export function refusals(templates: readonly PdfTemplate[] = TEMPLATES): string[] {
  // wider than a quote may hold, so the bound is what decides the length
  const cell = 'W'.repeat(CELL_QUOTE_MAX + 2);
  // more lines than a statement at MAX_PDF_PAGES has, so the count is at its widest
  const found = 999_999;
  const longest = (xs: string[]): string => xs.reduce((a, b) => (a.length >= b.length ? a : b), '');

  const all = [
    ENCRYPTED,
    NOT_A_PDF,
    NOT_RECOGNISED,
    SCANNED,
    tooManyPages(found, found),
    ambiguousLayout(templates.map((t) => t.title)),
  ];
  for (const t of templates) {
    const label = longest(
      t.balances.kind === 'one-line'
        ? [t.balances.total]
        : [t.balances.opening, t.balances.closing],
    );
    const code = longest(Object.values(t.amount.currency));
    all.push(
      unreadableTable(t.title, quote(cell)),
      noTransactionLines(t.title),
      noBalanceBox(t.title, label, found),
      unreadableBalance(t.title, 'opening', label, cell, t.amount.example),
      unreadableBalance(t.title, 'closing', label, cell, t.amount.example),
      mixedBalanceCurrencies(t.title, { label, currency: code }, { label, currency: code }),
    );
  }
  return all;
}
