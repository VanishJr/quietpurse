/**
 * Overview: one account at a time.
 *
 * The screen used to be a list of every account with a balance beside each. It is now
 * a rail of tabs — one tab per account — and everything below it is about the selected
 * one: its balance, its month, its chart, its last transactions. The list answered
 * "what do I have"; the rail answers "how is this one doing", which is the question
 * somebody who has just uploaded a statement actually has.
 *
 * ---------------------------------------------------------------------------
 * Where the numbers come from
 *
 * Not from a summary endpoint: there isn't a per-account one. `/api/summary` and
 * `/api/summary/months` take a date range and sum the whole workspace. So this screen
 * fetches the account's own transactions and `accounts.ts` does the arithmetic the
 * server would have done — see the header there, and the row in
 * `REDESIGN-BACK-DEBT.md` that deletes it.
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
 * Account screen, in order. This screen is one account and nothing else.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, SessionUser } from '../api';
import {
  foreignCurrencies,
  LONGEST_WINDOW,
  monthlyTotals,
  MonthWindow,
  monthOf,
  shiftMonth,
} from '../accounts';
import { AccountDialog, DialogKind } from '../components/AccountDialog';
import { AccountMonths } from '../components/AccountMonths';
import { AccountSummary } from '../components/AccountSummary';
import { AccountTabs } from '../components/AccountTabs';
import { CsvImport } from '../components/CsvImport';
import { ImportHistory } from '../components/ImportHistory';
import { RecentTransactions, RECENT_LIMIT } from '../components/RecentTransactions';
import { fmtMoney } from '../format';
import { initialOf } from '../identity';
import { ThemeMode, useTheme } from '../theme';
import { Account, AccountDeleted, Transaction } from '../types';

/** The window the chart opens on: long enough to be a trend, short enough to be full. */
const DEFAULT_WINDOW: MonthWindow = 6;

/**
 * The cap on the chart's fetch. The same number TransactionsScreen uses for a year,
 * and for the same reason — the endpoint's own default (1000) is inside what a busy
 * account produces. A response that comes back exactly this long is reported as
 * incomplete rather than drawn as a total.
 */
export const WINDOW_TX_LIMIT = 5_000;

/** Theme button cycle: system → light → dark. */
const NEXT_MODE: Record<ThemeMode, ThemeMode> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
};
const MODE_GLYPH: Record<ThemeMode, string> = { system: '◐', light: '☀', dark: '☾' };
const MODE_NAME: Record<ThemeMode, string> = { system: 'Auto', light: 'Light', dark: 'Dark' };

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

/** Which panel has taken the screen over. They are pages, not dialogs. */
type Panel = { kind: 'import' } | { kind: 'history'; account?: Account } | null;

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
  /** Bumped by the sidebar's Import; each new value opens the import panel once. */
  importAsk: number;
  /** Opens the Transactions screen with this account's filter already applied. */
  onOpenTransactions: (accountId: string) => void;
  /** The avatar's destination: identity and the settings live on that screen. */
  onOpenAccount: () => void;
}

export function OverviewScreen({
  user,
  importAsk,
  onOpenTransactions,
  onOpenAccount,
}: Props) {
  const { mode, setMode } = useTheme();

  /**
   * null = never loaded. `[]` used to mean that as well as "loaded, and empty", which
   * is how a failed request came to render as "you have no accounts".
   */
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [baseCurrency, setBaseCurrency] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** What the last delete destroyed. Not a refusal, and not the dashboard's. */
  const [notice, setNotice] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Hidden accounts are off the rail until asked for; restoring them has to stay reachable. */
  const [showHidden, setShowHidden] = useState(false);
  const [window_, setWindow] = useState<MonthWindow>(DEFAULT_WINDOW);

  const [panel, setPanel] = useState<Panel>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);

  const [data, setData] = useState<AccountData | null>(null);
  /** The dashboard's own refusal: the rail above it loaded and is still true. */
  const [dataError, setDataError] = useState<string | null>(null);

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

  // the sidebar asked for the import panel; 0 is the initial value and asks nothing
  useEffect(() => {
    if (importAsk > 0) setPanel({ kind: 'import' });
  }, [importAsk]);

  const visible = useMemo(() => (accounts ?? []).filter((a) => !a.hidden), [accounts]);
  const hidden = useMemo(() => (accounts ?? []).filter((a) => a.hidden), [accounts]);
  const onRail = useMemo(
    () => (showHidden ? [...visible, ...hidden] : visible),
    [showHidden, visible, hidden],
  );

  /**
   * Nothing chosen yet, or what was chosen has left the rail — the first account
   * stands in. Resolved while rendering rather than in an effect that writes back to
   * `selectedId`: the effect version painted one frame of a rail with no tab marked
   * and no panel under it, and everything downstream — which page the rail shows,
   * which account's transactions are fetched — was deciding against that empty frame.
   */
  const selected = onRail.find((a) => a.id === selectedId) ?? onRail[0] ?? null;

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
    setSelectedId(created.id);
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

  if (panel?.kind === 'import') {
    return (
      <div className="screen-inner">
        <CsvImport onBack={() => setPanel(null)} onImported={load} />
      </div>
    );
  }

  if (panel?.kind === 'history') {
    return (
      <div className="screen-inner">
        <ImportHistory
          account={panel.account}
          onBack={() => setPanel(null)}
          onChanged={() => {
            load();
            if (selected) loadAccount(selected);
          }}
        />
      </div>
    );
  }

  return (
    <div className="screen-inner">
      <header className="welcome">
        <div>
          <h1 className="welcome-title">Welcome, {user.name || user.email}!</h1>
          <p className="welcome-sub">{user.email}</p>
        </div>
        <div className="welcome-actions">
          <button
            className="icon-btn"
            onClick={() => setMode(NEXT_MODE[mode])}
            aria-label={`Theme: ${MODE_NAME[mode]}. Click to change`}
          >
            <span aria-hidden="true">{MODE_GLYPH[mode]}</span>
          </button>
          {/* the letter, not a photograph; it goes where the address and the settings are */}
          <button className="avatar" onClick={onOpenAccount} aria-label={`Account: ${user.email}`}>
            <span aria-hidden="true">{initialOf(user)}</span>
          </button>
        </div>
      </header>

      {/* above the content, not below it: a refusal read after the list is a refusal
          the reader has already acted on */}
      {error && <p className="error">Error: {error}</p>}

      {/* the wrapper is always here and only the sentence is conditional: a live region
          that arrives in the same commit as its text announces nothing. It is needed at
          all because Sheet does not restore focus on close, so after a delete focus is
          on <body> and there is nothing else to say the account went */}
      <div aria-live="polite">{notice && <p className="hint">{notice}</p>}</div>

      {onRail.length > 0 && (
        <>
          <AccountTabs
            accounts={onRail}
            selectedId={selected?.id ?? null}
            onSelect={setSelectedId}
            onAdd={() => setDialog(openAt('add', null))}
          />
          {hidden.length > 0 && (
            <button className="btn-link" onClick={() => setShowHidden((v) => !v)}>
              {showHidden
                ? 'Hide removed accounts again'
                : `Show ${hidden.length} hidden account${hidden.length === 1 ? '' : 's'}`}
            </button>
          )}
        </>
      )}

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
            <button className="btn" onClick={() => setPanel({ kind: 'import' })}>
              ⭳ Import a statement
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
        <p className="edit-hint">
          Every account you have is hidden.{' '}
          <button className="btn-link" onClick={() => setShowHidden(true)}>
            Show {hidden.length === 1 ? 'it' : 'them'}
          </button>
        </p>
      )}

      {dataError && <p className="error">Error: {dataError}</p>}

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
            <>
              <AccountSummary
                account={selected}
                months={months}
                foreign={foreign}
                truncated={mine.truncated}
                onOpenMenu={() => setDialog(openAt('menu', selected))}
              />

              {months.length > 0 ? (
                <AccountMonths
                  months={months}
                  window={window_}
                  onWindow={setWindow}
                  currency={selected.currency}
                  truncated={mine.truncated}
                />
              ) : (
                <div className="acct-blank">
                  <h2 className="acct-blank-title">
                    Nothing has been loaded into {selected.name}
                  </h2>
                  <p className="acct-blank-text">
                    The account is here, and it is empty — which is why its balance is{' '}
                    {fmtMoney(0, selected.currency)}. Import a statement into it and the
                    figures, the chart and the list below fill in.
                  </p>
                  <div className="acct-blank-actions">
                    <button className="btn" onClick={() => setPanel({ kind: 'import' })}>
                      ⭳ Import a statement
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
            </>
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
          onOpenHistory={(account) => {
            setDialog(null);
            setPanel({ kind: 'history', account });
          }}
          onCreated={afterCreate}
          onUpdated={applyAccount}
          onDeleted={afterDelete}
        />
      )}
    </div>
  );
}
