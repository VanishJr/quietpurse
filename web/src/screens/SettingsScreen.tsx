import { useCallback, useEffect, useRef, useState } from 'react';
import { api, apiLabel } from '../api';
import { categoryLabel } from '../categories';
import { AppSettingsBlock } from '../components/AppSettingsBlock';
import { ImportHistory } from '../components/ImportHistory';
import { IncomeSourcesBlock } from '../components/IncomeSourcesBlock';
import { ImportIcon } from '../components/NavIcons';
import { BackupIcon, ChevronIcon, HistoryIcon, MoreIcon } from '../components/SettingsActionIcons';
import { useDismiss } from '../dismiss';
import { saveBlob } from '../download';
import { fmtDate, fmtMoney } from '../format';
import { useTheme } from '../theme';
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
  const historyOpen = url.panel === 'history';
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
    <div key={g.key} className="settings-recurring-row">
      <span className="settings-recurring-marker" style={{ backgroundColor: categoryColor(g.category) }} aria-hidden="true" />
      <div className="settings-recurring-info">
        <div className="settings-recurring-name">{g.description}</div>
        <div className="settings-recurring-meta">
          {categoryLabel(g.category)} · {g.months} months detected · last {fmtDate(g.lastDate)}
        </div>
      </div>
      <strong className="settings-recurring-amount">
        {fmtMoney(g.monthlyAvg, recurring?.baseCurrency)}/mo
      </strong>
      {excluded ? (
        <button
          className="settings-recurring-restore"
          type="button"
          aria-label={`Restore payment ${g.description}`}
          aria-disabled={recurringBusy}
          onClick={() => toggleRecurring(g, false)}
        >
          Restore
        </button>
      ) : (
        <div
          className="settings-recurring-actions"
          ref={openRecurringMenu === g.key ? recurringMenuRef : undefined}
        >
          <button
            className="settings-recurring-trigger"
            type="button"
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
          </button>
          {openRecurringMenu === g.key && (
            <div className="settings-recurring-menu" id="settings-recurring-menu">
              <button
                ref={recurringActionRef}
                type="button"
                aria-label={`Exclude from recurring: ${g.description}`}
                onClick={() => toggleRecurring(g, true)}
              >
                Exclude from recurring
              </button>
            </div>
          )}
        </div>
      )}
    </div>
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

  if (historyOpen) {
    return (
      <div className="screen-inner">
        <ImportHistory onBack={() => setHistoryOpen(false)} onChanged={loadRecurring} />
      </div>
    );
  }

  return (
    <div className="screen-inner settings-page">
      <header className="settings-header">
        <h1 className="title">Settings</h1>
        <p className="settings-intro">
          Set how Finto counts your money, review recurring payments, and manage your local data.
        </p>
      </header>

      <div className="settings-top">
        <section className="settings-card" aria-labelledby="settings-financial-title">
          <h2 className="settings-title" id="settings-financial-title">Financial setup</h2>
          <p className="settings-lead">
            These settings decide what totals and income-based goals mean across all accounts.
          </p>
          <AppSettingsBlock onChanged={onDataChanged} />
        </section>

        <section className="settings-card" aria-labelledby="settings-income-title">
          <IncomeSourcesBlock onChanged={onDataChanged} />
        </section>
      </div>

      <section className="settings-card settings-recurring" aria-labelledby="settings-recurring-title">
        <div className="settings-recurring-header">
          <div>
            <h2 className="settings-title" id="settings-recurring-title" ref={recurringTitleRef} tabIndex={-1}>Recurring payments</h2>
            <p className="settings-lead">Detected across every account, over the last twelve months.</p>
          </div>
          {recurring && recurring.groups.length > 0 && (
            <p className="settings-recurring-summary">
              <strong>{fmtMoney(recurring.monthlyTotal, recurring.baseCurrency)}</strong>
              <span>Estimated per month</span>
            </p>
          )}
        </div>
        {!recurring && !recurringReadError && (
          <p role="status" className="hint">Loading recurring payments…</p>
        )}
        {recurringReadError && (
          <div className="settings-recurring-error">
            <p className="error" role="alert">Error: {recurringReadError}</p>
            <button className="btn-link" type="button" onClick={loadRecurring}>Retry</button>
          </div>
        )}
        {recurringActionErrors.map((failed) => (
          <div key={failed.key} className="settings-recurring-error">
            <p className="error" role="alert">Error: {failed.description}: {failed.message}</p>
          </div>
        ))}
        {recurringBusy && <p role="status" className="hint">Updating recurring payments…</p>}
        {recurring && recurring.groups.length === 0 && (
          <p className="hint">
            Nothing yet. A payment has to appear in several months before Finto calls it recurring.
          </p>
        )}
        {recurring && active.length > 0 && (
          <div className="settings-recurring-list">
            {(showAllRecurring ? active : active.slice(0, RECURRING_LIMIT)).map((g) => recurringRow(g, false))}
          </div>
        )}
        {!showAllRecurring && active.length > RECURRING_LIMIT && (
          <button className="settings-recurring-more" type="button" onClick={() => setShowAllRecurring(true)}>
            Show {active.length - RECURRING_LIMIT} more
          </button>
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

      <section className="settings-card">
        <h2 className="settings-title">Data &amp; backup</h2>
        <p className="settings-lead">
          What you have uploaded, and how to take all of it away with you.
        </p>

        <div className="settings-data-actions">
          <div className="settings-data-item">
            <button className="settings-data-action" type="button" onClick={onOpenImport}
              aria-labelledby="settings-import-label" aria-describedby="settings-import-description">
              <span className="settings-data-icon"><ImportIcon /></span>
              <span className="settings-data-copy">
                <span className="settings-data-label" id="settings-import-label">Import a statement</span>
                <span className="settings-data-description" id="settings-import-description">Upload a CSV, XLSX, or PDF statement.</span>
              </span>
              <span className="settings-data-trailing"><ChevronIcon /></span>
            </button>
          </div>
          <div className="settings-data-item">
            <button className="settings-data-action" type="button" onClick={() => setHistoryOpen(true)}
              aria-labelledby="settings-history-label" aria-describedby="settings-history-description">
              <span className="settings-data-icon"><HistoryIcon /></span>
              <span className="settings-data-copy">
                <span className="settings-data-label" id="settings-history-label">Import history</span>
                <span className="settings-data-description" id="settings-history-description">
                  Review uploads from every account and download original statement files.
                </span>
              </span>
              <span className="settings-data-trailing"><ChevronIcon /></span>
            </button>
          </div>
          <div className="settings-data-item">
            <button
              className="settings-data-action"
              type="button"
              disabled={exporting}
              aria-busy={exporting}
              aria-labelledby="settings-export-label"
              aria-describedby="settings-export-description"
              onClick={runExport}
            >
              <span className="settings-data-icon"><BackupIcon /></span>
              <span className="settings-data-copy">
                <span className="settings-data-label" id="settings-export-label">
                  {exporting ? 'Preparing backup…' : 'Export backup'}
                </span>
                <span className="settings-data-description" id="settings-export-description">
                  Download readable, unencrypted JSON. Original statement files are not included.
                </span>
              </span>
              <span className="settings-data-trailing"><ImportIcon /></span>
            </button>
            {exportError && <p className="settings-data-error error" role="alert">Error: {exportError}</p>}
          </div>
        </div>
      </section>

      {/* a button inside the heading rather than a heading inside <summary>: a summary's
          contents are presentational, which takes the heading out of heading navigation */}
      <section className="settings-card settings-advanced" aria-labelledby="settings-advanced-title">
        <h2 className="settings-title" id="settings-advanced-title">
          <button
            className="settings-advanced-toggle"
            type="button"
            aria-expanded={advancedOpen}
            aria-controls="settings-advanced-content"
            onClick={() => setAdvancedOpen((open) => !open)}
          >
            <span className="settings-advanced-label">Advanced · API connection</span>
            <span className="settings-advanced-chevron" aria-hidden="true"><ChevronIcon /></span>
          </button>
        </h2>
        <div className="settings-advanced-content" id="settings-advanced-content" hidden={!advancedOpen}>
          <p className="settings-lead">This is the address of Finto’s local REST API.</p>
          <code className="settings-api-origin">{apiLabel()}</code>
        </div>
      </section>
    </div>
  );
}
