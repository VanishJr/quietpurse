/**
 * Income against expenses, for one account: the two figures and the line they draw.
 *
 * One card, split. The design puts the month's two totals down the left of it and the
 * trend they belong to on the right — which is what makes the pair readable: "+5,700
 * and −2,690" is a fact about one month, and the line beside it is what says whether
 * that month is the usual one.
 *
 * ---------------------------------------------------------------------------
 * The figures
 *
 * They carried standing prose once — that a transfer moves the balance while being
 * neither income nor an expense, and that the pair is the newest month WITH DATA
 * rather than last calendar month — and all of it was taken off the screen
 * deliberately. What that prose was for, for anyone reinstating it: balance, income
 * and expenses genuinely do not reconcile, on purpose, and the first thing somebody
 * does with a number that disagrees with their banking app is stop believing the app
 * that printed it. The label under each figure still names the month, which is the
 * only part of it the card itself says.
 *
 * What is left below the split is a refusal rather than a caveat: two currencies inside
 * one account. It is printed because the figures above it may be wrong, not because
 * they are hard to read.
 *
 * ---------------------------------------------------------------------------
 * The chart
 *
 * A line and not the bars this used to be, because the design draws lines and because
 * two lines answer the question the card is titled with — income against expenses,
 * over time — where two bars per month answer it one month at a time.
 *
 * The window is 3, 6 or 12 months, and what it draws is however many of those the
 * account has: `windowMonths` never pads the range with months that predate the first
 * statement, since a point at zero for a month before anything was uploaded is a claim
 * that nothing happened then, and nothing in this app knows that. So the first users,
 * who have one statement, get one month, and nothing here apologises for it — the
 * range beside the heading says which months these are.
 *
 * A one-month line is a line through one point, which draws nothing at all. That is
 * what `dot` is for below, and it is the only thing about the chart that is not the
 * same at every length.
 *
 * Colours are the app's and not the reference's, which draws both series in blues:
 * income is `good` and expenses are `accent` everywhere else in Finto, and a green
 * that means "income" on three screens cannot mean "the first series" on the fourth.
 */
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { MonthWindow, MONTH_WINDOWS } from '../accounts';
import { fmtMoney, fmtMonthKey, fmtMonthTick, fmtShort, niceMax } from '../format';
import { useTheme } from '../theme';
import { Account, AccountMonthTotals } from '../types';
import { Chips } from './Chips';
import { Delta } from './Delta';

const CHART_HEIGHT = 216;

/** The gutter the Y axis takes, which is the same whatever the plot beside it is. */
const Y_AXIS_WIDTH = 46;

/**
 * Up to this many months the points are drawn as well as joined.
 *
 * At one month there is no line — a path through a single point paints nothing — so
 * without this the card would show an axis and an empty plot for exactly the account
 * a new user has. At two and three the line is a single straight run and the dots are
 * what say how many readings it was made of. From four up the shape carries that
 * itself and twenty-four discs on two series is noise.
 */
const DOTTED_UP_TO = 3;

interface Props {
  account: Account;
  /** Already windowed and gap-filled by `windowMonths`, oldest first. Never empty. */
  months: AccountMonthTotals[];
  /**
   * The last of them — the newest month the account has anything in, which is what
   * both figures are about. Handed down rather than read off the end of `months`
   * here: the screen has already asked `latestMonth` that question to decide whether
   * to draw this card at all, and asking it twice is two answers waiting to differ.
   */
  month: AccountMonthTotals;
  /** The month before it in that array, or null when the account has only ever had one. */
  prior: AccountMonthTotals | null;
  window: MonthWindow;
  onWindow: (w: MonthWindow) => void;
  /**
   * Currencies among the account's rows that are not its own; normally none. All time
   * and not the window, which is what the endpoint answers — see the sentence below,
   * which is written to be true of that.
   */
  otherCurrencies: string[];
  /** Income and expenses of the newest month, as percentages of the month before. */
  deltas: { income: number | null; expense: number | null };
}

export function AccountFlows({
  account,
  months,
  month,
  prior,
  window,
  onWindow,
  otherCurrencies,
  deltas,
}: Props) {
  const { ink } = useTheme();

  const first = months[0];
  const range =
    months.length === 1
      ? fmtMonthKey(first.month)
      : `${fmtMonthKey(first.month)} – ${fmtMonthKey(month.month)}`;

  const label = fmtMonthKey(month.month);
  /**
   * "vs Jul", or nothing at all. Built as the whole note rather than as a month that
   * gets interpolated later: `prior` is null for an account with one month, and
   * `` `vs ${priorLabel}` `` printed the string "vs null" — invisible today only
   * because the parent nulls both percentages under exactly that condition and
   * `Delta` then draws nothing. That is a contract between two files, and this is
   * what stops it being load-bearing.
   */
  const priorNote = prior ? `vs ${fmtMonthTick(prior.month)}` : '';

  const points = months.map((m) => ({ ...m, label: fmtMonthTick(m.month) }));
  const max = niceMax(Math.max(...months.map((m) => Math.max(m.income, m.expense)), 0));
  const axisTick = { fill: ink.muted, fontSize: 11 };
  const dot = months.length <= DOTTED_UP_TO ? { r: 3.5, strokeWidth: 0 } : false;

  return (
    <section
      className="ov-card ov-flows"
      aria-label={`Income and expenses for ${account.name}`}
    >
      {/*
        The chart comes FIRST in the DOM and second in the paint, and the two are
        reconciled by named grid areas rather than by source order — see `.flows-split`
        in styles.css.

        It is here for the heading tree. Every other card on this screen carries one
        `<h2>`, its own title; this one carried three, and the card's own arrived
        third, after the two figures that belong under it. Nothing in the figures is
        focusable, so the tab order is unchanged by the move, and what a screen reader
        now hears first is the name of the card it has entered.
      */}
      <div className="flows-split">
        <div className="flows-chart">
          <div className="header flows-head">
            <div>
              <h2 className="block-title flows-title">Income vs Expenses</h2>
              <span className="acct-range">{range}</span>
            </div>
            <Chips
              label="Chart range"
              options={MONTH_WINDOWS.map((w) => ({ key: String(w), label: `${w} months` }))}
              selected={String(window)}
              onSelect={(k) => onWindow(Number(k) as MonthWindow)}
            />
          </div>

          <div className="acct-legend">
            <span className="acct-legend-item">
              <span className="swatch" style={{ background: ink.good }} /> Income
            </span>
            <span className="acct-legend-item">
              <span className="swatch" style={{ background: ink.accent }} /> Expenses
            </span>
          </div>

          {/* The SVG is not readable, and in a test environment it is not even
              measurable — recharts sizes itself against a 0x0 box in jsdom. The table
              at the foot of the card carries the same numbers, which is what a screen
              reader gets and what a test asserts on; this is the same data drawn for
              eyes. */}
          <div className="acct-chart" style={{ height: CHART_HEIGHT }} aria-hidden="true">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={points} margin={{ top: 8, right: 10, bottom: 0, left: 0 }}>
                <CartesianGrid stroke={ink.grid} strokeDasharray="3 4" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={axisTick}
                  axisLine={{ stroke: ink.grid }}
                  tickLine={false}
                  padding={{ left: 12, right: 12 }}
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
                {/* the tooltip is a real DOM node, so its radius and its quiet white
                    are the tokens rather than a 12 and a 0.7 that happen to equal
                    them — `var()` resolves in an inline style like any other value */}
                <Tooltip
                  cursor={{ stroke: ink.grid, strokeWidth: 1 }}
                  contentStyle={{
                    background: ink.brand,
                    border: 'none',
                    borderRadius: 'var(--r-md)',
                    padding: '8px 12px',
                    fontSize: 12,
                  }}
                  labelStyle={{ color: 'var(--c-on-ground-2)', marginBottom: 2 }}
                  itemStyle={{ color: ink.onBrand, padding: 0 }}
                  formatter={(value) => fmtMoney(Number(value), account.currency)}
                />
                {/* animation off for the reason AnalyticsScreen gives: every screen
                    stays mounted, so this first renders inside a hidden container and
                    an animation started there freezes at an arbitrary frame */}
                <Line
                  name="Income"
                  dataKey="income"
                  type="monotone"
                  stroke={ink.good}
                  strokeWidth={2.5}
                  dot={dot}
                  activeDot={{ r: 4.5, strokeWidth: 0 }}
                  isAnimationActive={false}
                />
                <Line
                  name="Expenses"
                  dataKey="expense"
                  type="monotone"
                  stroke={ink.accent}
                  strokeWidth={2.5}
                  dot={dot}
                  activeDot={{ r: 4.5, strokeWidth: 0 }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="flows-figures">
          <article className="flow">
            <h3 className="fig-title">Income</h3>
            <p className="fig-label">{label}</p>
            <p className="fig-value">+{fmtMoney(month.income, account.currency)}</p>
            <Delta
              pct={deltas.income}
              favourable={(deltas.income ?? 0) >= 0}
              note={priorNote}
            />
          </article>

          <article className="flow">
            <h3 className="fig-title">Expenses</h3>
            <p className="fig-label">{label}</p>
            {/* the sign is decided rather than written: a refund this month for a
                purchase in an earlier one pushes the figure negative, which is the
                honest number, and "−" in front of it printed "−−60 EUR" */}
            <p className="fig-value">
              {month.expense < 0 ? '+' : '−'}
              {fmtMoney(Math.abs(month.expense), account.currency)}
            </p>
            {/* the one card where up is the bad direction */}
            <Delta
              pct={deltas.expense}
              favourable={(deltas.expense ?? 0) < 0}
              note={priorNote}
            />
          </article>
        </div>
      </div>

      {otherCurrencies.length > 0 && (
        // an account has one currency and an import into it carries that currency, so
        // this is a state nothing should reach - printing one code over a sum of two
        // is the failure it exists to prevent.
        //
        // The list is all time and the figures beside it are one window, so the two
        // claims below have different strengths and are written as different
        // sentences: the balance is all time too and IS wrong, while a figure on this
        // screen is wrong only if one of those rows falls in a month it covers - which
        // nothing here was told. The claim is screen-wide and this is the only place it
        // is made: the donut's total sums the same unconverted rows, and one sentence
        // said once is worth more than the same paragraph on every card.
        <p className="error">
          This account holds transactions in {otherCurrencies.join(', ')}, not{' '}
          {account.currency}. The account's balance adds them in as though they were{' '}
          {account.currency}, so it is wrong. So is any other figure on this screen
          covering a month one of them falls in — and nothing here knows which months
          those are.
        </p>
      )}

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
              <td>{fmtMoney(m.income, account.currency)}</td>
              <td>{fmtMoney(m.expense, account.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
