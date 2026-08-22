import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  NO_FIGURE,
  TOOLTIP_CHIP,
  TooltipGround,
  tooltipColor,
  tooltipMoney,
  tooltipPercent,
  tooltipProps,
} from './chartTooltip';
import { darkInk, Ink, lightInk } from './theme';

const PALETTES: [string, Ink][] = [
  ['light', lightInk],
  ['dark', darkInk],
];

/**
 * sRGB relative luminance and the WCAG ratio, over the two colour notations this
 * palette is written in. The quiet white is an `rgba`, so it is composited over the
 * fill before it is measured: `rgba(255,255,255,0.62)` is not a colour until you say
 * what is behind it, and what is behind it is the whole question here.
 */
function parse(color: string, over: [number, number, number]): [number, number, number] {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (hex) return [1, 2, 3].map((i) => parseInt(hex[i], 16)) as [number, number, number];
  const rgba = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(color);
  if (!rgba) throw new Error(`unreadable colour: ${color}`);
  const a = rgba[4] === undefined ? 1 : Number(rgba[4]);
  return [1, 2, 3].map((i) => Number(rgba[i]) * a + over[i - 1] * (1 - a)) as [
    number,
    number,
    number,
  ];
}

const luminance = (rgb: [number, number, number]): number => {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** How far apart two colours read, the text one composited over the ground one. */
function contrast(text: string, ground: string): number {
  const back = parse(ground, [0, 0, 0]);
  const front = parse(text, back);
  const [hi, lo] = [luminance(front), luminance(back)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

/** What a graphical object needs is 3:1; text on its own fill is held to the text bar. */
const TEXT_FLOOR = 4.5;

const GROUNDS = Object.keys(TOOLTIP_CHIP) as TooltipGround[];

describe('a tooltip is never painted in the colour of the ground it is drawn on', () => {
  /*
   * The list is the record's own keys and never a hand-written one: an enumeration of
   * what crosses a boundary is written by somebody who can be one short, which row 052b
   * paid for. The record being total over the union is the structural half of this — a
   * ground added without a chip does not compile, and this case then covers it without
   * being edited. A ground's name being the `Ink` key of its own fill is what lets the
   * comparison below read the real card colour rather than a second idea of it.
   */
  it.each(GROUNDS)('%s: the fill is not the ground, in both palettes', (ground) => {
    for (const [scheme, ink] of PALETTES) {
      // off the object recharts is handed, never off the record: the record is what
      // the factory is meant to read, and a factory that ignores it paints the card's
      // own colour while every assertion about the record stays green
      const fill = tooltipProps(ink, ground, () => '').contentStyle.background;
      expect(fill, `${ground} tooltip is invisible on its own ground in ${scheme}`).not.toBe(
        ink[ground],
      );
    }
  });

  /*
   * A string inequality and not a ratio floor. The tightest pair that SHIPS is `brand`
   * on `surface` in dark at 1.36:1 — the flows card, since it was drawn — so any floor
   * that catches the real defect (1.20:1, below) sits six hundredths under a live
   * colour and reds on a palette tweak of any size, for a reason nobody reading it
   * could connect to a tooltip. The pair that inequality alone would let through is
   * pinned by name in its own case instead.
   */

  it.each(GROUNDS)('%s: both text colours are readable on the fill, in both palettes', (ground) => {
    for (const [scheme, ink] of PALETTES) {
      // the fill and both texts as the factory composed them, for the reason above —
      // and a colour rather than a key, which is also what makes the quiet white
      // measurable: `var(--c-on-ground-2)` compared to a fill would pass by being
      // unequal to everything
      const props = tooltipProps(ink, ground, () => '');
      const fill = props.contentStyle.background;
      const texts = [
        ['label', props.labelStyle.color],
        ['item', props.itemStyle.color],
      ] as const;
      for (const [key, text] of texts) {
        expect(contrast(text, fill), `${ground} ${key} on its fill in ${scheme}`).toBeGreaterThan(
          TEXT_FLOOR,
        );
      }
    }
  });

  /*
   * The measurement behind `panel` not taking the navy chip, kept as a case so that it
   * is re-read rather than re-argued: these two are 1.20:1 apart in light and identical
   * in dark. If a palette change ever makes them tell apart, this reds, and the red is
   * a true signal — the reason for the mapping above has changed.
   */
  it('the navy fill is indistinguishable from the panel card, which is why panel is not navy', () => {
    expect(contrast(lightInk.brand, lightInk.panel)).toBeLessThan(1.25);
    expect(darkInk.brand).toBe(darkInk.panel);
  });

  /*
   * The separations each chip was chosen on, written into the comments beside them and
   * pinned here so that a palette move makes them red rather than false. This is not
   * the floor D4 refused: a floor is a bound on what the design may become and reds for
   * a reason a reader cannot connect to a tooltip, where a pin on a measured value says
   * something true and actionable — the figures written down are stale, re-measure
   * them. The minimum of this set is 1.36, which is the "tightest pair that ships"
   * sentence below carried by a number instead of by prose.
   */
  it('the separations the chips were chosen on are the ones written beside them', () => {
    const shipped: [string, number, number][] = [
      ['NAVY on surface (chartTooltip.ts, above NAVY)', contrast(lightInk.brand, lightInk.surface), 16.13],
      ['NAVY on surface, dark', contrast(darkInk.brand, darkInk.surface), 1.36],
      ['LIGHT on panel (chartTooltip.ts, above LIGHT)', contrast(lightInk.surface, lightInk.panel), 19.31],
      ['LIGHT on panel, dark', contrast(darkInk.surface, darkInk.panel), 1.36],
    ];
    for (const [what, measured, written] of shipped) {
      expect(measured, `${what}: the figure in the comment is no longer the measurement`).toBeCloseTo(
        written,
        1,
      );
    }
    expect(Math.min(...shipped.map(([, m]) => m)), 'the tightest pair that ships').toBeCloseTo(
      1.36,
      1,
    );
  });

  /*
   * `ChartPlot` is drawn on two grounds — `surface` in a chart card, `page` in the
   * wizard's live preview — and passes `'surface'` for both, because today they take
   * the same chip. This case is what says that shortcut is still safe; when it reds,
   * the ground becomes a prop and `ChartWizard` passes it.
   */
  it('surface and page take the same chip, which is what lets ChartPlot pass one of them', () => {
    expect(TOOLTIP_CHIP.surface).toEqual(TOOLTIP_CHIP.page);
  });

  /*
   * The quiet white is a copy of a token, and a copy of a constant is what this
   * repository keeps being bitten by. Read as text out of the stylesheet that defines
   * it, resolving from import.meta.url like `copy.test.ts` and for its reason: the
   * root of this lookup is the directory this file sits in, not a package root.
   */
  it('the quiet white is the token it was copied from', () => {
    const tokens = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), 'styles/tokens.css'),
      'utf8',
    );
    const declared = /--c-on-ground-2:\s*([^;]+);/.exec(tokens);
    expect(declared, 'no --c-on-ground-2 in styles/tokens.css').not.toBeNull();
    expect(
      tooltipColor(lightInk, 'quietOnDark'),
      'QUIET_ON_DARK in chartTooltip.ts no longer matches --c-on-ground-2 in styles/tokens.css',
    ).toBe(declared?.[1].trim());
  });
});

describe('the props the module hands recharts', () => {
  /*
   * The whole object, field by field, against what `ChartPlot` and `AccountFlows`
   * hand-rolled before the refit. It is the only automatic hold on that refit: nothing
   * in jsdom renders either chart, so a regression in how those two files USE this
   * object is invisible to the suite and is answered by a person looking at the screen.
   */
  it.each(PALETTES)(
    'is what the two money charts drew before the refit, plus the bar cursor’s fill (%s)',
    (_scheme, ink) => {
      const props = tooltipProps(ink, 'surface', tooltipMoney('EUR'));
      // the one deliberate difference from the hand-rolled objects: without a fill a
      // bar chart's cursor is recharts' own `#ccc` slab, which the ranking chart has
      // been drawing all along and which this row hands to a third surface
      expect(props.cursor).toEqual({ stroke: ink.grid, fill: ink.grid, strokeWidth: 1 });
      expect(props.contentStyle).toEqual({
        background: ink.brand,
        border: 'none',
        borderRadius: 'var(--r-md)',
        padding: '8px 12px',
        fontSize: 12,
      });
      expect(props.labelStyle).toEqual({ color: 'rgba(255, 255, 255, 0.62)', marginBottom: 2 });
      expect(props.itemStyle).toEqual({ color: ink.onBrand, padding: 0 });
    },
  );

  const entry = (payload: unknown) =>
    ({ payload }) as Parameters<ReturnType<typeof tooltipProps>['formatter']>[2];

  it('prints money in the chart’s own currency', () => {
    const props = tooltipProps(lightInk, 'surface', tooltipMoney('UAH'));
    expect(props.formatter(-2690.5, 'Expenses', entry({}))).toBe('−2,690.50 UAH');
  });

  it('reads the figure off the datum, not off the value the series was drawn at', () => {
    const props = tooltipProps<{ actual: number }>(lightInk, 'page', (_value, m) =>
      m ? tooltipPercent(m.actual) : NO_FIGURE,
    );
    expect(props.formatter(150, 'drawn', entry({ actual: 340 }))).toBe('340%');
  });

  it('says nothing rather than throwing when there is no datum', () => {
    const props = tooltipProps<{ actual: number }>(lightInk, 'page', (_value, m) =>
      m ? tooltipPercent(m.actual) : NO_FIGURE,
    );
    // the literal and not the constant: the claim is that the fallback is not a
    // number, and `NO_FIGURE` on both sides is green over a `'0%'` that says a month
    // recharts handed no datum for was 0% self-sufficient
    expect(props.formatter(150, 'drawn', entry(undefined))).toBe('—');
  });
});

/*
 * Four JSX attributes, read as text.
 *
 * Recharts takes `nameKey`, `dataKey` and `name` as strings it looks up on a datum and
 * never checks, so `tsc` holds none of these and nothing that renders can either — a
 * chart in jsdom is a 0x0 box. Each of the four was measured green after being changed
 * to something wrong, which is what puts them here.
 *
 * This is a PIN LIST over four named attributes and not an enumeration of a boundary:
 * a fifth attribute added tomorrow is not covered by this and is not meant to be. The
 * source-reading idiom is `web/src/copy.test.ts`'s, resolving from `import.meta.url`
 * rather than `process.cwd()` for the reason its header gives — the root of the lookup
 * is the directory this file sits in.
 */
describe('what a reader is told when they point, which lives only in a JSX attribute', () => {
  const read = (path: string): string =>
    readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), path), 'utf8');

  const PINS: [file: string, attribute: string, whatGoesWrong: string][] = [
    [
      'components/SpendingByCategory.tsx',
      'nameKey="label"',
      'the Overview ring prints the slug — `food`, not `Food`',
    ],
    [
      'screens/IndependenceScreen.tsx',
      'dataKey="drawn"',
      'the Goal bars draw the uncapped ratio, and one 1298% month flattens the rest into the axis',
    ],
    [
      'screens/IndependenceScreen.tsx',
      'name="Self-sufficiency"',
      'the Goal tooltip prints `drawn : 340%`, a field name of ours in front of the reader',
    ],
    [
      'components/ChartPlot.tsx',
      'name={rankingSeriesName(spec.breakdown)}',
      'the ranking chart answers `value : 1,082 EUR`',
    ],
  ];

  it.each(PINS)('%s keeps %s', (file, attribute, whatGoesWrong) => {
    expect(read(file), `${file} lost ${attribute}: ${whatGoesWrong}`).toContain(attribute);
  });
});
