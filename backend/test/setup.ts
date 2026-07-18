/**
 * Shared test environment: an in-memory database and deterministic .env values.
 * Set BEFORE src/config is imported (dotenv does not override variables that are
 * already set), so the real backend/.env has no effect on the tests.
 */
process.env.DB_PATH = ':memory:';
process.env.BASE_CURRENCY = 'EUR';
process.env.OWNER_NAMES = 'Yurii Kalvenko, Yuriy Kalvenko';
process.env.FAMILY_NAMES = 'ANNA BECKER, Becker Anna';
process.env.MONOBANK_TOKEN = '';
process.env.API_KEY = '';
// pino in tests: silent, and no pino-pretty worker spun up
process.env.LOG_LEVEL = 'silent';
process.env.LOG_PRETTY = '0';

// Network is forbidden in tests: rates (Monobank, NBU) must degrade quietly.
globalThis.fetch = (() =>
  Promise.reject(new Error('network disabled in tests'))) as typeof fetch;
