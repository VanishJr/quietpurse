/**
 * Sync orchestration. A sync runs in the background (Monobank, with its limit of
 * 1 request/60 s, can take several minutes), the status is available through
 * GET /api/sync/status, and the run history lives in the sync_log table
 * (GET /api/sync/journal).
 *
 * Workspaces: a sync always runs in the workspace context of whoever started it
 * (the session middleware for the button, the scheduler for auto-sync), and both
 * its status and its journal are per-workspace. One exception is gated below:
 * Monobank's token is a global .env credential, so that provider only runs for
 * the server owner's workspace - the first one ever created. Enable Banking
 * needs no gate: its bank sessions live in eb_sessions, already workspace-scoped.
 */
import { reclassifyAll } from './classify';
import {
  currentWorkspaceId,
  finishSyncLogEntry,
  listWorkspaceIds,
  runWithWorkspace,
  startSyncLogEntry,
} from './db';
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

const statuses = new Map<string, SyncStatus>();

function statusFor(workspaceId: string): SyncStatus {
  let s = statuses.get(workspaceId);
  if (!s) {
    s = { running: false, startedAt: null, finishedAt: null, error: null, log: [] };
    statuses.set(workspaceId, s);
  }
  return s;
}

export function getSyncStatus(): SyncStatus {
  return statusFor(currentWorkspaceId());
}

/** Starts a sync of every provider in the background. false = already running. */
export function startSync(): boolean {
  const workspaceId = currentWorkspaceId();
  const status = statusFor(workspaceId);
  if (status.running) return false;
  status.running = true;
  status.startedAt = new Date().toISOString();
  status.finishedAt = null;
  status.error = null;
  status.log = [];

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
    const runId = await startSyncLogEntry(status.startedAt!);
    let ok = false;
    try {
      // the oldest workspace on the server belongs to whoever set the server up -
      // the only one the global .env bank token may sync into
      const ownerWorkspace = (await listWorkspaceIds())[0];
      for (const p of SYNC_PROVIDERS) {
        if (!p.configured()) {
          reporter.log(`${p.key}: not configured - skipping`);
          continue;
        }
        if (p.key === 'monobank' && workspaceId !== ownerWorkspace) {
          reporter.log(
            'monobank: the token in .env belongs to the server owner - skipping for this workspace',
          );
          continue;
        }
        await p.sync(reporter);
      }
      // transfers are searched across the whole workspace at once: the other half of
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
      await finishSyncLogEntry(runId, ok, inserted, errors, status.log);
    }
  }

  return true;
}

// ---------- auto-sync ----------

let autoSyncTimer: NodeJS.Timeout | null = null;

/**
 * (Re)arms the auto-sync. Called at startup and after the interval is edited in
 * settings - no backend restart needed. 0 = off.
 *
 * Auto-sync serves the server owner's workspace only: it exists to keep the
 * global-credential bank feeds fresh, and those only sync there anyway (see the
 * Monobank gate above). Other workspaces sync on demand from the app.
 */
export function scheduleAutoSync(minutes: number): void {
  if (autoSyncTimer) clearInterval(autoSyncTimer);
  autoSyncTimer = null;
  if (minutes > 0) {
    autoSyncTimer = setInterval(() => {
      void (async () => {
        const owner = (await listWorkspaceIds())[0];
        if (owner) runWithWorkspace(owner, () => startSync());
      })().catch((e: Error) => logSync.error(`auto-sync failed to start: ${e.message}`));
    }, minutes * 60_000);
    autoSyncTimer.unref();
    logSync.info(`auto-sync every ${minutes} min`);
  } else {
    logSync.info('auto-sync disabled');
  }
}
