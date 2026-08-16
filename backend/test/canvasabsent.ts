/**
 * What the PDF parser answers, reduced to something two processes can compare.
 *
 * The point of this row is that the production image carries no `@napi-rs/canvas`
 * (ROADMAP row 28), and no test on any developer's machine can see that: canvas is
 * installed everywhere the suite runs, so the stubs in src/providers/pdfjsloader.ts
 * are dead code here and the parser would keep passing with them deleted. So this
 * module is imported twice - once by canvasabsent.test.ts with the package present,
 * once by canvasabsent.child.ts in a child process where it has been made
 * unresolvable - and the two answers are compared.
 *
 * The template is synthetic. It is not either shipped layout and is not evidence
 * about one: what it has to exercise is the four ways readPdf can answer, one of
 * which - the password refusal - only comes out right if the dynamic import handed
 * back pdfjs's real namespace rather than something shaped like it.
 */
import { PdfTemplate, StatementBalances, readPdf } from '../src/providers/pdf';
import { Cell } from '../src/providers/sheet';
import { PlacedText, buildImagePdf, buildPdf } from './pdffixture';

const ISSUER = 'Canvas Absent Bank';

const TEMPLATE: PdfTemplate = {
  id: 'canvas-absent',
  title: 'Canvas Absent',
  issuer: [ISSUER],
  amounts: 'signed',
  columns: { date: [30, 130], description: [130, 300], amount: [300, 420] },
  marker: { column: 'description', text: 'Description' },
  tables: [
    { header: { date: 'Date', description: 'Description', amount: 'Amount' }, collect: true },
  ],
  dates: { format: 'de-numeric' },
  amount: {
    pattern: /^(-?\d{1,3}(?:\.\d{3})*,\d{2}) (€)$/u,
    decimal: ',',
    currency: { kind: 'in-the-cell', symbols: { '€': 'EUR' } },
    example: '1.234,56 €',
  },
  rows: { kind: 'one-line' },
  fee: { kind: 'none' },
  mcc: { kind: 'none' },
  balances: {
    scope: { kind: 'whole-document' },
    kind: 'one-line',
    total: 'Total',
    label: [30, 130],
    opening: [300, 420],
    closing: [420, 540],
    // The Total line below prints two cells and not four, so this is what the
    // fixture does rather than what its author could not find (row 035's Q1).
    gross: { kind: 'not-printed' },
  },
};

const line = (y: number, date: string, description: string, amount: string): PlacedText[] => [
  { x: 40, y, text: date },
  { x: 140, y, text: description },
  { x: 320, y, text: amount },
];

// two rows netting +87,66, which is what 1.000,00 -> 1.087,66 says
const STATEMENT: PlacedText[][] = [
  [
    { x: 40, y: 780, text: ISSUER },
    ...line(700, 'Date', 'Description', 'Amount'),
    ...line(680, '02.07.2026', 'Grocery', '-12,34 €'),
    ...line(660, '03.07.2026', 'Salary', '100,00 €'),
    { x: 40, y: 620, text: 'Total' },
    { x: 320, y: 620, text: '1.000,00 €' },
    { x: 440, y: 620, text: '1.087,66 €' },
  ],
];

/** Text, and enough of it per page that it is refused as unrecognised and not as a scan. */
const NOT_THIS_LAYOUT: PlacedText[][] = [
  [
    { x: 40, y: 780, text: 'Some other bank, whose layout nothing in the tree was measured against' },
    { x: 40, y: 760, text: 'and which therefore has to be refused by name rather than read.' },
  ],
];

const refused = async (bytes: Buffer): Promise<string> => {
  try {
    await readPdf(bytes, { maxPages: 10, deadlineMs: 600_000 }, [TEMPLATE]);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return 'parsed, and this fixture was built not to';
};

export interface CanvasAbsentParse {
  template: string;
  title: string;
  rows: Cell[][];
  /**
   * The reader's own type rather than a copy of its fields: `parsed.balances` is
   * assigned here whole, so a hand-written shape beside it goes stale the moment the
   * reader gains a field and `tsc` says nothing, because this is an assignment and not
   * an object literal. Row 035 added `gross` and that is exactly what happened.
   */
  balances: StatementBalances;
  scan: string;
  encrypted: string;
  unrecognised: string;
  /** invariant 3: the render path is a crash, in this process too */
  path2dThrows: boolean;
  domMatrixWithInitThrows: boolean;
}

const throws = (f: () => unknown): boolean => {
  try {
    f();
    return false;
  } catch {
    return true;
  }
};

export async function parseWithoutCanvas(): Promise<CanvasAbsentParse> {
  const parsed = await readPdf(buildPdf(STATEMENT), { maxPages: 10, deadlineMs: 600_000 }, [
    TEMPLATE,
  ]);
  const globals = globalThis as unknown as {
    Path2D: new () => unknown;
    DOMMatrix: new (init: number[]) => unknown;
  };
  return {
    template: parsed.template,
    title: parsed.title,
    rows: parsed.sheet.rows,
    balances: parsed.balances,
    scan: await refused(buildImagePdf()),
    encrypted: await refused(buildPdf(STATEMENT, { encrypted: true })),
    unrecognised: await refused(buildPdf(NOT_THIS_LAYOUT)),
    path2dThrows: throws(() => new globals.Path2D()),
    domMatrixWithInitThrows: throws(() => new globals.DOMMatrix([1, 0, 0, 1, 0, 0])),
  };
}
