import { useCallback, useEffect, useRef, useState } from 'react';
import { api, apiLabel } from '../api';
import { categoryLabel } from '../categories';
import { AppSettingsBlock } from '../components/AppSettingsBlock';
import { ImportHistory } from '../components/ImportHistory';
import { IncomeSourcesBlock } from '../components/IncomeSourcesBlock';
import { saveBlob } from '../download';
import { fmtDate, fmtMoney } from '../format';
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
    const request = ++recurringRequest.current;
    try {
      setRecurringError(null);
      const next = await api.setRecurringIgnored(description, ignored);
      if (request === recurringRequest.current) setRecurring(next);
    } catch (e) {
      if (request === recurringRequest.current) setRecurringError((e as Error).message);
    }
  };

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
    <div className="screen-inner">
      <h1 className="title">Settings</h1>

      {/* the order is the point — how Finto counts, then what it found, then your data:
          reading down goes from what is true before the app has any data to what you
          do with it afterwards */}
      <section className="settings-section">
        <h2 className="settings-title">How Finto counts</h2>
        <p className="settings-lead">
          These settings decide what totals and income-based goals mean across all accounts.
        </p>
        <AppSettingsBlock />
        <div className="settings-subsection">
          <IncomeSourcesBlock onChanged={onDataChanged} />
        </div>
      </section>

      <section className="settings-section">
        <h2 className="settings-title">Recurring payments</h2>
        <p className="settings-lead">
          Detected across every account, over the last twelve months.{' '}
          {recurring && recurring.groups.length > 0 && (
            <>
              About{' '}
              <strong>{fmtMoney(recurring.monthlyTotal, recurring.baseCurrency)}</strong> a
              month.
            </>
          )}
        </p>
        {recurringError && <p className="error">Error: {recurringError}</p>}
        {recurring && recurring.groups.length === 0 && (
          <p className="hint">
            Nothing yet. A payment has to appear in several months before Finto calls it
            recurring.
          </p>
        )}
        {[...active.slice(0, RECURRING_LIMIT), ...ignored].map((g) => (
          <div key={g.description} className="row" style={{ padding: '8px 0' }}>
            <div className="row-main">
              <div className={`row-title${g.ignored ? ' muted-strike' : ''}`}>
                {g.description}
              </div>
              <div className="row-sub">
                {categoryLabel(g.category)} · {g.months} mo. · last {fmtDate(g.lastDate)}
                {g.ignored ? ' · hidden' : ''}
              </div>
            </div>
            <div
              className={`row-value${g.ignored ? ' muted-strike' : ''}`}
              style={{ fontSize: 13, color: 'var(--ink-secondary)' }}
            >
              {fmtMoney(g.monthlyAvg, recurring?.baseCurrency)}/mo
            </div>
            <button
              className={g.ignored ? 'btn-link' : 'btn-danger'}
              onClick={() => toggleRecurring(g.description, !g.ignored)}
              aria-label={
                g.ignored ? `Restore payment ${g.description}` : `Hide payment ${g.description}`
              }
            >
              {g.ignored ? 'Restore' : 'Hide'}
            </button>
          </div>
        ))}
        {active.length > RECURRING_LIMIT && (
          <p className="hint" style={{ marginTop: 6 }}>
            …and {active.length - RECURRING_LIMIT} more, smaller
          </p>
        )}
      </section>

      <section className="settings-section">
        <h2 className="settings-title">Your data</h2>
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

      <p className="api-hint">API: {apiLabel()}</p>
    </div>
  );
}
