/**
 * Where this account's money went last month: a donut, the total in the middle of it,
 * and the three categories that took most of it.
 *
 * The card the design left as an empty navy rectangle in the left column, under the
 * balance. It is the Analytics screen's breakdown cut down to what fits beside a
 * balance: that screen answers the whole workspace over a range you page through, and
 * this answers one account over the one month the figures beside it are already about.
 * Nothing here is a second opinion — it is the Expenses figure on the card to the
 * right, opened up.
 *
 * ---------------------------------------------------------------------------
 * Three rows, and then the rest of them named as the rest
 *
 * The legend is the top three, which is what makes it a card and not a list. A month
 * has up to twelve categories in it, and the ones under the fold are not nothing — so
 * when there are more, the row after the third says how many and what they came to.
 * Top three plus that row is the total in the middle by construction, whatever the
 * shape of the tail: it is computed as a remainder and not summed a second time.
 *
 * The donut draws only the categories that are positive. A refund can push one
 * negative — the purchase it reverses was in an earlier month — and there is no such
 * thing as a negative sector. That is also why the middle is the month's expense total
 * rather than the sum of the sectors: those two disagree exactly when a category is
 * negative, and of the two it is the one the reader can check against the card beside
 * it that has to be right.
 *
 * That total is `totals.expense` from the same `/api/summary` body the breakdown came
 * from, and not the Expenses figure the flows card was handed. The two are the same
 * number for the same month by construction — the server applies one predicate to one
 * set of rows for both — so taking each card's total from the body its own detail came
 * from costs nothing, and it means a write landing between the two requests produces
 * two cards about two months, each correctly labelled, instead of one card labelled
 * with the other's month.
 *
 * ---------------------------------------------------------------------------
 * The colours are the dark palette in both schemes
 *
 * This card is a `panel` fill, which is a dark navy in light mode and in dark mode
 * alike, so the categorical palette picked against the near-white page does not apply
 * to it — light-mode Health on this ground is 2.26:1, under the 3:1 a graphical object
 * needs. `categoryColorOnPanel` is that rule, and it is the same rule
 * `--c-on-ground-*` already follows.
 */
import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts';
import { toCents } from '../accounts';
import { categoryLabel } from '../categories';
import { fmtMoney, fmtMonthKey } from '../format';
import { useTheme } from '../theme';
import { CategorySummary } from '../types';

/** How many categories are named. The rest arrive as one row that says how many. */
const TOP = 3;

/**
 * The ring's box. Tall enough that a 66% hole still leaves the total room to be set
 * inside it, short enough that the three legend rows under it are on the card without
 * scrolling at the narrowest column the grid gives this card.
 */
const DONUT_HEIGHT = 168;

interface Props {
  /** Biggest first: `byCategory` off the account's summary for this month. */
  spend: CategorySummary[];
  /** YYYY-MM the breakdown is of — the newest month the account has anything in. */
  month: string;
  /** That month's expense total, off the same body — see the header. */
  total: number;
  currency: string;
  /** Opens the Analytics screen: this card over the whole workspace, over a range. */
  onSeeAll: () => void;
}

export function SpendingByCategory({ spend, month, total, currency, onSeeAll }: Props) {
  const { ink, categoryColorOnPanel } = useTheme();

  const top = spend.slice(0, TOP);
  const rest = spend.slice(TOP);
  /* in cents and divided once, for the reason `accounts.ts` gives: these are doubles
     that came from integers, and subtracting three of them from a fourth keeps the
     residue — which is how a tail that is exactly nothing came to be 2e-13 */
  const restTotal =
    (toCents(total) - top.reduce((sum, c) => sum + toCents(c.total), 0)) / 100;
  const sectors = spend.filter((c) => c.total > 0);

  /** A share of nothing is not 0%, it is not a share — so nothing is printed. */
  const share = (value: number): string | null =>
    total > 0 ? `${Math.round((value / total) * 100)}%` : null;

  return (
    <section
      className="ov-card ov-spend"
      aria-label={`Spending by category, ${fmtMonthKey(month)}`}
    >
      <h2 className="ov-spend-title">Spending · {fmtMonthKey(month)}</h2>

      {sectors.length === 0 ? (
        <p className="ov-spend-empty">
          Nothing was spent out of this account in {fmtMonthKey(month)}.
        </p>
      ) : (
        <>
          <div className="ov-donut" style={{ height: DONUT_HEIGHT }} aria-hidden="true">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                {/* `stroke` is the card's own fill, so what separates two sectors is a
                    gap and not a line. It was `ink.brand`, which is this card's colour
                    in dark mode and a lighter navy than it in light — where the ring
                    was drawing a visible navy hairline between every pair. */}
                <Pie
                  data={sectors}
                  dataKey="total"
                  nameKey="category"
                  innerRadius="66%"
                  outerRadius="100%"
                  stroke={ink.panel}
                  strokeWidth={2}
                  isAnimationActive={false}
                >
                  {sectors.map((c) => (
                    <Cell key={c.category} fill={categoryColorOnPanel(c.category)} />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            <div className="donut-center">
              <div className="donut-value">{fmtMoney(total)}</div>
              <div className="donut-currency">{currency}</div>
            </div>
          </div>

          {/* the identity of a category is never carried by its colour alone: every
              row names itself, and the disc is only how it is found in the ring.
              Named, because a list of three when the table below has all twelve has to
              say which three it is */}
          <ul className="ov-spend-legend" aria-label={`Biggest categories, ${fmtMonthKey(month)}`}>
            {top.map((c) => (
              <li key={c.category} className="ov-spend-row">
                <span
                  className="dot"
                  style={{ background: categoryColorOnPanel(c.category) }}
                />
                <span className="ov-spend-name">{categoryLabel(c.category)}</span>
                <span className="ov-spend-pct">{share(c.total)}</span>
              </li>
            ))}
            {rest.length > 0 && (
              <li className="ov-spend-row is-rest">
                <span className="dot dot-rest" />
                <span className="ov-spend-name">
                  {rest.length} more {rest.length === 1 ? 'category' : 'categories'}
                </span>
                <span className="ov-spend-pct">{share(restTotal)}</span>
              </li>
            )}
          </ul>

          <table className="visually-hidden">
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
            {/*
              The figure in the middle of the ring, which is the biggest thing on this
              card and was the one thing on it nobody could read: `.donut-center` is
              inside the `aria-hidden` container, because it is painted over a drawing
              that has to be hidden as one piece, and the table that stands in for that
              drawing had every category in it and no total.

              A row here rather than a second copy of the figure outside the ring: the
              rows above are what the total is a total OF, and a table that carries both
              says the relationship as well as the number. It is `total` and not the sum
              of the rows on purpose — see the header: this is the month's expense total,
              the same figure the card to the right prints, and the two disagree exactly
              when a refund makes a category negative. Of the two, the one a reader can
              check against the card beside it is the one that has to be printed.
            */}
            <tfoot>
              <tr>
                <th scope="row">Total</th>
                <td>{fmtMoney(total, currency)}</td>
              </tr>
            </tfoot>
          </table>
        </>
      )}

      {/* The way out of a card that is deliberately three rows deep: this month, this
          account, top three. Everything it leaves out — every category, every account,
          a range you choose — is the Analytics screen, and this is the door to it. It
          is outside the branch above so that a month which spent nothing still has
          one. */}
      <button className="btn-link ov-spend-more" onClick={onSeeAll}>
        All analytics <span aria-hidden="true">→</span>
      </button>
    </section>
  );
}
