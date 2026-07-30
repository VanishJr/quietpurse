/**
 * Shared test environment: a migrated Postgres (embedded PGlite by default, a real
 * server when TEST_DATABASE_URL is set - see ./pglite.ts) and deterministic .env
 * values.
 *
 * The env vars are set BEFORE src/config is imported, so the real backend/.env has
 * no effect on the tests. That is why the db modules are loaded with dynamic
 * import() below: a static import would hoist above the assignments.
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

process.env.BASE_CURRENCY = 'EUR';
process.env.OWNER_NAMES = 'Yurii Kalvenko, Yuriy Kalvenko';
process.env.FAMILY_NAMES = 'ANNA BECKER, Becker Anna';
// pino in tests: silent, and no pino-pretty worker spun up
process.env.LOG_LEVEL = 'silent';
process.env.LOG_PRETTY = '0';
// Source documents go to a per-RUN directory under the OS temp dir, never to
// backend/data/: imports.test.ts, csv.test.ts, xlsx.test.ts and upload.test.ts all
// drive real imports, and gitignoring the default root would hide those statement
// blobs rather than not write them. Keyed on the pid because vitest.config.ts runs
// one process with isolate:false - src/config is read once per module registry, so
// a value that differed per file would simply be ignored.
const documentRoot = path.join(os.tmpdir(), 'finto-test-documents', String(process.pid));
process.env.DOCUMENT_STORE_PATH = documentRoot;

// Network is forbidden in tests: rates (Monobank, NBU) must degrade quietly.
globalThis.fetch = (() =>
  Promise.reject(new Error('network disabled in tests'))) as typeof fetch;

import { freshTestDb, TEST_WORKSPACE_ID } from './pglite';

// The disk counterpart of freshTestDb()'s truncate, three lines from it so the two
// resets are visibly paired: without it an empty database would sit beside the
// previous file's documents, and xlsx.test.ts's 10 MB fixture would linger for the
// rest of the run. Nothing validates the path first because there is nothing to
// validate - documentRoot is built from os.tmpdir() above rather than read back
// from the environment. The day it does come from outside, it needs the check
// assertTestDatabase gives the database URL.
await fs.rm(documentRoot, { recursive: true, force: true });

const db = await freshTestDb();
const { initDb, seedDefaults, setWorkspaceFallback } = await import('../src/db');
initDb(db);
// Tests call the data layer directly, with no HTTP session to scope them - the
// fallback stands in for what the session middleware does in production.
setWorkspaceFallback(TEST_WORKSPACE_ID);
await seedDefaults();
