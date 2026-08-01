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
  TextLine,
  readPdf,
  refusals,
  selectTemplate,
} from '../src/providers/pdf';
import { MAX_DATA_ROWS } from '../src/providers/sheet';
import {
  CURRENCY_CODE_MAX,
  ParsedFile,
  importStatement,
  readSheet,
  reconcile,
  sniff,
} from '../src/providers/statement';
import { NewTransaction } from '../src/types';
import { importAndConfirm } from './helpers';
import { PlacedText, buildImagePdf, buildPdf } from './pdffixture';

// the x-intervals the revolut-ru template declares, one literal each so a test that
// places a cell outside its column has to say so. The last three are the balance
// box's, and `total` shares the date column's interval on purpose - that is where
// the real document writes the label.
const X = {
  date: 42.7,
  description: 124.8,
  debit: 335.1,
  credit: 417.1,
  total: 42.7,
  opening: 253.0,
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
 */
const box = (y: number, opening: string, closing: string): PlacedText[] => [
  { x: X.total, y, text: 'Итого' },
  { x: X.opening, y, text: opening },
  { x: X.closing, y, text: closing },
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
    // the three rows net -1 140,24
    ...box(620, '1 200,00€', closing),
  ],
];

const importPdf = (accountName: string, pages: PlacedText[][], preset?: string) =>
  importStatement({ accountName, currency: 'EUR', bytes: buildPdf(pages), preset });

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
    // -16,90 over the three
    drawn.push(...box(620, '100,00€', '83,10€'));

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
        // Flipping `collect: false` on that table fails this case
        ...box(540, '100,00€', '94,32€'),
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
    ).rejects.toThrow(/has a table this importer cannot read \("Дата начисления"\)/);

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
        ...box(540, '100,00€', '104,31€'),
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

  /** presetMapping still throws on a name no preset has: that is a client bug. */
  it('an unknown preset is still loud on the PDF path', async () => {
    await expect(importPdf('Revolut Bad Preset', statement('bad preset'), 'not-a-bank')).rejects.toThrow(
      /unknown preset: not-a-bank/,
    );
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
          ...box(560, '100,00€', '90,00€'),
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
    // match: 1 200,00 - 1 140,24 - 12,99 = 46,77
    const staged = await importPdf(name, [
      [
        ISSUER,
        { x: 39.7, y: 15, text: 'overlap second' },
        ...header(700),
        ...row(680, '2 июл. 2026г.', 'REWE.de', { debit: '5,68€' }),
        ...row(660, '3 июл. 2026г.', 'Платеж от JANE DOE', { credit: '100,00€' }),
        ...row(640, '30 июл. 2026г.', 'Wizz Air', { debit: '1 234,56€' }),
        ...row(620, '31 июл. 2026г.', 'Netflix', { debit: '12,99€' }),
        ...box(600, '1 200,00€', '46,77€'),
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
        ...box(640, '0,00€', '0,30€'),
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
      /could not read its balance summary: it expects exactly one "Итого" line and found 0/,
    ],
    [
      'two of them',
      [...box(640, '1 200,00€', '59,76€'), ...box(600, '1 200,00€', '59,76€')],
      /it expects exactly one "Итого" line and found 2/,
    ],
    [
      // the group separator gone is the smallest drift a redesign can produce, and
      // it must not be read as 1 200,00 by a laxer pattern
      'an opening balance this template cannot read',
      box(640, '1200,00€', '59,76€'),
      /the opening balance cell of its "Итого" line reads "1200,00€", where this template reads an amount like "1 234,56€"/,
    ],
    [
      'a closing balance that is not there',
      box(640, '1 200,00€', ''),
      /the closing balance cell of its "Итого" line reads "", where this template reads an amount like "1 234,56€"/,
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
    });

    const parsed = (currency: string): ParsedFile => ({
      kind: 'pdf',
      sheet: { rows: [], rowLabel: (i) => i },
      preset: null,
      mapping: {},
      template: 'revolut-ru',
      title: 'Revolut',
      balances: { openingCents: 0, closingCents: 3000, currency },
    });

    it('refuses rather than checking against whichever currency came first', () => {
      expect(() => reconcile(parsed('EUR'), [tx('EUR', 10), tx('PLN', 20)], 0)).toThrow(
        'this Revolut statement states its balances in EUR, but the lines read are in EUR, PLN' +
          ' - this importer cannot check a statement that mixes currencies',
      );
    });

    it("refuses one currency that is not the balances' either", () => {
      expect(() => reconcile(parsed('EUR'), [tx('PLN', 30)], 0)).toThrow(
        'states its balances in EUR, but the lines read are in PLN',
      );
    });

    it('names three and counts the rest', () => {
      const many = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'].map((c) => tx(c, 1));
      expect(() => reconcile(parsed('EUR'), many, 0)).toThrow(
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
    currency: { '€': 'EUR' },
    example: '-1,00€',
  },
  rows: { kind: 'one-line' },
  balances: {
    kind: 'two-lines',
    label: [0, 330],
    value: [460, 596],
    opening: 'Anfang',
    closing: 'Ende',
  },
});

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
      /the opening balance cell of its "Dein alter Kontostand" line reads "2\.415,77€", where this template reads an amount like "-1\.234,56€"/,
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
        currency: { '€': 'EUR', '£': 'GBP' },
        example: '-1,00€',
      },
    };
    const bytes = buildPdf([
      [
        { x: 40, y: 760, text: 'Two Layouts Bank' },
        { x: 40, y: 700, text: 'Beschreibung' },
        { x: 340, y: 700, text: 'Datum' },
        { x: 500, y: 700, text: 'Betrag' },
        { x: 40, y: 680, text: 'Kauf' },
        { x: 340, y: 680, text: '01.07.2026' },
        { x: 500, y: 680, text: '-1,00€' },
        { x: 40, y: 640, text: 'Anfang' },
        { x: 500, y: 640, text: '+10,00€' },
        { x: 40, y: 620, text: 'Ende' },
        { x: 500, y: 620, text: '+9,00£' },
      ],
    ]);
    await expect(readPdf(bytes, 200, [twoSymbols])).rejects.toThrow(
      'this looks like a Two Symbols statement but its opening balance ("Anfang") is stated in' +
        ' EUR and its closing balance ("Ende") in GBP - this importer cannot check a statement' +
        ' that mixes currencies',
    );
  });
});

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
      /starts with %PDF but could not be opened as one/,
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
      'a statement in a known layout with no transaction lines in it',
      () => buildPdf([[ISSUER, ...header(700)]]),
      /looks like a Revolut statement but no transaction lines were found in it/,
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
 * accountid.ts's whole reason, and the cheapest possible check that the seam did not
 * grow a second account namespace: the prefix is an opaque id and not a claim about
 * the format, so one bank uploaded as a PDF one month and as a CSV the next lands in
 * one account. A `pdf:` prefix would split it, and every row appearing in both files
 * would insert twice - the dedup key is unique per (workspace, account, key), so a
 * second account id defeats it silently.
 */
describe('pdf and csv of the same statement', () => {
  it('land in one account, and the second one deduplicates against the first', async () => {
    const name = 'One Bank Two Formats';
    const fromPdf = await importAndConfirm({
      accountName: name,
      currency: 'EUR',
      bytes: buildPdf(statement('two formats')),
    });
    expect(fromPdf.accountId).toBe('csv:one-bank-two-formats');
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
          ...box(640, '1,00€', '1,00€'),
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
   * is composed with it. Both refusals are composed here rather than measured, so
   * raising any of those goes red instead of silently off the end of what
   * error_detail keeps.
   */
  it("the gate's longest refusals fit what error_detail keeps", () => {
    // built FROM the bound rather than beside it: written as a literal wide enough
    // today, it stops reaching the bound the moment the bound is raised, and these
    // assertions go on passing over a sentence that has grown past 500
    const CCY = 'A'.repeat(CURRENCY_CODE_MAX + 2);
    const tx = (currency: string, amount: number): NewTransaction => ({
      accountId: 'csv:budget',
      provider: 'upload',
      amount,
      currency,
      date: '2026-07-02T00:00:00.000Z',
      description: 'x',
      category: 'other',
    });
    const parsed = (currency: string): ParsedFile => ({
      kind: 'pdf',
      sheet: { rows: [], rowLabel: (i) => i },
      preset: null,
      mapping: {},
      template: 'revolut-ru',
      title: 'Revolut',
      // opening 1e20 and closing 1e20, so the case below - whose rows net -2e20 -
      // puts the running sum at -1e20 and the difference at 2e20
      balances: { openingCents: 1e22, closingCents: 1e22, currency },
    });
    const refusalOf = (run: () => unknown): string => {
      try {
        run();
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error('did not refuse');
    };

    const short = refusalOf(() => reconcile(parsed('EUR'), [tx('EUR', 1e20)], 0));
    expect(short).toContain('100000000000000000000.00 EUR');
    expect(short).toContain('so an operation is probably missing');

    const longest = refusalOf(() =>
      reconcile(
        parsed(CCY),
        Array.from({ length: MAX_DATA_ROWS }, (_, i) => tx(CCY, i === 0 ? -2e20 : 0)),
        MAX_DATA_ROWS,
      ),
    );
    expect(longest).toContain('are probably where it went');
    expect(longest).toContain('-100000000000000000000.00');
    expect(longest.length).toBeLessThanOrEqual(ERROR_DETAIL_MAX);

    // and the other one, at its own extreme: three codes named and the rest counted,
    // each as wide as the bound lets one be
    const mixed = refusalOf(() =>
      reconcile(
        parsed(CCY),
        ['A', 'B', 'C', 'D', 'E'].map((c) => tx(c.repeat(CURRENCY_CODE_MAX + 2), 1)),
        0,
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
   */
  it("the parser's own refusals fit what error_detail keeps, at every template's extreme", () => {
    const all = refusals();
    for (const sentence of all) expect(sentence.length).toBeLessThanOrEqual(ERROR_DETAIL_MAX);
    expect(Math.max(...all.map((s) => s.length))).toBe(310);
    // and no two of them read alike, which is what the set exists for
    expect(new Set(all).size).toBe(all.length);
  });
});
