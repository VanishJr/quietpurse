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
import { toCents } from '../money';
import { CsvMapping, parseAmount } from './csv';
import { ISSUERS, issuerName } from './issuer';
import { loadPdfjs } from './pdfjsloader';
import { Cell, Sheet, cellText } from './sheet';

/**
 * Bumped whenever a change here would parse an existing file differently. Per
 * parser, keyed by imports.source_type - see CSV_PARSER_VERSION.
 */
export const PDF_PARSER_VERSION = 5;

/**
 * What the document says it started and ended with, for the whole statement rather
 * than for one of the products inside it, and what it says each side came to.
 *
 * Minor units, because the gate that compares these to the rows compares integers.
 * The real statement's 70 amounts summed as decimals come to 123.45000000000002,
 * which against a closing balance of 579.85 is a refused import and a wrong one
 * (ROADMAP 4.6). A field named `openingCents` cannot be compared with a decimal sum
 * by accident.
 *
 * `gross` mirrors the shape of the template's own declaration, which does NOT stop a
 * `not-printed` template returning a printed pair - one branch of readBalances is
 * what stops that, and a type can force a value's provenance and not what a branch
 * does (row 6b, D12). What it does hold is downstream: the absent case is
 * unrepresentable, so `reconcile` cannot read two cents fields that were never
 * printed.
 */
export interface StatementBalances {
  openingCents: number;
  closingCents: number;
  /** what each side came to, on the rows' own convention: outgoing negative */
  gross:
    | { kind: 'printed'; outgoingCents: number; incomingCents: number }
    | { kind: 'not-printed' };
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
 * Not every way an import of a PDF can refuse: the reconciliation gate's three
 * sentences live beside `reconcile` in statement.ts, because they name counts of
 * MAPPED rows - how many lines became transactions, how many were skipped - which
 * this module never sees. Keeping them here would mean exporting message builders to
 * be called with numbers from the other side of the seam, which couples the two
 * modules for the sake of one file (row 6b, D2).
 *
 * The first two are what the document turned out not to be, the next four what the
 * template list could not settle on, and the rest what a template found and could
 * not finish. Each says what to do instead, and none of them is a dead end: CSV and
 * Excel from the same online banking import today, which for as long as the
 * template list is short is the common path rather than a rough edge (ROADMAP,
 * "'Import finished' does not mean every bank").
 */
const ENCRYPTED =
  'this PDF is password-protected - open it with its password and save an unprotected copy, or download the statement again from your online banking';

// "looks like a PDF" rather than "starts with %PDF": a signed container carries the
// header at an offset (row 33), so the old clause was a claim about the first four
// bytes that anyone holding one could open a hex editor and disprove.
const NOT_A_PDF =
  'this file looks like a PDF but could not be opened as one - download the statement again from your online banking, or export it as CSV or Excel (.xlsx)';

/**
 * The half that says what to do instead, shared by both wordings so that the named
 * refusal and the unnamed one cannot come to give different advice (row 30, Q4).
 */
const NOT_RECOGNISED_TAIL =
  'layout is not one this importer recognises yet - export the same statement as CSV or Excel (.xlsx) from the same online banking and upload that; those import today';

const NOT_RECOGNISED = `this statement's ${NOT_RECOGNISED_TAIL}`;

/**
 * The same refusal, for a document that printed enough to say whose it is. The name is
 * the institution `issuerName` read off the document's own every-page IBAN, never a
 * template title (row 30, D-G): a title names a layout, this names a bank, and a
 * redesigned layout at a bank the directory knows is refused BY that bank's name -
 * which is §5.2's decay being loud rather than a bug to suppress.
 */
const notRecognisedFrom = (name: string): string =>
  `this looks like a statement from ${name}, and its ${NOT_RECOGNISED_TAIL}`;

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

/**
 * The seven builders below open `this ${title} statement` and not `this looks like a
 * ${title} statement but`, which is what they read as until row 31.
 *
 * Two reasons, and the first is the article: `a N26`, and `a АТ «УНІВЕРСАЛ БАНК»`.
 * The article-free fix that suggests itself - `this looks like a statement from
 * ${title}` - is taken, by notRecognisedFrom, where it means "this bank is known and
 * its layout is not"; these five mean the opposite ("the layout is known and
 * something inside it broke"), and two refusals with one head and opposite meanings
 * are worse than the article.
 *
 * The second is why the hedge can go at all: every one of these fires AFTER a
 * template has claimed the document, so there is nothing left to hedge about - and
 * statement.ts's three gate refusals, which fire on the same evidence one seam later,
 * already assert flatly with `this ${title} statement`. A user cannot tell which side
 * of that seam a refusal came from and should not have to, so the two sets open
 * identically and diverge from notRecognisedFrom's at character 6.
 */
const unreadableTable = (title: string, cell: string): string =>
  `this ${title} statement has a table this importer cannot read (${cell}) - export the same statement as CSV or Excel (.xlsx) from your online banking and upload that`;

/**
 * mapAndStore's own "no data rows (header only, or empty)" names a header, to
 * someone holding a document that has not got one.
 */
const noTransactionLines = (title: string): string =>
  `this ${title} statement has no transaction lines in it - if the statement is really empty then nothing is missing; otherwise export it as CSV or Excel (.xlsx) from your online banking`;

const noBalanceBox = (title: string, label: string, found: number): string =>
  `this ${title} statement has a balance summary this importer could not read: it expects exactly one "${label}" line and found ${found} - export the same statement as CSV or Excel (.xlsx) from your online banking and upload that`;

/**
 * A `section` scope whose opening heading is nowhere in the document (row 57, D2).
 *
 * No count, and there is no arm for one: the opener resolves to the FIRST line that
 * carries it, so a repeat is not an error and 0 is the only number this can be
 * composed with. An argument with one reachable value is an arm nobody can watch throw
 * (row 6c, D6). What holds the choice of section is `only()` inside it, unchanged.
 */
const unplacedBalanceBox = (title: string, opens: string): string =>
  `this ${title} statement's balance summary is one this importer could not place: it reads the summary of the section headed "${opens}", and this document prints no such heading - export the same statement as CSV or Excel (.xlsx) from your online banking and upload that`;

/**
 * A layout whose date cells carry no year states the period once, and the year of
 * every row is read out of it - so a document that states it twice over, or not at
 * all, is one whose rows cannot be dated. Counted over the DISTINCT period lines
 * inside the scope, which is why a reprinted page frame is not two.
 */
const noStatementPeriod = (title: string, found: number): string =>
  `this ${title} statement's rows carry a day and a month and no year, so this template reads the year off the period the statement covers - and it expects exactly one such line and found ${found} - export the same statement as CSV or Excel (.xlsx) from your online banking and upload that`;

/**
 * Which cell of the box a refusal is about, as the whole noun phrase rather than a
 * bare direction: a gross total is not a balance, so "the outgoing balance cell"
 * would be a sentence naming a thing the document has not got - and a branch inside
 * a message builder to pick the noun is worse than the phrase being the parameter
 * (row 035, D5).
 */
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

/**
 * Each cell is named by the line it was read off, because a layout may state them
 * under a label each on a line each and one that does has no single label to name.
 */
const mixedBalanceCurrencies = (
  title: string,
  a: { role: BalanceRole; label: string; currency: string },
  b: { role: BalanceRole; label: string; currency: string },
): string =>
  `this ${title} statement's ${a.role} (${quote(a.label)}) is stated in ${a.currency} and its ${b.role} (${quote(b.label)}) in ${b.currency} - this importer cannot check a statement that mixes currencies; export the same statement as CSV or Excel (.xlsx) from your online banking and upload that`;

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
 * Where an amount's currency comes from, which is a different question from what the
 * amount is. Two of the layouts measured write the symbol in the cell; the third
 * states it once in a column heading - "Сума в валюті картки (UAH)" - and writes a
 * bare number in every cell under it, so there is no group 2 for a symbol to be read
 * out of and no cell that could carry one (row 31).
 *
 * A union and never an optional field or an empty key, for the reason TableLayout is
 * one. `currency: { '': 'UAH' }` is what an optional group 2 invites, and under it
 * every cell this parser could not read resolves to a currency anyway - the
 * silent-wrong-money shape the whole module exists to refuse. Here the bare-number
 * layout names its code once, `symbols` is not reachable on that arm, and tsc refuses
 * a half-written one. What holds the codes and symbols themselves is a case in
 * test/pdf.test.ts, because a type cannot see inside a string.
 */
type AmountCurrency =
  /** the cell carries it: group 2 of `pattern` is the symbol, mapped here */
  | { kind: 'in-the-cell'; symbols: Readonly<Record<string, string>> }
  /** the layout states it in a column heading; the cell is a bare number */
  | { kind: 'per-column'; code: string };

/**
 * How this layout writes an amount. The pattern must match the whole cell: a bank
 * that writes "1234,56-" for a debit hands parseFloat a number it reads as positive
 * and stops, so an amount is validated by shape before it is parsed, never after.
 */
interface AmountFormat {
  /** group 1 the number; group 2 the currency symbol, on the `in-the-cell` arm only */
  pattern: RegExp;
  decimal: CsvMapping['decimal'];
  currency: AmountCurrency;
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
 * Which way round a summary cell carries its sign, and there is no deriving it: the
 * two layouts measured disagree. Revolut prints "1 742,18€" unsigned in a column
 * whose identity IS the sign; N26 prints "-2.948,37€" with the sign in the cell.
 *
 * Declared rather than inferred from `amounts`, which correlates on both documents
 * measured and is not a fact about layouts - a debit-credit table whose summary line
 * prints "-1 742,18€", or a signed table whose summary prints an unsigned magnitude
 * under a directional label, are both ordinary documents that the inference makes
 * inexpressible. What holds a template that declares it backwards is arithmetic: the
 * printed figure and the rows' own sum then differ by twice the figure, so every
 * import from that layout is refused (row 035, D6).
 */
type GrossSigns = 'signed' | 'magnitudes';

/**
 * The escape, and the honest statement of what holds it: NOTHING STRUCTURAL DOES.
 * `tsc` can force the declaration to exist and force its shape; it cannot tell a
 * template author who read the summary block and found no per-side totals from one
 * who did not look. What stands in its place is a case in test/pdf.test.ts pinning
 * the set of template ids that reach for this to a literal list, empty today - so an
 * author who takes it gets a red suite and has to write their own id into that list.
 *
 * It exists at all because the two claims differ in a way `BalanceBox` itself does
 * not have to express: a document stating no balances is not importable AT ALL
 * (ROADMAP 5.3, row 3), so there is nothing for the balance locator to escape to,
 * where a document stating balances and no per-side totals is importable with half
 * the check - a real layout, refused by nothing else.
 */
type NoGrossTotals = { kind: 'not-printed' };

type GrossSpans =
  | { kind: 'printed'; signs: GrossSigns; outgoing: Span; incoming: Span }
  | NoGrossTotals;

type GrossLabels =
  | { kind: 'printed'; signs: GrossSigns; outgoing: string; incoming: string }
  | NoGrossTotals;

/**
 * Which lines readBalances searches - and, for a layout whose date cells carry no
 * year, where the statement's own period is read (row 57, R-A(1)).
 *
 * Required and total, with no optional field and no default. `whole-document` is a
 * DECLARATION that each of this box's labels was measured to occur exactly once in
 * the whole file, not an escape hatch: it is what the four layouts measured before
 * this one all say, and `only()`'s throw is what enforces it.
 *
 * `section` exists because one layout prints the same four labels twice - once for
 * the statement, once for a quarterly Rechnungsabschluss covering a different period -
 * and three of the four numbers agree, so no arithmetic can tell the blocks apart.
 * The one that differs is the opening balance, which is the number the rows would have
 * to supply. Both literals are matched as PREFIXES of the cell at `label`, because a
 * section title carries a month or a quarter beside it: the rule is anchored on the
 * generator's own label with the varying part left outside it, which is the direction
 * 6c D17 finding 2 permits.
 *
 * `opens` resolves to the FIRST line that carries it and a repeat is not an error, for
 * a reason worth writing down: a section long enough to span pages may reprint its own
 * title at the top of each, and refusing that would reject an ordinary month for a
 * property a dormant one happens not to have. Nothing is given up by it - the
 * fail-closed property was never held by the opener's uniqueness. Opening too early
 * admits a second box and `only()` finds 2; too late excludes the statement's own and
 * it finds 0. There is no arrangement in which the first opener selects exactly one
 * box and it is the wrong one, because `opens` and `closes` name two DIFFERENT labels -
 * which is what separates this from "take the first opening-balance line", a rule that
 * chooses between two identically-labelled things and cannot be loud about it.
 *
 * `closes` is a non-empty tuple: `[]` would mean "this section never ends", a section
 * scope that scopes nothing, written by the author least sure of what they were
 * reading - the shape this whole type exists to make unwritable.
 */
type BalanceScope =
  | { kind: 'whole-document' }
  | {
      kind: 'section';
      /** the prefix of the line that opens it, read at the box's own `label` span */
      opens: string;
      /** and the prefixes of whichever heading ends it first */
      closes: readonly [string, ...string[]];
    };

/**
 * Where the layout states the statement's own opening and closing balance, and what
 * each side came to, for the whole document rather than for one of its products.
 *
 * Required and total, the same way a table's header is total over its columns. The
 * two balances have no variant meaning "this layout states none": that is what would
 * let a template author who could not find the box write it away, and the weakest
 * parser in the product would then ship with its only check switched off by a data
 * literal - on exactly the layouts whose author was least sure of what they were
 * reading. A document that does not state its balances is not importable today
 * (ROADMAP 5.3, row 3 of the table) and is refused by simply not being a template.
 *
 * `gross` is the one place that argument does not reach, and it is required and
 * total too: a layout may genuinely print no per-side totals, so it has a named arm
 * saying so, and what keeps that arm from being the same escape one level down is
 * written above NoGrossTotals rather than claimed here.
 *
 * Two kinds, because the second layout measured put its two balances on two lines 79
 * user units apart under two different labels, which the one-line shape cannot say
 * at all - and the locator's shape decides how its gross cells are found too, which
 * is why `gross` is nested here and not a sibling field on PdfTemplate. Spans against
 * a two-lines box would be x-intervals with no line to read them off: a cross-field
 * inconsistency `tsc` cannot see. Nested, it cannot be written. Neither kind is a way
 * to write "no balances".
 *
 * `scope` is nested here rather than sitting beside `balances` on PdfTemplate for the
 * reason `gross` is: it is resolved at the `label` span this node declares, and a span
 * declared on one node and read from another is a cross-field inconsistency `tsc`
 * cannot see.
 */
type BalanceBox = { scope: BalanceScope } & (
  | {
      /** one line states both, under one label */
      kind: 'one-line';
      /** the literal that line carries in `label` */
      total: string;
      label: Span;
      opening: Span;
      closing: Span;
      /** two more x-intervals on the line the label already found */
      gross: GrossSpans;
    }
  | {
      /** a line each, under a label each, and the value in one column */
      kind: 'two-lines';
      label: Span;
      value: Span;
      /** the literal the opening balance's line carries in `label` */
      opening: string;
      closing: string;
      /** two more labels, read at the `value` span this box already has */
      gross: GrossLabels;
    }
);

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
  dates: DateSource;
  amount: AmountFormat;
  rows: RowExtent;
  balances: BalanceBox;
};

// ---------- dates ----------

type DateFormat = 'ru-abbrev' | 'de-numeric' | 'de-day-month-pair';

/**
 * How this layout writes a date and, when the cell carries no year, where the year
 * is (row 57, R-A(2)).
 *
 * One union node and not a `dateFormat` beside an optional `year`, for the reason
 * TableLayout and AmountCurrency are unions: a year source declared for a vocabulary
 * whose cell already carries one, or omitted for a vocabulary whose cell does not, is
 * then not writable at all rather than caught by a branch.
 */
type DateSource =
  /** the cell carries its own year */
  | { format: 'ru-abbrev' | 'de-numeric' }
  /**
   * it does not, and this is where the year is read from instead: the one line of the
   * balance box's scope whose whole text is the period the statement covers. Groups
   * 1..3 are the first day, month and year; 4..6 the last. No `g` and no `y` flag -
   * this is matched once per line over the whole scope, and a sticky or global regex
   * keeps `lastIndex` and answers true, false, true for the same line (see `wanted`).
   */
  | { format: 'de-day-month-pair'; period: RegExp };

/**
 * How a layout writes a date. A named vocabulary rather than a callback per
 * template: the reader owns the parsing and a template says which rule it is written
 * in, so a second layout widens this list instead of shipping a parser inside a data
 * literal (row 6c, R1).
 *
 * Groups 1..3 of `shape` are the day, the month and the year, in that order, in every
 * vocabulary whose cell carries a year - stated once here rather than per entry,
 * because it is what readDate below reads them as. A `no-year` vocabulary states its
 * own group order in its own entry, which is where a reader of the entry is standing.
 *
 * `shape` is also what decides whether a line is a transaction at all - one regex
 * rather than two, or the anchor and the parser drift and a line that looks like a
 * row is dropped as furniture. A line that matches the shape and not the month
 * table is a SKIPPED row with a reason, never a dropped one: a month abbreviation
 * this table has wrong would otherwise make that month's transactions vanish with
 * nothing said. The same holds one step further out for a date the period cannot
 * place: skipped and noted, never guessed.
 */
type DateVocabulary =
  | { kind: 'named-month'; shape: RegExp; months: Readonly<Record<string, number>> }
  | { kind: 'numeric'; shape: RegExp }
  | { kind: 'no-year'; shape: RegExp };

/**
 * `satisfies` rather than an annotation, so that indexing this with the two formats
 * whose cells carry a year yields those two entries and not the union: it is what
 * makes `readDate` unreachable from a `no-year` template without a branch saying so.
 */
const DATE_FORMATS = {
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
  // "30.06. 30.06." - a booking date and a value date, both without a year, drawn as
  // two items in two columns and joined by cellAt into one cell. Groups 1 and 2 are
  // the BOOKING day and month, which is what every date on that layout's statement is
  // defined on; groups 3 and 4 are the value date and are read by nothing, and they
  // are in the shape rather than left out of it so that a row printing only one of the
  // two is not a transaction at all.
  //
  // Both digits required in all four, for de-numeric's reason. The whole cell is
  // matched, which is what stops a wider date column turning a description into a row.
  'de-day-month-pair': { kind: 'no-year', shape: /^(\d{2})\.(\d{2})\. (\d{2})\.(\d{2})\.$/u },
} satisfies Record<DateFormat, DateVocabulary>;

/**
 * UTC throughout and never `new Date(string)`: the calendar day goes into the dedup
 * key, and a local-time parse shifts it by one for half the world's timezones - so
 * the same statement imported from another machine would duplicate every row
 * (ROADMAP 4.2, and the same reason sheet.ts's cellDate is written in UTC).
 *
 * The round trip is the check that the components are a real date: Date.UTC rolls
 * 31 February over into March rather than refusing it. One function, so the two
 * callers - a cell that carries its year and a period line that carries two - cannot
 * come to disagree about which day-month pairs exist.
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

/** The period a statement covers, off its own period line, and that line's text. */
interface StatementPeriod {
  text: string;
  from: Date;
  to: Date;
}

/**
 * How THIS document's dates are read.
 *
 * Built once per document rather than looked up per row, because a cell that carries
 * no year needs the statement's own period and that is a fact about the document. The
 * period is bound inside `read`, so a row read against another statement's period is
 * unwritable rather than merely unlikely - and the alternative, handing readRows a
 * year to pass down, would make readRows compute the candidate year, which means
 * readRows knowing which groups of `shape` are the day and the month. That rule is the
 * one DATE_FORMATS owns, and duplicated at a call site it drifts silently the day a
 * fifth vocabulary numbers its groups differently, producing dates that are wrong and
 * reconcile (row 57, D6).
 */
interface DateReader {
  /** what decides whether a line is a transaction at all, as DATE_FORMATS' own is */
  shape: RegExp;
  /** the row's date, or why this template could not place it in the calendar */
  read: (m: RegExpExecArray) => { date: Date } | { date: null; note: string };
}

const cannotRead = (m: RegExpExecArray): { date: null; note: string } => ({
  date: null,
  note: `reads ${quote(m[0])}, which this template cannot read as a date`,
});

/**
 * The period the statement covers, off the one line of the scope whose WHOLE text is
 * one - matched against the line's items joined, and not against a cell.
 *
 * Three reasons, and none of them is taste. It asserts the line carries nothing else,
 * which a cell cannot; it needs no span, so the date node borrows no x-interval from
 * the balances node; and a period drawn as several runs - which is what a statement
 * with a space either side of its dash is - reads whole here where a cell narrower
 * than the line would read the first run alone.
 *
 * DISTINCT lines, not lines: a section long enough to span pages may reprint its own
 * frame, and two prints of one period are one period. Two DIFFERENT periods inside one
 * scope refuse, and that is the arm that matters - the year is the one thing on this
 * path that a wrong answer makes silent, since a row given the wrong year reconciles
 * to the cent and lands in the wrong month (row 57, R-B).
 */
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
    // a line in the shape of a period whose ends are not real days is not a period:
    // Date.UTC would roll 31 February into March and every row's year would be read
    // off a range the document never printed
    if (from && to && from <= to) found.set(m[0], { text: m[0], from, to });
  }
  if (found.size !== 1) throw new Error(noStatementPeriod(template.title, found.size));
  return [...found.values()][0];
}

/**
 * The year of a row whose cell carries none: the ONE year in the period's own range
 * for which the day and month are a real date inside the period. Zero or more than
 * one is no date at all - a skipped row with a note - and there is no fallback, no
 * walk back a year and no default to the period's end year.
 *
 * The rule that can answer "I do not know" is strictly better than the rule that
 * always answers, and this is arithmetic rather than a preference: the gate sums
 * amounts and cannot see a date, so a row given the wrong year reconciles to the cent,
 * imports, and lands in the wrong month on the Transactions screen, in the analytics
 * buckets and in the dedup key - a number the user reads being false with every check
 * green. A skipped row makes the sum short and doesNotAddUp refuses out loud.
 *
 * Both ends of the period are INCLUSIVE. A bank books its interest and its fees on the
 * period's last day by construction, so an exclusive comparison would skip every such
 * row and refuse the import of documents that are perfectly correct.
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
  // its own sentence and not the shape failure's, and a second one for the other arm:
  // the template CAN read this cell as a date, and telling a reader that a well-formed
  // "15.03." is unreadable sends them to inspect a column that is fine (feeRefused's
  // reason, in the same product one seam over)
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
  const { getDocument, PasswordException, VerbosityLevel } = await loadPdfjs();
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

/**
 * The ISO code a matched cell is in, or undefined for a symbol this layout does not
 * write. `per-column` cannot answer undefined and does not read the match at all: its
 * code is the template's own literal and there is nothing in the cell to disagree
 * with it - which is why every caller's undefined arm names a symbol.
 */
const currencyOf = (currency: AmountCurrency, m: RegExpExecArray): string | undefined =>
  currency.kind === 'in-the-cell' ? currency.symbols[m[2]] : currency.code;

/** A cell that is there, against the layout's amount format. */
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

/**
 * Whether the layout wants this continuation line, by the label it starts with.
 *
 * `startsWith` over a literal, and if a RegExp is ever wanted here it must not carry
 * the `g` flag. A global regex keeps `lastIndex` between calls, and this runs once
 * per line over the whole document, so `test` would answer true, false, true, false
 * for the same line - and every second line the rule was written to drop would land
 * whole in the description column with nothing refusing it and nothing noting it.
 * The rule holding no state across lines is the property that would be lost, and
 * nothing in the type system notices a flag.
 */
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
  dates: DateReader,
): { rows: Cell[][]; notes: Map<string, string> } {
  const { shape } = dates;
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
      // FOUR rules meet in this one condition and nowhere else, which is why editing
      // a line of it moves three things the editor was not looking at: the
      // continuation rule itself - what a transaction's extent is; the template's own
      // drop or keep list, through `wanted` below; the page test, whose cost is
      // stated two paragraphs down; and TOLERANCE, because "nothing in the date
      // column" is a claim about a line, and which baselines are one line is decided
      // by readLines before any template is known. None of the four is written down
      // anywhere else in this file.
      //
      // The page test is not decoration. Pages 2..n of the N26 statement repeat the
      // title and the period in the description column with both other cells empty,
      // which is a continuation's exact shape, and without it those two lines would
      // be appended to the last transaction of the page before. What it costs is
      // stated rather than hidden - a transaction split across a page break would
      // lose its tail - and no transaction in any document measured is split: 0 of 72
      // in each of the third layout's two files, counted rather than assumed. A
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

    const date = dates.read(m);
    if (date.date === null) note(DATE, date.note);
    const amount = table.amount(line);
    if (amount.note) note(AMOUNT, amount.note);

    const row: Cell[] = [];
    row[DATE] = date.date;
    row[AMOUNT] = amount.value;
    row[DESCRIPTION] = cells.description;
    row[CURRENCY] = amount.currency;
    rows.push(row);
    open = { row, page: line.page };
  }
  return { rows, notes };
}

/** One cell of the box, what it is, and the label of the line it was read off. */
interface Balance {
  value: number;
  currency: string;
  label: string;
  role: BalanceRole;
}

/**
 * The lines the balance box is read out of, and the lines the period is read out of -
 * one set, so the two cannot come to disagree about which section of the document is
 * the statement's own (row 57, R-C).
 *
 * Declared by the template and never by code that knows what one bank's sections are
 * called. A scope that cannot be resolved refuses with a sentence of its own; it is
 * never silently widened back to the whole document, which would put the parser back
 * to reading whichever of two identically-labelled blocks came first.
 */
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
 * What the document says it started and ended with, and what it says each side came
 * to, off the line - or the lines - that state it for the whole statement.
 *
 * Exactly one line per label is required WITHIN THE SCOPE, not the first of several.
 * A layout that repeats a label inside one section is a layout nobody has measured,
 * and taking the first is the guess this parser exists not to make.
 *
 * There is no header assertion fingerprinting this box the way `matches` fingerprints
 * the transaction table, and the reason is measured rather than economic: in the first
 * document this was written against, the closing column's heading wraps onto two
 * baselines either side of the header row, so the assertion could only ever be
 * partial - and a table named in half its columns is a table whose shape is not
 * known. What stands in its place is stronger: the gate makes the locator
 * self-checking, and since row 035 it does so per side as well as end to end. Any
 * misread of the box - a column inserted, two values swapped, the wrong line matched -
 * changes the arithmetic and refuses the import; and a pair of rows the parser never
 * saw that cancel into a clean net now changes it too.
 */
function readBalances(template: PdfTemplate, scoped: TextLine[]): StatementBalances {
  const { balances } = template;

  const only = (label: string): TextLine => {
    const found = scoped.filter((l) => cellAt(l, balances.label) === label);
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

  // The currency check is over every cell of the box and not just the two balances:
  // a gross total in a second currency is the same hazard as a closing balance in
  // one, and an unreachable arm left unbuilt beside an unreachable arm built
  // deliberately is two arms nobody can tell apart later (row 035, D4).
  //
  // Unreachable through either template in this file - both declare a single currency
  // symbol, so every cell is read through the one map and they can only agree - and it
  // is here rather than absent because the alternative is taking one cell's currency
  // for all of them, which is a check against a number that is not the one printed.
  // What makes it reachable at all is readPdf's `templates` parameter, which the test
  // hands a two-symbol template (ROADMAP row 6c: it owes this arm a test, not a
  // document).
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
      // convention rather than normalising until they agree. A plain negation and
      // never Math.abs: a signed cell under a `magnitudes` declaration comes out
      // positive and refuses, where Math.abs would have accepted it (row 035, R6)
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

  // opening, closing, then the two gross cells, so a box broken in more than one
  // place goes on refusing with the sentence it refused with before this row
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
  if (!template) {
    // two statements and not a ternary: a document with no text layer has nothing to
    // read an issuer off and its advice does not change with one, so the scan is
    // unreachable from that arm rather than merely wasted there
    if (chars / pages < MIN_CHARS_PER_PAGE) throw new Error(SCANNED);
    const name = issuerName(pageLines(lines, pages));
    throw new Error(name === null ? NOT_RECOGNISED : notRecognisedFrom(name));
  }

  // The scope and the period come first, and only because the rows depend on them: a
  // layout whose date cells carry no year reads every row's year off the period, and
  // the period is read out of the scope. Moving them back below readRows to restore
  // the old order either resolves the scope twice or hands readRows a year it has to
  // compute itself, which means readRows knowing which groups of the vocabulary's
  // shape are the day and the month - the one rule DATE_FORMATS owns (row 57, D6).
  //
  // What that costs is stated per template rather than in general, because it is not
  // general. For a `section` template - c24-de alone today - unplacedBalanceBox and
  // noStatementPeriod now come BEFORE both of readRows' own refusals: a document that
  // cannot resolve its scope refuses for that even when it also has a table this
  // template cannot read (unreadableTable) or no transaction line at all
  // (noTransactionLines). For the four that declare `whole-document` and a vocabulary
  // carrying its own year, the scope is the whole line list and the period is never
  // looked for, so neither refusal exists and nothing moves.
  const scoped = scopeOf(template, lines);
  const dates = dateReader(template, scoped);
  const { rows, notes } = readRows(template, lines, dates);
  if (rows.length === 0) throw new Error(noTransactionLines(template.title));
  // the box's VALUES are still read last, so noBalanceBox, unreadableBalance and
  // mixedBalanceCurrencies go on coming after the table refusals - it is only the
  // box's SCOPE that moved ahead of them
  const balances = readBalances(template, scoped);

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
    dates: { format: 'ru-abbrev' },
    amount: {
      // "5,96€", "1 742,18€" - the group separator is an ASCII space, and the
      // symbol carries none, so "5,68 EUR" is a cell in the wrong shape rather
      // than a currency this template has not met
      pattern: /^(\d{1,3}(?: \d{3})*,\d{2})([^\s\d]+)$/u,
      decimal: ',',
      currency: { kind: 'in-the-cell', symbols: { '€': 'EUR' } },
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
    //
    // The same line states the two gross totals, which is what the document's own
    // "Списания" and "Пополнения" columns come to: -1742.18 and +1953.40 on the
    // statement measured, each to the cent against the parsed rows' own halves.
    balances: {
      // each of the four labels below occurs exactly once in the whole document,
      // counted over all its pages - which is what this arm declares and only()
      // enforces
      scope: { kind: 'whole-document' },
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
      gross: {
        kind: 'printed',
        // the columns ARE the sign here: the cells read "1 742,18€" and "1 953,40€",
        // unsigned, under headings that say which way the money went
        signs: 'magnitudes',
        // Two independent measurements that happen to equal `columns.debit` and
        // `columns.credit` today, and they must NOT be turned into a reference to
        // them. This box is a row of the five-column balance summary table
        // (42.7 / 253.0 / 335.1 / 417.1 / 526.2); the transaction table has four
        // columns and two of the four spans here correspond to no column of it at
        // all - `opening` sits inside its description span and `closing` past its
        // last column. A redesign that moved one table alone would break a
        // reference while both literals were still individually correct.
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
    dates: { format: 'de-numeric' },
    amount: {
      // "+0,13€", "-1.140,57€" - "." groups thousands, "," is the decimal and the
      // sign is required rather than optional: an unsigned cell is a cell in a shape
      // this layout does not write, and a skipped row with its reason is louder than
      // a positive number that was meant to be a debit
      pattern: /^([+-]\d{1,3}(?:\.\d{3})*,\d{2})([^\s\d]+)$/u,
      decimal: ',',
      currency: { kind: 'in-the-cell', symbols: { '€': 'EUR' } },
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
    // all, and those two lines are this layout's gross totals. Each of the four
    // labels occurs exactly once in the whole document, and each value sits 0.82-0.83
    // ABOVE its label's baseline: 41% of TOLERANCE spent here, on top of the 1.95 the
    // dated rows spend.
    balances: {
      // each of the four labels occurs exactly once in the whole document, measured
      // over all its pages
      scope: { kind: 'whole-document' },
      kind: 'two-lines',
      // the description column, because that is where this layout writes its labels.
      // Unlike revolut-ru's, it cannot be narrowed to a column no transaction
      // reaches: a transaction described exactly "Dein alter Kontostand" makes the
      // count 2 and the import is refused rather than misread
      label: [0, 330],
      value: [460, 596],
      opening: 'Dein alter Kontostand',
      closing: 'Dein neuer Kontostand',
      gross: {
        kind: 'printed',
        // "-2.948,37€" and "+2.774,09€" on the statement measured: the sign is in
        // the cell, which is the same thing this layout's amount column does. The
        // cost taken knowingly: the pattern requires that sign, so a month printing
        // an unsigned "0,00€" incoming total refuses where it imports today, and one
        // printing no such line at all refuses through noBalanceBox.
        signs: 'signed',
        // no new span - the two lines state their values in the `value` column above
        outgoing: 'Ausgehende Transaktionen',
        incoming: 'Einkommende Transaktionen',
      },
    },
  },
  /*
   * The third layout (ROADMAP row 31), and the two entries below are ONE layout in
   * two locales: the same bank prints the same statement in Ukrainian and in English,
   * 4 pages and 72 transactions each, and the two files share no heading, no balance
   * label and no marker. A CSV preset per language would be a dropdown somebody has
   * to find their own locale in (row 20); a PDF template is chosen by the document,
   * so the second entry costs a user nothing and detection is O(templates) over page
   * 1, which §5.2 has already paid for. 16 literals are the same in both and 16
   * differ; nothing here is factored into a shared vocabulary, because a data literal
   * that repeats is not a correctness cost and a vocabulary two templates read
   * through is a way for one to move the other.
   *
   * Both are a text layer and nowhere near MIN_CHARS_PER_PAGE's 50: 1663.0 and 1803.3
   * characters a page by the count readLines actually keeps, which is the trimmed
   * non-blank one and not the raw item text (1817.0 and 1944.5 for the same files).
   * The two differ by a sixth, so a figure quoted for this layout has to say which.
   *
   * What this layout cost the reader, stated because the row exists to measure it:
   * ONE axis, `AmountCurrency` - see its comment. Everything else is data.
   *
   * The geometry is the same in both files and is NOT shareable, and the reason is
   * not stylistic: every column here is CENTRED, so both of its edges move with the
   * content and the left edge a span assigns on is a function of how wide the text
   * happens to be. The two files print the same numbers and different words, so the
   * three columns' centres agree to three decimals (59.527 / 137.479 / 245.195) and
   * their left-edge ranges do not. Each span below is measured off its own document.
   */
  {
    id: 'universalbank-uk',
    title: 'АТ «УНІВЕРСАЛ БАНК»',
    // Both terms are locale-exclusive, which is what stops the two entries claiming
    // one document and `selectTemplate` throwing ambiguousLayout on a correct file:
    // measured, neither of these appears anywhere in the English export, and neither
    // of that one's appears here. Never the IBAN, the card or the holder's name -
    // those are the per-customer fallback 6c's R3 refuses.
    issuer: ['АТ «УНІВЕРСАЛ БАНК»', 'Рух коштів по картці'],
    amounts: 'signed',
    // Ten columns; this template reads three of them. Every boundary sits in a gap
    // that was measured over all 72 transaction lines, and the gap is the headroom:
    //
    //   date [35, 41)   dates 37.018-37.351, heading "Дата i час" 37.765. 35 clears
    //     the client block at 28.346; 41 is the tight one - it separates the heading
    //     from "операції" at 41.041, the second baseline of that same heading, by
    //     3.276, and it is what keeps the TIME out. The time is not in the date cell:
    //     it sits on its own baseline 10.8 below, in this same centred column, and
    //     the only thing telling the two apart is that "dd.mm.yyyy" is 45.0 wide and
    //     "hh:mm:ss" is 35.0, so centring puts them 5.0 apart. That is a coincidence
    //     of two fixed widths, not a column boundary, and a generator that changed
    //     either one would put a time in the date cell.
    //   description [50, 190)   values 91.467-129.735 with the widest ending 183.492;
    //     50 clears the time at 42.022, 190 clears "MCC" at 191.012.
    //   amount [215, 272)   the centred column's own spread is 9.756 (225.188 min
    //     left edge, 234.944 max) and the widest value ends at 265.202. 215 clears
    //     MCC's right edge at 211.266 and 272 clears the next column's 279.046, so a
    //     UAH amount has about 60 points to grow in before it leaves the window - the
    //     widest measured is 40.0. Measured wide at BOTH ends because the column is
    //     centred, which is worse than n26-de's right-aligned one: there a value grows
    //     in one direction only.
    columns: { date: [35, 41], description: [50, 190], amount: [215, 272] },
    marker: { column: 'description', text: 'Деталі операції' },
    tables: [
      // The heading block is six baselines and only ONE of them carries the date and
      // description headings together, so only one can be the header - and on that
      // one the amount column is empty, because its own heading ("Сума в валюті
      // картки (UAH)") wraps across the other four. The `''` is what that baseline
      // really reads and inventing a heading it does not carry would make the
      // fingerprint a fiction. What it costs, said where a template author reads it:
      // `signed()` composes `is empty in the "" column` for a row with no amount, on
      // a collect table, which is a poor sentence - it has never fired, because every
      // one of the 144 transaction lines measured writes an amount.
      //
      // The `i` in "Дата i час" is ASCII U+0069, not Cyrillic U+0456, on both this
      // document and its English twin. It looks like a typo in the generator and it
      // is the generator's; correcting it here would stop the header matching and
      // refuse the whole document.
      {
        header: { date: 'Дата i час', description: 'Деталі операції', amount: '' },
        collect: true,
      },
    ],
    // Named after where the vocabulary was first met and not after this document's
    // locale: the cell is "28.07.2026", zero-padded on all 144 lines across both
    // files, which is the shape de-numeric already carries. A second entry with an
    // identical `shape` under a Ukrainian name would be two literals free to drift,
    // and the drift would be silent because both would go on matching.
    dates: { format: 'de-numeric' },
    amount: {
      // "-742.18", "20 000.00", "3 118.40 UAH" - one run each, the group separator
      // an ASCII space and the decimal a dot. The sign is optional because this
      // layout writes one on debits and nothing at all on credits, which is the
      // opposite of n26-de.
      //
      // The trailing code is a literal " UAH" and NOT " [A-Z]{3}": a balance printed
      // in another currency has to fail this pattern and refuse loudly, where a
      // generic three-letter group would read it as UAH and import somebody's dollar
      // statement as hryvnia. It is optional because the transaction cells carry no
      // code at all - the currency is in the column heading, which is the whole
      // reason AmountCurrency exists, and `per-column` is what supplies it.
      pattern: /^(-?\d{1,3}(?: \d{3})*\.\d{2})(?: UAH)?$/u,
      decimal: '.',
      currency: { kind: 'per-column', code: 'UAH' },
      example: '-1 234.56',
    },
    // One continuation baseline per transaction - the time - and when the description
    // wraps, its tail is drawn on that same baseline with no label of any kind. 7 of
    // the 72 rows here carry one, 35 of the 72 in the English file. So this layout
    // cannot name what it keeps and names what it drops, which is an obligation to
    // enumerate what the layout writes BELOW its transactions rather than a licence.
    //
    // Enumerated, on page 4 of both files: three lines reach the description column
    // and are dropped by the labels below; four write left of it (x=28.346) and have
    // an empty description cell; and one - the ЕЦП verification paragraph - is held
    // out by ACCIDENT and is worth saying so. It wraps far enough right to write into
    // the amount span, so `blank()` refuses it. Nothing about the drop list or the
    // spans holds it, and a generator that reflowed that paragraph would land it in a
    // description with nothing refusing. It is deliberately NOT in the drop list: a
    // label matched against a line nobody has seen is the near-miss shape 6c D17
    // finding 2 rules out.
    //
    // The client block on page 1 has a continuation's exact shape too and is held by
    // something stronger: it is printed ABOVE the table header, so `table` is still
    // null when readRows reaches it. A fixture that puts the box below the
    // transactions is testing a different document.
    //
    // No transaction is split across a page break: 0 of 72 in both files, every page
    // ending on the time baseline of its last row and every page 2..n opening with
    // the repeated heading block. So the page test in readRows costs this layout
    // nothing.
    rows: {
      kind: 'continuations',
      drop: ['Операційний директор', 'Вклади гарантуються', 'Детальна інформація'],
    },
    // Four labels on four baselines 13.5 apart, page 1, each stating its value in one
    // column - so `two-lines`, and `one-line` cannot say it. Each label occurs exactly
    // once in the whole document, counted over all four pages, which is what `only()`
    // requires.
    //
    // Both per-side totals are printed, as unsigned magnitudes under directional
    // labels - the same way round as revolut-ru and the opposite of n26-de. Checked
    // arithmetically rather than read off the words: negating the outgoing magnitude
    // gives the parsed rows' own outgoing half to the cent.
    balances: {
      // counted over all four pages, as the comment above this box says
      scope: { kind: 'whole-document' },
      kind: 'two-lines',
      // The value's x tracks the LABEL's width, not the value's, because the label is
      // laid out first: a 26-character label puts its value at 154.426 and a
      // 22-character one at 133.789. So the boundary sits below the narrowest value's
      // left edge and above every label's, which all start at 28.346. Unlike
      // revolut-ru's this cannot be narrowed to a column no transaction reaches: a
      // transaction line reads its date joined to its description here
      // ("28.07.2026 <merchant>"), which can never equal a label, but a description
      // that WAS one of the four labels would make the count 2 and refuse the import
      // rather than being misread - n26-de's trade, taken for the same reason.
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
    // The same three columns and the same centres, measured off THIS file and not
    // copied from the entry above - the left edges differ because the words do.
    //
    //   date [30, 42)   dates 39.519-39.815, heading "Date and time" at 33.319, which
    //     reaches 4.4 further left than the Ukrainian heading does and is why this
    //     span is not the other one. 30 clears the client block at 28.346; 42 keeps
    //     the time out, which starts at 43.967 here against 42.022 there.
    //   description [50, 190)   values 95.923-130.367, widest ending 179.035; 50
    //     clears the time, 190 clears "MCC" at 192.150.
    //   amount [215, 272)   left edges 227.411-236.083, widest ending 262.979,
    //     between MCC's right edge at 210.154 and the next column's 279.851.
    columns: { date: [30, 42], description: [50, 190], amount: [215, 272] },
    marker: { column: 'description', text: 'Description' },
    tables: [
      // Where the Ukrainian file's header baseline has an empty amount cell, this
      // one carries "currency" - a fragment of "Card currency amount, (UAH)" that
      // happens to wrap onto the header's own baseline. It sits at 228.307, BETWEEN
      // real amount values at 228.303 and 228.599, so no boundary can exclude it
      // without excluding amounts this template has to read. Declaring it is what
      // the cell reads, and it makes this fingerprint the stronger of the two.
      //
      // It depends on something worth naming: three heading baselines 2.514 apart
      // merge into this one line, and readLines seeds a line at the FIRST item's y
      // and never re-centres, so the merge holds because pdfjs emits the middle
      // baseline first. That is stable for a given generator and it is not
      // structural. 2.514 is also the closest this document puts two baselines it
      // keeps apart, against 13.27 for the two layouts TOLERANCE was measured on.
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
    // The same three footer lines as the Ukrainian file, in English, and the same
    // measurement behind them - though in THIS file it is not the list that rejects
    // them TODAY. Page 4 carries the signature and footer block and no transaction of
    // its own, so the row still open is page 3's and the page test rejects all three
    // before `wanted` is ever reached: counted through readRows, page test 3 and drop
    // list 0 here against page test 0 and drop list 3 in the Ukrainian file. Which
    // one fires is data and not layout - a month whose footer shares a page with a
    // transaction is what the list is here for, and the Ukrainian file, where it
    // fires on 3 of 3, is the proof these labels match what is printed.
    //
    // Its verification paragraph is one run at x=28.346 and writes nothing in the
    // amount column, so unlike the Ukrainian one it is held by the description span
    // rather than by `blank()`. Two files, two different accidents, one list.
    rows: {
      kind: 'continuations',
      drop: ['Operating Director', 'Deposits are guaranteed', 'Details in the Reference'],
    },
    // Same four baselines, same spans: the labels are longer here and the values sit
    // further right (170.554-197.500 against 133.789-154.786), so [0, 133) / [133,
    // 596) holds for both files without either boundary being tuned to this one.
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
  /*
   * The fourth layout (ROADMAP row 57): a C24 Smartkonto statement, 3 pages, 1011.7
   * characters a page by the count readLines keeps - the trimmed non-blank one, where
   * the raw item text is 1019.7 - against MIN_CHARS_PER_PAGE's 50.
   *
   * What this layout cost the reader, stated because the row exists to measure it: TWO
   * axes, both authorised in advance. `BalanceScope`, because this document prints the
   * balance box's four labels twice; and the `no-year` date vocabulary with the period
   * it reads its year off, because its transaction cells carry no year. A third
   * widening was authorised and NOT taken - the header line writes four headings where
   * TableLayout's signed arm knows three, and rather than widen that arm the two date
   * cells share one span, so `header.date` reads "Buchung Valuta", which is what cellAt
   * really returns there. Every heading the layout writes is inside a declared span and
   * compared whole.
   *
   * What that costs, and it is a real cost: a row that printed only ONE of its two date
   * cells does not match the shape, is therefore not a transaction, and - its amount
   * cell being non-blank - is not appended to the row above either. It is dropped, the
   * sum comes up short and doesNotAddUp refuses. Loud, but not diagnostic: with
   * `skipped` at 0 that refusal reads "an operation is probably missing" and names no
   * line.
   *
   * WHAT THIS DOCUMENT CANNOT PROVE, which is the other half of what a template comment
   * owes. Two transactions, both bank-generated (a tax line and an interest line), both
   * dated 30.06. in BOTH date columns - so the second date column is present and never
   * differs, and reading `Buchung` is a choice made on what the statement IS (its
   * period, its balances and its own "Kontoauszug 06/2026" title are all defined on
   * booking, and a value date legitimately falls outside the period) rather than on
   * anything this file shows. No purchase, no foreign currency, no fee, no page break -
   * 0 of 2 transactions split across one - no amount above 10,02, no thousands
   * separator anywhere, and a gate exercised on two rows and six cents. And no section
   * in this file spans a page, so nothing here shows whether a section title repeats at
   * the top of each of its pages; first-match on `opens` is the choice that does not
   * need to know.
   */
  {
    id: 'c24-de',
    // the bank's own legal name off its footer, 13 characters. Not "C24 Smartkonto",
    // which is 14 and names a product where a title names a layout (row 30, D-G)
    title: 'C24 Bank GmbH',
    // Both terms are the bank's own and per-DOCUMENT rather than per-customer: the
    // legal name and the VAT identifier out of the footer, which every page carries.
    // Never the holder's name, their address or the IBAN, which is R3's
    // stop-and-report. Deliberately NOT "Kontoauszug 06/2026" or "BIC: DEFFDEFFXXX":
    // the month varies in the first, and both are printed by the synthetic document
    // that pins row 30's by-name refusal for this very bank - so drawing the
    // fingerprint from them would put half of it inside that fixture. The cost, taken
    // knowingly: a C24 statement whose footer legal name or VAT id ever changes is
    // refused BY NAME through the issuer directory's own 'DE 50024024' entry, which is
    // the good failure and one template edit from working.
    issuer: ['C24 Bank GmbH', 'Ust.-ID DE 322 469 451'],
    amounts: 'signed',
    // Three spans over a page 595.276 wide, and every boundary is a measurement of its
    // own rather than a reference to another one:
    //
    //   date [40, 135)   the two date cells write at 48.354 and 99.378 and nowhere
    //     else; 135 sits in the 24.7-point gap between the Valuta column's right edge
    //     (125.745) and the description column's left edge (150.402). 40 is BELOW the
    //     leftmost thing this document draws (45.354) and that is deliberate, not
    //     slack: it puts every line the layout writes in the left margin - the four
    //     summary labels, the section headings, the footer's "06/2026", the whole of
    //     page 3's legal text - inside the date cell, where a non-empty date cell is
    //     what stops readRows taking any of them for a continuation. Raise it to 46 and
    //     the footer's address line becomes one, measured.
    //   description [135, 250)   the column writes at 150.402 and nowhere else, seven
    //     items over the document. 250 sits in the 37.2-point gap between the footer
    //     address's left edge (233.880) and the Ust.-ID line's (271.094), which is what
    //     this boundary is FOR - see `rows` below. Its cost is real: the column's own
    //     widest run ends at 287.854, so a description drawn as a SECOND run beginning
    //     past 250 would be dropped silently, which is the class of loss DEBT.md's item
    //     (b) already carries. Every description line in this document is one run.
    //   amount [460, 596)   right-aligned at 546.921, and 460 is much further left than
    //     the widest amount the document contains (-10,02 €, 33.293 wide, left edge
    //     516.628) because the column is right-aligned and an item is assigned by its
    //     LEFT edge: by this font's own measured advances a four-figure "-1.234,56 €"
    //     begins near 500.9 and a five-figure one near 495.7, so a span drawn for the
    //     amounts this file happens to print would read an empty amount cell for every
    //     four-figure movement, skip the row and refuse an ordinary month. 460 also sits
    //     in the 72.9-point band above the page-1 header's own "Kontostand 84,22 €" run
    //     at 427.132, which must stay OUT of it.
    //
    // The obvious lower bound is the footer's own "Seite N von 3" at 500.003, and it is
    // not available: a four-figure amount begins within a POINT of it - to the right of
    // it, by 0.9 - so no boundary separates the two, and one that cleared the footer
    // would take the five-figure amounts with it. What admitting a span this low costs
    // is therefore one line, the footer at y=16.704, whose amount cell then reads
    // "Seite 1 von 3". That line is already held out of the transaction path by a
    // non-empty date cell ("06/2026" at 45.354), so a non-blank amount cell adds a
    // second guard rather than removing one.
    columns: { date: [40, 135], description: [135, 250], amount: [460, 596] },
    marker: { column: 'description', text: 'Transaktionsinformation' },
    tables: [
      // "Buchung" at 48.354 and "Valuta" at 99.378 are two headings in one span, joined
      // by cellAt exactly as the two date cells under them are - so the fourth column
      // is NAMED, and a redesign that renames or moves it stops this template matching
      // rather than reading rows against columns that have shifted.
      //
      // One entry is enough, and that is measured rather than assumed: exactly one line
      // in the whole document carries "Transaktionsinformation" in the description
      // column, so there is no second marker line for readRows to refuse over and no
      // analogue of n26-de's `collect: false` summary table.
      {
        header: {
          date: 'Buchung Valuta',
          description: 'Transaktionsinformation',
          amount: 'Betrag',
        },
        collect: true,
      },
    ],
    // "30.06. 30.06." - no year in either cell, so the year comes off the period line
    // inside the balance box's scope. Both period lines in this document have the same
    // x and the same shape ("01.06.2026 - 30.06.2026" on page 1, "01.04.2026 -
    // 30.06.2026" on page 2), which is exactly the problem the box has, so the scope
    // serves both and there is no second locator to disagree with the first.
    //
    // What the locator counts is DISTINCT MATCHED TEXTS and not lines, which matters
    // to anyone writing a sixth template here: a section long enough to reprint its
    // own frame states one period however many times it prints it, and that is the
    // whole reason the count is not over lines. But the key is the text and not the
    // range it parses to, so two SPELLINGS of one period - "01.06.2026 - 30.06.2026"
    // against "01.06.2026-30.06.2026" - count as two and refuse a correct document.
    // That direction is chosen and not accidental: a loud false refusal over a silent
    // normalisation of two facts into one, because a wrong year is the only failure on
    // this path that reconciles to the cent and lands in the wrong month.
    dates: {
      format: 'de-day-month-pair',
      period: /^(\d{2})\.(\d{2})\.(\d{4}) - (\d{2})\.(\d{2})\.(\d{4})$/u,
    },
    amount: {
      // "-0,02 €", "+ 0,08 €", "84,16 €". Three things this pattern has to carry:
      //
      // The sign is OPTIONAL and cannot be otherwise. readBalances reads "84,16 €" and
      // "84,22 €" with this same pattern, so n26-de's required sign would refuse the
      // balance box. What that costs, said plainly: a dropped "+" is arithmetically
      // invisible - 0,08 and +0,08 are one number - while a dropped "-" flips a debit
      // into a credit, and the only thing standing between a narrow amount span and
      // wrong money is row 035's per-side check.
      //
      // The space after the sign is real. A credit's sign is a text run of its own at
      // 516.024 with its digits at 521.670, and cellAt joins runs with a space, so the
      // cell arrives as "+ 0,08 €" where the summary line writes "+0,08 €" as one run.
      // parseAmount strips whitespace before it parses, so the pattern is the only
      // place this matters - and it still matches the WHOLE cell, which is what stops
      // "1234,56-" being read as positive.
      //
      // The thousands separator is UNMEASURED: no amount in this document reaches
      // 1.000, and "." is declared from the locale's convention and from n26-de's
      // measurement of the same one. Every wrong form of that guess is loud - a balance
      // cell the pattern cannot read is quoted back through unreadableBalance, and a
      // transaction cell it cannot read is a skipped row that makes the sum short.
      pattern: /^([+-]? ?\d{1,3}(?:\.\d{3})*,\d{2}) ([^\s\d]+)$/u,
      decimal: ',',
      currency: { kind: 'in-the-cell', symbols: { '€': 'EUR' } },
      example: '-1.234,56 €',
    },
    // A transaction is a dated line plus one or two detail lines in the description
    // column, unlabelled free text - a counterparty name, a "Steuerabrechnung
    // Zinsgutschrift", an interest period - so this layout cannot name what it keeps
    // and takes the permissive arm, which obliges an enumeration of what it writes
    // BELOW its transactions on the transaction page. There are exactly four such
    // lines, and each is held by something different:
    //
    //   "Zusammenfassung" and the four summary lines under it   the DATE cell: their
    //     labels are at 45.354, inside date's [40, 135), so the cell is not empty. The
    //     four summary lines also write in the amount column, so blank() refuses them
    //     a second time.
    //   the footer's "C24 Bank GmbH" at 273.765                 the DESCRIPTION span,
    //     and nothing else can hold it - see below.
    //   the footer's "06/2026 | <address> | Seite N von 3"      the DATE cell again,
    //     plus a non-blank amount cell.
    //   the footer's "Ust.-ID DE 322 469 451" at 271.094        the DESCRIPTION span.
    //
    // `drop` is EMPTY, and that is the whole point of the description span's 250.
    // "C24 Bank GmbH" appears twice on page 1: at 150.402 as transaction 1's own first
    // detail line, and at 273.765 as the page footer, on the same page as the last
    // transaction and blank in the amount column - a continuation's exact shape. The
    // two texts are byte-identical and differ only in x, so no rule over the
    // description TEXT can separate them: a drop list naming "C24 Bank GmbH" takes the
    // real detail line with the footer, three appended instead of four, which is a
    // silent truncation of a real description. Only a rule keyed on x can tell them
    // apart, and the span is that rule. Its cost is the one written above 250.
    rows: { kind: 'continuations', drop: [] },
    // The document prints these four labels TWICE - once here for the statement, once
    // on page 2 for a quarterly Rechnungsabschluss covering 01.04 to 30.06 - and three
    // of the four numbers agree: Endsaldo 84,22 in both, Kontogutschriften +0,08 in
    // both, and the page-1 header's own "Kontostand 84,22 €" agrees with both. Only
    // Startsaldo differs, and that is the one number the rows would have to supply. So
    // no arithmetic can choose the block and the scope has to.
    //
    // "Kontoauszug" and not "Transaktionsübersicht", because the period line sits at
    // y=636.301 - ABOVE Transaktionsübersicht at 601.500 - and opening the scope at the
    // section title puts the period line and the balance box inside one line set.
    //
    // A page-based scope was measured against this and is worse rather than merely
    // different: the anchor sits on the page a section STARTS on while Zusammenfassung
    // moves with the transaction list, so a month with forty transactions puts them on
    // different pages and a page rule finds nothing and refuses a correct document.
    balances: {
      scope: { kind: 'section', opens: 'Kontoauszug', closes: ['Rechnungsabschluss'] },
      kind: 'two-lines',
      // Two independent measurements that happen to equal two of `columns` and must
      // NOT be turned into references to them. This box is not a row of the
      // transaction table: its labels are at 45.354 where the date column's cells are
      // at 48.354, and its values right-align at 549.921 where the transaction column
      // right-aligns at 546.921 - three points apart, measured, which is the proof
      // they are two columns. Like n26-de's and unlike revolut-ru's, `label` cannot be
      // narrowed to a column no transaction reaches: a transaction whose date cell read
      // exactly "Startsaldo" would make the count 2 and refuse the import rather than
      // being misread.
      label: [0, 135],
      value: [460, 596],
      opening: 'Startsaldo',
      closing: 'Endsaldo',
      gross: {
        kind: 'printed',
        // "-0,02 €" and "+0,08 €": the sign is in the cell, the same way this layout's
        // transaction column writes it and the opposite of the two universalbank
        // entries. The balance cells beside them are UNSIGNED, which is why the pattern
        // above cannot require one.
        signs: 'signed',
        outgoing: 'Kontobelastungen',
        incoming: 'Kontogutschriften',
      },
    },
  },
];

/**
 * Every sentence in the refusal set, composed at its own extreme out of every
 * template's own literals: the title a refusal names the layout by, the balance
 * labels it quotes back, the currency codes it declares and the example it offers,
 * against the widest cell a quote may hold and the widest count one may carry - and
 * out of the issuer directory's own longest entry, for the one refusal that names a
 * bank rather than a layout.
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
    // the real directory and never a placeholder: 'W'.repeat(n) bounds a constant
    // nobody enforces, where the longest entry that actually ships bounds the data -
    // so a long bank name added later has to move the number below
    notRecognisedFrom(longest(Object.values(ISSUERS))),
    SCANNED,
    tooManyPages(found, found),
    ambiguousLayout(templates.map((t) => t.title)),
  ];
  // the widest label and the widest role word, taken independently: this is a bound
  // and not a specimen, and a real pair would be narrower than either extreme
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
    // the two below only for the templates whose arms can reach them, the way the
    // gross labels above are read only where they exist: a sentence composed for a
    // template that can never produce it would bound this set by a fiction
    if (t.balances.scope.kind === 'section') {
      all.push(unplacedBalanceBox(t.title, t.balances.scope.opens));
    }
    if (t.dates.format === 'de-day-month-pair') all.push(noStatementPeriod(t.title, found));
  }
  return all;
}
