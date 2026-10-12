/**
 * `ChartGlyph`'s drawings are not icons and they are not thumbnails. An icon would be a
 * symbol standing for "chart"; a thumbnail would be the reader's own data, which nothing
 * knows before the shape has been chosen. These are the SHAPE: a line drawing of what
 * the plot will look like. That is the only thing the first step of the wizard asks
 * about, and a name plus a sentence is a slow way to say "bars" to somebody who would
 * recognise bars.
 *
 * One viewBox for every shape, so they line up in the grid whatever the tile does to its
 * width. Wider than it is tall, because a plot is.
 */

const box = {
  viewBox: '0 0 44 30',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

const Baseline = () => <path d="M4 27h36" strokeWidth={1.2} opacity={0.4} />;

const Line = () => (
  <svg {...box}>
    <Baseline />
    <path d="M6 21l8-7 7 5 9-12 8 6" />
  </svg>
);

const Column = () => (
  <svg {...box}>
    <Baseline />
    <g fill="currentColor" stroke="none">
      <rect x="6" y="16" width="6" height="10" rx="1.5" />
      <rect x="16" y="9" width="6" height="17" rx="1.5" />
      <rect x="26" y="18" width="6" height="8" rx="1.5" />
      <rect x="36" y="5" width="4" height="21" rx="1.5" />
    </g>
  </svg>
);

const Area = () => (
  <svg {...box}>
    <Baseline />
    <path
      d="M6 21l8-7 7 5 9-12 8 6v13H6z"
      fill="currentColor"
      stroke="none"
      opacity={0.22}
    />
    <path d="M6 21l8-7 7 5 9-12 8 6" />
  </svg>
);

const Donut = () => (
  <svg {...box}>
    <circle cx="22" cy="15" r="10" strokeWidth={5} opacity={0.28} />
    {/* one sector lit, which is the whole of what a donut says that a circle does not */}
    <path d="M22 5a10 10 0 016.43 17.66" strokeWidth={5} />
  </svg>
);

const Ranking = () => (
  <svg {...box}>
    <path d="M6 4v23" strokeWidth={1.2} opacity={0.4} />
    <g fill="currentColor" stroke="none">
      <rect x="8" y="6" width="31" height="5" rx="2.5" />
      <rect x="8" y="13" width="21" height="5" rx="2.5" />
      <rect x="8" y="20" width="12" height="5" rx="2.5" />
    </g>
  </svg>
);

const Radar = () => (
  <svg {...box}>
    <polygon points="22,4 31.5,9.5 31.5,20.5 22,26 12.5,20.5 12.5,9.5" strokeWidth={1.2} opacity={0.4} />
    <polygon points="22,7 29,11 27,20 22,22.5 15.5,19 16,11" fill="currentColor" fillOpacity={0.18} />
  </svg>
);

const GLYPHS = { line: Line, column: Column, area: Area, donut: Donut, ranking: Ranking, radar: Radar };

export type GlyphName = keyof typeof GLYPHS;

export const ChartGlyph = ({ kind }: { kind: GlyphName }) => {
  const Shape = GLYPHS[kind];
  return <Shape />;
};

/**
 * Deliberately not one of the shapes. The panel it heads says there is no chart yet,
 * and one of the shapes there would look like a chart that failed to load.
 */
export const BlankPlotGlyph = () => (
  <svg
    viewBox="0 0 64 44"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M8 4v34h48" opacity={0.55} />
    <path d="M16 34h40M16 24h40M16 14h40" strokeWidth={1.1} strokeDasharray="2 5" opacity={0.4} />
  </svg>
);
