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
import { CsvMapping, parseAmount } from './csv';
import { Cell, Sheet } from './sheet';

/**
 * Bumped whenever a change here would parse an existing file differently. Per
 * parser, keyed by imports.source_type - see CSV_PARSER_VERSION.
 */
export const PDF_PARSER_VERSION = 1;

/**
 * What the PDF frontend answers with (ROADMAP row 6a, Ruling 1). A Sheet the shared
 * mapper reads, and the facts only this format carries. 6b's opening and closing
 * balance, the statement currency and the IBAN attach HERE rather than to Sheet:
 * required per template, so that "this format has no balances" and "the template
 * was supposed to find the closing balance and did not" cannot be spelled the same
 * way. Sheet is produced by three frontends and two of them can never carry one.
 */
export interface PdfStatement {
  sheet: Sheet;
  /** which template matched - a log line, never a row problem (Ruling 4) */
  template: string;
  /** the columns of `sheet`, named by this module and never by the request */
  columns: Partial<CsvMapping>;
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
 * Every way this parser can refuse, in one place so that no two of them can come to
 * read alike. All of them are composed inside ERROR_DETAIL_MAX; the longest, at the
 * extreme of the one number and the one quote any of them carries, is 206.
 *
 * The first two are what the document turned out not to be, the next two what no
 * template could make of it, and the last two what a template found and could not
 * finish. Each says what to do instead, and none of them is a dead end: CSV and
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

/** Cut with a mark, so a value with more behind it does not read as the whole one. */
const bounded = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

const quote = (text: string): string => `"${bounded(text, CELL_QUOTE_MAX)}"`;

// ---------- what a template is ----------

/** [left, right) in PDF user units. An item is assigned by the x of its left edge. */
type Span = readonly [number, number];

type ColumnKey = 'date' | 'description' | 'debit' | 'credit';

type Cells = Record<ColumnKey, string>;

/**
 * One of the tables a layout writes, by the heading each of its columns carries.
 * Total over ColumnKey rather than partial: a table this importer has looked at and
 * named only three columns of is a table it does not actually know the shape of.
 *
 * `collect: false` is what keeps Revolut's "В статусе ожидания" block out of the
 * import. Those rows are money that has not moved, and the CSV path drops them
 * through State != COMPLETED - a PDF import that took them would disagree with the
 * CSV of the same weeks, which is the one comparison this row can be checked by.
 */
interface PdfTable {
  header: Cells;
  collect: boolean;
}

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

interface PdfTemplate {
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
  columns: Readonly<Record<ColumnKey, Span>>;
  /** the heading that says a line is a table header at all, whichever table it is */
  marker: { column: ColumnKey; text: string };
  tables: readonly PdfTable[];
  dateFormat: DateFormat;
  amount: AmountFormat;
}

// ---------- dates ----------

type DateFormat = 'ru-abbrev';

/**
 * A named vocabulary rather than a callback per template: the reader owns the
 * parsing and a template says which rule it is written in, so 6c widens this list
 * instead of shipping a parser inside a data literal.
 *
 * `shape` is also what decides whether a line is a transaction at all - one regex
 * rather than two, or the anchor and the parser drift and a line that looks like a
 * row is dropped as furniture. A line that matches the shape and not the month
 * table is a SKIPPED row with a reason, never a dropped one: a month abbreviation
 * this table has wrong would otherwise make that month's transactions vanish with
 * nothing said.
 */
const DATE_FORMATS: Record<DateFormat, { shape: RegExp; months: Readonly<Record<string, number>> }> =
  {
    // "2 июл. 2026г." - the abbreviations are CLDR's ru formatting-context set,
    // which is what the sample's "июл." is, and the year suffix is the generator's
    // own. Never Intl at parse time: a Node built with small-icu has no ru data,
    // and a date that parses on one machine and not another duplicates a statement
    // rather than recognising it (ROADMAP 4.2).
    'ru-abbrev': {
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
  const month = DATE_FORMATS[format].months[m[2]];
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

interface TextLine {
  page: number;
  y: number;
  items: { x: number; text: string }[];
}

/**
 * How far two baselines may sit apart and still be one line. A statement's row
 * pitch is 12-20 user units and a row's own items vary by well under one, so this
 * is an order of magnitude below the distance at which two rows could merge and
 * still absorbs the sub-unit jitter a mixed-size line arrives with.
 *
 * Not a template field, though it is a fact about a layout: the grouping is what a
 * template is matched against, so it is fixed before any template is known. 6c is
 * what would prove one number does not do for every layout.
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

const cellsOf = (template: PdfTemplate, line: TextLine): Cells => {
  const cell = (span: Span): string =>
    line.items
      .filter((i) => i.x >= span[0] && i.x < span[1])
      .map((i) => i.text)
      .join(' ');
  return {
    date: cell(template.columns.date),
    description: cell(template.columns.description),
    debit: cell(template.columns.debit),
    credit: cell(template.columns.credit),
  };
};

const tableOf = (template: PdfTemplate, cells: Cells): PdfTable | undefined =>
  template.tables.find((t) =>
    (Object.keys(t.header) as ColumnKey[]).every((k) => cells[k] === t.header[k]),
  );

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
  return first.some((l) => tableOf(template, cellsOf(template, l))?.collect === true);
}

interface ReadAmount {
  value: number | null;
  currency: string;
  note?: string;
}

/**
 * One of the two amount columns, and which one it was is the sign. A line with a
 * value in both or in neither is a SKIPPED row carrying the reason, never a row
 * built from whichever column happened to be filled: a shifted row is a
 * transaction whose amount belongs to its neighbour.
 */
function readAmount(template: PdfTemplate, table: PdfTable, cells: Cells): ReadAmount {
  const { debit, credit } = cells;
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
      note: `is empty in both the ${quote(table.header.debit)} and ${quote(table.header.credit)} columns`,
    };
  }
  const raw = debit || credit;
  const m = template.amount.pattern.exec(raw);
  if (!m) {
    return {
      value: null,
      currency: '',
      note: `reads ${quote(raw)}, where this template reads an amount like "${template.amount.example}"`,
    };
  }
  const currency = template.amount.currency[m[2]];
  if (currency === undefined) {
    return {
      value: null,
      currency: '',
      note: `reads ${quote(raw)}, and ${quote(m[2])} is not a currency symbol this template knows`,
    };
  }
  const value = parseAmount(m[1], template.amount.decimal);
  if (value === null) {
    return {
      value: null,
      currency: '',
      note: `reads ${quote(raw)}, where this template reads an amount like "${template.amount.example}"`,
    };
  }
  return { value: debit ? -value : value, currency };
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
 */
function readRows(
  template: PdfTemplate,
  lines: TextLine[],
): { rows: Cell[][]; notes: Map<string, string> } {
  const { shape } = DATE_FORMATS[template.dateFormat];
  const rows: Cell[][] = [];
  const notes = new Map<string, string>();
  let table: PdfTable | null = null;

  for (const line of lines) {
    const cells = cellsOf(template, line);
    const m = shape.exec(cells.date);
    if (!m) {
      if (cells[template.marker.column] !== template.marker.text) continue;
      const found = tableOf(template, cells);
      if (!found) throw new Error(unreadableTable(template.title, quote(cells.date)));
      table = found;
      continue;
    }
    if (!table?.collect) continue;

    // rows[] becomes sheet.rows[1..n]: the synthetic header takes index 0
    const i = rows.length + 1;
    const note = (col: number, text: string): void => {
      notes.set(`${i}:${col}`, bounded(text, NOTE_MAX));
    };

    const date = readDate(template.dateFormat, m);
    if (date === null) {
      note(DATE, `reads ${quote(cells.date)}, which this template cannot read as a date`);
    }
    const amount = readAmount(template, table, cells);
    if (amount.note) note(AMOUNT, amount.note);

    const row: Cell[] = [];
    row[DATE] = date;
    row[AMOUNT] = amount.value;
    row[DESCRIPTION] = cells.description;
    row[CURRENCY] = amount.currency;
    rows.push(row);
  }
  return { rows, notes };
}

/**
 * Bytes to rows. maxPages is passed in rather than declared here so that it is read
 * beside the byte cap it does not replace (see SIZE_CAP in statement.ts).
 *
 * Everything this throws leaves a `failed` import with its document, because all of
 * it needed the file opened - which is what makes a miss diagnosable, and what
 * ROADMAP 5.2 means by recording which template to build next.
 */
export async function readPdf(bytes: Buffer, maxPages: number): Promise<PdfStatement> {
  const { lines, pages, chars } = await readLines(bytes, maxPages);

  const template = TEMPLATES.find((t) => matches(t, lines));
  if (!template) throw new Error(chars / pages < MIN_CHARS_PER_PAGE ? SCANNED : NOT_RECOGNISED);

  const { rows, notes } = readRows(template, lines);
  if (rows.length === 0) throw new Error(noTransactionLines(template.title));

  return {
    sheet: {
      rows: [HEADER, ...rows],
      // the nth transaction line of the statement: a PDF has no row numbers of its
      // own, and rowLabel answers with a number
      rowLabel: (i) => i,
      note: (row, col) => notes.get(`${row}:${col}`),
    },
    template: template.id,
    columns: COLUMNS,
  };
}

// ---------- the templates ----------

/**
 * Every number and every literal below was measured off one real statement, and
 * nothing in this repository checks it against another: the fixture in pdf.test.ts
 * is written to match this template, so a green suite proves the reader works and
 * not that the layout is right. The evidence for the layout is a manual check
 * against a document, and for this one it is the CSV export of the same weeks
 * importing to the same rows.
 *
 * Russian export only - the same statement in English is a second layout, and a
 * layout nobody has seen is not written from imagination (ROADMAP 5.2, row 6c).
 */
const TEMPLATES: readonly PdfTemplate[] = [
  {
    id: 'revolut-ru',
    title: 'Revolut',
    issuer: ['Revolut Bank UAB'],
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
  },
];
