import crypto from 'crypto';
import path from 'path';
import { and, asc, eq, getTableColumns, inArray, sql, type SQL } from 'drizzle-orm';
import fs from 'fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { Pool } from 'pg';
import { z } from 'zod';
import { CATEGORIES, type Category, recurringKey } from '../categorizer';
import { config } from '../config';
import { type DocumentLocator, type DocumentRef, deleteDocument } from '../documents';
import { causeChain, logDb } from '../logger';
import { fromCents, fromCentsOrUndefined, toCents, toCentsOrNull } from '../money';
import { assertWritableDir } from '../storage';
import {
  categoryPatternMatches,
  matchesTransferRule,
  similarDescriptionKey,
  tallyTransferRuleMatches,
  transactionDescription,
} from '../transaction-description';
import {
  Account,
  AccountMonthTotals,
  CategorySummary,
  IncomeSourceDef,
  IncomeSourceKind,
  IncomeSourceTotal,
  MonthTotals,
  NewTransaction,
  SummaryTotals,
  Transaction,
  TransferRule,
} from '../types';
import {
  CHART_METRICS,
  type CategoryRule,
  type CategoryRuleCounts,
  type CategoryRulePreview,
  type Chart,
  type ChartList,
  type ChartMetric,
  ERROR_DETAIL_MAX,
  type ImportList,
  type ImportRecord,
  type ImportSourceType,
  type ImportStatus,
  type GoalCost,
  type GoalCreate,
  type GoalType,
  type ImportTotals,
  type RecurringGroup,
  type TransferRulePreview,
  SUPPORT_INCOME_SOURCE,
} from '../wire';
import {
  COMPUTED_PREFIX,
  computedDedupKey,
  computedGroupPrefix,
  computedKeyOrdinal,
  dedupGroup,
  parkedDedupKey,
  withOrdinal,
} from './dedup';
import * as s from './schema';

export {
  CHART_ACCOUNT_ID_MAX,
  CHART_BREAKDOWNS,
  CHART_ID_MAX,
  CHART_ID_SHAPE,
  CHART_KINDS,
  CHART_METRICS,
  CHART_RANGES,
  CHART_TITLE_MAX,
  CHARTS_MAX,
  ERROR_DETAIL_MAX,
} from '../wire';
export type {
  CategoryRule,
  Chart,
  ChartBreakdown,
  ChartKind,
  ChartList,
  ChartMetric,
  ChartRange,
  ImportList,
  ImportRecord,
  ImportSourceType,
  ImportStatus,
  ImportTotals,
  RecurringGroup,
} from '../wire';

export type Db = PgDatabase<PgQueryResultHKT, any, any>;

let db: Db | undefined;

export function initDb(instance: Db): void {
  db = instance;
}

function getDb(): Db {
  if (!db) throw new Error('database not initialized - call connectDatabase() first');
  return db;
}

export function dbInstance(): Db {
  return getDb();
}

export const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'drizzle');

export interface DatabaseHandle {
  db: Db;
  /** For the boot log: where the data is, with any password out of it. */
  location: string;
  close(): Promise<void>;
}

/**
 * Opens and migrates the database config names: a PostgreSQL server when
 * DATABASE_URL is set, the embedded one under FINTO_HOME otherwise. Everything in
 * src that needs a handle goes through here, so the two engines are chosen in one
 * place; the suite's harness (test/pglite.ts) opens its own and migrates it from
 * the same directory.
 */
export async function openDatabase(): Promise<DatabaseHandle> {
  const opened = config.databaseUrl ? openServer(config.databaseUrl) : await openEmbedded(config.databaseDir);
  try {
    await opened.migrate();
  } catch (e) {
    await opened.close();
    throw e;
  }
  return opened;
}

type Opened = DatabaseHandle & { migrate(): Promise<void> };

function openServer(url: string): Opened {
  const pool = new Pool({ connectionString: url });
  const instance = drizzlePg(pool, { schema: s });
  return {
    db: instance,
    location: url.replace(/:[^:@/]+@/, ':***@'),
    close: () => pool.end(),
    migrate: () => migratePg(instance, { migrationsFolder: MIGRATIONS_DIR }),
  };
}

async function openEmbedded(directory: string): Promise<Opened> {
  // the same probe the statements folder gets, and for a sharper reason: a database
  // folder that cannot be written to is discovered by the migration, which reports
  // the SQL it was running and not the permission that stopped it
  await assertWritableDir(directory, 'the database folder (FINTO_HOME/db)');
  const client = new PGlite(directory);
  const instance = drizzlePglite(client, { schema: s });
  return {
    db: instance,
    location: directory,
    close: () => client.close(),
    migrate: () => migratePglite(instance, { migrationsFolder: MIGRATIONS_DIR }),
  };
}

let handle: DatabaseHandle | undefined;

export async function connectDatabase(): Promise<void> {
  handle = await openDatabase();
  initDb(handle.db);
  logDb.info(`database ready at ${handle.location}`);
}

export async function closeDatabase(): Promise<void> {
  const open = handle;
  handle = undefined;
  db = undefined;
  if (open) await open.close();
}

export async function seedDefaults(): Promise<void> {
  const d = getDb();
  await d
    .insert(s.incomeSources)
    .values([
      { id: 'salary', label: 'Salary', kind: 'own', patterns: '[]', sort: 0, builtin: true },
      {
        id: 'family',
        // the id is data and stays; the label is what a stranger reads, and a
        // scholarship is not family. A database seeded earlier keeps its label - the
        // insert ends onConflictDoNothing - and renames it through Settings.
        label: 'Support',
        kind: 'external',
        patterns: JSON.stringify(config.familyNames),
        sort: 1,
        builtin: true,
      },
      { id: 'other', label: 'Other', kind: 'own', patterns: '[]', sort: 2, builtin: true },
    ])
    .onConflictDoNothing();
  await d
    .insert(s.settings)
    .values([
      { key: 'base_currency', value: config.baseCurrency },
      { key: 'owner_names', value: JSON.stringify(config.ownerNames) },
    ])
    .onConflictDoNothing();
}

async function rowsOf<T>(q: SQL): Promise<T[]> {
  const res = (await getDb().execute(q)) as unknown as { rows: T[] };
  return res.rows;
}

async function execCount(q: SQL): Promise<number> {
  const res = (await getDb().execute(q)) as unknown as {
    rowCount?: number | null;
    affectedRows?: number;
  };
  return Number(res.rowCount ?? res.affectedRows ?? 0);
}

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The effective transfer flag: a manual mark beats auto-detection.
 * Transfer transactions count as neither income nor spending.
 */
const NOT_TRANSFER = sql`NOT COALESCE(transfer_manual, transfer)`;

/**
 * The effective category: the user's own answer for this row beats the categorizer's.
 * Two arms and not three - `category` is NOT NULL DEFAULT 'other', so there is no
 * third case to fall through to.
 */
const CATEGORY = sql`COALESCE(category_manual, category)`;

/**
 * Transactions of hidden accounts are neither shown nor counted. They aren't
 * deleted: the classifier needs them as the other leg of a transfer - hiding N26
 * shouldn't lose the transfer flag on the matching Revolut income.
 */
const VISIBLE_ACCOUNT = (): SQL => sql`account_id NOT IN (SELECT id FROM accounts WHERE hidden)`;

/**
 * A row of this account's own, in either table - the two reasons its currency must
 * not move. `transactions` is what balance_cents sums
 * (recalcAccountBalanceFromTransactionsOn) whatever each row's own currency says,
 * so re-denominating an account holding them relabels a total that was never in
 * the new unit. `staged_transactions` rows were stamped with the account's currency
 * when the file was read (statement.ts's rowCurrency) and land unchanged at
 * confirm, so a correction made while an import is outstanding survives on the
 * account and is reverted on its rows.
 *
 * Neither carries VISIBLE_ACCOUNT(), unlike every other predicate here, and that is
 * not an omission: it excludes the transactions OF hidden accounts, so pairing it
 * would read a hidden account holding a thousand rows as empty.
 */
const HOLDS_TRANSACTIONS = (accountId: string): SQL =>
  sql`EXISTS (SELECT 1 FROM transactions
      WHERE transactions.account_id = ${accountId})`;

const HOLDS_STAGED_ROWS = (accountId: string): SQL =>
  sql`EXISTS (SELECT 1 FROM staged_transactions
      WHERE staged_transactions.account_id = ${accountId})`;

/**
 * Clauses of the UPDATE that writes the currency rather than a count before it -
 * confirmImport's note is the pattern. Counting first and writing after is a window
 * an import commits inside, and the loser is a silent re-denomination.
 *
 * Not a latch: both tables empty again and the account is correctable again, which
 * is what makes discarding an import and deleting one the ways out.
 */
const NO_ROWS = (accountId: string): SQL =>
  sql`NOT ${HOLDS_TRANSACTIONS(accountId)} AND NOT ${HOLDS_STAGED_ROWS(accountId)}`;

export async function getSetting(key: string): Promise<string | undefined> {
  const rows = await getDb()
    .select()
    .from(s.settings)
    .where(eq(s.settings.key, key));
  return rows[0]?.value;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await getDb()
    .insert(s.settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: [s.settings.key], set: { value } });
}

export async function currentBaseCurrency(): Promise<string> {
  return (await getSetting('base_currency')) ?? config.baseCurrency;
}

export async function getMeta(key: string): Promise<string | undefined> {
  const rows = await getDb()
    .select()
    .from(s.meta)
    .where(eq(s.meta.key, key));
  return rows[0]?.value;
}

export async function setMeta(key: string, value: string): Promise<void> {
  await getDb()
    .insert(s.meta)
    .values({ key, value })
    .onConflictDoUpdate({ target: [s.meta.key], set: { value } });
}

export async function upsertAccount(a: Omit<Account, 'hidden'>): Promise<void> {
  await upsertAccountOn(getDb(), a);
}

export async function upsertAccountOn(d: Db, a: Omit<Account, 'hidden'>): Promise<void> {
  await d
    .insert(s.accounts)
    .values({
      id: a.id,
      provider: a.provider,
      name: a.name,
      currency: a.currency,
      balanceCents: toCents(a.balance),
      iban: a.iban ?? null,
    })
    .onConflictDoUpdate({
      target: [s.accounts.id],
      // `hidden` is deliberately not in the set below: nothing here may silently
      // un-hide an account the user removed.
      //
      // `name` is out of it too, and for a different reason: the account's name is
      // the user's to change (updateAccount) and the id is what an import is
      // recorded against, so writing a remembered name back over it would revert
      // every rename made since the backup was taken. It is also what keeps this
      // statement clear of accounts_name_unique: the conflict arm never touches the
      // indexed column.
      //
      // `currency` is out of it for a reason of the same kind. It is the account's
      // own now - updateAccount writes it, and only while the account holds no rows
      // - so writing a remembered one back would revert a correction with nothing
      // said. Out of the set there is no application branch to drop later.
      //
      // The INSERT above keeps both: an account created here has to have a name and
      // be denominated in something.
      set: {
        balanceCents: sql`excluded.balance_cents`,
        iban: sql`excluded.iban`,
      },
    });
}

export async function updateAccountBalance(id: string, balance: number): Promise<void> {
  await getDb()
    .update(s.accounts)
    .set({ balanceCents: toCents(balance) })
    .where(eq(s.accounts.id, id));
}

export async function recalcAccountBalanceFromTransactions(accountId: string): Promise<void> {
  await recalcAccountBalanceFromTransactionsOn(getDb(), accountId);
}

export async function recalcAccountBalanceFromTransactionsOn(
  d: Executor,
  accountId: string,
): Promise<void> {
  await d.execute(sql`
    UPDATE accounts SET balance_cents = (
      SELECT COALESCE(SUM(amount_cents), 0) FROM transactions
      WHERE account_id = ${accountId}
    ) WHERE id = ${accountId}`);
}

type AccountRow = typeof s.accounts.$inferSelect;

function rowToAccount(r: AccountRow): Account {
  return {
    id: r.id,
    provider: r.provider as Account['provider'],
    name: r.name,
    currency: r.currency,
    balance: fromCents(r.balanceCents),
    iban: r.iban ?? undefined,
    hidden: r.hidden,
  };
}

export async function listAccounts(includeHidden = false): Promise<Account[]> {
  const rows = await getDb()
    .select()
    .from(s.accounts)
    .where(includeHidden ? undefined : eq(s.accounts.hidden, false));
  return rows
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name))
    .map(rowToAccount);
}

export async function getAccount(id: string): Promise<Account | undefined> {
  const rows = await getDb()
    .select()
    .from(s.accounts)
    .where(eq(s.accounts.id, id));
  return rows[0] ? rowToAccount(rows[0]) : undefined;
}

/**
 * The account a name refers to, folded the way accounts_name_unique folds it - so a
 * name this misses is a name the index would also let through, and the lookup can
 * never be followed by an insert that collides. Folding in JS instead is what makes
 * those two disagree - toLowerCase() and lower() do not agree on every alphabet -
 * and the disagreement surfaces as a 500 on the upload path.
 *
 * Hidden accounts are included deliberately: an upload naming a removed account has
 * always landed in it, and narrowing that here would fix half of a defect.
 */
export async function findAccountByName(name: string): Promise<Account | undefined> {
  const rows = await getDb()
    .select()
    .from(s.accounts)
    .where(
      sql`lower(${s.accounts.name}) = lower(${name})`,
    );
  return rows[0] ? rowToAccount(rows[0]) : undefined;
}

declare const resolved: unique symbol;

export type ResolvedAccountId = string & { readonly [resolved]: true };

export type UploadAccount =
  | { ok: true; account: StagedAccount }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'hidden' };

export async function resolveUploadAccount(id: string): Promise<UploadAccount> {
  const rows = await getDb()
    .select()
    .from(s.accounts)
    .where(eq(s.accounts.id, id));
  const row = rows[0];
  if (!row) return { ok: false, reason: 'not-found' };
  if (row.hidden) return { ok: false, reason: 'hidden' };
  return {
    ok: true,
    account: { id: row.id as ResolvedAccountId, name: row.name, currency: row.currency },
  };
}

export const ACCOUNT_NAME_MAX = 60;

export type AccountWrite =
  | { ok: true; account: Account }
  | { ok: false; reason: 'name-taken'; taken: Account | undefined }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'has-transactions' }
  | { ok: false; reason: 'staged-import' };

/**
 * A create has no row to miss and no rows to hold. An allow-list rather than a
 * subtraction: a refusal added above is then an outcome POST is never made to
 * answer for, without anyone having to remember to widen an Exclude.
 */
export type AccountCreate = Extract<AccountWrite, { ok: true } | { reason: 'name-taken' }>;

export async function createAccount(input: {
  name: string;
  currency: string;
}): Promise<AccountCreate> {
  try {
    const rows = await getDb()
      .insert(s.accounts)
      .values({
        id: crypto.randomUUID(),
        provider: 'upload',
        name: input.name,
        currency: input.currency,
        balanceCents: 0,
        hidden: false,
      })
      .returning();
    return { ok: true, account: rowToAccount(rows[0]) };
  } catch (e) {
    if (!isUniqueViolation(e, 'accounts_name_unique')) throw e;
    return { ok: false, reason: 'name-taken', taken: await findAccountByName(input.name) };
  }
}

export type AccountPatch =
  | { name: string; hidden?: boolean; currency?: string }
  | { name?: string; hidden: boolean; currency?: string }
  | { name?: string; hidden?: boolean; currency: string };

async function currencyRefusal(
  id: string,
): Promise<'has-transactions' | 'staged-import' | undefined> {
  const rows = await rowsOf<{ blocked: boolean }>(
    sql`SELECT ${HOLDS_TRANSACTIONS(id)} AS blocked FROM accounts WHERE id = ${id}`,
  );
  if (!rows[0]) return undefined;
  return rows[0].blocked ? 'has-transactions' : 'staged-import';
}

export async function updateAccount(id: string, patch: AccountPatch): Promise<AccountWrite> {
  try {
    const rows = await getDb()
      .update(s.accounts)
      .set({
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.hidden === undefined ? {} : { hidden: patch.hidden }),
        ...(patch.currency === undefined ? {} : { currency: patch.currency }),
      })
      .where(
        and(
          eq(s.accounts.id, id),
          // and() drops undefined, so a rename or a hide keeps exactly the WHERE it
          // has always had - which is what leaves a populated account renameable
          patch.currency === undefined ? undefined : NO_ROWS(id),
        ),
      )
      .returning();
    if (rows[0]) return { ok: true, account: rowToAccount(rows[0]) };
    // Zero rows is ambiguous exactly when a guard was on, and NO_ROWS is the ONLY
    // guarded clause in the WHERE above - which is why this readback is conditional
    // on the same field. A clause added later must be read back here too, or its
    // refusal tells a user their account does not exist while they are looking at it.
    if (patch.currency !== undefined) {
      const refused = await currencyRefusal(id);
      if (refused) return { ok: false, reason: refused };
    }
    return { ok: false, reason: 'not-found' };
  } catch (e) {
    if (!isUniqueViolation(e, 'accounts_name_unique')) throw e;
    return {
      ok: false,
      reason: 'name-taken',
      taken: patch.name === undefined ? undefined : await findAccountByName(patch.name),
    };
  }
}

/**
 * Returns the number of genuinely new rows.
 *
 * Ordinals for computed keys are numbered over the whole batch, before chunking:
 * restarting per chunk would collide the second chunk's rows with the first's and
 * drop them. They start from 1 rather than continuing from what the database already
 * holds; why that is what makes a re-import insert nothing is in this module's SPEC.md.
 *
 * A duplicate is skipped, never merged: the existing row keeps its description, its
 * category and the user's manual marks.
 */
export async function insertTransactions(
  txs: NewTransaction[],
  importId?: string,
): Promise<number> {
  if (txs.length === 0) return 0;
  const baseCurrency = await currentBaseCurrency();
  let inserted = 0;
  await getDb().transaction(async (tx) => {
    inserted = await insertTransactionsOn(tx, txs, baseCurrency, importId);
  });
  return inserted;
}

/**
 * The rows of a batch that will actually be offered to the database, each with the
 * key it claims. **The only place computed keys are numbered** - the confirmation
 * preview asks the same question of the same list (see countNewKeys), and a second
 * copy of this loop would let the number the user reads before pressing Confirm
 * drift from the number the confirm inserts, with nothing failing until it does.
 *
 * A key repeated inside one batch is taken once: a provider handing us the same
 * native reference twice would be resolved by PG anyway, but the returned count is
 * easier to trust if it never happens.
 */
function claimedKeys(
  txs: NewTransaction[],
): { tx: NewTransaction; amountCents: number; dedupKey: string }[] {
  const ordinals = new Map<string, number>();
  const batchKeys = new Set<string>();
  const out: { tx: NewTransaction; amountCents: number; dedupKey: string }[] = [];
  for (const t of txs) {
    const amountCents = toCents(t.amount);
    let dedupKey = t.dedupKey;
    if (!dedupKey) {
      const day = t.date.slice(0, 10);
      const group = dedupGroup(t.accountId, day, amountCents, t.currency);
      const n = (ordinals.get(group) ?? 0) + 1;
      ordinals.set(group, n);
      dedupKey = computedDedupKey(day, amountCents, t.currency, n);
    }
    if (batchKeys.has(`${t.accountId}|${dedupKey}`)) continue;
    batchKeys.add(`${t.accountId}|${dedupKey}`);
    out.push({ tx: t, amountCents, dedupKey });
  }
  return out;
}

/**
 * The body, on a caller-supplied executor and with the base currency already read.
 * Both are what makes the confirm step atomic: it opens one transaction and every
 * statement inside it runs on that handle, so no call under it can reach for a
 * second pooled connection (see confirmImport).
 */
export async function insertTransactionsOn(
  d: Db,
  txs: NewTransaction[],
  baseCurrency: string,
  importId?: string,
): Promise<number> {
  if (txs.length === 0) return 0;
  const values: (typeof s.transactions.$inferInsert)[] = claimedKeys(txs).map(
    ({ tx: t, amountCents, dedupKey }) => {
      // transactions already in the base currency need no conversion - fill it now;
      // for the rest base_amount is filled later by backfillBaseAmounts (fxrates.ts)
      const isBase = t.currency === baseCurrency;
      return {
        id: crypto.randomUUID(),
        accountId: t.accountId,
        dedupKey,
        provider: t.provider,
        amountCents,
        feeCents: toCentsOrNull(t.fee),
        currency: t.currency,
        date: t.date,
        description: t.description,
        mcc: t.mcc ?? null,
        category: t.category,
        baseAmountCents: isBase ? amountCents : null,
        fxRate: isBase ? 1 : null,
        importId: importId ?? null,
      };
    },
  );
  let inserted = 0;
  for (const chunk of chunked(values, 1000)) {
    const res = await d
      .insert(s.transactions)
      .values(chunk)
      .onConflictDoNothing({
        target: [s.transactions.accountId, s.transactions.dedupKey],
      })
      .returning({ id: s.transactions.id });
    inserted += res.length;
  }
  return inserted;
}

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
  fee_cents: number | null;
  currency: string;
  date: string;
  description: string;
  mcc: number | null;
  category: string;
  category_manual: string | null;
  transfer: boolean;
  transfer_manual: boolean | null;
  refund: boolean;
  base_amount_cents: number | null;
  fx_rate: number | null;
  income_source: string | null;
  income_source_manual: string | null;
  recurring: boolean;
  one_off: boolean;
}

function rowToTx(r: TxRow): Transaction {
  const category = r.category_manual ?? r.category;
  const support = category === 'support' && r.amount_cents > 0 && !r.refund;
  return {
    id: r.id,
    accountId: r.account_id,
    provider: r.provider as Transaction['provider'],
    amount: fromCents(r.amount_cents),
    fee: fromCentsOrUndefined(r.fee_cents),
    currency: r.currency,
    date: r.date,
    description: r.description,
    ...transactionDescription(r.description),
    mcc: r.mcc ?? undefined,
    category,
    categoryManual: r.category_manual !== null,
    transfer: r.transfer_manual ?? r.transfer,
    transferManual: r.transfer_manual,
    refund: r.refund,
    baseAmount: fromCentsOrUndefined(r.base_amount_cents),
    incomeSource:
      r.amount_cents > 0
        ? (support ? SUPPORT_INCOME_SOURCE : (r.income_source_manual ?? r.income_source ?? 'other'))
        : undefined,
    incomeSourceManual: !support && r.income_source_manual !== null,
    recurring: r.recurring,
    oneOff: r.one_off,
  };
}

export async function listTransactions(f: TxFilter): Promise<Transaction[]> {
  const where: SQL[] = [VISIBLE_ACCOUNT()];
  if (f.from) where.push(sql`date >= ${f.from}`);
  // include the whole "to" day when a date without a time is given
  if (f.to) where.push(sql`date <= ${f.to.length === 10 ? `${f.to}T23:59:59.999Z` : f.to}`);
  if (f.accountId) where.push(sql`account_id = ${f.accountId}`);
  if (f.category) where.push(sql`${CATEGORY} = ${f.category}`);
  const limit = f.limit && f.limit > 0 ? f.limit : 1000;
  const rows = await rowsOf<TxRow>(sql`
    SELECT * FROM transactions
    WHERE ${sql.join(where, sql` AND `)}
    ORDER BY date DESC LIMIT ${limit}`);
  return rows.map(rowToTx);
}

/**
 * Rows without base_amount (the rate hasn't been fetched yet) are left out of the
 * summaries - otherwise we would be adding euros to hryvnias.
 *
 * The all-accounts arm's clause, and scopeSql below is the only thing that may name it:
 * per account it drops a real transaction from its own account's total - an import
 * short by a row, in the account's own currency, that nothing reports.
 */
const CONVERTED = sql`base_amount_cents IS NOT NULL`;

export interface AllAccountsScope {
  kind: 'all';
}

export interface AccountScope {
  kind: 'account';
  id: ResolvedAccountId;
  currency: string;
}

export type SummaryScope = AllAccountsScope | AccountScope;

/**
 * The rows a scope is about and the column its money lives in - together, from one
 * value, because picking the filter of one arm and the column of the other is what
 * puts two currencies in one sum.
 *
 * NOT_TRANSFER is in the WHERE on both arms. The one exception is accountMonths,
 * which needs the month to survive even when every row in it is a transfer and
 * therefore spells its own WHERE - see the note there.
 *
 */
const scopeSql = (scope: SummaryScope): { where: SQL; money: SQL } =>
  scope.kind === 'account'
    ? {
        where: sql`account_id = ${scope.id} AND ${NOT_TRANSFER}`,
        money: sql`amount_cents`,
      }
    : {
        where: sql`${NOT_TRANSFER} AND ${VISIBLE_ACCOUNT()} AND ${CONVERTED}`,
        money: sql`base_amount_cents`,
      };

/**
 * Spending by category, net: a refund ("Bolt, cancelled") subtracts from spending
 * in its own category, so a total can go negative if the purchase was in a previous
 * period and the refund arrived in this one. Categories that collapse to exactly
 * zero are not shown.
 */
export async function summaryByCategory(
  scope: SummaryScope,
  from: string,
  to: string,
): Promise<CategorySummary[]> {
  const { where, money } = scopeSql(scope);
  const rows = await rowsOf<{ category: string; total_cents: string }>(sql`
    SELECT ${CATEGORY} AS category, SUM(-${money}) AS total_cents
    FROM transactions
    WHERE ${where}
      AND (amount_cents < 0 OR refund) AND date >= ${from} AND date <= ${to}
    GROUP BY 1
    HAVING SUM(-${money}) <> 0
    ORDER BY total_cents DESC`);
  return rows.map((r) => ({ category: r.category, total: fromCents(Number(r.total_cents)) }));
}

export async function summaryIncomeByCategory(
  scope: SummaryScope,
  from: string,
  to: string,
): Promise<CategorySummary[]> {
  const { where, money } = scopeSql(scope);
  const rows = await rowsOf<{ category: string; total_cents: string }>(sql`
    SELECT ${CATEGORY} AS category, SUM(${money}) AS total_cents
    FROM transactions
    WHERE ${where}
      AND amount_cents > 0 AND NOT refund AND date >= ${from} AND date <= ${to}
    GROUP BY 1
    ORDER BY total_cents DESC`);
  return rows.map((r) => ({ category: r.category, total: fromCents(Number(r.total_cents)) }));
}

const INCOME_SOURCE = sql`CASE WHEN ${CATEGORY} = 'support' AND amount_cents > 0 AND NOT refund
  THEN ${SUPPORT_INCOME_SOURCE} ELSE COALESCE(income_source_manual, income_source, 'other') END`;

const IS_EXTERNAL = (): SQL =>
  sql`(${CATEGORY} = 'support' OR ${INCOME_SOURCE} IN (SELECT id FROM income_sources WHERE kind = 'external'))`;

export async function summaryIncomeBySource(
  scope: SummaryScope,
  from: string,
  to: string,
): Promise<IncomeSourceTotal[]> {
  const { where, money } = scopeSql(scope);
  const rows = await rowsOf<Omit<IncomeSourceTotal, 'total'> & { total_cents: string }>(sql`
    SELECT ${INCOME_SOURCE} AS source,
           CASE WHEN ${CATEGORY} = 'support' THEN ${SUPPORT_INCOME_SOURCE} ELSE COALESCE(i.label, ${INCOME_SOURCE}) END AS label,
           CASE WHEN ${CATEGORY} = 'support' THEN 'external' ELSE COALESCE(i.kind, 'own') END AS kind,
           SUM(${money}) AS total_cents
    FROM transactions
    LEFT JOIN income_sources i ON i.id = ${INCOME_SOURCE}
    WHERE ${where}
      AND amount_cents > 0 AND NOT refund AND date >= ${from} AND date <= ${to}
    GROUP BY 1, 2, 3
    ORDER BY total_cents DESC`);
  return rows.map(({ total_cents, ...r }) => ({ ...r, total: fromCents(Number(total_cents)) }));
}

export async function summaryTotals(
  scope: SummaryScope,
  from: string,
  to: string,
): Promise<SummaryTotals> {
  const { where, money } = scopeSql(scope);
  const rows = await rowsOf<{ expense_cents: string | null; income_cents: string | null }>(sql`
    SELECT SUM(CASE WHEN amount_cents < 0 OR refund THEN -${money} ELSE 0 END) AS expense_cents,
           SUM(CASE WHEN amount_cents > 0 AND NOT refund THEN ${money} ELSE 0 END) AS income_cents
    FROM transactions
    WHERE ${where} AND date >= ${from} AND date <= ${to}`);
  const row = rows[0];
  return {
    expense: fromCents(Number(row?.expense_cents ?? 0)),
    income: fromCents(Number(row?.income_cents ?? 0)),
  };
}

async function allAccountsMonths(from: string, to: string): Promise<MonthTotals[]> {
  const { where, money } = scopeSql({ kind: 'all' });
  // camelCase aliases must be quoted: PG folds unquoted identifiers to lowercase
  const rows = await rowsOf<{
    month: string;
    expense: string;
    expenseOneOff: string;
    income: string;
    incomeOwn: string;
    incomeExternal: string;
  }>(sql`
    SELECT SUBSTR(date, 1, 7) AS month,
           SUM(CASE WHEN amount_cents < 0 OR refund THEN -${money} ELSE 0 END) AS expense,
           SUM(CASE WHEN (amount_cents < 0 OR refund) AND one_off THEN -${money} ELSE 0 END) AS "expenseOneOff",
           SUM(CASE WHEN amount_cents > 0 AND NOT refund THEN ${money} ELSE 0 END) AS income,
           SUM(CASE WHEN amount_cents > 0 AND NOT refund AND NOT ${IS_EXTERNAL()} THEN ${money} ELSE 0 END) AS "incomeOwn",
           SUM(CASE WHEN amount_cents > 0 AND NOT refund AND ${IS_EXTERNAL()} THEN ${money} ELSE 0 END) AS "incomeExternal"
    FROM transactions
    WHERE ${where} AND date >= ${from} AND date <= ${to}
    GROUP BY 1
    ORDER BY 1 ASC`);
  // the SUMs above are in cents (bigint strings from the driver) - convert every
  // money field at the boundary
  return rows.map((r) => ({
    month: r.month,
    expense: fromCents(Number(r.expense)),
    expenseOneOff: fromCents(Number(r.expenseOneOff)),
    income: fromCents(Number(r.income)),
    incomeOwn: fromCents(Number(r.incomeOwn)),
    incomeExternal: fromCents(Number(r.incomeExternal)),
  }));
}

/**
 * The same chart for one account, in that account's own currency.
 *
 * This is the one summary query that does not take its WHERE from scopeSql, and the
 * reason is the GROUP BY: it is the only query here that can lose a whole bucket, so
 * a WHERE excluding transfers deletes a month whose every row is a transfer from the
 * chart - which reads as "nothing happened" rather than "nothing is shown". So
 * NOT_TRANSFER moves into the income and expense CASEs, where it excludes transfers
 * from those two figures exactly as everywhere else, and the month survives.
 *
 * `net` carries no NOT_TRANSFER at all: it is a balance movement, summed by
 * recalcAccountBalanceFromTransactions' rule (every row of the account, transfers
 * and unconverted rows included), which is the only thing that makes these months
 * add up to the balance printed beside them.
 *
 * Moving NOT_TRANSFER out of a WHERE anywhere else counts a transfer out of the
 * account as spending in its category.
 */
async function accountMonths(
  scope: AccountScope,
  from: string,
  to: string,
): Promise<AccountMonthTotals[]> {
  const rows = await rowsOf<{
    month: string;
    expense: string;
    income: string;
    net: string;
  }>(sql`
    SELECT SUBSTR(date, 1, 7) AS month,
           SUM(CASE WHEN ${NOT_TRANSFER} AND (amount_cents < 0 OR refund) THEN -amount_cents ELSE 0 END) AS expense,
           SUM(CASE WHEN ${NOT_TRANSFER} AND amount_cents > 0 AND NOT refund THEN amount_cents ELSE 0 END) AS income,
           SUM(amount_cents) AS net
    FROM transactions
    WHERE account_id = ${scope.id} AND date >= ${from} AND date <= ${to}
    GROUP BY 1
    ORDER BY 1 ASC`);
  return rows.map((r) => ({
    month: r.month,
    income: fromCents(Number(r.income)),
    expense: fromCents(Number(r.expense)),
    net: fromCents(Number(r.net)),
  }));
}

export function summaryMonthlyTotals(
  scope: AllAccountsScope,
  from: string,
  to: string,
): Promise<MonthTotals[]>;
export function summaryMonthlyTotals(
  scope: AccountScope,
  from: string,
  to: string,
): Promise<AccountMonthTotals[]>;
export function summaryMonthlyTotals(scope: SummaryScope, from: string, to: string) {
  return scope.kind === 'account' ? accountMonths(scope, from, to) : allAccountsMonths(from, to);
}

export interface GoalMonthTotals extends MonthTotals {
  rows: number;
  unconverted: number;
}

export async function goalMonthlyTotals(from: string, to: string): Promise<GoalMonthTotals[]> {
  const rows = await rowsOf<{
    month: string;
    rows: number;
    unconverted: number;
    expense: string;
    expenseOneOff: string;
    income: string;
    incomeOwn: string;
    incomeExternal: string;
  }>(sql`
    SELECT SUBSTR(date, 1, 7) AS month,
      COUNT(*)::int AS rows,
      COUNT(*) FILTER (WHERE base_amount_cents IS NULL)::int AS unconverted,
      SUM(CASE WHEN base_amount_cents IS NOT NULL AND (amount_cents < 0 OR refund)
        THEN -base_amount_cents ELSE 0 END) AS expense,
      SUM(CASE WHEN base_amount_cents IS NOT NULL AND (amount_cents < 0 OR refund) AND one_off
        THEN -base_amount_cents ELSE 0 END) AS "expenseOneOff",
      SUM(CASE WHEN base_amount_cents IS NOT NULL AND amount_cents > 0 AND NOT refund
        THEN base_amount_cents ELSE 0 END) AS income,
      SUM(CASE WHEN base_amount_cents IS NOT NULL AND amount_cents > 0 AND NOT refund
        AND NOT ${IS_EXTERNAL()} THEN base_amount_cents ELSE 0 END) AS "incomeOwn",
      SUM(CASE WHEN base_amount_cents IS NOT NULL AND amount_cents > 0 AND NOT refund
        AND ${IS_EXTERNAL()} THEN base_amount_cents ELSE 0 END) AS "incomeExternal"
    FROM transactions
    WHERE ${NOT_TRANSFER} AND ${VISIBLE_ACCOUNT()} AND date >= ${from} AND date <= ${to}
    GROUP BY 1
    ORDER BY 1
  `);
  return rows.map((row) => ({
    month: row.month,
    rows: Number(row.rows),
    unconverted: Number(row.unconverted),
    expense: fromCents(Number(row.expense)),
    expenseOneOff: fromCents(Number(row.expenseOneOff)),
    income: fromCents(Number(row.income)),
    incomeOwn: fromCents(Number(row.incomeOwn)),
    incomeExternal: fromCents(Number(row.incomeExternal)),
  }));
}

export interface GoalCategorySpend {
  category: string;
  total: number;
  rows: number;
  unconverted: number;
  totalRows: number;
}

export async function goalCurrentCategoryTotals(
  from: string,
  to: string,
): Promise<GoalCategorySpend[]> {
  const rows = await rowsOf<{
    category: string;
    total_cents: string;
    rows: number;
    unconverted: number;
    total_rows: number;
  }>(sql`
    WITH grouped AS (
      SELECT ${CATEGORY} AS category,
        SUM(CASE WHEN base_amount_cents IS NOT NULL AND (amount_cents < 0 OR refund)
          THEN -base_amount_cents ELSE 0 END) AS total_cents,
        COUNT(*)::int AS rows,
        COUNT(*) FILTER (
          WHERE (amount_cents < 0 OR refund) AND base_amount_cents IS NULL
        )::int AS unconverted
      FROM transactions
      WHERE ${NOT_TRANSFER} AND ${VISIBLE_ACCOUNT()} AND date >= ${from} AND date <= ${to}
      GROUP BY 1
    )
    SELECT category, total_cents, rows, unconverted,
      SUM(rows) OVER ()::int AS total_rows
    FROM grouped
  `);
  return rows.map((row) => ({
    category: row.category,
    total: fromCents(Number(row.total_cents)),
    rows: Number(row.rows),
    unconverted: Number(row.unconverted),
    totalRows: Number(row.total_rows),
  }));
}

export async function avgMonthlyByCategory(
  from: string,
  to: string,
  months: number,
): Promise<CategorySummary[]> {
  if (months <= 0) return [];
  const { where, money } = scopeSql({ kind: 'all' });
  const rows = await rowsOf<{ category: string; total_cents: string }>(sql`
    SELECT ${CATEGORY} AS category, SUM(-${money}) AS total_cents
    FROM transactions
    WHERE ${where} AND NOT one_off
      AND (amount_cents < 0 OR refund) AND date >= ${from} AND date <= ${to}
    GROUP BY 1
    HAVING SUM(-${money}) > 0
    ORDER BY total_cents DESC`);
  // the sum is exact; the division by months is a genuine fraction - round to whole cents
  return rows.map((r) => ({
    category: r.category,
    total: Math.round(Number(r.total_cents) / months) / 100,
  }));
}

export async function accountOtherCurrencies(scope: AccountScope): Promise<string[]> {
  const rows = await rowsOf<{ currency: string }>(sql`
    SELECT DISTINCT currency FROM transactions
    WHERE account_id = ${scope.id} AND currency <> ${scope.currency}
    ORDER BY 1`);
  return rows.map((r) => r.currency);
}

// ---------- imports (provenance) ----------

type ImportRow = typeof s.imports.$inferSelect;

const rowToImport = (r: ImportRow & { transactions?: number }): ImportRecord => ({
  id: r.id,
  fileHash: r.fileHash,
  sourceType: r.sourceType,
  originalFilename: r.originalFilename,
  accountName: r.accountName,
  accountId: r.accountId,
  uploadedAt: r.uploadedAt,
  parserVersion: r.parserVersion,
  status: r.status,
  rowsAccepted: r.rowsAccepted,
  rowsRejected: r.rowsRejected,
  errorDetail: r.errorDetail,
  transactions: r.transactions ?? 0,
  documentAvailable: r.documentStored,
});

/**
 * Layer 1 of the duplicate defence: has this exact file already been imported?
 * Committed imports only: neither `failed` nor `pending` promises anything about
 * what is in the database (see imports.status), and both must stay retryable
 * with the same bytes.
 */
export async function findCommittedImportByHash(
  fileHash: string,
): Promise<ImportRecord | undefined> {
  const rows = await getDb()
    .select()
    .from(s.imports)
    .where(
      and(
        eq(s.imports.fileHash, fileHash),
        eq(s.imports.status, 'committed'),
      ),
    );
  return rows[0] ? rowToImport(rows[0]) : undefined;
}

/** The import row, written BEFORE parsing so that a crashed parse leaves a record. */
export async function createImport(input: {
  fileHash: string;
  sourceType: ImportSourceType;
  parserVersion: number;
  originalFilename?: string;
}): Promise<ImportRecord> {
  const rows = await getDb()
    .insert(s.imports)
    .values({
      id: crypto.randomUUID(),
      fileHash: input.fileHash,
      sourceType: input.sourceType,
      originalFilename: input.originalFilename ?? null,
      uploadedAt: new Date().toISOString(),
      parserVersion: input.parserVersion,
      status: 'pending',
    })
    .returning();
  return rowToImport(rows[0]);
}

/**
 * The file is on disk: the row may now claim it. A separate write rather than a
 * field on createImport/failImport, because the put happens between the two - and
 * a FAILED import keeps its document, which is what makes a miss diagnosable.
 *
 * Never called before the put: a row claiming a document that is not there is the
 * state every read would have to distrust.
 */
export async function recordImportDocument(id: string): Promise<void> {
  await getDb().update(s.imports).set({ documentStored: true }).where(eq(s.imports.id, id));
}

/**
 * The row no longer claims a readable document. Called only AFTER the bytes are
 * gone: between the two, a crash leaves a row whose document throws on read, which
 * is loud and self-healing - the other order leaves a statement on disk that the
 * user has been told is deleted, and nothing revisits it.
 */
export async function clearImportDocument(id: string): Promise<void> {
  await getDb().update(s.imports).set({ documentStored: false }).where(eq(s.imports.id, id));
}

/** What names the file on disk, plus the pointer - never the file's path itself. */
export interface ImportDocumentInfo extends DocumentLocator {
  sourceType: ImportSourceType;
  documentStored: boolean;
}

export async function getImportDocumentInfo(id: string): Promise<ImportDocumentInfo | undefined> {
  const rows = await getDb()
    .select({
      originalFilename: s.imports.originalFilename,
      sourceType: s.imports.sourceType,
      documentStored: s.imports.documentStored,
    })
    .from(s.imports)
    .where(eq(s.imports.id, id));
  return rows[0] && { importId: id, ...rows[0] };
}

/** Undefined when the row claims no readable document, whatever is on disk. */
export async function getImportDocumentRef(id: string): Promise<DocumentRef | undefined> {
  const rows = await getDb()
    .select({
      fileHash: s.imports.fileHash,
      originalFilename: s.imports.originalFilename,
      sourceType: s.imports.sourceType,
      documentStored: s.imports.documentStored,
    })
    .from(s.imports)
    .where(eq(s.imports.id, id));
  const row = rows[0];
  if (!row || !row.documentStored) return undefined;
  const { documentStored: _stored, ...locator } = row;
  return { importId: id, ...locator };
}

export async function failImport(id: string, message: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx
      .update(s.imports)
      // the last cut between a composed refusal and the screen, and marked: the
      // client renders the whole of what is stored and adds no cut of its own, so an
      // unmarked one arrives reading like a sentence that finished
      .set({
        status: 'failed',
        errorDetail:
          message.length <= ERROR_DETAIL_MAX
            ? message
            : `${message.slice(0, ERROR_DETAIL_MAX - 1)}…`,
      })
      .where(eq(s.imports.id, id));
    await tx
      .delete(s.stagedTransactions)
      .where(eq(s.stagedTransactions.importId, id));
  });
}

/** COUNT is a number on PGlite; int8 and numeric arrive as strings on node-postgres. */
type Counted = string | number;

type ImportListRow = ImportRow & {
  ownTx: Counted;
  totalImports: Counted;
  totalDocuments: Counted;
  totalTransactions: Counted;
};

/**
 * Newest first, each with how many transactions it still owns - which is not
 * rows_accepted: a row an earlier import already wrote belongs to that one - plus
 * totals over the whole filtered set.
 *
 * Page and totals come out of ONE statement: window functions run after WHERE and
 * before LIMIT, so there is no interval in which a concurrent upload or delete can
 * move a total without moving the page printed beside it. Two statements would not
 * be fixed by db.transaction() either - READ COMMITTED takes a fresh snapshot per
 * statement.
 */
export async function listImports(
  opts: { accountId?: string; limit?: number } = {},
): Promise<ImportList> {
  const where: SQL[] = [];
  // on presence, never on truthiness: '' is a filter that matches nothing, and must
  // not widen to every account at this layer either
  if (opts.accountId !== undefined) where.push(sql`account_id = ${opts.accountId}`);
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 100;
  const rows = await rowsOf<ImportListRow>(sql`
    WITH f AS (
      SELECT id, file_hash AS "fileHash",
             source_type AS "sourceType", original_filename AS "originalFilename",
             account_name AS "accountName", account_currency AS "accountCurrency",
             account_id AS "accountId",
             uploaded_at AS "uploadedAt", parser_version AS "parserVersion", status,
             rows_accepted AS "rowsAccepted", rows_rejected AS "rowsRejected",
             error_detail AS "errorDetail",
             document_stored AS "documentStored",
             (SELECT COUNT(*) FROM transactions t WHERE t.import_id = imports.id) AS "ownTx"
      FROM imports${sql.raw(where.length > 0 ? ' WHERE ' : '')}${sql.join(where, sql` AND `)})
    SELECT f.*,
           COUNT(*) OVER () AS "totalImports",
           COUNT(*) FILTER (WHERE "documentStored") OVER () AS "totalDocuments",
           SUM("ownTx") OVER () AS "totalTransactions"
    FROM f ORDER BY "uploadedAt" DESC, id DESC LIMIT ${limit}`);
  const first = rows[0];
  // no row at all is an empty filtered set, not a page that fell off the end: there
  // is no offset and no cursor here, so the first page is the only page there is to
  // miss. Whatever adds one has to take the totals from somewhere other than the first row.
  const totals: ImportTotals = first
    ? {
        imports: Number(first.totalImports),
        documents: Number(first.totalDocuments),
        transactions: Number(first.totalTransactions),
      }
    : { imports: 0, documents: 0, transactions: 0 };
  return { imports: rows.map((r) => rowToImport({ ...r, transactions: Number(r.ownTx) })), totals };
}

/**
 * Where an import's rows actually are - which is not where a caller asked for
 * them to go. Empty when the import owns nothing: everything it accepted had
 * already been written by an earlier import (see transactions.import_id). That
 * is not "nothing was imported".
 */
export async function listImportAccountIds(importId: string): Promise<string[]> {
  const rows = await getDb()
    .selectDistinct({ accountId: s.transactions.accountId })
    .from(s.transactions)
    .where(
      eq(s.transactions.importId, importId),
    );
  return rows.map((r) => r.accountId).sort();
}

type StagedRow = typeof s.stagedTransactions.$inferSelect;

/**
 * A staged row on its way into the pipeline. The return type is what holds the
 * second row shape to the first: a required field added to NewTransaction is a
 * compile error here, and here is the only place it can be.
 */
const stagedToNew = (r: StagedRow): NewTransaction => ({
  accountId: r.accountId,
  provider: r.provider as NewTransaction['provider'],
  amount: fromCents(r.amountCents),
  fee: r.feeCents === null ? null : fromCents(r.feeCents),
  currency: r.currency,
  date: r.date,
  description: r.description,
  mcc: r.mcc ?? undefined,
  category: r.category,
});

/**
 * What the upload asked for, carried on the import row to the confirm request. `id`
 * is required and branded: an import that reached awaiting_confirmation without a
 * resolved account is a state confirmImport refuses, and this is what stops one
 * being written in the first place.
 */
export interface StagedAccount {
  id: ResolvedAccountId;
  name: string;
  currency: string;
}

/**
 * Stages a parsed file and flips the import to `awaiting_confirmation` - in ONE
 * transaction, rows first. That status has to mean "the complete staged set is
 * present", and a crash anywhere inside here leaves `pending`, which nothing can
 * confirm.
 */
export async function stageImport(
  id: string,
  txs: NewTransaction[],
  rowsRejected: number,
  account: StagedAccount,
): Promise<void> {
  const values = txs.map((t, i) => ({
    importId: id,
    rowNo: i,
    accountId: t.accountId,
    provider: t.provider,
    amountCents: toCents(t.amount),
    feeCents: toCentsOrNull(t.fee),
    currency: t.currency,
    date: t.date,
    description: t.description,
    mcc: t.mcc ?? null,
    category: t.category,
  }));
  await getDb().transaction(async (tx) => {
    for (const chunk of chunked(values, 1000)) {
      await tx.insert(s.stagedTransactions).values(chunk);
    }
    await tx
      .update(s.imports)
      .set({
        status: 'awaiting_confirmation',
        rowsAccepted: txs.length,
        rowsRejected,
        accountName: account.name,
        accountCurrency: account.currency,
        accountId: account.id,
      })
      .where(eq(s.imports.id, id));
  });
}

const keyPairs = (pairs: { accountId: string; dedupKey: string }[]): SQL =>
  sql.join(
    pairs.map((p) => sql`(${p.accountId}::text, ${p.dedupKey}::text)`),
    sql`, `,
  );

/**
 * How many of a parsed batch are not already in the database - the one number the
 * user reads before pressing Confirm, so it is asked of the same key list the
 * confirm will offer (claimedKeys) rather than recomputed alongside it.
 *
 * A snapshot, not a promise: another import committing in between can take one of
 * these slots. The confirm answers with what actually landed.
 */
export async function countNewKeys(txs: NewTransaction[]): Promise<number> {
  const pairs = claimedKeys(txs).map((c) => ({
    accountId: c.tx.accountId,
    dedupKey: c.dedupKey,
  }));
  let taken = 0;
  for (const chunk of chunked(pairs, 1000)) {
    const rows = await rowsOf<{ n: string }>(sql`
      SELECT COUNT(*) AS n FROM transactions t
      JOIN (VALUES ${keyPairs(chunk)}) AS k(account_id, dedup_key)
        ON t.account_id = k.account_id AND t.dedup_key = k.dedup_key`);
    taken += Number(rows[0].n);
  }
  return pairs.length - taken;
}

const SUPERSEDED_BY_REUPLOAD =
  'superseded: the same file was uploaded again while this import was still awaiting confirmation, so it was dropped in favour of the newer one';

/**
 * Clears the way for a re-upload of the same bytes: an *older* import of this hash
 * still awaiting confirmation is discarded, and its ids come back so the summary can
 * say so. There is no imports-history screen, which makes re-uploading the file the
 * re-uploading the file the only way back to an import whose tab was closed.
 *
 * Nothing is deleted to do this - a staged import owns no transactions - and the
 * document is kept, referenced by the row that stays behind at `discarded`.
 *
 * **Older, not merely other, and that is the whole concurrency story.** An
 * `id <> exceptId` predicate is symmetric: two uploads of one file that overlap in
 * time both reach `awaiting_confirmation`, then each supersede matches the other and
 * both end up `discarded` - zero confirmable imports and a file that needs a third
 * upload. The tuple excludes self on its own, and the `id` tiebreak decides two
 * uploads landing in the same millisecond, which comparing `uploaded_at` alone would
 * leave superseding neither. `uploaded_at` is read here rather than passed in so that
 * `exceptId` alone determines the comparison; a caller handing over someone else's
 * timestamp would discard the wrong set with nothing failing.
 */
export async function supersedeStagedImports(
  fileHash: string,
  exceptId: string,
): Promise<string[]> {
  const rows = await getDb().transaction(async (tx) => {
    const mine = await tx
      .select({ uploadedAt: s.imports.uploadedAt })
      .from(s.imports)
      .where(eq(s.imports.id, exceptId));
    if (!mine[0]) throw new Error(`import ${exceptId} does not exist`);
    const claimed = await tx
      .update(s.imports)
      .set({ status: 'discarded', errorDetail: SUPERSEDED_BY_REUPLOAD.slice(0, ERROR_DETAIL_MAX) })
      .where(
        and(
          eq(s.imports.fileHash, fileHash),
          eq(s.imports.status, 'awaiting_confirmation'),
          sql`(uploaded_at, id) < (${mine[0].uploadedAt}::text, ${exceptId}::text)`,
        ),
      )
      .returning({ id: s.imports.id, uploadedAt: s.imports.uploadedAt });
    for (const chunk of chunked(claimed, 100)) {
      await tx.delete(s.stagedTransactions).where(
        inArray(
            s.stagedTransactions.importId,
            chunk.map((c) => c.id),
          ),
      );
    }
    return claimed;
  });
  return rows
    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt) || b.id.localeCompare(a.id))
    .map((r) => r.id);
}

async function importStateOf(
  id: string,
): Promise<{ status: ImportStatus; fileHash: string } | undefined> {
  const rows = await getDb()
    .select({ status: s.imports.status, fileHash: s.imports.fileHash })
    .from(s.imports)
    .where(eq(s.imports.id, id));
  return rows[0];
}

class NotAwaitingConfirmation extends Error {}

class AccountRemoved extends Error {}

class AccountMissing extends Error {}

export class ImportNotConfirmable extends Error {}

const UNIQUE_VIOLATION = '23505';

/**
 * Whether a throw is that unique index. The constraint name is checked as well as
 * the code, because the whole point is to answer 409 for one collision and let
 * every other one surface as itself - and the name reaches us either as a field
 * (node-postgres) or only inside the message (PGlite), through however many layers
 * of `cause` the driver wrapped it in.
 */
function isUniqueViolation(e: unknown, constraint: string): boolean {
  for (let cur: unknown = e, depth = 0; cur && depth < 10; depth++) {
    const err = cur as { code?: string; constraint?: string; message?: string; cause?: unknown };
    if (
      err.code === UNIQUE_VIOLATION &&
      (err.constraint === constraint || err.message?.includes(constraint))
    ) {
      return true;
    }
    cur = err.cause;
  }
  return false;
}

export type ConfirmOutcome =
  | {
      confirmed: true;
      accountId: string;
      accountIds: string[];
      inserted: number;
      rowsAccepted: number;
      rowsRejected: number;
    }
  | { confirmed: false; reason: 'status'; status: ImportStatus }
  | { confirmed: false; reason: 'file-committed'; heldBy: string }
  | { confirmed: false; reason: 'account-missing' }
  | { confirmed: false; reason: 'account-hidden' };

export async function confirmImport(id: string): Promise<ConfirmOutcome | undefined> {
  const baseCurrency = await currentBaseCurrency();
  let accountId = '';
  let inserted = 0;
  let rowsAccepted = 0;
  let rowsRejected = 0;
  try {
    await getDb().transaction(async (tx) => {
      const claimed = await tx
        .update(s.imports)
        .set({ status: 'committed' })
        .where(
          and(
            eq(s.imports.id, id),
            eq(s.imports.status, 'awaiting_confirmation'),
          ),
        )
        .returning({
          accountName: s.imports.accountName,
          accountCurrency: s.imports.accountCurrency,
          accountId: s.imports.accountId,
          rowsAccepted: s.imports.rowsAccepted,
          rowsRejected: s.imports.rowsRejected,
        });
      const row = claimed[0];
      if (!row) throw new NotAwaitingConfirmation();
      // the columns are nullable because every import from before the confirmation
      // step is. Confirming one anyway means inventing the account it goes to, and
      // reporting that as a success. accountName and accountCurrency are CHECKED and
      // not read - nothing below reads either - and they stay checked because a row
      // missing them is a row from before this step, which must not become
      // confirmable just because the reader that used them went away
      if (row.accountName === null || row.accountCurrency === null || row.accountId === null) {
        throw new ImportNotConfirmable(
          `import ${id} is awaiting confirmation but records no account name, currency or id`,
        );
      }
      const staged = await tx
        .select()
        .from(s.stagedTransactions)
        .where(
          eq(s.stagedTransactions.importId, id),
        )
        // the ORDER BY is not what makes the counts right - ordinals are numbered
        // within a group, so the count is order-independent. What it decides is
        // which of a group's identical rows gets which ordinal, and therefore which
        // description ends up on the row that survives deduplication
        .orderBy(asc(s.stagedTransactions.rowNo));
      // without this the invariant would rest on stageImport never being reordered
      // by a later change, and its failure would read as a confirmed row count under
      // a summary that promised a larger one
      if (staged.length !== row.rowsAccepted) {
        throw new ImportNotConfirmable(
          `import ${id} was staged with ${row.rowsAccepted} rows and ${staged.length} are present - refusing to confirm a partial import`,
        );
      }
      accountId = row.accountId;
      // stageImport takes the rows and the account as independent arguments and
      // there is no foreign key from transactions.account_id to accounts.id, so a
      // caller whose rows were built for a different account than the one recorded
      // here would get: an account nobody's rows join, rows against an account with
      // no row, and the balance of the empty one recomputed - all reported as
      // confirmed. Today's single caller threads one resolved id into both.
      const stray = staged.find((r) => r.accountId !== accountId);
      if (stray) {
        throw new ImportNotConfirmable(
          `import ${id} is recorded against account ${accountId} but staged a row for ${stray.accountId}`,
        );
      }
      // The account was there and visible when the file was uploaded; the user
      // removed it while the summary sat on screen.
      //
      // FOR UPDATE, and it is load-bearing rather than decoration: under READ
      // COMMITTED a plain read here can be overtaken by a
      // PATCH /api/accounts/:id {hidden:true} committing between it and the insert,
      // and the rows land invisible behind a 200. With the lock that PATCH either
      // waits for this transaction to commit - hiding an account that legitimately
      // has rows, which is reversible and correct - or wins first, and this read
      // then sees hidden = true. Deleting `.for('update')` leaves every test in the
      // suite green: PGlite is single-connection, so nothing here can hold this
      // transaction open while a second one commits.
      //
      // `.at(0)` rather than a destructure so that deleting the throw below is a
      // compile error. This tsconfig has no noUncheckedIndexedAccess, and `strict`
      // does not imply it: NO index form is guarded - `rows[0]` is exactly as silent
      // as `const [holder] =` - so both would type non-optional and the resurrection
      // would come back unannounced. `.at(0)`'s `T | undefined` comes from
      // lib.es2022 instead, which no config here can turn off.
      const holder = (
        await tx
          .select({ hidden: s.accounts.hidden })
          .from(s.accounts)
          .where(eq(s.accounts.id, accountId))
          .for('update')
      ).at(0);
      if (!holder) throw new AccountMissing();
      if (holder.hidden) throw new AccountRemoved();
      inserted = await insertTransactionsOn(tx, staged.map(stagedToNew), baseCurrency, id);
      await tx
        .delete(s.stagedTransactions)
        .where(
          eq(s.stagedTransactions.importId, id),
        );
      // inside the transaction. Nothing else ever recomputes an account's balance, so
      // a crash between the inserts and this would leave Overview showing 0 for an
      // account full of rows, indefinitely, with every status saying the import
      // succeeded
      await recalcAccountBalanceFromTransactionsOn(tx, accountId);
      rowsAccepted = row.rowsAccepted;
      rowsRejected = row.rowsRejected;
    });
  } catch (e) {
    if (e instanceof NotAwaitingConfirmation) {
      const state = await importStateOf(id);
      return state && { confirmed: false, reason: 'status', status: state.status };
    }
    if (e instanceof AccountRemoved) return { confirmed: false, reason: 'account-hidden' };
    if (e instanceof AccountMissing) return { confirmed: false, reason: 'account-missing' };
    // two uploads of one file overlapping in time both reach awaiting_confirmation
    // (the partial index only blocks `committed`), so the second
    // confirm meets the index rather than the status check. Its rows are identical
    // to the ones that landed, so nothing is lost - what must not happen is a 500 on
    // the one screen whose job is telling the user whether their data arrived
    if (isUniqueViolation(e, 'imports_file_hash_unique')) {
      const state = await importStateOf(id);
      const held = state && (await findCommittedImportByHash(state.fileHash));
      if (held) return { confirmed: false, reason: 'file-committed', heldBy: held.id };
    }
    throw e;
  }
  return {
    confirmed: true,
    accountId,
    accountIds: await listImportAccountIds(id),
    inserted,
    rowsAccepted,
    rowsRejected,
  };
}

export type DiscardOutcome =
  | { discarded: true }
  | { discarded: false; status: ImportStatus };

export async function discardImport(id: string): Promise<DiscardOutcome | undefined> {
  const claimed = await getDb().transaction(async (tx) => {
    const rows = await tx
      .update(s.imports)
      .set({ status: 'discarded' })
      .where(
        and(
          eq(s.imports.id, id),
          eq(s.imports.status, 'awaiting_confirmation'),
        ),
      )
      .returning({ id: s.imports.id });
    if (rows.length > 0) {
      await tx
        .delete(s.stagedTransactions)
        .where(
          eq(s.stagedTransactions.importId, id),
        );
    }
    return rows.length;
  });
  if (claimed > 0) return { discarded: true };
  const state = await importStateOf(id);
  if (!state) return undefined;
  return state.status === 'discarded' ? { discarded: true } : { discarded: false, status: state.status };
}

type Executor = { execute: (q: SQL) => Promise<unknown> };

async function rowsVia<T>(d: Executor, q: SQL): Promise<T[]> {
  const res = (await d.execute(q)) as unknown as { rows: T[] };
  return res.rows;
}

/**
 * execCount on a caller-supplied executor. Needed where the count a caller reports
 * must be the affected-row count of the statement that did the deleting, inside the
 * transaction that did it - execCount reaches for the pool, which is a second
 * connection and a second snapshot.
 */
async function execCountVia(d: Executor, q: SQL): Promise<number> {
  const res = (await d.execute(q)) as unknown as {
    rowCount?: number | null;
    affectedRows?: number;
  };
  return Number(res.rowCount ?? res.affectedRows ?? 0);
}

/**
 * The (account, group prefix) pairs whose computed ordinals are about to lose
 * rows. Called before the delete, while those rows still exist. A statement of a
 * few thousand rows produces nearly as many groups, so everything downstream of
 * this works on the whole set at once rather than per group.
 */
async function computedGroupsOf(
  d: Executor,
  importId: string,
): Promise<{ accountId: string; prefix: string }[]> {
  const rows = await rowsVia<{ account_id: string; dedup_key: string }>(
    d,
    sql`SELECT DISTINCT account_id, dedup_key FROM transactions
        WHERE import_id = ${importId}
          AND starts_with(dedup_key, ${COMPUTED_PREFIX})`,
  );
  const seen = new Map<string, { accountId: string; prefix: string }>();
  for (const r of rows) {
    const prefix = computedGroupPrefix(r.dedup_key);
    seen.set(`${r.account_id}|${prefix}`, { accountId: r.account_id, prefix });
  }
  return [...seen.values()];
}

const groupPairs = (groups: { accountId: string; prefix: string }[]): SQL =>
  sql.join(
    groups.map((g) => sql`(${g.accountId}::text, ${g.prefix}::text)`),
    sql`, `,
  );

const keyAssignments = (rows: { id: string; key: string }[]): SQL =>
  sql.join(
    rows.map((r) => sql`(${r.id}::text, ${r.key}::text)`),
    sql`, `,
  );

/**
 * Rewrites the ordinals of every group the delete touched back to a dense 1..n,
 * in the order they already had. Nothing here touches identity: `id` is the
 * surrogate every annotation and foreign key points at, and dedup_key is
 * recomputable precisely so this is allowed.
 *
 * Two passes over the rows that actually move, because the final key of one row
 * is often the current key of another. Between them the affected slots are all
 * free, so a concurrent import into one of these groups can take a slot and make
 * the second pass violate the unique index - which rolls the whole delete back
 * rather than corrupting anything. Fail-safe, and acceptable for one person
 * uploading files, which is the only shape this application has.
 *
 * The statement count is bounded by the chunk size and not by the size of the
 * deleted import: rolling back a large statement is the thing this whole feature
 * is for, and it must not cost one round trip per row.
 */
async function renumberGroups(
  d: Executor,
  groups: { accountId: string; prefix: string }[],
): Promise<void> {
  const survivors: { id: string; account_id: string; dedup_key: string }[] = [];
  for (const chunk of chunked(groups, 500)) {
    survivors.push(
      ...(await rowsVia<{ id: string; account_id: string; dedup_key: string }>(
        d,
        sql`SELECT t.id, t.account_id, t.dedup_key FROM transactions t
            JOIN (VALUES ${groupPairs(chunk)}) AS g(account_id, prefix)
              ON t.account_id = g.account_id AND starts_with(t.dedup_key, g.prefix)`,
      )),
    );
  }

  const byGroup = new Map<string, { id: string; dedup_key: string }[]>();
  for (const r of survivors) {
    const key = `${r.account_id}|${computedGroupPrefix(r.dedup_key)}`;
    const list = byGroup.get(key);
    if (list) list.push(r);
    else byGroup.set(key, [r]);
  }

  const moves: { id: string; key: string }[] = [];
  for (const rows of byGroup.values()) {
    const ordered = rows.sort(
      (a, b) => computedKeyOrdinal(a.dedup_key) - computedKeyOrdinal(b.dedup_key),
    );
    if (ordered.every((r, i) => computedKeyOrdinal(r.dedup_key) === i + 1)) continue;
    ordered.forEach((r, i) => moves.push({ id: r.id, key: withOrdinal(r.dedup_key, i + 1) }));
  }
  if (moves.length === 0) return;

  // every parking chunk before any final chunk: a final key is only free once
  // its whole group has left
  const park = moves.map((m) => ({ id: m.id, key: parkedDedupKey(m.id) }));
  for (const pass of [park, moves]) {
    for (const chunk of chunked(pass, 1000)) {
      await d.execute(sql`
        UPDATE transactions AS t SET dedup_key = v.new_key
        FROM (VALUES ${keyAssignments(chunk)}) AS v(id, new_key)
        WHERE t.id = v.id`);
    }
  }
}

/**
 * What it removes is exactly the rows this import first wrote: not another import's,
 * and not a row no import owns (import_id NULL). It does not remove the account,
 * whose balance is recomputed afterwards.
 *
 * The ordinals of whatever survives in the affected groups are renumbered in the
 * same transaction - see renumberGroup for what a hole would do.
 */
export async function deleteImport(
  id: string,
): Promise<{ removed: number; accountIds: string[] } | undefined> {
  const existing = await getDb()
    // what names the file, read before the row goes: the delete of the file is
    // unconditional on the pointer (see deleteDocument), so the pointer is not read
    .select({
      id: s.imports.id,
      originalFilename: s.imports.originalFilename,
      sourceType: s.imports.sourceType,
    })
    .from(s.imports)
    .where(eq(s.imports.id, id));
  if (!existing[0]) return undefined;

  const owned = await rowsOf<{ account_id: string; n: string }>(
    sql`SELECT account_id, COUNT(*) AS n FROM transactions
        WHERE import_id = ${id} GROUP BY account_id`,
  );
  const accountIds = owned.map((r) => r.account_id);
  const removed = owned.reduce((sum, r) => sum + Number(r.n), 0);

  await getDb().transaction(async (tx) => {
    const groups = await computedGroupsOf(tx, id);
    await tx
      .delete(s.imports)
      .where(eq(s.imports.id, id));
    await renumberGroups(tx, groups);
  });

  // The rows are gone; the blob goes second, on its own, and before the balance
  // recalcs so a slow recalc does not widen the window. A filesystem delete cannot
  // join the transaction above, so the order is the choice: a blob that survives
  // its row is garbage - unreadable, unreachable, removable by hand - while a row
  // that survives its blob is a lie every read has to distrust.
  //
  // A failure here is logged rather than raised: the rows really are deleted, and
  // reporting otherwise would send the user to press the button again. It is logged
  // in a form an operator can act on, because "delete my data" that quietly leaves
  // the bank statement on disk is the failure a data-deletion promise cannot have.
  try {
    await deleteDocument({ importId: id, ...existing[0] });
  } catch (e) {
    logDb.error(
      { err: e },
      `import ${id} deleted, but its stored document was not removed: ${causeChain(e)} - remove it by hand`,
    );
  }

  for (const accountId of accountIds) {
    await recalcAccountBalanceFromTransactions(accountId);
  }
  return { removed, accountIds };
}

class NoSuchAccount extends Error {}

class AccountHoldsStagedRows extends Error {}

export interface DeletedByAccount {
  transactions: number;
  imports: number;
  documents: number;
  transferRules: number;
}

export type AccountDelete =
  | { ok: true; deleted: DeletedByAccount }
  | Extract<AccountWrite, { reason: 'not-found' } | { reason: 'staged-import' }>;

type AccountScoped = {
  [K in keyof typeof s]: (typeof s)[K] extends { accountId: unknown } ? K : never;
}[keyof typeof s];

const CASCADES_FROM_IMPORTS = Symbol('cascades from imports');

/**
 * The other kind of answer: rows that stay. A chart naming an account that is gone
 * is a state the client draws deliberately - the tab remains and says the account
 * is no longer here - so deleting the chart with the account would take a tab away
 * with nothing said, and blanking its account would silently turn one account's
 * chart into an all-accounts one under its old title.
 */
const OUTLIVES_THE_ACCOUNT = Symbol('outlives the account');

/**
 * What deleteAccount does to each of them, and `satisfies` rather than an
 * annotation: a missing key and an excess key are both compile errors, while each
 * statement keeps its own type at the call site. What it does NOT prove is that an
 * entry is executed - the body consumes these by name, in an order that is not
 * interchangeable - so a table added here and never called would compile.
 * ACCOUNT_CASCADE_TABLES is the other half of that; why that list is derived from the
 * schema rather than written down is in this module's SPEC.md.
 */
const ACCOUNT_CASCADE = {
  transactions: (id: string): SQL =>
    sql`DELETE FROM transactions WHERE account_id = ${id}`,
  imports: (id: string): SQL =>
    sql`DELETE FROM imports WHERE account_id = ${id}
        AND NOT ${HOLDS_STAGED_ROWS(id)}
        RETURNING id, document_stored, original_filename, source_type`,
  stagedTransactions: CASCADES_FROM_IMPORTS,
  transferRules: (id: string): SQL =>
    sql`DELETE FROM transfer_rules WHERE account_id = ${id}`,
  analyticsCharts: OUTLIVES_THE_ACCOUNT,
  debtPayoffGoals: OUTLIVES_THE_ACCOUNT,
  goalAccounts: OUTLIVES_THE_ACCOUNT,
} satisfies Record<
  AccountScoped,
  ((id: string) => SQL) | typeof CASCADES_FROM_IMPORTS | typeof OUTLIVES_THE_ACCOUNT
>;

export const ACCOUNT_CASCADE_TABLES = Object.keys(ACCOUNT_CASCADE);

export async function deleteAccount(id: string): Promise<AccountDelete> {
  const deleted: DeletedByAccount = {
    transactions: 0,
    imports: 0,
    documents: 0,
    transferRules: 0,
  };
  let gone: {
    id: string;
    document_stored: boolean;
    original_filename: string | null;
    source_type: string;
  }[] = [];
  let strayAccountIds: string[] = [];
  let strayImportIds: string[] = [];
  try {
    await getDb().transaction(async (tx) => {
      const [held] = await rowsVia<{ id: string }>(
        tx,
        sql`SELECT id FROM accounts WHERE id = ${id} FOR UPDATE`,
      );
      if (!held) throw new NoSuchAccount();

      deleted.transactions = await execCountVia(tx, ACCOUNT_CASCADE.transactions(id));

      // after the delete above, so every row this can still see is another
      // account's by construction. Empty in every state a product path produces -
      // confirmImport refuses a staged set whose rows disagree with the import's
      // account - and a semi-join over this account's imports is what proves that
      // instead of assuming it
      const strays = await rowsVia<{ import_id: string; account_id: string }>(
        tx,
        sql`SELECT DISTINCT t.import_id, t.account_id FROM transactions t
            WHERE t.account_id <> ${id}
              AND t.import_id IN (
                SELECT i.id FROM imports i WHERE i.account_id = ${id})`,
      );
      const groups = new Map<string, { accountId: string; prefix: string }>();
      if (strays.length > 0) {
        strayImportIds = [...new Set(strays.map((r) => r.import_id))];
        strayAccountIds = [...new Set(strays.map((r) => r.account_id))];
        // called while those rows still exist, which is what computedGroupsOf's
        // docstring requires, and deduped across imports the way it dedupes within one
        for (const importId of strayImportIds) {
          for (const g of await computedGroupsOf(tx, importId)) {
            groups.set(`${g.accountId}|${g.prefix}`, g);
          }
        }
      }

      gone = await rowsVia<typeof gone[number]>(tx, ACCOUNT_CASCADE.imports(id));
      deleted.imports = gone.length;
      deleted.documents = gone.filter((r) => r.document_stored).length;

      // the checked premise, never insurance: renumberGroups moves rows through a
      // parking namespace and can trip the unique index against a concurrent
      // import, so an unnecessary call is a new way for a delete to fail
      if (groups.size > 0) await renumberGroups(tx, [...groups.values()]);

      deleted.transferRules = await execCountVia(tx, ACCOUNT_CASCADE.transferRules(id));

      const [removed] = await rowsVia<{ id: string }>(
        tx,
        sql`DELETE FROM accounts WHERE id = ${id}
            AND NOT ${HOLDS_STAGED_ROWS(id)} RETURNING id`,
      );
      // unambiguous, unlike updateAccount's read-back: the row lock is held from the
      // top of this transaction, so the row cannot have gone missing under us and
      // zero rows here can only be the guard
      if (!removed) throw new AccountHoldsStagedRows();
    });
  } catch (e) {
    if (e instanceof NoSuchAccount) return { ok: false, reason: 'not-found' };
    if (e instanceof AccountHoldsStagedRows) return { ok: false, reason: 'staged-import' };
    throw e;
  }

  // The rows are gone; the blobs go second, for deleteImport's reasons, and from
  // the set the DELETE returned rather than one selected before it - an upload
  // landing between a select and the delete would leave a blob nothing can reach
  // again. A failure is logged and not raised: the rows really are deleted.
  for (const row of gone) {
    try {
      await deleteDocument({
        importId: row.id,
        originalFilename: row.original_filename,
        sourceType: row.source_type,
      });
    } catch (e) {
      logDb.error(
        { err: e },
        `import ${row.id} was deleted with account ${id}, but its stored document was not removed: ${causeChain(e)} - remove it by hand`,
      );
    }
  }

  // The database was already inconsistent before this call, and repairing it in
  // silence is how it stays that way. Written here rather than beside the probe
  // that found the rows: the probe runs inside the transaction and ahead of both
  // guarded statements, so a delete refused at the guard would have announced a
  // repair that then rolled back. Past the catch, the rows really are gone.
  if (strayAccountIds.length > 0) {
    logDb.warn(
      `account ${id} holds imports (${strayImportIds.join(', ')}) that own rows in ${strayAccountIds.join(', ')} - deleting the account takes those rows too`,
    );
  }

  // Nothing is owed for `id` itself: the balance is the sum of an account's own
  // transactions, so no other account moves when these go, and the account's own
  // row no longer exists - recalculating it would update nothing and log that
  // something happened. These are the accounts the stray probe named, which lost
  // rows to the imports cascade above.
  for (const accountId of strayAccountIds) {
    await recalcAccountBalanceFromTransactions(accountId);
  }
  return { ok: true, deleted };
}

export async function allTransactions(): Promise<Transaction[]> {
  const rows = await rowsOf<TxRow>(
    sql`SELECT * FROM transactions ORDER BY date ASC`,
  );
  return rows.map(rowToTx);
}

export interface Classification {
  id: string;
  category: string;
  transfer: boolean;
  refund: boolean;
  incomeSource: string | null;
  recurring: boolean;
}

/**
 * How many rows one UPDATE carries. Six bound parameters per row against Postgres's
 * ceiling of 65,535 puts the hard limit near 10,900; 500 is well under it and is
 * chosen for the other end - it is the size at which a batch is still a single
 * round trip a reader can wait on.
 */
export const CLASSIFY_BATCH = 500;

/**
 * Writes the classification result. Manual marks (transfer_manual,
 * income_source_manual, one_off) are left alone - they beat auto-detection.
 *
 * One statement per batch, and no transaction around the whole run. This used to be
 * one UPDATE per row inside a single transaction, which is correct against a
 * connection POOL and is a freeze against the embedded database: PGlite has ONE
 * connection, so every other query in the application queues behind the open
 * transaction and the app answers nothing until the re-tag finishes. Nothing sees it
 * - the suite runs sequentially, and the node-postgres side never had the property.
 *
 * Dropping the transaction is safe because of the order in reclassifyAll: the
 * classify_version signature is written AFTER this returns, so a run that dies half
 * way leaves the old signature, and the next start recomputes every row again.
 * A partial re-tag is a state this converges out of rather than one it can be stuck
 * in - which is the only reason atomicity was worth anything here.
 *
 * The casts are on the first VALUES row's business, not decoration: a bound
 * parameter in a VALUES list arrives as `unknown` and Postgres will not compare it
 * to a text column without being told what it is.
 */
export async function applyClassification(rows: Classification[]): Promise<void> {
  for (let from = 0; from < rows.length; from += CLASSIFY_BATCH) {
    const batch = rows.slice(from, from + CLASSIFY_BATCH);
    const values = sql.join(
      batch.map(
        (r) =>
          sql`(${r.id}::text, ${r.category}::text, ${r.transfer}::boolean, ${r.refund}::boolean, ${r.incomeSource}::text, ${r.recurring}::boolean)`,
      ),
      sql`, `,
    );
    await getDb().execute(sql`
      UPDATE transactions AS t
         SET category = v.category,
             transfer = v.transfer,
             refund = v.refund,
             income_source = v.income_source,
             recurring = v.recurring
        FROM (VALUES ${values}) AS v(id, category, transfer, refund, income_source, recurring)
       WHERE t.id = v.id`);
  }
}

export async function getTransaction(id: string): Promise<Transaction | undefined> {
  const rows = await rowsOf<TxRow>(
    sql`SELECT * FROM transactions WHERE id = ${id}`,
  );
  return rows[0] ? rowToTx(rows[0]) : undefined;
}

export async function setTransferOverride(
  id: string,
  value: boolean | null,
): Promise<Transaction | undefined> {
  await getDb()
    .update(s.transactions)
    .set({ transferManual: value })
    .where(eq(s.transactions.id, id));
  return getTransaction(id);
}

/**
 * The user's own category for one transaction; null hands the decision back to
 * auto-detection. Takes a Category rather than a string: an unvalidated slug here is
 * a bucket every summary answers and no client dictionary can label.
 */
export async function setCategoryOverride(
  id: string,
  category: Category | null,
): Promise<Transaction | undefined> {
  await getDb()
    .update(s.transactions)
    .set({ categoryManual: category })
    .where(eq(s.transactions.id, id));
  return getTransaction(id);
}

export async function setIncomeSourceOverride(
  id: string,
  source: string | null,
): Promise<Transaction | undefined> {
  await getDb()
    .update(s.transactions)
    .set({ incomeSourceManual: source })
    .where(eq(s.transactions.id, id));
  return getTransaction(id);
}

export async function setOneOff(id: string, value: boolean): Promise<Transaction | undefined> {
  await getDb()
    .update(s.transactions)
    .set({ oneOff: value })
    .where(eq(s.transactions.id, id));
  return getTransaction(id);
}

type IncomeSourceRow = typeof s.incomeSources.$inferSelect;

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
    builtin: r.builtin,
  };
}

/**
 * ACCOUNT_NAME_MAX's number and not CHART_TITLE_MAX's: this label is rendered in line
 * by screens that never wrote it, never as a card heading. Here rather than inside the
 * schema so it sits with the value it bounds, which is where a reader of
 * income_sources.label looks.
 */
export const INCOME_SOURCE_LABEL_MAX = 60;

export async function listIncomeSources(): Promise<IncomeSourceDef[]> {
  const rows = await getDb()
    .select()
    .from(s.incomeSources)
    .orderBy(s.incomeSources.sort, s.incomeSources.id);
  return rows.map(rowToIncomeSource);
}

export async function getIncomeSource(id: string): Promise<IncomeSourceDef | undefined> {
  const rows = await getDb()
    .select()
    .from(s.incomeSources)
    .where(eq(s.incomeSources.id, id));
  return rows[0] ? rowToIncomeSource(rows[0]) : undefined;
}

export async function upsertIncomeSource(
  def: Pick<IncomeSourceDef, 'id' | 'label' | 'kind'> &
    Partial<Pick<IncomeSourceDef, 'patterns' | 'sort'>>,
): Promise<IncomeSourceDef> {
  const existing = await getIncomeSource(def.id);
  const nextSort =
    def.sort ??
    existing?.sort ??
    Number(
      (
        await rowsOf<{ m: number }>(
          sql`SELECT COALESCE(MAX(sort), -1) AS m FROM income_sources`,
        )
      )[0].m,
    ) + 1;
  const patterns = JSON.stringify(def.patterns ?? existing?.patterns ?? []);
  await getDb()
    .insert(s.incomeSources)
    .values({
      id: def.id,
      label: def.label,
      kind: def.kind,
      patterns,
      sort: nextSort,
      builtin: false,
    })
    .onConflictDoUpdate({
      target: [s.incomeSources.id],
      set: { label: def.label, kind: def.kind, patterns, sort: nextSort },
    });
  return (await getIncomeSource(def.id))!;
}

/**
 * Deletes a source (builtin ones cannot be). Transactions tagged with it (auto or
 * manual) fall back to 'other' - otherwise their income would silently drop out of
 * the by-source summaries under an unknown id.
 */
export async function deleteIncomeSource(id: string): Promise<boolean> {
  const src = await getIncomeSource(id);
  if (!src || src.builtin) return false;
  await getDb().transaction(async (tx) => {
    await tx
      .update(s.transactions)
      .set({ incomeSource: 'other' })
      .where(eq(s.transactions.incomeSource, id));
    await tx
      .update(s.transactions)
      .set({ incomeSourceManual: 'other' })
      .where(eq(s.transactions.incomeSourceManual, id));
    await tx
      .delete(s.incomeSources)
      .where(eq(s.incomeSources.id, id));
  });
  return true;
}

type RuleRow = typeof s.transferRules.$inferSelect;

const rowToRule = (r: RuleRow): TransferRule => ({
  id: r.id,
  description: r.description,
  accountId: r.accountId,
  matchMode: r.matchMode,
  createdAt: r.createdAt,
});

export async function listTransferRules(): Promise<TransferRule[]> {
  const rows = await getDb()
    .select()
    .from(s.transferRules)
    .orderBy(sql`${s.transferRules.createdAt} DESC`);
  return rows.map(rowToRule);
}

export async function addTransferRule(
  description: string,
  accountId: string,
): Promise<TransferRule> {
  await getDb()
    .insert(s.transferRules)
    .values({ description, accountId, createdAt: new Date().toISOString() })
    .onConflictDoNothing();
  const rows = await getDb()
    .select()
    .from(s.transferRules)
    .where(
      and(
        eq(s.transferRules.description, description),
        eq(s.transferRules.accountId, accountId),
        eq(s.transferRules.matchMode, 'exact'),
      ),
    );
  return rowToRule(rows[0]);
}

export async function deleteTransferRule(id: number): Promise<boolean> {
  const rows = await getDb()
    .delete(s.transferRules)
    .where(eq(s.transferRules.id, id))
    .returning({ id: s.transferRules.id });
  return rows.length > 0;
}

export async function countTransferRuleMatches(rules: TransferRule[]): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  for (const accountId of new Set(rules.map((rule) => rule.accountId))) {
    const rows = await rowsOf<Pick<TxRow, 'account_id' | 'description'>>(
      sql`SELECT account_id, description FROM transactions WHERE account_id = ${accountId}`,
    );
    const covered = tallyTransferRuleMatches(rows.map((r) => ({ accountId: r.account_id, description: r.description })));
    for (const rule of rules) {
      if (rule.accountId === accountId) counts.set(rule.id, covered(rule));
    }
  }
  return counts;
}

export async function countRuleMatches(rule: TransferRule): Promise<number> {
  return (await countTransferRuleMatches([rule])).get(rule.id) ?? 0;
}

function transferPreview(source: Transaction, rows: Transaction[], rules: TransferRule[]): TransferRulePreview {
  const key = similarDescriptionKey(source.description);
  const match = { accountId: source.accountId, description: source.description, matchMode: 'similar-v1' as const };
  const transactions = rows.filter((row) => matchesTransferRule(match, row));
  const relatedRules = rules.filter((rule) => similarDescriptionKey(rule.description) === key);
  const activeRules = relatedRules.filter((rule) => matchesTransferRule(rule, source));
  const activeRule = activeRules.find((rule) => rule.matchMode === 'similar-v1') ?? activeRules[0] ?? null;
  const previewToken = crypto.createHash('sha256').update(JSON.stringify([
    source.id, source.accountId, key,
    transactions.map((t) => [t.id, t.description, t.date, t.amount, t.currency, t.transferManual]),
    relatedRules,
  ])).digest('hex');
  return {
    txId: source.id,
    accountId: source.accountId,
    description: source.displayDescription ?? source.description,
    transactions,
    matches: transactions.length,
    manualOverrides: transactions.filter((t) => t.transferManual !== null).length,
    activeRule,
    previewToken,
  };
}

export async function previewTransferRule(id: string): Promise<TransferRulePreview | undefined> {
  const source = await getTransaction(id);
  if (!source) return undefined;
  const rows = await rowsOf<TxRow>(sql`
    SELECT * FROM transactions WHERE account_id = ${source.accountId} ORDER BY date DESC, id ASC`);
  const rules = await getDb().select().from(s.transferRules)
    .where(eq(s.transferRules.accountId, source.accountId)).orderBy(asc(s.transferRules.id));
  return transferPreview(source, rows.map(rowToTx), rules.map(rowToRule));
}

export async function applySimilarTransferRule(id: string, previewToken: string): Promise<
  | { ok: true; rule: TransferRule; matches: number }
  | { ok: false; reason: 'not-found' | 'empty' | 'changed' }
> {
  return getDb().transaction(async (tx) => {
    const sourceRow = (await rowsVia<TxRow>(tx, sql`SELECT * FROM transactions WHERE id = ${id}`)).at(0);
    if (!sourceRow) return { ok: false, reason: 'not-found' };
    const holder = await tx.select({ id: s.accounts.id }).from(s.accounts)
      .where(eq(s.accounts.id, sourceRow.account_id)).for('update');
    if (!holder.length) return { ok: false, reason: 'not-found' };
    const rows = await rowsVia<TxRow>(tx, sql`
      SELECT * FROM transactions WHERE account_id = ${sourceRow.account_id}
      ORDER BY date DESC, id ASC FOR UPDATE`);
    const source = rows.find((row) => row.id === id);
    if (!source) return { ok: false, reason: 'not-found' };
    const key = similarDescriptionKey(source.description);
    if (!key) return { ok: false, reason: 'empty' };
    const rules = await tx.select().from(s.transferRules)
      .where(eq(s.transferRules.accountId, source.account_id)).orderBy(asc(s.transferRules.id)).for('update');
    const preview = transferPreview(rowToTx(source), rows.map(rowToTx), rules.map(rowToRule));
    if (preview.previewToken !== previewToken) return { ok: false, reason: 'changed' };
    const replaced = rules.filter((rule) => similarDescriptionKey(rule.description) === key);
    if (replaced.length) {
      await tx.delete(s.transferRules).where(inArray(s.transferRules.id, replaced.map((r) => r.id)));
    }
    const [rule] = await tx.insert(s.transferRules).values({
      description: source.description, accountId: source.account_id, matchMode: 'similar-v1', createdAt: new Date().toISOString(),
    }).returning();
    for (const ids of chunked(preview.transactions.map((t) => t.id), CLASSIFY_BATCH)) {
      await tx.update(s.transactions).set({ transferManual: null }).where(inArray(s.transactions.id, ids));
    }
    return { ok: true, rule: rowToRule(rule), matches: preview.matches };
  });
}

/**
 * Clears manual marks from transactions covered by the rule: otherwise an old
 * manual `transfer_manual = false` would keep overriding the rule that was just
 * created, and one transaction in the group would stay untagged.
 */
export async function clearManualForRule(description: string, accountId: string): Promise<void> {
  await getDb().execute(sql`
    UPDATE transactions SET transfer_manual = NULL
    WHERE description = ${description} AND account_id = ${accountId}`);
}

export async function getFxRate(day: string, currency: string): Promise<number | undefined> {
  const rows = await getDb()
    .select()
    .from(s.fxRates)
    .where(
      and(
        eq(s.fxRates.date, day),
        eq(s.fxRates.currency, currency),
      ),
    );
  return rows[0]?.rate;
}

export async function saveFxRate(day: string, currency: string, rate: number): Promise<void> {
  await getDb()
    .insert(s.fxRates)
    .values({ date: day, currency, rate })
    .onConflictDoUpdate({
      target: [s.fxRates.date, s.fxRates.currency],
      set: { rate },
    });
}

export async function setBaseForBaseCurrency(baseCurrency: string): Promise<number> {
  return execCount(sql`
    UPDATE transactions SET base_amount_cents = amount_cents, fx_rate = 1
    WHERE base_amount_cents IS NULL AND currency = ${baseCurrency}`);
}

/**
 * Changing the base currency: every base_amount is recomputed from scratch - the
 * old values were computed in the previous currency and cannot be added to the new ones.
 */
export async function resetBaseAmounts(): Promise<number> {
  return execCount(
    sql`UPDATE transactions SET base_amount_cents = NULL, fx_rate = NULL`,
  );
}

export async function listUnconvertedDays(): Promise<{ day: string; currency: string }[]> {
  return rowsOf<{ day: string; currency: string }>(sql`
    SELECT DISTINCT SUBSTR(date, 1, 10) AS day, currency
    FROM transactions WHERE base_amount_cents IS NULL ORDER BY day`);
}

/**
 * Fills base_amount for every unconverted row of that day in that currency.
 * k - units of the base currency per unit of `currency` on that day.
 * The cast is on the parameter, not on the product: amount_cents is an integer
 * column, so `amount_cents * $1` types $1 as integer too and every fractional
 * rate is rejected before a cast on the result can matter. ::numeric and not
 * ::float8 - ROUND(numeric) is half away from zero, like toCents(); ROUND(double)
 * is half to even.
 */
export async function applyBaseRate(day: string, currency: string, k: number): Promise<number> {
  return execCount(sql`
    UPDATE transactions
    SET base_amount_cents = CAST(ROUND(amount_cents * ${k}::numeric) AS integer), fx_rate = ${k}
    WHERE base_amount_cents IS NULL AND currency = ${currency} AND SUBSTR(date, 1, 10) = ${day}`);
}

export async function setRecurringIgnored(description: string, ignored: boolean): Promise<void> {
  const key = recurringKey(description);
  if (ignored) {
    await getDb()
      .insert(s.recurringIgnores)
      .values({ key, description, createdAt: new Date().toISOString() })
      .onConflictDoNothing();
  } else {
    await getDb()
      .delete(s.recurringIgnores)
      .where(eq(s.recurringIgnores.key, key));
  }
}

/**
 * Groups of recurring spending (recurring = true) since sinceIso, across visible
 * accounts. Grouped by the same normalized key as the detector (digits collapsed):
 * rent "LEV 01/2026"..."LEV 07/2026" is one group.
 */
export async function listRecurringGroups(sinceIso: string): Promise<RecurringGroup[]> {
  const rows = await rowsOf<{
    description: string;
    category: string;
    date: string;
    base_amount_cents: number;
  }>(sql`
    SELECT description, ${CATEGORY} AS category, date, base_amount_cents
    FROM transactions
    WHERE recurring AND amount_cents < 0 AND ${NOT_TRANSFER} AND ${VISIBLE_ACCOUNT()}
      AND base_amount_cents IS NOT NULL AND date >= ${sinceIso}
    ORDER BY date ASC`);

  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = recurringKey(r.description);
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }

  const ignoredKeys = new Set(
    (
      await getDb()
        .select({ key: s.recurringIgnores.key })
        .from(s.recurringIgnores)
    ).map((r) => r.key),
  );

  // the total is an exact sum of integer cents; the averages divide it, so they are
  // rounded back to whole cents
  const avgCents = (totalCents: number, n: number) => Math.round(totalCents / n) / 100;
  return [...groups.entries()]
    .map(([key, list]) => {
      const months = new Set(list.map((r) => r.date.slice(0, 7))).size;
      const totalCents = list.reduce((sum, r) => sum - r.base_amount_cents, 0);
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

export async function listCategoryRules(): Promise<CategoryRule[]> {
  const rows = await getDb()
    .select()
    .from(s.categoryRules)
    .orderBy(sql`${s.categoryRules.createdAt} DESC`);
  return rows.map((r) => ({
    id: r.id,
    pattern: r.pattern,
    category: r.category,
    createdAt: r.createdAt,
  }));
}

export async function addCategoryRule(pattern: string, category: string): Promise<CategoryRule> {
  await getDb()
    .insert(s.categoryRules)
    .values({ pattern, category, createdAt: new Date().toISOString() })
    .onConflictDoUpdate({
      target: [s.categoryRules.pattern],
      set: { category },
    });
  const rows = await getDb()
    .select()
    .from(s.categoryRules)
    .where(eq(s.categoryRules.pattern, pattern));
  const row = rows[0];
  return { id: row.id, pattern: row.pattern, category: row.category, createdAt: row.createdAt };
}

function categoryPreview(pattern: string, rows: Transaction[], rules: CategoryRule[]): CategoryRulePreview {
  const activeRule = rules.find((rule) => rule.pattern === pattern) ?? null;
  const otherRules = rules.filter((rule) => rule.id !== activeRule?.id && (
    categoryPatternMatches(pattern, rule.pattern) ||
    rows.some((row) => categoryPatternMatches(row.description, rule.pattern))
  ));
  const previewToken = crypto.createHash('sha256').update(JSON.stringify([
    pattern,
    rows.map((row) => [row.id, row.accountId, row.description, row.date, row.amount, row.currency, row.category, row.categoryManual]),
    rules,
  ])).digest('hex');
  return {
    pattern, transactions: rows, matches: rows.length,
    overridden: rows.filter((row) => row.categoryManual).length,
    activeRule, otherRules, previewToken,
  };
}

async function readCategoryPreview(db: Db, pattern: string): Promise<CategoryRulePreview> {
  const rows = await rowsVia<TxRow>(db, sql`SELECT * FROM transactions ORDER BY date DESC, id ASC`);
  const rules = await db.select().from(s.categoryRules).orderBy(asc(s.categoryRules.id));
  return categoryPreview(pattern, rows.filter((r) => categoryPatternMatches(r.description, pattern)).map(rowToTx), rules);
}

export async function previewCategoryRule(pattern: string): Promise<CategoryRulePreview> {
  return readCategoryPreview(getDb(), pattern);
}

export async function applyPreviewedCategoryRule(pattern: string, category: string, previewToken: string): Promise<CategoryRule | undefined> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`LOCK TABLE transactions, category_rules IN SHARE ROW EXCLUSIVE MODE`);
    const preview = await readCategoryPreview(tx, pattern);
    if (preview.previewToken !== previewToken) return undefined;
    const [rule] = await tx.insert(s.categoryRules)
      .values({ pattern, category, createdAt: new Date().toISOString() })
      .onConflictDoUpdate({ target: [s.categoryRules.pattern], set: { category } })
      .returning();
    return rule;
  });
}

export async function deleteCategoryRule(id: number): Promise<boolean> {
  const rows = await getDb()
    .delete(s.categoryRules)
    .where(eq(s.categoryRules.id, id))
    .returning({ id: s.categoryRules.id });
  return rows.length > 0;
}

/**
 * How many transactions the pattern covers, and how many of those the rule cannot
 * change because the user set the category by hand. One filter computing both, so the
 * two can never be taken through different filters and matches - overridden go wrong
 * as soon as one account is hidden.
 */
export async function countCategoryRuleMatches(pattern: string): Promise<CategoryRuleCounts> {
  const rows = await rowsOf<Pick<TxRow, 'description' | 'category_manual'>>(
    sql`SELECT description, category_manual FROM transactions`,
  );
  const matched = rows.filter((r) => categoryPatternMatches(r.description, pattern));
  return { matches: matched.length, overridden: matched.filter((r) => r.category_manual !== null).length };
}

export type ChartsWrite =
  | { ok: true; version: number; charts: Chart[] }
  | { ok: false; reason: 'stale'; version: number; charts: Chart[] };

const CHARTS_VERSION_KEY = 'analytics_charts_version';

/**
 * meta.value is text, so the counter comes back a string on both drivers. Parsed
 * here and nowhere else: a route comparing '1' to 1 would answer 409 to every
 * write after the first, for ever. Anything unparseable reads as 0 rather than
 * throwing - restoreBackup is a door that inserts values nothing validated.
 */
const parseChartsVersion = (raw: string | undefined): number => {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
};

const chartsVersionRow = async (d: Db): Promise<string | undefined> =>
  (await d.select({ value: s.meta.value }).from(s.meta).where(eq(s.meta.key, CHARTS_VERSION_KEY)))[0]
    ?.value;

type ChartRow = typeof s.analyticsCharts.$inferSelect;

const KNOWN_METRICS = new Set<string>(CHART_METRICS);

function rowToChart(r: ChartRow): Chart {
  let metrics: ChartMetric[] = [];
  try {
    const v = JSON.parse(r.metrics);
    if (Array.isArray(v)) metrics = v.filter((m): m is ChartMetric => KNOWN_METRICS.has(m));
  } catch {
    // corrupted JSON - a chart with no measures, which the client draws a sentence for
  }
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    accountId: r.accountId,
    metrics,
    breakdown: r.breakdown,
    range: r.range,
  };
}

/**
 * The version is read BEFORE the charts, and the order is the guarantee rather
 * than a formality: read the other way round, a write committing between the two
 * statements hands the caller an old list under the new version, and the caller's
 * next write then matches and silently overwrites it. This way the caller can only
 * ever hold a version older than its list, which the next write refuses out loud.
 */
async function chartListOn(d: Db): Promise<ChartList> {
  const version = parseChartsVersion(await chartsVersionRow(d));
  const rows = await d
    .select()
    .from(s.analyticsCharts)
    .orderBy(s.analyticsCharts.sort, s.analyticsCharts.id);
  return { version, charts: rows.map(rowToChart) };
}

export async function listCharts(): Promise<ChartList> {
  return chartListOn(getDb());
}

/**
 * Replaces the whole list, or refuses. One transaction: a crash anywhere in it
 * leaves the previous list standing.
 *
 * The compare-and-swap matches the bytes that were read, not String(expected):
 * a stored '007' parses to 7, so a caller sending 7 gets past the comparison and
 * would then match no row for ever. Matching what was read accepts it and writes
 * the canonical value back.
 */
export async function replaceCharts(expected: number, charts: Chart[]): Promise<ChartsWrite> {
  return getDb().transaction(async (tx) => {
    await tx
      .insert(s.meta)
      .values({ key: CHARTS_VERSION_KEY, value: '0' })
      .onConflictDoNothing();
    const raw = await chartsVersionRow(tx);
    const stale = async (): Promise<ChartsWrite> => ({
      ok: false,
      reason: 'stale',
      ...(await chartListOn(tx)),
    });
    if (parseChartsVersion(raw) !== expected) return stale();
    const bumped = await tx
      .update(s.meta)
      .set({ value: String(expected + 1) })
      .where(
        and(
          eq(s.meta.key, CHARTS_VERSION_KEY),
          eq(s.meta.value, raw ?? '0'),
        ),
      )
      .returning({ key: s.meta.key });
    // another writer moved the counter between the read and this statement: under
    // READ COMMITTED the predicate is re-evaluated against their committed row
    if (bumped.length === 0) return stale();
    await tx.delete(s.analyticsCharts);
    if (charts.length > 0) {
      await tx.insert(s.analyticsCharts).values(
        charts.map((c, i) => ({
          id: c.id,
          sort: i,
          title: c.title,
          kind: c.kind,
          range: c.range,
          breakdown: c.breakdown,
          accountId: c.accountId,
          metrics: JSON.stringify(c.metrics),
        })),
      );
    }
    // read back inside the writing transaction, never the request echoed: a route
    // that answers with what it was sent reports a write that did not happen as 200
    return { ok: true, ...(await chartListOn(tx)) };
  });
}

type StoredGoal<T extends GoalType> = Extract<GoalCreate, { type: T }>;
type GoalRecordCommon = {
  id: string;
  name: string;
  targetDate: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GoalRecord =
  | (GoalRecordCommon &
      Omit<StoredGoal<'financial-independence'>, 'name' | 'essentialCosts'> & {
        essentialCosts: GoalCost[];
      })
  | (GoalRecordCommon & Omit<StoredGoal<'emergency-fund'>, 'name' | 'targetDate'> & {
      currency: string;
    })
  | (GoalRecordCommon & Omit<StoredGoal<'savings-balance'>, 'name' | 'targetDate'> & {
      currency: string;
    })
  | (GoalRecordCommon & Omit<StoredGoal<'debt-payoff'>, 'name' | 'targetDate'> & {
      startingDebt: number;
      currency: string;
    })
  | (GoalRecordCommon & Omit<StoredGoal<'monthly-income'>, 'name'> & {
      baseCurrency: string;
    })
  | (GoalRecordCommon & Omit<StoredGoal<'savings-rate'>, 'name'>)
  | (GoalRecordCommon & Omit<StoredGoal<'category-spending-limit'>, 'name'> & {
      baseCurrency: string;
    });

type GoalJoinRow = {
  id: string;
  type: GoalType;
  name: string;
  target_date: string | null;
  created_at: string;
  updated_at: string;
  fi_basis: 'essential-costs' | 'current-spending' | null;
  fi_buffer_pct: number | null;
  fi_window_months: number | null;
  fi_hourly_rate_cents: number | null;
  fi_hours_per_week: number | null;
  ef_monthly_essentials_cents: number | null;
  ef_coverage_months: number | null;
  ef_currency: string | null;
  sb_target_cents: number | null;
  sb_currency: string | null;
  dp_account_id: string | null;
  dp_starting_debt_cents: number | null;
  dp_target_debt_cents: number | null;
  dp_currency: string | null;
  mi_target_monthly_cents: number | null;
  mi_income_scope: 'own' | 'all' | null;
  mi_window_months: number | null;
  mi_base_currency: string | null;
  sr_target_basis_points: number | null;
  sr_income_scope: 'own' | 'all' | null;
  sr_window_months: number | null;
  cs_category: string | null;
  cs_monthly_limit_cents: number | null;
  cs_base_currency: string | null;
};

const goalRowsOn = async (d: Executor, id?: string): Promise<GoalJoinRow[]> =>
  rowsVia<GoalJoinRow>(d, sql`
    SELECT g.id, g.type, g.name, g.target_date, g.created_at, g.updated_at,
      fi.basis AS fi_basis, fi.buffer_pct AS fi_buffer_pct,
      fi.window_months AS fi_window_months,
      fi.hourly_rate_cents AS fi_hourly_rate_cents,
      fi.hours_per_week AS fi_hours_per_week,
      ef.monthly_essentials_cents AS ef_monthly_essentials_cents,
      ef.coverage_months AS ef_coverage_months, ef.currency AS ef_currency,
      sb.target_cents AS sb_target_cents, sb.currency AS sb_currency,
      dp.account_id AS dp_account_id, dp.starting_debt_cents AS dp_starting_debt_cents,
      dp.target_debt_cents AS dp_target_debt_cents, dp.currency AS dp_currency,
      mi.target_monthly_cents AS mi_target_monthly_cents,
      mi.income_scope AS mi_income_scope, mi.window_months AS mi_window_months,
      mi.base_currency AS mi_base_currency,
      sr.target_basis_points AS sr_target_basis_points,
      sr.income_scope AS sr_income_scope, sr.window_months AS sr_window_months,
      cs.category AS cs_category, cs.monthly_limit_cents AS cs_monthly_limit_cents,
      cs.base_currency AS cs_base_currency
    FROM goals g
    LEFT JOIN financial_independence_goals fi ON fi.goal_id = g.id AND fi.goal_type = g.type
    LEFT JOIN emergency_fund_goals ef ON ef.goal_id = g.id AND ef.goal_type = g.type
    LEFT JOIN savings_balance_goals sb ON sb.goal_id = g.id AND sb.goal_type = g.type
    LEFT JOIN debt_payoff_goals dp ON dp.goal_id = g.id AND dp.goal_type = g.type
    LEFT JOIN monthly_income_goals mi ON mi.goal_id = g.id AND mi.goal_type = g.type
    LEFT JOIN savings_rate_goals sr ON sr.goal_id = g.id AND sr.goal_type = g.type
    LEFT JOIN category_spending_goals cs ON cs.goal_id = g.id AND cs.goal_type = g.type
    ${id === undefined ? sql`` : sql`WHERE g.id = ${id}`}
    ORDER BY g.created_at, g.id
  `);

const requiredGoalField = <T>(
  value: T | null | undefined,
  goalId: string,
  field: string,
): T => {
  if (value === null || value === undefined) throw new Error(`goal ${goalId} has no ${field}`);
  return value;
};

const recordsFromGoalRows = async (d: Executor, rows: GoalJoinRow[]): Promise<GoalRecord[]> => {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const accountRows = await rowsVia<{ goal_id: string; account_id: string }>(d, sql`
    SELECT goal_id, account_id FROM goal_accounts
    WHERE goal_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
    ORDER BY goal_id, position
  `);
  const costRows = await rowsVia<{
    id: number;
    goal_id: string;
    label: string;
    monthly_cents: number;
    sort: number;
  }>(d, sql`
    SELECT id, goal_id, label, monthly_cents, sort FROM baseline_items
    WHERE goal_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
    ORDER BY goal_id, sort, id
  `);
  const accounts = new Map<string, string[]>();
  for (const row of accountRows) {
    const list = accounts.get(row.goal_id) ?? [];
    list.push(row.account_id);
    accounts.set(row.goal_id, list);
  }
  const costs = new Map<string, GoalCost[]>();
  for (const row of costRows) {
    const list = costs.get(row.goal_id) ?? [];
    list.push({ id: row.id, label: row.label, monthly: fromCents(row.monthly_cents), sort: row.sort });
    costs.set(row.goal_id, list);
  }
  return rows.map((row): GoalRecord => {
    const common: GoalRecordCommon = {
      id: row.id,
      name: row.name,
      targetDate: row.target_date,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    switch (row.type) {
      case 'financial-independence':
        return {
          ...common,
          type: row.type,
          basis: requiredGoalField(row.fi_basis, row.id, 'basis'),
          bufferPct: requiredGoalField(row.fi_buffer_pct, row.id, 'buffer percentage'),
          windowMonths: requiredGoalField(row.fi_window_months, row.id, 'window'),
          hourlyRate:
            row.fi_hourly_rate_cents === null ? null : fromCents(row.fi_hourly_rate_cents),
          hoursPerWeek: row.fi_hours_per_week,
          essentialCosts: costs.get(row.id) ?? [],
        };
      case 'emergency-fund':
        return {
          ...common,
          type: row.type,
          coverageMonths: requiredGoalField(row.ef_coverage_months, row.id, 'coverage'),
          monthlyEssentials: fromCents(
            requiredGoalField(row.ef_monthly_essentials_cents, row.id, 'monthly essentials'),
          ),
          accountIds: accounts.get(row.id) ?? [],
          currency: requiredGoalField(row.ef_currency, row.id, 'currency'),
        };
      case 'savings-balance':
        return {
          ...common,
          type: row.type,
          target: fromCents(requiredGoalField(row.sb_target_cents, row.id, 'target')),
          accountIds: accounts.get(row.id) ?? [],
          currency: requiredGoalField(row.sb_currency, row.id, 'currency'),
        };
      case 'debt-payoff':
        return {
          ...common,
          type: row.type,
          accountId: requiredGoalField(row.dp_account_id, row.id, 'account'),
          startingDebt: fromCents(
            requiredGoalField(row.dp_starting_debt_cents, row.id, 'starting debt'),
          ),
          targetDebt: fromCents(requiredGoalField(row.dp_target_debt_cents, row.id, 'target debt')),
          currency: requiredGoalField(row.dp_currency, row.id, 'currency'),
        };
      case 'monthly-income':
        return {
          ...common,
          type: row.type,
          target: fromCents(requiredGoalField(row.mi_target_monthly_cents, row.id, 'target')),
          incomeScope: requiredGoalField(row.mi_income_scope, row.id, 'income scope'),
          windowMonths: requiredGoalField(row.mi_window_months, row.id, 'window'),
          baseCurrency: requiredGoalField(row.mi_base_currency, row.id, 'base currency'),
        };
      case 'savings-rate':
        return {
          ...common,
          type: row.type,
          targetPercent:
            requiredGoalField(row.sr_target_basis_points, row.id, 'target percentage') / 100,
          incomeScope: requiredGoalField(row.sr_income_scope, row.id, 'income scope'),
          windowMonths: requiredGoalField(row.sr_window_months, row.id, 'window'),
        };
      case 'category-spending-limit':
        return {
          ...common,
          type: row.type,
          category: requiredGoalField(row.cs_category, row.id, 'category'),
          monthlyLimit: fromCents(
            requiredGoalField(row.cs_monthly_limit_cents, row.id, 'monthly limit'),
          ),
          baseCurrency: requiredGoalField(row.cs_base_currency, row.id, 'base currency'),
        };
    }
  });
};

export async function listGoals(): Promise<GoalRecord[]> {
  const rows = await goalRowsOn(getDb());
  return recordsFromGoalRows(getDb(), rows);
}

export async function getGoal(id: string): Promise<GoalRecord | undefined> {
  const rows = await goalRowsOn(getDb(), id);
  return (await recordsFromGoalRows(getDb(), rows))[0];
}

export type GoalWriteErrorCode =
  | 'account-unavailable'
  | 'currency-mismatch'
  | 'debt-account-immutable'
  | 'duplicate-account'
  | 'duplicate-category'
  | 'duplicate-cost'
  | 'essential-costs-required'
  | 'invalid-target-date'
  | 'not-debt'
  | 'target-debt-invalid'
  | 'unknown-category';

export class GoalWriteError extends Error {
  constructor(
    readonly code: GoalWriteErrorCode,
    message: string,
  ) {
    super(message);
  }
}

type GoalAccountRow = {
  id: string;
  name: string;
  currency: string;
  balance_cents: number;
};

type PreparedGoal = {
  baseCurrency: string;
  currency?: string;
  startingDebtCents?: number;
};

const goalBaseCurrencyOn = async (d: Executor): Promise<string> => {
  const rows = await rowsVia<{ value: string }>(
    d,
    sql`SELECT value FROM settings WHERE key = 'base_currency'`,
  );
  return rows[0]?.value ?? config.baseCurrency;
};

const selectedGoalAccounts = async (d: Executor, ids: string[]): Promise<GoalAccountRow[]> => {
  const rows = await rowsVia<GoalAccountRow>(d, sql`
    SELECT id, name, currency, balance_cents FROM accounts
    WHERE hidden = false AND id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
  `);
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
};

const validDateOnly = (value: string): boolean => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

const prepareGoalWrite = async (
  d: Executor,
  input: GoalCreate,
  today: string,
  existing?: GoalRecord,
): Promise<PreparedGoal> => {
  const targetDate = 'targetDate' in input ? input.targetDate : null;
  if (targetDate !== null && (!validDateOnly(targetDate) || targetDate < today)) {
    throw new GoalWriteError('invalid-target-date', 'target date must be today or later');
  }
  const baseCurrency = await goalBaseCurrencyOn(d);
  if (input.type === 'financial-independence') {
    const labels = input.essentialCosts.map((cost) => cost.label.trim().toLocaleLowerCase());
    if (new Set(labels).size !== labels.length) {
      throw new GoalWriteError('duplicate-cost', 'essential cost names must be unique');
    }
    if (input.basis === 'essential-costs' && input.essentialCosts.length === 0) {
      throw new GoalWriteError(
        'essential-costs-required',
        'add at least one essential monthly cost',
      );
    }
    return { baseCurrency };
  }
  if (input.type === 'category-spending-limit') {
    if (!(CATEGORIES as readonly string[]).includes(input.category)) {
      throw new GoalWriteError('unknown-category', 'choose a known category');
    }
    const rows = await rowsVia<{ goal_id: string }>(d, sql`
      SELECT goal_id FROM category_spending_goals WHERE category = ${input.category}
      ${existing ? sql`AND goal_id <> ${existing.id}` : sql``}
    `);
    if (rows.length > 0) {
      throw new GoalWriteError(
        'duplicate-category',
        'a category spending limit already tracks this category',
      );
    }
    return { baseCurrency };
  }
  if (input.type === 'monthly-income' || input.type === 'savings-rate') {
    return { baseCurrency };
  }
  if (input.type === 'debt-payoff' && existing?.type === 'debt-payoff') {
    if (input.accountId !== existing.accountId) {
      throw new GoalWriteError(
        'debt-account-immutable',
        'the debt account cannot change; create a new goal for another account',
      );
    }
    if (input.targetDebt >= existing.startingDebt) {
      throw new GoalWriteError(
        'target-debt-invalid',
        'target debt must be below the captured starting debt',
      );
    }
    return {
      baseCurrency,
      currency: existing.currency,
      startingDebtCents: toCents(existing.startingDebt),
    };
  }

  const ids = input.type === 'debt-payoff' ? [input.accountId] : input.accountIds;
  if (new Set(ids).size !== ids.length) {
    throw new GoalWriteError('duplicate-account', 'select each account only once');
  }
  const accounts = await selectedGoalAccounts(d, ids);
  if (accounts.length !== ids.length) {
    throw new GoalWriteError(
      'account-unavailable',
      'choose an account that is still visible',
    );
  }
  const currencies = new Set(accounts.map((account) => account.currency));
  if (currencies.size !== 1) {
    throw new GoalWriteError('currency-mismatch', 'selected accounts must use one currency');
  }
  const currency = accounts[0].currency;
  if (input.type === 'emergency-fund' && currency !== baseCurrency) {
    throw new GoalWriteError(
      'currency-mismatch',
      `emergency-fund accounts must use the base currency ${baseCurrency}`,
    );
  }
  if (input.type === 'debt-payoff') {
    const startingDebtCents = -accounts[0].balance_cents;
    if (startingDebtCents <= 0) {
      throw new GoalWriteError('not-debt', 'the selected account does not currently show debt');
    }
    if (toCents(input.targetDebt) >= startingDebtCents) {
      throw new GoalWriteError(
        'target-debt-invalid',
        'target debt must be below the current debt',
      );
    }
    return { baseCurrency, currency, startingDebtCents };
  }
  return { baseCurrency, currency };
};

type GoalWriteDb = Pick<Db, 'delete' | 'insert' | 'update'>;

const insertGoalAccounts = async (
  d: Pick<Db, 'insert'>,
  goalId: string,
  accountIds: string[],
): Promise<void> => {
  if (accountIds.length === 0) return;
  await d.insert(s.goalAccounts).values(
    accountIds.map((accountId, position) => ({ goalId, accountId, position })),
  );
};

const insertGoalConfig = async (
  d: Pick<Db, 'insert'>,
  goalId: string,
  input: GoalCreate,
  prepared: PreparedGoal,
): Promise<void> => {
  switch (input.type) {
    case 'financial-independence':
      await d.insert(s.financialIndependenceGoals).values({
        goalId,
        goalType: input.type,
        basis: input.basis,
        bufferPct: input.bufferPct,
        windowMonths: input.windowMonths,
        hourlyRateCents: input.hourlyRate === null ? null : toCents(input.hourlyRate),
        hoursPerWeek: input.hoursPerWeek,
      });
      if (input.essentialCosts.length > 0) {
        await d.insert(s.baselineItems).values(
          input.essentialCosts.map((cost, sort) => ({
            goalId,
            label: cost.label,
            monthlyCents: toCents(cost.monthly),
            sort,
          })),
        );
      }
      return;
    case 'emergency-fund':
      await d.insert(s.emergencyFundGoals).values({
        goalId,
        goalType: input.type,
        monthlyEssentialsCents: toCents(input.monthlyEssentials),
        coverageMonths: input.coverageMonths,
        currency: requiredGoalField(prepared.currency, goalId, 'currency'),
      });
      await insertGoalAccounts(d, goalId, input.accountIds);
      return;
    case 'savings-balance':
      await d.insert(s.savingsBalanceGoals).values({
        goalId,
        goalType: input.type,
        targetCents: toCents(input.target),
        currency: requiredGoalField(prepared.currency, goalId, 'currency'),
      });
      await insertGoalAccounts(d, goalId, input.accountIds);
      return;
    case 'debt-payoff':
      await d.insert(s.debtPayoffGoals).values({
        goalId,
        goalType: input.type,
        accountId: input.accountId,
        startingDebtCents: requiredGoalField(
          prepared.startingDebtCents,
          goalId,
          'starting debt',
        ),
        targetDebtCents: toCents(input.targetDebt),
        currency: requiredGoalField(prepared.currency, goalId, 'currency'),
      });
      return;
    case 'monthly-income':
      await d.insert(s.monthlyIncomeGoals).values({
        goalId,
        goalType: input.type,
        targetMonthlyCents: toCents(input.target),
        incomeScope: input.incomeScope,
        windowMonths: input.windowMonths,
        baseCurrency: prepared.baseCurrency,
      });
      return;
    case 'savings-rate':
      await d.insert(s.savingsRateGoals).values({
        goalId,
        goalType: input.type,
        targetBasisPoints: Math.round(input.targetPercent * 100),
        incomeScope: input.incomeScope,
        windowMonths: input.windowMonths,
      });
      return;
    case 'category-spending-limit':
      await d.insert(s.categorySpendingGoals).values({
        goalId,
        goalType: input.type,
        category: input.category,
        monthlyLimitCents: toCents(input.monthlyLimit),
        baseCurrency: prepared.baseCurrency,
      });
  }
};

const replaceGoalConfig = async (
  d: GoalWriteDb,
  goalId: string,
  input: GoalCreate,
  prepared: PreparedGoal,
): Promise<void> => {
  switch (input.type) {
    case 'financial-independence':
      await d
        .update(s.financialIndependenceGoals)
        .set({
          basis: input.basis,
          bufferPct: input.bufferPct,
          windowMonths: input.windowMonths,
          hourlyRateCents: input.hourlyRate === null ? null : toCents(input.hourlyRate),
          hoursPerWeek: input.hoursPerWeek,
        })
        .where(eq(s.financialIndependenceGoals.goalId, goalId));
      await d.delete(s.baselineItems).where(eq(s.baselineItems.goalId, goalId));
      if (input.essentialCosts.length > 0) {
        await d.insert(s.baselineItems).values(
          input.essentialCosts.map((cost, sort) => ({
            goalId,
            label: cost.label,
            monthlyCents: toCents(cost.monthly),
            sort,
          })),
        );
      }
      return;
    case 'emergency-fund':
      await d
        .update(s.emergencyFundGoals)
        .set({
          monthlyEssentialsCents: toCents(input.monthlyEssentials),
          coverageMonths: input.coverageMonths,
          currency: requiredGoalField(prepared.currency, goalId, 'currency'),
        })
        .where(eq(s.emergencyFundGoals.goalId, goalId));
      await d.delete(s.goalAccounts).where(eq(s.goalAccounts.goalId, goalId));
      await insertGoalAccounts(d, goalId, input.accountIds);
      return;
    case 'savings-balance':
      await d
        .update(s.savingsBalanceGoals)
        .set({
          targetCents: toCents(input.target),
          currency: requiredGoalField(prepared.currency, goalId, 'currency'),
        })
        .where(eq(s.savingsBalanceGoals.goalId, goalId));
      await d.delete(s.goalAccounts).where(eq(s.goalAccounts.goalId, goalId));
      await insertGoalAccounts(d, goalId, input.accountIds);
      return;
    case 'debt-payoff':
      await d
        .update(s.debtPayoffGoals)
        .set({ targetDebtCents: toCents(input.targetDebt) })
        .where(eq(s.debtPayoffGoals.goalId, goalId));
      return;
    case 'monthly-income':
      await d
        .update(s.monthlyIncomeGoals)
        .set({
          targetMonthlyCents: toCents(input.target),
          incomeScope: input.incomeScope,
          windowMonths: input.windowMonths,
          baseCurrency: prepared.baseCurrency,
        })
        .where(eq(s.monthlyIncomeGoals.goalId, goalId));
      return;
    case 'savings-rate':
      await d
        .update(s.savingsRateGoals)
        .set({
          targetBasisPoints: Math.round(input.targetPercent * 100),
          incomeScope: input.incomeScope,
          windowMonths: input.windowMonths,
        })
        .where(eq(s.savingsRateGoals.goalId, goalId));
      return;
    case 'category-spending-limit':
      await d
        .update(s.categorySpendingGoals)
        .set({
          category: input.category,
          monthlyLimitCents: toCents(input.monthlyLimit),
          baseCurrency: prepared.baseCurrency,
        })
        .where(eq(s.categorySpendingGoals.goalId, goalId));
  }
};

export async function createGoal(input: GoalCreate, now = new Date()): Promise<GoalRecord> {
  const id = crypto.randomUUID();
  const stamp = now.toISOString();
  const today = stamp.slice(0, 10);
  await getDb().transaction(async (tx) => {
    const prepared = await prepareGoalWrite(tx, input, today);
    await tx.insert(s.goals).values({
      id,
      type: input.type,
      name: input.name,
      targetDate: 'targetDate' in input ? input.targetDate : null,
      createdAt: stamp,
      updatedAt: stamp,
    });
    await insertGoalConfig(tx, id, input, prepared);
  });
  return requiredGoalField(await getGoal(id), id, 'stored row');
}

export type GoalReplaceResult =
  | { ok: true; goal: GoalRecord }
  | { ok: false; reason: 'not-found' | 'type-mismatch' };

export async function replaceGoal(
  id: string,
  input: GoalCreate,
  now = new Date(),
): Promise<GoalReplaceResult> {
  const stamp = now.toISOString();
  const today = stamp.slice(0, 10);
  const result = await getDb().transaction(
    async (tx): Promise<'not-found' | 'type-mismatch' | null> => {
      const rows = await goalRowsOn(tx, id);
      const existing = (await recordsFromGoalRows(tx, rows))[0];
      if (!existing) return 'not-found';
      if (existing.type !== input.type) return 'type-mismatch';
      const prepared = await prepareGoalWrite(tx, input, today, existing);
      await tx
        .update(s.goals)
        .set({
          name: input.name,
          targetDate: 'targetDate' in input ? input.targetDate : null,
          updatedAt: stamp,
        })
        .where(eq(s.goals.id, id));
      await replaceGoalConfig(tx, id, input, prepared);
      return null;
    },
  );
  if (result) return { ok: false, reason: result };
  return { ok: true, goal: requiredGoalField(await getGoal(id), id, 'stored row') };
}

export async function deleteGoal(id: string): Promise<boolean> {
  const rows = await getDb()
    .delete(s.goals)
    .where(eq(s.goals.id, id))
    .returning({ id: s.goals.id });
  return rows.length > 0;
}

const LEGACY_FINANCIAL_INDEPENDENCE_GOAL_ID = '00000000-0000-4000-8000-000000000001';

export interface BackupData {
  format: 'finto-backup';
  version: 1 | 2;
  exportedAt: string;
  tables: Record<string, unknown[]>;
}

/** Every user table, in the order restore inserts them. */
const BACKUP_TABLES = {
  accounts: s.accounts,
  // before transactions: import_id points at it, and restore inserts in this order
  imports: s.imports,
  transactions: s.transactions,
  fx_rates: s.fxRates,
  category_rules: s.categoryRules,
  transfer_rules: s.transferRules,
  recurring_ignores: s.recurringIgnores,
  goals: s.goals,
  financial_independence_goals: s.financialIndependenceGoals,
  emergency_fund_goals: s.emergencyFundGoals,
  savings_balance_goals: s.savingsBalanceGoals,
  debt_payoff_goals: s.debtPayoffGoals,
  monthly_income_goals: s.monthlyIncomeGoals,
  savings_rate_goals: s.savingsRateGoals,
  category_spending_goals: s.categorySpendingGoals,
  goal_accounts: s.goalAccounts,
  baseline_items: s.baselineItems,
  income_sources: s.incomeSources,
  settings: s.settings,
  meta: s.meta,
  analytics_charts: s.analyticsCharts,
} as const;

const IDENTITY_TABLES = new Set(['category_rules', 'transfer_rules', 'baseline_items']);

export async function exportBackup(): Promise<BackupData> {
  return getDb().transaction(
    async (tx) => {
      const tables: Record<string, unknown[]> = {};
      for (const [name, table] of Object.entries(BACKUP_TABLES)) {
        tables[name] = (await tx.select().from(table)) as Record<string, unknown>[];
      }
      return {
        format: 'finto-backup' as const,
        version: 2 as const,
        exportedAt: new Date().toISOString(),
        tables,
      };
    },
    { isolationLevel: 'repeatable read' },
  );
}

/**
 * The envelope. Row contents are checked separately, per table, against the real
 * columns - see sanitizeRow: the shape of a row depends on which table it is, and
 * a restore file is the one place where a user hands us raw rows to insert.
 */
const backupEnvelope = z.object({
  format: z.literal('finto-backup', {
    error: 'not a Finto backup file (expected JSON with format: "finto-backup")',
  }),
  version: z.union([z.literal(1), z.literal(2)], {
    error: (issue) => `unsupported backup version: ${String(issue.input)}`,
  }),
  exportedAt: z.string().optional(),
  tables: z.record(z.string(), z.unknown(), { error: 'backup file has no tables' }),
});

export function parseBackup(input: unknown): BackupData {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('not a Finto backup file (expected JSON with format: "finto-backup")');
  }
  const parsed = backupEnvelope.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'malformed backup file');
  }
  for (const [name, rows] of Object.entries(parsed.data.tables)) {
    if (!Array.isArray(rows)) throw new Error(`backup table ${name} is not an array`);
  }
  return { exportedAt: '', ...parsed.data } as BackupData;
}

const GOAL_BACKUP_TABLES = [
  'goals',
  'financial_independence_goals',
  'emergency_fund_goals',
  'savings_balance_goals',
  'debt_payoff_goals',
  'monthly_income_goals',
  'savings_rate_goals',
  'category_spending_goals',
  'goal_accounts',
  'baseline_items',
] as const;

const legacyNumber = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;

const migrateLegacyBackup = (data: BackupData): BackupData => {
  if (data.version === 2) {
    for (const name of GOAL_BACKUP_TABLES) {
      if (!(name in data.tables)) throw new Error(`backup is missing required goal table ${name}`);
    }
    return data;
  }
  if (GOAL_BACKUP_TABLES.some((name) => name !== 'baseline_items' && name in data.tables)) {
    throw new Error('backup version 1 contains unsupported goal tables');
  }

  const tables = Object.fromEntries(
    Object.entries(data.tables).map(([name, rows]) => [name, [...rows]]),
  );
  for (const name of GOAL_BACKUP_TABLES) tables[name] = [];

  const records = (name: string): Record<string, unknown>[] =>
    (data.tables[name] ?? []).map((row) => {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) {
        throw new Error(`${name}: a row is not an object`);
      }
      return row as Record<string, unknown>;
    });
  const legacyMeta = records('meta');
  const legacySettingsRow = legacyMeta.find((row) => row.key === 'settings');
  let settings: Record<string, unknown> = {};
  if (legacySettingsRow !== undefined) {
    if (typeof legacySettingsRow.value !== 'string') {
      throw new Error('meta.settings: expected a JSON string');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(legacySettingsRow.value);
    } catch {
      throw new Error('meta.settings: invalid JSON');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('meta.settings: expected a JSON object');
    }
    settings = parsed as Record<string, unknown>;
    for (const key of ['bufferPct', 'windowMonths', 'hoursCapPerWeek'] as const) {
      if (key in settings && (typeof settings[key] !== 'number' || !Number.isFinite(settings[key]))) {
        throw new Error(`meta.settings.${key}: expected a finite number`);
      }
    }
    if (
      'hourlyRate' in settings &&
      settings.hourlyRate !== null &&
      (typeof settings.hourlyRate !== 'number' || !Number.isFinite(settings.hourlyRate))
    ) {
      throw new Error('meta.settings.hourlyRate: expected a finite number or null');
    }
    if (
      'goalMode' in settings &&
      settings.goalMode !== 'baseline' &&
      settings.goalMode !== 'lifestyle'
    ) {
      throw new Error('meta.settings.goalMode: expected baseline or lifestyle');
    }
  }

  const transactions = data.tables.transactions ?? [];
  const baseline = records('baseline_items');
  const budgets = records('budgets');
  const hasLegacyGoal =
    transactions.length > 0 || legacySettingsRow !== undefined || baseline.length > 0 || budgets.length > 0;
  const stamp = Number.isNaN(new Date(data.exportedAt).getTime())
    ? new Date().toISOString()
    : new Date(data.exportedAt).toISOString();
  const baseCurrency =
    records('settings').find((row) => row.key === 'base_currency')?.value ?? 'EUR';

  if (hasLegacyGoal) {
    const bufferPct = legacyNumber(settings.bufferPct, 10, 0, 100);
    const windowMonths = Math.round(legacyNumber(settings.windowMonths, 6, 1, 24));
    const hourlyRate =
      settings.hourlyRate === null
        ? null
        : legacyNumber(settings.hourlyRate, 0, 0, 10_000) || null;
    const hoursPerWeek = legacyNumber(settings.hoursCapPerWeek, 20, 0.01, 168);
    tables.goals.push({
      id: LEGACY_FINANCIAL_INDEPENDENCE_GOAL_ID,
      type: 'financial-independence',
      name: 'Financial independence',
      targetDate: null,
      createdAt: stamp,
      updatedAt: stamp,
    });
    tables.financial_independence_goals.push({
      goalId: LEGACY_FINANCIAL_INDEPENDENCE_GOAL_ID,
      goalType: 'financial-independence',
      basis: settings.goalMode === 'lifestyle' ? 'current-spending' : 'essential-costs',
      bufferPct,
      windowMonths,
      hourlyRateCents: hourlyRate === null ? null : toCents(hourlyRate),
      hoursPerWeek,
    });
    tables.baseline_items = baseline.map((row) => ({
      ...row,
      goalId: LEGACY_FINANCIAL_INDEPENDENCE_GOAL_ID,
    }));
  }

  for (const budget of budgets) {
    if (
      typeof budget.category !== 'string' ||
      budget.category.trim() === '' ||
      typeof budget.monthlyCents !== 'number' ||
      !Number.isSafeInteger(budget.monthlyCents) ||
      budget.monthlyCents <= 0
    ) {
      throw new Error('budgets: invalid category or monthly cents');
    }
    const id = `legacy-budget-${crypto.createHash('md5').update(budget.category).digest('hex')}`;
    tables.goals.push({
      id,
      type: 'category-spending-limit',
      name: `${budget.category.replace(/-/g, ' ')} spending limit`,
      targetDate: null,
      createdAt: stamp,
      updatedAt: stamp,
    });
    tables.category_spending_goals.push({
      goalId: id,
      goalType: 'category-spending-limit',
      category: budget.category,
      monthlyLimitCents: budget.monthlyCents,
      baseCurrency: typeof baseCurrency === 'string' ? baseCurrency : 'EUR',
    });
  }

  tables.meta = legacyMeta.filter((row) => row.key !== 'settings');
  delete tables.budgets;
  return { ...data, version: 2, tables };
};

const NOT_RESTORABLE_STATUS = new Set<ImportStatus>(['awaiting_confirmation']);

const RESTORED_UNCONFIRMABLE =
  'restored from a backup: this import was still awaiting confirmation when the backup was taken, and a backup carries no staged rows, so it can never be confirmed here';

/**
 * The one value a restore rewrites rather than copies. It cannot live in
 * sanitizeRow, which strips columns and rejects types and never edits a value.
 */
function coerceRestoredImport(row: Record<string, unknown>): Record<string, unknown> {
  if (!NOT_RESTORABLE_STATUS.has(row.status as ImportStatus)) return row;
  return {
    ...row,
    status: 'discarded' satisfies ImportStatus,
    errorDetail: RESTORED_UNCONFIRMABLE.slice(0, ERROR_DETAIL_MAX),
  };
}

function sanitizeRow(
  table: (typeof BACKUP_TABLES)[keyof typeof BACKUP_TABLES],
  row: unknown,
  tableName: string,
): Record<string, unknown> {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(`${tableName}: a row is not an object`);
  }
  const columns: Record<string, { notNull: boolean; dataType: string } | undefined> =
    getTableColumns(table);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    const column = columns[key];
    if (!column) continue; // unknown column
    if (value === null) {
      if (column.notNull) throw new Error(`${tableName}.${key}: null in a required column`);
      out[key] = null;
      continue;
    }
    // widened: each column of the union has its own literal dataType, and we need
    // to compare all of them against the same runtime typeof
    const dataType: string = column.dataType;
    if (typeof value !== dataType) {
      throw new Error(
        `${tableName}.${key}: expected ${dataType}, got ${Array.isArray(value) ? 'array' : typeof value}`,
      );
    }
    if (dataType === 'number' && !Number.isFinite(value)) {
      throw new Error(`${tableName}.${key}: not a finite number`);
    }
    out[key] = value;
  }
  return out;
}

/**
 * After restoring, the caller runs a full reclassification - same as after any bulk
 * import.
 */
export async function restoreBackup(data: BackupData): Promise<{ tables: number; rows: number }> {
  const provided = new Set(Object.keys(data.tables));
  const migrated = migrateLegacyBackup(data);
  let tables = 0;
  let rows = 0;
  await getDb().transaction(async (tx) => {
    const goalTables = new Set<string>(GOAL_BACKUP_TABLES);
    for (const name of [...GOAL_BACKUP_TABLES].reverse()) {
      await tx.execute(sql`DELETE FROM ${sql.raw(name)}`);
    }
    for (const [name, table] of Object.entries(BACKUP_TABLES)) {
      const incoming = migrated.tables[name];
      if (!incoming && !goalTables.has(name)) continue;
      if (!goalTables.has(name)) await tx.execute(sql`DELETE FROM ${sql.raw(name)}`);
      const valuesIn = incoming ?? [];
      const dropId = IDENTITY_TABLES.has(name);
      const values = valuesIn.map((row) => {
        const clean = sanitizeRow(table, row, name);
        const { id, ...rest } = name === 'imports' ? coerceRestoredImport(clean) : clean;
        return dropId ? rest : { ...rest, id };
      });
      for (const chunk of chunked(values, 500)) {
        await tx.insert(table).values(chunk as never[]);
      }
      if (provided.has(name) || valuesIn.length > 0) tables++;
      rows += valuesIn.length;
    }
  });
  return { tables, rows };
}
