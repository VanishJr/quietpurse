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
 * charts they want, and each one is a `ChartSpec` remembered in this browser. Nothing
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
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import {
  ChartSpec,
  newChartId,
  readCharts,
  suggestedTitle,
  writeCharts,
} from '../analytics';
import { BudgetsBlock } from '../components/BudgetsBlock';
import { ChartCard } from '../components/ChartCard';
import { ChartDock, DockTab } from '../components/ChartDock';
import { BlankPlotGlyph } from '../components/ChartGlyphs';
import { ChartWizard } from '../components/ChartWizard';
import { setUrl, useUrl } from '../url';
import { Account } from '../types';

/**
 * The pinned tab's id. A `#` in it so that no chart id can ever collide with it —
 * `newChartId` builds from base-36 digits and cannot produce one.
 */
const BUDGETS_TAB = '#budgets';

export function AnalyticsScreen() {
  const [charts, setCharts] = useState<ChartSpec[]>(readCharts);
  /** null while the list is in flight — `useChartData` needs the two apart. */
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  /** open, and on what: a spec to edit, or null to build a new one. */
  const [wizard, setWizard] = useState<{ editing: ChartSpec | null } | null>(null);

  const { chart: urlChart } = useUrl();

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

  const save = (next: ChartSpec[]) => {
    setCharts(next);
    writeCharts(next);
  };

  /**
   * Which tab is showing.
   *
   * The URL is asked first and is not trusted: an id it carries may be a chart this
   * browser does not have (a link from somebody else, or a chart since deleted), and
   * showing the first chart under a URL naming another one is better than a blank
   * screen with a dock full of names. Falling back to the first chart rather than to
   * nothing is also what makes the workspace open where it was left in the common case
   * where the URL carries nothing at all.
   */
  const known = urlChart === BUDGETS_TAB || charts.some((c) => c.id === urlChart);
  const activeId = known ? urlChart : (charts[0]?.id ?? null);
  const active = charts.find((c) => c.id === activeId) ?? null;

  const show = (id: string) => setUrl({ chart: id });

  const onSave = (spec: ChartSpec) => {
    const exists = charts.some((c) => c.id === spec.id);
    save(exists ? charts.map((c) => (c.id === spec.id ? spec : c)) : [...charts, spec]);
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
    if (!exists) show(spec.id);
  };

  /* Everything below is keyed on an id rather than on a spec: the dock is what calls
     them now, and a strip of tabs knows which chart it is pointing at and nothing else
     about it. */
  const edit = (id: string) => {
    const spec = charts.find((c) => c.id === id);
    if (spec) setWizard({ editing: spec });
  };

  const duplicate = (id: string) => {
    const at = charts.findIndex((c) => c.id === id);
    if (at < 0) return;
    const copy: ChartSpec = {
      ...charts[at],
      id: newChartId(),
      title: `${charts[at].title} (copy)`,
    };
    save([...charts.slice(0, at + 1), copy, ...charts.slice(at + 1)]);
    show(copy.id);
  };

  const remove = (id: string) => {
    const at = charts.findIndex((c) => c.id === id);
    if (at < 0) return;
    const next = charts.filter((c) => c.id !== id);
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
    const neighbour = next[Math.min(at, next.length - 1)];
    setUrl({ chart: neighbour ? neighbour.id : null }, 'replace');
  };

  const tabs: DockTab[] = [
    ...charts.map((c) => ({
      id: c.id,
      label: c.title || suggestedTitle(c),
      glyph: c.kind,
    })),
    { id: BUDGETS_TAB, label: 'Budgets', pinned: true as const },
  ];

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

      <div className="chart-stage">
        {activeId === BUDGETS_TAB ? (
          <BudgetsBlock />
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
