/**
 * One `Chart` and its data, drawn.
 *
 * Six kinds, one component, because everything around a plot is the same whichever it
 * is: the axis colours, the tooltip, the "animation off" rule, the legend of swatches
 * and the empty state. Six components would be six copies of that agreeing until one
 * of them was edited.
 *
 * It draws and nothing else. It fetches nothing (`chartData.ts` does), it decides
 * nothing about what the chart is about (`analytics.ts` does), and it holds no state —
 * which is what lets the wizard render the very chart being configured as a live
 * preview, at a smaller height, from the same file the card uses.
 *
 * ---------------------------------------------------------------------------
 * Colour
 *
 * A series is coloured by what it MEANS: income is `good` and expenses are `accent` on
 * every screen in this app, and `METRICS` carries the palette key so this file does not
 * get a vote. A share is coloured by category, from the same `categoryColor` the
 * Overview's donut and the old breakdown legend use, so one category is one colour
 * across the whole app.
 *
 * Income sources are the exception and have to be: they are rows the user created, with
 * ids no palette knows. They take colours off the category ramp by position — distinct
 * from each other, stable for as long as the list is, and never claiming that "Salary"
 * the source is "Salary" the category.
 *
 * ---------------------------------------------------------------------------
 * Animation
 *
 * Off on every series, for the reason AnalyticsScreen has given since it was one
 * screen: every screen in this app stays mounted, so a chart first renders inside a
 * hidden container, and an animation started there freezes at an arbitrary frame and
 * keeps that wrong height once the screen is shown.
 */
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  Radar,
  RadarChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { drawnShares, METRICS, rankingSeriesName, SharePoint } from '../analytics';
import { ChartData } from '../chartData';
import { CATEGORY_LABELS } from '../categories';
import { tooltipMoney, tooltipProps } from '../chartTooltip';
import { fmtMoney, fmtShort, niceMax } from '../format';
import { useTheme } from '../theme';
import { Chart } from '../types';

/** The gutter the value axis takes, the same on every plot that has one. */
const Y_AXIS_WIDTH = 52;

/** …and on the ranking, where the axis carries names instead and needs the room. */
const NAME_AXIS_WIDTH = 104;

/**
 * Up to this many ticks the points are drawn as well as joined — the rule
 * `AccountFlows` already applies, and for its reasons: at one tick a path through a
 * single point paints nothing at all, and past a handful the discs are noise.
 */
const DOTTED_UP_TO = 3;

/**
 * Category slugs the ramp is walked in for keys no palette knows — income sources,
 * which are rows the user made. Slugs rather than hexes so the two schemes keep
 * answering for themselves; `categoryColor` is what turns one into a colour.
 */
const RAMP = [
  'food',
  'transport',
  'subscriptions',
  'health',
  'shopping',
  'cash',
  'entertainment',
  'housing',
  'cashback',
  'salary',
];

interface Props {
  spec: Chart;
  data: ChartData;
  height: number;
}

export function ChartPlot({ spec, data, height }: Props) {
  const { ink, categoryColor } = useTheme();

  const axisTick = { fill: ink.muted, fontSize: 11 };
  /* `'surface'` for both grounds this file is drawn on: a chart card is a surface and
     the wizard's live preview is the page, and they take the same chip today.
     `chartTooltip.test.ts` is what says that shortcut is still safe. */
  const tooltip = tooltipProps(ink, 'surface', tooltipMoney(data.currency));

  const sliceColor = (key: string, index: number): string =>
    categoryColor(CATEGORY_LABELS[key] ? key : RAMP[index % RAMP.length]);

  if (data.shape === 'series') {
    const { points } = data;
    const drawn = METRICS.filter((m) => spec.metrics.includes(m.key));
    /*
     * No measure is ticked. The wizard will not let a chart be SAVED in this state and
     * says so in red under the chips — this is the same fact seen from the plot's side,
     * and it is what the live preview shows while the reader is between two choices. An
     * axis with no series on it would read as a load that failed.
     */
    if (drawn.length === 0) {
      return <PlotEmpty text="No measure picked." />;
    }
    const values = points.flatMap((p) => drawn.map((m) => p[m.key]));
    const top = niceMax(Math.max(0, ...values));
    const lowest = Math.min(0, ...values);
    /*
     * A floor only when something is actually below zero — Net goes negative in a
     * month that spent more than it earned, and an axis pinned at 0 would clip the
     * one figure the chart was made to show. Symmetric rounding, so the zero line
     * lands on a grid line rather than between two.
     */
    const bottom = lowest < 0 ? -niceMax(Math.abs(lowest)) : 0;
    const domain: [number, number] = [bottom, top];
    const dot = points.length <= DOTTED_UP_TO ? { r: 3.5, strokeWidth: 0 } : false;

    /*
     * An array and not a fragment. Recharts reads its own children to work out what
     * the chart is made of, and while it does flatten fragments today, an array is
     * what `React.Children` flattens on its own — one fewer thing about this plot that
     * depends on a traversal helper inside a dependency.
     */
    const axes = [
      <CartesianGrid key="grid" stroke={ink.grid} strokeDasharray="3 4" vertical={false} />,
      <XAxis
        key="x"
        dataKey="label"
        tick={axisTick}
        axisLine={{ stroke: ink.grid }}
        tickLine={false}
        // an axis of 24 months is more ticks than there are pixels for; recharts
        // drops what does not fit rather than overprinting them
        interval="preserveStartEnd"
        minTickGap={6}
      />,
      <YAxis
        key="y"
        domain={domain}
        tickCount={5}
        tick={axisTick}
        axisLine={false}
        tickLine={false}
        width={Y_AXIS_WIDTH}
        tickFormatter={fmtShort}
      />,
      <Tooltip key="tip" {...tooltip} />,
      ...(bottom < 0
        ? [<ReferenceLine key="zero" y={0} stroke={ink.muted} strokeWidth={1} />]
        : []),
    ];

    return (
      <>
        <div className="chart-legend">
          {drawn.map((m) => (
            <span key={m.key} className="acct-legend-item">
              <span className="swatch" style={{ background: ink[m.ink] }} />
              {m.label}
            </span>
          ))}
        </div>
        <div className="chart-plot" style={{ height }} aria-hidden="true">
          <ResponsiveContainer width="100%" height="100%">
            {spec.kind === 'column' ? (
              <BarChart data={points} margin={{ top: 8, right: 10, bottom: 0, left: 0 }}>
                {axes}
                {drawn.map((m) => (
                  <Bar
                    key={m.key}
                    name={m.label}
                    dataKey={m.key}
                    fill={ink[m.ink]}
                    radius={[3, 3, 0, 0]}
                    maxBarSize={38}
                    isAnimationActive={false}
                  />
                ))}
              </BarChart>
            ) : spec.kind === 'area' ? (
              <AreaChart data={points} margin={{ top: 8, right: 10, bottom: 0, left: 0 }}>
                {axes}
                {drawn.map((m) => (
                  <Area
                    key={m.key}
                    name={m.label}
                    dataKey={m.key}
                    type="monotone"
                    stroke={ink[m.ink]}
                    strokeWidth={2.5}
                    fill={ink[m.ink]}
                    // stacked fills would read as a total; these are three separate
                    // answers about the same months and they are allowed to overlap
                    fillOpacity={0.16}
                    dot={dot}
                    activeDot={{ r: 4.5, strokeWidth: 0 }}
                    isAnimationActive={false}
                  />
                ))}
              </AreaChart>
            ) : (
              <LineChart data={points} margin={{ top: 8, right: 10, bottom: 0, left: 0 }}>
                {axes}
                {drawn.map((m) => (
                  <Line
                    key={m.key}
                    name={m.label}
                    dataKey={m.key}
                    type="monotone"
                    stroke={ink[m.ink]}
                    strokeWidth={2.5}
                    dot={dot}
                    activeDot={{ r: 4.5, strokeWidth: 0 }}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            )}
          </ResponsiveContainer>
        </div>
      </>
    );
  }

  if (spec.kind === 'radar') {
    /*
     * `compared` is null when a comparative kind was drawn from a load that did not
     * fetch the second window — which nothing does today, and is exactly the state a
     * future kind added to `CHART_KINDS` without its loader would arrive in. Drawing
     * the current period alone would be a chart missing half its subject without
     * saying so.
     *
     * Both sides arrive with the negatives already out of them: a radius below zero is
     * drawn mirrored through the centre, and `chartData.ts` is where that is taken off
     * because it is the one place `compared` is built. Nothing to filter here.
     */
    const rows = data.compared;
    if (!rows || rows.length === 0) return <PlotEmpty />;
    return (
      <>
        <div className="chart-legend">
          <span className="acct-legend-item">
            <span className="swatch" style={{ background: ink.accent }} /> This period
          </span>
          <span className="acct-legend-item">
            <span className="swatch" style={{ background: ink.muted }} /> The one before
          </span>
        </div>
        <div className="chart-plot" style={{ height }} aria-hidden="true">
          <ResponsiveContainer width="100%" height="100%">
            <RadarChart data={rows} outerRadius="72%">
              <PolarGrid stroke={ink.grid} />
              <PolarAngleAxis dataKey="label" tick={{ fill: ink.muted, fontSize: 10 }} />
              <Tooltip {...tooltip} />
              <Radar
                name="The one before"
                dataKey="before"
                stroke={ink.muted}
                strokeWidth={1.5}
                fill={ink.muted}
                fillOpacity={0.12}
                isAnimationActive={false}
              />
              <Radar
                name="This period"
                dataKey="now"
                stroke={ink.accent}
                strokeWidth={2}
                fill={ink.accent}
                fillOpacity={0.2}
                isAnimationActive={false}
              />
            </RadarChart>
          </ResponsiveContainer>
        </div>
      </>
    );
  }

  if (spec.kind === 'ranking') {
    const rows = data.slices;
    if (rows.length === 0) return <PlotEmpty />;
    return (
      <div className="chart-plot" style={{ height }} aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={rows}
            layout="vertical"
            margin={{ top: 4, right: 16, bottom: 0, left: 0 }}
          >
            <CartesianGrid stroke={ink.grid} strokeDasharray="3 4" horizontal={false} />
            <XAxis
              type="number"
              tick={axisTick}
              axisLine={false}
              tickLine={false}
              tickFormatter={fmtShort}
            />
            <YAxis
              type="category"
              dataKey="label"
              tick={axisTick}
              axisLine={false}
              tickLine={false}
              width={NAME_AXIS_WIDTH}
            />
            <Tooltip {...tooltip} />
            {/* a refund can push a row negative, and a bar chart is the one shape
                here that can say so — the zero line is what makes it readable */}
            <ReferenceLine x={0} stroke={ink.muted} strokeWidth={1} />
            {/* named for the same reason the Goal screen's bar is: a series with no
                `name` is announced by its `dataKey`, and `value : 1,082 EUR` is a
                field of this file's own vocabulary put in front of the reader */}
            <Bar
              dataKey="value"
              name={rankingSeriesName(spec.breakdown)}
              radius={[0, 3, 3, 0]}
              maxBarSize={22}
              isAnimationActive={false}
            >
              {rows.map((r, i) => (
                <Cell key={r.key} fill={sliceColor(r.key, i)} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  // the donut
  const sectors: SharePoint[] = drawnShares(spec.kind, data.slices);
  if (sectors.length === 0) return <PlotEmpty />;
  const total = sectors.reduce((sum, s) => sum + s.value, 0);

  /*
   * The ring is hidden as one piece, `.donut-center` included — the same wrapping, for
   * the same reason, that `SpendingByCategory` gives at length over its own ring. It is
   * an SVG no screen reader can read, and the total in the hole is painted over it; both
   * are stood in for by the figures above the plot and the table under it, which
   * `ChartCard` renders for every chart. Left announced, the centre reads the card's
   * own "Total" back out a second time.
   */
  return (
    <>
      {/*
       * The ring's key, and the only thing on the card that names a sector. The figures
       * above name the largest one and the table below is not on screen, so without this
       * a donut is a circle of colours with a total in it — and the tooltip that would
       * otherwise answer "which wedge is Transport" needs a hover a phone has not got.
       *
       * Every sector, not the top few: the three breakdowns are all closed sets (the
       * category list, or the reader's own accounts), so there is no tail to fold away.
       * Discs rather than the series legend's squares — the shape this app gives a
       * category everywhere it draws one.
       */}
      <div className="chart-legend">
        {sectors.map((s, i) => (
          <span key={s.key} className="acct-legend-item">
            <span className="dot" style={{ background: sliceColor(s.key, i) }} />
            {s.label}
          </span>
        ))}
      </div>
      <div className="chart-wrap chart-plot" style={{ height }} aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={sectors}
              dataKey="value"
              nameKey="label"
              innerRadius="62%"
              outerRadius="94%"
              stroke={ink.surface}
              strokeWidth={2}
              isAnimationActive={false}
            >
              {sectors.map((s, i) => (
                <Cell key={s.key} fill={sliceColor(s.key, i)} />
              ))}
            </Pie>
            <Tooltip {...tooltip} />
          </PieChart>
        </ResponsiveContainer>
        {/* the total belongs in the hole: it is what the sectors are shares OF, and
            putting it anywhere else makes the reader hold two numbers at once */}
        <div className="donut-center">
          <div className="donut-value">{fmtMoney(total)}</div>
          <div className="donut-currency">{data.currency}</div>
        </div>
      </div>
    </>
  );
}

/**
 * A sentence where the plot would be. Always a sentence and never an empty axis: axes
 * with no marks on them read as a chart that failed, where "this month was quiet" and
 * "you have not said what to draw" are both ordinary answers — and the three are not
 * the same thing to somebody deciding whether to trust the screen.
 */
const PlotEmpty = ({ text = 'Nothing in this period.' }: { text?: string }) => (
  <p className="empty chart-empty">{text}</p>
);
