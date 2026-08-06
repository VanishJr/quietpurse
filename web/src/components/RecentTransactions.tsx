/**
 * The account's last few transactions, and the way to the rest of them.
 *
 * A real `<table>`, which the reference screenshot's five columns are. Three of those
 * five are not built here and the reasons differ:
 *
 *  - **Account** is the tab. Repeating it down every row of a screen that shows one
 *    account at a time is a column with one value in it.
 *  - **Status** would be invented. Every row here came out of a statement, which is a
 *    record of what already happened — there is no pending, no failed, and a green
 *    "Completed" on all seven says something the data never said. What is real in its
 *    place is the flags the app already keeps: `transfer`, `refund`, `one-off`. Those
 *    also happen to be what explains the arithmetic in the figures above.
 *  - **Export Data** is a per-row download of a file that is not per-row. The statement
 *    a transaction came from is downloaded once, from the account's import history.
 *
 * **Date & Time** is Date. The time of day in these rows is whatever the statement
 * carried, which for a CSV or a PDF is usually nothing — printing midnight as a time
 * would be inventing one.
 *
 * The disc at the left of the description is the screenshot's merchant avatar, minus
 * the claim: it is the transaction's category colour with the first letter of the
 * description in it, so a row is identifiable at a glance without a logo this app has
 * no way to know.
 *
 * One DOM, not two. The narrow layout is the same table restyled by `styles.css` —
 * rendering a phone list beside a desktop table would put every description on the
 * screen twice, which is what a screen reader would then read.
 *
 * ---------------------------------------------------------------------------
 * Every cell's layout lives on a span INSIDE the `<td>`, never on the `<td>`
 *
 * `display: flex` on a table cell is not a flex table cell — it stops being a cell at
 * all, and CSS table fixup then wraps it, together with every adjacent non-cell
 * sibling, into ONE anonymous cell. Description and Category are adjacent, and both
 * wanted to be flex containers, so the two collapsed into a single column and the
 * category rendered underneath the description inside it. The column headers stayed
 * where they were, which is what made it look like a stray element rather than a
 * layout rule.
 */
import { categoryLabel } from '../categories';
import { fmtDate, fmtMoney } from '../format';
import { useTheme } from '../theme';
import { Account, Transaction } from '../types';

/** How many rows the block shows. The screen fetches exactly this many. */
export const RECENT_LIMIT = 7;

interface Props {
  account: Account;
  transactions: Transaction[];
  /** Opens the Transactions screen with this account already filtered. */
  onSeeAll: () => void;
}

/** The letter on the disc. A row with no description gets the category's initial. */
const initialOf = (t: Transaction): string =>
  (t.description.trim() || categoryLabel(t.category)).charAt(0).toUpperCase();

export function RecentTransactions({ account, transactions, onSeeAll }: Props) {
  const { categoryColor } = useTheme();

  return (
    <section className="tx-recent" aria-label={`Recent transactions in ${account.name}`}>
      <div className="header">
        <h2 className="block-title">Last {RECENT_LIMIT} transactions</h2>
        <button className="btn-link" onClick={onSeeAll}>
          All transactions →
        </button>
      </div>

      {transactions.length === 0 ? (
        <p className="empty">No transactions in this account yet.</p>
      ) : (
        <div className="acct-card tx-card">
        <table className="tx-table">
          {/*
            The widths are here rather than in the cells because the table is
            `table-layout: fixed`, which takes them from this row and nowhere else.
            Fixed is what makes the description ellipsise: under auto layout the column
            grows to whatever the longest description is — and a bank writes
            "Платеж от JANE DOE Реквизиты: Sent from N26 Отправитель: …" into that
            field — so the table ended up wider than the card and Amount fell off the
            right-hand edge. `text-overflow` needs a cell that is not free to grow.
          */}
          <thead>
            <tr>
              <th scope="col" className="tx-col-date">
                Date
              </th>
              <th scope="col">Description</th>
              <th scope="col" className="tx-col-cat">
                Category
              </th>
              <th scope="col" className="tx-num tx-col-amount">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {transactions.map((t) => (
              <tr key={t.id}>
                <td className="tx-date">
                  <span className="tx-cell">{fmtDate(t.date)}</span>
                </td>
                <td className="tx-desc">
                  <span className="tx-cell tx-desc-cell">
                    <span className="tx-mark" style={{ background: categoryColor(t.category) }}>
                      {initialOf(t)}
                    </span>
                    <span className="tx-desc-body">
                      <span className={`tx-title${t.transfer ? ' muted-strike' : ''}`}>
                        {t.description || '(no description)'}
                      </span>
                      {/* what the reference draws as Status, and this app actually knows */}
                      {(t.transfer || t.refund || t.oneOff) && (
                        <span className="tx-flags">
                          {t.transfer && <span className="badge">transfer</span>}
                          {t.refund && <span className="badge">refund</span>}
                          {t.oneOff && <span className="badge">one-off</span>}
                        </span>
                      )}
                    </span>
                  </span>
                </td>
                <td className="tx-cat">
                  <span className="tx-cell tx-cat-cell">
                    <span className="dot" style={{ background: categoryColor(t.category) }} />
                    <span className="tx-cat-name">{categoryLabel(t.category)}</span>
                  </span>
                </td>
                <td className={`tx-num tx-amount${t.amount > 0 ? ' is-income' : ''}`}>
                  <span className="tx-cell">
                    {t.amount > 0 ? '+' : ''}
                    {fmtMoney(t.amount, t.currency)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </section>
  );
}
