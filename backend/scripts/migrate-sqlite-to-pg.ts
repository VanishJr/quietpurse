/**
 * One-off transfer of a Finto SQLite database into PostgreSQL.
 *
 *   npm run migrate:sqlite                       # data/finto.db -> the owner workspace
 *   npm run migrate:sqlite -- <file.db>          # an explicit dump (e.g. an old backup)
 *   npm run migrate:sqlite -- --workspace <id>   # a specific workspace
 *   npm run migrate:sqlite -- --force            # overwrite that workspace's data
 *
 * Expects the SQLite file to be on the final pre-Postgres schema (migration 002,
 * money in *_cents columns) - i.e. one the last SQLite build of the app has opened
 * at least once. Applies the Drizzle migrations itself, so it works on an empty
 * Postgres too.
 *
 * Workspaces: the SQLite era had exactly one user, so its data lands in ONE
 * workspace - by default the oldest one on the server, which belongs to whoever
 * set it up. The script cannot invent a workspace: register in the app first,
 * then run this. Refuses to run if the target workspace already has transactions
 * (unless --force, which clears that workspace's tables first - never anyone
 * else's).
 */
import 'dotenv/config';
import crypto from 'crypto';
import path from 'path';
import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { PgTable } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import { computedDedupKey, dedupGroup } from '../src/db/dedup';
import * as s from '../src/db/schema';

const args = process.argv.slice(2);
const force = args.includes('--force');
const workspaceArg = ((): string | undefined => {
  const i = args.indexOf('--workspace');
  return i >= 0 ? args[i + 1] : undefined;
})();
const sqlitePath =
  args.filter((a) => a !== workspaceArg).find((a) => !a.startsWith('--')) ??
  path.join(__dirname, '..', 'data', 'finto.db');
const databaseUrl = process.env.DATABASE_URL || 'postgres://finto:finto@localhost:5432/finto';

/** SQLite integer flags that become Postgres booleans (null stays null). */
const asBool = (v: unknown): boolean | null => (v === null ? null : Number(v) === 1);

/**
 * old transaction id -> new dedup_key, filled by dedupKeysFor() before the copy.
 * The transaction mapper is per-row, but the ordinal in a computed key depends on
 * the whole table, so it is worked out in one pass up front.
 */
const dedupKeys = new Map<string, string>();

/**
 * Reconstructs the new-shape dedup keys for a SQLite history (see ROADMAP 4.2).
 *
 * The old id WAS the dedup key, so carrying it over verbatim would be the easy
 * move - and would leave the migrated history unreproducible by any later parse:
 * a re-import of the same statement computes a key in the new format, matches
 * nothing, and duplicates everything. So the keys are derived in the format the
 * app now uses:
 *
 *  - monobank: the id is already `mono:<operation id>`, the bank's own reference;
 *  - enablebanking: `eb:<account uid>:<entry_reference>` loses the uid, which the
 *    unique index now carries as account_id;
 *  - anything hashed (`...:h:<hash>` - CSV, and EB without an entry_reference)
 *    gets a computed key, numbered within its (account, day, amount, currency)
 *    group.
 *
 * Numbering order inside a group is irrelevant - only the count is - so old id
 * order is used for determinism. No two source rows can collide: they were unique
 * by their old hash, and n distinct rows take n distinct ordinals, so nothing in
 * the user's history is merged away.
 */
function dedupKeysFor(rows: Row[]): void {
  const computed: Row[] = [];
  for (const r of rows) {
    const id = String(r.id);
    const accountPrefix = `${String(r.account_id)}:`;
    const rest = id.startsWith(accountPrefix) ? id.slice(accountPrefix.length) : '';
    if (r.provider === 'monobank') {
      dedupKeys.set(id, id);
    } else if (r.provider === 'enablebanking' && rest && !rest.startsWith('h:')) {
      dedupKeys.set(id, `eb:${rest}`);
    } else {
      computed.push(r);
    }
  }
  const ordinals = new Map<string, number>();
  for (const r of computed.sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    const day = String(r.date).slice(0, 10);
    const amountCents = Number(r.amount_cents);
    const currency = String(r.currency);
    const group = dedupGroup(String(r.account_id), day, amountCents, currency);
    const n = (ordinals.get(group) ?? 0) + 1;
    ordinals.set(group, n);
    dedupKeys.set(String(r.id), computedDedupKey(day, amountCents, currency, n));
  }
}

/**
 * dedupKeysFor covers every row, so this is unreachable - but a transfer of
 * somebody's whole financial history should stop rather than write a row whose
 * identity it could not work out.
 */
function missingKey(r: Row): never {
  throw new Error(`no dedup key derived for transaction ${String(r.id)} - refusing to transfer it`);
}

/**
 * table -> [pg table, sqlite row -> pg insert values]. Money stays integer cents;
 * only the 0/1 flags change representation. workspace_id is added by the caller -
 * it is the same for every row, so the mappers stay free of it.
 *
 * Identity ids (category_rules, transfer_rules, baseline_items, sync_log) are
 * deliberately NOT carried over: those sequences are per table, not per
 * workspace, so a dump's ids can collide with rows another workspace already
 * owns. Nothing references them across tables, so renumbering costs nothing.
 *
 * Transaction ids are not carried over either, for a different reason: they used
 * to be content hashes and are now surrogates. See dedupKeysFor above.
 */
type Row = Record<string, unknown>;
const TABLES: [string, PgTable, (r: Row) => Row][] = [
  [
    'accounts',
    s.accounts,
    (r) => ({
      id: r.id,
      provider: r.provider,
      name: r.name,
      currency: r.currency,
      balanceCents: r.balance_cents,
      iban: r.iban,
      ebSessionId: r.eb_session_id,
      lastSyncedAt: r.last_synced_at,
      historyFrom: r.history_from,
      hidden: asBool(r.hidden) ?? false,
    }),
  ],
  [
    'transactions',
    s.transactions,
    (r) => ({
      // the id becomes a surrogate; what the old id meant now lives in dedup_key
      id: crypto.randomUUID(),
      dedupKey: dedupKeys.get(String(r.id)) ?? missingKey(r),
      accountId: r.account_id,
      provider: r.provider,
      amountCents: r.amount_cents,
      currency: r.currency,
      date: r.date,
      description: r.description,
      mcc: r.mcc,
      category: r.category,
      transfer: asBool(r.transfer) ?? false,
      transferManual: asBool(r.transfer_manual),
      refund: asBool(r.refund) ?? false,
      baseAmountCents: r.base_amount_cents,
      fxRate: r.fx_rate,
      incomeSource: r.income_source,
      incomeSourceManual: r.income_source_manual,
      recurring: asBool(r.recurring) ?? false,
      oneOff: asBool(r.one_off) ?? false,
    }),
  ],
  ['fx_rates', s.fxRates, (r) => ({ date: r.date, currency: r.currency, rate: r.rate })],
  [
    'category_rules',
    s.categoryRules,
    (r) => ({ pattern: r.pattern, category: r.category, createdAt: r.created_at }),
  ],
  [
    'transfer_rules',
    s.transferRules,
    (r) => ({
      description: r.description,
      accountId: r.account_id,
      createdAt: r.created_at,
    }),
  ],
  [
    'recurring_ignores',
    s.recurringIgnores,
    (r) => ({ key: r.key, description: r.description, createdAt: r.created_at }),
  ],
  ['budgets', s.budgets, (r) => ({ category: r.category, monthlyCents: r.monthly_cents })],
  [
    'baseline_items',
    s.baselineItems,
    (r) => ({ label: r.label, monthlyCents: r.monthly_cents, sort: r.sort }),
  ],
  [
    'income_sources',
    s.incomeSources,
    (r) => ({
      id: r.id,
      label: r.label,
      kind: r.kind,
      patterns: r.patterns,
      sort: r.sort,
      builtin: asBool(r.builtin) ?? false,
    }),
  ],
  ['settings', s.settings, (r) => ({ key: r.key, value: r.value })],
  ['meta', s.meta, (r) => ({ key: r.key, value: r.value })],
  [
    'eb_sessions',
    s.ebSessions,
    (r) => ({
      sessionId: r.session_id,
      aspspName: r.aspsp_name,
      aspspCountry: r.aspsp_country,
      validUntil: r.valid_until,
      createdAt: r.created_at,
    }),
  ],
  [
    'eb_auth_state',
    s.ebAuthState,
    (r) => ({
      state: r.state,
      aspspName: r.aspsp_name,
      aspspCountry: r.aspsp_country,
      createdAt: r.created_at,
    }),
  ],
  [
    'sync_log',
    s.syncLog,
    (r) => ({
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      ok: asBool(r.ok),
      inserted: r.inserted,
      errors: r.errors,
      log: r.log,
    }),
  ],
];

/** meta keys that only made sense to the old SQLite migration runner */
const META_SKIP = new Set(['schema_version']);

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function main(): Promise<void> {
  console.log(`SQLite:   ${sqlitePath}`);
  console.log(`Postgres: ${databaseUrl.replace(/:[^:@/]+@/, ':***@')}`);

  const sqlite = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  const hasCents = (
    sqlite.prepare(`PRAGMA table_info(transactions)`).all() as { name: string }[]
  ).some((c) => c.name === 'amount_cents');
  if (!hasCents) {
    throw new Error(
      'this SQLite file is on a pre-002 schema (no amount_cents column) - open it once with the last SQLite build of the app to migrate it, then rerun',
    );
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: path.join(__dirname, '..', 'drizzle') });

  // the target workspace: --workspace, or the oldest one (the server owner's)
  const workspaces = (await db.execute(
    sql`SELECT id, name FROM organization ORDER BY created_at ASC, id ASC`,
  )) as unknown as { rows: { id: string; name: string }[] };
  if (workspaces.rows.length === 0) {
    throw new Error(
      'no workspaces on this server yet - register in the app first, then rerun: the data has to belong to somebody',
    );
  }
  const target = workspaceArg
    ? workspaces.rows.find((w) => w.id === workspaceArg)
    : workspaces.rows[0];
  if (!target) {
    throw new Error(
      `workspace ${workspaceArg} not found. Available:\n` +
        workspaces.rows.map((w) => `  ${w.id}  ${w.name}`).join('\n'),
    );
  }
  console.log(`Workspace: ${target.id} (${target.name})`);

  const existing = (await db.execute(
    sql`SELECT COUNT(*) AS n FROM transactions WHERE workspace_id = ${target.id}`,
  )) as unknown as { rows: { n: string }[] };
  if (Number(existing.rows[0].n) > 0 && !force) {
    throw new Error(
      `workspace ${target.id} already has ${existing.rows[0].n} transactions - rerun with --force to replace ITS data (other workspaces are never touched)`,
    );
  }

  const report: { table: string; rows: number }[] = [];
  await db.transaction(async (tx) => {
    for (const [name, table, map] of TABLES) {
      const exists = sqlite
        .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(name) as { n: number };
      const rows =
        exists.n > 0 ? (sqlite.prepare(`SELECT * FROM ${name}`).all() as Row[]) : [];
      // ordinals need the whole table, so the keys are worked out before mapping
      if (name === 'transactions') dedupKeysFor(rows);
      const values = rows
        .map(map)
        .filter((v) => name !== 'meta' || !META_SKIP.has(String(v.key)))
        .map((v) => ({ ...v, workspaceId: target.id }));
      // only this workspace's rows are cleared - a shared server keeps the rest
      await tx.execute(sql`DELETE FROM ${sql.raw(name)} WHERE workspace_id = ${target.id}`);
      for (const chunk of chunked(values, 500)) {
        await tx.insert(table).values(chunk as never[]);
      }
      report.push({ table: name, rows: values.length });
    }
  });

  console.log('\ntransferred:');
  for (const r of report) console.log(`  ${r.table.padEnd(18)} ${r.rows}`);

  // control check: account balances must match to the cent
  const sqliteBalances = sqlite
    .prepare(`SELECT id, balance_cents FROM accounts ORDER BY id`)
    .all() as { id: string; balance_cents: number }[];
  const pgBalances = (await db.execute(
    sql`SELECT id, balance_cents FROM accounts WHERE workspace_id = ${target.id} ORDER BY id`,
  )) as unknown as { rows: { id: string; balance_cents: number }[] };
  const mismatches = sqliteBalances.filter(
    (a, i) =>
      pgBalances.rows[i]?.id !== a.id ||
      Number(pgBalances.rows[i]?.balance_cents) !== a.balance_cents,
  );
  console.log(
    mismatches.length === 0
      ? `\nbalance check: OK (${sqliteBalances.length} accounts match)`
      : `\nbalance check FAILED for: ${mismatches.map((m) => m.id).join(', ')}`,
  );

  sqlite.close();
  await pool.end();
  if (mismatches.length > 0) process.exit(1);
}

main().catch((e: Error) => {
  console.error(`transfer failed: ${e.message}`);
  process.exit(1);
});
