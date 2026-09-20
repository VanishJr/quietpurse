/**
 * Analytics: a workspace the reader builds, rather than one analysis the app chose.
 *
 * It used to be a single fixed view — a period pager, two total cards, a donut over a
 * category legend, and twelve bars if you switched to Year. That answered one question
 * well and every other question not at all: "how did groceries move over two years",
 * "what did this one account earn against what it spent", "is the shape of this quarter
 * the shape of the last one" were all outside it, and none of them is exotic.
 *
 * So the screen holds no analysis of its own now. It starts empty, the reader makes the
 * charts they want, and each one is a `Chart` the workspace keeps. Nothing
 * that the old screen could say has been lost: its yearly bars are a Column of Expenses
 * over 12 months, its donut and legend are a Donut split by category, its income-by-
 * source block is the same donut split by source — all of them reachable, and none of
 * them the only thing on offer.
 *
 * ---------------------------------------------------------------------------
 * One chart at a time, and the dock says which
 *
 * Not a grid of every chart at once. A chart is worth the width of the screen — the
 * axis labels of a 24-month series are unreadable at a third of it — and the reader
 * asked a specific question, which is answered by one plot rather than by six of them
 * needing to be found among each other. The dock along the bottom is the index.
 *
 * Which one is showing lives in the URL (`?chart=`), the way every other "where the
 * reader is" fact in this app does since the navigation moved there: a chart is a place
 * you can be sent to and come Back from.
 *
 * ---------------------------------------------------------------------------
 * The list is the workspace's, and the server is where it is
 *
 * It was this browser's localStorage once, which meant a chart did not follow
 * the reader to their phone and `AGENTS.md`'s "no state that lives only in the browser"
 * was crossed by the screen a reader spends the longest on. It is `GET`/`PUT
 * /api/analytics/charts` now, and three states came with the move that a browser store
 * never had: the list has not arrived, it could not be read, and the last change was
 * not saved.
 *
 * Everything below turns on one rule. **The version and the list are one value**, and
 * the version is only ever a number the server answered with. The route refuses a PUT
 * whose expected version is not the current one, which is what stops two devices
 * overwriting each other — and a client that keeps the two apart, or computes the next
 * version itself, defeats that quietly rather than loudly: its writes are ACCEPTED, on
 * top of work it never read. So `list` is one ref, `commit` is the only thing that
 * writes it, and `ChartsVersion` is branded so no other number can reach the PUT.
 *
 * **One PUT at a time.** Two mutations a few hundred milliseconds apart — build a
 * chart, rename it; duplicate, delete — would otherwise both carry the version the
 * screen was holding, and the second would be refused for staleness by the FIRST one's
 * write. The reader would be told the workspace changed elsewhere, and the thing that
 * changed it would be their own previous click. `pump` sends one list at a time and
 * later intents coalesce onto the latest.
 *
 * **A failed save does not take the work back off the screen.** The list stays, the
 * notice says it is not saved, and Try again sends it. The one exception is the
 * refusal for staleness, where the whole point is that what is on screen is not what
 * the workspace holds: there the server's list replaces it and the reader is told, in
 * words, that the change they just made is gone. Re-applying it would resurrect a
 * chart another device deleted, which is the exact silent wrongness the version exists
 * to prevent.
 *
 * The dock is also the only place a chart is acted on. There is no "New chart" beside
 * the heading and no Edit/Duplicate/Delete over the plot: making a chart, choosing one
 * and changing one are all things you do to the LIST, and the list is one strip at the
 * foot of the screen rather than three controls in three places.
 *
 * ---------------------------------------------------------------------------
 * Budgets is pinned, and is not a chart
 *
 * Monthly budgets is a per-category limit with an editor behind it, and it lived on this
 * screen because the old fixed view had somewhere to put it. It is not something the
 * wizard could build — there is nothing to configure and no series to plot — so it is a
 * pinned tab at the end of the dock rather than a seventh shape in the picker, and it is
 * unchanged. Deleting it along with the layout it happened to sit in would have been a
 * feature removed by accident.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ChartList, ChartsStaleError } from '../api';
import {
  ChartEntry,
  CHART_TITLE_MAX,
  CHARTS_MAX,
  clearLegacyCharts,
  entrySpecs,
  newChartId,
  normaliseForSave,
  Normalised,
  readLegacyCharts,
  suggestedTitle,
} from '../analytics';
import { ChartCard } from '../components/ChartCard';
import { ChartDock, DockTab } from '../components/ChartDock';
import { BlankPlotGlyph } from '../components/ChartGlyphs';
import { ChartWizard } from '../components/ChartWizard';
import { setUrl, useUrl } from '../url';
import { Account, Chart } from '../types';

/**
 * What a refusal for staleness says here, which is not what the route says.
 *
 * The API's own sentence (`CHARTS_STALE`, backend/src/app.ts) ends "save again and it
 * will go through", and on this surface there is nothing to save again: the change was
 * not queued, it was dropped, because re-applying it over a list somebody else wrote
 * is how a chart deleted on another device comes back. Telling a reader to press a
 * button that cannot return their edit is worse than telling them nothing.
 */
const CHANGED_ELSEWHERE =
  'These charts were changed somewhere else while you were working — what you see now is the current list, and the change you just made was not saved.';

/** The list, or the two states a list that lives on a server can be in instead. */
type ChartsState =
  | { phase: 'loading' }
  | { phase: 'failed'; message: string }
  | { phase: 'ready'; list: ChartList };

/** Why the last write did not land. `stale` is the one that replaced what was on screen. */
interface SaveFailure {
  stale: boolean;
  message: string;
}

/**
 * What the client changed on its way out, in one sentence, or nothing.
 *
 * An edit this client makes to the reader's own content is an edit the reader is told
 * about — that is the whole difference between normalising and the silent substitution
 * this row exists to end. The cap is first because it is the only one that loses a
 * chart.
 */
function editsSentence(cleaned: Normalised): string | null {
  const said: string[] = [];
  const charts = (n: number) => `${n} chart${n === 1 ? '' : 's'}`;
  const were = (n: number) => (n === 1 ? 'was' : 'were');
  if (cleaned.droppedOverCap > 0)
    said.push(
      `${charts(cleaned.droppedOverCap)} could not be saved — this workspace holds at most ${CHARTS_MAX}.`,
    );
  if (cleaned.titlesShortened > 0)
    said.push(
      `${cleaned.titlesShortened} chart title${cleaned.titlesShortened === 1 ? '' : 's'} ${were(cleaned.titlesShortened)} shortened to the ${CHART_TITLE_MAX} characters this workspace stores.`,
    );
  if (cleaned.idsReminted > 0)
    said.push(`${charts(cleaned.idsReminted)} ${were(cleaned.idsReminted)} given a new internal id.`);
  if (cleaned.accountIdsTruncated > 0)
    said.push(
      `${charts(cleaned.accountIdsTruncated)} named an account this workspace cannot store in full.`,
    );
  return said.length === 0 ? null : said.join(' ');
}

export function AnalyticsScreen() {
  const [charts, setCharts] = useState<ChartsState>({ phase: 'loading' });
  /** null while the list is in flight — `useChartData` needs the two apart. */
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  /** open, and on what: a spec to edit, or null to build a new one. */
  const [wizard, setWizard] = useState<{ editing: Chart | null } | null>(null);
  const [saveFailure, setSaveFailure] = useState<SaveFailure | null>(null);
  const [edits, setEdits] = useState<string | null>(null);
  const [capReached, setCapReached] = useState(false);

  const { chart: urlChart } = useUrl();

  /*
   * The list and its version as ONE value, in a ref, mirrored into state.
   *
   * A ref because a click handler cannot read the state it set a moment ago, and the
   * write path has to know the version it is at rather than the version of the render
   * it was created in — which is the difference between two mutations producing
   * ascending versions and producing the same one twice. `commit` is the only writer
   * of either, so the mirror cannot drift from the store.
   */
  const list = useRef<ChartList | null>(null);
  /** The latest list the reader wants saved. Later intents replace it rather than queue. */
  const pending = useRef<ChartEntry[] | null>(null);
  const inFlight = useRef(false);
  /** The first PUT is the migration's, and the browser's copy is dropped when it lands. */
  const migrating = useRef(false);

  const commit = useCallback((next: ChartList) => {
    list.current = next;
    setCharts({ phase: 'ready', list: next });
  }, []);

  /**
   * Sends the pending list, one at a time, until there is nothing left to send.
   *
   * `inFlight` is cleared in a `finally` over the whole loop and not on the success
   * arm, and the difference is the worst failure this design can have: left set, every
   * later mutation is committed to the screen and NOTHING is ever sent again, with no
   * notice, because from the screen's side nothing failed.
   */
  const pump = useCallback(async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      while (pending.current !== null && list.current !== null) {
        const at = list.current;
        const sending = pending.current;
        pending.current = null;

        const cleaned = normaliseForSave(sending);
        setEdits(editsSentence(cleaned));
        try {
          const answered = await api.putCharts(at.version, cleaned.entries);
          setSaveFailure(null);
          if (migrating.current) {
            migrating.current = false;
            clearLegacyCharts();
          }
          /*
           * The reader acted again while this was out, so their newer list wins over
           * the server's echo of the older one — under the version the server has just
           * answered with, which is the only version the next PUT may carry. It does
           * mean a narrowing the server made is invisible on this path where the quiet
           * one shows it.
           */
          commit(
            pending.current === null
              ? answered
              : { version: answered.version, entries: (list.current ?? answered).entries },
          );
        } catch (e) {
          if (e instanceof ChartsStaleError) {
            // no merge, no re-apply, no retry at the new version: see the header
            pending.current = null;
            /*
             * And the migration, if this was it, is over: the version is no longer 0,
             * so `migrate` cannot fire again — left set, this flag would have some
             * later write, carrying nothing of this browser's, delete the only copy of
             * charts that were never saved anywhere.
             */
            migrating.current = false;
            commit(e.current);
            setSaveFailure({ stale: true, message: CHANGED_ELSEWHERE });
            // it described the list that was just thrown away
            setEdits(null);
          } else {
            // put it back so Try again has something to send, unless the reader has
            // already replaced it with something newer
            if (pending.current === null) pending.current = sending;
            setSaveFailure({ stale: false, message: (e as Error).message });
          }
          /* Not another turn of the loop. A server that is down would be retried as
             fast as it can refuse; a fresh press of Try again, or a fresh mutation, is
             a fresh intent and pumps again. */
          break;
        }
      }
    } finally {
      inFlight.current = false;
    }
  }, [commit]);

  /**
   * The reader's new list: on screen at once, on the wire as soon as the wire is free.
   *
   * Optimistic because a failed save must not take work off the screen that the reader
   * can see and did not undo. Unreachable before the list has loaded — a mutation over
   * a list nobody read is a save at version 0 over a workspace that has one.
   */
  const save = useCallback(
    (next: ChartEntry[]) => {
      const at = list.current;
      if (at === null) return;
      setCapReached(false);
      commit({ version: at.version, entries: next });
      pending.current = next;
      void pump();
    },
    [commit, pump],
  );

  /**
   * The migration, and the only place `finto.analytics.charts` is read.
   *
   * Both halves of the condition, out of the same response: a version above zero with
   * an empty list is a workspace where somebody deliberately deleted every chart,
   * possibly on another device, and uploading this browser's stale copy over it
   * resurrects them and is indistinguishable from a bug. The key is cleared by `pump`
   * when the PUT comes back 200 and never before, so a migration the server never took
   * is tried again on the next mount.
   *
   * Except after a refusal for staleness, which is the one failure that ends the
   * migration rather than deferring it: the workspace was written by somebody else
   * while this PUT was out, its version is no longer 0, and both halves of the
   * condition above are needed. The browser's copy is left where it is, unread from
   * here ever again — the alternative is re-applying it over a list another device
   * wrote, which resurrects charts that were deliberately deleted.
   */
  const migrate = useCallback(
    (loaded: ChartList) => {
      if (loaded.version !== 0 || loaded.entries.length > 0) return;
      const stored = readLegacyCharts();
      if (stored.length === 0) return;
      migrating.current = true;
      save(stored.map((spec): ChartEntry => ({ known: true, spec })));
    },
    [save],
  );

  const loadCharts = useCallback(() => {
    // paired with the guard on the answer below: without it a re-run would blank a
    // screen that is holding a list and then refuse to fill it back in
    if (list.current !== null) return;
    setCharts({ phase: 'loading' });
    api
      .charts()
      .then((loaded) => {
        /*
         * Only into a screen that is holding nothing. Two reads can be in flight at
         * once — StrictMode double-invokes this effect in development, and Try again
         * is a second call by hand — and a later answer to an earlier read carries an
         * OLDER version. Committing it would lower the version the write path is
         * holding, and the next save is then refused for staleness against a list
         * nobody else touched. It would also run the migration twice.
         */
        if (list.current !== null) return;
        commit(loaded);
        migrate(loaded);
      })
      .catch((e: unknown) => {
        // never a fall back to what this browser happens to hold: that is a list the
        // reader would edit and then save at version 0, over the one they could not read
        setCharts({ phase: 'failed', message: (e as Error).message });
      });
  }, [commit, migrate]);

  useEffect(loadCharts, [loadCharts]);

  /*
   * The accounts are read once, here, and handed down. Every card would otherwise ask
   * for the same list — a workspace of five per-account charts is five identical
   * requests — and the answer is the same for all of them.
   *
   * Hidden accounts are kept in what is stored: a chart pointed at one must keep
   * drawing rather than turn into "that account is no longer here" because it was taken
   * off the Overview's rail. The wizard is what filters them out of the CHOICES.
   *
   * Asking again is a control and not a page reload, for the same reason the read is
   * shared: one failure here stops every per-account card on the screen at once, so the
   * way out of it has to be a step and not a fresh start on the whole workspace.
   */
  const loadAccounts = useCallback(() => {
    setAccountsError(null);
    api
      .accounts(true)
      .then((rows) => {
        setAccounts(rows);
        setAccountsError(null);
      })
      .catch((e: unknown) => {
        // an empty list would be a claim that the workspace has no accounts, and every
        // per-account chart on the screen would then say its account had been deleted
        setAccounts(null);
        setAccountsError((e as Error).message);
      });
  }, []);

  useEffect(loadAccounts, [loadAccounts]);

  const ready = charts.phase === 'ready';
  const entries = ready ? charts.list.entries : [];
  const specs = entrySpecs(entries);
  const unreadable = entries.length - specs.length;

  /**
   * Which tab is showing.
   *
   * The URL is asked first and is not trusted: an id it carries may be a chart this
   * workspace does not have (a link from somebody else, or a chart since deleted), and
   * showing the first chart under a URL naming another one is better than a blank
   * screen with a dock full of names. Falling back to the first chart rather than to
   * nothing is also what makes the workspace open where it was left in the common case
   * where the URL carries nothing at all.
   *
   * Nothing here writes the URL, which is what keeps an arrival at `?chart=c-b` from
   * being rewritten to nothing while the list is still in flight: `specs` is empty
   * then, the fallback is only READ, and the id is found the moment the list lands.
   */
  const known = specs.some((c) => c.id === urlChart);
  const activeId = known ? urlChart : (specs[0]?.id ?? null);
  const active = specs.find((c) => c.id === activeId) ?? null;

  const show = (id: string) => setUrl({ chart: id });

  /** Where a chart sits on the list, which is not where it sits among the drawable ones. */
  const positionOf = (id: string) => entries.findIndex((e) => e.known && e.spec.id === id);

  const onSave = (spec: Chart) => {
    const at = positionOf(spec.id);
    if (at < 0 && entries.length >= CHARTS_MAX) {
      // refused here rather than by the route, which would refuse the WHOLE list and
      // say so in a sentence about a limit the reader has no way to see
      setCapReached(true);
      setWizard(null);
      return;
    }
    const entry: ChartEntry = { known: true, spec };
    save(at < 0 ? [...entries, entry] : entries.map((e, i) => (i === at ? entry : e)));
    setWizard(null);
    /*
     * Only a chart that did not exist a moment ago. Every tab carries its own ⋮, so an
     * edit is as often a change to the LIST as to the chart on screen — and the reader
     * who renamed the third tab while reading the first did not ask to be moved to the
     * third. The same rule `remove` states at length, and the two disagreed: this one
     * navigated on every save.
     *
     * Nothing is needed for the case where the edited chart IS the one showing. It is
     * already at this URL, and `setUrl` treats a write that changes nothing as the
     * non-navigation it is.
     */
    if (at < 0) show(spec.id);
  };

  /* Everything below is keyed on an id rather than on a spec: the dock is what calls
     them now, and a strip of tabs knows which chart it is pointing at and nothing else
     about it. */
  const edit = (id: string) => {
    const spec = specs.find((c) => c.id === id);
    if (spec) setWizard({ editing: spec });
  };

  const duplicate = (id: string) => {
    const at = positionOf(id);
    if (at < 0) return;
    if (entries.length >= CHARTS_MAX) {
      setCapReached(true);
      return;
    }
    const source = entries[at];
    if (!source.known) return;
    const copy: Chart = {
      ...source.spec,
      id: newChartId(),
      title: `${source.spec.title} (copy)`,
    };
    save([...entries.slice(0, at + 1), { known: true, spec: copy }, ...entries.slice(at + 1)]);
    show(copy.id);
  };

  const remove = (id: string) => {
    const at = positionOf(id);
    if (at < 0) return;
    const next = entries.filter((_, i) => i !== at);
    save(next);
    /*
     * Only when what went was what was showing. Every tab carries its own ⋮, so a
     * delete is as often an edit to the LIST as it is to the chart on screen — and
     * moving the reader then would take them off the chart they are reading and put
     * them beside the one they just deleted, which is the single place they did not
     * ask to be.
     */
    if (id !== activeId) return;
    /*
     * The neighbour, and `replace`: deleting a chart is not a place to come Back to —
     * Back would land on the URL naming the chart that no longer exists, and the
     * fallback above would put the reader on the first chart with no way to tell that
     * anything had happened.
     */
    const left = entrySpecs(next);
    const gone = specs.findIndex((c) => c.id === id);
    const neighbour = left[Math.min(gone, left.length - 1)];
    setUrl({ chart: neighbour ? neighbour.id : null }, 'replace');
  };

  const tabs: DockTab[] = specs.map((c) => ({
    id: c.id,
    label: c.title || suggestedTitle(c),
    glyph: c.kind,
  }));

  return (
    <div className="screen-inner analytics-screen">
      <h1 className="title">Analytics</h1>

      {accountsError && (
        <p className="error">
          Error: {accountsError}{' '}
          <button className="btn-ghost btn-sm" onClick={loadAccounts}>
            Try again
          </button>
        </p>
      )}

      {/* everything the screen has to say about the LIST rather than about a chart:
          announced, because none of it is where the reader was looking */}
      <div aria-live="polite">
        {saveFailure && (
          <p className="error">
            {saveFailure.stale ? saveFailure.message : `Not saved: ${saveFailure.message}`}{' '}
            {!saveFailure.stale && (
              <button className="btn-ghost btn-sm" onClick={() => void pump()}>
                Try again
              </button>
            )}
          </p>
        )}
        {capReached && (
          <p className="error">
            This workspace holds at most {CHARTS_MAX} charts. Delete one to make room.
          </p>
        )}
        {edits && <p className="hint">{edits}</p>}
        {unreadable > 0 && (
          <p className="hint">
            {unreadable === 1
              ? '1 chart on this list was made by a newer version of Finto'
              : `${unreadable} charts on this list were made by a newer version of Finto`}
            . {unreadable === 1 ? 'It is kept' : 'They are kept'} and saved with the rest, and
            cannot be shown here.
          </p>
        )}
      </div>

      <div className="chart-stage">
        {charts.phase === 'loading' ? (
          <p className="empty">Reading your charts…</p>
        ) : charts.phase === 'failed' ? (
          <p className="error">
            Error: {charts.message}{' '}
            <button className="btn-ghost btn-sm" onClick={loadCharts}>
              Try again
            </button>
          </p>
        ) : active ? (
          <ChartCard
            // the id, so switching tabs remounts rather than reusing the last chart's
            // loading state under the new one's name
            key={active.id}
            spec={active}
            accounts={accounts}
            accountsError={accountsError}
          />
        ) : (
          <Blank onNew={() => setWizard({ editing: null })} />
        )}
      </div>

      <ChartDock
        tabs={tabs}
        activeId={activeId}
        onSelect={show}
        onNew={() => setWizard({ editing: null })}
        onEdit={edit}
        onDuplicate={duplicate}
        onDelete={remove}
        // a list nobody has read yet is a list nothing may be added to or taken from
        actionsDisabled={!ready}
      />

      <ChartWizard
        open={wizard !== null}
        editing={wizard?.editing ?? null}
        accounts={accounts}
        accountsError={accountsError}
        onClose={() => setWizard(null)}
        onSave={onSave}
      />
    </div>
  );
}

/**
 * The screen before anything has been made on it: a mark, a line and the way in.
 *
 * It carried two paragraphs of instructions — what a shape is, what the wizard will ask
 * next, where the charts are kept — and every one of those questions is answered by
 * pressing the button underneath them. The one thing this has to say is that the
 * emptiness is the starting state and not a failure to load, which is what the mark
 * says: a bare axis, and deliberately not one of the six shapes, because a drawn chart
 * here would read as a chart that did not arrive.
 */
const Blank = ({ onNew }: { onNew: () => void }) => (
  <div className="chart-blank">
    <span className="chart-blank-mark">
      <BlankPlotGlyph />
    </span>
    <h2 className="block-title chart-blank-title">Nothing plotted yet</h2>
    {/* not "Create chart", which is what the wizard's own submit says: two controls a
        step apart with one name is what makes a screenshot of a bug unreadable */}
    <button className="btn" onClick={onNew}>
      Build your first chart
    </button>
  </div>
);
