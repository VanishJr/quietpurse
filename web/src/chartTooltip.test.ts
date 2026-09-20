import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TOOLTIP_CHIP, TooltipGround, tooltipMoney, tooltipProps } from './chartTooltip';
import { darkInk, Ink, lightInk } from './theme';

const PALETTES: [string, Ink][] = [
  ['light', lightInk],
  ['dark', darkInk],
];

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

function contrast(text: string, ground: string): number {
  const back = parse(ground, [0, 0, 0]);
  const front = parse(text, back);
  const [hi, lo] = [luminance(front), luminance(back)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT_FLOOR = 4.5;

const GROUNDS = Object.keys(TOOLTIP_CHIP) as TooltipGround[];

describe('a tooltip is never painted in the colour of the ground it is drawn on', () => {

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

  it.each(GROUNDS)('%s: both text colours are readable on the fill, in both palettes', (ground) => {
    for (const [scheme, ink] of PALETTES) {
      // the fill and both texts as the factory composed them, for the reason above
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

  it('surface and page take the same chip, which is what lets ChartPlot pass one of them', () => {
    expect(TOOLTIP_CHIP.surface).toEqual(TOOLTIP_CHIP.page);
  });

  /*
   * The fill sits a step off its ground on purpose and the border is what makes the box
   * a box, so the string inequality above is the only other hold on the tightest live
   * pair. A pin on the measured figures and not a floor: a floor bounds what the design
   * may become and reds for a reason nobody reading it could connect to a tooltip, where
   * a pin says the numbers written down are stale — re-measure them. Precision 2, because
   * a palette step of two hex values moves these by a few hundredths.
   */
  it('the tightest fill on its ground, and the border between them, are the figures written here', () => {
    const shipped: [string, number, number][] = [
      ['raised on surface, dark', contrast(darkInk.raised, darkInk.surface), 1.102],
      ['border on surface, dark', contrast(darkInk.border, darkInk.surface), 1.387],
      ['raised on page, light', contrast(lightInk.raised, lightInk.page), 1.075],
      ['border on page, light', contrast(lightInk.border, lightInk.page), 1.244],
    ];
    for (const [what, measured, written] of shipped) {
      expect(measured, `${what}: the figure written down is no longer the measurement`).toBeCloseTo(
        written,
        2,
      );
    }
  });
});

describe('the props the module hands recharts', () => {

  it.each(PALETTES)(
    'hands recharts the raised fill, the border, both text colours and the bar cursor’s fill (%s)',
    (_scheme, ink) => {
      const props = tooltipProps(ink, 'surface', tooltipMoney('EUR'));
      // without a fill a bar chart's cursor is recharts' own `#ccc` slab
      expect(props.cursor).toEqual({ stroke: ink.grid, fill: ink.grid, strokeWidth: 1 });
      expect(props.contentStyle).toEqual({
        background: ink.raised,
        border: `1px solid ${ink.border}`,
        borderRadius: 'var(--r-md)',
        padding: '8px 12px',
        fontSize: 12,
      });
      expect(props.labelStyle).toEqual({ color: ink.secondary, marginBottom: 2 });
      expect(props.itemStyle).toEqual({ color: ink.primary, padding: 0 });
    },
  );

  it('prints money in the chart’s own currency', () => {
    const props = tooltipProps(lightInk, 'surface', tooltipMoney('UAH'));
    expect(props.formatter(-2690.5)).toBe('−2,690.50 UAH');
  });
});

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
      'components/ChartPlot.tsx',
      'name={rankingSeriesName(spec.breakdown)}',
      'the ranking chart answers `value : 1,082 EUR`',
    ],
  ];

  it.each(PINS)('%s keeps %s', (file, attribute, whatGoesWrong) => {
    expect(read(file), `${file} lost ${attribute}: ${whatGoesWrong}`).toContain(attribute);
  });
});
