import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { recurringKey } from './categorizer';
import { config } from './config';
import { logDb } from './logger';
import { runMigrations } from './migrations';
import { fromCents, fromCentsOrUndefined, toCents, toCentsOrNull } from './money';
import {
  Account,
  CategorySummary,
  IncomeSourceDef,
  IncomeSourceKind,
  MonthTotals,
  Summary,
  Transaction,
  TransferRule,
} from './types';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');

// the whole schema lives in versioned migrations (see migrations/index.ts)
runMigrations(db, (s) => logDb.info(s));

/**
 * The effective transfer flag: a manual mark beats auto-detection.
 * Transfer transactions count as neither income nor spending.
 */
const NOT_TRANSFER = 'COALESCE(transfer_manual, transfer) = 0';

/**
 * Transactions of hidden accounts are neither shown nor counted. They aren't
 * deleted: the classifier needs them as the other leg of a transfer - hiding N26
 * shouldn't lose the transfer flag on the matching Revolut income.
 */
const VISIBLE_ACCOUNT =
  'account_id NOT IN (SELECT id FROM accounts WHERE hidden = 1)';

// ---------- settings (key/value, source of truth, see appsettings.ts) ----------

export function getSetting(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

/**
 * Base currency from settings (falls back to env/config default while the initial
 * migration hasn't seeded a value). Needed inside db.ts too: inserting transactions
 * fills base_amount straight away for rows already in the base currency.
 */
export function currentBaseCurrency(): string {
  return getSetting('base_currency') ?? config.baseCurrency;
}

// ---------- meta ----------

export function getMeta(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setMeta(key: string, value: string): void {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

// ---------- accounts ----------

const upsertAccountStmt = db.prepare(`
INSERT INTO accounts (id, provider, name, currency, balance_cents, iban, eb_session_id)
VALUES (@id, @provider, @name, @currency, @balanceCents, @iban, @ebSessionId)
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  currency = excluded.currency,
  balance_cents = excluded.balance_cents,
  iban = excluded.iban,
  eb_session_id = COALESCE(excluded.eb_session_id, accounts.eb_session_id)
`);

export function upsertAccount(a: Account): void {
  upsertAccountStmt.run({
    id: a.id,
    provider: a.provider,
    name: a.name,
    currency: a.currency,
    balanceCents: toCents(a.balance),
    iban: a.iban ?? null,
    ebSessionId: a.ebSessionId ?? null,
  });
}

export function updateAccountBalance(id: string, balance: number): void {
  db.prepare('UPDATE accounts SET balance_cents = ? WHERE id = ?').run(toCents(balance), id);
}

/**
 * Balance = the sum of the account's transactions. For CSV accounts a statement
 * carries no balance, so this is the best approximation (exact with full history).
 */
export function recalcAccountBalanceFromTransactions(accountId: string): void {
  db.prepare(
    `UPDATE accounts SET balance_cents = (
       SELECT COALESCE(SUM(amount_cents), 0) FROM transactions WHERE account_id = @id
     ) WHERE id = @id`,
  ).run({ id: accountId });
}

export function markAccountSynced(id: string, when: string): void {
  db.prepare('UPDATE accounts SET last_synced_at = ? WHERE id = ?').run(when, id);
}

/** Remembers the earliest date for which the account's history has been fetched. */
export function markAccountHistoryFrom(id: string, fromIso: string): void {
  db.prepare(
    `UPDATE accounts SET history_from = MIN(COALESCE(history_from, @from), @from) WHERE id = @id`,
  ).run({ id, from: fromIso });
}

interface AccountRow {
  id: string;
  provider: string;
  name: string;
  currency: string;
  balance_cents: number;
  iban: string | null;
  eb_session_id: string | null;
  last_synced_at: string | null;
  history_from: string | null;
  hidden: number;
}

function rowToAccount(r: AccountRow): Account {
  return {
    id: r.id,
    provider: r.provider as Account['provider'],
    name: r.name,
    currency: r.currency,
    balance: fromCents(r.balance_cents),
    iban: r.iban ?? undefined,
    ebSessionId: r.eb_session_id ?? undefined,
    lastSyncedAt: r.last_synced_at ?? undefined,
    historyFrom: r.history_from ?? undefined,
    hidden: r.hidden === 1,
  };
}

/**
 * Visible accounts only by default: sync relies on this same list, so a hidden
 * account also stops being synced.
 */
export function listAccounts(includeHidden = false): Account[] {
  const rows = db
    .prepare(
      `SELECT * FROM accounts ${includeHidden ? '' : 'WHERE hidden = 0'} ORDER BY provider, name`,
    )
    .all() as AccountRow[];
  return rows.map(rowToAccount);
}

/** Remove an account from the app (or bring it back). Transactions stay in the database. */
export function setAccountHidden(id: string, hidden: boolean): Account | undefined {
  db.prepare('UPDATE accounts SET hidden = ? WHERE id = ?').run(hidden ? 1 : 0, id);
  const r = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | undefined;
  return r ? rowToAccount(r) : undefined;
}

export function getAccount(id: string): Account | undefined {
  const r = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | undefined;
  return r ? rowToAccount(r) : undefined;
}

// ---------- transactions ----------

const insertTxStmt = db.prepare(`
INSERT OR IGNORE INTO transactions (id, account_id, provider, amount_cents, currency, date, description, mcc, category, base_amount_cents, fx_rate)
VALUES (@id, @accountId, @provider, @amountCents, @currency, @date, @description, @mcc, @category, @baseAmountCents, @fxRate)
`);

/** Inserts a batch of transactions, silently skipping duplicates (by id). Returns the number of new ones. */
export const insertTransactions = db.transaction((txs: Transaction[]): number => {
  let inserted = 0;
  const baseCurrency = currentBaseCurrency();
  for (const t of txs) {
    // transactions already in the base currency need no conversion - fill it now;
    // for the rest base_amount is filled by backfillBaseAmounts (fxrates.ts) after sync
    const isBase = t.currency === baseCurrency;
    const amountCents = toCents(t.amount);
    const res = insertTxStmt.run({
      id: t.id,
      accountId: t.accountId,
      provider: t.provider,
      amountCents,
      currency: t.currency,
      date: t.date,
      description: t.description,
      mcc: t.mcc ?? null,
      category: t.category,
      baseAmountCents: isBase ? amountCents : null,
      fxRate: isBase ? 1 : null,
    });
    inserted += res.changes;
  }
  return inserted;
});

export interface TxFilter {
  from?: string;
  to?: string;
  accountId?: string;
  category?: string;
  limit?: number;
}

interface TxRow {
  id: string;
  account_id: string;
  provider: string;
  amount_cents: number;
  currency: string;
  date: string;
  description: string;
  mcc: number | null;
  category: string;
  transfer: number;
  transfer_manual: number | null;
  refund: number;
  base_amount_cents: number | null;
  fx_rate: number | null;
  income_source: string | null;
  income_source_manual: string | null;
  recurring: number;
  one_off: number;
}

function rowToTx(r: TxRow): Transaction {
  return {
    id: r.id,
    accountId: r.account_id,
    provider: r.provider as Transaction['provider'],
    amount: fromCents(r.amount_cents),
    currency: r.currency,
    date: r.date,
    description: r.description,
    mcc: r.mcc ?? undefined,
    category: r.category,
    transfer: (r.transfer_manual ?? r.transfer) === 1,
    transferManual: r.transfer_manual === null ? null : r.transfer_manual === 1,
    refund: r.refund === 1,
    baseAmount: fromCentsOrUndefined(r.base_amount_cents),
    incomeSource:
      r.amount_cents > 0
        ? ((r.income_source_manual ?? r.income_source ?? 'other') as Transaction['incomeSource'])
        : undefined,
    incomeSourceManual: r.income_source_manual !== null,
    recurring: r.recurring === 1,
    oneOff: r.one_off === 1,
  };
}

export function listTransactions(f: TxFilter): Transaction[] {
  const where: string[] = [VISIBLE_ACCOUNT];
  const params: Record<string, unknown> = {};
  if (f.from) {
    where.push('date >= @from');
    params.from = f.from;
  }
  if (f.to) {
    // include the whole "to" day when a date without a time is given
    where.push('date <= @to');
    params.to = f.to.length === 10 ? `${f.to}T23:59:59.999Z` : f.to;
  }
  if (f.accountId) {
    where.push('account_id = @accountId');
    params.accountId = f.accountId;
  }
  if (f.category) {
    where.push('category = @category');
    params.category = f.category;
  }
  params.limit = f.limit && f.limit > 0 ? f.limit : 1000;
  const sql = `SELECT * FROM transactions
    WHERE ${where.join(' AND ')}
    ORDER BY date DESC LIMIT @limit`;
  const rows = db.prepare(sql).all(params) as TxRow[];
  return rows.map(rowToTx);
}

/**
 * Rows without base_amount (the rate hasn't been fetched yet) are left out of the
 * summaries - otherwise we would be adding euros to hryvnias. After backfillBaseAmounts
 * (which runs on every recompute) there are normally no such rows.
 */
const CONVERTED = 'base_amount_cents IS NOT NULL';

/**
 * Spending by category in the base currency, net: a refund ("Скасування. Bolt")
 * subtracts from spending in its own category, so a total can go negative if the
 * purchase was in a previous period and the refund arrived in this one. Categories
 * that collapse to exactly zero are not shown.
 */
export function summaryByCategory(from: string, to: string): CategorySummary[] {
  const rows = db
    .prepare(
      `SELECT category, SUM(-base_amount_cents) AS total_cents
       FROM transactions
       WHERE ${NOT_TRANSFER} AND ${VISIBLE_ACCOUNT} AND ${CONVERTED}
         AND (amount_cents < 0 OR refund = 1) AND date >= ? AND date <= ?
       GROUP BY category
       HAVING total_cents <> 0
       ORDER BY total_cents DESC`,
    )
    .all(from, to) as { category: string; total_cents: number }[];
  return rows.map((r) => ({ category: r.category, total: fromCents(r.total_cents) }));
}

/** Income by category: transfers between your own accounts and refunds excluded. */
export function summaryIncomeByCategory(from: string, to: string): CategorySummary[] {
  const rows = db
    .prepare(
      `SELECT category, SUM(base_amount_cents) AS total_cents
       FROM transactions
       WHERE ${NOT_TRANSFER} AND ${VISIBLE_ACCOUNT} AND ${CONVERTED}
         AND amount_cents > 0 AND refund = 0 AND date >= ? AND date <= ?
       GROUP BY category
       ORDER BY total_cents DESC`,
    )
    .all(from, to) as { category: string; total_cents: number }[];
  return rows.map((r) => ({ category: r.category, total: fromCents(r.total_cents) }));
}

/** Effective income source: a manual mark beats auto-detection, empty = other. */
const INCOME_SOURCE = "COALESCE(income_source_manual, income_source, 'other')";

/**
 * External source (kind = external)? A source deleted from income_sources (or an
 * unknown id) counts as your own - same as the default other.
 */
const IS_EXTERNAL = `${INCOME_SOURCE} IN (SELECT id FROM income_sources WHERE kind = 'external')`;

/** Income by source in the base currency (id + label + kind). */
export function summaryIncomeBySource(from: string, to: string): Summary['incomeBySource'] {
  const rows = db
    .prepare(
      `SELECT ${INCOME_SOURCE} AS source,
              COALESCE(s.label, ${INCOME_SOURCE}) AS label,
              COALESCE(s.kind, 'own') AS kind,
              SUM(base_amount_cents) AS total_cents
       FROM transactions
       LEFT JOIN income_sources s ON s.id = ${INCOME_SOURCE}
       WHERE ${NOT_TRANSFER} AND ${VISIBLE_ACCOUNT} AND ${CONVERTED}
         AND amount_cents > 0 AND refund = 0 AND date >= ? AND date <= ?
       GROUP BY source
       ORDER BY total_cents DESC`,
    )
    .all(from, to) as (Omit<Summary['incomeBySource'][number], 'total'> & { total_cents: number })[];
  return rows.map(({ total_cents, ...r }) => ({ ...r, total: fromCents(total_cents) }));
}

export function summaryTotals(from: string, to: string): { expense: number; income: number } {
  const row = db
    .prepare(
      `SELECT SUM(CASE WHEN amount_cents < 0 OR refund = 1 THEN -base_amount_cents ELSE 0 END) AS expense_cents,
              SUM(CASE WHEN amount_cents > 0 AND refund = 0 THEN base_amount_cents ELSE 0 END) AS income_cents
       FROM transactions
       WHERE ${NOT_TRANSFER} AND ${VISIBLE_ACCOUNT} AND ${CONVERTED} AND date >= ? AND date <= ?`,
    )
    .get(from, to) as { expense_cents: number | null; income_cents: number | null };
  return {
    expense: fromCents(row.expense_cents ?? 0),
    income: fromCents(row.income_cents ?? 0),
  };
}

/**
 * Spending/income by month in the base currency - for the "over the year" chart and
 * the independence calculation. Same rules as summaryTotals: transfers between your
 * own accounts excluded, refunds subtracted from spending. On top of that:
 *  - expenseOneOff - the share of spending flagged as one-off (amortized);
 *  - incomeOwn - income from your own sources (kind = own);
 *  - incomeExternal - help from external sources (kind = external).
 */
export function summaryMonthlyTotals(from: string, to: string): MonthTotals[] {
  const rows = db
    .prepare(
      `SELECT SUBSTR(date, 1, 7) AS month,
              SUM(CASE WHEN amount_cents < 0 OR refund = 1 THEN -base_amount_cents ELSE 0 END) AS expense,
              SUM(CASE WHEN (amount_cents < 0 OR refund = 1) AND one_off = 1 THEN -base_amount_cents ELSE 0 END) AS expenseOneOff,
              SUM(CASE WHEN amount_cents > 0 AND refund = 0 THEN base_amount_cents ELSE 0 END) AS income,
              SUM(CASE WHEN amount_cents > 0 AND refund = 0 AND NOT ${IS_EXTERNAL} THEN base_amount_cents ELSE 0 END) AS incomeOwn,
              SUM(CASE WHEN amount_cents > 0 AND refund = 0 AND ${IS_EXTERNAL} THEN base_amount_cents ELSE 0 END) AS incomeExternal
       FROM transactions
       WHERE ${NOT_TRANSFER} AND ${VISIBLE_ACCOUNT} AND ${CONVERTED} AND date >= ? AND date <= ?
       GROUP BY month
       ORDER BY month ASC`,
    )
    .all(from, to) as (Omit<MonthTotals, 'month'> & { month: string })[];
  // the SUMs above are in cents - convert every money field at the boundary
  return rows.map((r) => ({
    month: r.month,
    expense: fromCents(r.expense),
    expenseOneOff: fromCents(r.expenseOneOff),
    income: fromCents(r.income),
    incomeOwn: fromCents(r.incomeOwn),
    incomeExternal: fromCents(r.incomeExternal),
  }));
}

/**
 * Average monthly spending by category over the window [from, to] in the base
 * currency: SUM per category / number of months with any money movement. One-off
 * purchases are excluded - the independence screen amortizes them separately.
 */
export function avgMonthlyByCategory(
  from: string,
  to: string,
  months: number,
): CategorySummary[] {
  if (months <= 0) return [];
  const rows = db
    .prepare(
      `SELECT category, SUM(-base_amount_cents) AS total_cents
       FROM transactions
       WHERE ${NOT_TRANSFER} AND ${VISIBLE_ACCOUNT} AND ${CONVERTED} AND one_off = 0
         AND (amount_cents < 0 OR refund = 1) AND date >= ? AND date <= ?
       GROUP BY category
       HAVING total_cents > 0
       ORDER BY total_cents DESC`,
    )
    .all(from, to) as { category: string; total_cents: number }[];
  // the sum is exact; the division by months is a genuine fraction - round to whole cents
  return rows.map((r) => ({
    category: r.category,
    total: Math.round(r.total_cents / months) / 100,
  }));
}

// ---------- classification (transfers / refunds / categories) ----------

/**
 * All transactions in chronological order - the input for classify.ts.
 * Hidden accounts are deliberately NOT filtered out (see VISIBLE_ACCOUNT above):
 * their transactions remain the other leg of a pair.
 */
export function allTransactions(): Transaction[] {
  const rows = db.prepare('SELECT * FROM transactions ORDER BY date ASC').all() as TxRow[];
  return rows.map(rowToTx);
}

export interface Classification {
  id: string;
  category: string;
  transfer: boolean;
  refund: boolean;
  /** income source (income only), null for spending */
  incomeSource: string | null;
  /** recurring payment (see the detector in classify.ts) */
  recurring: boolean;
}

const updateClassStmt = db.prepare(
  `UPDATE transactions
   SET category = @category, transfer = @transfer, refund = @refund,
       income_source = @incomeSource, recurring = @recurring
   WHERE id = @id`,
);

/**
 * Writes the classification result. Manual marks (transfer_manual,
 * income_source_manual, one_off) are left alone - they beat auto-detection.
 */
export const applyClassification = db.transaction((rows: Classification[]): void => {
  for (const r of rows) {
    updateClassStmt.run({
      id: r.id,
      category: r.category,
      transfer: r.transfer ? 1 : 0,
      refund: r.refund ? 1 : 0,
      incomeSource: r.incomeSource,
      recurring: r.recurring ? 1 : 0,
    });
  }
});

/** Manual "this is a transfer between my own accounts" mark. null - hand the decision back to auto-detection. */
export function setTransferOverride(id: string, value: boolean | null): Transaction | undefined {
  db.prepare('UPDATE transactions SET transfer_manual = ? WHERE id = ?').run(
    value === null ? null : value ? 1 : 0,
    id,
  );
  const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as TxRow | undefined;
  return row ? rowToTx(row) : undefined;
}

/**
 * Manual income source mark (an id from income_sources - validated at the API
 * level). null - hand the decision back to auto-detection.
 */
export function setIncomeSourceOverride(
  id: string,
  source: string | null,
): Transaction | undefined {
  db.prepare('UPDATE transactions SET income_source_manual = ? WHERE id = ?').run(source, id);
  const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as TxRow | undefined;
  return row ? rowToTx(row) : undefined;
}

// ---------- income sources ----------

interface IncomeSourceRow {
  id: string;
  label: string;
  kind: string;
  patterns: string;
  sort: number;
  builtin: number;
}

function rowToIncomeSource(r: IncomeSourceRow): IncomeSourceDef {
  let patterns: string[] = [];
  try {
    const v = JSON.parse(r.patterns);
    if (Array.isArray(v)) patterns = v.map(String);
  } catch {
    // corrupted JSON - treat it as having no patterns
  }
  return {
    id: r.id,
    label: r.label,
    kind: r.kind as IncomeSourceKind,
    patterns,
    sort: r.sort,
    builtin: r.builtin === 1,
  };
}

export function listIncomeSources(): IncomeSourceDef[] {
  const rows = db
    .prepare('SELECT * FROM income_sources ORDER BY sort, id')
    .all() as IncomeSourceRow[];
  return rows.map(rowToIncomeSource);
}

export function getIncomeSource(id: string): IncomeSourceDef | undefined {
  const row = db.prepare('SELECT * FROM income_sources WHERE id = ?').get(id) as
    | IncomeSourceRow
    | undefined;
  return row ? rowToIncomeSource(row) : undefined;
}

/**
 * Creates or edits a source. The kind of a builtin source can be changed (the user
 * is entitled to decide that "other" is not their own earnings), the id cannot.
 */
export function upsertIncomeSource(
  def: Pick<IncomeSourceDef, 'id' | 'label' | 'kind'> & Partial<Pick<IncomeSourceDef, 'patterns' | 'sort'>>,
): IncomeSourceDef {
  const existing = getIncomeSource(def.id);
  const nextSort =
    def.sort ??
    existing?.sort ??
    ((db.prepare('SELECT COALESCE(MAX(sort), -1) AS m FROM income_sources').get() as { m: number })
      .m +
      1);
  db.prepare(
    `INSERT INTO income_sources (id, label, kind, patterns, sort, builtin)
     VALUES (@id, @label, @kind, @patterns, @sort, 0)
     ON CONFLICT(id) DO UPDATE SET
       label = excluded.label, kind = excluded.kind,
       patterns = excluded.patterns, sort = excluded.sort`,
  ).run({
    id: def.id,
    label: def.label,
    kind: def.kind,
    patterns: JSON.stringify(def.patterns ?? existing?.patterns ?? []),
    sort: nextSort,
  });
  return getIncomeSource(def.id)!;
}

/**
 * Deletes a source (builtin ones cannot be). Transactions tagged with it (auto or
 * manual) fall back to 'other' - otherwise their income would silently drop out of
 * the by-source summaries under an unknown id.
 */
export function deleteIncomeSource(id: string): boolean {
  const src = getIncomeSource(id);
  if (!src || src.builtin) return false;
  db.transaction(() => {
    db.prepare("UPDATE transactions SET income_source = 'other' WHERE income_source = ?").run(id);
    db.prepare(
      "UPDATE transactions SET income_source_manual = 'other' WHERE income_source_manual = ?",
    ).run(id);
    db.prepare('DELETE FROM income_sources WHERE id = ?').run(id);
  })();
  return true;
}

/** Manual "one-off large purchase" mark - amortized in average spending. */
export function setOneOff(id: string, value: boolean): Transaction | undefined {
  db.prepare('UPDATE transactions SET one_off = ? WHERE id = ?').run(value ? 1 : 0, id);
  const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as TxRow | undefined;
  return row ? rowToTx(row) : undefined;
}

export function getTransaction(id: string): Transaction | undefined {
  const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as TxRow | undefined;
  return row ? rowToTx(row) : undefined;
}

// ---------- "description + account = transfer" rules ----------

interface RuleRow {
  id: number;
  description: string;
  account_id: string;
  created_at: string;
}

const rowToRule = (r: RuleRow): TransferRule => ({
  id: r.id,
  description: r.description,
  accountId: r.account_id,
  createdAt: r.created_at,
});

export function listTransferRules(): TransferRule[] {
  const rows = db
    .prepare('SELECT * FROM transfer_rules ORDER BY created_at DESC')
    .all() as RuleRow[];
  return rows.map(rowToRule);
}

/** Idempotent: a rule for the same description + account pair is simply returned. */
export function addTransferRule(description: string, accountId: string): TransferRule {
  db.prepare(
    `INSERT INTO transfer_rules (description, account_id, created_at) VALUES (?, ?, ?)
     ON CONFLICT(description, account_id) DO NOTHING`,
  ).run(description, accountId, new Date().toISOString());
  const row = db
    .prepare('SELECT * FROM transfer_rules WHERE description = ? AND account_id = ?')
    .get(description, accountId) as RuleRow;
  return rowToRule(row);
}

export function deleteTransferRule(id: number): boolean {
  return db.prepare('DELETE FROM transfer_rules WHERE id = ?').run(id).changes > 0;
}

/** How many transactions the rule covers - for the caption in the app. */
export function countRuleMatches(description: string, accountId: string): number {
  const r = db
    .prepare('SELECT COUNT(*) n FROM transactions WHERE description = ? AND account_id = ?')
    .get(description, accountId) as { n: number };
  return r.n;
}

/**
 * Clears manual marks from transactions covered by the rule: otherwise an old
 * manual `transfer_manual = 0` would keep overriding the rule that was just created,
 * and one transaction in the group would stay untagged.
 */
export function clearManualForRule(description: string, accountId: string): void {
  db.prepare(
    'UPDATE transactions SET transfer_manual = NULL WHERE description = ? AND account_id = ?',
  ).run(description, accountId);
}

// ---------- exchange rates and the base amount ----------

export function getFxRate(day: string, currency: string): number | undefined {
  const row = db
    .prepare('SELECT rate FROM fx_rates WHERE date = ? AND currency = ?')
    .get(day, currency) as { rate: number } | undefined;
  return row?.rate;
}

export function saveFxRate(day: string, currency: string, rate: number): void {
  db.prepare(
    'INSERT INTO fx_rates (date, currency, rate) VALUES (?, ?, ?) ON CONFLICT(date, currency) DO UPDATE SET rate = excluded.rate',
  ).run(day, currency, rate);
}

/** Rows already in the base currency need no rate: base_amount = amount. Returns the number updated. */
export function setBaseForBaseCurrency(baseCurrency: string): number {
  return db
    .prepare(
      'UPDATE transactions SET base_amount_cents = amount_cents, fx_rate = 1 WHERE base_amount_cents IS NULL AND currency = ?',
    )
    .run(baseCurrency).changes;
}

/**
 * Changing the base currency: every base_amount is recomputed from scratch - the
 * old values were computed in the previous currency and cannot be added to the new ones.
 */
export function resetBaseAmounts(): number {
  return db.prepare('UPDATE transactions SET base_amount_cents = NULL, fx_rate = NULL').run()
    .changes;
}

/** "Day + currency" pairs that still need a rate (across all accounts, hidden included). */
export function listUnconvertedDays(): { day: string; currency: string }[] {
  return db
    .prepare(
      `SELECT DISTINCT SUBSTR(date, 1, 10) AS day, currency
       FROM transactions WHERE base_amount_cents IS NULL ORDER BY day`,
    )
    .all() as { day: string; currency: string }[];
}

/**
 * Fills base_amount for every unconverted row of that day in that currency.
 * k - units of the base currency per unit of `currency` on that day.
 */
export function applyBaseRate(day: string, currency: string, k: number): number {
  return db
    .prepare(
      `UPDATE transactions SET base_amount_cents = CAST(ROUND(amount_cents * @k) AS INTEGER), fx_rate = @k
       WHERE base_amount_cents IS NULL AND currency = @currency AND SUBSTR(date, 1, 10) = @day`,
    )
    .run({ day, currency, k }).changes;
}

// ---------- recurring payments ----------

export interface RecurringGroup {
  description: string;
  category: string;
  /** in how many calendar months it appears */
  months: number;
  count: number;
  /** average size of a single payment in the base currency */
  avgAmount: number;
  /** what the group costs per month (total / months) */
  monthlyAvg: number;
  lastDate: string;
  /** the user hid the group from the Overview; excluded from the monthly total */
  ignored: boolean;
}

/** Hide/restore a group of recurring payments (the key is the normalized description). */
export function setRecurringIgnored(description: string, ignored: boolean): void {
  const key = recurringKey(description);
  if (ignored) {
    db.prepare(
      `INSERT INTO recurring_ignores (key, description, created_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO NOTHING`,
    ).run(key, description, new Date().toISOString());
  } else {
    db.prepare('DELETE FROM recurring_ignores WHERE key = ?').run(key);
  }
}

/**
 * Groups of recurring spending (recurring = 1) since sinceIso, across visible
 * accounts. Grouped by the same normalized key as the detector (digits collapsed):
 * rent "LEV 01/2026"..."LEV 07/2026" is one group.
 */
export function listRecurringGroups(sinceIso: string): RecurringGroup[] {
  const rows = db
    .prepare(
      `SELECT description, category, date, base_amount_cents
       FROM transactions
       WHERE recurring = 1 AND amount_cents < 0 AND ${NOT_TRANSFER} AND ${VISIBLE_ACCOUNT}
         AND base_amount_cents IS NOT NULL AND date >= ?
       ORDER BY date ASC`,
    )
    .all(sinceIso) as {
    description: string;
    category: string;
    date: string;
    base_amount_cents: number;
  }[];

  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = recurringKey(r.description);
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }

  const ignoredKeys = new Set(
    (db.prepare('SELECT key FROM recurring_ignores').all() as { key: string }[]).map(
      (r) => r.key,
    ),
  );

  // the total is an exact sum of integer cents; the averages divide it, so they are
  // rounded back to whole cents
  const avgCents = (totalCents: number, n: number) => Math.round(totalCents / n) / 100;
  return [...groups.entries()]
    .map(([key, list]) => {
      const months = new Set(list.map((r) => r.date.slice(0, 7))).size;
      const totalCents = list.reduce((s, r) => s - r.base_amount_cents, 0);
      const last = list[list.length - 1];
      return {
        description: last.description, // the most recent spelling in the group
        category: last.category,
        months,
        count: list.length,
        avgAmount: avgCents(totalCents, list.length),
        monthlyAvg: avgCents(totalCents, months),
        lastDate: last.date,
        ignored: ignoredKeys.has(key),
      };
    })
    .sort((a, b) => b.monthlyAvg - a.monthlyAvg);
}

// ---------- "description contains X -> category Y" rules ----------

export interface CategoryRule {
  id: number;
  pattern: string;
  category: string;
  createdAt: string;
}

export function listCategoryRules(): CategoryRule[] {
  const rows = db
    .prepare('SELECT id, pattern, category, created_at FROM category_rules ORDER BY created_at DESC')
    .all() as { id: number; pattern: string; category: string; created_at: string }[];
  return rows.map((r) => ({
    id: r.id,
    pattern: r.pattern,
    category: r.category,
    createdAt: r.created_at,
  }));
}

/** Idempotent: a rule with the same pattern updates the category. */
export function addCategoryRule(pattern: string, category: string): CategoryRule {
  db.prepare(
    `INSERT INTO category_rules (pattern, category, created_at) VALUES (?, ?, ?)
     ON CONFLICT(pattern) DO UPDATE SET category = excluded.category`,
  ).run(pattern, category, new Date().toISOString());
  const row = db
    .prepare('SELECT id, pattern, category, created_at FROM category_rules WHERE pattern = ?')
    .get(pattern) as { id: number; pattern: string; category: string; created_at: string };
  return { id: row.id, pattern: row.pattern, category: row.category, createdAt: row.created_at };
}

export function deleteCategoryRule(id: number): boolean {
  return db.prepare('DELETE FROM category_rules WHERE id = ?').run(id).changes > 0;
}

/** How many transactions the pattern covers - for the caption in the app. */
export function countCategoryRuleMatches(pattern: string): number {
  const r = db
    .prepare("SELECT COUNT(*) n FROM transactions WHERE INSTR(LOWER(description), LOWER(?)) > 0")
    .get(pattern) as { n: number };
  return r.n;
}

// ---------- budgets ----------

export interface Budget {
  category: string;
  /** limit for a calendar month in the base currency */
  monthly: number;
}

export function listBudgets(): Budget[] {
  const rows = db
    .prepare('SELECT category, monthly_cents FROM budgets ORDER BY monthly_cents DESC')
    .all() as { category: string; monthly_cents: number }[];
  return rows.map((r) => ({ category: r.category, monthly: fromCents(r.monthly_cents) }));
}

/** monthly = null removes the budget from the category. */
export function setBudget(category: string, monthly: number | null): void {
  if (monthly === null) {
    db.prepare('DELETE FROM budgets WHERE category = ?').run(category);
  } else {
    db.prepare(
      'INSERT INTO budgets (category, monthly_cents) VALUES (?, ?) ON CONFLICT(category) DO UPDATE SET monthly_cents = excluded.monthly_cents',
    ).run(category, toCents(monthly));
  }
}

// ---------- baseline minimum ----------

export interface BaselineItem {
  id: number;
  label: string;
  monthly: number;
  sort: number;
}

interface BaselineItemRow {
  id: number;
  label: string;
  monthly_cents: number;
  sort: number;
}

const rowToBaselineItem = (r: BaselineItemRow): BaselineItem => ({
  id: r.id,
  label: r.label,
  monthly: fromCents(r.monthly_cents),
  sort: r.sort,
});

export function listBaselineItems(): BaselineItem[] {
  const rows = db
    .prepare(
      'SELECT id, label, monthly_cents, sort FROM baseline_items ORDER BY sort, monthly_cents DESC',
    )
    .all() as BaselineItemRow[];
  return rows.map(rowToBaselineItem);
}

/**
 * The key is the label: a line item is created and edited by its own name.
 * sort is optional: editing an amount from the app sends only monthly, and it must
 * not clobber the item's position - the list would jump under your finger. A new
 * item without sort goes to the end.
 */
export function upsertBaselineItem(label: string, monthly: number, sort?: number): BaselineItem {
  const existing = db.prepare('SELECT sort FROM baseline_items WHERE label = ?').get(label) as
    | { sort: number }
    | undefined;
  const nextSort =
    sort ??
    existing?.sort ??
    ((db.prepare('SELECT COALESCE(MAX(sort), -1) AS m FROM baseline_items').get() as { m: number })
      .m +
      1);
  db.prepare(
    `INSERT INTO baseline_items (label, monthly_cents, sort) VALUES (?, ?, ?)
     ON CONFLICT(label) DO UPDATE SET monthly_cents = excluded.monthly_cents, sort = excluded.sort`,
  ).run(label, toCents(monthly), nextSort);
  return rowToBaselineItem(
    db
      .prepare('SELECT id, label, monthly_cents, sort FROM baseline_items WHERE label = ?')
      .get(label) as BaselineItemRow,
  );
}

export function deleteBaselineItem(label: string): boolean {
  return db.prepare('DELETE FROM baseline_items WHERE label = ?').run(label).changes > 0;
}

/** The sum of all line items is the baseline minimum before any buffer. */
export function baselineTotal(): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(monthly_cents), 0) AS total_cents FROM baseline_items')
    .get() as { total_cents: number };
  return fromCents(row.total_cents);
}

// ---------- backup / restore ----------

/**
 * Full database dump to a file (the online backup API - safe with WAL and
 * concurrent requests). "My data is mine": one button in the app.
 */
export async function backupTo(destPath: string): Promise<void> {
  await db.backup(destPath);
}

/** Names of all user tables in the database. */
function userTables(prefix: string): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM ${prefix}sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
}

/**
 * Live columns an older dump does not have, and how to rebuild each from the columns
 * it does. Migration 002 renamed the money columns and changed their unit, so a
 * pre-002 dump carries `amount` (a decimal) where the schema now wants `amount_cents`.
 * Without this the intersection-of-columns copy below would skip them and the INSERT
 * would fail on NOT NULL - i.e. every backup taken before 002 would be unrestorable.
 */
const LEGACY_COLUMNS: Record<string, Record<string, { from: string; expr: string }>> = (() => {
  const cents = (col: string) =>
    `CASE WHEN "${col}" IS NULL THEN NULL ELSE CAST(ROUND("${col}" * 100) AS INTEGER) END`;
  return {
    accounts: { balance_cents: { from: 'balance', expr: `COALESCE(${cents('balance')}, 0)` } },
    transactions: {
      amount_cents: { from: 'amount', expr: cents('amount') },
      base_amount_cents: { from: 'base_amount', expr: cents('base_amount') },
    },
    budgets: { monthly_cents: { from: 'monthly', expr: `COALESCE(${cents('monthly')}, 0)` } },
    baseline_items: {
      monthly_cents: { from: 'monthly', expr: `COALESCE(${cents('monthly')}, 0)` },
    },
  };
})();

/**
 * Restore from a dump. The connection and its prepared statements stay alive, so we
 * do not swap the file but copy the data through ATTACH: clear our tables and load
 * the dump's rows (by the intersection of columns, plus LEGACY_COLUMNS for the ones
 * an older schema spelled differently). After copying, the caller runs runMigrations
 * (an older dump catches up to the current schema) and a full reclassification.
 */
export function restoreFrom(dumpPath: string): { tables: number; rows: number } {
  db.prepare('ATTACH DATABASE ? AS dump').run(dumpPath);
  try {
    const result = db.transaction(() => {
      const live = new Set(userTables(''));
      const dumpTables = userTables('dump.');
      let tables = 0;
      let rows = 0;
      for (const t of dumpTables) {
        if (!live.has(t)) continue; // tables the current schema does not know
        const liveCols = (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(
          (c) => c.name,
        );
        const dumpCols = new Set(
          (db.prepare(`PRAGMA dump.table_info(${t})`).all() as { name: string }[]).map(
            (c) => c.name,
          ),
        );
        // columns the dump has verbatim, plus the ones it only has under an older
        // name/unit (see LEGACY_COLUMNS)
        const insertCols: string[] = [];
        const selectExprs: string[] = [];
        for (const c of liveCols) {
          if (dumpCols.has(c)) {
            insertCols.push(c);
            selectExprs.push(`"${c}"`);
            continue;
          }
          const legacy = LEGACY_COLUMNS[t]?.[c];
          if (legacy && dumpCols.has(legacy.from)) {
            insertCols.push(c);
            selectExprs.push(legacy.expr);
          }
        }
        if (insertCols.length === 0) continue;
        const colList = insertCols.map((c) => `"${c}"`).join(', ');
        db.prepare(`DELETE FROM ${t}`).run();
        const res = db
          .prepare(
            `INSERT INTO ${t} (${colList}) SELECT ${selectExprs.join(', ')} FROM dump.${t}`,
          )
          .run();
        tables++;
        rows += res.changes;
      }
      // AUTOINCREMENT counters - so new ids do not collide with old ones
      const seq = db
        .prepare(
          "SELECT COUNT(*) AS n FROM dump.sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'",
        )
        .get() as { n: number };
      if (seq.n > 0) {
        db.prepare('DELETE FROM sqlite_sequence').run();
        db.prepare('INSERT INTO sqlite_sequence SELECT * FROM dump.sqlite_sequence').run();
      }
      return { tables, rows };
    })();
    return result;
  } finally {
    db.prepare('DETACH DATABASE dump').run();
  }
}

/** Run migrations on top of restored data (the dump may be from an older version). */
export function migrateAfterRestore(): void {
  runMigrations(db, (s) => logDb.info(s));
}

// ---------- sync journal ----------

export interface SyncLogEntry {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  /** true = finished without a fatal error; null = running (or killed midway) */
  ok: boolean | null;
  /** new transactions in this run */
  inserted: number;
  /** non-fatal errors per account/provider */
  errors: string[];
  /** the full text log of the run */
  log: string[];
}

export function startSyncLogEntry(startedAt: string): number {
  const res = db
    .prepare('INSERT INTO sync_log (started_at) VALUES (?)')
    .run(startedAt);
  return Number(res.lastInsertRowid);
}

export function finishSyncLogEntry(
  id: number,
  ok: boolean,
  inserted: number,
  errors: string[],
  log: string[],
): void {
  db.prepare(
    `UPDATE sync_log SET finished_at = ?, ok = ?, inserted = ?, errors = ?, log = ? WHERE id = ?`,
  ).run(new Date().toISOString(), ok ? 1 : 0, inserted, JSON.stringify(errors), JSON.stringify(log), id);
}

interface SyncLogRow {
  id: number;
  started_at: string;
  finished_at: string | null;
  ok: number | null;
  inserted: number;
  errors: string;
  log: string;
}

const parseJsonArray = (s: string): string[] => {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};

function rowToSyncLog(r: SyncLogRow): SyncLogEntry {
  return {
    id: r.id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    ok: r.ok === null ? null : r.ok === 1,
    inserted: r.inserted,
    errors: parseJsonArray(r.errors),
    log: parseJsonArray(r.log),
  };
}

/** The most recent sync runs, newest first. */
export function listSyncJournal(limit = 20): SyncLogEntry[] {
  const rows = db
    .prepare('SELECT * FROM sync_log ORDER BY id DESC LIMIT ?')
    .all(limit > 0 ? limit : 20) as SyncLogRow[];
  return rows.map(rowToSyncLog);
}

/** The last successful run - the basis for "data current as of ...". */
export function lastSuccessfulSync(): SyncLogEntry | undefined {
  const row = db
    .prepare('SELECT * FROM sync_log WHERE ok = 1 ORDER BY id DESC LIMIT 1')
    .get() as SyncLogRow | undefined;
  return row ? rowToSyncLog(row) : undefined;
}

// ---------- enable banking: sessions / auth state ----------

export interface EbSession {
  sessionId: string;
  aspspName: string;
  aspspCountry: string;
  validUntil: string;
}

export function saveEbSession(s: EbSession): void {
  // one active session per bank: an older one for the same bank is deleted
  db.prepare('DELETE FROM eb_sessions WHERE aspsp_name = ? AND aspsp_country = ?').run(
    s.aspspName,
    s.aspspCountry,
  );
  db.prepare(
    `INSERT INTO eb_sessions (session_id, aspsp_name, aspsp_country, valid_until, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(s.sessionId, s.aspspName, s.aspspCountry, s.validUntil, new Date().toISOString());
}

export function deleteEbSession(sessionId: string): void {
  db.prepare('DELETE FROM eb_sessions WHERE session_id = ?').run(sessionId);
}

export function listEbSessions(): EbSession[] {
  const rows = db.prepare('SELECT * FROM eb_sessions').all() as {
    session_id: string;
    aspsp_name: string;
    aspsp_country: string;
    valid_until: string;
  }[];
  return rows.map((r) => ({
    sessionId: r.session_id,
    aspspName: r.aspsp_name,
    aspspCountry: r.aspsp_country,
    validUntil: r.valid_until,
  }));
}

export function saveAuthState(state: string, aspspName: string, aspspCountry: string): void {
  db.prepare(
    'INSERT INTO eb_auth_state (state, aspsp_name, aspsp_country, created_at) VALUES (?, ?, ?, ?)',
  ).run(state, aspspName, aspspCountry, new Date().toISOString());
}

export function takeAuthState(
  state: string,
): { aspspName: string; aspspCountry: string } | undefined {
  const row = db.prepare('SELECT * FROM eb_auth_state WHERE state = ?').get(state) as
    | { aspsp_name: string; aspsp_country: string }
    | undefined;
  if (!row) return undefined;
  db.prepare('DELETE FROM eb_auth_state WHERE state = ?').run(state);
  return { aspspName: row.aspsp_name, aspspCountry: row.aspsp_country };
}
