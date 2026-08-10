/**
 * Overview: one account at a time.
 *
 * The screen used to be a list of every account with a balance beside each. It is now
 * a rail of tabs — one tab per account — and everything below it is about the selected
 * one: its balance, its month, its spending, its chart, its last transactions. The
 * list answered "what do I have"; the rail answers "how is this one doing", which is
 * the question somebody who has just uploaded a statement actually has.
 *
 * ---------------------------------------------------------------------------
 * The shape the design draws
 *
 * A navy hero that continues the navigation bar above it — today's date, the greeting,
 * the rail — with rounded corners where it ends, and the first row of cards pulled up
 * over that edge so the two overlap. Then two columns: the balance and the spending
 * donut down the left, income-against-expenses and the last transactions down the
 * right.
 *
 * The left one is a column of its own inside the grid rather than two of its cells,
 * and it spans both rows. That is what lets the navy card run past the foot of the
 * transactions table, the way the design draws it: cells of a shared row are all one
 * height, so as two cells the donut could only ever end exactly where the table did.
 * A narrow window is the same four blocks in that order down one column — balance,
 * spending, income against expenses, transactions.
 *
 * The hero is full-bleed and the body is not, so neither is inside a padded wrapper —
 * each carries its own `.shell`, which is the column every screen is laid out in.
 *
 * ---------------------------------------------------------------------------
 * Where the numbers come from
 *
 * Not from a summary endpoint: there isn't a per-account one. `/api/summary` and
 * `/api/summary/months` take a date range and sum the whole workspace. So this screen
 * fetches the account's own transactions and `accounts.ts` does the arithmetic the
 * server would have done — see the header there, and the row in
 * `REDESIGN-BACK-DEBT.md` that deletes it. The donut is the same story one level
 * further in: `categorySpend` over the newest month of the window already fetched, so
 * it costs no request of its own.
 *
 * Two requests per account, and the second depends on the first. The recent list also
 * says when this account's newest transaction is, and the chart window is anchored on
 * that rather than on today: an account whose last statement is eighteen months old
 * would otherwise answer an empty year while its seven most recent transactions sit
 * underneath it.
 *
 * ---------------------------------------------------------------------------
 * What is no longer here
 *
 * Recurring payments, the app settings, the export and the workspace-wide import
 * history are about the workspace and not about any one account. They are on the
 * Account screen, in order. The theme button and the avatar went to the navigation
 * bar, which is where the design puts them and where they are reachable from all five
 * screens rather than from this one. This screen is one account and nothing else.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, SessionUser } from '../api';
import {
  categorySpend,
  foreignCurrencies,
  latestMonth,
  LONGEST_WINDOW,
  monthlyTotals,
  MonthWindow,
  monthOf,
  percentChange,
  priorMonth,
  shiftMonth,
} from '../accounts';
import { AccountBalance } from '../components/AccountBalance';
import { AccountDialog, DialogKind } from '../components/AccountDialog';
import { AccountFlows } from '../components/AccountFlows';
import { AccountTabs } from '../components/AccountTabs';
import { CsvImport } from '../components/CsvImport';
import { ImportHistory } from '../components/ImportHistory';
import { RecentTransactions, RECENT_LIMIT } from '../components/RecentTransactions';
import { SpendingByCategory } from '../components/SpendingByCategory';
import { fmtMoney, fmtWeekday } from '../format';
import { Account, AccountDeleted, Transaction } from '../types';
import { setUrl, useUrl } from '../url';

/** The window the chart opens on: long enough to be a trend, short enough to be full. */
const DEFAULT_WINDOW: MonthWindow = 6;

/**
 * The cap on the chart's fetch. The same number TransactionsScreen uses for a year,
 * and for the same reason — the endpoint's own default (1000) is inside what a busy
 * account produces. A response that comes back exactly this long is reported as
 * incomplete rather than drawn as a total.
 */
export const WINDOW_TX_LIMIT = 5_000;

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
  /** The longest window, sliced per toggle rather than re-fetched. */
  window: Transaction[];
  truncated: boolean;
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
const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

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
  user: SessionUser;
  /** Opens the Transactions screen with this account's filter already applied. */
  onOpenTransactions: (accountId: string) => void;
  /** Opens the Analytics screen — the spending card over the whole workspace. */
  onOpenAnalytics: () => void;
}

export function OverviewScreen({ user, onOpenTransactions, onOpenAnalytics }: Props) {
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
      // read for one thing — the currency a new account is created in. See the row in
      // REDESIGN-BACK-DEBT.md: the endpoint requires one and "Add more" does not ask.
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
   * It also means an `?account=` naming something deleted, hidden, or belonging to
   * somebody else's workspace lands on the first account rather than on a blank screen.
   */
  const selected = onRail.find((a) => a.id === url.account) ?? onRail[0] ?? null;

  /**
   * Which fetch the screen is waiting for. Two requests per account and the second
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
      setData({ accountId: account.id, recent: [], window: [], truncated: false });
      return;
    }
    try {
      const recent = await api.transactions({ accountId: account.id, limit: RECENT_LIMIT });
      if (token !== request.current) return;
      if (recent.length === 0) {
        setData({ accountId: account.id, recent, window: [], truncated: false });
        return;
      }
      // anchored on the newest transaction, not on today: see the header
      const from = `${shiftMonth(monthOf(recent[0].date), -(LONGEST_WINDOW - 1))}-01`;
      const rows = await api.transactions({
        accountId: account.id,
        from,
        limit: WINDOW_TX_LIMIT,
      });
      if (token !== request.current) return;
      setData({
        accountId: account.id,
        recent,
        window: rows,
        truncated: rows.length === WINDOW_TX_LIMIT,
      });
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
  const months = useMemo(
    () => (mine ? monthlyTotals(mine.window, window_) : []),
    [mine, window_],
  );
  const foreign = useMemo(
    () => (mine && selected ? foreignCurrencies(mine.window, selected.currency) : []),
    [mine, selected],
  );

  /** The newest month the account has anything in — what every figure is about. */
  const month = latestMonth(months);
  const prior = priorMonth(months);

  /**
   * The month a comparison may be drawn from, or null when none may be — and the ONE
   * place that is decided. Both cards that draw a percentage are handed this rather
   * than the raw month and a `truncated` flag to re-apply the rule against: the
   * balance card was making the same decision a second time, in its own words.
   *
   * No comparison at all off a truncated window. The fetch is ordered newest first, so
   * a response at its limit lost the far end: `prior` is then whichever month survived
   * second, which may be a part of one, and the balance's derived opening figure is
   * short by whatever was dropped. An arrow and a percentage read as more certain
   * than the figure they came from — the same reason `percentChange` answers null on a
   * base of zero rather than printing an infinity.
   */
  const comparable = mine?.truncated ? null : month;
  const deltas = {
    income: comparable && prior ? percentChange(comparable.income, prior.income) : null,
    expense: comparable && prior ? percentChange(comparable.expense, prior.expense) : null,
  };

  /**
   * The newest month's rows, by category. Off the window already in hand, so it is
   * arithmetic rather than a request — and off the newest month specifically, which is
   * the one end of that window a truncated fetch cannot have cut: the endpoint orders
   * `date DESC`, so what a cap drops is the oldest.
   */
  const monthKey = month?.month ?? null;
  const spend = useMemo(
    () =>
      mine && monthKey
        ? categorySpend(mine.window.filter((t) => monthOf(t.date) === monthKey))
        : [],
    [mine, monthKey],
  );

  if (panel === 'import') {
    return (
      <div className="screen-inner">
        <CsvImport onBack={() => setUrl({ panel: null })} onImported={load} />
      </div>
    );
  }

  /*
    `&& selected`, and it is load-bearing. ImportHistory reads a missing account as the
    whole workspace, so a reload straight onto `?panel=history` — where the accounts are
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
      {/* `ov-band` is the same gradient the navigation bar carries, and both are the
          full width of the window — so the two read as one band that ends here */}
      <div className="ov-hero ov-band">
        <div className="shell">
          <p className="ov-date">{fmtWeekday(today)}</p>
          <h1 className="welcome-title">Welcome, {user.name || user.email}!</h1>

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
        </div>
      </div>

      <div className="shell ov-body">
        {/* Above the content, not below it: a refusal read after the list is a refusal
            the reader has already acted on.

            One wrapper for both sentences rather than one each. It is always here and
            only the sentences are conditional, because a live region that arrives in the
            same commit as its text announces nothing — and both of these arrive out of a
            request that has already come back, which is a moment nothing else on the page
            marks. The refusal is the whole of what the reader is told when the accounts
            could not be listed; the delete's sentence needs it for a second reason on top
            of that, that Sheet does not restore focus on close, so afterwards focus is on
            <body> and there is nothing else to say the account went.

            `ov-notice` is what makes either of them survivable. This body is pulled 64px
            up over the hero, so whatever is first in it is drawn ON the navy — and
            `--ink-bad` there is 2.6:1. It is on the sentences and not on the wrapper: the
            wrapper is in the DOM with nothing to say, and a card's fill and padding on an
            empty element would be a blank white box sitting on the navy. */}
        <div aria-live="polite">
          {error && <p className="error ov-notice">Error: {error}</p>}
          {notice && <p className="hint ov-notice">{notice}</p>}
        </div>

        {/* the whole reason this screen exists for a new user: nothing has been uploaded,
            and the way to upload is the biggest thing on the page */}
        {accounts !== null && onRail.length === 0 && hidden.length === 0 && (
          <div className="acct-blank">
            <h2 className="acct-blank-title">Nothing here yet — start with a statement</h2>
            <p className="acct-blank-text">
              Export a statement from your bank in whatever format it offers — .csv, .xlsx or
              .pdf — and drop it in. Finto reads the transactions out of it and makes an
              account for them, named after the file. You can rename it afterwards.
            </p>
            <div className="acct-blank-actions">
              {/* the arrow is a picture of the verb beside it, so a reader who is given
                  it aloud gets a syllable of nothing in front of every one of these */}
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
              An empty account is for money that has no statement — cash, or a card you enter
              by hand.
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

        {/* The dashboard's own refusal, and a second region rather than a line in the one
            above: it belongs BELOW the two states that are about the rail, and a sentence
            about the account on the rail standing over a sentence about the rail itself
            is the wrong order to read them in. Same rule as that wrapper — always in the
            DOM, only the sentence conditional. */}
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
                  Its transactions are out of every figure the app computes — including the
                  ones this screen would draw. Nothing has been deleted, and unhiding it
                  brings all of them back.
                </p>
                <div className="acct-blank-actions">
                  <button className="btn" onClick={() => setDialog(openAt('hide', selected))}>
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
                {/* One column and not two cells: the design's navy card runs from
                    under the balance to below the transactions table, which two cells
                    of a shared row cannot do — a row is one height and both its cells
                    get it. The balance takes what it needs off the top of this column
                    and the donut takes the rest, so the card is as tall as the two
                    cells beside it put together. */}
                <div className="ov-col">
                  <AccountBalance
                    account={selected}
                    comparable={comparable}
                    onOpenMenu={() => setDialog(openAt('menu', selected))}
                  />

                  {month && (
                    <SpendingByCategory
                      spend={spend}
                      month={month.month}
                      total={month.expense}
                      currency={selected.currency}
                      onSeeAll={onOpenAnalytics}
                    />
                  )}
                </div>

                {month ? (
                  <AccountFlows
                    account={selected}
                    months={months}
                    month={month}
                    prior={prior}
                    window={window_}
                    onWindow={setWindow}
                    foreign={foreign}
                    truncated={mine.truncated}
                    deltas={deltas}
                  />
                ) : (
                  <div className="acct-blank ov-blank">
                    <h2 className="acct-blank-title">
                      Nothing has been loaded into {selected.name}
                    </h2>
                    <p className="acct-blank-text">
                      {/* the account's own balance and not a literal zero: the balance
                          card is directly above this sentence, and a sentence that
                          names a figure the card beside it disagrees with is worse
                          than one that names none */}
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
