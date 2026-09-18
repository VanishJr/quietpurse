import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import {
  latestMonth,
  LONGEST_WINDOW,
  monthEnd,
  MonthWindow,
  monthOf,
  percentChange,
  priorMonth,
  shiftMonth,
  windowMonths,
} from '../accounts';
import { AccountBalance } from '../components/AccountBalance';
import { AccountDialog, DialogKind } from '../components/AccountDialog';
import { AccountFlows } from '../components/AccountFlows';
import { AccountTabs } from '../components/AccountTabs';
import { CsvImport } from '../components/CsvImport';
import { ImportIcon } from '../components/NavIcons';
import { ImportHistory } from '../components/ImportHistory';
import { RecentTransactions, RECENT_LIMIT } from '../components/RecentTransactions';
import { SpendingByCategory } from '../components/SpendingByCategory';
import { fmtMoney, fmtWeekday } from '../format';
import {
  Account,
  AccountDeleted,
  AccountMonthlySummary,
  AccountSummary,
  Transaction,
} from '../types';
import { setUrl, useUrl } from '../url';

/** The window the chart opens on: long enough to be a trend, short enough to be full. */
const DEFAULT_WINDOW: MonthWindow = 6;

/**
 * What one account's dashboard is drawn from. Carries the id it was fetched for, which
 * is the second of two guards against a tab switch overtaking the one before it: the
 * fetch drops its own answer when a newer one has been asked for (see `request`), and
 * this is what the render checks in case one gets past that anyway.
 */
interface AccountData {
  accountId: string;
  /** Newest first — the endpoint orders by date DESC. */
  recent: Transaction[];
  /**
   * Both summary bodies or neither, so that "the summary is present exactly when the
   * months are" is a fact about the type instead of a convention. A hidden account and
   * an empty one have neither: nothing was asked for.
   */
  figures: { summary: AccountSummary; monthly: AccountMonthlySummary } | null;
}

/**
 * Which panel has taken the screen over. They are pages and not dialogs — which is why
 * they are in the URL beside the screen rather than in state beside `dialog`.
 *
 * Neither carries an account of its own. The import history used to hold the `Account`
 * it was opened with, and it is always the account on the rail: `?panel=history` next
 * to `?account=` says the same thing in something a link can carry.
 */
type PanelKind = 'import' | 'history';

/** ...and what a URL that asks for something else gets, which is the dashboard. */
const panelOf = (panel: string | null): PanelKind | null =>
  panel === 'import' || panel === 'history' ? panel : null;

/**
 * Which step of the account panel is open, and for which account ('add' has none).
 * `origin` is the step it was opened at and does not move as the steps do — it is what
 * tells the panel whether its leftmost button goes back to a menu or closes. Two
 * things open a step directly: "+ Add", and a hidden account's panel, which has no ⋮
 * to reach a menu through.
 */
type Dialog = { kind: DialogKind; origin: DialogKind; account: Account | null };

/** Opening a step: it is its own origin until something steps away from it. */
const openAt = (kind: DialogKind, account: Account | null): Dialog => ({
  kind,
  origin: kind,
  account,
});

/** Singular at one, each count on its own, so a mixed sentence still reads. */
const count = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;

/**
 * What the delete destroyed, in the server's own numbers and never the preview's —
 * for a hidden account the two legitimately differ, and the one worth printing is the
 * count of rows that actually went. "uploaded file" is the noun the preview's third
 * bullet uses, and deliberately: the two numbers are a claim about the same fact, so a
 * reader who compares them is entitled to find them equal.
 */
const destroyedSentence = (name: string, d: AccountDeleted): string =>
  d.transactions === 0 && d.imports === 0 && d.documents === 0
    ? `${name} was deleted. It held no transactions, no imports and no uploaded files.`
    : `${name} was deleted — ${count(d.transactions, 'transaction', 'transactions')}, ` +
      `${count(d.imports, 'import', 'imports')} and ` +
      `${count(d.documents, 'uploaded file', 'uploaded files')} went with it.`;

interface Props {
  /** Opens the Transactions screen with this account's filter already applied. */
  onOpenTransactions: (accountId: string) => void;
  /** Opens the Analytics screen — the spending card over every account. */
  onOpenAnalytics: () => void;
}

export function OverviewScreen({ onOpenTransactions, onOpenAnalytics }: Props) {
  /**
   * null = never loaded. `[]` used to mean that as well as "loaded, and empty", which
   * is how a failed request came to render as "you have no accounts".
   */
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [baseCurrency, setBaseCurrency] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** What the last delete destroyed. Not a refusal, and not the dashboard's. */
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * Which account, and which panel — both from the URL, so a link names the account it
   * was read on and Back is the way out of the import page. `url.ts` has the rest.
   *
   * The chart's window and the hidden-accounts switch stay in state on purpose. They
   * are how this reader has set the screen up rather than what they are looking at, and
   * a link that arrives carrying somebody else's chart range is a link that argues with
   * whoever opened it.
   */
  const url = useUrl();
  const panel = panelOf(url.panel);

  /** Hidden accounts are off the rail until asked for; restoring them has to stay reachable. */
  const [showHidden, setShowHidden] = useState(false);
  const [window_, setWindow] = useState<MonthWindow>(DEFAULT_WINDOW);

  const [dialog, setDialog] = useState<Dialog | null>(null);

  const [data, setData] = useState<AccountData | null>(null);
  /** The dashboard's own refusal: the rail above it loaded and is still true. */
  const [dataError, setDataError] = useState<string | null>(null);

  /**
   * Taken once, at mount. Read on every render it would be a different Date object per
   * frame for a line that changes at most at midnight — and a session left open across
   * one is not a reason to re-render the screen.
   */
  const [today] = useState(() => new Date());

  const load = useCallback(async () => {
    try {
      setError(null);
      // hidden ones too: without them there is no way to bring one back
      setAccounts(await api.accounts(true));
      // read for one thing — the currency a new account is created in: the client never
      // sends one, the endpoint defaults to the base currency, and both create arms say which.
      api
        .appSettings()
        .then((s) => setBaseCurrency(s.baseCurrency))
        .catch(() => {});
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(() => (accounts ?? []).filter((a) => !a.hidden), [accounts]);
  const hidden = useMemo(() => (accounts ?? []).filter((a) => a.hidden), [accounts]);
  const onRail = useMemo(
    () => (showHidden ? [...visible, ...hidden] : visible),
    [showHidden, visible, hidden],
  );

  /**
   * Nothing chosen yet, or what was chosen has left the rail — the first account
   * stands in. Resolved while rendering rather than in an effect that writes the answer
   * back: the effect version painted one frame of a rail with no tab marked and no
   * panel under it, and everything downstream — which page the rail shows, which
   * account's transactions are fetched — was deciding against that empty frame.
   *
   * The fallback is not written back to the URL either, and for a second reason on top
   * of that one: `?screen=overview` with no account is a true and useful URL — "the
   * dashboard, whichever account is first" — and an app that immediately rewrote it to
   * name today's first account would hand out links that go stale on the next upload.
   * It also means an `?account=` naming something deleted, hidden, or from somebody
   * else's Finto lands on the first account rather than on a blank screen.
   */
  const selected = onRail.find((a) => a.id === url.account) ?? onRail[0] ?? null;

  /**
   * Which fetch the screen is waiting for. Three requests per account and two of them
   * waiting on the first, so a tab switch has a wide window to be overtaken in — and
   * an answer for a tab nobody is looking at any more is not a slower answer, it is
   * the wrong one. Writing it anyway left `data` holding an id `mine` then rejected,
   * which renders no dashboard, no error and no reason to fetch again: the effect's
   * deps did not move. Dropping it here is what keeps the screen showing the account
   * whose tab is current.
   */
  const request = useRef(0);

  const loadAccount = useCallback(async (account: Account) => {
    const token = ++request.current;
    setDataError(null);
    setData(null);
    // a hidden account's transactions are filtered out of the endpoint, so asking for
    // them would answer an empty account rather than a removed one
    if (account.hidden) {
      setData({ accountId: account.id, recent: [], figures: null });
      return;
    }
    try {
      const recent = await api.transactions({
        accountId: account.id,
        limit: RECENT_LIMIT,
      });
      if (token !== request.current) return;
      if (recent.length === 0) {
        setData({ accountId: account.id, recent, figures: null });
        return;
      }
      // Anchor on the uploaded history; today could be outside every statement.
      const anchor = monthOf(recent[0].date);
      // the last day of the month, and the endpoints keep it whole — a `to` short by
      // one drops that day out of the donut, both figures and the newest point at once
      const to = monthEnd(anchor);
      const [summary, monthly] = await Promise.all([
        api.accountSummary(account.id, `${anchor}-01`, to),
        api.accountMonths(
          account.id,
          `${shiftMonth(anchor, -(LONGEST_WINDOW - 1))}-01`,
          to,
        ),
      ]);
      if (token !== request.current) return;
      setData({ accountId: account.id, recent, figures: { summary, monthly } });
    } catch (e) {
      // a refusal is as stale as an answer: the abandoned tab's 500 would otherwise
      // paint an error over the account that loaded
      if (token !== request.current) return;
      setDataError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (selected) loadAccount(selected);
  }, [selected, loadAccount]);

  /** The account's row moved on the server — put the new one in the list as it is. */
  const applyAccount = (updated: Account) => {
    setAccounts((list) => list?.map((a) => (a.id === updated.id ? updated : a)) ?? null);
  };

  const afterCreate = (created: Account) => {
    setDialog(null);
    setUrl({ account: created.id });
    load();
  };

  const afterDelete = (deleted: Account, destroyed: AccountDeleted) => {
    setDialog(null);
    // before the reload and outside its failure: the account is gone whether or not the
    // list comes back, and a screen that says nothing sends the reader to press again
    setNotice(destroyedSentence(deleted.name, destroyed));
    // the whole list, never a splice: it is the server's answer instead of a guess at
    // it, it is the shape afterCreate already uses, and the delete's own path is the
    // wrong place to be clever — the deleted account is the selected one today, so a
    // splice happens to work, and nothing in the code says it will stay that way.
    // Deleting an account also un-pairs every transfer whose other leg was in it, so
    // the SURVIVING account's income and expenses move and its rows have to be re-read.
    load();
  };

  // Trap: a sentence about the account that is gone must not stand above the panel of
  // the next one. An effect rather than a line in each setDialog caller, because a
  // caller written later cannot forget an effect. `afterDelete` sets dialog to null in
  // the same batch, so this sees null and does not eat the sentence it was just given.
  useEffect(() => {
    if (dialog) setNotice(null);
  }, [dialog]);

  const mine = data?.accountId === selected?.id ? data : null;
  const figures = mine?.figures ?? null;

  /**
   * The chart's months: the server's answer anchored, cut to the toggle and with its
   * interior gaps filled. Sliced here rather than re-fetched — the request asks for
   * the longest window once and 3 and 6 are cuts of it.
   */
  const months = useMemo(
    () => (figures ? windowMonths(figures.monthly.months, window_) : []),
    [figures, window_],
  );

  /**
   * All time and not the window, which is what the endpoint answers and more than this
   * screen could ever see before. The warning on the flows card says so in those words.
   */
  const otherCurrencies = figures?.monthly.otherCurrencies ?? [];

  /** The newest month the account has anything in — what every figure is about. */
  const month = latestMonth(months);
  const prior = priorMonth(months);

  const deltas = {
    income: month && prior ? percentChange(month.income, prior.income) : null,
    expense: month && prior ? percentChange(month.expense, prior.expense) : null,
  };

  if (panel === 'import') {
    return (
      <div className="screen-inner">
        <CsvImport
          onBack={() => setUrl({ panel: null })}
          onImported={load}
          // the same reload, and deliberately not the same prop: onBack closes the
          // panel without one, so an account created in there reaches the rail here
          onAccountCreated={load}
          baseCurrency={baseCurrency}
        />
      </div>
    );
  }

  /*
    `&& selected`, and it is load-bearing. ImportHistory reads a missing account as
    every account, so a reload straight onto `?panel=history` — where the accounts are
    still in flight and nothing is selected yet — would answer with every import the user
    has ever made under a heading about one account. It falls through to the dashboard
    for the tick that takes and arrives once there is an account for it to be about.
  */
  if (panel === 'history' && selected) {
    return (
      <div className="screen-inner">
        <ImportHistory
          account={selected}
          onBack={() => setUrl({ panel: null })}
          onChanged={() => {
            load();
            loadAccount(selected);
          }}
        />
      </div>
    );
  }

  return (
    <div className="ov">
      <header className="ov-heading">
        <div>
          <p className="ov-date">{fmtWeekday(today)}</p>
          <h1 className="overview-title">Overview</h1>
          <p className="ov-subtitle">A clear view of your everyday account.</p>
        </div>
        <button className="btn ov-import" onClick={() => setUrl({ panel: 'import' })}>
          <ImportIcon /> Import statement
        </button>
      </header>

      {onRail.length > 0 && (
        <AccountTabs
          accounts={onRail}
          selectedId={selected?.id ?? null}
          onSelect={(id) => setUrl({ account: id })}
          onAdd={() => setDialog(openAt('add', null))}
          hiddenCount={hidden.length}
          showHidden={showHidden}
          onToggleHidden={() => setShowHidden((v) => !v)}
        />
      )}

      <div className="ov-body">
        {((accounts === null && !error) || (selected && !mine && !dataError)) && (
          <p className="ov-loading" role="status">
            Loading your account…
          </p>
        )}
        <div aria-live="polite">
          {error && <p className="error ov-notice">Error: {error}</p>}
          {notice && <p className="hint ov-notice">{notice}</p>}
        </div>

        {accounts !== null && onRail.length === 0 && hidden.length === 0 && (
          <div className="acct-blank">
            <h2 className="acct-blank-title">
              Nothing here yet — start with a statement
            </h2>
            <p className="acct-blank-text">
              Export a statement from your bank in whatever format it offers — .csv, .xlsx
              or .pdf — and drop it in. Finto reads the transactions out of it and puts
              them in an account you name on the way in.
            </p>
            <div className="acct-blank-actions">
              <button className="btn" onClick={() => setUrl({ panel: 'import' })}>
                <span aria-hidden="true">⭳</span> Import a statement
              </button>
              <button
                className="btn-ghost"
                onClick={() => setDialog(openAt('add', null))}
                disabled={baseCurrency === null}
              >
                Create an empty account
              </button>
            </div>
            <p className="hint">
              An empty account is for money that has no statement — cash, or a card you
              enter by hand.
            </p>
          </div>
        )}

        {accounts !== null && onRail.length === 0 && hidden.length > 0 && (
          <p className="edit-hint ov-notice">
            Every account you have is hidden.{' '}
            <button className="btn-link" onClick={() => setShowHidden(true)}>
              Show {hidden.length === 1 ? 'it' : 'them'}
            </button>
          </p>
        )}

        <div aria-live="polite">
          {dataError && <p className="error ov-notice">Error: {dataError}</p>}
        </div>

        {selected && mine && (
          <div className="acct-panel" role="region" aria-label={selected.name}>
            {selected.hidden ? (
              /* The ⋮ lives on the balance card, and a hidden account has no balance card
                 to put it on — so this panel carries the same control under the same
                 accessible name. Without it the only route back out of Hidden is a PATCH
                 by hand: the sentence here used to name a menu that was not on the page. */
              <div className="acct-blank">
                <h2 className="acct-blank-title">{selected.name} is hidden</h2>
                <p className="acct-blank-text">
                  Its transactions are out of every figure the app computes — including
                  the ones this screen would draw. Nothing has been deleted, and unhiding
                  it brings all of them back.
                </p>
                <div className="acct-blank-actions">
                  <button
                    className="btn"
                    onClick={() => setDialog(openAt('hide', selected))}
                  >
                    Unhide this account
                  </button>
                  <button
                    className="btn-ghost"
                    onClick={() => setDialog(openAt('menu', selected))}
                    aria-haspopup="dialog"
                    aria-label={`Account menu: ${selected.name}`}
                  >
                    Account menu
                  </button>
                </div>
              </div>
            ) : (
              <div className="ov-grid">
                <AccountBalance
                  account={selected}
                  comparable={month}
                  onOpenMenu={() => setDialog(openAt('menu', selected))}
                />

                {month ? (
                  <AccountFlows
                    account={selected}
                    months={months}
                    month={month}
                    prior={prior}
                    window={window_}
                    onWindow={setWindow}
                    otherCurrencies={otherCurrencies}
                    deltas={deltas}
                  />
                ) : (
                  <div className="acct-blank ov-blank">
                    <h2 className="acct-blank-title">
                      Nothing has been loaded into {selected.name}
                    </h2>
                    <p className="acct-blank-text">
                      The account is here, and it is empty — which is why its balance is{' '}
                      {fmtMoney(selected.balance, selected.currency)}. Import a statement
                      into it and the figures, the chart and the transactions fill in.
                    </p>
                    <div className="acct-blank-actions">
                      <button className="btn" onClick={() => setUrl({ panel: 'import' })}>
                        <span aria-hidden="true">⭳</span> Import a statement
                      </button>
                    </div>
                  </div>
                )}

                {month && figures && (
                  <SpendingByCategory
                    spend={figures.summary.byCategory}
                    month={monthOf(figures.summary.from)}
                    total={figures.summary.totals.expense}
                    currency={selected.currency}
                    onSeeAll={onOpenAnalytics}
                  />
                )}

                {mine.recent.length > 0 && (
                  <RecentTransactions
                    account={selected}
                    transactions={mine.recent}
                    onSeeAll={() => onOpenTransactions(selected.id)}
                  />
                )}
              </div>
            )}
          </div>
        )}

        {selected && mine && !selected.hidden && figures && (
          <p className="ov-footnote">
            Transfers affect your balance, but are excluded from income and expenses.
          </p>
        )}

        {dialog && (
          <AccountDialog
            kind={dialog.kind}
            origin={dialog.origin}
            account={dialog.account}
            baseCurrency={baseCurrency ?? ''}
            onStep={(kind) => setDialog({ ...dialog, kind })}
            onClose={() => setDialog(null)}
            // the account as well as the panel: the dialog's account is the one on the
            // rail today, and naming it is what makes the URL true on its own rather
            // than only in a session that got here by opening this menu
            onOpenHistory={(account) => {
              setDialog(null);
              setUrl({ account: account.id, panel: 'history' });
            }}
            onCreated={afterCreate}
            onUpdated={applyAccount}
            onDeleted={afterDelete}
          />
        )}
      </div>
    </div>
  );
}
