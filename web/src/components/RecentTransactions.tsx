import { categoryLabel } from '../categories';
import { fmtDate, fmtMoney } from '../format';
import { TransactionsIcon } from './NavIcons';
import { Account, Transaction } from '../types';

/** How many rows the block shows. The screen fetches exactly this many. */
export const RECENT_LIMIT = 7;

interface Props {
  account: Account;
  transactions: Transaction[];
  /** Opens the Transactions screen with this account already filtered. */
  onSeeAll: () => void;
}

export function RecentTransactions({ account, transactions, onSeeAll }: Props) {
  return (
    <section
      className="ov-card tx-recent"
      aria-label={`Recent transactions in ${account.name}`}
    >
      <div className="header">
        <h2 className="block-title">Recent transactions</h2>
        <button className="btn-link" onClick={onSeeAll}>
          See all <span aria-hidden="true">↗</span>
        </button>
      </div>

      {transactions.length === 0 ? (
        <p className="empty">No transactions in this account yet.</p>
      ) : (
        <div className="tx-card">
          <table className="tx-table">
            <thead>
              <tr>
                <th scope="col">Description</th>
                <th scope="col" className="tx-col-cat">
                  Category
                </th>
                <th scope="col" className="tx-col-date">
                  Date
                </th>
                <th scope="col" className="tx-num tx-col-amount">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((t) => (
                <tr key={t.id}>
                  <td className="tx-desc">
                    <span className="tx-cell tx-desc-cell">
                      <span
                        className="tx-mark"

                        aria-hidden="true"
                      >
                        <TransactionsIcon />
                      </span>
                      <span className="tx-desc-body">
                        <span className="tx-title" title={t.description}>
                          {t.displayDescription ?? (t.description || '(no description)')}
                        </span>

                        {(t.transfer || t.refund || t.oneOff) && (
                          <span className="tx-flags">
                            {t.transfer && <span className="badge">Transfer</span>}
                            {t.refund && <span className="badge">Refund</span>}
                            {t.oneOff && <span className="badge">One-off</span>}
                          </span>
                        )}
                      </span>
                    </span>
                  </td>
                  <td className="tx-cat">
                    <span className="tx-cell tx-cat-cell">
                      <span className="tx-cat-name">{categoryLabel(t.category)}</span>
                    </span>
                  </td>
                  <td className="tx-date">
                    <span className="tx-cell">{fmtDate(t.date)}</span>
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
