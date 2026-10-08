import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api, apiLabel } from '../api';
import { categoryLabel } from '../categories';
import { AppSettingsBlock } from '../components/AppSettingsBlock';
import { ImportHistory } from '../components/ImportHistory';
import { IncomeSourcesBlock } from '../components/IncomeSourcesBlock';
import { PageHeader } from '../components/PageHeader';
import { Button } from '../components/Button';
import { Notice } from '../components/Notice';
import { ImportIcon } from '../components/NavIcons';
import { BackupIcon, ChevronIcon, HistoryIcon, MoreIcon } from '../components/SettingsActionIcons';
import { useDismiss } from '../dismiss';
import { saveBlob } from '../download';
import { fmtDate, fmtMoney } from '../format';
import { useTheme } from '../theme';
import { ScreenShown } from '../screen';
import { RecurringSummary } from '../types';
import { setUrl, useUrl } from '../url';

const RECURRING_LIMIT = 8;

/** By `key`: a group answers under its newest spelling, and that moves between reads. */
const recurringActionObsolete = (summary: RecurringSummary, key: string, ignored: boolean) => {
  const group = summary.groups.find((item) => item.key === key);
  return !group || group.ignored === ignored;
};

type FailedRecurringAction = { key: string; description: string; ignored: boolean; message: string };

interface Props {
  /** The bar's own Import, so the two entry points are one behaviour. */
  onOpenImport: () => void;
  onDataChanged?: () => void;
  dataRevision?: number;
}

export function SettingsScreen({
  onOpenImport,
  onDataChanged = () => {},
  dataRevision = 0,
}: Props) {
  const [recurring, setRecurring] = useState<RecurringSummary | null>(null);
  const [recurringReadError, setRecurringReadError] = useState<string | null>(null);
  const [recurringActionErrors, setRecurringActionErrors] = useState<FailedRecurringAction[]>([]);
  const recurringRequest = useRef(0);
  const recurringAnswer = useRef<{ request: number; summary: RecurringSummary } | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [recurringBusy, setRecurringBusy] = useState(false);
  const [openRecurringMenu, setOpenRecurringMenu] = useState<string | null>(null);
  const [showAllRecurring, setShowAllRecurring] = useState(false);
  const recurringMenuRef = useRef<HTMLDivElement>(null);
  const recurringTriggerRef = useRef<HTMLButtonElement>(null);
  const recurringActionRef = useRef<HTMLButtonElement>(null);
  const recurringTitleRef = useRef<HTMLHeadingElement>(null);
  const { categoryColor } = useTheme();

  useDismiss(
    openRecurringMenu,
    (target) => !!recurringMenuRef.current?.contains(target),
    () => {
      setOpenRecurringMenu(null);
      recurringTriggerRef.current?.focus();
    },
    () => setOpenRecurringMenu(null),
  );

  useEffect(() => {
    if (openRecurringMenu) recurringActionRef.current?.focus();
  }, [openRecurringMenu]);

  /**
   * The import history takes the screen over, so it is a place the reader can BE, and
   * it lives in the URL rather than in a `useState`: the Shell keeps every screen
   * mounted under `hidden`, so state would outlive the visit, and coming back to
   * Settings would answer with the history instead of the settings that were asked
   * for. What closes it when the reader leaves is written in `web/src/SPEC.md`, under
   * *Where the reader is*.
   */
  const url = useUrl();
  const shown = useContext(ScreenShown);
  const historyOpen = url.screen === 'settings' && url.panel === 'history';
  const setHistoryOpen = (open: boolean): void =>
    setUrl({ screen: 'settings', panel: open ? 'history' : null });

  /**
   * The export's own refusal. It sits at the bottom of a long screen, and the error
   * line of any other block on it is somewhere the reader is no longer looking.
   */
  const [exportError, setExportError] = useState<string | null>(null);
  /**
   * In flight, and nothing else: on a real history the export takes long enough for a
   * second click while the first is still out.
   */
  const [exporting, setExporting] = useState(false);

  const takeRecurring = useCallback((request: number, summary: RecurringSummary) => {
    recurringAnswer.current = { request, summary };
    setRecurring(summary);
    setRecurringActionErrors((failed) =>
      failed.filter((action) => !recurringActionObsolete(summary, action.key, action.ignored)));
  }, []);

  const loadRecurring = useCallback(async () => {
    const request = ++recurringRequest.current;
    setOpenRecurringMenu(null);
    setRecurring(null);
    setRecurringReadError(null);
    try {
      const next = await api.recurring();
      if (request === recurringRequest.current) takeRecurring(request, next);
    } catch (e) {
      if (request === recurringRequest.current) setRecurringReadError((e as Error).message);
    }
  }, [takeRecurring]);

  useEffect(() => {
    loadRecurring();
  }, [dataRevision, loadRecurring]);

  const toggleRecurring = async ({ key, description }: RecurringSummary['groups'][number], ignored: boolean) => {
    if (recurringBusy) return;
    setRecurringBusy(true);
    if (ignored) recurringTriggerRef.current?.focus();
    setOpenRecurringMenu(null);
    const request = ++recurringRequest.current;
    const overtaken = () => {
      const latest = recurringAnswer.current;
      return !!latest && latest.request > request && recurringActionObsolete(latest.summary, key, ignored);
    };
    const otherPayments = (failed: FailedRecurringAction[]) => failed.filter((action) => action.key !== key);
    setRecurringActionErrors(otherPayments);
    try {
      const next = await api.setRecurringIgnored(description, ignored);
      if (request === recurringRequest.current) takeRecurring(request, next);
      else if (!overtaken()) await loadRecurring();
      const title = recurringTitleRef.current;
      const focused = document.activeElement;
      if (!focused || focused === document.body || title?.closest('section')?.contains(focused)) {
        title?.focus();
      }
    } catch (e) {
      if (!overtaken()) {
        const refused = { key, description, ignored, message: (e as Error).message };
        setRecurringActionErrors((failed) => [...otherPayments(failed), refused]);
      }
    } finally {
      setRecurringBusy(false);
    }
  };

  const recurringRow = (g: RecurringSummary['groups'][number], excluded: boolean) => (
    <article key={g.key} className="settings-recurring-row" aria-label={`Recurring payment ${g.description}`}
      aria-describedby={recurringActionErrors.some((failed) => failed.key === g.key)
        ? `settings-recurring-error-${encodeURIComponent(g.key)}` : undefined}>
      <span className="settings-recurring-marker" style={{ backgroundColor: categoryColor(g.category) }} aria-hidden="true" />
      <h3 className="settings-recurring-name">{g.description}</h3>
      <strong className="settings-recurring-amount">
        <span className="financial-value"><span className="financial-value-text">{fmtMoney(g.monthlyAvg, recurring?.baseCurrency)}</span></span><span className="financial-qualifier">/mo</span>
      </strong>
      <div className="settings-recurring-meta">
        {excluded && 'Excluded · '}{categoryLabel(g.category)} · {g.months} months detected · last {fmtDate(g.lastDate)}
      </div>
      {excluded ? (
        <Button type="button" variant="secondary" size="compact"
          className="settings-recurring-restore"
          aria-label={`Restore payment ${g.description}`}
          aria-disabled={recurringBusy}
          onClick={() => toggleRecurring(g, false)}
        >
          Restore
        </Button>
      ) : (
        <div
          className="settings-recurring-actions"
          ref={openRecurringMenu === g.key ? recurringMenuRef : undefined}
        >
          <Button type="button" variant="tertiary" size="touch" iconOnly
            className="settings-recurring-trigger"
            aria-label={`Actions for ${g.description}`}
            aria-expanded={openRecurringMenu === g.key}
            aria-controls={openRecurringMenu === g.key ? 'settings-recurring-menu' : undefined}
            aria-disabled={recurringBusy}
            ref={openRecurringMenu === g.key ? recurringTriggerRef : undefined}
            onClick={(event) => {
              if (recurringBusy) return;
              recurringTriggerRef.current = event.currentTarget;
              if (openRecurringMenu === g.key) event.currentTarget.focus();
              setOpenRecurringMenu(openRecurringMenu === g.key ? null : g.key);
            }}
          >
            <MoreIcon />
          </Button>
          {openRecurringMenu === g.key && (
            <div className="settings-recurring-menu" id="settings-recurring-menu">
              <Button type="button" variant="secondary" size="standard"
                ref={recurringActionRef}
                aria-label={`Exclude from recurring: ${g.description}`}
                onClick={() => toggleRecurring(g, true)}
              >
                Exclude from recurring
              </Button>
            </div>
          )}
        </div>
      )}
    </article>
  );

  /**
   * A fetch and not a link: /api/backup answers 500 like anything else, and
   * `<a download>` writes that to disk as finto-backup-<date>.json, and the user
   * believes they hold their data.
   */
  const runExport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      setExportError(null);
      const blob = await api.backup();
      // the name the backend's own Content-Disposition would have carried
      saveBlob(blob, `finto-backup-${new Date().toISOString().slice(0, 10)}.json`);
    } catch (e) {
      setExportError((e as Error).message);
    } finally {
      setExporting(false);
    }
  };

  const active = recurring?.groups.filter((g) => !g.ignored) ?? [];
  const ignored = recurring?.groups.filter((g) => g.ignored) ?? [];

  return (
    <>
      {historyOpen && (
        <div className="screen-inner">
          <ImportHistory backLabel="Back to Settings" onBack={() => setHistoryOpen(false)} onChanged={loadRecurring} />
        </div>
      )}
      <ScreenShown.Provider value={shown && !historyOpen}>
      <div className="screen-inner settings-page" hidden={historyOpen}>
      <PageHeader title="Settings" context="Set how Finto counts your money, review recurring payments, and manage your local data." />

        <section className="settings-section" aria-labelledby="settings-financial-title">
          <h2 className="settings-title" id="settings-financial-title">Financial setup</h2>
          <p className="settings-lead">
            These settings decide what totals and income-based goals mean across all accounts.
          </p>
          <AppSettingsBlock onChanged={onDataChanged} />
        </section>

        <section className="settings-section" aria-labelledby="settings-income-title">
          <IncomeSourcesBlock onChanged={onDataChanged} />
        </section>

      <section className="settings-section settings-recurring" aria-labelledby="settings-recurring-title">
        <div className="settings-recurring-header">
          <div>
            <h2 className="settings-title" id="settings-recurring-title" ref={recurringTitleRef} tabIndex={-1}>Recurring payments</h2>
            <p className="settings-lead">Detected across every account, over the last twelve months.</p>
          </div>
          {recurring && recurring.groups.length > 0 && (
            <p className="settings-recurring-summary">
              <strong><span>{fmtMoney(recurring.monthlyTotal, recurring.baseCurrency)}</span></strong>
              <span>Estimated per month</span>
            </p>
          )}
        </div>
        {!recurring && !recurringReadError && (
          <Notice role="status">Loading recurring payments…</Notice>
        )}
        {recurringReadError && (
          <Notice tone="error" role="alert" remedy={
            <Button type="button" variant="tertiary" size="standard" onClick={loadRecurring}>Retry</Button>
          }>Error: {recurringReadError}</Notice>
        )}
        {recurringActionErrors.map((failed) => (
          <Notice key={failed.key} tone="error" role="alert" id={`settings-recurring-error-${encodeURIComponent(failed.key)}`}>
            Error: {failed.description}: {failed.message}
          </Notice>
        ))}
        {recurringBusy && <Notice role="status">Updating recurring payments…</Notice>}
        {recurring && recurring.groups.length === 0 && (
          <Notice>
            Nothing yet. A payment has to appear in several months before Finto calls it recurring.
          </Notice>
        )}
        {recurring && active.length > 0 && (
          <div className="settings-recurring-list">
            {(showAllRecurring ? active : active.slice(0, RECURRING_LIMIT)).map((g) => recurringRow(g, false))}
          </div>
        )}
        {!showAllRecurring && active.length > RECURRING_LIMIT && (
          <Button className="settings-recurring-more" type="button" variant="tertiary" size="standard" onClick={() => setShowAllRecurring(true)}>
            Show {active.length - RECURRING_LIMIT} more
          </Button>
        )}
        {ignored.length > 0 && (
          <details className="settings-recurring-excluded">
            <summary>
              <span className="settings-recurring-excluded-chevron" aria-hidden="true"><ChevronIcon /></span>
              Excluded payments ({ignored.length})
            </summary>
            <div className="settings-recurring-list">
              {ignored.map((g) => recurringRow(g, true))}
            </div>
          </details>
        )}
      </section>

      <section className="settings-section" aria-labelledby="settings-data-title">
        <h2 className="settings-title" id="settings-data-title">Data &amp; backup</h2>
        <p className="settings-lead">
          What you have uploaded, and how to take all of it away with you.
        </p>

        <div className="settings-data-actions">
          <div className="settings-data-item">
            <Button className="settings-data-action" type="button" variant="tertiary" size="standard" onClick={onOpenImport}
              aria-labelledby="settings-import-label" aria-describedby="settings-import-description">
              <span className="settings-data-icon"><ImportIcon /></span>
              <span className="settings-data-copy">
                <span className="settings-data-label" id="settings-import-label">Import a statement</span>
                <span className="settings-data-description" id="settings-import-description">Upload a CSV, XLSX, or PDF statement.</span>
              </span>
              <span className="settings-data-trailing"><ChevronIcon /></span>
            </Button>
          </div>
          <div className="settings-data-item">
            <Button className="settings-data-action" type="button" variant="tertiary" size="standard" onClick={() => setHistoryOpen(true)}
              aria-labelledby="settings-history-label" aria-describedby="settings-history-description">
              <span className="settings-data-icon"><HistoryIcon /></span>
              <span className="settings-data-copy">
                <span className="settings-data-label" id="settings-history-label">Import history</span>
                <span className="settings-data-description" id="settings-history-description">
                  Review uploads from every account and download original statement files.
                </span>
              </span>
              <span className="settings-data-trailing"><ChevronIcon /></span>
            </Button>
          </div>
          <div className="settings-data-item">
            <Button className="settings-data-action" type="button" variant="tertiary" size="standard"
              pending={exporting} aria-busy={exporting}
              aria-labelledby="settings-export-label"
              aria-describedby="settings-export-description"
              onClick={runExport}
            >
              <span className="settings-data-icon"><BackupIcon /></span>
              <span className="settings-data-copy">
                <span className="settings-data-label" id="settings-export-label">
                  Export backup
                </span>
                <span className="settings-data-description" id="settings-export-description">
                  Download readable, unencrypted JSON. Original statement files are not included.
                </span>
              </span>
              <span className="settings-data-trailing"><ImportIcon /></span>
            </Button>
            {exporting && <Notice role="status">Preparing backup…</Notice>}
            {exportError && <Notice className="settings-data-error" tone="error" role="alert">Error: {exportError}</Notice>}
          </div>
        </div>
      </section>

      {/* a button inside the heading rather than a heading inside <summary>: a summary's
          contents are presentational, which takes the heading out of heading navigation */}
      <section className="settings-section settings-advanced" aria-labelledby="settings-advanced-title">
        <h2 className="settings-title" id="settings-advanced-title">
          <Button className="settings-advanced-toggle" type="button" variant="tertiary" size="standard"
            aria-expanded={advancedOpen}
            aria-controls="settings-advanced-content"
            onClick={() => setAdvancedOpen((open) => !open)}
          >
            <span className="settings-advanced-label">Advanced · API connection</span>
            <span className="settings-advanced-chevron" aria-hidden="true"><ChevronIcon /></span>
          </Button>
        </h2>
        <div className="settings-advanced-content" id="settings-advanced-content" hidden={!advancedOpen}>
          <p className="settings-lead">This is the address of Finto’s local REST API.</p>
          <code className="settings-api-origin">{apiLabel()}</code>
        </div>
      </section>
      </div>
      </ScreenShown.Provider>
    </>
  );
}
