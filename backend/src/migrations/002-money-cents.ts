/**
 * Money: REAL -> INTEGER cents.
 *
 * Storing amounts as REAL meant every aggregate had to be wrapped in ROUND(..., 2) to
 * hide the drift of binary floating point. Integer minor units make SUM() exact, so
 * that rounding disappears from the queries (see money.ts for the whole rationale).
 *
 * The columns are renamed, not just retyped: `amount` -> `amount_cents`. A rename is
 * what makes the change safe - had the name stayed, an old decimal value read as cents
 * would be silently off by a factor of 100, and nothing would have flagged it.
 *
 * fx_rate stays REAL on purpose: it is a ratio, not money.
 *
 * SQLite cannot change a column's type in place, so each table is rebuilt: new table,
 * copy with conversion, drop, rename. ROUND() in SQL rounds half away from zero, which
 * is what toCents() in money.ts does - the two conversions agree.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './helpers';

/** Has the table already been converted? Makes the migration safe to re-run. */
function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

/** REAL -> INTEGER cents, preserving NULL (base_amount before its rate is known). */
const cents = (col: string) =>
  `CASE WHEN ${col} IS NULL THEN NULL ELSE CAST(ROUND(${col} * 100) AS INTEGER) END`;

export const migration002: Migration = {
  id: 2,
  name: 'money-cents',
  up(db: Database.Database): void {
    if (!hasColumn(db, 'accounts', 'balance_cents')) {
      db.exec(`
CREATE TABLE accounts_new (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  name TEXT NOT NULL,
  currency TEXT NOT NULL,
  balance_cents INTEGER NOT NULL DEFAULT 0,
  iban TEXT,
  eb_session_id TEXT,
  last_synced_at TEXT,
  -- from which date (ISO) the account's history is already loaded: if SYNC_START
  -- moves further back, sync backfills the gap [SYNC_START, history_from)
  history_from TEXT,
  -- account removed by the user: not shown, not counted, not synced
  hidden INTEGER NOT NULL DEFAULT 0
);
INSERT INTO accounts_new
  (id, provider, name, currency, balance_cents, iban, eb_session_id, last_synced_at, history_from, hidden)
SELECT id, provider, name, currency,
       COALESCE(${cents('balance')}, 0),
       iban, eb_session_id, last_synced_at, history_from, hidden
FROM accounts;
DROP TABLE accounts;
ALTER TABLE accounts_new RENAME TO accounts;
`);
    }

    if (!hasColumn(db, 'transactions', 'amount_cents')) {
      db.exec(`
CREATE TABLE transactions_new (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
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
  -- (a ratio, so it stays REAL)
  base_amount_cents INTEGER,
  fx_rate REAL,
  -- income source id (income_sources.id); *_manual - the user's explicit choice
  income_source TEXT,
  income_source_manual TEXT,
  -- recurring payment (subscription, rent): detected from history
  recurring INTEGER NOT NULL DEFAULT 0,
  -- one-off large purchase: spread over 12 months in the goal calculation
  one_off INTEGER NOT NULL DEFAULT 0
);
INSERT INTO transactions_new
  (id, account_id, provider, amount_cents, currency, date, description, mcc, category,
   transfer, transfer_manual, refund, base_amount_cents, fx_rate,
   income_source, income_source_manual, recurring, one_off)
SELECT id, account_id, provider,
       ${cents('amount')},
       currency, date, description, mcc, category,
       transfer, transfer_manual, refund,
       ${cents('base_amount')},
       fx_rate, income_source, income_source_manual, recurring, one_off
FROM transactions;
DROP TABLE transactions;
ALTER TABLE transactions_new RENAME TO transactions;
CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
`);
    }

    if (!hasColumn(db, 'budgets', 'monthly_cents')) {
      db.exec(`
CREATE TABLE budgets_new (
  category TEXT PRIMARY KEY,
  monthly_cents INTEGER NOT NULL
);
INSERT INTO budgets_new (category, monthly_cents)
SELECT category, COALESCE(${cents('monthly')}, 0) FROM budgets;
DROP TABLE budgets;
ALTER TABLE budgets_new RENAME TO budgets;
`);
    }

    if (!hasColumn(db, 'baseline_items', 'monthly_cents')) {
      // ids are copied explicitly: an AUTOINCREMENT table picks its sqlite_sequence
      // back up from the largest inserted rowid, so new items keep getting fresh ids
      db.exec(`
CREATE TABLE baseline_items_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL UNIQUE,
  monthly_cents INTEGER NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);
INSERT INTO baseline_items_new (id, label, monthly_cents, sort)
SELECT id, label, COALESCE(${cents('monthly')}, 0), sort FROM baseline_items;
DROP TABLE baseline_items;
ALTER TABLE baseline_items_new RENAME TO baseline_items;
`);
    }
  },
};
