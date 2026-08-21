/**
 * The data layer: every query the app makes.
 *
 * EVERY query in this module is scoped to the current workspace (see
 * ./workspace.ts): the workspace id comes from AsyncLocalStorage, set by the
 * session middleware for requests and by the scheduler for background jobs.
 * A call outside a workspace context throws instead of leaking data.
 *
 * PG gotchas encoded here so callers never see them:
 *  - SUM()/COUNT() return bigint/numeric and the driver hands them over as
 *    strings - every aggregate is wrapped in Number() at the boundary;
 *  - unquoted SQL aliases fold to lowercase - camelCase aliases are quoted;
 *  - ROUND(double) is round-half-to-even - money rounding casts to ::numeric
 *    first, which rounds half away from zero like toCents() in money.ts.
 */
import crypto from 'crypto';
import path from 'path';
import { and, asc, eq, getTableColumns, inArray, sql, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import { z } from 'zod';
import { type Category, recurringKey } from '../categorizer';
import { config } from '../config';
import { DocumentRef, deleteDocument, knowsKeyVersion } from '../documents';
import { causeChain, logDb } from '../logger';
import { fromCents, fromCentsOrUndefined, toCents, toCentsOrNull } from '../money';
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
  COMPUTED_PREFIX,
  computedDedupKey,
  computedGroupPrefix,
  computedKeyOrdinal,
  dedupGroup,
  parkedDedupKey,
  withOrdinal,
} from './dedup';
import * as s from './schema';
import { currentWorkspaceId } from './workspace';

export { currentWorkspaceId, runWithWorkspace, setWorkspaceFallback } from './workspace';

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

export async function connectDatabase(): Promise<void> {
  const pool = new Pool({ connectionString: config.databaseUrl });
  const instance = drizzle(pool, { schema: s });
  await migrate(instance, { migrationsFolder: MIGRATIONS_DIR });
  initDb(instance);
  logDb.info('database connected, migrations applied');
}

export async function seedDefaults(): Promise<void> {
  const w = currentWorkspaceId();
  const d = getDb();
  const isOwner = (await listWorkspaceIds())[0] === w;
  const ownerNames = isOwner ? config.ownerNames : [];
  const familyNames = isOwner ? config.familyNames : [];
  await d
    .insert(s.incomeSources)
    .values([
      { workspaceId: w, id: 'salary', label: 'Salary', kind: 'own', patterns: '[]', sort: 0, builtin: true },
      {
        workspaceId: w,
        id: 'family',
        label: 'Family support',
        kind: 'external',
        patterns: JSON.stringify(familyNames),
        sort: 1,
        builtin: true,
      },
      { workspaceId: w, id: 'other', label: 'Other', kind: 'own', patterns: '[]', sort: 2, builtin: true },
    ])
    .onConflictDoNothing();
  await d
    .insert(s.settings)
    .values([
      { workspaceId: w, key: 'base_currency', value: config.baseCurrency },
      { workspaceId: w, key: 'owner_names', value: JSON.stringify(ownerNames) },
    ])
    .onConflictDoNothing();
}

export async function listWorkspaceIds(): Promise<string[]> {
  const rows = await getDb()
    .select({ id: s.organization.id })
    .from(s.organization)
    .orderBy(asc(s.organization.createdAt), asc(s.organization.id));
  return rows.map((r) => r.id);
}

export async function listUserWorkspaceIds(userId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ id: s.member.organizationId })
    .from(s.member)
    .where(eq(s.member.userId, userId))
    .orderBy(asc(s.member.createdAt), asc(s.member.id));
  return rows.map((r) => r.id);
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

/** The workspace filter every raw SQL query carries. Built at call time - the id lives in ALS. */
const WS = (): SQL => sql`workspace_id = ${currentWorkspaceId()}`;

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
const VISIBLE_ACCOUNT = (): SQL =>
  sql`account_id NOT IN (SELECT id FROM accounts WHERE hidden AND workspace_id = ${currentWorkspaceId()})`;

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
      WHERE transactions.account_id = ${accountId} AND transactions.${WS()})`;

const HOLDS_STAGED_ROWS = (accountId: string): SQL =>
  sql`EXISTS (SELECT 1 FROM staged_transactions
      WHERE staged_transactions.account_id = ${accountId} AND staged_transactions.${WS()})`;

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
    .where(and(eq(s.settings.workspaceId, currentWorkspaceId()), eq(s.settings.key, key)));
  return rows[0]?.value;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await getDb()
    .insert(s.settings)
    .values({ workspaceId: currentWorkspaceId(), key, value })
    .onConflictDoUpdate({ target: [s.settings.workspaceId, s.settings.key], set: { value } });
}

export async function currentBaseCurrency(): Promise<string> {
  return (await getSetting('base_currency')) ?? config.baseCurrency;
}

export async function getMeta(key: string): Promise<string | undefined> {
  const rows = await getDb()
    .select()
    .from(s.meta)
    .where(and(eq(s.meta.workspaceId, currentWorkspaceId()), eq(s.meta.key, key)));
  return rows[0]?.value;
}

export async function setMeta(key: string, value: string): Promise<void> {
  await getDb()
    .insert(s.meta)
    .values({ workspaceId: currentWorkspaceId(), key, value })
    .onConflictDoUpdate({ target: [s.meta.workspaceId, s.meta.key], set: { value } });
}

export async function upsertAccount(a: Account): Promise<void> {
  await upsertAccountOn(getDb(), a);
}

export async function upsertAccountOn(d: Db, a: Account): Promise<void> {
  await d
    .insert(s.accounts)
    .values({
      workspaceId: currentWorkspaceId(),
      id: a.id,
      provider: a.provider,
      name: a.name,
      currency: a.currency,
      balanceCents: toCents(a.balance),
      iban: a.iban ?? null,
    })
    .onConflictDoUpdate({
      target: [s.accounts.workspaceId, s.accounts.id],
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
    .where(and(eq(s.accounts.workspaceId, currentWorkspaceId()), eq(s.accounts.id, id)));
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
      WHERE account_id = ${accountId} AND ${WS()}
    ) WHERE id = ${accountId} AND ${WS()}`);
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
  const ws = eq(s.accounts.workspaceId, currentWorkspaceId());
  const rows = await getDb()
    .select()
    .from(s.accounts)
    .where(includeHidden ? ws : and(ws, eq(s.accounts.hidden, false)));
  return rows
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name))
    .map(rowToAccount);
}

export async function getAccount(id: string): Promise<Account | undefined> {
  const rows = await getDb()
    .select()
    .from(s.accounts)
    .where(and(eq(s.accounts.workspaceId, currentWorkspaceId()), eq(s.accounts.id, id)));
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
      and(
        eq(s.accounts.workspaceId, currentWorkspaceId()),
        sql`lower(${s.accounts.name}) = lower(${name})`,
      ),
    );
  return rows[0] ? rowToAccount(rows[0]) : undefined;
}

declare const resolved: unique symbol;

/**
 * An account id proved to be a row of this workspace. The brand is the point: this
 * type cannot be produced without writing the assertion that says so, and both
 * StagedAccount.id and AccountScope.id require one - so a second way of turning a
 * request into an id is a compile error rather than a review finding. A name was an
 * id once, through a slug function, and two callers deriving it differently put a
 * statement's rows in an account its own summary did not name.
 *
 * Two producers, each branding an id it has just read out of this workspace's own
 * rows and never a string that arrived off the wire unread: resolveUploadAccount
 * below, for an upload that picks its account by id, and app.ts's summaryScope, for
 * a summary that asks about one account.
 *
 * Phantom, and it stops at the data layer: nothing that crosses the wire carries it
 * (ImportRecord.accountId, ImportSummary.accountId and Account.id stay plain
 * strings), because the client mirrors plain objects.
 */
export type ResolvedAccountId = string & { readonly [resolved]: true };

export type UploadAccount =
  | { ok: true; account: StagedAccount }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'hidden' };

export async function resolveUploadAccount(id: string): Promise<UploadAccount> {
  const rows = await getDb()
    .select()
    .from(s.accounts)
    .where(and(eq(s.accounts.workspaceId, currentWorkspaceId()), eq(s.accounts.id, id)));
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
        workspaceId: currentWorkspaceId(),
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
    sql`SELECT ${HOLDS_TRANSACTIONS(id)} AS blocked FROM accounts WHERE id = ${id} AND ${WS()}`,
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
          eq(s.accounts.workspaceId, currentWorkspaceId()),
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
 * Inserts a batch of transactions, silently skipping ones already there. Returns
 * the number of genuinely new rows.
 *
 * Identity and deduplication are two different things here: `id` is a fresh UUID
 * that never changes, and duplicates are caught by the
 * UNIQUE (workspace_id, account_id, dedup_key) index instead.
 *
 * A source with a stable reference of its own can supply it as dedupKey; none
 * does today, so every key is computed here (the format, and why the
 * description is not part of it, are in ./dedup.ts).
 *
 * Ordinals for computed keys are numbered from 1 within each group, over the
 * whole batch (before chunking - restarting per chunk would collide the second
 * chunk's rows with the first's and drop them). Numbering from 1 rather than
 * continuing from what the database already holds is what makes re-importing
 * idempotent: existing ordinals in a group are dense 1..E, so of k incoming rows
 * the first min(E, k) collide and are skipped, and only a genuinely larger k
 * inserts anything. The database does the comparison, via the unique index.
 *
 * This is exact as long as a batch is complete for every group it touches - all
 * k rows of a day arrive in one call. Statement windows are whole days, so an
 * uploaded file is; a parser that hands over a file in pieces must accumulate
 * them before calling.
 *
 * A duplicate is skipped, never merged: the existing row keeps its description,
 * its category and the user's manual marks. Correcting facts on a re-parse is
 * the imports table's job, not this one's.
 *
 * importId is the provenance of the rows this call actually inserts, and only
 * those - a skipped duplicate keeps whatever import first wrote it (see
 * transactions.import_id in ./schema.ts).
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
  const w = currentWorkspaceId();
  const values: (typeof s.transactions.$inferInsert)[] = claimedKeys(txs).map(
    ({ tx: t, amountCents, dedupKey }) => {
      // transactions already in the base currency need no conversion - fill it now;
      // for the rest base_amount is filled by backfillBaseAmounts (fxrates.ts) after sync
      const isBase = t.currency === baseCurrency;
      return {
        workspaceId: w,
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
        target: [s.transactions.workspaceId, s.transactions.accountId, s.transactions.dedupKey],
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
  return {
    id: r.id,
    accountId: r.account_id,
    provider: r.provider as Transaction['provider'],
    amount: fromCents(r.amount_cents),
    fee: fromCentsOrUndefined(r.fee_cents),
    currency: r.currency,
    date: r.date,
    description: r.description,
    mcc: r.mcc ?? undefined,
    category: r.category_manual ?? r.category,
    categoryManual: r.category_manual !== null,
    transfer: r.transfer_manual ?? r.transfer,
    transferManual: r.transfer_manual,
    refund: r.refund,
    baseAmount: fromCentsOrUndefined(r.base_amount_cents),
    incomeSource:
      r.amount_cents > 0
        ? ((r.income_source_manual ?? r.income_source ?? 'other') as Transaction['incomeSource'])
        : undefined,
    incomeSourceManual: r.income_source_manual !== null,
    recurring: r.recurring,
    oneOff: r.one_off,
  };
}

export async function listTransactions(f: TxFilter): Promise<Transaction[]> {
  const where: SQL[] = [WS(), VISIBLE_ACCOUNT()];
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
 * The workspace arm's clause, and scopeSql below is the only thing that may name it:
 * per account it drops a real transaction from its own account's total - an import
 * short by a row, in the account's own currency, that nothing reports.
 */
const CONVERTED = sql`base_amount_cents IS NOT NULL`;

export interface WorkspaceScope {
  kind: 'workspace';
}

export interface AccountScope {
  kind: 'account';
  id: ResolvedAccountId;
  currency: string;
}

export type SummaryScope = WorkspaceScope | AccountScope;

/**
 * The rows a scope is about and the column its money lives in - together, from one
 * value, because picking the filter of one arm and the column of the other is what
 * puts two currencies in one sum. Every summary query below goes through this and
 * none of them names CONVERTED, VISIBLE_ACCOUNT() or base_amount_cents itself.
 *
 * NOT_TRANSFER is in the WHERE on both arms (transfers between your own accounts
 * are neither income nor spending, per account exactly as workspace-wide). The one
 * exception is accountMonths, which needs the month to survive even when every row
 * in it is a transfer and therefore spells its own WHERE - see the note there.
 *
 * The workspace clause is table-qualified: summaryIncomeBySource joins
 * income_sources, which has a workspace_id of its own, and an unqualified one is
 * ambiguous there. Qualifying costs the other four nothing.
 */
const scopeSql = (scope: SummaryScope): { where: SQL; money: SQL } =>
  scope.kind === 'account'
    ? {
        where: sql`transactions.${WS()} AND account_id = ${scope.id} AND ${NOT_TRANSFER}`,
        money: sql`amount_cents`,
      }
    : {
        where: sql`transactions.${WS()} AND ${NOT_TRANSFER} AND ${VISIBLE_ACCOUNT()} AND ${CONVERTED}`,
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

const INCOME_SOURCE = sql`COALESCE(income_source_manual, income_source, 'other')`;

const IS_EXTERNAL = (): SQL =>
  sql`${INCOME_SOURCE} IN (SELECT id FROM income_sources WHERE kind = 'external' AND workspace_id = ${currentWorkspaceId()})`;

export async function summaryIncomeBySource(
  scope: SummaryScope,
  from: string,
  to: string,
): Promise<IncomeSourceTotal[]> {
  const { where, money } = scopeSql(scope);
  const rows = await rowsOf<Omit<IncomeSourceTotal, 'total'> & { total_cents: string }>(sql`
    SELECT ${INCOME_SOURCE} AS source,
           COALESCE(i.label, ${INCOME_SOURCE}) AS label,
           COALESCE(i.kind, 'own') AS kind,
           SUM(${money}) AS total_cents
    FROM transactions
    LEFT JOIN income_sources i
      ON i.id = ${INCOME_SOURCE} AND i.workspace_id = transactions.workspace_id
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

async function workspaceMonths(from: string, to: string): Promise<MonthTotals[]> {
  const { where, money } = scopeSql({ kind: 'workspace' });
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
    WHERE transactions.${WS()} AND account_id = ${scope.id} AND date >= ${from} AND date <= ${to}
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
  scope: WorkspaceScope,
  from: string,
  to: string,
): Promise<MonthTotals[]>;
export function summaryMonthlyTotals(
  scope: AccountScope,
  from: string,
  to: string,
): Promise<AccountMonthTotals[]>;
export function summaryMonthlyTotals(scope: SummaryScope, from: string, to: string) {
  return scope.kind === 'account' ? accountMonths(scope, from, to) : workspaceMonths(from, to);
}

export async function avgMonthlyByCategory(
  from: string,
  to: string,
  months: number,
): Promise<CategorySummary[]> {
  if (months <= 0) return [];
  const { where, money } = scopeSql({ kind: 'workspace' });
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
    WHERE ${WS()} AND account_id = ${scope.id} AND currency <> ${scope.currency}
    ORDER BY 1`);
  return rows.map((r) => r.currency);
}

// ---------- imports (provenance) ----------

type ImportRow = typeof s.imports.$inferSelect;

export type ImportSourceType = ImportRow['sourceType'];
export type ImportStatus = ImportRow['status'];

export interface ImportRecord {
  id: string;
  fileHash: string;
  sourceType: ImportSourceType;
  originalFilename: string | null;
  accountName: string | null;
  /**
   * The account the rows are going to, resolved at staging. NULL wherever
   * accountName is, and it is the id and not the name that says where they landed:
   * a rename moves the account, never this row's accountName.
   */
  accountId: string | null;
  uploadedBy: string | null;
  uploadedAt: string;
  parserVersion: number;
  status: ImportStatus;
  rowsAccepted: number;
  rowsRejected: number;
  errorDetail: string | null;
  transactions: number;
  /**
   * Whether a document can be READ for this row, which is not whether bytes exist
   * (see imports.document_key_version): a restored row has its pointer stripped
   * while its statement is still on disk. The version itself never leaves the
   * server - it is a storage-layout detail, and a client that can read it is a
   * client that can be tempted to build a key.
   */
  documentAvailable: boolean;
}

export const ERROR_DETAIL_MAX = 500;

const rowToImport = (r: ImportRow & { transactions?: number }): ImportRecord => ({
  id: r.id,
  fileHash: r.fileHash,
  sourceType: r.sourceType,
  originalFilename: r.originalFilename,
  accountName: r.accountName,
  accountId: r.accountId,
  uploadedBy: r.uploadedBy,
  uploadedAt: r.uploadedAt,
  parserVersion: r.parserVersion,
  status: r.status,
  rowsAccepted: r.rowsAccepted,
  rowsRejected: r.rowsRejected,
  errorDetail: r.errorDetail,
  transactions: r.transactions ?? 0,
  documentAvailable: r.documentKeyVersion !== null,
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
        eq(s.imports.workspaceId, currentWorkspaceId()),
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
  uploadedBy?: string;
}): Promise<ImportRecord> {
  const rows = await getDb()
    .insert(s.imports)
    .values({
      workspaceId: currentWorkspaceId(),
      id: crypto.randomUUID(),
      fileHash: input.fileHash,
      sourceType: input.sourceType,
      originalFilename: input.originalFilename ?? null,
      uploadedBy: input.uploadedBy ?? null,
      uploadedAt: new Date().toISOString(),
      parserVersion: input.parserVersion,
      status: 'pending',
    })
    .returning();
  return rowToImport(rows[0]);
}

/**
 * The bytes are on disk: the row may now claim them. A separate write rather than
 * a field on createImport/failImport, because the put happens between the two - and
 * a FAILED import keeps its document, which is what makes a miss diagnosable.
 *
 * Never called before the put: a row claiming a document that is not there is the
 * state every read would have to distrust.
 */
export async function recordImportDocument(id: string, keyVersion: number): Promise<void> {
  await getDb()
    .update(s.imports)
    .set({ documentKeyVersion: keyVersion })
    .where(and(eq(s.imports.workspaceId, currentWorkspaceId()), eq(s.imports.id, id)));
}

/**
 * The row no longer claims a readable document. Called only AFTER the bytes are
 * gone: between the two, a crash leaves a row whose document throws on read, which
 * is loud and self-healing - the other order leaves a statement on disk that the
 * user has been told is deleted, and nothing revisits it.
 */
export async function clearImportDocument(id: string): Promise<void> {
  await getDb()
    .update(s.imports)
    .set({ documentKeyVersion: null })
    .where(and(eq(s.imports.workspaceId, currentWorkspaceId()), eq(s.imports.id, id)));
}

export interface ImportDocumentInfo {
  keyVersion: number | null;
  originalFilename: string | null;
  sourceType: ImportSourceType;
}

export async function getImportDocumentInfo(id: string): Promise<ImportDocumentInfo | undefined> {
  const rows = await getDb()
    .select({
      keyVersion: s.imports.documentKeyVersion,
      originalFilename: s.imports.originalFilename,
      sourceType: s.imports.sourceType,
    })
    .from(s.imports)
    .where(and(eq(s.imports.workspaceId, currentWorkspaceId()), eq(s.imports.id, id)));
  return rows[0];
}

export async function getImportDocumentRef(id: string): Promise<DocumentRef | undefined> {
  const rows = await getDb()
    .select({ fileHash: s.imports.fileHash, keyVersion: s.imports.documentKeyVersion })
    .from(s.imports)
    .where(and(eq(s.imports.workspaceId, currentWorkspaceId()), eq(s.imports.id, id)));
  const row = rows[0];
  if (!row || row.keyVersion === null) return undefined;
  return { importId: id, keyVersion: row.keyVersion, fileHash: row.fileHash };
}

export async function failImport(id: string, message: string): Promise<void> {
  const w = currentWorkspaceId();
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
      .where(and(eq(s.imports.workspaceId, w), eq(s.imports.id, id)));
    await tx
      .delete(s.stagedTransactions)
      .where(and(eq(s.stagedTransactions.workspaceId, w), eq(s.stagedTransactions.importId, id)));
  });
}

/** Counts over the whole filtered set, never over the page (see listImports). */
export interface ImportTotals {
  imports: number;
  documents: number;
  /**
   * Transactions those imports own (transactions.import_id, "first wrote"), which
   * is NOT "this account's transactions": a row no import owns is in neither.
   */
  transactions: number;
}

export interface ImportList {
  imports: ImportRecord[];
  totals: ImportTotals;
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
  const where: SQL[] = [WS()];
  // on presence, never on truthiness: '' is a filter that matches nothing, and must
  // not widen to the whole workspace at this layer either
  if (opts.accountId !== undefined) where.push(sql`account_id = ${opts.accountId}`);
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 100;
  const rows = await rowsOf<ImportListRow>(sql`
    WITH f AS (
      SELECT workspace_id AS "workspaceId", id, file_hash AS "fileHash",
             source_type AS "sourceType", original_filename AS "originalFilename",
             account_name AS "accountName", account_currency AS "accountCurrency",
             account_id AS "accountId", uploaded_by AS "uploadedBy",
             uploaded_at AS "uploadedAt", parser_version AS "parserVersion", status,
             rows_accepted AS "rowsAccepted", rows_rejected AS "rowsRejected",
             error_detail AS "errorDetail",
             document_key_version AS "documentKeyVersion",
             (SELECT COUNT(*) FROM transactions t
               WHERE t.workspace_id = imports.workspace_id AND t.import_id = imports.id)
               AS "ownTx"
      FROM imports WHERE ${sql.join(where, sql` AND `)})
    SELECT f.*,
           COUNT(*) OVER () AS "totalImports",
           COUNT(*) FILTER (WHERE "documentKeyVersion" IS NOT NULL) OVER () AS "totalDocuments",
           SUM("ownTx") OVER () AS "totalTransactions"
    FROM f ORDER BY "uploadedAt" DESC, id DESC LIMIT ${limit}`);
  const first = rows[0];
  // no row at all is an empty filtered set, not a page that fell off the end: there
  // is no offset and no cursor here, so the first page is the only page there is to
  // miss. Whatever adds one has to take the totals from somewhere other than row 0.
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
      and(
        eq(s.transactions.workspaceId, currentWorkspaceId()),
        eq(s.transactions.importId, importId),
      ),
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
  const w = currentWorkspaceId();
  const values = txs.map((t, i) => ({
    workspaceId: w,
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
      .where(and(eq(s.imports.workspaceId, w), eq(s.imports.id, id)));
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
        ON t.account_id = k.account_id AND t.dedup_key = k.dedup_key
      WHERE t.${WS()}`);
    taken += Number(rows[0].n);
  }
  return pairs.length - taken;
}

/**
 * Why a superseded import is `discarded`. The third producer of that status, and
 * without a sentence here the second one would be indistinguishable from the first:
 * on a `discarded` row NULL means the user declined it, so a superseded row left
 * empty would have item 10's screen telling someone they rejected an import they
 * never saw. It is also the only place a copy the user displaced can be told apart
 * from one they refused, which the retention purge will want.
 */
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
  const w = currentWorkspaceId();
  const rows = await getDb().transaction(async (tx) => {
    const mine = await tx
      .select({ uploadedAt: s.imports.uploadedAt })
      .from(s.imports)
      .where(and(eq(s.imports.workspaceId, w), eq(s.imports.id, exceptId)));
    if (!mine[0]) throw new Error(`import ${exceptId} is not in this workspace`);
    const claimed = await tx
      .update(s.imports)
      .set({ status: 'discarded', errorDetail: SUPERSEDED_BY_REUPLOAD.slice(0, ERROR_DETAIL_MAX) })
      .where(
        and(
          eq(s.imports.workspaceId, w),
          eq(s.imports.fileHash, fileHash),
          eq(s.imports.status, 'awaiting_confirmation'),
          sql`(uploaded_at, id) < (${mine[0].uploadedAt}::text, ${exceptId}::text)`,
        ),
      )
      .returning({ id: s.imports.id, uploadedAt: s.imports.uploadedAt });
    for (const chunk of chunked(claimed, 100)) {
      await tx.delete(s.stagedTransactions).where(
        and(
          eq(s.stagedTransactions.workspaceId, w),
          inArray(
            s.stagedTransactions.importId,
            chunk.map((c) => c.id),
          ),
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
    .where(and(eq(s.imports.workspaceId, currentWorkspaceId()), eq(s.imports.id, id)));
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
  const w = currentWorkspaceId();
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
            eq(s.imports.workspaceId, w),
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
          and(eq(s.stagedTransactions.workspaceId, w), eq(s.stagedTransactions.importId, id)),
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
          .where(and(eq(s.accounts.workspaceId, w), eq(s.accounts.id, accountId)))
          .for('update')
      ).at(0);
      if (!holder) throw new AccountMissing();
      if (holder.hidden) throw new AccountRemoved();
      inserted = await insertTransactionsOn(tx, staged.map(stagedToNew), baseCurrency, id);
      await tx
        .delete(s.stagedTransactions)
        .where(
          and(eq(s.stagedTransactions.workspaceId, w), eq(s.stagedTransactions.importId, id)),
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
  const w = currentWorkspaceId();
  const claimed = await getDb().transaction(async (tx) => {
    const rows = await tx
      .update(s.imports)
      .set({ status: 'discarded' })
      .where(
        and(
          eq(s.imports.workspaceId, w),
          eq(s.imports.id, id),
          eq(s.imports.status, 'awaiting_confirmation'),
        ),
      )
      .returning({ id: s.imports.id });
    if (rows.length > 0) {
      await tx
        .delete(s.stagedTransactions)
        .where(
          and(eq(s.stagedTransactions.workspaceId, w), eq(s.stagedTransactions.importId, id)),
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
        WHERE ${WS()} AND import_id = ${importId}
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
 * rather than corrupting anything. Fail-safe, and acceptable while a workspace is
 * one person uploading files.
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
              ON t.account_id = g.account_id AND starts_with(t.dedup_key, g.prefix)
            WHERE t.${WS()}`,
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
        WHERE t.${WS()} AND t.id = v.id`);
    }
  }
}

/**
 * Deletes an import and, by the ON DELETE CASCADE on transactions.import_id, its
 * transactions. **This is the only sanctioned path that deletes a user's
 * transactions** - anything else that ever needs to must be as visible as this,
 * not a call buried in a helper.
 *
 * What it removes is exactly the rows this import first wrote: not another
 * import's, not another workspace's (the foreign key is composite), and not a
 * bank sync's (their import_id is NULL). It does not remove the account, whose
 * balance is recomputed afterwards.
 *
 * The ordinals of whatever survives in the affected groups are renumbered in the
 * same transaction - see renumberGroup for what a hole would do.
 *
 * It is also the only path that deletes a stored source document, for the same
 * reason and with the same visibility.
 */
export async function deleteImport(
  id: string,
): Promise<{ removed: number; accountIds: string[] } | undefined> {
  const w = currentWorkspaceId();
  const existing = await getDb()
    // the version is read for the diagnostic below only - never to decide whether
    // to delete the blob, which is unconditional (see deleteDocument)
    .select({ id: s.imports.id, keyVersion: s.imports.documentKeyVersion })
    .from(s.imports)
    .where(and(eq(s.imports.workspaceId, w), eq(s.imports.id, id)));
  if (!existing[0]) return undefined;

  const owned = await rowsOf<{ account_id: string; n: string }>(
    sql`SELECT account_id, COUNT(*) AS n FROM transactions
        WHERE ${WS()} AND import_id = ${id} GROUP BY account_id`,
  );
  const accountIds = owned.map((r) => r.account_id);
  const removed = owned.reduce((sum, r) => sum + Number(r.n), 0);

  await getDb().transaction(async (tx) => {
    const groups = await computedGroupsOf(tx, id);
    await tx
      .delete(s.imports)
      .where(and(eq(s.imports.workspaceId, w), eq(s.imports.id, id)));
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
    await deleteDocument(id);
  } catch (e) {
    logDb.error(
      { err: e },
      `import ${id} deleted, but its stored document was not removed: ${causeChain(e)} - remove it by hand`,
    );
  }
  const claimed = existing[0].keyVersion;
  if (claimed !== null && !knowsKeyVersion(claimed)) {
    logDb.error(
      `import ${id} deleted, but its document was written under key layout ${claimed}, which this server cannot address - remove it by hand`,
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

/**
 * Every exported table carrying BOTH an account and a workspace - exactly the
 * tables a deleted account leaves rows in. Derived from the schema module rather
 * than remembered, so a new one is a compile error at ACCOUNT_CASCADE instead of a
 * table nobody's delete reaches. There is no foreign key from any of them to
 * `accounts`, so this is the whole of the enumeration.
 *
 * Both conditions are load-bearing: `auth_account` has an accountId and a userId
 * and no workspaceId, and it is better-auth's, not an account of the user's.
 */
type AccountScoped = {
  [K in keyof typeof s]: (typeof s)[K] extends { accountId: unknown; workspaceId: unknown }
    ? K
    : never;
}[keyof typeof s];

const CASCADES_FROM_IMPORTS = Symbol('cascades from imports');

/**
 * The other kind of answer: rows that stay. A chart naming an account that is gone
 * is a state the client draws deliberately - the tab remains and says the account
 * is no longer here - so deleting the chart with the account would take a tab away
 * with nothing said, and blanking its account would silently turn one account's
 * chart into the whole workspace's under its old title.
 */
const OUTLIVES_THE_ACCOUNT = Symbol('outlives the account');

/**
 * What deleteAccount does to each of them, and `satisfies` rather than an
 * annotation: a missing key and an excess key are both compile errors, while each
 * statement keeps its own type at the call site. What it does NOT prove is that an
 * entry is executed - the body consumes these by name, in an order that is not
 * interchangeable - so a table added here and never called would compile.
 * ACCOUNT_CASCADE_TABLES is the other half of that, and the docstring is the rest.
 */
const ACCOUNT_CASCADE = {
  transactions: (id: string): SQL =>
    sql`DELETE FROM transactions WHERE ${WS()} AND account_id = ${id}`,
  imports: (id: string): SQL =>
    sql`DELETE FROM imports WHERE ${WS()} AND account_id = ${id}
        AND NOT ${HOLDS_STAGED_ROWS(id)} RETURNING id, document_key_version`,
  stagedTransactions: CASCADES_FROM_IMPORTS,
  transferRules: (id: string): SQL =>
    sql`DELETE FROM transfer_rules WHERE ${WS()} AND account_id = ${id}`,
  analyticsCharts: OUTLIVES_THE_ACCOUNT,
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
  let gone: { id: string; document_key_version: number | null }[] = [];
  let strayAccountIds: string[] = [];
  let strayImportIds: string[] = [];
  try {
    await getDb().transaction(async (tx) => {
      const [held] = await rowsVia<{ id: string }>(
        tx,
        sql`SELECT id FROM accounts WHERE ${WS()} AND id = ${id} FOR UPDATE`,
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
            WHERE t.${WS()} AND t.account_id <> ${id}
              AND t.import_id IN (
                SELECT i.id FROM imports i WHERE i.${WS()} AND i.account_id = ${id})`,
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

      gone = await rowsVia<{ id: string; document_key_version: number | null }>(
        tx,
        ACCOUNT_CASCADE.imports(id),
      );
      deleted.imports = gone.length;
      deleted.documents = gone.filter((r) => r.document_key_version !== null).length;

      // the checked premise, never insurance: renumberGroups moves rows through a
      // parking namespace and can trip the unique index against a concurrent
      // import, so an unnecessary call is a new way for a delete to fail
      if (groups.size > 0) await renumberGroups(tx, [...groups.values()]);

      deleted.transferRules = await execCountVia(tx, ACCOUNT_CASCADE.transferRules(id));

      const [removed] = await rowsVia<{ id: string }>(
        tx,
        sql`DELETE FROM accounts WHERE ${WS()} AND id = ${id}
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
      await deleteDocument(row.id);
    } catch (e) {
      logDb.error(
        { err: e },
        `import ${row.id} was deleted with account ${id}, but its stored document was not removed: ${causeChain(e)} - remove it by hand`,
      );
    }
    if (row.document_key_version !== null && !knowsKeyVersion(row.document_key_version)) {
      logDb.error(
        `import ${row.id} was deleted with account ${id}, but its document was written under key layout ${row.document_key_version}, which this server cannot address - remove it by hand`,
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
    sql`SELECT * FROM transactions WHERE ${WS()} ORDER BY date ASC`,
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
 * Writes the classification result. Manual marks (transfer_manual,
 * income_source_manual, one_off) are left alone - they beat auto-detection.
 */
export async function applyClassification(rows: Classification[]): Promise<void> {
  const w = currentWorkspaceId();
  await getDb().transaction(async (tx) => {
    for (const r of rows) {
      await tx
        .update(s.transactions)
        .set({
          category: r.category,
          transfer: r.transfer,
          refund: r.refund,
          incomeSource: r.incomeSource,
          recurring: r.recurring,
        })
        .where(and(eq(s.transactions.workspaceId, w), eq(s.transactions.id, r.id)));
    }
  });
}

export async function getTransaction(id: string): Promise<Transaction | undefined> {
  const rows = await rowsOf<TxRow>(
    sql`SELECT * FROM transactions WHERE id = ${id} AND ${WS()}`,
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
    .where(and(eq(s.transactions.workspaceId, currentWorkspaceId()), eq(s.transactions.id, id)));
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
    .where(and(eq(s.transactions.workspaceId, currentWorkspaceId()), eq(s.transactions.id, id)));
  return getTransaction(id);
}

export async function setIncomeSourceOverride(
  id: string,
  source: string | null,
): Promise<Transaction | undefined> {
  await getDb()
    .update(s.transactions)
    .set({ incomeSourceManual: source })
    .where(and(eq(s.transactions.workspaceId, currentWorkspaceId()), eq(s.transactions.id, id)));
  return getTransaction(id);
}

export async function setOneOff(id: string, value: boolean): Promise<Transaction | undefined> {
  await getDb()
    .update(s.transactions)
    .set({ oneOff: value })
    .where(and(eq(s.transactions.workspaceId, currentWorkspaceId()), eq(s.transactions.id, id)));
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

export async function listIncomeSources(): Promise<IncomeSourceDef[]> {
  const rows = await getDb()
    .select()
    .from(s.incomeSources)
    .where(eq(s.incomeSources.workspaceId, currentWorkspaceId()))
    .orderBy(s.incomeSources.sort, s.incomeSources.id);
  return rows.map(rowToIncomeSource);
}

export async function getIncomeSource(id: string): Promise<IncomeSourceDef | undefined> {
  const rows = await getDb()
    .select()
    .from(s.incomeSources)
    .where(and(eq(s.incomeSources.workspaceId, currentWorkspaceId()), eq(s.incomeSources.id, id)));
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
          sql`SELECT COALESCE(MAX(sort), -1) AS m FROM income_sources WHERE ${WS()}`,
        )
      )[0].m,
    ) + 1;
  const patterns = JSON.stringify(def.patterns ?? existing?.patterns ?? []);
  await getDb()
    .insert(s.incomeSources)
    .values({
      workspaceId: currentWorkspaceId(),
      id: def.id,
      label: def.label,
      kind: def.kind,
      patterns,
      sort: nextSort,
      builtin: false,
    })
    .onConflictDoUpdate({
      target: [s.incomeSources.workspaceId, s.incomeSources.id],
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
  const w = currentWorkspaceId();
  await getDb().transaction(async (tx) => {
    await tx
      .update(s.transactions)
      .set({ incomeSource: 'other' })
      .where(and(eq(s.transactions.workspaceId, w), eq(s.transactions.incomeSource, id)));
    await tx
      .update(s.transactions)
      .set({ incomeSourceManual: 'other' })
      .where(and(eq(s.transactions.workspaceId, w), eq(s.transactions.incomeSourceManual, id)));
    await tx
      .delete(s.incomeSources)
      .where(and(eq(s.incomeSources.workspaceId, w), eq(s.incomeSources.id, id)));
  });
  return true;
}

type RuleRow = typeof s.transferRules.$inferSelect;

const rowToRule = (r: RuleRow): TransferRule => ({
  id: r.id,
  description: r.description,
  accountId: r.accountId,
  createdAt: r.createdAt,
});

export async function listTransferRules(): Promise<TransferRule[]> {
  const rows = await getDb()
    .select()
    .from(s.transferRules)
    .where(eq(s.transferRules.workspaceId, currentWorkspaceId()))
    .orderBy(sql`${s.transferRules.createdAt} DESC`);
  return rows.map(rowToRule);
}

export async function addTransferRule(
  description: string,
  accountId: string,
): Promise<TransferRule> {
  const w = currentWorkspaceId();
  await getDb()
    .insert(s.transferRules)
    .values({ workspaceId: w, description, accountId, createdAt: new Date().toISOString() })
    .onConflictDoNothing();
  const rows = await getDb()
    .select()
    .from(s.transferRules)
    .where(
      and(
        eq(s.transferRules.workspaceId, w),
        eq(s.transferRules.description, description),
        eq(s.transferRules.accountId, accountId),
      ),
    );
  return rowToRule(rows[0]);
}

export async function deleteTransferRule(id: number): Promise<boolean> {
  const rows = await getDb()
    .delete(s.transferRules)
    .where(and(eq(s.transferRules.workspaceId, currentWorkspaceId()), eq(s.transferRules.id, id)))
    .returning({ id: s.transferRules.id });
  return rows.length > 0;
}

export async function countRuleMatches(description: string, accountId: string): Promise<number> {
  const rows = await rowsOf<{ n: string }>(
    sql`SELECT COUNT(*) AS n FROM transactions
        WHERE description = ${description} AND account_id = ${accountId} AND ${WS()}`,
  );
  return Number(rows[0].n);
}

/**
 * Clears manual marks from transactions covered by the rule: otherwise an old
 * manual `transfer_manual = false` would keep overriding the rule that was just
 * created, and one transaction in the group would stay untagged.
 */
export async function clearManualForRule(description: string, accountId: string): Promise<void> {
  await getDb().execute(sql`
    UPDATE transactions SET transfer_manual = NULL
    WHERE description = ${description} AND account_id = ${accountId} AND ${WS()}`);
}

export async function getFxRate(day: string, currency: string): Promise<number | undefined> {
  const rows = await getDb()
    .select()
    .from(s.fxRates)
    .where(
      and(
        eq(s.fxRates.workspaceId, currentWorkspaceId()),
        eq(s.fxRates.date, day),
        eq(s.fxRates.currency, currency),
      ),
    );
  return rows[0]?.rate;
}

export async function saveFxRate(day: string, currency: string, rate: number): Promise<void> {
  await getDb()
    .insert(s.fxRates)
    .values({ workspaceId: currentWorkspaceId(), date: day, currency, rate })
    .onConflictDoUpdate({
      target: [s.fxRates.workspaceId, s.fxRates.date, s.fxRates.currency],
      set: { rate },
    });
}

export async function setBaseForBaseCurrency(baseCurrency: string): Promise<number> {
  return execCount(sql`
    UPDATE transactions SET base_amount_cents = amount_cents, fx_rate = 1
    WHERE base_amount_cents IS NULL AND currency = ${baseCurrency} AND ${WS()}`);
}

/**
 * Changing the base currency: every base_amount is recomputed from scratch - the
 * old values were computed in the previous currency and cannot be added to the new ones.
 */
export async function resetBaseAmounts(): Promise<number> {
  return execCount(
    sql`UPDATE transactions SET base_amount_cents = NULL, fx_rate = NULL WHERE ${WS()}`,
  );
}

export async function listUnconvertedDays(): Promise<{ day: string; currency: string }[]> {
  return rowsOf<{ day: string; currency: string }>(sql`
    SELECT DISTINCT SUBSTR(date, 1, 10) AS day, currency
    FROM transactions WHERE base_amount_cents IS NULL AND ${WS()} ORDER BY day`);
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
    WHERE base_amount_cents IS NULL AND currency = ${currency} AND SUBSTR(date, 1, 10) = ${day} AND ${WS()}`);
}

export interface RecurringGroup {
  description: string;
  category: string;
  months: number;
  count: number;
  avgAmount: number;
  monthlyAvg: number;
  lastDate: string;
  ignored: boolean;
}

export async function setRecurringIgnored(description: string, ignored: boolean): Promise<void> {
  const key = recurringKey(description);
  const w = currentWorkspaceId();
  if (ignored) {
    await getDb()
      .insert(s.recurringIgnores)
      .values({ workspaceId: w, key, description, createdAt: new Date().toISOString() })
      .onConflictDoNothing();
  } else {
    await getDb()
      .delete(s.recurringIgnores)
      .where(and(eq(s.recurringIgnores.workspaceId, w), eq(s.recurringIgnores.key, key)));
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
    WHERE ${WS()} AND recurring AND amount_cents < 0 AND ${NOT_TRANSFER} AND ${VISIBLE_ACCOUNT()}
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
        .where(eq(s.recurringIgnores.workspaceId, currentWorkspaceId()))
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

export interface CategoryRule {
  id: number;
  pattern: string;
  category: string;
  createdAt: string;
}

export async function listCategoryRules(): Promise<CategoryRule[]> {
  const rows = await getDb()
    .select()
    .from(s.categoryRules)
    .where(eq(s.categoryRules.workspaceId, currentWorkspaceId()))
    .orderBy(sql`${s.categoryRules.createdAt} DESC`);
  return rows.map((r) => ({
    id: r.id,
    pattern: r.pattern,
    category: r.category,
    createdAt: r.createdAt,
  }));
}

export async function addCategoryRule(pattern: string, category: string): Promise<CategoryRule> {
  const w = currentWorkspaceId();
  await getDb()
    .insert(s.categoryRules)
    .values({ workspaceId: w, pattern, category, createdAt: new Date().toISOString() })
    .onConflictDoUpdate({
      target: [s.categoryRules.workspaceId, s.categoryRules.pattern],
      set: { category },
    });
  const rows = await getDb()
    .select()
    .from(s.categoryRules)
    .where(and(eq(s.categoryRules.workspaceId, w), eq(s.categoryRules.pattern, pattern)));
  const row = rows[0];
  return { id: row.id, pattern: row.pattern, category: row.category, createdAt: row.createdAt };
}

export async function deleteCategoryRule(id: number): Promise<boolean> {
  const rows = await getDb()
    .delete(s.categoryRules)
    .where(and(eq(s.categoryRules.workspaceId, currentWorkspaceId()), eq(s.categoryRules.id, id)))
    .returning({ id: s.categoryRules.id });
  return rows.length > 0;
}

/**
 * How many transactions the pattern covers, and how many of those the rule cannot
 * change because the user set the category by hand. One WHERE computing both, so the
 * two can never be taken through different filters and matches - overridden go wrong
 * for a workspace with a hidden account.
 */
export async function countCategoryRuleMatches(
  pattern: string,
): Promise<{ matches: number; overridden: number }> {
  const rows = await rowsOf<{ matches: string; overridden: string }>(
    sql`SELECT COUNT(*) AS matches,
               COUNT(*) FILTER (WHERE category_manual IS NOT NULL) AS overridden
        FROM transactions
        WHERE POSITION(LOWER(${pattern}) IN LOWER(description)) > 0 AND ${WS()}`,
  );
  return { matches: Number(rows[0].matches), overridden: Number(rows[0].overridden) };
}

export interface Budget {
  category: string;
  monthly: number;
}

export async function listBudgets(): Promise<Budget[]> {
  const rows = await getDb()
    .select()
    .from(s.budgets)
    .where(eq(s.budgets.workspaceId, currentWorkspaceId()))
    .orderBy(sql`${s.budgets.monthlyCents} DESC`);
  return rows.map((r) => ({ category: r.category, monthly: fromCents(r.monthlyCents) }));
}

export async function setBudget(category: string, monthly: number | null): Promise<void> {
  const w = currentWorkspaceId();
  if (monthly === null) {
    await getDb()
      .delete(s.budgets)
      .where(and(eq(s.budgets.workspaceId, w), eq(s.budgets.category, category)));
  } else {
    const monthlyCents = toCents(monthly);
    await getDb()
      .insert(s.budgets)
      .values({ workspaceId: w, category, monthlyCents })
      .onConflictDoUpdate({
        target: [s.budgets.workspaceId, s.budgets.category],
        set: { monthlyCents },
      });
  }
}

// ---------- the Analytics dock: the saved chart list ----------

export { CHART_BREAKDOWNS, CHART_KINDS, CHART_METRICS, CHART_RANGES } from './schema';

export type ChartKind = (typeof s.CHART_KINDS)[number];
export type ChartRange = (typeof s.CHART_RANGES)[number];
export type ChartBreakdown = (typeof s.CHART_BREAKDOWNS)[number];
export type ChartMetric = (typeof s.CHART_METRICS)[number];

export const CHARTS_MAX = 100;
export const CHART_TITLE_MAX = 120;
export const CHART_ID_MAX = 64;
export const CHART_ACCOUNT_ID_MAX = 64;

/**
 * One saved chart, as both routes carry it: the dock's order is array position, so `sort`
 * is not on this type. It IS in a downloaded backup, which selects the columns rather than
 * this shape - say "not on the charts API", never "never leaves".
 */
export interface Chart {
  id: string;
  kind: ChartKind;
  title: string;
  accountId: string | null;
  metrics: ChartMetric[];
  breakdown: ChartBreakdown;
  range: ChartRange;
}

export interface ChartList {
  version: number;
  charts: Chart[];
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

const chartsVersionRow = async (d: Db, w: string): Promise<string | undefined> =>
  (
    await d
      .select({ value: s.meta.value })
      .from(s.meta)
      .where(and(eq(s.meta.workspaceId, w), eq(s.meta.key, CHARTS_VERSION_KEY)))
  )[0]?.value;

type ChartRow = typeof s.analyticsCharts.$inferSelect;

const KNOWN_METRICS = new Set<string>(s.CHART_METRICS);

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
async function chartListOn(d: Db, w: string): Promise<ChartList> {
  const version = parseChartsVersion(await chartsVersionRow(d, w));
  const rows = await d
    .select()
    .from(s.analyticsCharts)
    .where(eq(s.analyticsCharts.workspaceId, w))
    .orderBy(s.analyticsCharts.sort, s.analyticsCharts.id);
  return { version, charts: rows.map(rowToChart) };
}

export async function listCharts(): Promise<ChartList> {
  return chartListOn(getDb(), currentWorkspaceId());
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
  const w = currentWorkspaceId();
  return getDb().transaction(async (tx) => {
    await tx
      .insert(s.meta)
      .values({ workspaceId: w, key: CHARTS_VERSION_KEY, value: '0' })
      .onConflictDoNothing();
    const raw = await chartsVersionRow(tx, w);
    const stale = async (): Promise<ChartsWrite> => ({
      ok: false,
      reason: 'stale',
      ...(await chartListOn(tx, w)),
    });
    if (parseChartsVersion(raw) !== expected) return stale();
    const bumped = await tx
      .update(s.meta)
      .set({ value: String(expected + 1) })
      .where(
        and(
          eq(s.meta.workspaceId, w),
          eq(s.meta.key, CHARTS_VERSION_KEY),
          eq(s.meta.value, raw ?? '0'),
        ),
      )
      .returning({ key: s.meta.key });
    // another writer moved the counter between the read and this statement: under
    // READ COMMITTED the predicate is re-evaluated against their committed row
    if (bumped.length === 0) return stale();
    await tx.delete(s.analyticsCharts).where(eq(s.analyticsCharts.workspaceId, w));
    if (charts.length > 0) {
      await tx.insert(s.analyticsCharts).values(
        charts.map((c, i) => ({
          workspaceId: w,
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
    return { ok: true, ...(await chartListOn(tx, w)) };
  });
}

export interface BaselineItem {
  id: number;
  label: string;
  monthly: number;
  sort: number;
}

type BaselineItemRow = typeof s.baselineItems.$inferSelect;

const rowToBaselineItem = (r: BaselineItemRow): BaselineItem => ({
  id: r.id,
  label: r.label,
  monthly: fromCents(r.monthlyCents),
  sort: r.sort,
});

export async function listBaselineItems(): Promise<BaselineItem[]> {
  const rows = await getDb()
    .select()
    .from(s.baselineItems)
    .where(eq(s.baselineItems.workspaceId, currentWorkspaceId()))
    .orderBy(s.baselineItems.sort, sql`${s.baselineItems.monthlyCents} DESC`);
  return rows.map(rowToBaselineItem);
}

/**
 * The key is the label: a line item is created and edited by its own name.
 * sort is optional: editing an amount from the app sends only monthly, and it must
 * not clobber the item's position - the list would jump under your finger. A new
 * item without sort goes to the end.
 */
export async function upsertBaselineItem(
  label: string,
  monthly: number,
  sort?: number,
): Promise<BaselineItem> {
  const w = currentWorkspaceId();
  const existing = (
    await getDb()
      .select()
      .from(s.baselineItems)
      .where(and(eq(s.baselineItems.workspaceId, w), eq(s.baselineItems.label, label)))
  )[0];
  const nextSort =
    sort ??
    existing?.sort ??
    Number(
      (
        await rowsOf<{ m: number }>(
          sql`SELECT COALESCE(MAX(sort), -1) AS m FROM baseline_items WHERE ${WS()}`,
        )
      )[0].m,
    ) + 1;
  const monthlyCents = toCents(monthly);
  const rows = await getDb()
    .insert(s.baselineItems)
    .values({ workspaceId: w, label, monthlyCents, sort: nextSort })
    .onConflictDoUpdate({
      target: [s.baselineItems.workspaceId, s.baselineItems.label],
      set: { monthlyCents, sort: nextSort },
    })
    .returning();
  return rowToBaselineItem(rows[0]);
}

export async function deleteBaselineItem(label: string): Promise<boolean> {
  const rows = await getDb()
    .delete(s.baselineItems)
    .where(
      and(eq(s.baselineItems.workspaceId, currentWorkspaceId()), eq(s.baselineItems.label, label)),
    )
    .returning({ id: s.baselineItems.id });
  return rows.length > 0;
}

export async function baselineTotal(): Promise<number> {
  const rows = await rowsOf<{ total_cents: string }>(
    sql`SELECT COALESCE(SUM(monthly_cents), 0) AS total_cents FROM baseline_items WHERE ${WS()}`,
  );
  return fromCents(Number(rows[0].total_cents));
}

/**
 * "My data is mine": one button in the app. The backup is a JSON dump of the
 * CURRENT WORKSPACE's rows in every user table - workspace_id itself is stripped
 * on export and reassigned on restore, so a backup can be moved between
 * workspaces (and servers) freely. Auth tables are deliberately not included:
 * users and sessions belong to the server, not to the workspace's data.
 */
export interface BackupData {
  format: 'finto-backup';
  version: 1;
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
  budgets: s.budgets,
  baseline_items: s.baselineItems,
  income_sources: s.incomeSources,
  settings: s.settings,
  meta: s.meta,
  analytics_charts: s.analyticsCharts,
} as const;

/**
 * Tables with an identity id. On restore their ids are dropped and regenerated:
 * the backup may come from another workspace/server whose ids are already taken
 * here (identity sequences are per table, not per workspace). Nothing references
 * these ids across tables, so renumbering is free.
 */
const IDENTITY_TABLES = new Set(['category_rules', 'transfer_rules', 'baseline_items']);

export async function exportBackup(): Promise<BackupData> {
  const w = currentWorkspaceId();
  const tables: Record<string, unknown[]> = {};
  for (const [name, table] of Object.entries(BACKUP_TABLES)) {
    const rows = (await getDb()
      .select()
      .from(table)
      .where(eq((table as typeof s.accounts).workspaceId, w))) as Record<string, unknown>[];
    tables[name] = rows.map(({ workspaceId: _ws, ...rest }) => rest);
  }
  return {
    format: 'finto-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    tables,
  };
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
  version: z.literal(1, { error: (issue) => `unsupported backup version: ${String(issue.input)}` }),
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

/**
 * Columns a restore may never carry over from the file. workspaceId is the scope
 * the restore reassigns. documentKeyVersion is a claim about bytes on THIS
 * server's disk, and the backup carries no documents - a restored row that kept it
 * would promise a file that is not there or, from a crafted backup whose rows name
 * another workspace's import ids, somebody else's.
 *
 * Checked against the row type rather than left as bare strings: the set matches TS
 * property names, so a renamed property would silently stop the strip from firing -
 * no compile error, no runtime error, and a restore quietly carrying a foreign
 * workspace's pointer again.
 *
 * The cost, accepted: because restoreBackup keeps import ids, a workspace restoring
 * its OWN backup reproduces the exact keys its blobs already sit under, and
 * stripping the pointer makes those documents unreadable anyway. They are not
 * unreachable - deleteImport removes a document without consulting this column -
 * so what is lost is a future re-parse skipping those imports. The alternative
 * (keep the pointer where a document exists at the derived key) makes a database
 * restore depend on disk state inside its own transaction, for a feature that does
 * not exist yet.
 */
const NEVER_RESTORED = new Set<string>([
  'workspaceId' satisfies keyof ImportRow,
  'documentKeyVersion' satisfies keyof ImportRow,
]);

/**
 * Statuses a restored import may not keep. `awaiting_confirmation` is a claim about
 * staged rows, and the backup carries none (staged_transactions is not a backup
 * table) - it would arrive as an import whose Confirm inserts nothing and reports
 * success. Typed against ImportStatus, like NEVER_RESTORED: renaming an enum value
 * is then a compile error rather than a set that quietly stops matching.
 */
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

/**
 * Keeps only real columns of the target table, and only values whose type the
 * column accepts. Without this a restore file is a direct write path into the
 * database with whatever types the uploader felt like: a string where an integer
 * lives turns into a driver error mid-transaction (a 500 instead of a "bad file"),
 * and a JSON object smuggled into a text column reappears everywhere that value is
 * displayed. Anything unrecognised is dropped rather than rejected, so a backup
 * from a future version still restores what this version understands.
 */
function sanitizeRow(
  table: (typeof BACKUP_TABLES)[keyof typeof BACKUP_TABLES],
  row: unknown,
  tableName: string,
): Record<string, unknown> {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(`${tableName}: a row is not an object`);
  }
  const columns = getTableColumns(table);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    const column = columns[key as keyof typeof columns];
    if (!column || NEVER_RESTORED.has(key)) continue; // unknown column, or one a restore may not carry
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
 * Restore from a JSON backup: clear the current workspace's tables and load the
 * dump's rows into it, all in one transaction. Tables the current schema does not
 * know are skipped (a future version's backup restores what it can). After
 * restoring, the caller runs a full reclassification - same as after any bulk import.
 *
 * What it leaves behind, and what is accepted: this deletes the workspace's
 * `imports` rows, and every source document those rows had stays on disk (the
 * backup is JSON and carries no documents). The ones whose import id comes back in
 * the file are still removable, because deleteImport addresses a document without
 * consulting the pointer this strips; the ones whose row is not reinstated are
 * referenced by nothing and no sweeper is in scope. Both are data-subject-deletion
 * lines, not bugs to fix here.
 */
export async function restoreBackup(data: BackupData): Promise<{ tables: number; rows: number }> {
  const w = currentWorkspaceId();
  let tables = 0;
  let rows = 0;
  await getDb().transaction(async (tx) => {
    for (const [name, table] of Object.entries(BACKUP_TABLES)) {
      const incoming = data.tables[name];
      if (!incoming) continue; // an older backup without this table keeps it empty
      await tx.execute(sql`DELETE FROM ${sql.raw(name)} WHERE workspace_id = ${w}`);
      const dropId = IDENTITY_TABLES.has(name);
      const values = incoming.map((row) => {
        const clean = sanitizeRow(table, row, name);
        const { id, ...rest } = name === 'imports' ? coerceRestoredImport(clean) : clean;
        return dropId ? { ...rest, workspaceId: w } : { ...rest, id, workspaceId: w };
      });
      for (const chunk of chunked(values, 500)) {
        await tx.insert(table).values(chunk as never[]);
      }
      tables++;
      rows += incoming.length;
    }
  });
  return { tables, rows };
}
