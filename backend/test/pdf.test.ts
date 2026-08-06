/**
 * The PDF parser (ROADMAP 5.2, row 6a), through the same entry point the endpoint
 * uses.
 *
 * Every fixture is built in code (./pdffixture.ts) and laid out to match the one
 * template in the tree. So a green run here proves the reader turns coordinates
 * into rows, the refusals are distinct, and the seam did not grow a second account
 * namespace. **It does not prove the template is right** - the fixture was written
 * from the same measurements the template was. The only evidence for the layout is
 * a manual check against a real statement, and the CSV export of the same weeks
 * importing to the same rows.
 */
import { describe, expect, it } from 'vitest';
import {
  ERROR_DETAIL_MAX,
  ImportSourceType,
  confirmImport,
  getAccount,
  listImports,
  listTransactions,
} from '../src/db';
import {
  NOTE_MAX,
  PDF_PARSER_VERSION,
  PdfTemplate,
  TEMPLATES,
  TextLine,
  readPdf,
  refusals,
  selectTemplate,
} from '../src/providers/pdf';
import { MAX_DATA_ROWS } from '../src/providers/sheet';
import {
  CURRENCY_CODE_MAX,
  NUL_SCAN_BYTES,
  ParsedFile,
  StatedBalances,
  importStatement,
  readSheet,
  reconcile,
  sniff,
} from '../src/providers/statement';
import { NewTransaction } from '../src/types';
import { importAndConfirm } from './helpers';
import {
  CONTAINER_HEADER_BYTES,
  PlacedText,
  buildImagePdf,
  buildPdf,
  buildSignedContainer,
} from './pdffixture';

/**
 * What the sheet mapper stated beside a PDF's rows, which is nothing: a PDF's
 * balances come off the template that read it and the pdf arm never looks at this
 * argument. The one value every reconcile call below passes (row 54).
 */
const NO_BALANCES: StatedBalances = { kind: 'none' };

// the x-intervals the revolut-ru template declares, one literal each so a test that
// places a cell outside its column has to say so. The last five are the balance
// box's, and `total` shares the date column's interval on purpose - that is where
// the real document writes the label.
//
// `grossOut` and `grossIn` are their own literals and not `debit`/`credit`, for the
// reason the template's own comment gives: the balance summary is a five-column
// table of its own and the equality with the transaction table's middle two columns
// is arithmetic rather than structure.
const X = {
  date: 42.7,
  description: 124.8,
  debit: 335.1,
  credit: 417.1,
  total: 42.7,
  opening: 253.0,
  grossOut: 335.1,
  grossIn: 417.1,
  closing: 526.2,
} as const;

const header = (y: number, date = 'Дата'): PlacedText[] => [
  { x: X.date, y, text: date },
  { x: X.description, y, text: 'Описание' },
  { x: X.debit, y, text: 'Списания' },
  { x: X.credit, y, text: 'Пополнения' },
];

/**
 * The statement's own balance summary - the one line the reconciliation gate checks
 * the rows against. Every fixture that gets as far as the gate carries one and every
 * one of them adds up, because a template with no balance locator is not a template
 * (row 6b, R1): making the fixtures optional-friendly is exactly the hole that rules
 * out.
 *
 * Positional, in the order the document prints the line, and every gross pair below
 * is arithmetic done on the fixture's OWN literal amounts - never read off the
 * parser. A box computed from what the reader produced agrees with the reader by
 * construction and tests nothing, which is the defect one level down from the one
 * this row exists to fix (row 035, trap 2).
 *
 * `BOX_SIZE` is a budget and a fixture artefact, the same one FOOTER's comment
 * measures: this fixture's font advances one point per character per point of size
 * where the real document's advances far less, and the four cells sit 82, 82 and 109
 * points apart. At size 4 the widest of them - nine characters - advances 36 points
 * from 253 and stops 46 short of the next cell; at the default 9 it stops 1.1 short,
 * pdfjs joins the two runs into ONE item at the opening column's x, and the opening
 * cell reads "1 200,00€ 1". 8 is the largest size that still comes apart, so this
 * has half the budget spare.
 */
const BOX_SIZE = 4;

const box = (
  y: number,
  opening: string,
  outgoing: string,
  incoming: string,
  closing: string,
): PlacedText[] => [
  { x: X.total, y, text: 'Итого' },
  { x: X.opening, y, text: opening, size: BOX_SIZE },
  { x: X.grossOut, y, text: outgoing, size: BOX_SIZE },
  { x: X.grossIn, y, text: incoming, size: BOX_SIZE },
  { x: X.closing, y, text: closing, size: BOX_SIZE },
];

const row = (
  y: number,
  date: string,
  description: string,
  amount: { debit?: string; credit?: string },
): PlacedText[] => [
  { x: X.date, y, text: date },
  { x: X.description, y, text: description },
  ...(amount.debit ? [{ x: X.debit, y, text: amount.debit }] : []),
  ...(amount.credit ? [{ x: X.credit, y, text: amount.credit }] : []),
];

const ISSUER: PlacedText = {
  x: 39.7,
  y: 27.1,
  text: '© 2026 Revolut Bank UAB, Zweigniederlassung Deutschland',
};

/**
 * The three-row statement most cases below import. `tag` is what makes one case's
 * bytes differ from the next one's: identical bytes answer "already imported"
 * without being parsed at all, which would make a case pass having asserted nothing.
 * It sits below the footer, where it is neither a table header nor a transaction.
 */
const statement = (tag: string, closing = '59,76€'): PlacedText[][] => [
  [
    ISSUER,
    { x: 39.7, y: 15, text: tag },
    ...header(700),
    ...row(680, '2 июл. 2026г.', 'REWE.de', { debit: '5,68€' }),
    ...row(660, '3 июл. 2026г.', 'Платеж от JANE DOE', { credit: '100,00€' }),
    ...row(640, '30 июл. 2026г.', 'Wizz Air', { debit: '1 234,56€' }),
    // the three rows net -1 140,24: 5,68 + 1 234,56 out and 100,00 in
    ...box(620, '1 200,00€', '1 240,24€', '100,00€', closing),
  ],
];

/** Two of them, so a rule that happens to match one literal is not enough. */
const CARDS = ['Карта: 400000******0000', 'Карта: 555500******0001'] as const;

/**
 * One line of the deposit-insurance footer the real document prints at the bottom of
 * every page: the description column, every other cell empty - a continuation's exact
 * shape - on the page of the transaction it would attach to, so the page test cannot
 * see it. It carries no label, which is what keeps it out.
 *
 * It is placed at `size: 3` and that is a budget rather than a preference. pdfjs
 * splits a placed run at every space and this fixture's font advances one point per
 * character per point of size, from x=124.8, so at size 3 a fragment may begin no
 * later than character 68 and still land inside the description column's [120, 330).
 * The last fragment here ("также") begins at character 50, so the line has eighteen
 * characters of headroom; at size 4 it would have one. Spend the headroom and the
 * line writes into the debit column, `blank()` stops calling it a continuation, and
 * the case below passes having exercised nothing - which is the silent direction: a
 * KEPT line that stops being a candidate turns its own case red, a dropped one does
 * not.
 */
const FOOTER = 'Литвы и Европейского центрального банка. Компания также';
const FOOTER_SIZE = 3;

/**
 * The lines the real document writes under a dated line, with what each one is for.
 *
 * `kept` is the case's own claim about what should reach the column, and both the
 * fixture's text and its expected descriptions are composed from these literals: a
 * reader that starts dropping a kept line cannot pass by having its expectation
 * moved with it, because the expectation is the dated line plus exactly the entries
 * marked here.
 *
 * Every kept label carries two distinct values, and so does the one dropped label.
 */
const DETAILED: readonly {
  date: string;
  description: string;
  amount: { debit?: string; credit?: string };
  /** `size` is 4 unless the line needs the headroom FOOTER's own comment measures */
  under: readonly { text: string; kept: boolean; size?: number }[];
}[] = [
  {
    date: '2 июл. 2026г.',
    description: 'REWE.de',
    amount: { debit: '5,68€' },
    // the row this whole thing is about: seven characters on the dated line, and the
    // merchant, its trading name and its town two lines under it
    under: [
      { text: 'Получатель: Rewe Markt Mueller, Hamburg', kept: true },
      { text: CARDS[0], kept: false },
    ],
  },
  {
    // a dropped line BETWEEN two kept ones: it ends nothing, and the row is still
    // open under it
    date: '3 июл. 2026г.',
    description: 'Платеж от JANE DOE',
    amount: { credit: '100,00€' },
    under: [
      { text: 'Реквизиты: Sent from N26', kept: true },
      { text: CARDS[1], kept: false },
      // no account number enters this file: the digits are zeroes
      { text: 'Отправитель: JANE DOE, DE00000000000000000000', kept: true },
    ],
  },
  {
    date: '12 июл. 2026г.',
    description: 'Apple',
    amount: { credit: '9,99€' },
    under: [
      { text: 'Отправитель: Apple.com/bill, Cork', kept: true },
      { text: 'Реквизиты: Отправлено из Revolut', kept: true },
    ],
  },
  {
    date: '30 июл. 2026г.',
    description: 'Wizz Air',
    amount: { debit: '1 234,56€' },
    under: [
      { text: 'Получатель: Wizz Airline, Budapest', kept: true },
      { text: FOOTER, kept: false, size: FOOTER_SIZE },
    ],
  },
];

const kept = (t: (typeof DETAILED)[number]): string =>
  [t.description, ...t.under.filter((u) => u.kept).map((u) => u.text)].join(' ');

/**
 * The same statement with the detail lines under it, as a builder of its own rather
 * than an addition to `statement()`: some twenty cases import that one and every one
 * of their expected descriptions would move.
 *
 * `size` is a fixture artefact and not a fact about the layout, for the reason
 * n26Detail states - this fixture's font advances one point per character where the
 * real document's advances 0.66, so a detail line of the length Revolut really
 * writes would spill its tail past x=330 and into the debit column, where `blank()`
 * would refuse it and the case would pass having exercised nothing.
 */
const detailed = (tag: string): PlacedText[][] => {
  const drawn: PlacedText[] = [ISSUER, { x: 39.7, y: 15, text: tag }, ...header(700)];
  let y = 680;
  for (const t of DETAILED) {
    drawn.push(...row(y, t.date, t.description, t.amount));
    for (const line of t.under) {
      y -= 12;
      drawn.push({ x: X.description, y, text: line.text, size: line.size ?? 4 });
    }
    y -= 20;
  }
  // -5,68 + 100,00 - 1 234,56 + 9,99: the four rows net -1 130,25, which is what
  // takes the 1 200,00€ opening to the 69,75€ the gate reads below, and their two
  // halves are 1 240,24 out and 109,99 in
  drawn.push(...box(y, '1 200,00€', '1 240,24€', '109,99€', '69,75€'));
  return [drawn];
};

const importPdf = (
  accountName: string,
  pages: PlacedText[][],
  preset?: string,
  currency = 'EUR',
) => importStatement({ accountName, currency, bytes: buildPdf(pages), preset });

/** The import row a refused upload left, and the message it recorded. */
async function lastFailure(before: string[]): Promise<{
  status: string;
  errorDetail: string | null;
  documentAvailable: boolean;
  sourceType: ImportSourceType;
}> {
  const fresh = (await listImports()).filter((i) => !before.includes(i.id));
  expect(fresh).toHaveLength(1);
  return fresh[0];
}

const idsNow = async (): Promise<string[]> => (await listImports()).map((i) => i.id);

describe('pdf: bytes to rows', () => {
  it('reads the rows of a statement in the layout it knows', async () => {
    const staged = await importPdf('Revolut Pdf', statement('happy path'));
    expect(staged.outcome).toBe('awaiting_confirmation');
    if (staged.outcome !== 'awaiting_confirmation') return;

    expect(staged.summary).toMatchObject({
      total: 3,
      accepted: 3,
      skipped: 0,
      problems: [],
      from: '2026-07-02',
      to: '2026-07-30',
      totals: [{ currency: 'EUR', net: -1140.24 }],
      // what the statement itself says it started and ended with, and the rows run
      // exactly between the two - 1200,00 - 1140,24 = 59,76
      balances: { opening: 1200, closing: 59.76, currency: 'EUR' },
    });
    const imports = await listImports();
    const record = imports.find((i) => i.id === staged.summary.importId)!;
    expect(record.sourceType).toBe('pdf');
    expect(record.parserVersion).toBe(PDF_PARSER_VERSION);
  });

  it('the amount column decides the sign, and the € decides the currency', async () => {
    const r = await importAndConfirm({
      accountName: 'Revolut Signs',
      // deliberately not EUR: a row's own currency must come from the document
      currency: 'USD',
      bytes: buildPdf(statement('signs')),
    });
    const rows = (await listTransactions({ accountId: r.accountId, limit: 50 })).map((t) => [
      t.date.slice(0, 10),
      t.amount,
      t.currency,
      t.description,
    ]);
    expect(rows.sort()).toEqual([
      ['2026-07-02', -5.68, 'EUR', 'REWE.de'],
      ['2026-07-03', 100, 'EUR', 'Платеж от JANE DOE'],
      ['2026-07-30', -1234.56, 'EUR', 'Wizz Air'],
    ]);
  });

  /**
   * Trap 6, directly. getTextContent hands items back in the order the generator
   * drew them, and this fixture draws every row's amount before its date and its
   * description last. Assembled by array position the amounts would move one row.
   */
  it('rows are grouped by coordinate, not by the order the items were drawn', async () => {
    const drawn: PlacedText[] = [ISSUER, ...header(700)];
    for (const [y, date, description, debit] of [
      [680, '2 июл. 2026г.', 'REWE.de', '5,68€'],
      [660, '3 июл. 2026г.', 'Lidl', '9,99€'],
      [640, '4 июл. 2026г.', 'Aldi', '1,23€'],
    ] as const) {
      drawn.push({ x: X.debit, y, text: debit });
      drawn.push({ x: X.date, y, text: date });
      drawn.push({ x: X.description, y, text: description });
    }
    // -16,90 over the three, all of it out and nothing in
    drawn.push(...box(620, '100,00€', '16,90€', '0,00€', '83,10€'));

    const r = await importAndConfirm({
      accountName: 'Revolut Drawing Order',
      currency: 'EUR',
      bytes: buildPdf([drawn]),
    });
    const rows = (await listTransactions({ accountId: r.accountId, limit: 50 })).map((t) => [
      t.date.slice(0, 10),
      t.amount,
      t.description,
    ]);
    expect(rows.sort()).toEqual([
      ['2026-07-02', -5.68, 'REWE.de'],
      ['2026-07-03', -9.99, 'Lidl'],
      ['2026-07-04', -1.23, 'Aldi'],
    ]);
  });

  /**
   * The one thing this layout gets wrong silently if the tables are not told apart:
   * "В статусе ожидания" rows are authorised and not settled, and the CSV path
   * drops them through State != COMPLETED. A PDF import that took them would
   * disagree with the CSV of the same weeks - which is the only check this row has.
   */
  it('rows under the pending table are not imported', async () => {
    const staged = await importPdf('Revolut Pending', [
      [
        ISSUER,
        ...header(700, 'Дата начала'),
        ...row(680, '31 июл. 2026г.', 'Rewe', { debit: '5,96€' }),
        ...header(600),
        ...row(580, '2 июл. 2026г.', 'REWE.de', { debit: '5,68€' }),
        // and the gate now says the same thing arithmetically: 100,00 - 5,68 is
        // 94,32, where taking the pending line too would compute 88,36 and refuse.
        // Flipping `collect: false` on that table fails this case twice over - the
        // net misses by 5,96 and so does the outgoing half
        ...box(540, '100,00€', '5,68€', '0,00€', '94,32€'),
      ],
    ]);
    if (staged.outcome !== 'awaiting_confirmation') throw new Error('not staged');
    // 1, not 2, and not 2-with-one-skipped: a pending line was never a candidate
    expect(staged.summary).toMatchObject({ total: 1, accepted: 1, skipped: 0 });
    expect(staged.summary.totals).toEqual([{ currency: 'EUR', net: -5.68 }]);
  });

  /**
   * A table header the template does not name refuses the document instead of being
   * passed over. Skipping it is the failure this project cares about most - rows
   * nothing could read, inside an import reported as complete - and a section whose
   * columns are not where the template thinks cannot be read correctly anyway.
   */
  it('a table this layout does not name refuses the document', async () => {
    const before = await idsNow();
    await expect(
      importPdf('Revolut New Table', [
        [
          ISSUER,
          ...header(700),
          ...row(680, '2 июл. 2026г.', 'REWE.de', { debit: '5,68€' }),
          ...header(600, 'Дата начисления'),
          ...row(580, '3 июл. 2026г.', 'Проценты', { credit: '0,05€' }),
        ],
      ]),
    ).rejects.toThrow(
      /this Revolut statement has a table this importer cannot read \("Дата начисления"\)/,
    );

    const failed = await lastFailure(before);
    expect(failed.status).toBe('failed');
    expect(failed.documentAvailable).toBe(true);
  });

  /**
   * Trap 6's other half: a line with the wrong number of fields is a SKIPPED row
   * carrying a reason, never one built from whichever column happened to be filled.
   * The neighbours' amounts are asserted for exactly that - a shifted row is what
   * this refuses to produce.
   */
  it('a line with no amount, or with two, is skipped with its own reason', async () => {
    const staged = await importPdf('Revolut Short Rows', [
      [
        ISSUER,
        ...header(700),
        ...row(680, '2 июл. 2026г.', 'REWE.de', { debit: '5,68€' }),
        ...row(660, '3 июл. 2026г.', 'Neither', {}),
        ...row(640, '4 июл. 2026г.', 'Both', { debit: '1,00€', credit: '2,00€' }),
        ...row(620, '5 июл. 2026г.', 'Unreadable', { debit: '5,68 EUR' }),
        ...row(600, '32 июл. 2026г.', 'Impossible date', { debit: '3,00€' }),
        ...row(580, '6 июл. 2026г.', 'Aldi', { credit: '9,99€' }),
        // the two that parsed net +4,31, and the statement agrees - a skipped row
        // does not have to be a discrepancy. This is also the shape whose confirm
        // card carries "the rows add up" above "4 rows couldn't be read": both are
        // true, since the gate checks what was read and a skipped row carrying
        // money would have broken the sum
        ...box(540, '100,00€', '5,68€', '9,99€', '104,31€'),
      ],
    ]);
    if (staged.outcome !== 'awaiting_confirmation') throw new Error('not staged');

    expect(staged.summary).toMatchObject({ total: 6, accepted: 2, skipped: 4 });
    expect(staged.summary.problems).toEqual([
      'row 2: the amount cell is empty in both the "Списания" and "Пополнения" columns',
      'row 3: the amount cell holds "1,00€" and "2,00€" - a line carries a debit or a credit, not both',
      'row 4: the amount cell reads "5,68 EUR", where this template reads an amount like "1 234,56€"',
      'row 5: the date cell reads "32 июл. 2026г.", which this template cannot read as a date',
    ]);
    // the two that did parse are unshifted: 5,68 stayed on REWE.de and 9,99 on Aldi
    expect(staged.summary.totals).toEqual([{ currency: 'EUR', net: 4.31 }]);
  });

  /**
   * Ruling 3: the client always sends `preset` and the chip persists across files,
   * so a PDF uploaded with "sparkasse" selected has to produce exactly what the same
   * file produces with "generic". A preset names header text and a PDF has no header
   * for it to name - a refusal that is nobody's fault and cannot be acted on.
   *
   * `revolut` is in the list on purpose and `sparkasse` is not enough on its own:
   * the four column slots are all filled by the override, so a preset that only
   * names columns is inert here whether it is dropped or not. What is NOT
   * overridable is onlyWhen - resolvePreset resolves it whenever the request did
   * not supply one - so the preset a Revolut PDF's uploader would most plausibly
   * have selected is exactly the one that breaks.
   *
   * Seen red: passing `preset` through instead of null in readSheet's pdf arm
   * refuses the revolut upload with `no column matched for status (tried "State")
   * - pick a different preset or set a mapping; the header reads: pdf:date, ...`,
   * where generic imports three rows.
   */
  it('the preset chip does not decide what a PDF imports', async () => {
    // one PDF several times is the point, so every upload carries the same bytes
    // and each supersedes the last's staged copy - the upload's own rule about a
    // re-upload, which says nothing about presets
    const strip = (s: Record<string, unknown>) => {
      const { importId, accountId, accountName, supersededImportId, ...rest } = s;
      return rest;
    };
    const summaries = [];
    for (const preset of ['generic', 'sparkasse', 'revolut']) {
      const staged = await importPdf(`Revolut Preset ${preset}`, statement('preset'), preset);
      if (staged.outcome !== 'awaiting_confirmation') throw new Error(`${preset} refused`);
      summaries.push(strip(staged.summary));
    }
    expect(summaries[1]).toEqual(summaries[0]);
    expect(summaries[2]).toEqual(summaries[0]);
  });

  /**
   * The other half of Ruling 3, and the half the test above cannot hold: it asserts the
   * three summaries are equal to EACH OTHER, never what any of them says. A summary
   * built from resolveColumns' own answer keeps all three equal - readSheet's pdf arm
   * forces preset: null and hands the mapper a synthetic pdf:date/pdf:amount header, so
   * every chip produces the same request-mapping descriptor - and prints this
   * importer's invented column names at the user as if they were the document's.
   *
   * The chip is set to the one a Revolut PDF's uploader would plausibly have left on,
   * so this also refuses a descriptor built from `preset`: that names the chip's title,
   * "Revolut (Statement CSV)", where the layout is called "Revolut".
   */
  it('the summary names the PDF layout that read it, and no column at all', async () => {
    const staged = await importPdf('Revolut Pdf Read As', statement('read as'), 'revolut');
    if (staged.outcome !== 'awaiting_confirmation') throw new Error('the PDF was refused');
    expect(staged.summary.readAs).toEqual({ kind: 'pdf-template', title: 'Revolut' });
  });

  /** presetMapping still throws on a name no preset has: that is a client bug. */
  it('an unknown preset is still loud on the PDF path', async () => {
    await expect(importPdf('Revolut Bad Preset', statement('bad preset'), 'not-a-bank')).rejects.toThrow(
      /unknown preset: not-a-bank/,
    );
  });

  /**
   * ROADMAP row 34, and it is what that row is: the document prints "Получатель:
   * Rewe Markt Mueller, Hamburg" two lines under a dated line whose description cell
   * is "REWE.de", and seven characters is what reached the column the categoriser,
   * the transfer detector, the export and every search this product grows all read.
   *
   * The truncation was invisible from anywhere downstream, which is why it needs a
   * case rather than a screen: the reconciliation gate sums amounts, so a statement
   * with every description cut to its first line reconciles to the cent and imports.
   *
   * Seen red against `rows: { kind: 'one-line' }` - every stored description is the
   * dated line alone and every expectation below loses its tail.
   */
  it('a transaction is its dated line and the labelled lines under it', async () => {
    const r = await importAndConfirm({
      accountName: 'Revolut Descriptions',
      currency: 'EUR',
      bytes: buildPdf(detailed('descriptions')),
    });
    const rows = (await listTransactions({ accountId: r.accountId, limit: 50 })).map(
      (t) => t.description,
    );
    expect(rows).toHaveLength(DETAILED.length);
    // found by the dated line's own text and asserted whole: a continuation is
    // appended and never substituted, so that text stays the prefix. Category rules
    // match by substring, and every one a user wrote against the short description
    // has to keep matching a longer one
    for (const t of DETAILED) {
      expect(rows.find((d) => d.startsWith(t.description))).toBe(kept(t));
    }
  });

  /**
   * I3. "Карта: …" is a masked card number - one distinct value on all 49 of its
   * occurrences in the document measured, so it cannot tell two transactions apart -
   * and the CSV export of the same month carries no card number at all, so keeping
   * it would make the PDF path store an identifier this product has never held. The
   * footer carries no label, and a layout that names what it keeps excludes it
   * without anyone reading what it says.
   *
   * Not vacuous: the same fixture's kept lines are placed at the same x and the same
   * size, and the case above asserts they arrive. So a line missing here is missing
   * because the template did not want it, not because it was never a continuation.
   *
   * Seen red with 'Карта:' added to the template's keep list.
   */
  it('the lines the template does not keep do not reach a description', async () => {
    const r = await importAndConfirm({
      accountName: 'Revolut Cards',
      currency: 'EUR',
      bytes: buildPdf(detailed('cards')),
    });
    const rows = (await listTransactions({ accountId: r.accountId, limit: 50 })).map(
      (t) => t.description,
    );
    expect(new Set(CARDS).size).toBe(CARDS.length);
    for (const line of [...CARDS, FOOTER]) {
      for (const description of rows) expect(description).not.toContain(line);
    }
  });
});

/**
 * ROADMAP 5.3's middle row: a statement whose rows do not run from its own opening
 * balance to its own closing balance is refused and told what the discrepancy is.
 *
 * There is no tolerance constant anywhere in this row's diff, and that is the point
 * of the first case: one cent of slack hides a systematically dropped fee on a small
 * statement and lets a template that has drifted import plausible numbers, which
 * ROADMAP 5.2 calls the one outcome worse than a refusal.
 *
 * Row 035 added the second check and the compensating-pair case below is what it
 * exists for. The gate cannot be made structural - a type can force the call and the
 * provenance of a value, not what a branch does (row 6b, D12) - so that case is what
 * holds it, and it has been watched fail.
 */
describe('pdf: the reconciliation gate', () => {
  it('a statement one cent out is refused, with the difference named', async () => {
    const before = await idsNow();
    await expect(importPdf('Revolut One Cent', statement('one cent', '59,77€'))).rejects.toThrow(
      'this Revolut statement does not add up: its opening balance of 1200.00 EUR plus the ' +
        "3 transaction lines read comes to 59.76 EUR, where the statement's own closing " +
        'balance is 59.77 EUR - a difference of 0.01 EUR, so an operation is probably missing ' +
        '- export the same statement as CSV or Excel (.xlsx) from your online banking and upload that',
    );

    const failed = await lastFailure(before);
    expect(failed.status).toBe('failed');
    // the bytes are what a template fix needs, and they stay re-uploadable because
    // only a committed import claims the hash
    expect(failed.documentAvailable).toBe(true);
    expect(failed.errorDetail!.length).toBeLessThanOrEqual(ERROR_DETAIL_MAX);
  });

  /**
   * Row 035's deliverable, and the shape no gate in this product could see before
   * it: a payment out and a payment in of the same size that the parser never read.
   * The net is right to the cent, both ends agree, and the statement is missing two
   * transactions.
   *
   * The printed pair is the fixture's own arithmetic and not the reader's - the
   * three lines carry 1 240,24 out and 100,00 in, and the box states 100,00 more of
   * each, which is exactly the pair that cancels.
   */
  it('a statement whose two halves are short by the same amount is refused', async () => {
    const before = await idsNow();
    await expect(
      importPdf('Revolut Compensating Pair', [
        [
          ISSUER,
          ...header(700),
          ...row(680, '2 июл. 2026г.', 'REWE.de', { debit: '5,68€' }),
          ...row(660, '3 июл. 2026г.', 'Платеж от JANE DOE', { credit: '100,00€' }),
          ...row(640, '30 июл. 2026г.', 'Wizz Air', { debit: '1 234,56€' }),
          // 200,00 - 1 340,24 is the same -1 140,24 the three lines net, so the
          // opening balance still reaches the closing one exactly
          ...box(620, '1 200,00€', '1 340,24€', '200,00€', '59,76€'),
        ],
      ]),
    ).rejects.toThrow(
      "this Revolut statement's opening and closing balance agree, but its two halves do not:" +
        ' it states -1340.24 EUR out and 200.00 EUR in, where the 3 transaction lines read come' +
        ' to -1240.24 EUR out and 100.00 EUR in, so an operation out and an operation in of the' +
        ' same size are probably both missing - export the same statement as CSV or Excel' +
        ' (.xlsx) from your online banking and upload that',
    );

    const failed = await lastFailure(before);
    expect(failed.status).toBe('failed');
    expect(failed.documentAvailable).toBe(true);
    expect(failed.errorDetail!.length).toBeLessThanOrEqual(ERROR_DETAIL_MAX);
  });

  /**
   * R5: rows the parser could not read ARE the likely cause of a short sum, so the
   * sentence has to say so rather than report a mystery. A refusal that names a
   * cause which is not the cause is ROADMAP rows 20 and 23, and this is the row
   * whose whole subject is a check.
   */
  it('names the rows it could not read when they are the likely cause', async () => {
    await expect(
      importPdf('Revolut Short Balance', [
        [
          ISSUER,
          ...header(700),
          ...row(680, '2 июл. 2026г.', 'REWE.de', { debit: '5,68€' }),
          ...row(660, '3 июл. 2026г.', 'Neither', {}),
          ...row(640, '4 июл. 2026г.', 'Both', { debit: '1,00€', credit: '2,00€' }),
          ...row(620, '5 июл. 2026г.', 'Unreadable', { debit: '5,68 EUR' }),
          ...row(600, '32 июл. 2026г.', 'Impossible date', { debit: '3,00€' }),
          // the halves agree with the one line that parsed; it is the ends that do
          // not, which is what puts the R5 sentence and not the row-035 one here
          ...box(560, '100,00€', '5,68€', '0,00€', '90,00€'),
        ],
      ]),
    ).rejects.toThrow(
      'its opening balance of 100.00 EUR plus the 1 transaction line read comes to 94.32 EUR, ' +
        "where the statement's own closing balance is 90.00 EUR - a difference of 4.32 EUR, " +
        'and the 4 transaction lines this importer could not read are probably where it went',
    );
  });

  /**
   * R3. Confirm inserts a subset - an overlapping statement's rows are already in
   * the database and are skipped there - so a gate re-run at confirm would refuse
   * every legitimate overlapping import, which is the common case ROADMAP 4.3's
   * second layer exists for.
   */
  it('does not run again at confirm, where fewer rows are inserted than staged', async () => {
    const name = 'Revolut Overlapping Months';
    const first = await importAndConfirm({
      accountName: name,
      currency: 'EUR',
      bytes: buildPdf(statement('overlap first')),
    });
    expect(first.inserted).toBe(3);

    // the same three lines and one more, with the statement's own balances moved to
    // match: 1 200,00 - 1 140,24 - 12,99 = 46,77, and 1 253,23 out against 100,00 in
    const staged = await importPdf(name, [
      [
        ISSUER,
        { x: 39.7, y: 15, text: 'overlap second' },
        ...header(700),
        ...row(680, '2 июл. 2026г.', 'REWE.de', { debit: '5,68€' }),
        ...row(660, '3 июл. 2026г.', 'Платеж от JANE DOE', { credit: '100,00€' }),
        ...row(640, '30 июл. 2026г.', 'Wizz Air', { debit: '1 234,56€' }),
        ...row(620, '31 июл. 2026г.', 'Netflix', { debit: '12,99€' }),
        ...box(600, '1 200,00€', '1 253,23€', '100,00€', '46,77€'),
      ],
    ]);
    if (staged.outcome !== 'awaiting_confirmation') throw new Error('not staged');
    expect(staged.summary).toMatchObject({ accepted: 4, newRows: 1, alreadyPresent: 3 });

    const confirmed = await confirmImport(staged.summary.importId);
    expect(confirmed?.confirmed).toBe(true);
    expect(confirmed?.inserted).toBe(1);
  });

  /**
   * Trap 4, at the smallest scale it happens at: 0.1 + 0.2 is 0.30000000000000004,
   * so a gate written in decimals refuses this statement. The real document is the
   * same fact at scale - its 70 amounts sum to 123.45000000000002.
   */
  it('a statement whose amounts are not exact in binary floating point reconciles', async () => {
    const staged = await importPdf('Revolut Exact Cents', [
      [
        ISSUER,
        ...header(700),
        ...row(680, '2 июл. 2026г.', 'Cashback', { credit: '0,10€' }),
        ...row(660, '3 июл. 2026г.', 'Interest', { credit: '0,20€' }),
        ...box(640, '0,00€', '0,00€', '0,30€', '0,30€'),
      ],
    ]);
    if (staged.outcome !== 'awaiting_confirmation') throw new Error('not staged');
    expect(staged.summary.balances).toEqual({ opening: 0, closing: 0.3, currency: 'EUR' });
  });

  /**
   * The locator's own refusals, which are the parser's and live in pdf.ts. Zero and
   * two are one sentence on purpose (D6): a layout that repeats the label is a
   * layout nobody has measured, and taking the first of several is the guess this
   * parser exists not to make.
   */
  const boxCases: [string, PlacedText[], RegExp][] = [
    [
      'no balance summary at all',
      [],
      /this Revolut statement has a balance summary this importer could not read: it expects exactly one "Итого" line and found 0/,
    ],
    [
      'two of them',
      [
        ...box(640, '1 200,00€', '5,68€', '0,00€', '59,76€'),
        ...box(600, '1 200,00€', '5,68€', '0,00€', '59,76€'),
      ],
      /it expects exactly one "Итого" line and found 2/,
    ],
    [
      // the group separator gone is the smallest drift a redesign can produce, and
      // it must not be read as 1 200,00 by a laxer pattern
      'an opening balance this template cannot read',
      box(640, '1200,00€', '5,68€', '0,00€', '59,76€'),
      /this Revolut statement's opening balance cell reads "1200,00€" on its "Итого" line, where this template reads an amount like "1 234,56€"/,
    ],
    [
      'a closing balance that is not there',
      box(640, '1 200,00€', '5,68€', '0,00€', ''),
      /this Revolut statement's closing balance cell reads "" on its "Итого" line, where this template reads an amount like "1 234,56€"/,
    ],
    [
      // and the two cells this row added, which refuse the same way and after the
      // two balances - a box broken in more than one place goes on refusing with
      // the sentence it refused with before
      'an outgoing total that is not there',
      box(640, '1 200,00€', '', '0,00€', '94,32€'),
      /this Revolut statement's outgoing total cell reads "" on its "Итого" line, where this template reads an amount like "1 234,56€"/,
    ],
    [
      // and the ordering itself, which every case above leaves free: each breaks
      // exactly one cell, so a reader taking the gross pair first would pass all of
      // them. Two broken at once, and the sentence naming the balance has to win -
      // a refusal blaming a subtotal where the balance is what drifted sends the
      // reader to the wrong column
      'a closing balance and an outgoing total both gone',
      box(640, '1 200,00€', '', '0,00€', ''),
      /this Revolut statement's closing balance cell reads "" on its "Итого" line, where this template reads an amount like "1 234,56€"/,
    ],
  ];

  for (const [what, balances, message] of boxCases) {
    it(`${what} refuses the statement and leaves the document behind`, async () => {
      const before = await idsNow();
      await expect(
        importPdf(`Revolut Box ${what}`, [
          [
            ISSUER,
            ...header(700),
            ...row(680, '2 июл. 2026г.', 'REWE.de', { debit: '5,68€' }),
            ...balances,
          ],
        ]),
      ).rejects.toThrow(message);

      const failed = await lastFailure(before);
      expect(failed.status).toBe('failed');
      expect(failed.documentAvailable).toBe(true);
      expect(failed.errorDetail!.length).toBeLessThanOrEqual(ERROR_DETAIL_MAX);
    });
  }

  /**
   * Trap 5, and it is unreachable through any fixture in this repository: the one
   * template declares a single currency symbol, and a cell carrying another is a
   * skipped row rather than a second currency. So the arm is called directly, the
   * way readSheet's `never` default is - it exists for 6c, and a comparison against
   * whichever entry came first is what it refuses to become.
   */
  describe('a statement whose rows are not all in the balance currency', () => {
    const tx = (currency: string, amount: number): NewTransaction => ({
      accountId: 'csv:mixed',
      provider: 'upload',
      amount,
      currency,
      date: '2026-07-02T00:00:00.000Z',
      description: 'x',
      category: 'other',
      fee: null,
    });

    const parsed = (currency: string): ParsedFile => ({
      kind: 'pdf',
      sheet: { rows: [], rowLabel: (i) => i },
      preset: null,
      mapping: {},
      template: 'revolut-ru',
      title: 'Revolut',
      balances: {
        openingCents: 0,
        closingCents: 3000,
        gross: { kind: 'printed', outgoingCents: 0, incomingCents: 3000 },
        currency,
      },
    });

    // NO_BALANCES throughout: the sheet mapper states nothing for a PDF, so the arm
    // below reads its balances off the template and never off this argument (row 54)
    it('refuses rather than checking against whichever currency came first', () => {
      expect(() =>
        reconcile(parsed('EUR'), [tx('EUR', 10), tx('PLN', 20)], 0, NO_BALANCES),
      ).toThrow(
        'this Revolut statement states its balances in EUR, but the lines read are in EUR, PLN' +
          ' - this importer cannot check a statement that mixes currencies',
      );
    });

    it("refuses one currency that is not the balances' either", () => {
      expect(() => reconcile(parsed('EUR'), [tx('PLN', 30)], 0, NO_BALANCES)).toThrow(
        'states its balances in EUR, but the lines read are in PLN',
      );
    });

    it('names three and counts the rest', () => {
      const many = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'].map((c) => tx(c, 1));
      expect(() => reconcile(parsed('EUR'), many, 0, NO_BALANCES)).toThrow(
        'the lines read are in AAA, BBB, CCC and 2 more',
      );
    });
  });
});

// ---------- the second layout (ROADMAP row 6c) ----------

/**
 * The x-intervals the n26-de template declares, one literal each so a case that
 * places a cell outside its column has to say so.
 *
 * The amount column carries two, because the real document right-aligns it: its
 * widest amount starts 16 points to the LEFT of its narrowest, and both have to land
 * inside one span that assigns by the left edge. A span narrow enough for the short
 * ones would drop the long ones, and the cases below place both.
 */
const N = {
  heading: 44.5,
  description: 43.8,
  dateHeading: 341.7,
  date: 390.9,
  amountHeading: 515.1,
  /** where "-1.140,57€" starts in the document measured */
  amountWide: 499.5,
  /** and where "-4,90€" does */
  amountNarrow: 515.8,
} as const;

const n26Header = (y: number): PlacedText[] => [
  { x: N.heading, y, text: 'Beschreibung' },
  { x: N.dateHeading, y, text: 'Verbuchungsdatum' },
  { x: N.amountHeading, y, text: 'Betrag' },
];

/**
 * One transaction's dated line. The date and the amount sit 1.95 BELOW the
 * description's baseline, as they do on every row of the document measured - so
 * TOLERANCE has 2% of its 2 left over here, and narrowing it splits every row below
 * into a description with no amount and an amount with no description (row 6c, D5).
 */
const n26Row = (
  y: number,
  date: string,
  description: string,
  amount: string,
  x: number = N.amountNarrow,
): PlacedText[] => [
  { x: N.description, y, text: description },
  { x: N.date, y: y - 1.95, text: date },
  ...(amount ? [{ x, y: y - 1.95, text: amount }] : []),
];

/**
 * A line under a transaction: the description column, both other cells empty.
 *
 * `size` is here for one reason and it is a fixture artefact, not a fact about the
 * layout. pdfjs splits a placed run at every space and advances each fragment by the
 * FONT's own metrics, and this fixture's font is not the bank's - it reports one
 * point size per character where the real document's reports 0.66. So a line of the
 * length N26 really writes would spill its last word past x=330 and into the date
 * column at size 9, which no real statement's does. The same trick, for the same
 * reason, is what the 'diagnostic budget' case above uses.
 */
const n26Detail = (y: number, text: string, size?: number): PlacedText[] => [
  { x: N.description, y, text, size },
];

/** One line of the summary page's box: its label, and its value in the amount column. */
const n26Balance = (y: number, label: string, value: string): PlacedText[] => [
  { x: N.description, y, text: label },
  { x: 491.2, y, text: value },
];

/**
 * The page footer, which is what keeps the address block out of the descriptions:
 * every one of its lines writes something in the amount column, so none of them is
 * blank there and none of them is a continuation of the transaction above.
 *
 * The BIC is the bank's own and is a third of the fingerprint. No account number
 * appears anywhere in this file - the IBANs below are zeroes.
 */
const n26Footer = (): PlacedText[] => [
  { x: 42.75, y: 69.26, text: 'KONTOINHABER' },
  { x: 505.24, y: 69.26, text: 'Erstellt am' },
  { x: 42.75, y: 37.54, text: 'BIC: NTSBDEB1XXX' },
  { x: 497.48, y: 37.54, text: 'Nr. 07/2026' },
];

/**
 * Three transactions over two pages, then the summary page. `tag` is what makes one
 * case's bytes differ from the next's, and it sits on the summary page rather than
 * under the transactions: on a page with a transaction still open, a trailing line
 * in the description column with nothing beside it IS a continuation, by the rule.
 */
const n26Statement = (tag: string, closing = '+1.270,43€'): PlacedText[][] => [
  [
    { x: N.description, y: 784.05, text: 'Kontoauszug Nr. 07/2026' },
    { x: N.description, y: 750.49, text: '01.07.2026 bis 31.07.2026' },
    ...n26Header(698.4),
    ...n26Row(671.7, '01.07.2026', 'Kaffeeroesterei', '+0,13€'),
    ...n26Detail(658.42, 'Gutschriften'),
    ...n26Detail(642.45, 'IBAN: DE00000000000000000000 • BIC: XXXXDEXXXXX', 4),
    ...n26Detail(626.47, 'Wertstellung 01.07.2026'),
    ...n26Row(600.38, '01.07.2026', 'Ein sehr langer Name der', '-1.140,57€', N.amountWide),
    ...n26Detail(586.58, 'umbricht'),
    ...n26Detail(573.3, 'Lastschriften'),
    ...n26Detail(557.33, 'IBAN: DE00000000000000000001 • BIC: YYYYDEYYYYY', 4),
    ...n26Detail(541.35, 'KND 5530 LEV 07/2026'),
    ...n26Detail(525.38, 'Wertstellung 01.07.2026'),
    ...n26Footer(),
  ],
  [
    // the title and the period again at the top of page 2, in the description column
    // with both other cells empty - which is exactly the shape a continuation has,
    // and the reason the rule is confined to the page its dated line was read on
    { x: N.description, y: 790.05, text: 'Kontoauszug Nr. 07/2026' },
    { x: N.description, y: 756.49, text: '01.07.2026 bis 31.07.2026' },
    ...n26Header(704.4),
    ...n26Row(677.7, '02.07.2026', 'Netto GmbH', '-4,90€'),
    ...n26Detail(664.42, 'Belastungen'),
    ...n26Detail(616.5, 'Wertstellung 02.07.2026'),
    ...n26Footer(),
  ],
  [
    { x: N.description, y: 790.05, text: 'Zusammenfassung Nr. 07/2026' },
    // the summary page repeats "Beschreibung" alone: a table header line the
    // template has to name, or the whole document is refused
    { x: N.heading, y: 704.4, text: 'Beschreibung' },
    ...n26Balance(676.31, 'Dein alter Kontostand', '+2.415,77€'),
    ...n26Balance(650.14, 'Ausgehende Transaktionen', '-1.145,47€'),
    ...n26Balance(623.96, 'Einkommende Transaktionen', '+0,13€'),
    ...n26Balance(597.22, 'Dein neuer Kontostand', closing),
    ...n26Footer(),
    { x: N.description, y: 15, text: tag },
  ],
];

/**
 * A template pair for the selection rules, deliberately not either of the two in the
 * tree: what R2 and the mixed-currency arm need is two templates that claim one
 * document, and neither can be produced by a real statement.
 */
const twin = (id: string, title: string): PdfTemplate => ({
  id,
  title,
  issuer: ['Two Layouts Bank'],
  amounts: 'signed',
  columns: { description: [0, 330], date: [330, 460], amount: [460, 596] },
  marker: { column: 'description', text: 'Beschreibung' },
  tables: [
    { header: { description: 'Beschreibung', date: 'Datum', amount: 'Betrag' }, collect: true },
  ],
  dateFormat: 'de-numeric',
  amount: {
    pattern: /^([+-]\d+,\d{2})([^\s\d]+)$/u,
    decimal: ',',
    currency: { kind: 'in-the-cell', symbols: { '€': 'EUR' } },
    example: '-1,00€',
  },
  rows: { kind: 'one-line' },
  balances: {
    kind: 'two-lines',
    label: [0, 330],
    value: [460, 596],
    opening: 'Anfang',
    closing: 'Ende',
    gross: { kind: 'printed', signs: 'signed', outgoing: 'Raus', incoming: 'Rein' },
  },
});

/**
 * One transaction and a four-cell box, in the layout `twin` declares. The four values
 * are the parameters because they are what every case below varies - the rest of the
 * page is what makes the template claim the document at all.
 */
const twinDoc = (opening: string, closing: string, outgoing: string, incoming: string): Buffer =>
  buildPdf([
    [
      { x: 40, y: 760, text: 'Two Layouts Bank' },
      { x: 40, y: 700, text: 'Beschreibung' },
      { x: 340, y: 700, text: 'Datum' },
      { x: 500, y: 700, text: 'Betrag' },
      { x: 40, y: 680, text: 'Kauf' },
      { x: 340, y: 680, text: '01.07.2026' },
      { x: 500, y: 680, text: '-1,00€' },
      { x: 40, y: 640, text: 'Anfang' },
      { x: 500, y: 640, text: opening },
      { x: 40, y: 620, text: 'Ende' },
      { x: 500, y: 620, text: closing },
      { x: 40, y: 600, text: 'Raus' },
      { x: 500, y: 600, text: outgoing },
      { x: 40, y: 580, text: 'Rein' },
      { x: 500, y: 580, text: incoming },
    ],
  ]);

const twinLines: TextLine[] = [
  { page: 1, y: 760, items: [{ x: 40, text: 'Two Layouts Bank' }] },
  {
    page: 1,
    y: 700,
    items: [
      { x: 40, text: 'Beschreibung' },
      { x: 340, text: 'Datum' },
      { x: 500, text: 'Betrag' },
    ],
  },
];

describe('pdf: the second layout', () => {
  it('reads a statement whose amounts are one signed column', async () => {
    const staged = await importPdf('N26 Happy', n26Statement('happy path'));
    expect(staged.outcome).toBe('awaiting_confirmation');
    if (staged.outcome !== 'awaiting_confirmation') return;

    expect(staged.summary).toMatchObject({
      total: 3,
      accepted: 3,
      skipped: 0,
      problems: [],
      from: '2026-07-01',
      to: '2026-07-02',
      // the sign came out of the cell and not out of which column it was in
      totals: [{ currency: 'EUR', net: -1145.34 }],
      balances: { opening: 2415.77, closing: 1270.43, currency: 'EUR' },
    });
  });

  /**
   * I8, and it is the one invariant of this row with nothing structural behind it:
   * the gate sums amounts, so a statement with every description cut to its first
   * line reconciles to the cent and imports with nothing on the screen saying so.
   *
   * Seen red against a reader that drops them - n26-de set to `rows: one-line` gives
   * "Kaffeeroesterei", "Ein sehr langer Name der" and "Netto GmbH", the three names
   * ten of the nineteen rows in the real document share.
   */
  it('a transaction is its dated line and the lines under it', async () => {
    const r = await importAndConfirm({
      accountName: 'N26 Descriptions',
      currency: 'EUR',
      bytes: buildPdf(n26Statement('descriptions')),
    });
    const rows = (await listTransactions({ accountId: r.accountId, limit: 50 })).map(
      (t) => t.description,
    );
    expect(rows.sort()).toEqual([
      'Ein sehr langer Name der umbricht Lastschriften KND 5530 LEV 07/2026 Wertstellung 01.07.2026',
      'Kaffeeroesterei Gutschriften Wertstellung 01.07.2026',
      'Netto GmbH Belastungen Wertstellung 02.07.2026',
    ]);
    // the template's one dropped line: other people's identifiers do not belong in a
    // column the categoriser, the transfer detector and the export all read
    for (const description of rows) expect(description).not.toMatch(/IBAN|BIC/);
    // and the page-2 title, which has a continuation's exact shape and is on the
    // wrong page for it
    for (const description of rows) expect(description).not.toMatch(/Kontoauszug|bis 31/);
  });

  /**
   * I4, and the ruling ROADMAP row 34 was assigned (row 6c, D17 finding 2). The rule
   * this template shipped with was anchored on the VALUE's character class -
   * /^IBAN: [A-Z0-9]+ • BIC: [A-Z0-9]+$/u - so a grouped IBAN, one with no BIC half
   * and a truncated one all missed it and landed whole in the column, with nothing
   * refusing and nothing noting it. The template names the label now and the value is
   * not in the rule at all, so every variant below is one string built from that one
   * literal rather than a hand-typed near miss of a pattern.
   *
   * `LABEL` is read off the template and not copied, so the misses cannot drift from
   * the rule they are aimed at. That is why the SHAPE is asserted separately: a
   * miss composed as `${LABEL} …` starts with `LABEL` whatever `LABEL` is, so
   * narrowing the template's entry to 'IBAN: DE00' would narrow every miss with it
   * and the case would pass while a real "IBAN: FR76… • BIC: AGRIFRPP" landed whole
   * in the column. A test held to a value cannot notice the value moving; the
   * label-and-nothing-else assertion is what bounds it, and it is over every entry
   * rather than the first, because a second one added later is what nobody re-reads
   * this case for.
   *
   * The control is what stops the case passing vacuously: it is placed the same way
   * and it IS appended, so a variant that is absent is absent because the template
   * dropped it and not because the line was never a continuation.
   */
  it('a near miss of the identifier the template names is dropped too', async () => {
    const n26 = TEMPLATES.find((t) => t.id === 'n26-de')!;
    const drop = n26.rows.kind === 'continuations' ? n26.rows.drop : [];
    expect(drop.length).toBeGreaterThan(0);
    // a label and nothing of the value: 'IBAN: DE00' fails on the space, 'IBAN' on
    // the missing colon
    for (const label of drop) expect(label).toMatch(/^\S+:$/u);
    const LABEL = drop[0];

    const misses = [
      `${LABEL} DE00 0000 0000 0000 0000 00 • BIC: XXXXDEXXXXX`,
      `${LABEL} DE00000000000000000002`,
      `${LABEL} DE00`,
    ];
    const control = 'Verwendungszweck 5530';

    const pages = n26Statement('near miss');
    let y = 505;
    for (const text of [...misses, control]) {
      pages[0].push(...n26Detail(y, text, 4));
      y -= 14;
    }
    const r = await importAndConfirm({
      accountName: 'N26 Near Miss',
      currency: 'EUR',
      bytes: buildPdf(pages),
    });
    const rows = (await listTransactions({ accountId: r.accountId, limit: 50 })).map(
      (t) => t.description,
    );
    expect(rows.some((d) => d.endsWith(control))).toBe(true);
    for (const description of rows) {
      for (const miss of misses) expect(description).not.toContain(miss);
    }
  });

  /**
   * Trap 5's instance for this layout. The summary page's four total lines are kept
   * out by one empty heading telling its table from the transactions' - and flipping
   * `collect` on it fails this case twice over: the line below becomes a fourth
   * transaction, and the statement then misses its own closing balance by a cent.
   *
   * The document measured has no dated line on its summary page. This one does,
   * because a flag nothing can observe is a flag nothing holds.
   */
  it('a dated line under the summary table is not a transaction', async () => {
    const pages = n26Statement('summary collect');
    pages[2].push(...n26Row(560, '31.07.2026', 'Zinsabschluss', '-0,01€'));
    const staged = await importPdf('N26 Summary Table', pages);
    if (staged.outcome !== 'awaiting_confirmation') throw new Error('not staged');
    expect(staged.summary).toMatchObject({ total: 3, accepted: 3, skipped: 0 });
  });

  /**
   * Trap 3: a layout with one amount column must not compose a refusal naming two
   * columns it has not got, which is ROADMAP rows 20(a) and 23 a third time. The
   * heading is read off the table the row was found under, and a signed layout has
   * only ever got one to name.
   */
  it('an empty amount cell names the one column this layout has', async () => {
    const pages = n26Statement('empty betrag');
    pages[0].push(...n26Row(480, '03.07.2026', 'Ohne Betrag', ''));
    const staged = await importPdf('N26 Empty Amount', pages);
    if (staged.outcome !== 'awaiting_confirmation') throw new Error('not staged');

    expect(staged.summary).toMatchObject({ total: 4, accepted: 3, skipped: 1 });
    expect(staged.summary.problems).toEqual([
      'row 3: the amount cell is empty in the "Betrag" column',
    ]);
    // the skipped row carried no money, so the statement still adds up
    expect(staged.summary.totals).toEqual([{ currency: 'EUR', net: -1145.34 }]);
  });

  it('a balance line this layout cannot find refuses the statement', async () => {
    const before = await idsNow();
    const pages = n26Statement('no closing');
    pages[2] = pages[2].filter(
      (t) => t.text !== 'Dein neuer Kontostand' && t.text !== '+1.270,43€',
    );
    await expect(importPdf('N26 No Closing', pages)).rejects.toThrow(
      /it expects exactly one "Dein neuer Kontostand" line and found 0/,
    );

    const failed = await lastFailure(before);
    expect(failed.status).toBe('failed');
    expect(failed.documentAvailable).toBe(true);
    expect(failed.errorDetail!.length).toBeLessThanOrEqual(ERROR_DETAIL_MAX);
  });

  /**
   * What a label span the transactions can reach costs, which revolut-ru's cannot
   * be: N26 writes its balance labels in the description column, so a transaction
   * described exactly "Dein alter Kontostand" makes the count 2. A refusal, not a
   * balance read off the wrong line - which is the trade the template names.
   */
  it('a transaction described like a balance label refuses rather than being read as one', async () => {
    const pages = n26Statement('label collision');
    pages[0].push(...n26Row(480, '03.07.2026', 'Dein alter Kontostand', '-1,00€'));
    await expect(importPdf('N26 Label Collision', pages)).rejects.toThrow(
      /it expects exactly one "Dein alter Kontostand" line and found 2/,
    );
  });

  it('a balance cell this template cannot read is refused with the cell quoted back', async () => {
    // the sign gone is the smallest drift this layout can produce, and the template
    // requires one because the document writes one in every cell
    const pages = n26Statement('unsigned balance').map((page) =>
      page.map((t) => (t.text === '+2.415,77€' ? { ...t, text: '2.415,77€' } : t)),
    );
    await expect(importPdf('N26 Unsigned Balance', pages)).rejects.toThrow(
      /this N26 statement's opening balance cell reads "2\.415,77€" on its "Dein alter Kontostand" line, where this template reads an amount like "-1\.234,56€"/,
    );
  });

  /**
   * R2. With one template `TEMPLATES.find` was exact; with two it resolves ambiguity
   * by literal order in a data array nobody reads as ordering, and the day a
   * fingerprint is loosened for a near miss the first entry wins and a statement is
   * read against another layout's columns - parsed, accepted, plausible and wrong.
   *
   * Seen red with the throw reverted to `return claimed[0]`: the first expectation
   * fails with "promise resolved instead of rejecting".
   */
  it('two templates claiming one document is a refusal, not the first in the array', () => {
    expect(() => selectTemplate([twin('a', 'Layout A'), twin('b', 'Layout B')], twinLines)).toThrow(
      'this statement matches more than one of the layouts this importer knows ("Layout A" and "Layout B")',
    );
    // and the fixture really is claimed by each of them on its own, so the case
    // above is not passing on a document neither one matches
    expect(selectTemplate([twin('a', 'Layout A')], twinLines)?.id).toBe('a');
    expect(selectTemplate([twin('b', 'Layout B')], twinLines)?.id).toBe('b');
  });

  /**
   * D6, and the half of this row's ROADMAP cell that owes a test rather than a
   * document: both templates in the tree declare a single currency symbol, so their
   * two balance cells are read through one map and can only agree. `templates` is
   * what makes the arm reachable at all.
   */
  it('a statement whose two balances are in different currencies is refused', async () => {
    const twoSymbols: PdfTemplate = {
      ...twin('two-symbols', 'Two Symbols'),
      amount: {
        pattern: /^([+-]\d+,\d{2})([^\s\d]+)$/u,
        decimal: ',',
        currency: { kind: 'in-the-cell', symbols: { '€': 'EUR', '£': 'GBP' } },
        example: '-1,00€',
      },
    };
    await expect(readPdf(twinDoc('+10,00€', '+9,00£', '-1,00€', '+0,00€'), 200, [twoSymbols])).rejects.toThrow(
      'this Two Symbols statement\'s opening balance ("Anfang") is stated in' +
        ' EUR and its closing balance ("Ende") in GBP - this importer cannot check a statement' +
        ' that mixes currencies',
    );

    // and the check is over every cell of the box, not the two balances alone
    // (row 035, D4): a gross total in a second currency is the same hazard, and
    // the sentence names it by what it is rather than calling it a balance
    await expect(readPdf(twinDoc('+10,00€', '+9,00€', '-1,00£', '+0,00€'), 200, [twoSymbols])).rejects.toThrow(
      'this Two Symbols statement\'s opening balance ("Anfang") is stated in' +
        ' EUR and its outgoing total ("Raus") in GBP',
    );
  });

  /**
   * The `two-lines` half of what the one-line box has had pinned since row 035, and
   * the arm the third layout brought into use: readBalances reads opening, closing,
   * then the gross pair, in that fixed order, so a box broken in more than one place
   * goes on refusing with the sentence it refused with before. A refusal blaming a
   * subtotal where the balance is what drifted sends the reader to the wrong column.
   *
   * Every other case on this arm breaks exactly one cell, so a reader taking the
   * gross pair first would pass all of them. Nothing structural holds the order -
   * it is statement order inside a switch - so this was SEEN RED rather than merely
   * written: with the two `read` calls in readBalances' two-lines arm reordered to
   * take the gross pair before the closing balance, it fails with "this Two Layouts
   * statement's outgoing total cell reads "" on its "Raus" line".
   */
  it('a two-lines box broken in two places refuses by the balance, not the subtotal', async () => {
    await expect(
      readPdf(twinDoc('+1,00€', '', '', '+0,00€'), 200, [twin('order', 'Two Layouts')]),
    ).rejects.toThrow(
      'this Two Layouts statement\'s closing balance cell reads "" on its "Ende" line',
    );
  });
});

// ---------- the third layout (ROADMAP row 31) ----------

/**
 * The coordinates the two universalbank templates are measured at, one literal each
 * so a case that places a cell outside its column has to say so.
 *
 * Split into what the two locales share and what they cannot, and the split is the
 * layout's own: every column here is CENTRED, so both edges of a cell move with the
 * text and the left edge a span assigns on is a function of how wide the words
 * happen to be. The two files print the same numbers and different words, so the
 * three read columns have identical centres and different left edges - which is why
 * `date`, `time` and `tail` are per locale and the amount column's three are not.
 *
 * `ukWrap` is the second baseline of the Ukrainian date heading, and it is the
 * reason that span stops at 41 rather than at the time's 42.022.
 */
const U = {
  bank: 220.466,
  /** the balance box's labels, and every left-hand line of the client block */
  margin: 28.346,
  description: 99.598,
  descriptionHeading: 103.239,
  mcc: 191.25,
  /** the three amount left edges measured, widest value to narrowest */
  amountWide: 225.188,
  amount: 229.94,
  amountNarrow: 234.944,
  opAmount: 286.3,
  running: 523.071,
} as const;

const UK = {
  date: 37.018,
  dateHeading: 37.765,
  /** "операції", the date heading's own second baseline: outside the date span */
  wrap: 41.041,
  time: 42.022,
  /** where a wrapped description's tail is drawn, on the time baseline */
  tail: 104.751,
  mccHeading: 191.012,
  /** how far below its dated line this locale draws the time */
  pitch: 10.8,
  opening: 154.426,
  closing: 147.703,
  grossOut: 133.789,
  grossIn: 154.786,
} as const;

const EN = {
  date: 39.519,
  dateHeading: 33.319,
  time: 43.967,
  tail: 113.255,
  descriptionHeading: 115.495,
  mccHeading: 192.15,
  /** the fragment of "Card currency amount, (UAH)" that lands on the header's own
   * baseline, between amount values at 228.303 and 228.599 - no boundary excludes it */
  amountHeading: 228.307,
  pitch: 9.6,
  opening: 197.5,
  closing: 170.554,
  grossOut: 183.046,
  grossIn: 176.539,
} as const;

/**
 * What the DATE heading may spend, and it is the tightest budget in this file.
 *
 * The real document draws "Дата i час" as ONE text item at x=37.765, inside a column
 * that has to stop at 41 to keep "операції" - that same heading's second baseline -
 * out at 41.041. This fixture's font advances one point per character per point of
 * size and pdfjs splits a placed run at every space, so at the default 9 the string
 * comes back as three items at 37.765, 82.765 and 100.765: the date cell reads
 * "Дата", the header line matches no table, and the whole document is refused. At
 * 0.5 it still reads "Дата i". At 0.4 the three land at 37.765, 39.765 and 40.565,
 * cellAt joins them, and the cell reads what the document reads with 0.435 spare.
 * "Date and time" needs 0.964 and takes the same constant.
 *
 * No other heading needs it: "Деталі операції" from 103.239 puts its second fragment
 * at 166.239, well inside the description column's [50, 190).
 */
const UA_HEADING_SIZE = 0.4;

/**
 * And what every other cell of this layout may spend, which is the budget BOX_SIZE's
 * comment measures for the other layout. It buys two different things, because this
 * fixture's font is roughly ten times wider than the generator's and that goes wrong
 * in two directions.
 *
 * A cell that carries a SPACE is split by pdfjs at every space, and each fragment is
 * assigned to a column by its own left edge - so a label has to END inside its
 * column, not merely start there. From the margin at x=28.346 the longest of the
 * eight balance labels, "Balance at the beginning of the period:", puts its last
 * fragment at 190.346 at the default 9, so the label cell reads "Balance at the" and
 * "beginning of the period:" lands in the VALUE column; at 4 it is 140.346, still
 * past `label: [0, 133)` - which is the size the Ukrainian labels fit at and the
 * English ones do not; at 3, 124.346; at 2, 92.346, which is forty points and twenty
 * characters of headroom. The deposit-guarantee footer line is the other tight one
 * and clears the description column's 190 at 2 alone.
 *
 * A cell with a WIDE NEIGHBOUR fails the other way, and the MCC cell is the one that
 * does: "4789" at the default 9 runs from 191.250 to 227.250, which is 16 points
 * into the amount column, and pdfjs joins it to the amount beside it into a single
 * item at the MCC's own x. The amount cell then reads empty, the row is skipped, and
 * the statement fails the gate by exactly that row - measured, not imagined. In the
 * real document that cell ends at 211.266 with 14 points to spare.
 *
 * Two cells need none of this, and saying which is what stops the next reader
 * dropping the size everywhere and losing the reason: an amount fragments to two
 * runs that both stay inside [215, 272) at the default size, and so does a box value
 * inside [133, 596) - even at the narrowest label's x of 133.789, where the first
 * fragment has 0.789 of the column to spare.
 */
const UA_SIZE = 2;

/**
 * The Ukrainian file's heading block: six baselines, of which exactly one carries
 * the date and description headings together and is therefore the only one that can
 * be the table header. On that baseline the amount column is EMPTY, because its own
 * heading wraps across the four others - which is what the template declares as `''`
 * and what this fixture has to reproduce, or the declaration is untested.
 */
const ukHeading = (y: number): PlacedText[] => [
  { x: UK.dateHeading, y, text: 'Дата i час', size: UA_HEADING_SIZE },
  { x: U.descriptionHeading, y, text: 'Деталі операції' },
  { x: UK.mccHeading, y, text: 'MCC' },
  { x: 229.724, y: y + 5.669, text: 'Сума в', size: UA_SIZE },
  { x: 229.949, y: y - 5.131, text: 'валюті' },
  // 0.041 outside the date column, which is the whole of what keeps this baseline
  // from being read as a date cell
  { x: UK.wrap, y: y - UK.pitch, text: 'операції' },
  { x: 230.543, y: y - 15.931, text: 'картки' },
  { x: 232.451, y: y - 26.731, text: '(UAH)' },
];

/**
 * The English file's, which is eight baselines and one genuinely marginal thing: the
 * header line is THREE baselines 2.514 apart merged into one, and 2.514 is past
 * TOLERANCE. They are one line only because readLines seeds a line at the first
 * item's y and never re-centres it, so the middle baseline has to be emitted first -
 * which is what the real generator does. The header items are placed first here for
 * exactly that reason, and reordering them below the other two splits this header
 * into three lines that match no table.
 *
 * That merge is what gives this locale's header its fourth cell: "currency", a
 * fragment of the amount column's own heading, which is the template's `amount`
 * heading and the reason its fingerprint is the stronger of the two.
 */
const enHeading = (y: number): PlacedText[] => [
  { x: EN.dateHeading, y, text: 'Date and time', size: UA_HEADING_SIZE },
  { x: EN.descriptionHeading, y, text: 'Description' },
  { x: EN.mccHeading, y, text: 'MCC' },
  { x: 523.245, y, text: 'Balance' },
  { x: 278.763, y: y + 1.417, text: 'Operation' },
  { x: EN.amountHeading, y: y - 1.097, text: 'currency' },
  { x: 236.087, y: y + 8.503, text: 'Card' },
  { x: 229.655, y: y - 10.697, text: 'amount,' },
  { x: 233.867, y: y - 20.297, text: '(UAH)' },
];

/**
 * One transaction: ten cells on one baseline, and the TIME on a baseline of its own
 * below it, in the same centred column as the date. The two are told apart by 5.0
 * points of left edge and nothing else - a coincidence of "dd.mm.yyyy" being 45.0
 * wide and "hh:mm:ss" 35.0 - so a case that moves either one is moving the thing the
 * date column's right boundary rests on.
 *
 * `tail` is a wrapped description's continuation, drawn on that same time baseline
 * with no label of any kind. It is the reason this layout takes `continuations`.
 */
const uaRow = (
  L: typeof UK | typeof EN,
  y: number,
  date: string,
  time: string,
  description: string,
  amount: string,
  x = U.amount,
  tail?: string,
): PlacedText[] => [
  { x: L.date, y, text: date },
  { x: U.description, y, text: description, size: UA_SIZE },
  { x: U.mcc, y, text: '4789', size: UA_SIZE },
  { x, y, text: amount },
  { x: U.opAmount, y, text: '-1.00' },
  { x: U.running, y, text: '0.00' },
  { x: L.time, y: y - L.pitch, text: time },
  ...(tail ? [{ x: L.tail, y: y - L.pitch, text: tail, size: UA_SIZE }] : []),
];

/** One line of the balance box: its label at the margin, its value in one column. */
const uaBalance = (y: number, label: string, x: number, value: string): PlacedText[] => [
  { x: U.margin, y, text: label, size: UA_SIZE },
  { x, y, text: value, size: UA_SIZE },
];

/**
 * What the layout writes BELOW its transactions, which is the whole of what taking
 * `continuations` obliges a template author to enumerate - and the three mechanisms
 * that keep it out of a description are three different things, only one of which
 * the template declares.
 *
 * Dropped by label: the signature line and the two deposit-guarantee lines. All
 * three write in the description column with the date and amount cells empty, which
 * is a continuation's exact shape, on the page of the transaction above them.
 *
 * Held by the description span: four more lines the real document writes as one text
 * item each at the left margin, with nothing in the description column at all. This
 * fixture's font cannot draw a sentence as one item - it splits at every space and
 * the tail would land in a column - so what is placed is the one thing the rule
 * turns on, a run whose left edge is outside every column this template reads.
 *
 * Held by NOTHING the template declares: the ЕЦП verification paragraph, in the
 * Ukrainian file only. It wraps far enough right to write into the amount column, so
 * `blank()` refuses it - and a generator that reflowed that paragraph would land it
 * in a description with nothing refusing. Placed at the left edges the real line
 * writes at, so a case notices if that stops being true. It is deliberately NOT in
 * the drop list: a label matched against a line nobody has seen is 6c D17 finding
 * 2's near miss.
 */
const ukFooter = (): PlacedText[] => [
  { x: 65.941, y: 516.867, text: 'Операційний директор', size: UA_SIZE },
  { x: U.margin, y: 421.887, text: 'Документ', size: UA_SIZE },
  { x: 47.795, y: 412.287, text: 'перевірки', size: UA_SIZE },
  { x: 88.94, y: 412.287, text: 'підпису', size: UA_SIZE },
  { x: 219.472, y: 412.287, text: 'можете', size: UA_SIZE },
  { x: 106.433, y: 26.501, text: 'Вклади гарантуються відповідно до Закону', size: UA_SIZE },
  { x: 103.661, y: 16.901, text: 'Детальна інформація - у Довідці', size: UA_SIZE },
];

/**
 * The same three labelled lines in English. This locale's verification paragraph is
 * one run at the margin rather than a wrapped one, so it is held by the description
 * span where the Ukrainian file's is held by `blank()`: two files, two different
 * accidents, one drop list.
 */
const enFooter = (): PlacedText[] => [
  { x: 76.642, y: 703.767, text: 'Operating Director', size: UA_SIZE },
  { x: U.margin, y: 608.787, text: 'The', size: UA_SIZE },
  { x: 94.997, y: 26.501, text: 'Deposits are guaranteed subject to the Law', size: UA_SIZE },
  { x: 128.409, y: 16.901, text: 'Details in the Reference to guarantee', size: UA_SIZE },
];

/**
 * Two pages, laid out as the real document lays them out: the balance box is printed
 * ABOVE the table header, so readRows reaches those four lines while `table` is
 * still null and can never take one for a continuation. A fixture that put the box
 * under the transactions would be testing a different document.
 *
 * The three amounts are invented and so are the three descriptions; the coordinates
 * are not. -500.25 + 1 200.00 - 75.50 nets +624.25, which takes the 1 000.00 opening
 * to the 1 624.25 closing below, and the two halves are 575.75 out and 1 200.00 in -
 * arithmetic done on these literals and never read back off the parser.
 */
const ukStatement = (tag: string, closing = '1 624.25 UAH'): PlacedText[][] => [
  [
    { x: U.bank, y: 815.269, text: 'АТ «УНІВЕРСАЛ БАНК»' },
    { x: U.margin, y: 752.778, text: 'Рух коштів по картці від 01.08.2026р.' },
    ...uaBalance(507.422, 'Баланс на початок періоду:', UK.opening, '1 000.00 UAH'),
    ...uaBalance(493.922, 'Баланс на кінець періоду:', UK.closing, closing),
    ...uaBalance(466.249, 'Сума витрат за період:', UK.grossOut, '575.75 UAH'),
    ...uaBalance(452.749, 'Сума зарахувань за період:', UK.grossIn, '1 200.00 UAH'),
    ...ukHeading(412.112),
    ...uaRow(UK, 368.631, '28.07.2026', '02:16:38', 'Кавʼярня', '-500.25', U.amount, 'на Хрещатику'),
    ...uaRow(UK, 341.081, '27.07.2026', '15:50:41', 'Зарахування', '1 200.00', U.amountWide),
    // what makes one case's bytes differ from the next's, in the running-balance
    // column because that is the one place a tag of ANY length is safe: at the left
    // margin its second word fragments into the description column and is appended
    // to the last transaction on the page - measured, with "happy path" landing
    // "path" on a description - and every column right of `amount` is read by
    // nothing. The balance box cannot pick it up either: its label cell is empty, so
    // `only()` never selects this line
    { x: U.running, y: 15, text: tag, size: UA_SIZE },
  ],
  [
    ...ukHeading(808.506),
    ...uaRow(UK, 765.025, '26.07.2026', '13:19:38', 'Аптека', '-75.50', U.amountNarrow),
    ...ukFooter(),
  ],
];

/** The same statement in the other locale, at the other locale's own coordinates. */
const enStatement = (tag: string, closing = '1 624.25 UAH'): PlacedText[][] => [
  [
    { x: U.bank, y: 815.269, text: 'UNIVERSAL BANK JSC' },
    { x: U.margin, y: 744.378, text: 'Cash flow on the card from 01.08.2026.' },
    ...uaBalance(499.022, 'Balance at the beginning of the period:', EN.opening, '1 000.00 UAH'),
    ...uaBalance(485.522, 'Balance at the end of the period:', EN.closing, closing),
    ...uaBalance(457.849, 'Amount of expenses for the period:', EN.grossOut, '575.75 UAH'),
    ...uaBalance(444.349, 'Amount of charges for the period:', EN.grossIn, '1 200.00 UAH'),
    ...enHeading(401.737),
    ...uaRow(EN, 368.631, '28.07.2026', '02:16:38', 'Coffee', '-500.25', U.amount, 'on Khreshchatyk'),
    ...uaRow(EN, 341.081, '27.07.2026', '15:50:41', 'Transfer', '1 200.00', U.amountWide),
    // what makes one case's bytes differ from the next's, in the running-balance
    // column because that is the one place a tag of ANY length is safe: at the left
    // margin its second word fragments into the description column and is appended
    // to the last transaction on the page - measured, with "happy path" landing
    // "path" on a description - and every column right of `amount` is read by
    // nothing. The balance box cannot pick it up either: its label cell is empty, so
    // `only()` never selects this line
    { x: U.running, y: 15, text: tag, size: UA_SIZE },
  ],
  [
    ...enHeading(806.531),
    ...uaRow(EN, 765.025, '26.07.2026', '13:19:38', 'Pharmacy', '-75.50', U.amountNarrow),
    ...enFooter(),
  ],
];

/**
 * Page 1 as readLines produces it, for the selection rules. Hand-built rather than
 * read back off buildPdf, because what these have to carry is the two halves of a
 * fingerprint - the issuer terms and a `collect` header at the template's own
 * x-intervals - and nothing else.
 */
const ukLines: TextLine[] = [
  { page: 1, y: 815.269, items: [{ x: U.bank, text: 'АТ «УНІВЕРСАЛ БАНК»' }] },
  { page: 1, y: 752.778, items: [{ x: U.margin, text: 'Рух коштів по картці від 01.08.2026р.' }] },
  {
    page: 1,
    y: 412.112,
    items: [
      { x: UK.dateHeading, text: 'Дата i час' },
      { x: U.descriptionHeading, text: 'Деталі операції' },
      { x: UK.mccHeading, text: 'MCC' },
    ],
  },
];

const enLines: TextLine[] = [
  { page: 1, y: 815.269, items: [{ x: U.bank, text: 'UNIVERSAL BANK JSC' }] },
  { page: 1, y: 744.378, items: [{ x: U.margin, text: 'Cash flow on the card from 01.08.2026.' }] },
  {
    page: 1,
    y: 401.737,
    items: [
      { x: EN.dateHeading, text: 'Date and time' },
      { x: EN.descriptionHeading, text: 'Description' },
      { x: EN.mccHeading, text: 'MCC' },
      { x: EN.amountHeading, text: 'currency' },
    ],
  },
];

describe('pdf: the third layout', () => {
  /**
   * The axis this row added, seen working: the amount cells carry no currency at all
   * and the template supplies UAH, while the balance cells in the same document
   * carry the ISO code inside the same run and are read by the same pattern. One
   * anchored pattern whose group 2 was the currency could not have read both.
   */
  it('reads a statement whose amount cells carry no currency', async () => {
    const staged = await importPdf('Universal Uk', ukStatement('happy path'), undefined, 'UAH');
    expect(staged.outcome).toBe('awaiting_confirmation');
    if (staged.outcome !== 'awaiting_confirmation') return;

    expect(staged.summary).toMatchObject({
      total: 3,
      accepted: 3,
      skipped: 0,
      problems: [],
      from: '2026-07-26',
      to: '2026-07-28',
      totals: [{ currency: 'UAH', net: 624.25 }],
      balances: { opening: 1000, closing: 1624.25, currency: 'UAH' },
    });
  });

  it('reads the same statement in the other locale, under the other title', async () => {
    const st = await readPdf(buildPdf(enStatement('en happy path')), 200);
    expect(st.template).toBe('universalbank-en');
    expect(st.title).toBe('UNIVERSAL BANK JSC');
    expect(st.balances).toEqual({
      openingCents: 100000,
      closingCents: 162425,
      gross: { kind: 'printed', outgoingCents: -57575, incomingCents: 120000 },
      currency: 'UAH',
    });
    // the sign came out of the cell; the currency came out of the template
    expect(st.sheet.rows.slice(1).map((r) => [r[1], r[3]])).toEqual([
      [-500.25, 'UAH'],
      [1200, 'UAH'],
      [-75.5, 'UAH'],
    ]);

    // and this locale's own drop list, which until now nothing in the file read: 35 of
    // its 72 real rows carry an unlabelled tail, so it is the arm where a wrong rule
    // does the most damage - and a drift in it lengthens a description while every
    // assertion above stays byte-identical. Composed off the template, the way the uk
    // case is, because a copied list goes on passing against a rule that has moved.
    const en = TEMPLATES.find((t) => t.id === 'universalbank-en')!;
    const drop = en.rows.kind === 'continuations' ? en.rows.drop : [];
    expect(drop).toHaveLength(3);
    const descriptions = st.sheet.rows.slice(1).map((r) => String(r[2]));
    // the control, and it is not decorative: the loop below is just as green under a
    // rule that drops EVERYTHING, wrapped tail included. This line is what makes
    // "Coffee on Khreshchatyk" prove the tail was kept while the footer was not.
    expect(descriptions).toEqual(['Coffee on Khreshchatyk', 'Transfer', 'Pharmacy']);
    for (const description of descriptions) {
      for (const label of drop) expect(description).not.toContain(label);
    }
  });

  /**
   * Trap 3, and the invariant nothing else in this file holds for these two: the
   * locales share an issuer, a card and an account, so a fingerprint that fell back
   * to any of those would make `matches` true for both and `selectTemplate` throw
   * ambiguousLayout on a correct document - a statement that never imports. Run over
   * the whole of TEMPLATES rather than a pair, because what has to hold is that
   * exactly one of the four claims each file.
   */
  it('each locale is claimed by its own template and by no other', () => {
    expect(selectTemplate(TEMPLATES, ukLines)?.id).toBe('universalbank-uk');
    expect(selectTemplate(TEMPLATES, enLines)?.id).toBe('universalbank-en');
    for (const lines of [ukLines, enLines]) {
      expect(TEMPLATES.filter((t) => selectTemplate([t], lines) !== undefined)).toHaveLength(1);
    }
  });

  /**
   * The form both real documents arrive in: this bank exports its statement inside a
   * CMS envelope, so `%PDF-` sits at byte 71 and row 33's branch is what classifies
   * it. Classify, store, parse, rows - the wrapped path whole, on this layout.
   */
  it('imports one inside a signed container, end to end', async () => {
    const imported = await importAndConfirm({
      accountName: 'Universal Wrapped',
      currency: 'UAH',
      bytes: buildSignedContainer(buildPdf(ukStatement('wrapped'))),
    });
    expect(imported.inserted).toBe(3);
    const record = (await listImports()).find((i) => i.id === imported.importId)!;
    expect(record.sourceType).toBe('pdf');
  });

  it('a table this layout does not name refuses the document', async () => {
    const pages = ukStatement('unknown table');
    // the marker heading, on a line whose other headings are not this template's
    pages[0].push(
      { x: UK.dateHeading, y: 300, text: 'Дата', size: UA_HEADING_SIZE },
      { x: U.descriptionHeading, y: 300, text: 'Деталі операції' },
    );
    await expect(importPdf('Universal New Table', pages, undefined, 'UAH')).rejects.toThrow(
      /this АТ «УНІВЕРСАЛ БАНК» statement has a table this importer cannot read \("Дата"\)/,
    );
  });

  /**
   * The continuation rule in BOTH directions, which is what taking the permissive
   * arm owes. The tail of a wrapped description is drawn on the time baseline with
   * no label at all and has to be kept; the three footer lines have the same shape,
   * on the same page as the transaction above them, and have to be dropped.
   *
   * The expectation is composed from the template's OWN drop literals rather than
   * copied, the way the n26 near-miss case is: a copy drifts, and the case then goes
   * on passing against a rule that is no longer there. The tail is the control - it
   * is placed the same way and it IS appended, so a footer line that is absent is
   * absent because the template dropped it and not because the line was never a
   * candidate.
   */
  it('keeps an unlabelled wrapped tail and drops the footer the template names', async () => {
    const uk = TEMPLATES.find((t) => t.id === 'universalbank-uk')!;
    const drop = uk.rows.kind === 'continuations' ? uk.rows.drop : [];
    expect(drop).toHaveLength(3);

    const r = await importAndConfirm({
      accountName: 'Universal Continuations',
      currency: 'UAH',
      bytes: buildPdf(ukStatement('continuations')),
    });
    const rows = (await listTransactions({ accountId: r.accountId, limit: 50 })).map(
      (t) => t.description,
    );
    expect(rows.sort()).toEqual(['Аптека', 'Зарахування', 'Кавʼярня на Хрещатику']);
    for (const description of rows) {
      for (const label of drop) expect(description).not.toContain(label);
      // and the paragraph no label names, which only `blank()` keeps out
      expect(description).not.toContain('підпису');
    }
  });

  /**
   * The trailing " UAH" in the pattern is a literal and not " [A-Z]{3}", and this is
   * the difference: a balance printed in another currency has to refuse loudly. A
   * three-letter group would have read this cell as 1 000.00 UAH and imported a
   * dollar statement as hryvnia, which is the silent-wrong-money outcome the whole
   * module exists to refuse.
   */
  it('a balance cell in another currency is refused rather than read as the column one', async () => {
    const pages = ukStatement('foreign balance').map((page) =>
      page.map((t) => (t.text === '1 000.00 UAH' ? { ...t, text: '1 000.00 USD' } : t)),
    );
    await expect(importPdf('Universal Foreign Balance', pages, undefined, 'UAH')).rejects.toThrow(
      /this АТ «УНІВЕРСАЛ БАНК» statement's opening balance cell reads "1 000.00 USD" on its "Баланс на початок періоду:" line/,
    );
  });
});

/**
 * What AmountCurrency's type cannot hold, and this row's whole reason for widening
 * it rather than nesting group 2 onto something that happened to match.
 *
 * `currency: { '': 'UAH' }` type-checks, and under it every cell this parser could
 * not read resolves to a currency anyway - a silent wrong number where the module's
 * entire job is a loud refusal. A key that is one punctuation character is the same
 * defect wearing a key, and a non-empty/no-whitespace/no-digit rule passes it. So the
 * rule is positive instead: a currency symbol is currency signs or letters - "€",
 * "£", "zł", "EUR" - and a per-column code is the ISO 4217 literal the template
 * supplies in place of reading one, which is three uppercase letters or it is not a
 * code.
 *
 * SEEN RED under all three forms - the empty key, the punctuation key and a symbols
 * map with nothing in it - each written into universalbank-uk in turn.
 */
describe('pdf: where a template says an amount currency comes from', () => {
  it('says it fully, on whichever arm it takes', () => {
    expect(TEMPLATES.length).toBeGreaterThan(0);
    for (const t of TEMPLATES) {
      const { currency } = t.amount;
      if (currency.kind === 'in-the-cell') {
        const symbols = Object.entries(currency.symbols);
        expect(symbols.length, `${t.id} declares no symbol at all`).toBeGreaterThan(0);
        for (const [symbol, code] of symbols) {
          expect(symbol, `${t.id} symbol`).toMatch(/^[\p{Sc}\p{L}]+$/u);
          expect(code, `${t.id} code for ${symbol}`).toMatch(/^[A-Z]{3}$/u);
        }
      } else {
        expect(currency.code, `${t.id} column code`).toMatch(/^[A-Z]{3}$/u);
      }
    }
  });
});

/**
 * Row 035's escape arm, and the whole of what holds it.
 *
 * NOTHING STRUCTURAL DOES. `tsc` forces every template to declare what it does about
 * its gross totals and forces the shape of that declaration; it cannot tell an author
 * who read the summary block and found no per-side totals from one who did not look.
 * So the list below is the mechanism: taking the escape turns this case red, and the
 * only way out of it is to write the id in and say in the report which document was
 * read and what its summary block carried instead.
 */
describe('pdf: what a template says about its gross totals', () => {
  it('no template in the tree has switched half the gate off', () => {
    const escaped = TEMPLATES.filter((t) => t.balances.gross.kind === 'not-printed').map(
      (t) => t.id,
    );
    expect(escaped).toEqual([]);
  });

  /**
   * And what the arm costs when it is reached, stated rather than left to be
   * discovered: half the gate is off, and the compensating pair the case in "the
   * reconciliation gate" refuses goes straight through. Unreachable through either
   * template in the tree - which is exactly why it is exercised here through
   * readPdf's `templates` parameter, the way the mixed-currency arm is.
   */
  it('a layout that prints none is read and imports with only its ends checked', async () => {
    const noGross: PdfTemplate = {
      ...twin('no-gross', 'No Gross'),
      balances: {
        kind: 'two-lines',
        label: [0, 330],
        value: [460, 596],
        opening: 'Anfang',
        closing: 'Ende',
        gross: { kind: 'not-printed' },
      },
    };
    // the same page the cases above use, "Raus" and "Rein" included: a template
    // that declares none does not read them, and a document that prints them is
    // not what the arm is about
    const st = await readPdf(twinDoc('+10,00€', '+9,00€', '-1,00€', '+0,00€'), 200, [noGross]);
    expect(st.balances.gross).toEqual({ kind: 'not-printed' });

    const parsed: ParsedFile = {
      kind: 'pdf',
      sheet: st.sheet,
      preset: null,
      mapping: st.columns,
      template: st.template,
      title: st.title,
      balances: st.balances,
    };
    const tx = (amount: number): NewTransaction => ({
      accountId: 'csv:no-gross',
      provider: 'upload',
      amount,
      currency: 'EUR',
      date: '2026-07-01T00:00:00.000Z',
      description: 'x',
      category: 'other',
      fee: null,
    });
    // -51,00 and +50,00 against a document showing one line of -1,00: the ends
    // still meet, and there is nothing printed for either half to be checked
    // against, so it imports
    expect(reconcile(parsed, [tx(-51), tx(50)], 0, NO_BALANCES).balances).toEqual({
      opening: 10,
      closing: 9,
      currency: 'EUR',
    });
  });
});

/**
 * Two IBANs at bank codes the issuer directory carries, invented account and check
 * digits and hand-written here rather than read off ISSUERS: a fixture composed from
 * the rule's own literal goes on passing under every narrowing of that rule (row 034,
 * D4). Nothing in either is anyone's account - the ten digits after the bank code are
 * zeroes, and the eight the row turns on are public routing data.
 */
const IBANS = { c24: 'DE64500240240000000001', n26: 'DE65100110010000000002' } as const;

/**
 * A German layout nothing in the tree was measured against, over as many pages as the
 * case wants, each printing whatever `lines` gives for it. Those lines are placed 12.3
 * apart - six times TOLERANCE, the pitch the real C24 statement puts its IBAN and its
 * BIC at - so a case can print the two the way the document does and get two lines,
 * which is what the fixed-length slice has to survive.
 */
const unknownLayout = (pages: number, lines: (page: number) => string[]): PlacedText[][] =>
  Array.from({ length: pages }, (_, i) => [
    { x: 39.7, y: 780, text: 'Kontoauszug 06/2026' },
    ...lines(i + 1).map((text, n) => ({ x: 45.4, y: 760 - n * 12.3, text })),
    { x: 42.7, y: 700, text: 'Buchungstag' },
    { x: 124.8, y: 700, text: 'Verwendungszweck' },
    { x: 335.1, y: 700, text: 'Betrag' },
    ...row(680, '02.07.2026', 'REWE SAGT DANKE', { debit: '-5,68' }),
    { x: 39.7, y: 27.1, text: `Seite ${i + 1}` },
  ]);

const refusalOfPdf = async (bytes: Buffer): Promise<string> => {
  try {
    await readPdf(bytes, 200);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error('did not refuse');
};

/**
 * Every refusal below needed the file opened, so every one leaves a `failed` import
 * with its document (statement.ts's band comment) - which is what makes the miss
 * diagnosable, and what ROADMAP 5.2 means by recording which template to build next.
 */
describe('pdf: the refusals', () => {
  const cases: [string, () => Buffer, RegExp][] = [
    [
      'a password-protected PDF',
      () => buildPdf([[{ x: 50, y: 700, text: 'secret' }]], { encrypted: true }),
      /this PDF is password-protected - open it with its password/,
    ],
    [
      'a file that starts with %PDF and is not one',
      () => Buffer.from('%PDF-1.4\n1 0 obj\n<< >>\n', 'utf8'),
      /looks like a PDF but could not be opened as one/,
    ],
    ['a scan', () => buildImagePdf(), /this looks like a scan - this importer reads the text layer/],
    [
      'a statement in a layout nobody has written a template for',
      () =>
        buildPdf([
          [
            { x: 39.7, y: 27.1, text: 'Sparkasse Hamburg' },
            { x: 42.7, y: 700, text: 'Buchungstag' },
            { x: 124.8, y: 700, text: 'Verwendungszweck' },
            { x: 335.1, y: 700, text: 'Betrag' },
            ...row(680, '02.07.2026', 'REWE SAGT DANKE', { debit: '-5,68' }),
          ],
        ]),
      /this statement's layout is not one this importer recognises yet/,
    ],
    [
      'a statement in a layout nobody has written a template for, from a bank it can name',
      () => buildPdf(unknownLayout(2, () => [`IBAN: ${IBANS.c24}`, 'BIC: DEFFDEFFXXX'])),
      /this looks like a statement from C24 Bank, and its layout is not one this importer recognises yet/,
    ],
    [
      'a statement in a known layout with no transaction lines in it',
      () => buildPdf([[ISSUER, ...header(700)]]),
      /this Revolut statement has no transaction lines in it/,
    ],
  ];

  for (const [what, bytes, message] of cases) {
    it(`${what} leaves a failed import with its document, and its own message`, async () => {
      const before = await idsNow();
      await expect(
        importStatement({ accountName: 'Refused Bank', currency: 'EUR', bytes: bytes() }),
      ).rejects.toThrow(message);

      const failed = await lastFailure(before);
      expect(failed.status).toBe('failed');
      expect(failed.sourceType).toBe('pdf');
      expect(failed.documentAvailable).toBe(true);
      expect(failed.errorDetail).toMatch(message);
      expect(failed.errorDetail!.length).toBeLessThanOrEqual(ERROR_DETAIL_MAX);
    });
  }

  it('every one of them is a different sentence', () => {
    const sentences = cases.map(([, , message]) => message.source);
    expect(new Set(sentences).size).toBe(cases.length);
  });
});

/**
 * ROADMAP row 30. A layout no template matches is still somebody's statement, and the
 * IBAN it prints carries the bank code, so the refusal can say whose - which is the
 * difference between "this importer does not read this" and "this importer does not
 * read C24 yet". Read against pdf.test's own seam rather than issuer.test's, because
 * what this row ships is a sentence and not a boolean.
 */
describe('pdf: a refusal that names the bank', () => {
  /**
   * The measured shape of a real statement and the whole of the evidence for the rule:
   * the account's own IBAN once on every page, a counterparty's twice a page on a
   * subset - four occurrences against three. Under a most-frequent rule this document
   * is named after the counterparty, which was measured happening in both directions
   * on the two statements the row was built against.
   */
  it("names the account's bank and not the counterparty printed more often", async () => {
    const message = await refusalOfPdf(
      buildPdf(
        unknownLayout(3, (page) => [
          `IBAN: ${IBANS.n26}`,
          ...(page <= 2 ? [`Empfänger: ${IBANS.c24}`, `Auftraggeber: ${IBANS.c24}`] : []),
        ]),
      ),
    );
    expect(message).toBe(
      'this looks like a statement from N26 Bank Berlin, and its layout is not one this importer recognises yet - export the same statement as CSV or Excel (.xlsx) from the same online banking and upload that; those import today',
    );
    expect(message).not.toContain('C24');
  });

  /**
   * A page with no text layer is still a page of the document. Counted only over the
   * pages that yielded lines, the IBAN on the two that did would be "on every page" -
   * a denominator derived from the same data it checks.
   */
  it('counts a page that carries no text at all, and then names nothing', async () => {
    const printed = unknownLayout(2, () => [`IBAN: ${IBANS.c24}`]);
    expect(await refusalOfPdf(buildPdf(printed))).toContain('from C24 Bank');
    expect(await refusalOfPdf(buildPdf([...printed, []]))).toBe(
      "this statement's layout is not one this importer recognises yet - export the same statement as CSV or Excel (.xlsx) from the same online banking and upload that; those import today",
    );
  });

  /**
   * The scan is unreachable until selectTemplate has already answered, so a recognised
   * statement cannot be diverted by what it prints. Pinned by consequence rather than
   * by intention: the same document with three foreign IBANs added imports to exactly
   * the rows it imports without them.
   */
  it('does not run at all on a statement a template claimed', async () => {
    // past the credit column's right edge, so every cell of these lines is empty and
    // the only thing they change about the document is that it prints IBANs. The
    // directory-known one is on both pages, which is the exact shape that earns a
    // name: if identity could reach template selection, this document would be refused
    // as C24's rather than imported as the layout it is.
    const elsewhere: PlacedText[] = [
      IBANS.c24,
      'LT711600000000000005',
      'UA503220010000000000000000007',
    ].map((iban, n) => ({ x: 520, y: 600 - n * 20, text: `IBAN: ${iban}` }));
    const [plain = []] = statement('foreign ibans');

    const control = await readPdf(buildPdf([plain, []]), 200);
    const read = await readPdf(buildPdf([[...plain, ...elsewhere], elsewhere]), 200);

    expect(read.template).toBe(control.template);
    expect(read.title).toBe(control.title);
    expect(read.balances).toEqual(control.balances);
    expect(read.sheet.rows).toEqual(control.sheet.rows);
    expect(read.sheet.rows).toHaveLength(4);
  });
});

/**
 * Row 33. A bank's own export can be the statement inside a CMS envelope, and the
 * sniffer read offset 0 only: `%PDF-` at byte 71 made the file "neither a CSV nor an
 * Excel workbook" to someone holding a document this importer opens perfectly well.
 */
describe('pdf: a statement inside a signed container', () => {
  const REFUSED =
    'this file is not a CSV, Excel (.xlsx) or PDF statement - export the statement in one of those from your online banking and upload that';

  /**
   * The precondition every case below stands on. A container the NUL scan would not
   * have refused is classified the same whether the new branch sits above that scan
   * or below it, so a case built that way cannot notice the branch moving - which is
   * what `buildPdf` output, carrying no NUL at all, would have produced. Composed
   * from NUL_SCAN_BYTES and never from 8192.
   */
  const binaryInsideTheScan = (bytes: Buffer, from = 0): Buffer => {
    const at = bytes.indexOf(0, from);
    const why = 'no NUL the sniffer would have scanned: this fixture pins nothing';
    expect(at, why).toBeGreaterThanOrEqual(from);
    expect(at, why).toBeLessThan(NUL_SCAN_BYTES);
    return bytes;
  };

  /**
   * The lead bytes as measured out of the two real documents - `30 83`, with `%PDF-`
   * at 71 - written here rather than imported from the rule, so a rule narrowed to
   * the one length byte those documents happen to carry goes red (034, D4).
   */
  const container = (lead: number, header = '%PDF-1.4'): Buffer =>
    Buffer.concat([
      Buffer.from([0x30, lead]),
      Buffer.alloc(64),
      Buffer.from(`signature ${header} certificates`),
    ]);

  it('classifies one as a PDF, whichever long-form length the signer wrote', () => {
    // 0x80 is BER indefinite length, which a signer that streams emits; 0x84 is four
    // length bytes. The real documents are 0x83 and the same bank's statement under
    // 64 KiB would be 0x82
    for (const lead of [0x80, 0x81, 0x82, 0x83, 0x84]) {
      expect(sniff(binaryInsideTheScan(container(lead)))).toBe('pdf');
    }
  });

  it('answers on the header being found, never on the lead-in', () => {
    expect(() => sniff(binaryInsideTheScan(container(0x83, 'no header here')))).toThrow(REFUSED);
    // and a lead-in that cannot hold a document is not one: short form says the whole
    // value is at most 127 bytes, and 0x30 is ASCII `0` in the first place
    for (const lead of [0x02, 0x7f, 0x85]) {
      expect(() => sniff(binaryInsideTheScan(container(lead)))).toThrow(REFUSED);
    }
  });

  it('finds a header at the last byte of the file', () => {
    const bytes = Buffer.concat([
      Buffer.from([0x30, 0x83]),
      Buffer.alloc(64),
      Buffer.from('%PDF-'),
    ]);
    expect(sniff(binaryInsideTheScan(bytes))).toBe('pdf');
  });

  /**
   * There is no window, so there is no boundary: pdfjs re-bases on a header inside
   * its own 1024-byte find() and reconstructs the xref when it misses, and a
   * classifier stricter than the reader it feeds refuses a file this product reads.
   */
  it('takes a header past pdfjs own 1024-byte search, and the parser still reads it', async () => {
    const bytes = buildSignedContainer(buildPdf(statement('past the find limit')), 2048);
    expect(bytes.indexOf('%PDF-')).toBeGreaterThan(1024);
    expect(sniff(binaryInsideTheScan(bytes, CONTAINER_HEADER_BYTES))).toBe('pdf');

    const staged = await importStatement({
      accountName: 'Wrapped Far Bank',
      currency: 'EUR',
      bytes,
    });
    expect(staged.outcome).toBe('awaiting_confirmation');
    if (staged.outcome !== 'awaiting_confirmation') return;
    expect(staged.summary.total).toBe(3);
  });

  /**
   * Classify, store, parse, rows - the wrapped path whole rather than in halves. It
   * is not evidence that the real containers import: those reach NOT_RECOGNISED and
   * are stored as failed imports, which is what this row hands row 31.
   */
  it('imports a known layout inside a container, end to end', async () => {
    const imported = await importAndConfirm({
      accountName: 'Wrapped Revolut',
      currency: 'EUR',
      bytes: binaryInsideTheScan(
        buildSignedContainer(buildPdf(statement('wrapped'))),
        CONTAINER_HEADER_BYTES,
      ),
    });

    expect(imported.inserted).toBe(3);
    const record = (await listImports()).find((i) => i.id === imported.importId)!;
    expect(record.sourceType).toBe('pdf');
    expect(record.parserVersion).toBe(PDF_PARSER_VERSION);
  });

  /**
   * The class NOT_A_PDF was reworded for. Every other case pinning that sentence
   * feeds a file whose header is at byte 0, for which the old "starts with %PDF" was
   * equally true - so the new wording was held only by inputs that could not have
   * motivated it. Here the header is at an offset and there is no document behind it.
   */
  it('says a container whose document is broken looks like a PDF, not that it starts with one', async () => {
    const bytes = binaryInsideTheScan(container(0x83));
    expect(bytes.indexOf('%PDF-')).toBeGreaterThan(0);

    await expect(readPdf(bytes, 200)).rejects.toThrow(
      /looks like a PDF but could not be opened as one/,
    );
  });
});

describe('pdf: the caps', () => {
  /**
   * Decidable from the bytes, so it is refused before createImport and leaves no
   * `imports` row at all - the band at statement.ts's comment, and xlsx.test.ts's
   * oversized workbook is the precedent.
   */
  it('a PDF past the byte cap is refused before an import row exists', async () => {
    const oversized = Buffer.alloc(11 * 1024 * 1024);
    Buffer.from('%PDF-1.4\n').copy(oversized);
    expect(sniff(oversized)).toBe('pdf');
    const before = (await listImports()).length;
    const attempt = () =>
      importStatement({ accountName: 'Fat Pdf Bank', currency: 'EUR', bytes: oversized });

    await expect(attempt()).rejects.toThrow(/the PDF is larger than 10 MB/);
    expect(await listImports()).toHaveLength(before);
    // nothing recorded the hash, so this is a second refusal and not a duplicate
    await expect(attempt()).rejects.toThrow(/the PDF is larger than 10 MB/);
    expect(await listImports()).toHaveLength(before);
  });

  /**
   * The page cap is on the other side of the line, and deliberately: numPages needs
   * the document open, which is the same reason "password-protected" leaves a row
   * despite parsing nothing either. Bytes do not bound the page count - this fixture
   * is 201 pages in well under a megabyte.
   */
  it('a PDF past the page cap leaves a failed import with its document', async () => {
    const pages: PlacedText[][] = [];
    for (let p = 0; p < 201; p++) pages.push([{ x: 50, y: 700, text: `page ${p}` }]);
    const bytes = buildPdf(pages);
    expect(bytes.length).toBeLessThan(1024 * 1024);

    const before = await idsNow();
    await expect(
      importStatement({ accountName: 'Long Pdf Bank', currency: 'EUR', bytes }),
    ).rejects.toThrow(/this PDF has 201 pages, more than the 200 this importer reads in one file/);

    const failed = await lastFailure(before);
    expect(failed.status).toBe('failed');
    expect(failed.documentAvailable).toBe(true);
  });
});

/**
 * What replaced accountid.ts, and the cheapest possible check that the seam did not
 * grow a second account namespace: one resolution point, so a bank uploaded as a PDF
 * one month and as a CSV the next resolves the same name to the same recorded id and
 * lands in one account. A parser-specific id would split it, and every row appearing
 * in both files would insert twice - the dedup key is unique per (workspace, account,
 * key), so a second account id defeats it silently.
 *
 * The two ids are compared to each other, which is what the test was always about:
 * an id nothing derives has no literal to be checked against, and the deduplication
 * asserted below is what makes the comparison mean something.
 */
describe('pdf and csv of the same statement', () => {
  it('land in one account, and the second one deduplicates against the first', async () => {
    const name = 'One Bank Two Formats';
    const fromPdf = await importAndConfirm({
      accountName: name,
      currency: 'EUR',
      bytes: buildPdf(statement('two formats')),
    });
    expect(fromPdf.inserted).toBe(3);

    const csv = [
      'Completed Date,Description,Amount,Currency,State',
      '2026-07-02,REWE.de,-5.68,EUR,COMPLETED',
      '2026-07-03,Платеж от JANE DOE,100.00,EUR,COMPLETED',
      '2026-07-30,Wizz Air,-1234.56,EUR,COMPLETED',
      // one the PDF did not carry, so the run is not vacuously "nothing new"
      '2026-07-31,Netflix,-12.99,EUR,COMPLETED',
    ].join('\n');
    const fromCsv = await importAndConfirm({
      accountName: name,
      currency: 'EUR',
      preset: 'revolut',
      bytes: Buffer.from(csv, 'utf8'),
    });

    expect(fromCsv.accountId).toBe(fromPdf.accountId);
    expect(fromCsv.inserted).toBe(1);
    expect(await getAccount(fromPdf.accountId)).toBeDefined();
    expect((await listTransactions({ accountId: fromPdf.accountId, limit: 50 })).length).toBe(4);
  });
});

/**
 * I1: a third format must not fall through to the CSV reader, or a PDF is handed to
 * decodeCsv and the user is told their columns do not match against a document whose
 * columns were never looked for.
 *
 * Held by tsc - deleting the pdf arm gives `src/providers/statement.ts(383,13):
 * error TS2322: Type '"pdf"' is not assignable to type 'never'`. This is the other
 * half: row 19's ruling is that an assumed `never` is worth nothing, and a
 * compile-time error cannot show the runtime arm actually throws.
 */
describe('the source-type dispatch', () => {
  it('has no default that quietly reads something as a CSV', async () => {
    await expect(
      readSheet(
        { accountName: 'x', currency: 'EUR', bytes: Buffer.from('date,amount,description\n') },
        'ofx' as ImportSourceType,
        null,
      ),
    ).rejects.toThrow(/unhandled source type: ofx/);
  });
});

/**
 * Trap 5: describeRow and noRowsParsed are shared, and xlsx.ts's NOTICE_MAX is
 * derived from a measurement of the longest reason they can compose - 159, at which
 * point a longer one from this path would start dropping the unused-sheet notice off
 * workbooks that have nothing to do with PDFs. So this path's notes are bounded, and
 * the bound is asserted rather than commented.
 */
describe('the diagnostic budget', () => {
  it('a note quotes a long cell cut, and stays inside what xlsx.ts assumed', async () => {
    // small enough to stay inside its own column at this point size, long enough
    // that both the inner quote and the outer bound have to do something
    const long = 'ы'.repeat(26);
    const tiny = (t: PlacedText): PlacedText => ({ ...t, size: 2 });
    const st = await readPdf(
      buildPdf([
        [
          ISSUER,
          ...header(700),
          ...row(680, `2 ${long}. 2026г.`, long, { debit: `${long},00€`, credit: '1,00€' }).map(
            tiny,
          ),
          // readPdf reads the box but never checks it - the gate is mapAndStore's,
          // and this case is about what a note costs, not what a statement sums to
          ...box(640, '1,00€', '1,00€', '1,00€', '1,00€'),
        ],
      ]),
      200,
    );

    const notes = [st.sheet.note!(1, 0), st.sheet.note!(1, 1)];
    // both cells quoted back, both cut inside their quotes rather than at the end -
    // a message cut at the end names a column the sentence was about to name
    expect(notes[0]).toMatch(/^reads "2 ы+…", which this template cannot read as a date$/);
    expect(notes[1]).toMatch(/^holds "ы+…" and "1,00€" - a line carries a debit or a credit/);
    for (const note of notes) expect(note!.length).toBeLessThanOrEqual(NOTE_MAX);
    // and what describeRow puts in front of it, at MAX_DATA_ROWS: the lead plus the
    // bound may not pass 159, the longest describeRow output xlsx.ts's NOTICE_MAX
    // was derived from. Asserted against the constant, so raising it goes red here
    // rather than silently off the end of an unrelated workbook's notice
    expect(`row 50000: the amount cell ${'x'.repeat(NOTE_MAX)}`.length).toBeLessThanOrEqual(159);
  });

  /**
   * And the gate's own longest sentence, composed rather than measured by hand:
   * ROADMAP row 21 exists because a margin was held by arithmetic somebody did once.
   *
   * The extreme is the R5 form - the longer of the two - with MAX_DATA_ROWS lines
   * read AND that many skipped, every amount at the longest toFixed(2) produces
   * before it switches to exponential notation (24 characters), and the currency at
   * the bound statement.ts puts on one. The running sum carries a sign on top of
   * that: the two balances are non-negative because the template's amount pattern
   * has no sign, but a statement whose rows net downwards past its opening balance
   * is ordinary, so the widest of the four amounts is 25 characters and the extreme
   * is composed with it. All three refusals are composed here rather than measured,
   * so raising any of those goes red instead of silently off the end of what
   * error_detail keeps.
   *
   * The title comes from TEMPLATES too, and not from the literal 'Revolut' this case
   * carried before row 035: the sentence names the layout once, so the longest title
   * in the tree is what the remaining headroom is spent by, and a template added with
   * a longer one has to turn this case red rather than cut a refusal's tail off (6b
   * D16(b), landed here).
   */
  it("the gate's longest refusals fit what error_detail keeps", () => {
    // built FROM the bound rather than beside it: written as a literal wide enough
    // today, it stops reaching the bound the moment the bound is raised, and these
    // assertions go on passing over a sentence that has grown past 500
    const CCY = 'A'.repeat(CURRENCY_CODE_MAX + 2);
    const TITLE = TEMPLATES.map((t) => t.title).reduce((a, b) => (a.length >= b.length ? a : b));
    const tx = (currency: string, amount: number): NewTransaction => ({
      accountId: 'csv:budget',
      provider: 'upload',
      amount,
      currency,
      date: '2026-07-02T00:00:00.000Z',
      description: 'x',
      category: 'other',
      fee: null,
    });
    const parsed = (
      currency: string,
      gross = { kind: 'printed', outgoingCents: 0, incomingCents: 0 } as const,
    ): ParsedFile => ({
      kind: 'pdf',
      sheet: { rows: [], rowLabel: (i) => i },
      preset: null,
      mapping: {},
      template: 'revolut-ru',
      title: TITLE,
      // opening 1e20 and closing 1e20, so the case below - whose rows net -2e20 -
      // puts the running sum at -1e20 and the difference at 2e20
      balances: { openingCents: 1e22, closingCents: 1e22, gross, currency },
    });
    const refusalOf = (run: () => unknown): string => {
      try {
        run();
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error('did not refuse');
    };

    const short = refusalOf(() => reconcile(parsed('EUR'), [tx('EUR', 1e20)], 0, NO_BALANCES));
    expect(short).toContain('100000000000000000000.00 EUR');
    expect(short).toContain('so an operation is probably missing');

    const longest = refusalOf(() =>
      reconcile(
        parsed(CCY),
        Array.from({ length: MAX_DATA_ROWS }, (_, i) => tx(CCY, i === 0 ? -2e20 : 0)),
        MAX_DATA_ROWS,
        NO_BALANCES,
      ),
    );
    expect(longest).toContain('are probably where it went');
    expect(longest).toContain('-100000000000000000000.00');
    expect(longest.length).toBeLessThanOrEqual(ERROR_DETAIL_MAX);

    // and row 035's, at its own extreme: the ends have to agree for it to fire at
    // all, so the rows net to zero and each half is as wide as one can be. Three of
    // the four figures carry a sign - the READ incoming side is a sum of
    // non-negatives and cannot, where the PRINTED one can, because a layout that
    // writes the sign in the cell can write a negative there and a drifted span
    // reading the outgoing cell into this slot is exactly how one arrives. The
    // skipped clause is the longer of the two causes
    const sides = refusalOf(() =>
      reconcile(
        parsed(CCY, { kind: 'printed', outgoingCents: -1e22, incomingCents: -1e22 }),
        Array.from({ length: MAX_DATA_ROWS }, (_, i) =>
          tx(CCY, i === 0 ? -2e20 : i === 1 ? 2e20 : 0),
        ),
        MAX_DATA_ROWS,
        NO_BALANCES,
      ),
    );
    expect(sides).toContain('opening and closing balance agree, but its two halves do not');
    expect(sides).toContain('are probably where they went');
    expect(sides.length).toBeLessThanOrEqual(ERROR_DETAIL_MAX);

    // and the other one, at its own extreme: three codes named and the rest counted,
    // each as wide as the bound lets one be
    const mixed = refusalOf(() =>
      reconcile(
        parsed(CCY),
        ['A', 'B', 'C', 'D', 'E'].map((c) => tx(c.repeat(CURRENCY_CODE_MAX + 2), 1)),
        0,
        NO_BALANCES,
      ),
    );
    expect(mixed).toContain('and 2 more');
    expect(mixed.length).toBeLessThanOrEqual(ERROR_DETAIL_MAX);
  });

  /**
   * And the parser's own set, composed rather than measured: `refusals` builds every
   * one of them at its extreme out of every template's own title, balance labels,
   * currency codes and example. A template added with a longer label moves the number
   * below, which is the point - the same measurement written into a comment in pdf.ts
   * would simply stop being true (row 6c, D5, and rows 6a D14 / 6b D2 / 6b D10).
   *
   * 310 before row 035, 316 after it, and 313 now. Row 035 moved it by widening the
   * label pool - a two-lines box declares four labels rather than two, so n26-de's
   * longest became "Einkommende Transaktionen" - and row 31 moved it twice more, in
   * opposite directions. R-D's head shortened all five builders and by five different
   * amounts, because each sentence spends the head differently: measured at n26-de's
   * own literals, unreadableTable -20, noTransactionLines -24, noBalanceBox -15,
   * unreadableBalance -19 and mixedBalanceCurrencies -19, which puts the two shipped
   * templates' longest at 297. The third layout then adds 16 back.
   *
   * The longest sentence is still mixedBalanceCurrencies and it has moved template:
   * universalbank-uk. Every one of those 16 characters is TITLE - "АТ «УНІВЕРСАЛ
   * БАНК»" at 19 against "N26" at 3 - and none of it is the label, because `quote`
   * cuts a label at CELL_QUOTE_MAX and the Ukrainian 26 and "Einkommende
   * Transaktionen"'s 25 both arrive as 24 and cancel. universalbank-en's label is 39,
   * the widest in the tree, and contributes nothing for the same reason: its sentence
   * is 312, short of this one by exactly its one character less of title.
   */
  it("the parser's own refusals fit what error_detail keeps, at every template's extreme", () => {
    const all = refusals();
    for (const sentence of all) expect(sentence.length).toBeLessThanOrEqual(ERROR_DETAIL_MAX);
    expect(Math.max(...all.map((s) => s.length))).toBe(313);
    // and no two of them read alike, which is what the set exists for
    expect(new Set(all).size).toBe(all.length);
  });
});
