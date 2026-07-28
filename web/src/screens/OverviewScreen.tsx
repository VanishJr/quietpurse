import { useCallback, useEffect, useRef, useState } from 'react';
import { api, apiLabel, backupUrl, SessionUser } from '../api';
import { categoryLabel } from '../categories';
import { CsvImport } from '../components/CsvImport';
import { fmtDate, fmtMoney } from '../format';
import { providerLabel } from '../providers';
import { ThemeMode, useTheme } from '../theme';
import { Account, RecurringSummary, SyncJournalRun, SyncStatus } from '../types';

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

const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

export function OverviewScreen({
  user,
  onSignOut,
}: {
  user: SessionUser;
  onSignOut: () => void;
}) {
  const { mode, setMode } = useTheme();

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [recurring, setRecurring] = useState<RecurringSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  /** sync journal — expands on click */
  const [journal, setJournal] = useState<SyncJournalRun[]>([]);
  const [journalOpen, setJournalOpen] = useState(false);
  /** edit mode: show hidden accounts and the "remove" / "restore" buttons */
  const [editing, setEditing] = useState(false);
  /** statement import takes over the screen — it's a form, not a dialog */
  const [importing, setImporting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      // in edit mode we need the hidden ones too — otherwise there's no way to restore them
      setAccounts(await api.accounts(true));
      // Overview background: errors from these requests must not break the accounts list
      api.recurring().then(setRecurring).catch(() => {});
      api.syncStatus().then(setSync).catch(() => {});
      api.syncJournal(5).then((r) => setJournal(r.runs)).catch(() => {});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const toggleHidden = async (a: Account) => {
    try {
      setError(null);
      const updated = await api.setAccountHidden(a.id, !a.hidden);
      setAccounts((list) => list.map((x) => (x.id === updated.id ? updated : x)));
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

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const pollUntilDone = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const st = await api.syncStatus();
        setSync(st);
        if (!st.running) {
          stopPolling();
          load();
        }
      } catch {
        // the backend may have been unreachable for a couple of seconds — keep polling
      }
    }, 2000);
  }, [load, stopPolling]);

  useEffect(() => {
    load();
    return stopPolling;
  }, [load, stopPolling]);

  const onSync = async () => {
    try {
      setError(null);
      const res = await api.startSync();
      setSync(res.status);
      pollUntilDone();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const running = sync?.running ?? false;
  const lastLog = sync?.log.length ? sync.log[sync.log.length - 1] : null;

  // outside edit mode, hidden accounts aren't shown at all
  const visible = editing ? accounts : accounts.filter((a) => !a.hidden);
  const hiddenCount = accounts.filter((a) => a.hidden).length;

  // outside edit mode — only visible ones; in edit mode — all, hidden ones at the
  // end with a "Restore" button (like removed accounts)
  const active = recurring?.groups.filter((g) => !g.ignored) ?? [];
  const ignored = recurring?.groups.filter((g) => g.ignored) ?? [];
  const shownRecurring = editing ? [...active, ...ignored] : active.slice(0, RECURRING_LIMIT);

  if (importing) {
    return (
      <div className="screen-inner">
        <CsvImport onBack={() => setImporting(false)} onImported={load} />
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
          <button className="pill" onClick={() => setImporting(true)}>
            ⭳ Import
          </button>
        </div>
      </div>

      {editing && (
        <p className="edit-hint">
          A removed account isn't shown, doesn't count in analytics, and isn't synced. Its
          transactions stay in the database — you can restore it any time.
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

      {visible.length === 0 && !loading && (
        <p className="empty">
          No accounts yet. Click "Import" to load a CSV statement — the fastest way to see
          real data — or "Refresh" to sync a bank (needs a MONOBANK_TOKEN or a bank
          connected via Enable Banking).
        </p>
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

      {error && <p className="error">Error: {error}</p>}
      {lastLog && <p className="sync-log">{lastLog}</p>}
      {sync?.error && <p className="error">Sync: {sync.error}</p>}

      {/* data status: when it last synced and what needs attention */}
      {sync?.freshAsOf && !running && (
        <p className="sync-log">
          Data current as of {fmtDate(sync.freshAsOf)} {hhmm(sync.freshAsOf)}
        </p>
      )}
      {(sync?.problems ?? []).map((p) => (
        <p key={p} className="error">
          ⚠ {p}
        </p>
      ))}

      {/* sync journal: recent runs from sync_log */}
      {journal.length > 0 && (
        <div>
          <button className="btn-link" onClick={() => setJournalOpen((v) => !v)}>
            {journalOpen ? 'Hide sync journal' : 'Sync journal…'}
          </button>
          {journalOpen &&
            journal.map((r) => (
              <div key={r.id} className="journal-row">
                <div className="journal-text">
                  {r.ok === null ? '⏳' : r.ok ? '✓' : '✗'} {fmtDate(r.startedAt)}{' '}
                  {hhmm(r.startedAt)} · new: {r.inserted}
                  {r.errors.length > 0 ? ` · errors: ${r.errors.length}` : ''}
                </div>
                {r.errors.slice(0, 2).map((e) => (
                  <div key={e} className="journal-error">
                    {e}
                  </div>
                ))}
              </div>
            ))}
          {journalOpen && (
            <a className="btn-link" href={backupUrl()} download>
              ⬇ Download backup (.json)
            </a>
          )}
        </div>
      )}

      <button
        className="btn"
        style={{ display: 'block', width: '100%', margin: '8px 0' }}
        onClick={onSync}
        disabled={running}
      >
        {running ? 'Syncing…' : 'Refresh'}
      </button>

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
