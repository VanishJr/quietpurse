import { useCallback, useEffect, useRef, useState } from 'react';
import { api, apiLabel } from '../api';
import { categoryLabel } from '../categories';
import { AppSettingsBlock } from '../components/AppSettingsBlock';
import { ImportHistory } from '../components/ImportHistory';
import { IncomeSourcesBlock } from '../components/IncomeSourcesBlock';
import { saveBlob } from '../download';
import { fmtDate, fmtMoney } from '../format';
import { useTheme } from '../theme';
import { RecurringSummary } from '../types';
import { setUrl, useUrl } from '../url';

const RECURRING_LIMIT = 8;

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
  const [recurringError, setRecurringError] = useState<string | null>(null);
  const recurringRequest = useRef(0);
  const recurringBusyRef = useRef(false);
  const [recurringBusy, setRecurringBusy] = useState<string | null>(null);
  const [openRecurringMenu, setOpenRecurringMenu] = useState<string | null>(null);
  const [showAllRecurring, setShowAllRecurring] = useState(false);
  const recurringMenuRef = useRef<HTMLDivElement>(null);
  const recurringTriggerRef = useRef<HTMLButtonElement>(null);
  const recurringActionRef = useRef<HTMLButtonElement>(null);
  const recurringTitleRef = useRef<HTMLHeadingElement>(null);
  const { categoryColor } = useTheme();

  useEffect(() => {
    if (!openRecurringMenu) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpenRecurringMenu(null);
      recurringTriggerRef.current?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      if (!recurringMenuRef.current?.contains(event.target as Node)) {
        setOpenRecurringMenu(null);
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer, true);
    };
  }, [openRecurringMenu]);

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

  const loadRecurring = useCallback(async () => {
    const request = ++recurringRequest.current;
    setOpenRecurringMenu(null);
    setRecurring(null);
    try {
      setRecurringError(null);
      const next = await api.recurring();
      if (request === recurringRequest.current) setRecurring(next);
    } catch (e) {
      if (request === recurringRequest.current) setRecurringError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    loadRecurring();
  }, [dataRevision, loadRecurring]);

  const toggleRecurring = async (description: string, ignored: boolean) => {
    if (recurringBusyRef.current) return;
    recurringBusyRef.current = true;
    setRecurringBusy(description);
    if (ignored) recurringTriggerRef.current?.focus();
    setOpenRecurringMenu(null);
    const request = ++recurringRequest.current;
    try {
      setRecurringError(null);
      const next = await api.setRecurringIgnored(description, ignored);
      if (request === recurringRequest.current) {
        setRecurring(next);
        recurringTitleRef.current?.focus();
      }
    } catch (e) {
      if (request === recurringRequest.current) setRecurringError((e as Error).message);
    } finally {
      recurringBusyRef.current = false;
      setRecurringBusy(null);
    }
  };

  const recurringRow = (g: RecurringSummary['groups'][number], excluded: boolean) => (
    <div key={g.description} className="settings-recurring-row">
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
          disabled={recurringBusy !== null}
          onClick={() => toggleRecurring(g.description, false)}
        >
          Restore
        </button>
      ) : (
        <div className="settings-recurring-actions" ref={openRecurringMenu === g.description ? recurringMenuRef : undefined}>
          <button
            className="settings-recurring-trigger"
            type="button"
            aria-label={`Actions for ${g.description}`}
            aria-expanded={openRecurringMenu === g.description}
            aria-controls={openRecurringMenu === g.description ? 'settings-recurring-menu' : undefined}
            disabled={recurringBusy !== null}
            ref={openRecurringMenu === g.description ? recurringTriggerRef : undefined}
            onClick={(event) => {
              recurringTriggerRef.current = event.currentTarget;
              if (openRecurringMenu === g.description) event.currentTarget.focus();
              setOpenRecurringMenu(openRecurringMenu === g.description ? null : g.description);
            }}
          >
            <span aria-hidden="true">⋮</span>
          </button>
          {openRecurringMenu === g.description && (
            <div className="settings-recurring-menu" id="settings-recurring-menu">
              <button
                ref={recurringActionRef}
                type="button"
                disabled={recurringBusy !== null}
                aria-label={`Exclude from recurring: ${g.description}`}
                onClick={() => toggleRecurring(g.description, true)}
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
          <AppSettingsBlock />
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
          {recurring && (
            <p className="settings-recurring-summary">
              <strong>{fmtMoney(recurring.monthlyTotal, recurring.baseCurrency)}</strong>
              <span>Estimated per month</span>
            </p>
          )}
        </div>
        {!recurring && !recurringError && (
          <p role="status" className="hint">Loading recurring payments…</p>
        )}
        {recurringError && (
          <div className="settings-recurring-error">
            <p className="error" role="alert">Error: {recurringError}</p>
            {!recurring && <button className="btn-link" type="button" onClick={loadRecurring}>Retry</button>}
          </div>
        )}
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
            <summary>Excluded payments ({ignored.length})</summary>
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

        <button className="btn-ghost" type="button" onClick={onOpenImport}>
          ⭳ Import a statement
        </button>

        <button
          className="btn-link"
          type="button"
          style={{ display: 'block' }}
          onClick={() => setHistoryOpen(true)}
        >
          ⧉ Import history (every account)
        </button>
        <p className="hint">
          Every file you have uploaded, what it read, and the file itself to download again.
          One account's history is under the ⋮ on its balance card, on Overview. The files
          themselves are in the statements folder next to the database, on this machine.
        </p>

        <button
          className="btn-link"
          type="button"
          style={{ display: 'block' }}
          disabled={exporting}
          onClick={runExport}
        >
          ⬇ Export my data (.json)
        </button>
        {exportError && <p className="error">Error: {exportError}</p>}
        <p className="hint">
          Every transaction, account and setting, as readable JSON — not encrypted, so anyone
          who opens the file can read it. The statement files you uploaded are not in it;
          download those from Import history.
        </p>
      </section>

      <section className="settings-card settings-advanced">
        <h2 className="settings-title">Advanced · API connection</h2>
        <p className="api-hint">API: {apiLabel()}</p>
      </section>
    </div>
  );
}
