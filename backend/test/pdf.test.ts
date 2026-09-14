import { describe, expect, it, vi } from 'vitest';
import { categorize } from '../src/categorizer';
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
  PdfLimits,
  PdfTemplate,
  StatementBalances,
  TEMPLATES,
  TextLine,
  readPdf,
  refusals,
  selectTemplate,
} from '../src/providers/pdf';
import { Cell, MAX_DATA_ROWS } from '../src/providers/sheet';
import {
  CURRENCY_CODE_MAX,
  ImportSummary,
  NUL_SCAN_BYTES,
  ParsedFile,
  StatedBalances,
  StatedFee,
  applyFee,
  importStatement,
  readSheet,
  reconcile,
  sniff,
} from '../src/providers/statement';
import { NewTransaction } from '../src/types';
import { accountFor, importAndConfirm } from './helpers';
import {
  CONTAINER_HEADER_BYTES,
  PlacedText,
  buildImagePdf,
  buildPdf,
  buildSignedContainer,
} from './pdffixture';

const NO_BALANCES: StatedBalances = { kind: 'none' };

/**
 * A page cap every fixture below is far under, and a deadline none of them approaches, so
 * neither bound decides anything except in the cases written against it.
 */
const LIMITS: PdfLimits = { maxPages: 200, deadlineMs: 60_000 };

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
 * The statement's own balance summary - the one line the reconciliation gate checks the
 * rows against.
 *
 * Every gross pair below is arithmetic done on the fixture's OWN literal amounts, and
 * never read off the parser: a box computed from what the reader produced agrees with the
 * reader by construction and tests nothing.
 *
 * `BOX_SIZE` is a fixture artefact, not a fact about the layout. This fixture's font
 * advances far more per character than the real document's, and pdfjs joins two runs that
 * meet into ONE item at the left one's x - so at the default size the opening cell picks
 * up the first digit of the cell beside it.
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
 * The three-row statement most cases below import. `tag` is what makes one case's bytes
 * differ from the next one's: identical bytes answer "already imported" without being
 * parsed at all, which would make a case pass having asserted nothing. It sits below the
 * footer, where it is neither a table header nor a transaction.
 */
const statement = (tag: string, closing = '59,76€'): PlacedText[][] => [
  [
    ISSUER,
    { x: 39.7, y: 15, text: tag },
    ...header(700),
    ...row(680, '2 июл. 2026г.', 'REWE.de', { debit: '5,68€' }),
    ...row(660, '3 июл. 2026г.', 'Платеж от JANE DOE', { credit: '100,00€' }),
    ...row(640, '30 июл. 2026г.', 'Wizz Air', { debit: '1 234,56€' }),
    ...box(620, '1 200,00€', '1 240,24€', '100,00€', closing),
  ],
];

const CARDS = ['Карта: 400000******0000', 'Карта: 555500******0001'] as const;

/**
 * One line of the deposit-insurance footer the real document prints at the bottom of
 * every page: the description column, every other cell empty - a continuation's exact
 * shape - on the page of the transaction it would attach to, so the page test cannot see
 * it. It carries no label, which is what keeps it out.
 *
 * `FOOTER_SIZE` is a budget rather than a preference, and it is the one every other size
 * constant in this file refers to. pdfjs splits a placed run at every space and assigns
 * each fragment to a column by its own left edge, and this fixture's font advances far
 * more per character than the real document's - so spend the headroom and the line writes
 * into the debit column, `blank()` stops calling it a continuation, and the case below
 * passes having exercised nothing. That is the silent direction: a KEPT line that stops
 * being a candidate turns its own case red, a dropped one does not.
 */
const FOOTER = 'Литвы и Европейского центрального банка. Компания также';
const FOOTER_SIZE = 3;

const DETAILED: readonly {
  date: string;
  description: string;
  amount: { debit?: string; credit?: string };
  under: readonly { text: string; kept: boolean; size?: number }[];
}[] = [
  {
    date: '2 июл. 2026г.',
    description: 'REWE.de',
    amount: { debit: '5,68€' },
    under: [
      { text: 'Получатель: Rewe Markt Mueller, Hamburg', kept: true },
      { text: CARDS[0], kept: false },
    ],
  },
  {
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
  drawn.push(...box(y, '1 200,00€', '1 240,24€', '109,99€', '69,75€'));
  return [drawn];
};

const importPdf = async (
  name: string,
  pages: PlacedText[][],
  preset?: string,
  currency = 'EUR',
) =>
  importStatement({ accountId: await accountFor(name, currency), bytes: buildPdf(pages), preset });

async function lastFailure(before: string[]): Promise<{
  status: string;
  errorDetail: string | null;
  documentAvailable: boolean;
  sourceType: ImportSourceType;
}> {
  const fresh = (await listImports()).imports.filter((i) => !before.includes(i.id));
  expect(fresh).toHaveLength(1);
  return fresh[0];
}

const idsNow = async (): Promise<string[]> => (await listImports()).imports.map((i) => i.id);

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
      balances: { opening: 1200, closing: 59.76, currency: 'EUR' },
    });
    const imports = (await listImports()).imports;
    const record = imports.find((i) => i.id === staged.summary.importId)!;
    expect(record.sourceType).toBe('pdf');
    // the literal, not PDF_PARSER_VERSION: a symbol on both sides of this cannot fail
    expect(record.parserVersion).toBe(7);
  });

  it('the amount column decides the sign, and the € decides the currency', async () => {
    const r = await importAndConfirm({
      accountId: await accountFor('Revolut Signs', 'USD'),
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
    drawn.push(...box(620, '100,00€', '16,90€', '0,00€', '83,10€'));

    const r = await importAndConfirm({
      accountId: await accountFor('Revolut Drawing Order'),
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

  it('rows under the pending table are not imported', async () => {
    const staged = await importPdf('Revolut Pending', [
      [
        ISSUER,
        ...header(700, 'Дата начала'),
        ...row(680, '31 июл. 2026г.', 'Rewe', { debit: '5,96€' }),
        ...header(600),
        ...row(580, '2 июл. 2026г.', 'REWE.de', { debit: '5,68€' }),
        ...box(540, '100,00€', '5,68€', '0,00€', '94,32€'),
      ],
    ]);
    if (staged.outcome !== 'awaiting_confirmation') throw new Error('not staged');
    expect(staged.summary).toMatchObject({ total: 1, accepted: 1, skipped: 0 });
    expect(staged.summary.totals).toEqual([{ currency: 'EUR', net: -5.68 }]);
  });

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
    expect(staged.summary.totals).toEqual([{ currency: 'EUR', net: 4.31 }]);
  });

  it('the preset chip does not decide what a PDF imports', async () => {
    const strip = (s: ImportSummary) => {
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

  it('the summary names the PDF layout that read it, and no column at all', async () => {
    const staged = await importPdf('Revolut Pdf Read As', statement('read as'), 'revolut');
    if (staged.outcome !== 'awaiting_confirmation') throw new Error('the PDF was refused');
    expect(staged.summary.readAs).toEqual({ kind: 'pdf-template', title: 'Revolut' });
  });

  it('an unknown preset is still loud on the PDF path', async () => {
    await expect(importPdf('Revolut Bad Preset', statement('bad preset'), 'not-a-bank')).rejects.toThrow(
      /unknown preset: not-a-bank/,
    );
  });

  it('a transaction is its dated line and the labelled lines under it', async () => {
    const r = await importAndConfirm({
      accountId: await accountFor('Revolut Descriptions'),
      bytes: buildPdf(detailed('descriptions')),
    });
    const rows = (await listTransactions({ accountId: r.accountId, limit: 50 })).map(
      (t) => t.description,
    );
    expect(rows).toHaveLength(DETAILED.length);
    for (const t of DETAILED) {
      expect(rows.find((d) => d.startsWith(t.description))).toBe(kept(t));
    }
  });

  it('the lines the template does not keep do not reach a description', async () => {
    const r = await importAndConfirm({
      accountId: await accountFor('Revolut Cards'),
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

describe('pdf: the fee on a continuation line', () => {
  const GROSS = 6362;
  const FEE = 44;
  const MERCHANT = GROSS - FEE;
  const OPENING = 120000;

  const eur = (cents: number): string =>
    `${Math.trunc(cents / 100)
      .toString()
      .replace(/\B(?=(\d{3})+$)/g, ' ')},${String(cents % 100).padStart(2, '0')}€`;

/**
 * The label off the template rather than a copy of it: a copied literal goes on passing
 * against a rule that is no longer there. Every expectation in this file that names a
 * template's own literal is composed the same way, for the same reason.
 */
  const label = (): string => {
    const { fee } = TEMPLATES.find((t) => t.id === 'revolut-ru')!;
    if (fee.kind !== 'included') throw new Error('revolut-ru no longer declares a fee line');
    return fee.label;
  };

  const feeLine = (y: number, states: string, column: string): PlacedText[] => [
    { x: X.description, y, text: `${label()} ${states}` },
    { x: X.debit, y, text: column },
  ];

  const RATE = 'Курс Revolut 1,00€ = 4,32 PLN (курс ECB * 1,00€ = 4,34 PLN)';
  const rateLine = (y: number): PlacedText[] => [
    { x: X.description, y, text: RATE, size: 3 },
    { x: X.debit, y, text: '272,94 PLN' },
  ];

  const feeStatement = (tag: string, states: string, ...extra: PlacedText[]): PlacedText[][] => [
    [
      ISSUER,
      { x: 39.7, y: 15, text: tag },
      ...header(700),
      ...row(680, '20 июл. 2026г.', 'Wizz Air', { debit: eur(GROSS) }),
      ...feeLine(668, states, eur(MERCHANT)),
      ...extra,
      ...box(620, eur(OPENING), eur(GROSS), eur(0), eur(OPENING - GROSS)),
    ],
  ];

  const plainStatement = (tag: string): PlacedText[][] => [
    [
      ISSUER,
      { x: 39.7, y: 15, text: tag },
      ...header(700),
      ...row(680, '20 июл. 2026г.', 'Wizz Air', { debit: eur(GROSS) }),
      ...box(620, eur(OPENING), eur(GROSS), eur(0), eur(OPENING - GROSS)),
    ],
  ];

  it('the fee is the number beside the label, not the one in the amount column', async () => {
    expect(eur(MERCHANT)).toBe('63,18€');
    const r = await importAndConfirm({
      accountId: await accountFor('Revolut Fee Line'),
      bytes: buildPdf(feeStatement('fee line', eur(FEE))),
    });
    expect(r.inserted).toBe(1);

    const [t] = await listTransactions({ accountId: r.accountId });
    expect(t.description).toBe('Wizz Air');
    expect(t.amount).toBe(-63.62);
    expect(t.fee).toBe(0.44);
  });

  it('a fee-bearing statement reconciles on the amounts the document printed', async () => {
    const staged = await importPdf('Revolut Fee Gate', feeStatement('fee gate', eur(FEE)));
    if (staged.outcome !== 'awaiting_confirmation') throw new Error('the PDF was refused');
    expect(staged.summary).toMatchObject({
      total: 1,
      accepted: 1,
      skipped: 0,
      problems: [],
      totals: [{ currency: 'EUR', net: -63.62 }],
      balances: { opening: 1200, closing: 1136.38, currency: 'EUR' },
    });
  });

  it('the exchange-rate line under the fee line contributes nothing', async () => {
    const r = await importAndConfirm({
      accountId: await accountFor('Revolut Fee Rate'),
      bytes: buildPdf(feeStatement('rate line', eur(FEE), ...rateLine(656))),
    });
    expect(r.inserted).toBe(1);
    const txs = await listTransactions({ accountId: r.accountId });
    expect(txs).toHaveLength(1);
    expect(txs[0].description).toBe('Wizz Air');
    expect(txs[0].amount).toBe(-63.62);
    expect(txs[0].fee).toBe(0.44);
  });

  it('neither a fee line nor a rate line is a transaction line', async () => {
    const counts = async (name: string, pages: PlacedText[][]) => {
      const staged = await importPdf(name, pages);
      if (staged.outcome !== 'awaiting_confirmation') throw new Error(`${name} was refused`);
      const { total, accepted, skipped, problems } = staged.summary;
      return { total, accepted, skipped, problems };
    };
    const plain = await counts('Revolut Fee Counts Plain', plainStatement('counts plain'));
    expect(plain).toEqual({ total: 1, accepted: 1, skipped: 0, problems: [] });
    expect(
      await counts(
        'Revolut Fee Counts',
        feeStatement('counts', eur(FEE), ...rateLine(656)),
      ),
    ).toEqual(plain);
  });

  it('a fee line reaches no description, and the kept lines still do', async () => {
    const KEPT = 'Получатель: Wizz Airline, Budapest';
    const r = await importAndConfirm({
      accountId: await accountFor('Revolut Fee Description'),
      bytes: buildPdf(
        feeStatement('fee description', eur(FEE), { x: X.description, y: 656, text: KEPT, size: 4 }),
      ),
    });
    const [t] = await listTransactions({ accountId: r.accountId });
    expect(t.description).toBe(`Wizz Air ${KEPT}`);
    expect(t.description).not.toContain(label());
    expect(t.fee).toBe(0.44);
  });

  it('the fee arm takes the line even from a keep list that names the label', async () => {
    const revolut = TEMPLATES.find((t) => t.id === 'revolut-ru')!;
    const contradictory: PdfTemplate = {
      ...revolut,
      id: 'fee-label-kept',
      rows: {
        kind: 'labelled-continuations',
        keep: [label()],
        accountNumbers: { kind: 'not-printed' },
      },
    };
    const st = await readPdf(
      buildPdf([
        [
          ISSUER,
          ...header(700),
          ...row(680, '20 июл. 2026г.', 'Wizz Air', { debit: eur(GROSS) }),
          { x: X.description, y: 668, text: `${label()} ${eur(FEE)}` },
          ...box(620, eur(OPENING), eur(GROSS), eur(0), eur(OPENING - GROSS)),
        ],
      ]),
      LIMITS,
      [contradictory],
    );
    const [, amount, description, currency, fee] = st.sheet.rows[1];
    expect({ amount, description, currency, fee }).toEqual({
      amount: -63.62,
      description: 'Wizz Air',
      currency: 'EUR',
      fee: 0.44,
    });
  });

  it('two fee lines under one transaction refuse the file', async () => {
    const before = await idsNow();
    await expect(
      importPdf(
        'Revolut Two Fees',
        feeStatement('two fees', eur(FEE), ...feeLine(656, eur(FEE), eur(MERCHANT))),
      ),
    ).rejects.toThrow(
      `this Revolut statement prints more than one "${label()}" line under one transaction,` +
        ' where this template reads one fee per transaction - export the same statement as CSV' +
        ' or Excel (.xlsx) from your online banking and upload that',
    );

    const failed = await lastFailure(before);
    expect(failed.status).toBe('failed');
    expect(failed.documentAvailable).toBe(true);
    expect(failed.errorDetail!.length).toBeLessThanOrEqual(ERROR_DETAIL_MAX);
  });

  it('a fee line whose value this template cannot read refuses the file', async () => {
    const before = await idsNow();
    await expect(
      importPdf('Revolut Fee Unreadable', feeStatement('fee unreadable', '0,44 EUR')),
    ).rejects.toThrow(
      `this Revolut statement's "${label()}" line reads "0,44 EUR" after its label, where this` +
        ' template reads an amount like "1 234,56€" - export the same statement as CSV or Excel' +
        ' (.xlsx) from your online banking and upload that',
    );

    const failed = await lastFailure(before);
    expect(failed.status).toBe('failed');
    expect(failed.errorDetail!.length).toBeLessThanOrEqual(ERROR_DETAIL_MAX);
  });

  it('a fee line with no transaction open above it is dropped in silence', async () => {
    const r = await importAndConfirm({
      accountId: await accountFor('Revolut Orphan Fee'),
      bytes: buildPdf([
        [
          ISSUER,
          { x: 39.7, y: 15, text: 'orphan fee' },
          ...header(700),
          ...feeLine(690, eur(FEE), eur(MERCHANT)),
          ...row(680, '20 июл. 2026г.', 'Wizz Air', { debit: eur(GROSS) }),
          ...box(620, eur(OPENING), eur(GROSS), eur(0), eur(OPENING - GROSS)),
        ],
      ]),
    });
    expect(r.inserted).toBe(1);
    const [t] = await listTransactions({ accountId: r.accountId });
    expect(t.description).toBe('Wizz Air');
    expect(t.fee).toBeUndefined();
  });

  it('a fee line in the pending block does not reach the last settled row', async () => {
    const r = await importAndConfirm({
      accountId: await accountFor('Revolut Pending Fee'),
      bytes: buildPdf([
        [
          ISSUER,
          { x: 39.7, y: 15, text: 'pending fee' },
          ...header(700),
          ...row(680, '20 июл. 2026г.', 'Wizz Air', { debit: eur(GROSS) }),
          ...header(660, 'Дата начала'),
          ...feeLine(648, eur(FEE), eur(MERCHANT)),
          ...box(620, eur(OPENING), eur(GROSS), eur(0), eur(OPENING - GROSS)),
        ],
      ]),
    });
    expect(r.inserted).toBe(1);
    const [t] = await listTransactions({ accountId: r.accountId });
    expect(t.description).toBe('Wizz Air');
    expect(t.fee).toBeUndefined();
  });

  it('a template that declares no fee line reads one as ordinary text', async () => {
    const pages = n26Statement('no fee arm');
    pages[1].push(...n26Detail(651.7, `${label()} 0,44€`));
    const bytes = buildPdf(pages);

    expect((await readPdf(bytes, LIMITS)).fee).toEqual({ kind: 'none' });
    const r = await importAndConfirm({ accountId: await accountFor('N26 Fee Text'), bytes });
    const netto = (await listTransactions({ accountId: r.accountId, limit: 50 })).find((t) =>
      t.description.startsWith('Netto GmbH'),
    )!;
    expect(netto.description).toContain(`${label()} 0,44€`);
    expect(netto.fee).toBeUndefined();
  });

  it('a fee stated in another currency than the row is dropped, not stored', async () => {
    const revolut = TEMPLATES.find((t) => t.id === 'revolut-ru')!;
    const twoSymbols: PdfTemplate = {
      ...revolut,
      id: 'two-symbol-fees',
      amount: {
        ...revolut.amount,
        currency: { kind: 'in-the-cell', symbols: { '€': 'EUR', '£': 'GBP' } },
      },
    };
    const feeOf = async (states: string): Promise<Cell> => {
      const st = await readPdf(buildPdf(feeStatement(states, states)), LIMITS, [twoSymbols]);
      if (st.fee.kind !== 'included') throw new Error('the template states no fee column');
      return st.sheet.rows[1][st.fee.col];
    };
    expect(await feeOf(eur(FEE))).toBe(0.44);
    expect(await feeOf('0,44£')).toBeNull();
  });

  it('a fee this template reads as negative is dropped, and the row keeps its amount', async () => {
    const revolut = TEMPLATES.find((t) => t.id === 'revolut-ru')!;
    const signedAmounts: PdfTemplate = {
      ...revolut,
      id: 'signed-fees',
      amount: { ...revolut.amount, pattern: /^(-?\d{1,3}(?: \d{3})*,\d{2})([^\s\d]+)$/u },
    };
    const rowOf = async (states: string): Promise<{ amount: Cell; fee: Cell }> => {
      const st = await readPdf(buildPdf(feeStatement(states, states)), LIMITS, [signedAmounts]);
      if (st.fee.kind !== 'included') throw new Error('the template states no fee column');
      const row = st.sheet.rows[1];
      const [, amount] = row;
      return { amount, fee: row[st.fee.col] };
    };
    expect(await rowOf(eur(FEE))).toEqual({ amount: -63.62, fee: 0.44 });
    expect(await rowOf(`-${eur(FEE)}`)).toEqual({ amount: -63.62, fee: null });
  });
});

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
    expect(failed.documentAvailable).toBe(true);
    expect(failed.errorDetail!.length).toBeLessThanOrEqual(ERROR_DETAIL_MAX);
  });

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
          ...box(560, '100,00€', '5,68€', '0,00€', '90,00€'),
        ],
      ]),
    ).rejects.toThrow(
      'its opening balance of 100.00 EUR plus the 1 transaction line read comes to 94.32 EUR, ' +
        "where the statement's own closing balance is 90.00 EUR - a difference of 4.32 EUR, " +
        'and the 4 transaction lines this importer could not read are probably where it went',
    );
  });

  it('does not run again at confirm, where fewer rows are inserted than staged', async () => {
    const name = 'Revolut Overlapping Months';
    const first = await importAndConfirm({
      accountId: await accountFor(name),
      bytes: buildPdf(statement('overlap first')),
    });
    expect(first.inserted).toBe(3);

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
    if (!confirmed || !confirmed.confirmed) {
      throw new Error(`confirming ${staged.summary.importId} failed: ${JSON.stringify(confirmed)}`);
    }
    expect(confirmed.inserted).toBe(1);
  });

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
      'an outgoing total that is not there',
      box(640, '1 200,00€', '', '0,00€', '94,32€'),
      /this Revolut statement's outgoing total cell reads "" on its "Итого" line, where this template reads an amount like "1 234,56€"/,
    ],
    [
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
      fee: { kind: 'none' },
      mcc: { kind: 'none' },
      balances: {
        openingCents: 0,
        closingCents: 3000,
        gross: { kind: 'printed', outgoingCents: 0, incomingCents: 3000 },
        currency,
      },
    });

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

const N = {
  heading: 44.5,
  description: 43.8,
  dateHeading: 341.7,
  date: 390.9,
  amountHeading: 515.1,
  amountWide: 499.5,
  amountNarrow: 515.8,
} as const;

const n26Header = (y: number): PlacedText[] => [
  { x: N.heading, y, text: 'Beschreibung' },
  { x: N.dateHeading, y, text: 'Verbuchungsdatum' },
  { x: N.amountHeading, y, text: 'Betrag' },
];

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
 * A line under a transaction: the description column, both other cells empty. `size` is
 * a fixture artefact for the reason FOOTER_SIZE states - at the default this font would
 * spill the line's last word past the description column's right edge and into the date
 * column, which no real statement's does.
 */
const n26Detail = (y: number, text: string, size?: number): PlacedText[] => [
  { x: N.description, y, text, size },
];

const n26Balance = (y: number, label: string, value: string): PlacedText[] => [
  { x: N.description, y, text: label },
  { x: 491.2, y, text: value },
];

const n26Footer = (): PlacedText[] => [
  { x: 42.75, y: 69.26, text: 'KONTOINHABER' },
  { x: 505.24, y: 69.26, text: 'Erstellt am' },
  { x: 42.75, y: 37.54, text: 'BIC: NTSBDEB1XXX' },
  { x: 497.48, y: 37.54, text: 'Nr. 07/2026' },
];

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
    { x: N.heading, y: 704.4, text: 'Beschreibung' },
    ...n26Balance(676.31, 'Dein alter Kontostand', '+2.415,77€'),
    ...n26Balance(650.14, 'Ausgehende Transaktionen', '-1.145,47€'),
    ...n26Balance(623.96, 'Einkommende Transaktionen', '+0,13€'),
    ...n26Balance(597.22, 'Dein neuer Kontostand', closing),
    ...n26Footer(),
    { x: N.description, y: 15, text: tag },
  ],
];

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
  dates: { format: 'de-numeric' },
  amount: {
    pattern: /^([+-]\d+,\d{2})([^\s\d]+)$/u,
    decimal: ',',
    currency: { kind: 'in-the-cell', symbols: { '€': 'EUR' } },
    example: '-1,00€',
  },
  rows: { kind: 'one-line' },
  fee: { kind: 'none' },
  mcc: { kind: 'none' },
  balances: {
    scope: { kind: 'whole-document' },
    kind: 'two-lines',
    label: [0, 330],
    value: [460, 596],
    opening: 'Anfang',
    closing: 'Ende',
    gross: { kind: 'printed', signs: 'signed', outgoing: 'Raus', incoming: 'Rein' },
  },
});

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
      totals: [{ currency: 'EUR', net: -1145.34 }],
      balances: { opening: 2415.77, closing: 1270.43, currency: 'EUR' },
    });
  });

  it('a transaction is its dated line and the lines under it', async () => {
    const r = await importAndConfirm({
      accountId: await accountFor('N26 Descriptions'),
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
    for (const description of rows) expect(description).not.toMatch(/IBAN|BIC/);
    for (const description of rows) expect(description).not.toMatch(/Kontoauszug|bis 31/);
  });

  it('a near miss of the identifier the template names is dropped too', async () => {
    const n26 = TEMPLATES.find((t) => t.id === 'n26-de')!;
    const drop = n26.rows.kind === 'continuations' ? n26.rows.drop : [];
    expect(drop.length).toBeGreaterThan(0);
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
      accountId: await accountFor('N26 Near Miss'),
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

  it('a dated line under the summary table is not a transaction', async () => {
    const pages = n26Statement('summary collect');
    pages[2].push(...n26Row(560, '31.07.2026', 'Zinsabschluss', '-0,01€'));
    const staged = await importPdf('N26 Summary Table', pages);
    if (staged.outcome !== 'awaiting_confirmation') throw new Error('not staged');
    expect(staged.summary).toMatchObject({ total: 3, accepted: 3, skipped: 0 });
  });

  it('an empty amount cell names the one column this layout has', async () => {
    const pages = n26Statement('empty betrag');
    pages[0].push(...n26Row(480, '03.07.2026', 'Ohne Betrag', ''));
    const staged = await importPdf('N26 Empty Amount', pages);
    if (staged.outcome !== 'awaiting_confirmation') throw new Error('not staged');

    expect(staged.summary).toMatchObject({ total: 4, accepted: 3, skipped: 1 });
    expect(staged.summary.problems).toEqual([
      'row 3: the amount cell is empty in the "Betrag" column',
    ]);
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

  it('a transaction described like a balance label refuses rather than being read as one', async () => {
    const pages = n26Statement('label collision');
    pages[0].push(...n26Row(480, '03.07.2026', 'Dein alter Kontostand', '-1,00€'));
    await expect(importPdf('N26 Label Collision', pages)).rejects.toThrow(
      /it expects exactly one "Dein alter Kontostand" line and found 2/,
    );
  });

  it('a balance cell this template cannot read is refused with the cell quoted back', async () => {
    const pages = n26Statement('unsigned balance').map((page) =>
      page.map((t) => (t.text === '+2.415,77€' ? { ...t, text: '2.415,77€' } : t)),
    );
    await expect(importPdf('N26 Unsigned Balance', pages)).rejects.toThrow(
      /this N26 statement's opening balance cell reads "2\.415,77€" on its "Dein alter Kontostand" line, where this template reads an amount like "-1\.234,56€"/,
    );
  });

  it('two templates claiming one document is a refusal, not the first in the array', () => {
    expect(() => selectTemplate([twin('a', 'Layout A'), twin('b', 'Layout B')], twinLines)).toThrow(
      'this statement matches more than one of the layouts this importer knows ("Layout A" and "Layout B")',
    );
    expect(selectTemplate([twin('a', 'Layout A')], twinLines)?.id).toBe('a');
    expect(selectTemplate([twin('b', 'Layout B')], twinLines)?.id).toBe('b');
  });

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
    await expect(
      readPdf(twinDoc('+10,00€', '+9,00£', '-1,00€', '+0,00€'), LIMITS, [twoSymbols]),
    ).rejects.toThrow(
      'this Two Symbols statement\'s opening balance ("Anfang") is stated in' +
        ' EUR and its closing balance ("Ende") in GBP - this importer cannot check a statement' +
        ' that mixes currencies',
    );

    await expect(
      readPdf(twinDoc('+10,00€', '+9,00€', '-1,00£', '+0,00€'), LIMITS, [twoSymbols]),
    ).rejects.toThrow(
      'this Two Symbols statement\'s opening balance ("Anfang") is stated in' +
        ' EUR and its outgoing total ("Raus") in GBP',
    );
  });

  it('a two-lines box broken in two places refuses by the balance, not the subtotal', async () => {
    await expect(
      readPdf(twinDoc('+1,00€', '', '', '+0,00€'), LIMITS, [twin('order', 'Two Layouts')]),
    ).rejects.toThrow(
      'this Two Layouts statement\'s closing balance cell reads "" on its "Ende" line',
    );
  });
});

const U = {
  bank: 220.466,
  margin: 28.346,
  description: 99.598,
  descriptionHeading: 103.239,
  mcc: 191.25,
  amountWide: 225.188,
  amount: 229.94,
  amountNarrow: 234.944,
  opAmount: 286.3,
  running: 523.071,
} as const;

const UK = {
  date: 37.018,
  dateHeading: 37.765,
  wrap: 41.041,
  time: 42.022,
  tail: 104.751,
  mccHeading: 191.012,
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
  amountHeading: 228.307,
  pitch: 9.6,
  opening: 197.5,
  closing: 170.554,
  grossOut: 183.046,
  grossIn: 176.539,
} as const;

/**
 * What the DATE heading may spend, and it is the tightest budget in this file. The real
 * document draws its date heading as ONE text item inside a column that has to stop short
 * of that same heading's second baseline. This fixture's font advances far more per
 * character and pdfjs splits a placed run at every space, so at any larger size the
 * heading comes back as several items, the date cell reads only the first word, the header
 * line matches no table, and the whole document is refused. No other heading needs it.
 */
const UA_HEADING_SIZE = 0.4;

/**
 * And what every other cell of this layout may spend. It buys two different things,
 * because this fixture's font is far wider than the generator's and that goes wrong in
 * two directions.
 *
 * A cell that carries a SPACE is split by pdfjs at every space and each fragment is
 * assigned to a column by its own left edge - so a label has to END inside its column,
 * not merely start there. The longest of the balance labels is what sets this, and the
 * English ones need a smaller size than the Ukrainian.
 *
 * A cell with a WIDE NEIGHBOUR fails the other way, and the MCC cell is the one that
 * does: at the default size it runs into the amount column, pdfjs joins it to the amount
 * beside it into a single item at the MCC's own x, the amount cell reads empty, the row is
 * skipped, and the statement fails the gate by exactly that row.
 *
 * Two cells need none of this, and saying which is what stops the next reader dropping
 * the size everywhere and losing the reason: an amount fragments to two runs that both
 * stay inside the amount span at the default size, and so does a box value.
 */
const UA_SIZE = 2;

/**
 * The codes the two locale fixtures print, and every one of them is chosen against what
 * its row's DESCRIPTION answers on its own:
 *
 * - `coffee` and `topUp` answer where the description answers `other`, so they are the
 *   row's whole categorisation;
 * - `ukPharmacy` DISAGREES with its description - "Аптека" reads health by keyword and
 *   5411 reads food - which is the one shape that can tell "the MCC was consulted" from
 *   "the description happened to agree";
 * - `enPharmacy` agrees with its description, and is the control for that;
 * - `enCoffee` and `enPharmacy` differ from the Ukrainian file's codes on the same two
 *   rows, so a reader answering out of the fixture's own head rather than the document
 *   cannot pass both locales.
 */
const UA_MCC = {
  coffee: '5812',
  topUp: '6536',
  ukPharmacy: '5411',
  enCoffee: '5814',
  enPharmacy: '5912',
} as const;

const ukHeading = (y: number): PlacedText[] => [
  { x: UK.dateHeading, y, text: 'Дата i час', size: UA_HEADING_SIZE },
  { x: U.descriptionHeading, y, text: 'Деталі операції' },
  { x: UK.mccHeading, y, text: 'MCC' },
  { x: 229.724, y: y + 5.669, text: 'Сума в', size: UA_SIZE },
  { x: 229.949, y: y - 5.131, text: 'валюті' },
  { x: UK.wrap, y: y - UK.pitch, text: 'операції' },
  { x: 230.543, y: y - 15.931, text: 'картки' },
  { x: 232.451, y: y - 26.731, text: '(UAH)' },
];

/**
 * The English file's heading block, and the one genuinely marginal thing in it: the
 * header line is three baselines further apart than TOLERANCE, merged into one line only
 * because readLines seeds a line at the first item's y and never re-centres it. So the
 * middle baseline has to be emitted first - which is what the real generator does - and
 * reordering the header items below the other two splits this header into three lines
 * that match no table. That merge is what gives this locale's header its fourth cell.
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
 * `mcc` is REQUIRED and its "none" is null, so every call site states a code on purpose -
 * this used to hard-code '4789' on every row, and a reader answering 4789 for everything
 * passed. No two rows of one locale share a code, and two rows differ between the locales:
 * a reader off by a line reddens on the first, one that ignores the document on the second.
 */
const uaRow = (
  L: typeof UK | typeof EN,
  y: number,
  date: string,
  time: string,
  description: string,
  amount: string,
  mcc: string | null,
  x: number = U.amount,
  tail?: string,
): PlacedText[] => [
  { x: L.date, y, text: date },
  { x: U.description, y, text: description, size: UA_SIZE },
  ...(mcc === null ? [] : [{ x: U.mcc, y, text: mcc, size: UA_SIZE }]),
  { x, y, text: amount },
  { x: U.opAmount, y, text: '-1.00' },
  { x: U.running, y, text: '0.00' },
  { x: L.time, y: y - L.pitch, text: time },
  ...(tail ? [{ x: L.tail, y: y - L.pitch, text: tail, size: UA_SIZE }] : []),
];

const uaBalance = (y: number, label: string, x: number, value: string): PlacedText[] => [
  { x: U.margin, y, text: label, size: UA_SIZE },
  { x, y, text: value, size: UA_SIZE },
];

const ukFooter = (): PlacedText[] => [
  { x: 65.941, y: 516.867, text: 'Операційний директор', size: UA_SIZE },
  { x: U.margin, y: 421.887, text: 'Документ', size: UA_SIZE },
  { x: 47.795, y: 412.287, text: 'перевірки', size: UA_SIZE },
  { x: 88.94, y: 412.287, text: 'підпису', size: UA_SIZE },
  { x: 219.472, y: 412.287, text: 'можете', size: UA_SIZE },
  { x: 106.433, y: 26.501, text: 'Вклади гарантуються відповідно до Закону', size: UA_SIZE },
  { x: 103.661, y: 16.901, text: 'Детальна інформація - у Довідці', size: UA_SIZE },
];

const enFooter = (): PlacedText[] => [
  { x: 76.642, y: 703.767, text: 'Operating Director', size: UA_SIZE },
  { x: U.margin, y: 608.787, text: 'The', size: UA_SIZE },
  { x: 94.997, y: 26.501, text: 'Deposits are guaranteed subject to the Law', size: UA_SIZE },
  { x: 128.409, y: 16.901, text: 'Details in the Reference to guarantee', size: UA_SIZE },
];

const ukStatement = (tag: string, closing = '1 624.25 UAH'): PlacedText[][] => [
  [
    { x: U.bank, y: 815.269, text: 'АТ «УНІВЕРСАЛ БАНК»' },
    { x: U.margin, y: 752.778, text: 'Рух коштів по картці від 01.08.2026р.' },
    ...uaBalance(507.422, 'Баланс на початок періоду:', UK.opening, '1 000.00 UAH'),
    ...uaBalance(493.922, 'Баланс на кінець періоду:', UK.closing, closing),
    ...uaBalance(466.249, 'Сума витрат за період:', UK.grossOut, '575.75 UAH'),
    ...uaBalance(452.749, 'Сума зарахувань за період:', UK.grossIn, '1 200.00 UAH'),
    ...ukHeading(412.112),
    ...uaRow(UK, 368.631, '28.07.2026', '02:16:38', 'Кавʼярня', '-500.25', UA_MCC.coffee, U.amount, 'на Хрещатику'),
    ...uaRow(UK, 341.081, '27.07.2026', '15:50:41', 'Зарахування', '1 200.00', UA_MCC.topUp, U.amountWide),
    { x: U.running, y: 15, text: tag, size: UA_SIZE },
  ],
  [
    ...ukHeading(808.506),
    ...uaRow(UK, 765.025, '26.07.2026', '13:19:38', 'Аптека', '-75.50', UA_MCC.ukPharmacy, U.amountNarrow),
    ...ukFooter(),
  ],
];

const enStatement = (tag: string, closing = '1 624.25 UAH'): PlacedText[][] => [
  [
    { x: U.bank, y: 815.269, text: 'UNIVERSAL BANK JSC' },
    { x: U.margin, y: 744.378, text: 'Cash flow on the card from 01.08.2026.' },
    ...uaBalance(499.022, 'Balance at the beginning of the period:', EN.opening, '1 000.00 UAH'),
    ...uaBalance(485.522, 'Balance at the end of the period:', EN.closing, closing),
    ...uaBalance(457.849, 'Amount of expenses for the period:', EN.grossOut, '575.75 UAH'),
    ...uaBalance(444.349, 'Amount of charges for the period:', EN.grossIn, '1 200.00 UAH'),
    ...enHeading(401.737),
    ...uaRow(EN, 368.631, '28.07.2026', '02:16:38', 'Coffee', '-500.25', UA_MCC.enCoffee, U.amount, 'on Khreshchatyk'),
    ...uaRow(EN, 341.081, '27.07.2026', '15:50:41', 'Transfer', '1 200.00', UA_MCC.topUp, U.amountWide),
    { x: U.running, y: 15, text: tag, size: UA_SIZE },
  ],
  [
    ...enHeading(806.531),
    ...uaRow(EN, 765.025, '26.07.2026', '13:19:38', 'Pharmacy', '-75.50', UA_MCC.enPharmacy, U.amountNarrow),
    ...enFooter(),
  ],
];

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
    const st = await readPdf(buildPdf(enStatement('en happy path')), LIMITS);
    expect(st.template).toBe('universalbank-en');
    expect(st.title).toBe('UNIVERSAL BANK JSC');
    expect(st.balances).toEqual({
      openingCents: 100000,
      closingCents: 162425,
      gross: { kind: 'printed', outgoingCents: -57575, incomingCents: 120000 },
      currency: 'UAH',
    });
    expect(st.sheet.rows.slice(1).map((r) => [r[1], r[3]])).toEqual([
      [-500.25, 'UAH'],
      [1200, 'UAH'],
      [-75.5, 'UAH'],
    ]);

    const en = TEMPLATES.find((t) => t.id === 'universalbank-en')!;
    const drop = en.rows.kind === 'continuations' ? en.rows.drop : [];
    expect(drop).toHaveLength(3);
    const descriptions = st.sheet.rows.slice(1).map((r) => String(r[2]));
    expect(descriptions).toEqual(['Coffee on Khreshchatyk', 'Transfer', 'Pharmacy']);
    for (const description of descriptions) {
      for (const label of drop) expect(description).not.toContain(label);
    }
  });

  it('each locale is claimed by its own template and by no other', () => {
    expect(selectTemplate(TEMPLATES, ukLines)?.id).toBe('universalbank-uk');
    expect(selectTemplate(TEMPLATES, enLines)?.id).toBe('universalbank-en');
    for (const lines of [ukLines, enLines]) {
      expect(TEMPLATES.filter((t) => selectTemplate([t], lines) !== undefined)).toHaveLength(1);
    }
  });

  /**
   * The transaction table's own windows, and deliberately NOT the balance box's.
   *
   * The box is a row of a different table: revolut-ru's `balances.opening` [250, 330)
   * sits INSIDE its own description window [120, 330) and its `closing` [500, 596) past
   * its last column, which the `revolut-ru` template says in its own words beside its
   * `gross` spans. Folding them in would redden this guard on the day it was written,
   * about a layout nobody has measured wrong.
   */
  const transactionWindows = (
    t: PdfTemplate,
  ): { name: string; span: readonly [number, number] }[] => {
    const columns = Object.entries(t.columns).map(([name, span]) => ({ name, span }));
    return t.mcc.kind === 'column' ? [...columns, { name: 'mcc', span: t.mcc.span }] : columns;
  };

  /**
   * The only holder of this that a template added tomorrow inherits. An overlapping
   * description/MCC pair would put a bank's own identifier into the column the categoriser,
   * the transfer detector and the export all read - the account-number defect, arriving
   * from a data literal instead of from a drop list.
   *
   * The three counts under it are the non-vacuity literals, canvasabsent's idiom: a
   * refactor that empties the iteration reddens them rather than passing over nothing.
   */
  it('every column window a template declares is disjoint from every other of its own', () => {
    const overlaps: string[] = [];
    let examined = 0;
    let declaringMcc = 0;
    for (const t of TEMPLATES) {
      const windows = transactionWindows(t);
      examined += windows.length;
      if (t.mcc.kind === 'column') declaringMcc++;
      for (let i = 0; i < windows.length; i++) {
        for (let j = i + 1; j < windows.length; j++) {
          const [a, b] = [windows[i], windows[j]];
          if (a.span[0] < b.span[1] && b.span[0] < a.span[1]) {
            overlaps.push(
              `${t.id}: ${a.name} [${a.span}) overlaps ${b.name} [${b.span})`,
            );
          }
        }
      }
    }
    expect(overlaps).toEqual([]);
    expect(TEMPLATES).toHaveLength(5);
    expect(examined).toBe(18);
    expect(declaringMcc).toBe(2);
  });

  /**
   * The stance's other half. tsc holds that every continuation template states one;
   * what it cannot see is the stance agreeing with the list `wanted` actually reads,
   * because that is two fields of one literal. Where a clause claims coverage - every
   * line under a declared label decided by the list - the match is `wanted`'s own and
   * runs one way: a list entry that is a prefix of the declared label, or the label
   * itself. Matched in either direction, an entry that merely extends the label is
   * green here while `wanted` decides only the lines that start with the longer entry.
   * Where a clause claims the lists do not meet, any overlap in either direction is the
   * contradiction: matched by equality, a `keep` naming a prefix of a dropped label is
   * green here and appends the line there; matched one way, the clause passes a `keep`
   * extending a dropped label, which admits a subset of the lines the stance declares
   * dropped. The last clause is cross-template, for the way templates are written here
   * - by cloning - so a `drop: ['IBAN:']` copied under a `not-printed` stance is a
   * contradiction the per-template clauses cannot see; its label set is a literal rather
   * than the union of the stances, or the one template declaring a label could drop the
   * declaration and take the label out of the set with it.
   *
   * The counts under it are the non-vacuity literals, as above.
   */
  it('every template states which continuation labels carry an account number, and the stance agrees with what it keeps and drops', () => {
    const IDENTIFIER_LABELS = ['Получатель:', 'Отправитель:', 'Карта:', 'IBAN:'] as const;
    const names = (list: readonly string[], label: string): boolean =>
      list.some((l) => l.startsWith(label) || label.startsWith(l));
    const decides = (list: readonly string[], label: string): boolean =>
      list.some((l) => label.startsWith(l));

    const continuations = TEMPLATES.flatMap((t) =>
      t.rows.kind === 'one-line' ? [] : [{ id: t.id, rows: t.rows }],
    );
    const declared = new Set(
      continuations.flatMap(({ rows: { accountNumbers } }) =>
        accountNumbers.kind === 'printed'
          ? [...accountNumbers.kept, ...accountNumbers.dropped]
          : [],
      ),
    );

    const problems: string[] = [];
    const stances = { printed: 0, notPrinted: 0 };
    for (const { id, rows } of continuations) {
      const stance = rows.accountNumbers;
      if (stance.kind === 'not-printed') {
        stances.notPrinted++;
      } else {
        stances.printed++;
        if (stance.kept.length === 0 && stance.dropped.length === 0) {
          problems.push(`${id}: printed, and names no line`);
        }
        for (const label of stance.kept) {
          if (names(stance.dropped, label)) problems.push(`${id}: "${label}" is both kept and dropped`);
        }
      }
      const kept = stance.kind === 'printed' ? stance.kept : [];
      const dropped = stance.kind === 'printed' ? stance.dropped : [];
      switch (rows.kind) {
        case 'continuations':
          for (const label of dropped) {
            if (!decides(rows.drop, label)) problems.push(`${id}: "${label}" is dropped by the stance and not by drop`);
          }
          for (const label of kept) {
            if (names(rows.drop, label)) problems.push(`${id}: "${label}" is kept by the stance and dropped by drop`);
          }
          for (const label of rows.drop) {
            if (names(IDENTIFIER_LABELS, label) && !names(dropped, label)) {
              problems.push(`${id}: drop names "${label}", an identifier label, and the stance does not`);
            }
          }
          break;
        case 'labelled-continuations':
          for (const label of kept) {
            if (!decides(rows.keep, label)) problems.push(`${id}: "${label}" is kept by the stance and not by keep`);
          }
          for (const label of dropped) {
            if (names(rows.keep, label)) problems.push(`${id}: "${label}" is dropped by the stance and kept by keep`);
          }
          for (const label of rows.keep) {
            if (names(IDENTIFIER_LABELS, label) && !names(kept, label)) {
              problems.push(`${id}: keep names "${label}", an identifier label, and the stance does not`);
            }
          }
          break;
      }
    }
    expect(problems).toEqual([]);
    expect(TEMPLATES).toHaveLength(5);
    expect(stances).toEqual({ printed: 2, notPrinted: 3 });
    expect([...declared].sort()).toEqual([...IDENTIFIER_LABELS].sort());
  });

  it('imports one inside a signed container, end to end', async () => {
    const imported = await importAndConfirm({
      accountId: await accountFor('Universal Wrapped', 'UAH'),
      bytes: buildSignedContainer(buildPdf(ukStatement('wrapped'))),
    });
    expect(imported.inserted).toBe(3);
    const record = (await listImports()).imports.find((i) => i.id === imported.importId)!;
    expect(record.sourceType).toBe('pdf');
  });

  it('a table this layout does not name refuses the document', async () => {
    const pages = ukStatement('unknown table');
    pages[0].push(
      { x: UK.dateHeading, y: 300, text: 'Дата', size: UA_HEADING_SIZE },
      { x: U.descriptionHeading, y: 300, text: 'Деталі операції' },
    );
    await expect(importPdf('Universal New Table', pages, undefined, 'UAH')).rejects.toThrow(
      /this АТ «УНІВЕРСАЛ БАНК» statement has a table this importer cannot read \("Дата"\)/,
    );
  });

/**
 * The continuation rule in BOTH directions, which is what taking the permissive arm owes.
 *
 * The tail is the control, and it is not decorative: it is placed the same way as the
 * footer lines and it IS appended, so a footer line that is absent is absent because the
 * template dropped it and not because the line was never a candidate. Every case in this
 * file that asserts an absence carries one.
 */
  it('keeps an unlabelled wrapped tail and drops the footer the template names', async () => {
    const uk = TEMPLATES.find((t) => t.id === 'universalbank-uk')!;
    const drop = uk.rows.kind === 'continuations' ? uk.rows.drop : [];
    expect(drop).toHaveLength(3);

    const r = await importAndConfirm({
      accountId: await accountFor('Universal Continuations', 'UAH'),
      bytes: buildPdf(ukStatement('continuations')),
    });
    const rows = (await listTransactions({ accountId: r.accountId, limit: 50 })).map(
      (t) => t.description,
    );
    expect(rows.sort()).toEqual(['Аптека', 'Зарахування', 'Кавʼярня на Хрещатику']);
    for (const description of rows) {
      for (const label of drop) expect(description).not.toContain(label);
      expect(description).not.toContain('підпису');
    }
  });

  it('a balance cell in another currency is refused rather than read as the column one', async () => {
    const pages = ukStatement('foreign balance').map((page) =>
      page.map((t) => (t.text === '1 000.00 UAH' ? { ...t, text: '1 000.00 USD' } : t)),
    );
    await expect(importPdf('Universal Foreign Balance', pages, undefined, 'UAH')).rejects.toThrow(
      /this АТ «УНІВЕРСАЛ БАНК» statement's opening balance cell reads "1 000.00 USD" on its "Баланс на початок періоду:" line/,
    );
  });

  /**
   * Imported and confirmed, then read back off the transactions table - not off the sheet.
   * The MCC crosses parse, stage and confirm to reach a column, and a case reading the
   * sheet would be green with any one of those three severed.
   *
   * Newest first, which is the order listTransactions answers in: 28.07, 27.07, 26.07.
   */
  const uaImported = async (
    name: string,
    pages: PlacedText[][],
  ): Promise<{ description: string; mcc: number | undefined; category: string }[]> => {
    const r = await importAndConfirm({
      accountId: await accountFor(name, 'UAH'),
      bytes: buildPdf(pages),
    });
    expect(r.inserted).toBe(3);
    const rows = await listTransactions({ accountId: r.accountId, limit: 50 });
    return rows.map((t) => ({ description: t.description, mcc: t.mcc, category: t.category }));
  };

  /** Every code item of a fixture, moved or rewritten in place. */
  const withMcc = (
    pages: PlacedText[][],
    change: (t: PlacedText) => PlacedText | null,
  ): PlacedText[][] =>
    pages.map((page) =>
      page.flatMap((t) => {
        if (t.x !== U.mcc) return [t];
        const moved = change(t);
        return moved === null ? [] : [moved];
      }),
    );

  it('each row carries the code its own line prints, in both locales', async () => {
    expect(await uaImported('Universal Mcc Uk', ukStatement('mcc uk'))).toEqual([
      { description: 'Кавʼярня на Хрещатику', mcc: 5812, category: 'food' },
      { description: 'Зарахування', mcc: 6536, category: 'transfers' },
      { description: 'Аптека', mcc: 5411, category: 'food' },
    ]);
    expect(await uaImported('Universal Mcc En', enStatement('mcc en'))).toEqual([
      { description: 'Coffee on Khreshchatyk', mcc: 5814, category: 'food' },
      { description: 'Transfer', mcc: 6536, category: 'transfers' },
      { description: 'Pharmacy', mcc: 5912, category: 'health' },
    ]);
  });

  /**
   * Both halves of the import-time edit, on the one row whose two answers differ: the
   * argument categorize was given, and the column the row is stored with. Severing either
   * one alone reddens exactly one of the two assertions, which is what a check standing in
   * for a structure has to be able to say.
   */
  it('the code decides the category the import stores, and is stored beside it', async () => {
    // the control: this description on its own answers something else, so a green here
    // cannot be the description agreeing by luck
    expect(categorize(undefined, 'Аптека', -75.5)).toBe('health');

    const rows = await uaImported('Universal Mcc Decides', ukStatement('mcc decides'));
    const pharmacy = rows.find((r) => r.description === 'Аптека')!;
    expect(pharmacy.category).toBe('food');
    expect(pharmacy.mcc).toBe(5411);
  });

  it('a four-digit token left of the MCC window is description text and not a code', async () => {
    const pages = withMcc(ukStatement('mcc left of the window'), (t) => ({ ...t, x: 189.5 }));
    const rows = await uaImported('Universal Mcc Left', pages);
    expect(rows.map((r) => r.mcc)).toEqual([undefined, undefined, undefined]);
    // and the control that the tokens were drawn at all: the description column is where
    // a glyph half a unit left of the window belongs, and it says so
    expect(rows.map((r) => r.description)).toEqual([
      `Кавʼярня ${UA_MCC.coffee} на Хрещатику`,
      `Зарахування ${UA_MCC.topUp}`,
      `Аптека ${UA_MCC.ukPharmacy}`,
    ]);
  });

  it("a code at the MCC window's own left edge is a code and not description text", async () => {
    const pages = withMcc(ukStatement('mcc at the edge'), (t) => ({ ...t, x: 190 }));
    const rows = await uaImported('Universal Mcc Edge', pages);
    expect(rows.map((r) => r.mcc)).toEqual([5812, 6536, 5411]);
    expect(rows.map((r) => r.description)).toEqual([
      'Кавʼярня на Хрещатику',
      'Зарахування',
      'Аптека',
    ]);
  });

  it('a row that prints no code imports, states none, and keeps the description’s answer', async () => {
    const pages = withMcc(ukStatement('no mcc drawn'), () => null);
    expect(await uaImported('Universal Mcc Absent', pages)).toEqual([
      { description: 'Кавʼярня на Хрещатику', mcc: undefined, category: 'other' },
      { description: 'Зарахування', mcc: undefined, category: 'other' },
      { description: 'Аптека', mcc: undefined, category: 'health' },
    ]);
  });

  it('a cell that is not four digits states no code, and the row still imports', async () => {
    const pages = withMcc(ukStatement('short mcc'), (t) => ({ ...t, text: t.text.slice(0, 3) }));
    const rows = await uaImported('Universal Mcc Short', pages);
    // undefined and never 581: a reader doing Number(text) with no shape test stores the
    // truncation as a code, and no gate anywhere can see that it is not one
    expect(rows.map((r) => r.mcc)).toEqual([undefined, undefined, undefined]);
    expect(rows.map((r) => r.category)).toEqual(['other', 'other', 'health']);
  });

  it('a cell reading 0000 states no code, and the row keeps the description’s answer', async () => {
    const pages = withMcc(ukStatement('zero mcc'), (t) => ({ ...t, text: '0000' }));
    const rows = await uaImported('Universal Mcc Zero', pages);
    // undefined and never 0: 0 is a code no network assigned, and a reader storing it
    // costs a fact column its meaning where nothing downstream can see the loss - the
    // categories below are the descriptions' own answers either way, because categorize
    // skips a falsy code
    expect(rows.map((r) => r.mcc)).toEqual([undefined, undefined, undefined]);
    expect(rows.map((r) => r.category)).toEqual(['other', 'other', 'health']);
  });

  it('a template declaring no MCC column reads none out of a document that prints one', async () => {
    const uk = TEMPLATES.find((t) => t.id === 'universalbank-uk')!;
    const bytes = buildPdf(ukStatement('template declares none'));
    const declared = await readPdf(bytes, LIMITS, [uk]);
    const none = await readPdf(bytes, LIMITS, [{ ...uk, mcc: { kind: 'none' } }]);

    const col = declared.sheet.rows[0].indexOf('pdf:mcc');
    expect(col).toBeGreaterThanOrEqual(0);
    expect(declared.mcc).toEqual({ kind: 'column', col });
    expect(declared.sheet.rows.slice(1).map((r) => r[col])).toEqual([
      UA_MCC.coffee,
      UA_MCC.topUp,
      UA_MCC.ukPharmacy,
    ]);

    expect(none.mcc).toEqual({ kind: 'none' });
    expect(none.sheet.rows.slice(1).map((r) => r[col])).toEqual([null, null, null]);
  });
});

const C = {
  margin: 45.354,
  section: 54.354,
  kontostand: 427.132,
  buchung: 48.354,
  valuta: 99.378,
  description: 150.402,
  amountHeading: 519.28,
  debit: 518.774,
  sign: 516.024,
  digits: 521.67,
  wide: 500.893,
  boxLabel: 45.354,
  boxValue: 519.524,
  boxValueWide: 516.628,
  interestLabel: 53.354,
  rate: 204.3,
  range: 332.889,
  interest: 516.67,
  footerName: 273.765,
  footerAddress: 233.88,
  footerPage: 500.003,
  footerVat: 271.094,
} as const;

/**
 * What every cell of this layout may spend. Two cells decide it, in opposite directions,
 * and both were built through buildPdf and read back rather than reasoned about.
 *
 * A credit's sign is drawn as a run of its own just left of its digits: too large and the
 * sign advances past the digits and pdfjs hands back two items in the wrong order; a size
 * or two smaller and the two MERGE into one item at the sign's x, so the cell reads a
 * number with no currency after it.
 *
 * The longest description fails the other way - at the default size its second fragment
 * lands outside the description column and the line stops being a continuation at all,
 * which is the silent direction: the case would pass having exercised nothing.
 */
const C24_SIZE = 3;

const c24Frame = (): PlacedText[] => [
  { x: C.margin, y: 727.344, text: 'C24 Smartkonto', size: C24_SIZE },
  { x: C.margin, y: 715.069, text: 'Girokonto', size: C24_SIZE },
  { x: C.margin, y: 690.52, text: 'BIC: DEFFDEFFXXX', size: C24_SIZE },
];

const c24Section = (y: number, title: string, period: string): PlacedText[] => [
  { x: C.section, y, text: title, size: C24_SIZE },
  { x: C.section, y: y - 12.274, text: period, size: C24_SIZE },
];

const c24Table = (y: number, valuta = 'Valuta'): PlacedText[] => [
  { x: C.buchung, y, text: 'Buchung', size: C24_SIZE },
  { x: C.valuta, y, text: valuta, size: C24_SIZE },
  { x: C.description, y, text: 'Transaktionsinformation', size: C24_SIZE },
  { x: C.amountHeading, y, text: 'Betrag', size: C24_SIZE },
];

const c24Row = (
  y: number,
  date: string,
  description: string,
  amount: readonly { x: number; text: string }[],
): PlacedText[] => [
  { x: C.buchung, y, text: date, size: C24_SIZE },
  { x: C.valuta, y, text: date, size: C24_SIZE },
  { x: C.description, y, text: description, size: C24_SIZE },
  ...amount.map((a) => ({ x: a.x, y, text: a.text, size: C24_SIZE })),
];

const c24Detail = (y: number, text: string): PlacedText[] => [
  { x: C.description, y, text, size: C24_SIZE },
];

const c24Box = (
  y: number,
  opening: string,
  outgoing: string,
  incoming: string,
  closing: string,
  outgoingX: number = C.boxValue,
): PlacedText[] => [
  { x: C.margin, y: y + 24.817, text: 'Zusammenfassung', size: C24_SIZE },
  ...(
    [
      ['Startsaldo', opening, C.boxValue],
      ['Kontobelastungen', outgoing, outgoingX],
      ['Kontogutschriften', incoming, C.boxValue],
      ['Endsaldo', closing, C.boxValue],
    ] as const
  ).flatMap(([label, value, x], n) => [
    { x: C.boxLabel, y: y - n * 20.425, text: label, size: C24_SIZE },
    { x, y: y - n * 20.425, text: value, size: C24_SIZE },
  ]),
];

const c24Footer = (page: number, of: number, month = '06/2026'): PlacedText[] => [
  { x: C.footerName, y: 23.687, text: 'C24 Bank GmbH', size: C24_SIZE },
  { x: C.margin, y: 16.704, text: month, size: C24_SIZE },
  {
    x: C.footerAddress,
    y: 16.704,
    text: 'Neue Mainzer Straße 14 - 18, 60311 Frankfurt am Main',
    size: C24_SIZE,
  },
  { x: C.footerPage, y: 16.704, text: `Seite ${page} von ${of}`, size: C24_SIZE },
  { x: C.footerVat, y: 11.148, text: 'Ust.-ID DE 322 469 451', size: C24_SIZE },
];

const c24Transactions = (): PlacedText[] => [
  ...c24Row(558.919, '30.06.', 'Steuern', [{ x: C.debit, text: '-0,02 €' }]),
  ...c24Detail(546.644, 'C24 Bank GmbH'),
  ...c24Detail(534.37, 'Steuerabrechnung Zinsgutschrift'),
  ...c24Row(513.945, '30.06.', 'Zinsen', [
    { x: C.sign, text: '+' },
    { x: C.digits, text: '0,08 €' },
  ]),
  ...c24Detail(501.67, 'C24 Bank'),
  ...c24Detail(489.395, '31.03.2026-29.06.2026'),
];

const C24_BOX = ['84,16 €', '-0,02 €', '+0,08 €', '84,22 €'] as const;
const C24_PERIOD = '01.06.2026 - 30.06.2026';

const c24StatementPage = (
  period: string,
  rows: PlacedText[],
  box: readonly [string, string, string, string],
): PlacedText[] => [
  ...c24Frame(),
  ...c24Section(648.575, 'Kontoauszug 06/2026', period),
    // the third place this document states its closing balance, on the title's own
    // baseline. Drawn smaller than C24_SIZE for a fixture reason with a real consequence:
    // the document draws it as ONE run outside the amount span, and at C24_SIZE this font
    // would fragment it and drop the number inside that span - so the fixture would print
    // an amount cell the document does not print
  { x: C.kontostand, y: 648.575, text: 'Kontostand 84,22 €', size: 1 },
  { x: C.margin, y: 601.5, text: 'Transaktionsübersicht', size: C24_SIZE },
  ...c24Table(579.344),
  ...rows,
  ...c24Box(424.039, ...box),
];

const c24QuarterlyPage = (): PlacedText[] => [
  ...c24Frame(),
  ...c24Section(648.575, 'Rechnungsabschluss 2/2026', '01.04.2026 - 30.06.2026'),
  { x: C.margin, y: 590.161, text: 'Entgelte', size: C24_SIZE },
  { x: C.boxValue, y: 565.344, text: '0,00 €', size: C24_SIZE },
  { x: C.margin, y: 524.804, text: 'Zinsen', size: C24_SIZE },
  ...(
    [
      [499.987, 'Sollzinsen', '7,49 % p.a.', '0,00 €'],
      [471.563, 'Habenzinsen', '0,50 % p.a.', '0,08 €'],
    ] as const
  ).flatMap(([y, label, rate, value]) => [
    { x: C.interestLabel, y, text: label, size: C24_SIZE },
    { x: C.rate, y, text: rate, size: C24_SIZE },
    { x: C.range, y, text: '31.03.2026 - 30.06.2026', size: C24_SIZE },
    { x: C.interest, y, text: value, size: C24_SIZE },
  ]),
  ...c24Box(383.702, '94,16 €', '-10,02 €', '+0,08 €', '84,22 €', C.boxValueWide),
];

const c24LegalPage = (tag: string): PlacedText[] => [
  ...c24Frame(),
  { x: C.margin, y: 657.575, text: 'Weitere Informationen', size: C24_SIZE },
  {
    x: C.margin,
    y: 603.423,
    text: 'Rechnungsabschluss. Der Abschnitt weiter oben ist der maßgebliche.',
    size: C24_SIZE,
  },
  { x: C.margin, y: 5, text: tag, size: C24_SIZE },
];

const c24Statement = (
  tag: string,
  over: {
    period?: string;
    rows?: PlacedText[];
    box?: readonly [string, string, string, string];
  } = {},
): PlacedText[][] => [
  [
    ...c24StatementPage(
      over.period ?? C24_PERIOD,
      over.rows ?? c24Transactions(),
      over.box ?? C24_BOX,
    ),
    ...c24Footer(1, 3),
  ],
  [...c24QuarterlyPage(), ...c24Footer(2, 3)],
  [...c24LegalPage(tag), ...c24Footer(3, 3)],
];

const c24Lines: TextLine[] = [
  {
    page: 1,
    y: 579.344,
    items: [
      { x: C.buchung, text: 'Buchung' },
      { x: C.valuta, text: 'Valuta' },
      { x: C.description, text: 'Transaktionsinformation' },
      { x: C.amountHeading, text: 'Betrag' },
    ],
  },
  { page: 1, y: 23.687, items: [{ x: C.footerName, text: 'C24 Bank GmbH' }] },
  { page: 1, y: 11.148, items: [{ x: C.footerVat, text: 'Ust.-ID DE 322 469 451' }] },
];

const c24Template = (): PdfTemplate => TEMPLATES.find((t) => t.id === 'c24-de')!;

const c24Unscoped = (): PdfTemplate => {
  const c24 = c24Template();
  if (c24.balances.kind !== 'two-lines') throw new Error('the c24 box is two-lines');
  return { ...c24, balances: { ...c24.balances, scope: { kind: 'whole-document' } } };
};

describe('pdf: the fourth layout', () => {
  it('reads a statement whose dates carry no year and whose box is printed twice', async () => {
    const staged = await importPdf('C24 Happy', c24Statement('happy path'));
    expect(staged.outcome).toBe('awaiting_confirmation');
    if (staged.outcome !== 'awaiting_confirmation') return;

    expect(staged.summary).toMatchObject({
      total: 2,
      accepted: 2,
      skipped: 0,
      problems: [],
      from: '2026-06-30',
      to: '2026-06-30',
      totals: [{ currency: 'EUR', net: 0.06 }],
      balances: { opening: 84.16, closing: 84.22, currency: 'EUR' },
    });
  });

  it('names the layout, and reads all four of the numbers its own section prints', async () => {
    const st = await readPdf(buildPdf(c24Statement('four numbers')), LIMITS);
    expect(st.template).toBe('c24-de');
    expect(st.title).toBe('C24 Bank GmbH');
    expect(st.balances).toEqual({
      openingCents: 8416,
      closingCents: 8422,
      gross: { kind: 'printed', outgoingCents: -2, incomingCents: 8 },
      currency: 'EUR',
    });
    expect(st.sheet.rows.slice(1).map((r) => [r[1], r[3]])).toEqual([
      [-0.02, 'EUR'],
      [0.08, 'EUR'],
    ]);
  });

  it('keeps a detail line and drops the footer line whose text it shares', async () => {
    const c24 = c24Template();
    expect(c24.rows.kind === 'continuations' && c24.rows.drop).toEqual([]);

    const r = await importAndConfirm({
      accountId: await accountFor('C24 Descriptions'),
      bytes: buildPdf(c24Statement('descriptions')),
    });
    const rows = (await listTransactions({ accountId: r.accountId, limit: 50 })).map(
      (t) => t.description,
    );
    expect(rows.sort()).toEqual([
      'Steuern C24 Bank GmbH Steuerabrechnung Zinsgutschrift',
      'Zinsen C24 Bank 31.03.2026-29.06.2026',
    ]);
    for (const description of rows) {
      expect(description).not.toMatch(/Ust\.-ID|Neue Mainzer|Seite|Zusammenfassung|Startsaldo/);
    }
    expect(rows.join(' ').match(/C24 Bank GmbH/gu)).toHaveLength(1);
  });

  it('reads the transaction section box where two are printed under one set of labels', async () => {
    const st = await readPdf(buildPdf(c24Statement('two boxes')), LIMITS);
    expect(st.balances.openingCents).toBe(8416);
  });

  it('reads it by its section and not by which block comes first', async () => {
    const bytes = buildPdf([
      [
        ...c24Frame(),
        ...c24Section(660, 'Rechnungsabschluss 2/2026', '01.04.2026 - 30.06.2026'),
        ...c24Box(611, '94,16 €', '-10,02 €', '+0,08 €', '84,22 €', C.boxValueWide),
        ...c24Section(520, 'Kontoauszug 06/2026', C24_PERIOD),
        { x: C.margin, y: 495, text: 'Transaktionsübersicht', size: C24_SIZE },
        ...c24Table(483),
        ...c24Row(463, '30.06.', 'Steuern', [{ x: C.debit, text: '-0,02 €' }]),
        ...c24Detail(451, 'C24 Bank GmbH'),
        ...c24Row(431, '30.06.', 'Zinsen', [
          { x: C.sign, text: '+' },
          { x: C.digits, text: '0,08 €' },
        ]),
        ...c24Box(345, ...C24_BOX),
        ...c24Footer(1, 2),
      ],
      [...c24LegalPage('reordered'), ...c24Footer(2, 2)],
    ]);
    const st = await readPdf(bytes, LIMITS);
    expect(st.balances.openingCents).toBe(8416);
  });

  it('refuses when its own section has no box, rather than reading the other one', async () => {
    const pages = c24Statement('no box of its own');
    pages[0] = pages[0].filter((t) => t.text !== 'Startsaldo' && t.text !== '84,16 €');
    await expect(importPdf('C24 No Box', pages)).rejects.toThrow(
      /it expects exactly one "Startsaldo" line and found 0/,
    );
  });

  it('opens its scope on the first section title, not on the only one', async () => {
    const staged = await importPdf('C24 Two Pages', [
      [
        ...c24Frame(),
        ...c24Section(648.575, 'Kontoauszug 06/2026', C24_PERIOD),
        { x: C.margin, y: 601.5, text: 'Transaktionsübersicht', size: C24_SIZE },
        ...c24Table(579.344),
        ...c24Row(558.919, '30.06.', 'Steuern', [{ x: C.debit, text: '-0,02 €' }]),
        ...c24Detail(546.644, 'C24 Bank GmbH'),
        ...c24Footer(1, 4),
      ],
      [
        ...c24Frame(),
        ...c24Section(648.575, 'Kontoauszug 06/2026', C24_PERIOD),
        ...c24Table(579.344),
        ...c24Row(558.919, '30.06.', 'Zinsen', [
          { x: C.sign, text: '+' },
          { x: C.digits, text: '0,08 €' },
        ]),
        ...c24Detail(546.644, 'C24 Bank'),
        ...c24Box(424.039, ...C24_BOX),
        ...c24Footer(2, 4),
      ],
      [...c24QuarterlyPage(), ...c24Footer(3, 4)],
      [...c24LegalPage('two page section'), ...c24Footer(4, 4)],
    ]);
    if (staged.outcome !== 'awaiting_confirmation') throw new Error('not staged');
    expect(staged.summary).toMatchObject({
      total: 2,
      accepted: 2,
      balances: { opening: 84.16, closing: 84.22, currency: 'EUR' },
    });
  });

  it('reads a month that prints no closing section at all', async () => {
    const st = await readPdf(
      buildPdf([
        [
          ...c24Frame(),
          ...c24Section(648.575, 'Kontoauszug 07/2026', '01.07.2026 - 31.07.2026'),
          { x: C.margin, y: 601.5, text: 'Transaktionsübersicht', size: C24_SIZE },
          ...c24Table(579.344),
          ...c24Row(558.919, '31.07.', 'Steuern', [{ x: C.debit, text: '-0,02 €' }]),
          ...c24Detail(546.644, 'C24 Bank GmbH'),
          ...c24Row(513.945, '31.07.', 'Zinsen', [
            { x: C.sign, text: '+' },
            { x: C.digits, text: '0,08 €' },
          ]),
          ...c24Box(424.039, ...C24_BOX),
          ...c24Footer(1, 2, '07/2026'),
        ],
        [
          ...c24Frame(),
          { x: C.margin, y: 657.575, text: 'Weitere Informationen', size: C24_SIZE },
          {
            x: C.margin,
            y: 603.423,
            text: 'Der Abschnitt oben ist der maßgebliche.',
            size: C24_SIZE,
          },
          ...c24Footer(2, 2, '07/2026'),
        ],
      ]),
      LIMITS,
    );
    expect(st.balances).toMatchObject({ openingCents: 8416, closingCents: 8422 });
    expect(st.sheet.rows.slice(1).map((r) => (r[0] as Date).toISOString().slice(0, 10))).toEqual([
      '2026-07-31',
      '2026-07-31',
    ]);
  });

  it('finds two of every label when the scope is the whole document', async () => {
    await expect(
      readPdf(buildPdf(c24Statement('unscoped')), LIMITS, [c24Unscoped()]),
    ).rejects.toThrow(/expects exactly one such line and found 2/);

    const onePeriod = c24Statement('unscoped box');
    onePeriod[1] = onePeriod[1].filter((t) => t.text !== '01.04.2026 - 30.06.2026');
    const bytes = buildPdf(onePeriod);
    await expect(readPdf(bytes, LIMITS, [c24Unscoped()])).rejects.toThrow(
      /it expects exactly one "Startsaldo" line and found 2/,
    );
    expect((await readPdf(bytes, LIMITS, [c24Template()])).balances.openingCents).toBe(8416);
  });

  it('refuses a document whose section heading it cannot find at all', async () => {
    const pages = c24Statement('no heading');
    pages[0] = pages[0].filter((t) => t.text !== 'Kontoauszug 06/2026');
    await expect(importPdf('C24 No Heading', pages)).rejects.toThrow(
      /it reads the summary of the section headed "Kontoauszug", and this document prints no such heading/,
    );
  });

  it('refuses when the period its years come from is missing or ambiguous', async () => {
    const gone = c24Statement('no period');
    gone[0] = gone[0].filter((t) => t.text !== C24_PERIOD);
    await expect(importPdf('C24 No Period', gone)).rejects.toThrow(
      /reads the year off the period the statement covers - and it expects exactly one such line and found 0/,
    );

    const two = c24Statement('two periods');
    two[0].push({ x: C.section, y: 620, text: '01.05.2026 - 31.05.2026', size: C24_SIZE });
    await expect(importPdf('C24 Two Periods', two)).rejects.toThrow(
      /expects exactly one such line and found 2/,
    );
  });

  it('reads each row the one year of the period that contains its day and month', async () => {
    const st = await readPdf(
      buildPdf(
        c24Statement('year boundary', {
          period: '01.12.2025 - 31.01.2026',
          rows: [
            ...c24Row(558.919, '01.12.', 'Erster Tag', [{ x: C.debit, text: '-1,00 €' }]),
            ...c24Row(538.494, '15.12.', 'Dezember', [{ x: C.debit, text: '-2,00 €' }]),
            ...c24Row(518.069, '15.01.', 'Januar', [{ x: C.debit, text: '-3,00 €' }]),
            ...c24Row(497.644, '31.01.', 'Letzter Tag', [
              { x: C.sign, text: '+' },
              { x: C.digits, text: '6,00 €' },
            ]),
          ],
          box: ['100,00 €', '-6,00 €', '+6,00 €', '100,00 €'],
        }),
      ),
      LIMITS,
    );
    expect(st.sheet.rows.slice(1).map((r) => (r[0] as Date).toISOString().slice(0, 10))).toEqual([
      '2025-12-01',
      '2025-12-15',
      '2026-01-15',
      '2026-01-31',
    ]);
  });

  it('skips a row the period does not contain, and the gate then refuses', async () => {
    const outside = (tag: string): PlacedText[][] =>
      c24Statement(tag, {
        rows: [
          ...c24Transactions(),
          ...c24Row(469, '15.03.', 'Zu frueh', [{ x: C.debit, text: '-1,00 €' }]),
        ],
        box: ['84,16 €', '-1,02 €', '+0,08 €', '83,22 €'],
      });

    const st = await readPdf(buildPdf(outside('outside note')), LIMITS);
    expect(st.sheet.rows[3][0]).toBeNull();
    expect(st.sheet.note!(3, 0)).toBe(
      `reads "15.03. 15.03.", which this statement's period (${C24_PERIOD}) does not contain`,
    );

    await expect(importPdf('C24 Outside Period', outside('outside gate'))).rejects.toThrow(
      /this C24 Bank GmbH statement does not add up: .* a difference of 1\.00 EUR, and the 1 transaction line this importer could not read/,
    );
  });

  it('skips a row the period contains twice, and says which of the two it is', async () => {
    const st = await readPdf(
      buildPdf(
        c24Statement('two candidates', {
          period: '01.01.2025 - 31.12.2026',
          rows: [...c24Row(558.919, '15.06.', 'Zweimal', [{ x: C.debit, text: '-1,00 €' }])],
          box: ['100,00 €', '-1,00 €', '+0,00 €', '99,00 €'],
        }),
      ),
      LIMITS,
    );
    expect(st.sheet.rows[1][0]).toBeNull();
    expect(st.sheet.note!(1, 0)).toBe(
      'reads "15.06. 15.06.", which this statement\'s period (01.01.2025 - 31.12.2026) contains in more than one year',
    );
  });

  it('reads a credit whose sign is a run of its own', async () => {
    const st = await readPdf(buildPdf(c24Statement('split credit')), LIMITS);
    expect(st.sheet.rows[2][1]).toBe(0.08);
  });

  it('reads a debit whose sign is a run of its own, and the sides then agree', async () => {
    const pages = c24Statement('split debit', {
      rows: [
        ...c24Transactions(),
        ...c24Row(469, '30.06.', 'Gebuehr', [
          { x: C.sign, text: '-' },
          { x: C.digits, text: '0,02 €' },
        ]),
      ],
      box: ['84,16 €', '-0,04 €', '+0,08 €', '84,20 €'],
    });
    const st = await readPdf(buildPdf(pages), LIMITS);
    expect(st.sheet.rows[3][1]).toBe(-0.02);

    const staged = await importPdf('C24 Split Debit', pages);
    expect(staged.outcome).toBe('awaiting_confirmation');
  });

  it('reads an amount wider than any this document prints', async () => {
    const st = await readPdf(
      buildPdf(
        c24Statement('four figures', {
          rows: [
            ...c24Transactions(),
            ...c24Row(469, '29.06.', 'Miete', [{ x: C.wide, text: '-1.234,56 €' }]),
          ],
          box: ['84,16 €', '-1.234,58 €', '+0,08 €', '-1.150,34 €'],
        }),
      ),
      LIMITS,
    );
    expect(st.sheet.rows[3][1]).toBe(-1234.56);
    expect(st.balances).toMatchObject({ openingCents: 8416, closingCents: -115034 });
  });

  it('a table this layout does not name refuses the document', async () => {
    const pages = c24Statement('unknown table');
    pages[0].push(
      { x: C.buchung, y: 300, text: 'Datum', size: C24_SIZE },
      { x: C.description, y: 300, text: 'Transaktionsinformation', size: C24_SIZE },
    );
    await expect(importPdf('C24 New Table', pages)).rejects.toThrow(
      /this C24 Bank GmbH statement has a table this importer cannot read \("Datum"\)/,
    );
  });

  it('does not claim a document whose fourth heading has been renamed', async () => {
    const pages = c24Statement('renamed heading');
    pages[0] = pages[0].map((t) => (t.text === 'Valuta' ? { ...t, text: 'Wertstellung' } : t));
    expect(pages[0].some((t) => t.text === 'Wertstellung')).toBe(true);
    await expect(importPdf('C24 Renamed', pages)).rejects.toThrow(
      /this statement's layout is not one this importer recognises yet/,
    );
  });

  it('is claimed by its own template and by no other', () => {
    expect(selectTemplate(TEMPLATES, c24Lines)?.id).toBe('c24-de');
    expect(TEMPLATES.filter((t) => selectTemplate([t], c24Lines) !== undefined)).toHaveLength(1);
  });
});

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

describe('pdf: what a template says about its gross totals', () => {
  it('no template in the tree has switched half the gate off', () => {
    const escaped = TEMPLATES.filter((t) => t.balances.gross.kind === 'not-printed').map(
      (t) => t.id,
    );
    expect(escaped).toEqual([]);
  });

  it('a layout that prints none is read and imports with only its ends checked', async () => {
    const noGross: PdfTemplate = {
      ...twin('no-gross', 'No Gross'),
      balances: {
        scope: { kind: 'whole-document' },
        kind: 'two-lines',
        label: [0, 330],
        value: [460, 596],
        opening: 'Anfang',
        closing: 'Ende',
        gross: { kind: 'not-printed' },
      },
    };
    const st = await readPdf(twinDoc('+10,00€', '+9,00€', '-1,00€', '+0,00€'), LIMITS, [noGross]);
    expect(st.balances.gross).toEqual({ kind: 'not-printed' });

    const parsed: ParsedFile = {
      kind: 'pdf',
      sheet: st.sheet,
      preset: null,
      mapping: st.columns,
      template: st.template,
      title: st.title,
      fee: st.fee,
      mcc: st.mcc,
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
    expect(reconcile(parsed, [tx(-51), tx(50)], 0, NO_BALANCES).balances).toEqual({
      opening: 10,
      closing: 9,
      currency: 'EUR',
    });
  });
});

const IBANS = { c24: 'DE64500240240000000001', n26: 'DE65100110010000000002' } as const;

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
    await readPdf(bytes, LIMITS);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error('did not refuse');
};

describe('pdf: the refusals', () => {
  // the sentences are pasted whole and never imported: toBe(ENCRYPTED) would commit
  // the defect this table exists to close, one column over
  const cases: [string, () => Buffer, string][] = [
    [
      'a password-protected PDF',
      () => buildPdf([[{ x: 50, y: 700, text: 'secret' }]], { encrypted: true }),
      'this PDF is password-protected - open it with its password and save an unprotected copy, or download the statement again from your online banking',
    ],
    [
      'a file that starts with %PDF and is not one',
      () => Buffer.from('%PDF-1.4\n1 0 obj\n<< >>\n', 'utf8'),
      'this file looks like a PDF but could not be opened as one - download the statement again from your online banking, or export it as CSV or Excel (.xlsx)',
    ],
    [
      'a scan',
      () => buildImagePdf(),
      'this looks like a scan - this importer reads the text layer of a PDF and this one has none; download the statement again from your online banking, or export it as CSV or Excel (.xlsx)',
    ],
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
      "this statement's layout is not one this importer recognises yet - export the same statement as CSV or Excel (.xlsx) from the same online banking and upload that; those import today",
    ],
    [
      'a statement in a layout nobody has written a template for, from a bank it can name',
      () => buildPdf(unknownLayout(2, () => [`IBAN: ${IBANS.c24}`, 'BIC: DEFFDEFFXXX'])),
      'this looks like a statement from C24 Bank, and its layout is not one this importer recognises yet - export the same statement as CSV or Excel (.xlsx) from the same online banking and upload that; those import today',
    ],
    [
      'a statement in a known layout with no transaction lines in it',
      () => buildPdf([[ISSUER, ...header(700)]]),
      'this Revolut statement has no transaction lines in it - if the statement is really empty then nothing is missing; otherwise export it as CSV or Excel (.xlsx) from your online banking',
    ],
  ];

  for (const [what, bytes, message] of cases) {
    it(`${what} leaves a failed import with its document, and its own message`, async () => {
      const before = await idsNow();
      await expect(
        importStatement({ accountId: await accountFor('Refused Bank'), bytes: bytes() }),
      ).rejects.toThrow(message);

      const failed = await lastFailure(before);
      expect(failed.status).toBe('failed');
      expect(failed.sourceType).toBe('pdf');
      expect(failed.documentAvailable).toBe(true);
      expect(failed.errorDetail).toBe(message);
      expect(failed.errorDetail!.length).toBeLessThanOrEqual(ERROR_DETAIL_MAX);
    });
  }

  it('every one of them is a different sentence', () => {
    const sentences = cases.map(([, , message]) => message);
    expect(new Set(sentences).size).toBe(cases.length);
  });
});

describe('pdf: a refusal that names the bank', () => {
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

  it('counts a page that carries no text at all, and then names nothing', async () => {
    const printed = unknownLayout(2, () => [`IBAN: ${IBANS.c24}`]);
    expect(await refusalOfPdf(buildPdf(printed))).toContain('from C24 Bank');
    expect(await refusalOfPdf(buildPdf([...printed, []]))).toBe(
      "this statement's layout is not one this importer recognises yet - export the same statement as CSV or Excel (.xlsx) from the same online banking and upload that; those import today",
    );
  });

  it('does not run at all on a statement a template claimed', async () => {
    const elsewhere: PlacedText[] = [
      IBANS.c24,
      'LT711600000000000005',
      'UA503220010000000000000000007',
    ].map((iban, n) => ({ x: 520, y: 600 - n * 20, text: `IBAN: ${iban}` }));
    const [plain = []] = statement('foreign ibans');

    const control = await readPdf(buildPdf([plain, []]), LIMITS);
    const read = await readPdf(buildPdf([[...plain, ...elsewhere], elsewhere]), LIMITS);

    expect(read.template).toBe(control.template);
    expect(read.title).toBe(control.title);
    expect(read.balances).toEqual(control.balances);
    expect(read.sheet.rows).toEqual(control.sheet.rows);
    expect(read.sheet.rows).toHaveLength(4);
  });
});

describe('pdf: a statement inside a signed container', () => {
  const REFUSED =
    'this file is not a CSV, Excel (.xlsx) or PDF statement - export the statement in one of those from your online banking and upload that';

  const binaryInsideTheScan = (bytes: Buffer, from = 0): Buffer => {
    const at = bytes.indexOf(0, from);
    const why = 'no NUL the sniffer would have scanned: this fixture pins nothing';
    expect(at, why).toBeGreaterThanOrEqual(from);
    expect(at, why).toBeLessThan(NUL_SCAN_BYTES);
    return bytes;
  };

  const container = (lead: number, header = '%PDF-1.4'): Buffer =>
    Buffer.concat([
      Buffer.from([0x30, lead]),
      Buffer.alloc(64),
      Buffer.from(`signature ${header} certificates`),
    ]);

  it('classifies one as a PDF, whichever long-form length the signer wrote', () => {
    for (const lead of [0x80, 0x81, 0x82, 0x83, 0x84]) {
      expect(sniff(binaryInsideTheScan(container(lead)))).toBe('pdf');
    }
  });

  it('answers on the header being found, never on the lead-in', () => {
    expect(() => sniff(binaryInsideTheScan(container(0x83, 'no header here')))).toThrow(REFUSED);
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

  it('takes a header past pdfjs own 1024-byte search, and the parser still reads it', async () => {
    const bytes = buildSignedContainer(buildPdf(statement('past the find limit')), 2048);
    expect(bytes.indexOf('%PDF-')).toBeGreaterThan(1024);
    expect(sniff(binaryInsideTheScan(bytes, CONTAINER_HEADER_BYTES))).toBe('pdf');

    const staged = await importStatement({
      accountId: await accountFor('Wrapped Far Bank'),
      bytes,
    });
    expect(staged.outcome).toBe('awaiting_confirmation');
    if (staged.outcome !== 'awaiting_confirmation') return;
    expect(staged.summary.total).toBe(3);
  });

  it('imports a known layout inside a container, end to end', async () => {
    const imported = await importAndConfirm({
      accountId: await accountFor('Wrapped Revolut'),
      bytes: binaryInsideTheScan(
        buildSignedContainer(buildPdf(statement('wrapped'))),
        CONTAINER_HEADER_BYTES,
      ),
    });

    expect(imported.inserted).toBe(3);
    const record = (await listImports()).imports.find((i) => i.id === imported.importId)!;
    expect(record.sourceType).toBe('pdf');
    expect(record.parserVersion).toBe(7);
  });

  it('says a container whose document is broken looks like a PDF, not that it starts with one', async () => {
    const bytes = binaryInsideTheScan(container(0x83));
    expect(bytes.indexOf('%PDF-')).toBeGreaterThan(0);

    await expect(readPdf(bytes, LIMITS)).rejects.toThrow(
      /looks like a PDF but could not be opened as one/,
    );
  });
});

/**
 * A clock that moves only when it is read, so expiry lands on a known check rather than on
 * how fast this machine is. It reads deterministically because pdfjs never calls this clock
 * during a parse: every reading below is one of the parser's own. Re-check that on a pdfjs
 * bump - nothing else in the tree would notice.
 *
 * Restored in a finally because vitest runs one process with isolation off, so a leaked spy
 * on a global would poison every later file and the symptom would appear nowhere near here.
 */
const stepping = async (step: number, run: () => Promise<unknown>): Promise<string> => {
  let t = 0;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => (t += step));
  try {
    await run();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  } finally {
    clock.mockRestore();
  }
  throw new Error('did not refuse');
};

/** How far the deadline refusal says it got, and that it is the deadline refusal at all. */
const pagesRead = (refusal: string, of: number): number => {
  expect(refusal).toMatch(/was taking longer than \d+ seconds to read/);
  const read = new RegExp(`stopped after (\\d+) of its ${of} pages`).exec(refusal);
  expect(read, refusal).not.toBeNull();
  return Number(read![1]);
};

describe('pdf: the caps', () => {
  it('a PDF past the byte cap is refused before an import row exists', async () => {
    const oversized = Buffer.alloc(11 * 1024 * 1024);
    Buffer.from('%PDF-1.4\n').copy(oversized);
    expect(sniff(oversized)).toBe('pdf');
    const before = (await listImports()).imports.length;
    const accountId = await accountFor('Fat Pdf Bank');
    const attempt = () => importStatement({ accountId, bytes: oversized });

    await expect(attempt()).rejects.toThrow(/the PDF is larger than 10 MB/);
    expect((await listImports()).imports).toHaveLength(before);
    await expect(attempt()).rejects.toThrow(/the PDF is larger than 10 MB/);
    expect((await listImports()).imports).toHaveLength(before);
  });

  it('a PDF past the page cap leaves a failed import with its document', async () => {
    const pages: PlacedText[][] = [];
    for (let p = 0; p < 201; p++) pages.push([{ x: 50, y: 700, text: `page ${p}` }]);
    const bytes = buildPdf(pages);
    expect(bytes.length).toBeLessThan(1024 * 1024);

    const before = await idsNow();
    await expect(
      importStatement({ accountId: await accountFor('Long Pdf Bank'), bytes }),
    ).rejects.toThrow(/this PDF has 201 pages, more than the 200 this importer reads in one file/);

    const failed = await lastFailure(before);
    expect(failed.status).toBe('failed');
    expect(failed.documentAvailable).toBe(true);
  });

  // Pages carrying no text at all, which is the one shape the check inside the item loop
  // cannot see: it never runs, so only the per-page check can stop this document.
  it('a PDF past the deadline stops between pages, and says how many it read', async () => {
    const bytes = buildPdf(Array.from({ length: 100 }, () => []));

    const refusal = await stepping(100, () =>
      readPdf(bytes, { maxPages: 200, deadlineMs: 5_000 }),
    );

    expect(pagesRead(refusal, 100)).toBe(50);
  });

  // And one page carrying more items than the stride the item check runs at, which only that
  // check can stop: the per-page check has already run for the only page there is.
  it('a PDF past the deadline stops partway through a page it has entered', async () => {
    const items: PlacedText[] = [];
    for (let i = 0; i < 1_200; i++) {
      items.push({ x: 30 + (i % 12) * 45, y: 800 - Math.floor(i / 12) * 8, text: 'x' });
    }

    const refusal = await stepping(10, () =>
      readPdf(buildPdf([items]), { maxPages: 200, deadlineMs: 25 }),
    );

    expect(pagesRead(refusal, 1)).toBe(0);
  });

  it('a PDF past the deadline leaves a failed import with its document', async () => {
    const pages: PlacedText[][] = [];
    for (let p = 0; p < 200; p++) pages.push([{ x: 50, y: 700, text: `page ${p}` }]);
    const bytes = buildPdf(pages);
    const accountId = await accountFor('Slow Pdf Bank');

    const before = await idsNow();
    // A step of a second against the deadline the importer really passes in, so this is also
    // the only case that constrains that number's magnitude: a value small enough to expire
    // on the first page or large enough to survive all 200 checks fails here.
    const refusal = await stepping(1_000, () => importStatement({ accountId, bytes }));

    const read = pagesRead(refusal, 200);
    expect(read).toBeGreaterThan(0);
    expect(read).toBeLessThan(200);

    const failed = await lastFailure(before);
    expect(failed.status).toBe('failed');
    expect(failed.documentAvailable).toBe(true);
    expect(failed.errorDetail).toContain('taking longer than');
  });
});

describe('pdf and csv of the same statement', () => {
  it('land in one account, and the second one deduplicates against the first', async () => {
    const accountId = await accountFor('One Bank Two Formats');
    const fromPdf = await importAndConfirm({
      accountId,
      bytes: buildPdf(statement('two formats')),
    });
    expect(fromPdf.inserted).toBe(3);

    const csv = [
      'Completed Date,Description,Amount,Currency,State',
      '2026-07-02,REWE.de,-5.68,EUR,COMPLETED',
      '2026-07-03,Платеж от JANE DOE,100.00,EUR,COMPLETED',
      '2026-07-30,Wizz Air,-1234.56,EUR,COMPLETED',
      '2026-07-31,Netflix,-12.99,EUR,COMPLETED',
    ].join('\n');
    const fromCsv = await importAndConfirm({
      accountId,
      preset: 'revolut',
      bytes: Buffer.from(csv, 'utf8'),
    });

    expect(fromCsv.accountId).toBe(fromPdf.accountId);
    expect(fromCsv.inserted).toBe(1);
    expect(await getAccount(fromPdf.accountId)).toBeDefined();
    expect((await listTransactions({ accountId: fromPdf.accountId, limit: 50 })).length).toBe(4);
  });
});

describe('the source-type dispatch', () => {
  it('has no default that quietly reads something as a CSV', async () => {
    await expect(
      readSheet(
        { accountId: await accountFor('x'), bytes: Buffer.from('date,amount,description\n') },
        'ofx' as ImportSourceType,
        null,
      ),
    ).rejects.toThrow(/unhandled source type: ofx/);
  });
});

describe('the fee convention dispatch', () => {
  it('has no default that quietly picks a convention', () => {
    expect(applyFee(-63.62, { kind: 'included', fee: 0.44 })).toEqual({
      amount: -63.62,
      fee: 0.44,
    });
    expect(applyFee(-63.18, { kind: 'on-top', fee: 0.44 })).toEqual({
      amount: -63.62,
      fee: 0.44,
    });
    expect(applyFee(-63.62, { kind: 'not-stated' })).toEqual({ amount: -63.62, fee: null });
    expect(() => applyFee(1, { kind: 'guessed' } as unknown as StatedFee)).toThrow(
      /unhandled fee convention/,
    );
  });
});

describe('the diagnostic budget', () => {
  it('a note quotes a long cell cut, and stays inside what xlsx.ts assumed', async () => {
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
          ...box(640, '1,00€', '1,00€', '1,00€', '1,00€'),
        ],
      ]),
      LIMITS,
    );

    const notes = [st.sheet.note!(1, 0), st.sheet.note!(1, 1)];
    expect(notes[0]).toMatch(/^reads "2 ы+…", which this template cannot read as a date$/);
    expect(notes[1]).toMatch(/^holds "ы+…" and "1,00€" - a line carries a debit or a credit/);
    for (const note of notes) expect(note!.length).toBeLessThanOrEqual(NOTE_MAX);
    expect(`row 50000: the amount cell ${'x'.repeat(NOTE_MAX)}`.length).toBeLessThanOrEqual(159);
  });

  it("the gate's longest refusals fit what error_detail keeps", () => {
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
      gross: StatementBalances['gross'] = { kind: 'printed', outgoingCents: 0, incomingCents: 0 },
    ): ParsedFile => ({
      kind: 'pdf',
      sheet: { rows: [], rowLabel: (i) => i },
      preset: null,
      mapping: {},
      template: 'revolut-ru',
      title: TITLE,
      fee: { kind: 'none' },
      mcc: { kind: 'none' },
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

  it("the parser's own refusals fit what error_detail keeps, at every template's extreme", () => {
    const all = refusals();
    for (const sentence of all) expect(sentence.length).toBeLessThanOrEqual(ERROR_DETAIL_MAX);
    expect(Math.max(...all.map((s) => s.length))).toBe(313);
    expect(new Set(all).size).toBe(all.length);
  });
});
