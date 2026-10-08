import { balanceChange, shiftMonth } from '../accounts';
import { fmtMoney, fmtMonthKey } from '../format';
import { Account, AccountMonthTotals } from '../types';
import { Delta } from './Delta';
import { Button } from './Button';
import { MoreIcon } from './SettingsActionIcons';

interface Props {
  account: Account;
  comparable: AccountMonthTotals | null;
  onOpenMenu: () => void;
}

export function AccountBalance({ account, comparable, onOpenMenu }: Props) {
  const change = balanceChange(account.balance, comparable);
  const value = fmtMoney(account.balance);

  return (
    <section className="ov-card ov-balance" aria-label={`Balance of ${account.name}`}>
      <div className="fig-head">
        <h2 className="fig-title">Account balance</h2>
        <Button type="button" variant="tertiary" size="compact" iconOnly
          onClick={onOpenMenu}
          aria-haspopup="dialog"
          aria-label={`Account menu: ${account.name}`}
        >
          <MoreIcon />
        </Button>
      </div>
      <p className="acct-full-name">{account.name}</p>
      <p className="bal-value financial-value">
        {value} {account.currency}
      </p>
      {change === null ? (
        <p className="balance-no-comparison">No previous balance to compare</p>
      ) : (
        <Delta
          pct={change}
          favourable={change >= 0}
          note={comparable ? `vs ${fmtMonthKey(shiftMonth(comparable.month, -1))}` : ''}
        />
      )}
      {comparable && (
        <p className="balance-period">Through {fmtMonthKey(comparable.month)}</p>
      )}
    </section>
  );
}
