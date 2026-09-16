/**
 * The `<Tooltip>` every chart in this app is handed, and the grounds it is drawn on: a
 * ground carries a fill AND the two colours that go on it, as one value, because the
 * ground is what decides the tooltip's colours.
 */
import { fmtMoney } from './format';
import { Ink } from './theme';
import type { TooltipProps } from 'recharts';

/** The backgrounds this app paints a chart on. Each is the `Ink` key of its own fill. */
export type TooltipGround = 'surface' | 'panel' | 'page';

/**
 * `--c-on-ground-2` from `styles/tokens.css`, copied because a `var()` reference
 * resolves in an inline style but to nothing a `unit` test can hold against a fill —
 * compared as the literal string `"var(…)"` it passes by being unequal to every colour.
 * The token is the source of truth and this is not; `chartTooltip.test.ts` pins the copy.
 */
const QUIET_ON_DARK = 'rgba(255, 255, 255, 0.62)';

/** A colour a tooltip paints with: a palette key, or the quiet white no key carries. */
export type TooltipColor = keyof Ink | 'quietOnDark';

export const tooltipColor = (ink: Ink, color: TooltipColor): string =>
  color === 'quietOnDark' ? QUIET_ON_DARK : ink[color];

/** A fill and the two colours that are readable on it. One decision, not three. */
interface TooltipChip {
  fill: keyof Ink;
  /** the series name, quieter than its figure */
  label: TooltipColor;
  /** the figure itself */
  item: TooltipColor;
}

/** The navy the money charts have always drawn: 16.13:1 on `surface` in light, 1.36:1 in dark. */
const NAVY: TooltipChip = { fill: 'brand', label: 'quietOnDark', item: 'onBrand' };

/**
 * For the one card that is itself a dark navy in both schemes. A `surface` fill clears
 * it at 19.31:1 in light and 1.36:1 in dark — the same separation `brand` on `surface`
 * has shipped with since the flows card was drawn — and the text inverts with the fill,
 * because both of `NAVY`'s whites vanish on a white fill.
 */
const LIGHT: TooltipChip = { fill: 'surface', label: 'secondary', item: 'primary' };

export const TOOLTIP_CHIP: Record<TooltipGround, TooltipChip> = {
  surface: NAVY,
  page: NAVY,
  panel: LIGHT,
};

/**
 * What a formatter prints when recharts hands it no datum. `payload` is optional on a
 * tooltip entry, and the one formatter here that reads a field off it would throw
 * during render rather than print a wrong number — a tooltip that throws takes the
 * screen with it. Money never reads the datum and is unaffected.
 */
export const NO_FIGURE = '—';

/** The value in the chart's own currency. */
export const tooltipMoney =
  (currency: string) =>
  (value: number): string =>
    fmtMoney(value, currency);

/** What the Goal screen prints. A required argument and never a default: that chart is
 *  percentages and every other one in this app is money. */
export const tooltipPercent = (value: number): string => `${value}%`;

/**
 * `format` is handed the datum as well as the value because they are not always the
 * same claim: a bar's drawn height may be clamped where the figure the reader is owed
 * is not, and recharts only ever passes a formatter the value at the series' `dataKey`.
 */
export function tooltipProps<T>(
  ink: Ink,
  ground: TooltipGround,
  format: (value: number, datum: T | undefined) => string,
) {
  const chip = TOOLTIP_CHIP[ground];
  return {
    /*
     * One object for two shapes: on a line or area chart only the stroke is ever seen,
     * and on a bar chart the cursor is a filled band whose fill is set here because the
     * library's own default for it was measured wrong on both grounds — a mid-grey that
     * is wrong on a white card and a slab on a dark page. It is the grid's colour rather
     * than a chip's: the band is painted on the plotting area, which is the ground the
     * chart sits on and not the tooltip's own.
     */
    cursor: { stroke: ink.grid, fill: ink.grid, strokeWidth: 1 },
    contentStyle: {
      background: ink[chip.fill],
      border: 'none',
      borderRadius: 'var(--r-md)',
      padding: '8px 12px',
      fontSize: 12,
    },
    labelStyle: { color: tooltipColor(ink, chip.label), marginBottom: 2 },
    itemStyle: { color: tooltipColor(ink, chip.item), padding: 0 },
    formatter: (value, _name, item) => format(Number(value), item.payload as T | undefined),
  } satisfies TooltipProps;
}
