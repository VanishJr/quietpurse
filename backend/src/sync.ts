/**
 * Sync orchestration. A sync runs in the background (Monobank, with its limit of
 * 1 request/60 s, can take several minutes), the status is available through
 * GET /api/sync/status, and the run history lives in the sync_log table
 * (GET /api/sync/journal).
 */
import { reclassifyAll } from './classify';
import { finishSyncLogEntry, startSyncLogEntry } from './db';
import { logSync } from './logger';
import { SYNC_PROVIDERS } from './providers';
import { SyncReporter } from './providers/provider';

export interface SyncStatus {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  log: string[];
}

const status: SyncStatus = {
  running: false,
  startedAt: null,
  finishedAt: null,
  error: null,
  log: [],
};

export function getSyncStatus(): SyncStatus {
  return status;
}

/** Starts a sync of every provider in the background. false = already running. */
export function startSync(): boolean {
  if (status.running) return false;
  status.running = true;
  status.startedAt = new Date().toISOString();
  status.finishedAt = null;
  status.error = null;
  status.log = [];

  const runId = startSyncLogEntry(status.startedAt);
  const errors: string[] = [];
  let inserted = 0;

  const line = (s: string) => `${new Date().toISOString().slice(11, 19)} ${s}`;
  const reporter: SyncReporter = {
    log: (s) => {
      status.log.push(line(s));
      logSync.info(s);
    },
    error: (s) => {
      errors.push(s);
      status.log.push(line(s));
      logSync.warn(s);
    },
    addInserted: (n) => {
      inserted += n;
    },
  };

  void runSync();

  async function runSync(): Promise<void> {
    let ok = false;
    try {
      for (const p of SYNC_PROVIDERS) {
        if (!p.configured()) {
          reporter.log(`${p.key}: not configured - skipping`);
          continue;
        }
        await p.sync(reporter);
      }
      // transfers are searched across the whole database at once: the other half of
      // a pair may have just arrived from another account
      const transfers = await reclassifyAll();
      reporter.log(`transfers between own accounts: ${transfers}`);
      reporter.log(`new transactions: ${inserted}`);
      reporter.log('done');
      ok = true;
    } catch (e) {
      status.error = (e as Error).message;
      reporter.error(`error: ${status.error}`);
    } finally {
      status.running = false;
      status.finishedAt = new Date().toISOString();
      finishSyncLogEntry(runId, ok, inserted, errors, status.log);
    }
  }

  return true;
}

// ---------- auto-sync ----------

let autoSyncTimer: NodeJS.Timeout | null = null;

/**
 * (Re)arms the auto-sync. Called at startup and after the interval is edited in
 * settings - no backend restart needed. 0 = off.
 */
export function scheduleAutoSync(minutes: number): void {
  if (autoSyncTimer) clearInterval(autoSyncTimer);
  autoSyncTimer = null;
  if (minutes > 0) {
    autoSyncTimer = setInterval(() => startSync(), minutes * 60_000);
    autoSyncTimer.unref();
    logSync.info(`auto-sync every ${minutes} min`);
  } else {
    logSync.info('auto-sync disabled');
  }
}
