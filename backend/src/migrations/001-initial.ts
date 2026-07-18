/**
 * Initial schema.
 *
 * This is 001-006 from the development history squashed into one: before publication
 * exactly one database ever went through them, so replaying six steps on an empty DB
 * has no value. The result is the same, minus the traces of evolution - columns that
 * were once added with ALTER TABLE are declared in their proper places.
 *
 * Idempotent (IF NOT EXISTS + ON CONFLICT DO NOTHING): safe to run on top of a
 * database where the tables already exist.
 *
 * The settings and income sources seed comes from config, i.e. from .env on first
 * run. After that the source of truth is the settings and income_sources tables,
 * edited from the app (see appsettings.ts).
 */
import type Database from 'better-sqlite3';
import { config } from '../config';
import type { Migration } from './helpers';

export const migration001: Migration = {
  id: 1,
  name: 'initial',
  up(db: Database.Database): void {
    db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  name TEXT NOT NULL,
  currency TEXT NOT NULL,
  balance REAL NOT NULL DEFAULT 0,
  iban TEXT,
  eb_session_id TEXT,
  last_synced_at TEXT,
  -- from which date (ISO) the account's history is already loaded: if SYNC_START
  -- moves further back, sync backfills the gap [SYNC_START, history_from)
  history_from TEXT,
  -- account removed by the user: not shown, not counted, not synced
  hidden INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  date TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  mcc INTEGER,
  -- category slug (see categorizer.ts); human-readable names live in the client
  category TEXT NOT NULL DEFAULT 'other',
  -- transfer between own accounts: neither income nor expense (see classify.ts)
  transfer INTEGER NOT NULL DEFAULT 0,
  -- manual mark from the app: NULL = auto-detection decides, 0/1 = the user decided
  transfer_manual INTEGER,
  -- refund / cancelled purchase: arrives positive, but subtracts from spending
  refund INTEGER NOT NULL DEFAULT 0,
  -- amount in the base currency at that date's rate, and the rate itself
  base_amount REAL,
  fx_rate REAL,
  -- income source id (income_sources.id); *_manual - the user's explicit choice
  income_source TEXT,
  income_source_manual TEXT,
  -- recurring payment (subscription, rent): detected from history
  recurring INTEGER NOT NULL DEFAULT 0,
  -- one-off large purchase: spread over 12 months in the goal calculation
  one_off INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);

CREATE TABLE IF NOT EXISTS fx_rates (
  date TEXT NOT NULL,     -- YYYY-MM-DD
  currency TEXT NOT NULL, -- ISO code
  rate REAL NOT NULL,     -- hryvnia per unit of currency
  PRIMARY KEY (date, currency)
);

CREATE TABLE IF NOT EXISTS category_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern TEXT NOT NULL,  -- substring of the description, case-insensitive
  category TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(pattern)
);

CREATE TABLE IF NOT EXISTS transfer_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  description TEXT NOT NULL,
  account_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(description, account_id)
);

CREATE TABLE IF NOT EXISTS recurring_ignores (
  key TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS budgets (
  category TEXT PRIMARY KEY,
  monthly REAL NOT NULL
);

-- baseline minimum line items for the Goal screen
CREATE TABLE IF NOT EXISTS baseline_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL UNIQUE,
  monthly REAL NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS income_sources (
  id TEXT PRIMARY KEY,      -- slug: salary, family, other, freelance...
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('own', 'external')),
  patterns TEXT NOT NULL DEFAULT '[]', -- JSON array of strings
  sort INTEGER NOT NULL DEFAULT 0,
  -- seeded sources: cannot be deleted, automation is keyed on the id
  -- (the salary category -> salary, default -> other)
  builtin INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Enable Banking sessions and OAuth states
CREATE TABLE IF NOT EXISTS eb_sessions (
  session_id TEXT PRIMARY KEY,
  aspsp_name TEXT NOT NULL,
  aspsp_country TEXT NOT NULL,
  valid_until TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS eb_auth_state (
  state TEXT PRIMARY KEY,
  aspsp_name TEXT NOT NULL,
  aspsp_country TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- sync journal
CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  -- 1 = finished without a fatal error, 0 = failed; NULL = still running
  -- (or the process was killed midway - such rows just stay in the journal)
  ok INTEGER,
  -- new transactions in the run (across all providers)
  inserted INTEGER NOT NULL DEFAULT 0,
  -- JSON array of strings: per-account/provider errors (non-fatal)
  errors TEXT NOT NULL DEFAULT '[]',
  -- the full text log of the run, a JSON array of strings
  log TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_sync_log_started ON sync_log(started_at);
`);

    const source = db.prepare(
      `INSERT INTO income_sources (id, label, kind, patterns, sort, builtin)
       VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT(id) DO NOTHING`,
    );
    source.run('salary', 'Salary', 'own', '[]', 0);
    source.run('family', 'Family support', 'external', JSON.stringify(config.familyNames), 1);
    source.run('other', 'Other', 'own', '[]', 2);

    const setting = db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING',
    );
    setting.run('base_currency', config.baseCurrency);
    setting.run('owner_names', JSON.stringify(config.ownerNames));
    setting.run('sync_interval_min', String(config.syncIntervalMin));
  },
};
