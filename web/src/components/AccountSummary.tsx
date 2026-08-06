/**
 * The three cards for the selected account.
 *
 * Three figures and nothing under them. They carried standing prose once — that
 * Balance is the sum of what has been uploaded rather than the bank's own figure,
 * that a transfer moves the balance while being neither income nor an expense, and
 * that the monthly pair is the newest month with data rather than last calendar
 * month — and all of it has been taken off the screen deliberately. What that prose
 * was for, for anyone reinstating it: the three figures genuinely do not reconcile,
 * on purpose, and the first thing somebody does with a number that disagrees with
 * their banking app is stop believing the app that printed it. The card labels still
 * name the month, which is the only part of it the cards themselves say.
 *
 * What is left below is a refusal rather than a caveat: a window that came back cut,
 * or two currencies inside one account. Those are printed because the figures above
 * them are wrong, not because they are hard to read.
 *
 * Every figure is in the account's own currency, including the two monthly ones. The
 * rest of the app converts to the base currency because it adds accounts together;
 * one account has one currency, and three figures in one unit can be compared with
 * each other.
 *
 * The ⋮ is on the balance card rather than on the tab, which is where the reference
 * design puts it. A tab is then a name and nothing else — which is what lets three of
 * them share a line without the row becoming a control panel — and the menu sits on
 * the thing it acts on, the account currently on screen.
 */
import { balanceChange, MonthTotal, percentChange, priorMonth } from '../accounts';
import { fmtMoney, fmtMonthKey, fmtMonthTick } from '../format';
import { Account } from '../types';

interface Props {
  account: Account;
  /** Windowed months, oldest first. The last is what the figures are about. */
  months: MonthTotal[];
  /** Currencies among its transactions that are not the account's own; normally none. */
  foreign: string[];
  /** The window these months were computed from came back at its limit. */
  truncated: boolean;
  onOpenMenu: () => void;
}

/**
 * A comparison, or nothing at all. `favourable` is the caller's, because the same
 * arrow means opposite things on two of these cards: income rising is good news and
 * spending rising is not, and colouring both green because both went up is the thing
 * the reference screenshot does and the one thing here not copied from it.
 */
function Delta({
  pct,
  favourable,
  note,
}: {
  pct: number | null;
  favourable: boolean;
  note: string;
}) {
  if (pct === null) return null;
  const up = pct >= 0;
  return (
    <p className={`fig-delta${favourable ? ' is-good' : ' is-bad'}`}>
      <span className="fig-arrow" aria-hidden="true">
        {up ? '↗' : '↘'}
      </span>
      <strong>{Math.abs(pct).toFixed(1)}%</strong>
      <span className="fig-delta-note">{note}</span>
    </p>
  );
}

export function AccountSummary({ account, months, foreign, truncated, onOpenMenu }: Props) {
  const month = months.length > 0 ? months[months.length - 1] : null;
  const prior = priorMonth(months);
  const label = month ? fmtMonthKey(month.month) : null;
  const priorLabel = prior ? fmtMonthTick(prior.month) : null;

  /**
   * No comparison at all off a truncated window. The fetch is ordered newest first, so
   * a response at its limit lost the far end: `prior` is then whichever month survived
   * second, which may be a part of one, and the balance's derived opening figure is
   * short by whatever was dropped out of the newest. An arrow and a percentage read as
   * more certain than the figure they came from — the same reason `percentChange`
   * answers null on a base of zero rather than printing an infinity.
   */
  const incomeDelta =
    month && prior && !truncated ? percentChange(month.income, prior.income) : null;
  const expenseDelta =
    month && prior && !truncated ? percentChange(month.expense, prior.expense) : null;
  const balanceDelta = truncated ? null : balanceChange(account.balance, month);

  return (
    <section className="acct-figures" aria-label={`Figures for ${account.name}`}>
      <div className="acct-figure-row">
        <article className="fig fig-brand">
          <div className="fig-head">
            <h2 className="fig-title">Your account</h2>
            <button
              className="fig-menu"
              onClick={onOpenMenu}
              aria-haspopup="dialog"
              aria-label={`Account menu: ${account.name}`}
            >
              ⋮
            </button>
          </div>
          <p className="fig-label">Total balance</p>
          <p className="fig-value">{fmtMoney(account.balance, account.currency)}</p>
          <Delta
            pct={balanceDelta}
            favourable={(balanceDelta ?? 0) >= 0}
            note={label ? `over ${label}` : ''}
          />
        </article>

        <article className="fig">
          <h2 className="fig-title">Income</h2>
          <p className="fig-label">{label ?? 'no month yet'}</p>
          <p className="fig-value is-income">
            {month ? `+${fmtMoney(month.income, account.currency)}` : '—'}
          </p>
          <Delta
            pct={incomeDelta}
            favourable={(incomeDelta ?? 0) >= 0}
            note={`vs ${priorLabel}`}
          />
        </article>

        <article className="fig">
          <h2 className="fig-title">Expenses</h2>
          <p className="fig-label">{label ?? 'no month yet'}</p>
          <p className="fig-value">
            {month ? `−${fmtMoney(month.expense, account.currency)}` : '—'}
          </p>
          {/* the one card where up is the bad direction */}
          <Delta
            pct={expenseDelta}
            favourable={(expenseDelta ?? 0) < 0}
            note={`vs ${priorLabel}`}
          />
        </article>
      </div>

      {truncated && (
        <p className="error">
          This account has more transactions than one request returns, so Income and
          Expenses above are read from an incomplete window and no comparison with the
          month before them is shown. Total balance is the server's own sum of every row
          and is not affected.
        </p>
      )}

      {foreign.length > 0 && (
        // an account has one currency and an import into it carries that currency, so
        // this is a state nothing should reach - printing one code over a sum of two
        // is the failure it exists to prevent
        <p className="error">
          Some transactions here are in {foreign.join(', ')}, not {account.currency}. All
          three figures add them together and label the result {account.currency} — the two
          monthly ones here, and the balance, which the server sums the same way — so they
          are wrong until that is sorted out.
        </p>
      )}
    </section>
  );
}
