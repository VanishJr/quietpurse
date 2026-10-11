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
import { Button } from '../components/Button';
import { Notice } from '../components/Notice';
import { PageHeader } from '../components/PageHeader';
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
 * Carries the id it was fetched for, which is the second of two guards against a tab
 * switch overtaking the one before it: the fetch drops its own answer when a newer one
 * has been asked for (see `request`), and this is what the render checks in case one
 * gets past that anyway.
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
 * The panels are pages and not dialogs — which is why they are in the URL beside the
 * screen rather than in state beside `dialog`.
 *
 * Neither carries an account of its own: the import history is always about the account
 * on the rail, and `?panel=history` next to `?account=` says so in something a link can
 * carry, for an account on the rail of whoever opens it.
 */
type PanelKind = 'import' | 'history';

const panelOf = (panel: string | null): PanelKind | null =>
  panel === 'import' || panel === 'history' ? panel : null;

/** `origin` is the step it was opened at, and does not move as the steps do. */
type Dialog = { kind: DialogKind; origin: DialogKind; account: Account | null };

const openAt = (kind: DialogKind, account: Account | null): Dialog => ({
  kind,
  origin: kind,
  account,
});

/** Singular at one, each count on its own, so a mixed sentence still reads. */
const count = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;

/**
 * What the delete removed, in the server's own numbers and never the preview's — for
 * a hidden account the two legitimately differ, and the one worth printing is the
 * count of rows that actually went. "uploaded file" is the noun the preview uses too,
 * and deliberately: the two numbers are a claim about the same fact, so a reader who
 * compares them is entitled to find them equal.
 */
const destroyedSentence = (name: string, d: AccountDeleted): string =>
  d.transactions === 0 && d.imports === 0 && d.documents === 0
    ? `${name} was deleted. It held no transactions, no imports and no uploaded files.`
    : `${name} was deleted — ${count(d.transactions, 'transaction', 'transactions')}, ` +
      `${count(d.imports, 'import', 'imports')} and ` +
      `${count(d.documents, 'uploaded file', 'uploaded files')} went with it.`;

interface Props {
  onOpenTransactions: (accountId: string) => void;
  onOpenAnalytics: () => void;
  onDataChanged?: () => void;
  dataRevision?: number;
}

export function OverviewScreen({
  onOpenTransactions,
  onOpenAnalytics,
  onDataChanged = () => {},
  dataRevision = 0,
}: Props) {
  /**
   * null until the list has been read, and never `[]` for that: an empty list renders
   * the empty state, which over a refused request is a claim that there are no accounts.
   */
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [baseCurrency, setBaseCurrency] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** What the last delete removed. Not a refusal, and not the dashboard's. */
  const [notice, setNotice] = useState<string | null>(null);

  const url = useUrl();
  const panel = panelOf(url.panel);

  // The chart's window and the hidden-accounts switch stay in state and out of the URL on
  // purpose, for the reason `web/src/SPEC.md` gives under *Where the reader is*.
  const [showHidden, setShowHidden] = useState(false);
  const [window_, setWindow] = useState<MonthWindow>(DEFAULT_WINDOW);

  const [dialog, setDialog] = useState<Dialog | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const postWriteFocus = useRef<{ list: Account[] | null } | null>(null);
  useEffect(() => {
    const intent = postWriteFocus.current;
    if (!intent) return;
    const replaced = accounts !== null && accounts !== intent.list;
    if (!replaced && !error) return;
    if (replaced) postWriteFocus.current = null;
    if (document.activeElement === document.body && !titleRef.current?.closest('[hidden], [inert]')) {
      titleRef.current?.focus();
    }
  }, [accounts, error]);

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
   * back: an effect leaves a render of a rail with no tab marked and no panel under it,
   * and everything downstream — which page the rail shows, which account's transactions
   * are fetched — decides against that empty render.
   *
   * The fallback is not written back to the URL either: `?screen=overview` with no
   * account is a true and useful URL — "the dashboard, whichever account is first" —
   * and an app that rewrote it to name today's first account would hand out links that
   * go stale on the next upload. It also means an `?account=` naming something deleted,
   * hidden, or from another installation lands on the first account rather than on a
   * blank screen.
   */
  const selected = onRail.find((a) => a.id === url.account) ?? onRail[0] ?? null;

  /**
   * Which fetch the screen is waiting for. An answer for a tab nobody is looking at any
   * more is not a slower answer, it is the wrong one: written anyway, it leaves `data`
   * holding an id `mine` rejects, which renders no dashboard, no error and no reason to
   * fetch again, because the effect's deps do not move.
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
  }, [selected, loadAccount, dataRevision]);

  const applyAccount = (updated: Account) => {
    if (updated.hidden && accounts?.some((account) => account.id === updated.id && !account.hidden)) {
      postWriteFocus.current = { list: accounts };
    }
    setAccounts((list) => list?.map((a) => (a.id === updated.id ? updated : a)) ?? null);
  };

  const afterCreate = (created: Account) => {
    postWriteFocus.current = { list: accounts };
    setDialog(null);
    setUrl({ account: created.id });
    load();
  };

  const afterDelete = (deleted: Account, destroyed: AccountDeleted) => {
    postWriteFocus.current = { list: accounts };
    setDialog(null);
    // before the reload and outside its failure: the account is gone whether or not the
    // list comes back, and a screen that says nothing sends the reader to press again
    setNotice(destroyedSentence(deleted.name, destroyed));
    // the whole list, never a splice: it is the server's answer instead of a guess at
    // it. Deleting an account also un-pairs every transfer whose other leg was in it, so
    // the SURVIVING account's income and expenses move and its rows have to be re-read.
    load();
  };

  // A sentence about the account that is gone must not stand above the panel of
  // the next one. An effect rather than a line in each setDialog caller, because a
  // caller written later cannot forget an effect. `afterDelete` sets dialog to null in
  // the same batch, so this sees null and does not eat the sentence it was just given.
  useEffect(() => {
    if (dialog) setNotice(null);
  }, [dialog]);

  const mine = data?.accountId === selected?.id ? data : null;
  const figures = mine?.figures ?? null;

  /** Sliced here rather than re-fetched: the request asks for the longest window once. */
  const months = useMemo(
    () => (figures ? windowMonths(figures.monthly.months, window_) : []),
    [figures, window_],
  );

  /** All time, and not the window the figures beside it cover. */
  const otherCurrencies = figures?.monthly.otherCurrencies ?? [];

  const month = latestMonth(months);
  const prior = priorMonth(months);

  const deltas = {
    income: month && prior ? percentChange(month.income, prior.income) : null,
    expense: month && prior ? percentChange(month.expense, prior.expense) : null,
  };

  if (panel === 'import') {
    return (
      <CsvImport
        onBack={() => setUrl({ panel: null })}
        onImported={() => {
          load();
          onDataChanged();
        }}
        // the rail's reload without the revision, and deliberately not the same prop:
        // onBack closes the panel without one, so an account created in there reaches
        // the rail here, and it has no rows yet for another screen to re-read
        onAccountCreated={load}
        baseCurrency={baseCurrency}
      />
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
          backLabel="Back to accounts"
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
    <div className="screen-inner ov">
      <PageHeader
        title="Overview"
        titleRef={titleRef}
        context={<><p className="ov-date">{fmtWeekday(today)}</p>A clear view of your everyday account.</>}
        action={
          <Button type="button" variant="primary" size="standard" onClick={() => setUrl({ panel: 'import' })}>
            <ImportIcon /> Import statement
          </Button>
        }
      />

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
          <Notice placement="content" role="status">Loading your account…</Notice>
        )}
        <div aria-live="polite">
          {error && <Notice tone="error" remedy={
            <Button type="button" variant="secondary" size="compact" onClick={load}>Retry accounts</Button>
          }>Error: {error}</Notice>}
          {notice && <Notice>{notice}</Notice>}
        </div>

        {accounts !== null && onRail.length === 0 && hidden.length === 0 && (
          <div className="acct-blank">
            <h2 className="acct-blank-title">
              Nothing here yet — start with a statement
            </h2>
            <p className="acct-blank-text">
              Export a statement from your bank in whatever format it offers — .csv, .xlsx
              or .pdf — and drop it in. Quietpurse reads the transactions out of it and puts
              them in an account you name on the way in.
            </p>
            <div className="acct-blank-actions">
              <Button type="button" variant="secondary" size="standard" onClick={() => setUrl({ panel: 'import' })}>
                <ImportIcon /> Import a statement
              </Button>
              <Button type="button" variant="tertiary" size="standard"
                onClick={() => setDialog(openAt('add', null))}
                disabled={baseCurrency === null}
              >
                Create an empty account
              </Button>
            </div>
            <p className="hint">
              An empty account is for money that has no statement — cash, or a card you
              enter by hand.
            </p>
          </div>
        )}

        {accounts !== null && onRail.length === 0 && hidden.length > 0 && (
          <Notice remedy={
            <Button type="button" variant="secondary" size="compact" onClick={() => setShowHidden(true)}>
              Show {hidden.length === 1 ? 'it' : 'them'}
            </Button>
          }>Every account you have is hidden.</Notice>
        )}

        <div aria-live="polite">
          {dataError && <Notice tone="error" remedy={selected &&
            <Button type="button" variant="secondary" size="compact" onClick={() => loadAccount(selected)}>Retry account</Button>
          }>Error: {dataError}</Notice>}
        </div>

        {selected && mine && (
          <div className="acct-panel" role="region" aria-label={selected.name}>
            {selected.hidden ? (
              /* The ⋮ lives on the balance card, and a hidden account has no balance card
                 to put it on — so this panel carries the same control under the same
                 accessible name. */
              <div className="acct-blank">
                <h2 className="acct-blank-title">{selected.name} is hidden</h2>
                <p className="acct-blank-text">
                  Its transactions are out of every figure the app computes — including
                  the ones this screen would draw. Nothing has been deleted, and unhiding
                  it brings all of them back.
                </p>
                <div className="acct-blank-actions">
                  <Button type="button" variant="primary" size="standard"
                    onClick={() => setDialog(openAt('hide', selected))}
                  >
                    Unhide this account
                  </Button>
                  <Button type="button" variant="secondary" size="standard"
                    onClick={() => setDialog(openAt('menu', selected))}
                    aria-haspopup="dialog"
                    aria-label={`Account menu: ${selected.name}`}
                  >
                    Account menu
                  </Button>
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
                      <Button type="button" variant="secondary" size="standard" onClick={() => setUrl({ panel: 'import' })}>
                        <ImportIcon /> Import a statement
                      </Button>
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

        {dialog && (
          <AccountDialog
            kind={dialog.kind}
            origin={dialog.origin}
            account={dialog.account}
            baseCurrency={baseCurrency ?? ''}
            restoreFocus={() => titleRef.current}
            onStep={(kind) => setDialog({ ...dialog, kind })}
            onClose={() => setDialog(null)}
            // the account as well as the panel: the dialog's account is the one on the
            // rail today, and naming it is what makes the URL true on its own for an
            // account on the rail of whoever opens it, rather than only in a session
            // that got here by opening this menu
            onOpenHistory={(account) => {
              setUrl({ account: account.id, panel: 'history' }, 'push', () => setDialog(null));
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
