import { useCallback, useEffect, useState } from 'react';
import { api, apiLabel, SessionUser } from '../api';
import { categoryLabel } from '../categories';
import { AppSettingsBlock } from '../components/AppSettingsBlock';
import { CsvImport } from '../components/CsvImport';
import { ImportHistory } from '../components/ImportHistory';
import { saveBlob } from '../download';
import { fmtDate, fmtMoney } from '../format';
import { providerLabel } from '../providers';
import { ThemeMode, useTheme } from '../theme';
import { Account, RecurringSummary } from '../types';

/** How many recurring payments to show in the Overview block. */
const RECURRING_LIMIT = 8;

/** Theme button cycle: system → light → dark. */
const NEXT_MODE: Record<ThemeMode, ThemeMode> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
};
const MODE_LABEL: Record<ThemeMode, string> = {
  system: '◐ Auto',
  light: '☀ Light',
  dark: '☾ Dark',
};

export function OverviewScreen({
  user,
  onSignOut,
}: {
  user: SessionUser;
  onSignOut: () => void;
}) {
  const { mode, setMode } = useTheme();

  /**
   * null = never loaded. `[]` used to mean that as well as "loaded, and empty", which
   * is how a failed request came to render as "you have no accounts".
   */
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [recurring, setRecurring] = useState<RecurringSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** edit mode: show hidden accounts and the "remove" / "restore" buttons */
  const [editing, setEditing] = useState(false);
  /**
   * Which panel has taken over the screen — they are forms, not dialogs. One state
   * and not a boolean each: "both open" would then be representable, and render
   * order would decide what the user sees. `editing` stays separate on purpose —
   * it is an in-place mode, and it survives a trip into a panel and back.
   */
  const [panel, setPanel] = useState<'import' | 'history' | null>(null);
  /**
   * The export's own refusal. The account and recurring handlers clear the screen
   * error on success, which would wipe it, and this control is at the bottom of a
   * screen whose error line is at the top.
   */
  const [exportError, setExportError] = useState<string | null>(null);
  /**
   * In flight, and nothing else: /api/backup serialises every table, so on a real
   * workspace the screen sits unchanged long enough for a second click. Its own
   * state because exportError and panel both outlive the request.
   */
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      // in edit mode we need the hidden ones too — otherwise there's no way to restore them
      setAccounts(await api.accounts(true));
      // Overview background: an error here must not break the accounts list
      api.recurring().then(setRecurring).catch(() => {});
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const toggleHidden = async (a: Account) => {
    try {
      setError(null);
      const updated = await api.setAccountHidden(a.id, !a.hidden);
      setAccounts((list) => list?.map((x) => (x.id === updated.id ? updated : x)) ?? null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** Hide/restore a group of recurring payments (the backend replies with a fresh list). */
  const toggleRecurring = async (description: string, ignored: boolean) => {
    try {
      setError(null);
      setRecurring(await api.setRecurringIgnored(description, ignored));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /**
   * A fetch and not a link: /api/backup answers 500 like anything else, and a
   * session that expired in an open tab answers 401 — `<a download>` writes both to
   * disk as finto-backup-<date>.json, and the user believes they hold their data.
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

  useEffect(() => {
    load();
  }, [load]);

  // outside edit mode, hidden accounts aren't shown at all
  const loaded = accounts ?? [];
  const visible = editing ? loaded : loaded.filter((a) => !a.hidden);
  const hiddenCount = loaded.filter((a) => a.hidden).length;

  // outside edit mode — only visible ones; in edit mode — all, hidden ones at the
  // end with a "Restore" button (like removed accounts)
  const active = recurring?.groups.filter((g) => !g.ignored) ?? [];
  const ignored = recurring?.groups.filter((g) => g.ignored) ?? [];
  const shownRecurring = editing ? [...active, ...ignored] : active.slice(0, RECURRING_LIMIT);

  if (panel === 'import') {
    return (
      <div className="screen-inner">
        <CsvImport onBack={() => setPanel(null)} onImported={load} />
      </div>
    );
  }

  if (panel === 'history') {
    return (
      <div className="screen-inner">
        <ImportHistory onBack={() => setPanel(null)} onChanged={load} />
      </div>
    );
  }

  return (
    <div className="screen-inner">
      <div className="header">
        <h1 className="title">Accounts</h1>
        <div className="header-btns">
          <button
            className="pill"
            onClick={() => setEditing((v) => !v)}
            aria-label={editing ? 'Exit account edit mode' : 'Edit accounts'}
          >
            {editing ? 'Done' : '✎ Edit'}
          </button>
          <button
            className="pill"
            onClick={() => setMode(NEXT_MODE[mode])}
            aria-label={`Theme: ${MODE_LABEL[mode]}. Click to change`}
          >
            {MODE_LABEL[mode]}
          </button>
          <button className="pill" onClick={() => setPanel('import')}>
            ⭳ Import
          </button>
        </div>
      </div>

      {/* above the content, not below it: a refusal read after the list is a refusal
          the reader has already acted on */}
      {error && <p className="error">Error: {error}</p>}

      {editing && (
        <p className="edit-hint">
          A removed account isn't shown and doesn't count in analytics. Its transactions
          stay in the database — you can restore it any time.
        </p>
      )}
      {!editing && hiddenCount > 0 && (
        <p className="edit-hint">Hidden accounts: {hiddenCount} · click "Edit" to restore</p>
      )}

      {visible.map((item) => (
        <div key={item.id} className="row">
          <div className="row-main">
            <div className={`row-title${item.hidden ? ' muted-strike' : ''}`}>{item.name}</div>
            <div className="row-sub">
              {providerLabel(item.provider)}
              {item.hidden ? ' · removed' : ''}
            </div>
          </div>
          <div className={`row-value${item.hidden ? ' muted-strike' : ''}`}>
            {fmtMoney(item.balance, item.currency)}
          </div>
          {editing && (
            <button
              className={item.hidden ? 'btn-link' : 'btn-danger'}
              onClick={() => toggleHidden(item)}
              aria-label={
                item.hidden ? `Restore account ${item.name}` : `Remove account ${item.name}`
              }
            >
              {item.hidden ? 'Restore' : 'Remove'}
            </button>
          )}
        </div>
      ))}

      {/* hiddenCount, because "no accounts yet" over accounts the user removed is the
          same untruth as over accounts that never loaded — the hidden line above says
          what is actually true, and how to undo it */}
      {accounts !== null && visible.length === 0 && hiddenCount === 0 && (
        <div className="empty">
          <p>
            No accounts yet. Load a bank statement — a .csv or .xlsx export — and the
            accounts, balances and categories all come out of the file.
          </p>
          <button className="btn" style={{ marginTop: 12 }} onClick={() => setPanel('import')}>
            ⭳ Import a statement
          </button>
        </div>
      )}

      {recurring && recurring.groups.length > 0 && (
        <section style={{ marginTop: 16, marginBottom: 8 }}>
          <div className="header">
            <h2 className="block-title">Recurring payments</h2>
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink-accent)' }}>
              ≈ {fmtMoney(recurring.monthlyTotal, recurring.baseCurrency)}/mo
            </span>
          </div>
          {editing && (
            <p className="edit-hint">
              "Hide" — if you disagree that this is a recurring payment: the group leaves the
              list and the monthly total. You can restore it right here.
            </p>
          )}
          {shownRecurring.map((g) => (
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
                {fmtMoney(g.monthlyAvg, recurring.baseCurrency)}/mo
              </div>
              {editing && (
                <button
                  className={g.ignored ? 'btn-link' : 'btn-danger'}
                  onClick={() => toggleRecurring(g.description, !g.ignored)}
                  aria-label={
                    g.ignored
                      ? `Restore payment ${g.description}`
                      : `Hide payment ${g.description}`
                  }
                >
                  {g.ignored ? 'Restore' : 'Hide'}
                </button>
              )}
            </div>
          ))}
          {!editing && active.length > RECURRING_LIMIT && (
            <p className="hint" style={{ marginTop: 6 }}>
              …and {active.length - RECURRING_LIMIT} more, smaller
            </p>
          )}
          {!editing && ignored.length > 0 && (
            <p className="hint" style={{ marginTop: 6 }}>
              Hidden payments: {ignored.length} · click "Edit" to restore
            </p>
          )}
        </section>
      )}

      <AppSettingsBlock />

      {/* the only user-reachable data export: unconditional on purpose - it used to
          sit inside the sync journal, which a workspace that never synced never had */}
      <div style={{ margin: '8px 0' }}>
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
          Every transaction, account and setting, as readable JSON — not encrypted, so
          anyone who opens the file can read it. The statement files you uploaded are not
          in it; download those from Import history.
        </p>
        <button
          className="btn-link"
          type="button"
          style={{ display: 'block' }}
          onClick={() => setPanel('history')}
        >
          ⧉ Import history
        </button>
      </div>

      <p className="api-hint">
        {user.email} ·{' '}
        <button className="btn-link" type="button" onClick={onSignOut}>
          Sign out
        </button>
        <br />
        API: {apiLabel()}
      </p>
    </div>
  );
}
