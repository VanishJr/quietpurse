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
import { ChartControls } from '../components/ChartControls';
import { Button } from '../components/Button';
import { Field } from '../components/Field';
import { Notice } from '../components/Notice';
import { PageHeader } from '../components/PageHeader';
import { ChartDock, DockTab } from '../components/ChartDock';
import { BlankPlotGlyph } from '../components/ChartGlyphs';
import { ChartWizard } from '../components/ChartWizard';
import { setUrl, useUrl } from '../url';
import { Account, Chart } from '../types';

/**
 * The screen's own words and not the route's: here the change was dropped, not queued,
 * because re-applying it over a list another tab or device wrote is how a chart deleted
 * there comes back. Nothing can save it again, and telling a reader to press a button
 * that cannot return their edit is worse than telling them nothing.
 */
const CHANGED_ELSEWHERE =
  'These charts were changed somewhere else while you were working, so your last change was not saved. This is the current list.';

type ChartsState =
  | { phase: 'loading' }
  | { phase: 'failed'; message: string }
  | { phase: 'ready'; list: ChartList };

/** `stale` is the failure that replaced what was on screen. */
interface SaveFailure {
  stale: boolean;
  message: string;
}

/**
 * An edit this client makes to the reader's own content is an edit the reader is told
 * about, which is the difference between normalising it and substituting for it. The
 * cap is first because it is the one of these that loses a chart.
 */
function editsSentence(cleaned: Normalised): string | null {
  const said: string[] = [];
  const charts = (n: number) => `${n} chart${n === 1 ? '' : 's'}`;
  const were = (n: number) => (n === 1 ? 'was' : 'were');
  if (cleaned.droppedOverCap > 0)
    said.push(
      `${charts(cleaned.droppedOverCap)} could not be saved because this workspace holds at most ${CHARTS_MAX}.`,
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

export function AnalyticsScreen({
  dataRevision = 0,
  accountsRevision = 0,
}: {
  dataRevision?: number;
  accountsRevision?: number;
}) {
  const [charts, setCharts] = useState<ChartsState>({ phase: 'loading' });
  /** null while the list is in flight: `useChartData` needs the two apart. */
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  /** open, and on what: a spec to edit, or null to build a new one. */
  const [wizard, setWizard] = useState<{ editing: Chart | null } | null>(null);
  const [saveFailure, setSaveFailure] = useState<SaveFailure | null>(null);
  const [edits, setEdits] = useState<string | null>(null);
  const [capReached, setCapReached] = useState(false);
  const [saving, setSaving] = useState(false);

  const { chart: urlChart } = useUrl();

  /*
   * The list and its version as ONE value, in a ref, mirrored into state.
   *
   * A ref because a click handler cannot read the state it set a moment ago, and the
   * write path has to know the version it is at rather than the version of the render
   * it was created in. That is the difference between two mutations producing
   * ascending versions and producing the same one twice.
   */
  const list = useRef<ChartList | null>(null);
  /** The latest list the reader wants saved. Later intents replace it rather than queue. */
  const pending = useRef<ChartEntry[] | null>(null);
  const inFlight = useRef(false);
  /**
   * Set by `migrate`, whose PUT is the first. While it is set, the first PUT answered 200
   * drops the browser's copy, whatever that PUT carries; a refusal for staleness sets the
   * flag back without dropping the copy.
   */
  const migrating = useRef(false);

  const commit = useCallback((next: ChartList) => {
    list.current = next;
    setCharts({ phase: 'ready', list: next });
  }, []);

  /**
   * `inFlight` is cleared in a `finally` over the whole loop and not on the success
   * arm, and the difference is the worst failure this design can have: left set, every
   * later mutation is committed to the screen and NOTHING is ever sent again, with no
   * notice, because from the screen's side nothing failed.
   */
  const pump = useCallback(async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setSaveFailure(null);
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
           * the server's echo of the older one. It goes under the version the server has
           * just answered with, which is the only version the next PUT may carry. It does
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
            // no merge, no re-apply, no retry at the new version: re-applied over the list
            // the other writer saved, the change would bring back any chart it deleted
            pending.current = null;
            /*
             * And the migration, if this was it, is over: the version is no longer 0,
             * so `migrate` cannot fire again. Left set, this flag would let some later
             * write, carrying nothing of this browser's, delete the only copy of charts
             * that were never saved anywhere.
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
      setSaving(false);
    }
  }, [commit]);

  /**
   * Optimistic because a failed save must not take work off the screen that the reader
   * can see and did not undo. Unreachable before the list has loaded, because a mutation
   * over a list nobody read is a save at version 0 over whatever list the server holds.
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
   * Both halves of the condition, out of the same response: a version above zero with
   * an empty list is a list whose every chart was deliberately deleted, perhaps on
   * another device, and uploading this browser's stale copy over it resurrects them and
   * is indistinguishable from a bug. The key is cleared by `pump` on the first PUT that
   * comes back 200 and never before, so the migration is tried again on the next mount
   * for as long as the list it reads is at version 0.
   *
   * Except after a refusal for staleness, which is the one failure that ends the
   * migration rather than deferring it: the list was written by another tab or device
   * while this PUT was out, its version is no longer 0, and both halves of the
   * condition above are needed. The browser's copy is left where it is, unread from
   * here while the list is above version 0. The alternative is re-applying it over a
   * list another device wrote, which resurrects charts that were deliberately deleted.
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
         * once: StrictMode double-invokes this effect in development, and Try again is
         * a second call by hand. A later answer to an earlier read carries an OLDER
         * version. Committing it would lower the version the write path is
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
   * Hidden accounts are kept in what is stored: a chart pointed at one must keep
   * drawing rather than turn into "that account is no longer here" because it was taken
   * off the Overview's rail. `ChartWizard` is what filters them out of the CHOICES.
   *
   * Asking again is a control and not a page reload: one failure here stops every
   * per-account chart at once, so the way out of it has to be a step and not a fresh
   * start on the whole screen.
   */
  const accountsRequest = useRef(0);
  const loadAccounts = useCallback(() => {
    const request = ++accountsRequest.current;
    setAccountsError(null);
    api
      .accounts(true)
      .then((rows) => {
        if (request !== accountsRequest.current) return;
        setAccounts(rows);
        setAccountsError(null);
      })
      .catch((e: unknown) => {
        if (request !== accountsRequest.current) return;
        // an empty list would be a claim that the reader has no accounts, and every
        // per-account chart would then say its account had been deleted
        setAccounts(null);
        setAccountsError((e as Error).message);
      });
  }, []);

  useEffect(loadAccounts, [loadAccounts, dataRevision, accountsRevision]);

  const ready = charts.phase === 'ready';
  const entries = ready ? charts.list.entries : [];
  const specs = entrySpecs(entries);
  const unreadable = entries.length - specs.length;

  /**
   * The URL is asked first and is not trusted: an id it carries may be a chart this
   * list does not have (a link from another installation, or a chart since deleted),
   * and showing the first chart under a URL naming another one is better than a blank
   * screen with a dock full of names.
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
      // without this, the chart just built is committed and shown, `normaliseForSave` cuts
      // it from the PUT, and `?chart=` is left naming a chart the server does not have
      setCapReached(true);
      setWizard(null);
      return;
    }
    const entry: ChartEntry = { known: true, spec };
    save(at < 0 ? [...entries, entry] : entries.map((e, i) => (i === at ? entry : e)));
    setWizard(null);
    /*
     * Only a chart that did not exist a moment ago. Every tab carries its own ⋮, so an
     * edit is as often a change to the LIST as to the chart on screen, and the reader
     * who renamed one tab while reading another did not ask to be moved to it.
     *
     * Nothing is needed for the case where the edited chart IS the one showing. It is
     * already at this URL, and `setUrl` treats a write that changes nothing as the
     * non-navigation it is.
     */
    if (at < 0) show(spec.id);
  };

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
     * delete is as often an edit to the LIST as it is to the chart on screen. Moving
     * the reader then would take them off the chart they are reading and put them
     * beside the one they just deleted, which is the single place they did not ask to
     * be.
     */
    if (id !== activeId) return;
    /*
     * The neighbour, and `replace`: deleting a chart is not a place to come Back to.
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
      <PageHeader title="Analytics" action={<Button type="button" variant="primary" size="standard" className="analytics-new" disabled={!ready} onClick={() => setWizard({ editing: null })}>New chart</Button>} />
      {ready && specs.length > 0 && <div className="chart-mobile-selector">
        <Field id="analytics-chart-selection" label="Selected chart" control="select" controlProps={{ value: activeId ?? '', onChange: (event) => show(event.target.value), children: tabs.map((tab) => <option key={tab.id} value={tab.id}>{tab.label}</option>) }} />
      </div>}

      {accountsError && (
        <Notice tone="error" role="alert" remedy={<Button type="button" variant="secondary" size="compact" onClick={loadAccounts}>Try again</Button>}>Error: {accountsError}</Notice>
      )}

      <div className="analytics-notices" aria-live="polite">
        {saving && <Notice>Saving charts…</Notice>}
        {saveFailure && (
          <Notice tone="error" remedy={!saveFailure.stale && <Button type="button" variant="secondary" size="compact" onClick={() => void pump()}>Try again</Button>}>
            {saveFailure.stale ? saveFailure.message : `Not saved: ${saveFailure.message}`}
          </Notice>
        )}
        {capReached && <Notice tone="error">This workspace holds at most {CHARTS_MAX} charts. Delete one to make room.</Notice>}
        {edits && <Notice tone="warning">{edits}</Notice>}
        {unreadable > 0 && (
          <Notice>
            {unreadable === 1
              ? '1 chart on this list was made by a newer version of Quietpurse'
              : `${unreadable} charts on this list were made by a newer version of Quietpurse`}
            . {unreadable === 1 ? 'It is kept' : 'They are kept'} and saved with the rest, and
            cannot be shown here.
          </Notice>
        )}
      </div>

      <div className="chart-stage">
        {charts.phase === 'loading' ? (
          <Notice placement="content" role="status">Reading your charts…</Notice>
        ) : charts.phase === 'failed' ? (
          <Notice placement="content" tone="error" role="alert" remedy={<Button type="button" variant="secondary" size="compact" onClick={loadCharts}>Try again</Button>}>Error: {charts.message}</Notice>
        ) : active ? (
          <ChartCard
            // the id, so switching tabs remounts rather than reusing the last chart's
            // loading state under the new one's name
            key={active.id}
            spec={active}
            accounts={accounts}
            accountsError={accountsError}
            dataRevision={dataRevision}
            actions={<ChartControls contextual id={active.id} label={active.title || suggestedTitle(active)} onEdit={edit} onDuplicate={duplicate} onDelete={remove} fallbackFocus={() => document.querySelector<HTMLElement>('.analytics-new')} />}
          />
        ) : (
          <Blank onNew={() => setWizard({ editing: null })} />
        )}
      </div>

      <ChartDock
        tabs={tabs}
        activeId={activeId}
        onSelect={show}
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
        dataRevision={dataRevision}
        onClose={() => setWizard(null)}
        onSave={onSave}
      />
    </div>
  );
}

/**
 * No instructions about what a shape is, what the wizard will ask next or where the
 * charts are kept, because pressing the button answers every one of those questions.
 * The one thing this has to say is that the emptiness is the starting state and not a
 * failure to load, which is what the mark says: a bare axis, and deliberately not one
 * of the chart shapes, because a drawn chart here would read as a chart that did not
 * arrive.
 */
const Blank = ({ onNew }: { onNew: () => void }) => (
  <div className="chart-blank">
    <span className="chart-blank-mark">
      <BlankPlotGlyph />
    </span>
    <h2 className="block-title chart-blank-title">Nothing plotted yet</h2>
    {/* not "Create chart", which is what the wizard's own submit says: two controls a
        step apart with one name is what makes a screenshot of a bug unreadable */}
    <Button type="button" variant="secondary" size="standard" onClick={onNew}>Build your first chart</Button>
  </div>
);
