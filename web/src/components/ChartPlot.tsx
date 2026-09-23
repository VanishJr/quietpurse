/**
 * One `Chart` and its data, drawn.
 *
 * Every kind in one component, because what surrounds a plot — the axis colours, the
 * tooltip, the animation rule, the empty state — is the same whichever kind it is, and
 * a component per kind would be a copy of it per kind, agreeing until one of them was
 * edited. It holds no state and fetches nothing, and animation is off on every series:
 * `web/src/SPEC.md` gives both reasons under *What a chart is, and where its numbers
 * come from*, and how a series and a slice are coloured under *The palette, and what
 * leaves the page*.
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
import { tooltipMoney, tooltipProps, type TooltipGround } from '../chartTooltip';
import { fmtMoney, fmtShort, niceMax } from '../format';
import { useTheme } from '../theme';
import { Chart } from '../types';

const Y_AXIS_WIDTH = 52;

const NAME_AXIS_WIDTH = 104;

/**
 * Up to this many ticks the points are drawn as well as joined: at one tick a path
 * through a single point paints nothing at all, and past a handful the discs are noise.
 */
const DOTTED_UP_TO = 3;

/**
 * Category slugs the ramp is walked in, by position, for a key that is not a category
 * slug. Slugs rather than hexes so the two schemes keep answering for themselves;
 * `categoryColor` is what turns one into a colour.
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
  ground: TooltipGround;
}

export function ChartPlot({ spec, data, height, ground }: Props) {
  const { ink, categoryColor } = useTheme();

  const axisTick = { fill: ink.muted, fontSize: 11 };
  const tooltip = tooltipProps(ink, ground, tooltipMoney(data.currency));

  const sliceColor = (key: string, index: number): string =>
    categoryColor(CATEGORY_LABELS[key] ? key : RAMP[index % RAMP.length]);

  if (data.shape === 'series') {
    const { points } = data;
    const drawn = METRICS.filter((m) => spec.metrics.includes(m.key));
    /*
     * No measure is ticked, which is what the wizard's preview shows while the reader is
     * between two choices. An axis with no series on it would read as a load that failed.
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
     * one figure the chart was made to show.
     */
    const bottom = lowest < 0 ? -niceMax(Math.abs(lowest)) : 0;
    const domain: [number, number] = [bottom, top];
    const dot = points.length <= DOTTED_UP_TO ? { r: 3.5, strokeWidth: 0 } : false;

    const axes = [
      <CartesianGrid key="grid" stroke={ink.grid} strokeDasharray="3 4" vertical={false} />,
      <XAxis
        key="x"
        dataKey="label"
        tick={axisTick}
        axisLine={{ stroke: ink.grid }}
        tickLine={false}
        // a long window is more ticks than there are pixels for; recharts drops what
        // does not fit rather than overprinting them
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
                    // stacked fills would read as a total; these are separate answers
                    // about the same months and they are allowed to overlap
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
     * fetch the second window, which is the state a kind added to `CHART_KINDS` without
     * its loader would arrive in. Drawing the current period alone would be a chart
     * missing half its subject without saying so.
     *
     * Both sides arrive with the negatives already out of them, so nothing is filtered
     * here.
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
            {/* a refund can push a row negative, and the ranking keeps it where the
                donut and the radar drop it — the zero line is what makes it readable */}
            <ReferenceLine x={0} stroke={ink.muted} strokeWidth={1} />
            {/* named because a series with no `name` is announced in the tooltip by its
                `dataKey`, and `value` is a field of this file's own vocabulary put in
                front of the reader */}
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

  const sectors: SharePoint[] = drawnShares(spec.kind, data.slices);
  if (sectors.length === 0) return <PlotEmpty />;
  const total = sectors.reduce((sum, s) => sum + s.value, 0);

  /*
   * The ring is hidden as one piece, `.donut-center` included: it is an SVG no screen
   * reader can read, and the total in the hole is painted over it. Left announced, the
   * centre reads the card's own "Total" back out a second time.
   */
  return (
    <>
      {/*
       * The ring's key, and the one place on screen that names every sector: the figures
       * above name the largest and the table below is not on screen, so without this a
       * donut is a circle of colours with a total in it — and the tooltip that would
       * otherwise answer "which wedge is Transport" needs a hover a phone has not got.
       *
       * Every sector, not the top few: the category list and the reader's own income
       * sources are closed sets, so there is no tail to fold away. Discs rather than the
       * series legend's squares, the mark a category is drawn with elsewhere too.
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
