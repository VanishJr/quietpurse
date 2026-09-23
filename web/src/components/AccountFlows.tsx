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
import { tooltipMoney, tooltipProps } from '../chartTooltip';
import { fmtMoney, fmtMonthKey, fmtMonthTick, fmtShort, niceMax } from '../format';
import { useTheme } from '../theme';
import { Account, AccountMonthTotals } from '../types';
import { Chips } from './Chips';
import { Delta } from './Delta';

const CHART_HEIGHT = 180;

const Y_AXIS_WIDTH = 46;

const DOTTED_UP_TO = 3;

interface Props {
  account: Account;

  months: AccountMonthTotals[];

  month: AccountMonthTotals;

  prior: AccountMonthTotals | null;
  window: MonthWindow;
  onWindow: (w: MonthWindow) => void;

  otherCurrencies: string[];

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

  const priorNote = prior ? `vs ${fmtMonthTick(prior.month)}` : '';

  const points = months.map((m) => ({ ...m, label: fmtMonthTick(m.month) }));
  const lowest = Math.min(...months.flatMap((m) => [m.income, m.expense]), 0);
  const min = lowest < 0 ? -niceMax(-lowest) : 0;
  const max = niceMax(Math.max(...months.map((m) => Math.max(m.income, m.expense)), 0));
  const axisTick = { fill: ink.muted, fontSize: 11 };
  const dot = months.length <= DOTTED_UP_TO;
  const longFigures = [month.income, month.expense].some(
    (value) => fmtMoney(value).length > 10,
  );

  return (
    <section
      className="ov-card ov-flows"
      aria-label={`Income and expenses for ${account.name}`}
    >
      <div className="header flows-head">
        <h2 className="block-title flows-title">Income vs expenses</h2>
        <Chips
          label="Chart range"
          options={MONTH_WINDOWS.map((w) => ({ key: String(w), label: `${w}M` }))}
          selected={String(window)}
          onSelect={(k) => onWindow(Number(k) as MonthWindow)}
        />
      </div>
      <div className={`flows-figures${longFigures ? ' flows-figures-long' : ''}`}>
        <article className="flow">
          <h3 className="fig-title">
            <span className="series-mark" />
            Income
          </h3>
          <p className="fig-label">{label}</p>
          <p className="fig-value">+{fmtMoney(month.income, account.currency)}</p>
          <Delta
            pct={deltas.income}
            favourable={(deltas.income ?? 0) >= 0}
            note={priorNote}
          />
        </article>

        <article className="flow">
          <h3 className="fig-title">
            <span className="series-mark series-expense" />
            Expenses
          </h3>
          <p className="fig-label">{label}</p>

          <p className="fig-value">
            {/* Net refunds reverse the sign; a fixed minus would print it twice. */}
            {month.expense < 0 ? '+' : '−'}
            {fmtMoney(Math.abs(month.expense), account.currency)}
          </p>

          <Delta
            pct={deltas.expense}
            favourable={(deltas.expense ?? 0) < 0}
            note={priorNote}
          />
        </article>
      </div>

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
              domain={[min, max]}
              tickCount={4}
              tick={axisTick}
              axisLine={false}
              tickLine={false}
              width={Y_AXIS_WIDTH}
              tickFormatter={fmtShort}
            />
            <Tooltip {...tooltipProps(ink, 'surface', tooltipMoney(account.currency))} />

            <Line
              name="Income"
              dataKey="income"
              type="linear"
              stroke={ink.good}
              strokeWidth={2.5}
              dot={dot ? { r: 3.5, strokeWidth: 0, fill: ink.good } : false}
              activeDot={{ r: 4.5, strokeWidth: 0 }}
              isAnimationActive={false}
            />
            <Line
              name="Expenses"
              dataKey="expense"
              type="linear"
              stroke={ink.lavender}
              strokeDasharray="5 4"
              strokeWidth={2.5}
              dot={dot ? { r: 4, strokeWidth: 2, fill: ink.surface } : false}
              activeDot={{ r: 4.5, strokeWidth: 0 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="acct-range">{range}</p>

      {otherCurrencies.length > 0 && (
        // an account has one currency, and a statement's own currency column can still
        // put rows of another into it - printing one code over a sum of two is the
        // failure this exists to prevent.
        //
        // The list is all time and the figures beside it are one window, so the two
        // claims below have different strengths and are written as different
        // sentences: the balance is all time too and IS wrong, while a figure on this
        // screen is wrong only if one of those rows falls in a month it covers - which
        // nothing here was told. The claim is screen-wide: the donut's total sums the
        // same unconverted rows, and one sentence said once is worth more than the same
        // paragraph on every card.
        <p className="error">
          This account holds transactions in {otherCurrencies.join(', ')}, not{' '}
          {account.currency}. The account's balance adds them in as though they were{' '}
          {account.currency}, so it is wrong. So is any other figure on this screen
          covering a month one of them falls in — and nothing here knows which months
          those are.
        </p>
      )}

      <div className="visually-hidden">
        <table>
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
      </div>
    </section>
  );
}
