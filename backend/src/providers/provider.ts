/**
 * The contract a bank data provider offers the sync orchestrator (sync.ts).
 * A provider decides for itself how to work around its rate limits and paging
 * (Monobank - 31-day windows with a 60 s pause, Enable Banking - continuation_key);
 * all it exposes is "am I configured" and "sync, reporting back here".
 *
 * An uploaded statement is a provider too, but a push-model one: it has no sync
 * (the user brings the file in through POST /api/imports), so it is not in the
 * SYNC_PROVIDERS registry. The shared part of the pipeline - insertTransactions +
 * reclassifyAll - is the same for all of them.
 */

/** Where a provider reports progress during a sync. */
export interface SyncReporter {
  /** a line in the run log (visible in the sync journal and in stdout) */
  log: (s: string) => void;
  /**
   * A non-fatal error (one account failed to sync, a session expired):
   * lands in the journal's errors and the status's problems, but the run continues.
   */
  error: (s: string) => void;
  /** how many new transactions were inserted (summed over the run) */
  addInserted: (n: number) => void;
}

export interface SyncProvider {
  key: string;
  /** false = the provider is not configured (no token/keys) - sync skips it */
  configured: () => boolean;
  sync: (r: SyncReporter) => Promise<void>;
}
