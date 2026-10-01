import { reclassifyIdle } from '../src/classify';
import { REQUEST_TIMEOUT_MS } from '../src/rates';

/**
 * Outlasts a rates.ts call a test left parked, which ends at its own request timeout.
 * A longer wait is no substitute: every start-up check takes a turn of its own, so
 * nothing bounds how many runs queue behind that call, and only putting the network
 * offline keeps each of them from parking a call of its own.
 */
export const IDLE_TIMEOUT_MS = 2 * REQUEST_TIMEOUT_MS;

export function settleRecomputes(offline: typeof fetch): Promise<void> {
  globalThis.fetch = offline;
  return reclassifyIdle();
}
