import { fmtMoney } from './format';
import { Ink } from './theme';
import type { TooltipProps } from 'recharts';

/** The backgrounds this app paints a chart on. Each is the `Ink` key of its own fill. */
export type TooltipGround = 'surface' | 'panel' | 'page';

export type TooltipColor = keyof Ink;

export const tooltipColor = (ink: Ink, color: TooltipColor): string => ink[color];

interface TooltipChip {
  fill: keyof Ink;
  label: TooltipColor;
  item: TooltipColor;
}

const RAISED: TooltipChip = { fill: 'raised', label: 'secondary', item: 'primary' };

export const TOOLTIP_CHIP: Record<TooltipGround, TooltipChip> = {
  surface: RAISED,
  page: RAISED,
  panel: RAISED,
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
      border: `1px solid ${ink.border}`,
      borderRadius: 'var(--r-md)',
      padding: '8px 12px',
      fontSize: 12,
    },
    labelStyle: { color: tooltipColor(ink, chip.label), marginBottom: 2 },
    itemStyle: { color: tooltipColor(ink, chip.item), padding: 0 },
    formatter: (value, _name, item) => format(Number(value), item.payload as T | undefined),
  } satisfies TooltipProps;
}
