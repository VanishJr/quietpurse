/**
 * Settings: everything that is about the whole of a person's data rather than about
 * one of their accounts.
 *
 * The Overview used to carry all of it — the base currency, the owner names, the
 * recurring payments, the export and the import history across every account — under
 * a heading below the dashboard. None of it was about the account on the tab, which
 * is the only thing that screen is now for, and all of it is settings.
 *
 * The order is the point, and it is: **how Finto counts**, then **what it found**,
 * then **your data**. Reading down the screen goes from the thing that is true before
 * the app has any data to the thing you do with it afterwards. Each section is a card
 * so that the order is visible as separation rather than as a run of headings.
 *
 * It fetches two things. `AppSettingsBlock` reads the settings it edits, and the
 * recurring list is read here; both were already first-paint requests when they were
 * on the Overview, so the app's first paint is unchanged.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, apiLabel } from '../api';
import { categoryLabel } from '../categories';
import { AppSettingsBlock } from '../components/AppSettingsBlock';
import { ImportHistory } from '../components/ImportHistory';
import { IncomeSourcesBlock } from '../components/IncomeSourcesBlock';
import { saveBlob } from '../download';
import { fmtDate, fmtMoney } from '../format';
import { RecurringSummary } from '../types';
import { setUrl, useUrl } from '../url';

/** How many recurring payments to show before the tail is summarised. */
const RECURRING_LIMIT = 8;

interface Props {
  /** The bar's own Import, so the two entry points are one behaviour. */
  onOpenImport: () => void;
  onDataChanged?: () => void;
}

export function SettingsScreen({ onOpenImport, onDataChanged = () => {} }: Props) {
  const [recurring, setRecurring] = useState<RecurringSummary | null>(null);
  const [recurringError, setRecurringError] = useState<string | null>(null);

  /**
   * The import history takes the screen over, so it is a place the reader can BE -
   * and a place lives in the URL, like every other one in this app.
   *
   * It was a useState, and Shell keeps every screen mounted under `hidden`, so the
   * state outlived the screen: leave Settings with the history up, come back to
   * Settings, and the app answered with the history instead of the settings that were
   * asked for. `panel` already carries exactly this fact for the Overview's Import,
   * and Shell drops it on every move between screens, which is the whole of the fix.
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
   * In flight, and nothing else: /api/backup serialises every table, so on a real
   * history the screen sits unchanged long enough for a second click.
   */
  const [exporting, setExporting] = useState(false);

  const loadRecurring = useCallback(async () => {
    try {
      setRecurringError(null);
      setRecurring(await api.recurring());
    } catch (e) {
      setRecurringError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    loadRecurring();
  }, [loadRecurring]);

  /** Hide/restore a group of recurring payments (the backend replies with a fresh list). */
  const toggleRecurring = async (description: string, ignored: boolean) => {
    try {
      setRecurringError(null);
      setRecurring(await api.setRecurringIgnored(description, ignored));
    } catch (e) {
      setRecurringError((e as Error).message);
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

      {/* 1. how Finto counts — the two settings every figure in the app depends on */}
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

      {/* 2. what it found */}
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

      {/* 3. your data */}
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
