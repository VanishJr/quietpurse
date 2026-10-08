import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { REST_SECTOR, categoryLabel, restLabel, spendRing } from '../categories';
import { tooltipMoney, tooltipProps } from '../chartTooltip';
import { fmtMoney, fmtMonthKey } from '../format';
import { useTheme } from '../theme';
import { CategorySummary } from '../types';
import { Button } from './Button';

interface Props {
  spend: CategorySummary[];
  month: string;
  total: number;
  currency: string;
  onSeeAll: () => void;
}

export function SpendingByCategory({ spend, month, total, currency, onSeeAll }: Props) {
  const { ink, categoryColor } = useTheme();
  const { top, rest, restTotal, sectors } = spendRing(spend, total);
  const hasRefunds = spend.some((c) => c.total < 0);

  return (
    <section
      className="ov-card ov-spend"
      aria-label={`Spending by category, ${fmtMonthKey(month)}`}
    >
      <div>
        <h2 className="ov-spend-title">Spending by category</h2>
        <p className="spend-period">{fmtMonthKey(month)}</p>
      </div>

      <div className="ov-donut" aria-hidden="true">
        {sectors.length > 0 ? (
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={sectors}
                dataKey="total"
                nameKey="label"
                innerRadius="78%"
                outerRadius="100%"
                stroke={ink.surface}
                strokeWidth={4}
                startAngle={90}
                endAngle={-270}
                isAnimationActive={false}
              >
                {sectors.map((c) => (
                  <Cell
                    key={c.category}
                    fill={c.category === REST_SECTOR ? ink.categoryRemainder : categoryColor(c.category)}
                  />
                ))}
              </Pie>
              <Tooltip {...tooltipProps(ink, 'surface', tooltipMoney(currency))} />
            </PieChart>
          </ResponsiveContainer>
        ) : (
          <div className="donut-empty-ring" />
        )}
        <div className="donut-center">
          <div className="donut-currency">Total spent</div>
          <div
            className={`donut-value${fmtMoney(total).length > 10 ? ' donut-value-long' : ''}`}
          >
            {fmtMoney(total)}
          </div>
          <div className="donut-currency">{currency}</div>
        </div>
      </div>

      {sectors.length === 0 && (
        <p className="ov-spend-empty">
          {total < 0
            ? `Net refunds in ${fmtMonthKey(month)} exceed spending.`
            : `Nothing was spent out of this account in ${fmtMonthKey(month)}.`}
        </p>
      )}
      {hasRefunds && sectors.length > 0 && (
        <p className="ov-spend-empty">
          Total includes net refunds; the ring shows positive spending.
        </p>
      )}

      <ul
        className="ov-spend-legend"
        aria-label={`Biggest categories, ${fmtMonthKey(month)}`}
      >
        {top.map((c) => (
          <li key={c.category} className="ov-spend-row">
            <span className="dot" style={{ background: categoryColor(c.category) }} aria-hidden="true" />
            <span className="ov-spend-name">{categoryLabel(c.category)}</span>
            <span className="ov-spend-amount"><span className="financial-value-text">{fmtMoney(c.total, currency)}</span></span>
          </li>
        ))}
        {rest.length > 0 && (
          <li className="ov-spend-row is-rest">
            <span className="swatch" style={{ background: ink.categoryRemainder }} aria-hidden="true" />
            <span className="ov-spend-name">{restLabel(rest.length)}</span>
            <span className="ov-spend-amount"><span className="financial-value-text">{fmtMoney(restTotal, currency)}</span></span>
          </li>
        )}
      </ul>

      <div className="visually-hidden">
        <table>
          <caption>Spending by category, {fmtMonthKey(month)}</caption>
          <thead>
            <tr>
              <th scope="col">Category</th>
              <th scope="col">Spent</th>
            </tr>
          </thead>
          <tbody>
            {spend.map((c) => (
              <tr key={c.category}>
                <th scope="row">{categoryLabel(c.category)}</th>
                <td>{fmtMoney(c.total, currency)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Total</th>
              <td>{fmtMoney(total, currency)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <Button type="button" variant="tertiary" size="compact" className="ov-spend-more" onClick={onSeeAll}>
        All analytics <span aria-hidden="true">↗</span>
      </Button>
    </section>
  );
}
