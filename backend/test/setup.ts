/**
 * Shared test environment: an embedded PGlite Postgres (no Docker, no external
 * server - see ./pglite.ts) and deterministic .env values.
 *
 * The env vars are set BEFORE src/config is imported, so the real backend/.env has
 * no effect on the tests. That is why the db modules are loaded with dynamic
 * import() below: a static import would hoist above the assignments.
 */
process.env.BASE_CURRENCY = 'EUR';
process.env.OWNER_NAMES = 'Yurii Kalvenko, Yuriy Kalvenko';
process.env.FAMILY_NAMES = 'ANNA BECKER, Becker Anna';
process.env.MONOBANK_TOKEN = '';
// pino in tests: silent, and no pino-pretty worker spun up
process.env.LOG_LEVEL = 'silent';
process.env.LOG_PRETTY = '0';

// Network is forbidden in tests: rates (Monobank, NBU) must degrade quietly.
globalThis.fetch = (() =>
  Promise.reject(new Error('network disabled in tests'))) as typeof fetch;

import { freshTestDb, TEST_WORKSPACE_ID } from './pglite';

const db = await freshTestDb();
const { initDb, seedDefaults, setWorkspaceFallback } = await import('../src/db');
initDb(db);
// Tests call the data layer directly, with no HTTP session to scope them - the
// fallback stands in for what the session middleware does in production.
setWorkspaceFallback(TEST_WORKSPACE_ID);
await seedDefaults();
