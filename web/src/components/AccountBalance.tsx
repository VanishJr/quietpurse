/**
 * The balance card: the account's name, what is in it, and how far that moved.
 *
 * The first card of the design and the only one in the left column above the spending
 * donut. It is white with the figure set in the interactive navy, where the previous
 * layout filled the whole card with that navy — the design moved the fill to the
 * donut card underneath, and one navy block in a column reads as the accent it is
 * while two read as a theme.
 *
 * Its heading is the account's own name rather than a label. The tab above says which
 * account is selected in eighteen characters; this is where the whole name is written
 * out, which is why it wraps rather than truncating.
 *
 * The ⋮ is here rather than on the tab, which is where the reference design puts it. A
 * tab is then a name and nothing else — what lets three of them share a line without
 * the row becoming a control panel — and the menu sits on the thing it acts on, the
 * account currently on screen.
 *
 * Every figure on this screen is in the account's own currency. The rest of the app
 * converts to the base currency because it adds accounts together; one account has one
 * currency, and figures in one unit can be compared with each other.
 */
import { balanceChange } from '../accounts';
import { fmtMoney, fmtMonthKey } from '../format';
import { Account, AccountMonthTotals } from '../types';
import { Delta } from './Delta';

interface Props {
  account: Account;
  /**
   * The month a comparison may be drawn from — the newest one the account has anything
   * in — or null when it has none. The same month the flows card beside it is about:
   * the screen names it once so the two cannot draw percentages of different months.
   */
  comparable: AccountMonthTotals | null;
  onOpenMenu: () => void;
}

export function AccountBalance({ account, comparable, onOpenMenu }: Props) {
  const change = balanceChange(account.balance, comparable);

  return (
    <section className="ov-card ov-balance" aria-label={`Balance of ${account.name}`}>
      <div className="fig-head">
        <h2 className="fig-title acct-full-name">{account.name}</h2>
        <button
          className="fig-menu"
          onClick={onOpenMenu}
          aria-haspopup="dialog"
          aria-label={`Account menu: ${account.name}`}
        >
          ⋮
        </button>
      </div>

      <p className="bal-value">{fmtMoney(account.balance, account.currency)}</p>

      <Delta
        pct={change}
        favourable={(change ?? 0) >= 0}
        note={comparable ? `over ${fmtMonthKey(comparable.month)}` : ''}
      />
    </section>
  );
}
