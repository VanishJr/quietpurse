/**
 * The `<Tooltip>` every chart in this app is handed, and the grounds it is drawn on.
 *
 * Four surfaces draw a chart. Two of them hand-rolled a tooltip object and the other
 * two answered nothing at all when you pointed at them — which is the divergence row
 * 40 is about rather than the absence, since a reader who learns that pointing works
 * on the Account screen learns it wrongly for the Overview. A fifth surface takes the
 * object from here or does not get one.
 *
 * ---------------------------------------------------------------------------
 * A ground is not decoration
 *
 * The ground is the background of the box the chart is painted in, and it is what
 * decides the tooltip's colours. `brand` is the navy the two money charts have drawn
 * their tooltip in since the cards were drawn, and it is correct on `surface` and on
 * `page` — but the Overview's spending card is a `panel` fill, and in dark mode
 * `panel` and `brand` are the same value (`theme.tsx:115` and `:119`, deliberately),
 * while in light mode they are two navies 1.20:1 apart. Copied unchanged onto that
 * card the tooltip is painted in the card's own colour.
 *
 * So a ground carries a fill AND the two colours that go on it, as one value: the
 * text does not survive the move on its own either — `onBrand` is `#ffffff` in light
 * mode, which on a `surface` fill is white on white. Each ground is named for the
 * `Ink` key of its own fill, so nothing here states twice what colour a card is, and
 * a ground added to the union without a chip does not compile.
 *
 * ---------------------------------------------------------------------------
 * .ts and not .tsx, on purpose
 *
 * `web/vitest.config.ts` binds the project to the filename, so this is checked in
 * `unit` against both palettes at once. In `dom` it could be checked against neither:
 * recharts measures a 0x0 box in jsdom and draws no tooltip at all, so a test that
 * mounts a chart and asserts on its tooltip passes whatever ships.
 */
import { fmtMoney } from './format';
import { Ink } from './theme';
import type { TooltipProps } from 'recharts';

/** The backgrounds this app paints a chart on. Each is the `Ink` key of its own fill. */
export type TooltipGround = 'surface' | 'panel' | 'page';

/**
 * `--c-on-ground-2` from `styles/tokens.css`, copied because a `var()` reference
 * resolves in an inline style but resolves to nothing a `unit` test can hold against
 * a fill — it would be compared as the literal string `"var(…)"` and pass by being
 * unequal to every colour. The copy is pinned to the token by a case in
 * `chartTooltip.test.ts`; the token is the source of truth and this is not.
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
 * because both of `NAVY`'s whites are 1.00:1 on it in light mode.
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

/** What the three money surfaces print: the value in the chart's own currency. */
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
     * One object for two shapes. Recharts draws the cursor as a two-point `Curve` on
     * a line or area chart, where only the stroke is ever seen, and as a filled
     * `Rectangle` across the band on a bar chart, whose own default is `#ccc`
     * (`util/cursor/getCursorRectangle.js`) — a mid-grey that is wrong on a white card
     * and a slab on a dark page. This object is spread after that default, so the fill
     * lands. It is the grid's colour rather than a chip's: the band is painted on the
     * plotting area, which is the ground the chart sits on and not the tooltip's own.
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
