/**
 * Income and expenses by calendar month, for one account.
 *
 * The window is 3, 6 or 12 months, and what it actually draws is however many of
 * those the account has — see `monthlyTotals`, which never pads the range with months
 * that predate the first statement. A bar for a month before anything was uploaded is
 * a claim that nothing happened then, and nothing in this app knows that.
 *
 * So the first users, who have one statement, get one month, and nothing on the card
 * apologises for it: the range beside the heading says which months these are, and a
 * reader who has uploaded one statement knows why there is one. It is drawn by the
 * same chart as twelve — `maxBarSize` keeps a lone month from becoming a slab across
 * the whole card. What makes one month legible is that it still shows income against
 * expenses — two bars, which is a comparison; a single total would be a number with a
 * rectangle drawn round it.
 *
 * The one thing still said in words is the opposite case: a window the request cut
 * short. That is not the account being young, it is the figures being wrong.
 */
import { Bar, BarChart, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { MonthTotal, MonthWindow, MONTH_WINDOWS } from '../accounts';
import { fmtMoney, fmtMonthKey, fmtMonthTick, fmtShort, niceMax } from '../format';
import { useTheme } from '../theme';
import { Chips } from './Chips';

/** Wide enough to read, narrow enough that one month does not fill the card. */
const MAX_BAR_WIDTH = 26;
const CHART_HEIGHT = 200;

/**
 * What one month is worth of chart, and from how many months the chart takes the
 * whole card.
 *
 * A bar chart stretched to a card it has three months of data for is what "a chart of
 * one column looks broken" actually is: recharts spreads the single category band
 * across the full width, the pair of bars lands somewhere inside it that is not over
 * its own tick, and the rest is empty. Sizing the plot to the data instead makes a
 * one-month chart a small deliberate object rather than a wide mostly-empty one — and
 * from four months up it is the full card again, which is where a bar chart earns it.
 */
const MONTH_WIDTH = 104;
const FULL_WIDTH_FROM = 4;

/** The gutter the Y axis takes, which is the same whatever the plot beside it is. */
const Y_AXIS_WIDTH = 52;

interface Props {
  /** Already windowed by `monthlyTotals`. */
  months: MonthTotal[];
  window: MonthWindow;
  onWindow: (w: MonthWindow) => void;
  currency: string;
  /**
   * The fetch came back at its limit, so there may be transactions these months do not
   * include. Silence here would be a chart that is quietly wrong.
   */
  truncated: boolean;
}

export function AccountMonths({ months, window, onWindow, currency, truncated }: Props) {
  const { ink } = useTheme();

  const first = months[0];
  const last = months[months.length - 1];
  const range =
    months.length === 1
      ? fmtMonthKey(first.month)
      : `${fmtMonthKey(first.month)} – ${fmtMonthKey(last.month)}`;

  const bars = months.map((m) => ({ ...m, label: fmtMonthTick(m.month) }));
  const max = niceMax(Math.max(...months.map((m) => Math.max(m.income, m.expense)), 0));
  const axisTick = { fill: ink.muted, fontSize: 10 };

  return (
    <section className="acct-months acct-card" aria-label="By month">
      <div className="header">
        <h2 className="block-title" style={{ margin: 0 }}>
          Expenses and income by month
        </h2>
        <span className="acct-range">{range}</span>
      </div>

      <Chips
        label="Chart range"
        options={MONTH_WINDOWS.map((w) => ({ key: String(w), label: `${w} months` }))}
        selected={String(window)}
        onSelect={(k) => onWindow(Number(k) as MonthWindow)}
      />

      <div className="acct-legend">
        <span className="acct-legend-item">
          <span className="dot" style={{ background: ink.good }} /> Income
        </span>
        <span className="acct-legend-item">
          <span className="dot" style={{ background: ink.accent }} /> Expenses
        </span>
      </div>

      {truncated && (
        <p className="error">
          This account has more transactions than one request returns, so the months below
          are incomplete and the window may be shorter than it should be. Nothing here is
          safe to read as a total.
        </p>
      )}

      {/* The SVG is not readable, and in a test environment it is not even measurable —
          recharts sizes itself against a 0x0 box in jsdom. The table below it carries
          the same numbers, which is what a screen reader gets and what a test asserts
          on; the chart is the same data drawn for eyes. */}
      <div
        className="acct-chart"
        style={{
          height: CHART_HEIGHT,
          // the Y axis keeps its own width whatever the data is; only the plot scales
          maxWidth:
            months.length < FULL_WIDTH_FROM
              ? `${months.length * MONTH_WIDTH + Y_AXIS_WIDTH}px`
              : undefined,
        }}
        aria-hidden="true"
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={bars} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <XAxis
              dataKey="label"
              tick={axisTick}
              axisLine={{ stroke: ink.grid }}
              tickLine={false}
            />
            <YAxis
              domain={[0, max]}
              tickCount={4}
              tick={axisTick}
              axisLine={false}
              tickLine={false}
              width={Y_AXIS_WIDTH}
              tickFormatter={fmtShort}
            />
            {/* animation off for the reason AnalyticsScreen gives: every screen stays
                mounted, so this first renders inside a hidden container and an
                animation started there freezes at an arbitrary frame */}
            <Bar
              dataKey="income"
              fill={ink.good}
              radius={[3, 3, 0, 0]}
              isAnimationActive={false}
              maxBarSize={MAX_BAR_WIDTH}
            />
            <Bar
              dataKey="expense"
              fill={ink.accent}
              radius={[3, 3, 0, 0]}
              isAnimationActive={false}
              maxBarSize={MAX_BAR_WIDTH}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <table className="visually-hidden">
        <caption>Income and expenses by month, {range}</caption>
        <thead>
          <tr>
            <th scope="col">Month</th>
            <th scope="col">Income</th>
            <th scope="col">Expenses</th>
          </tr>
        </thead>
        <tbody>
          {months.map((m) => (
            <tr key={m.month}>
              <th scope="row">{fmtMonthKey(m.month)}</th>
              <td>{fmtMoney(m.income, currency)}</td>
              <td>{fmtMoney(m.expense, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
