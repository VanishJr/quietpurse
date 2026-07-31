/**
 * The whole schema in its final shape (the state after the old SQLite migrations
 * 001+002). SQL migrations are generated from this file by `drizzle-kit generate`
 * into backend/drizzle/ and applied at startup (see ./index.ts).
 *
 * Conventions carried over from the SQLite era, deliberately kept:
 *  - money is INTEGER minor units (cents) - SUM() stays exact (see money.ts);
 *  - dates/timestamps are TEXT ISO-8601 - lexicographic comparison works, and
 *    SUBSTR-based month grouping needs no date-type gymnastics;
 *  - fx_rate is a ratio, not money - double precision.
 * What did change: INTEGER 0/1 flags became real booleans.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// ---------- better-auth tables (users, sessions, workspaces) ----------
//
// The shape better-auth's drizzle adapter expects (core + the organization
// plugin). Unlike the finance tables these use real timestamps: the adapter
// reads and writes Date objects. An "organization" IS a workspace - the app
// calls it workspace everywhere, the table keeps the plugin's name.

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    // organization plugin: the workspace the session is acting in
    activeOrganizationId: text('active_organization_id'),
  },
  (t) => [index('idx_session_user').on(t.userId)],
);

/** better-auth credential/oauth accounts - NOT bank accounts (those are `accounts`). */
export const authAccount = pgTable('auth_account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
});

/** A workspace. Every data table below carries workspace_id -> organization.id. */
export const organization = pgTable('organization', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').unique(),
  logo: text('logo'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  metadata: text('metadata'),
});

export const member = pgTable(
  'member',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('member'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('idx_member_user').on(t.userId), index('idx_member_org').on(t.organizationId)],
);

export const invitation = pgTable('invitation', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: text('role'),
  status: text('status').notNull().default('pending'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  inviterId: text('inviter_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
});

// ---------- finance tables (all workspace-scoped) ----------

/**
 * Every data table starts with this column. Deleting a workspace cascades into
 * its data. Account ids are provider-derived and only unique per workspace - two
 * users connecting the same bank produce the same id - so those tables use a
 * composite (workspace_id, id) primary key. Transactions keep the composite key
 * too, even though their id is a UUID: nothing else in the schema is keyed by id
 * alone, and a query that forgets the workspace filter must not compile a path
 * to somebody else's row.
 */
const workspaceId = () =>
  text('workspace_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' });

export const accounts = pgTable(
  'accounts',
  {
    workspaceId: workspaceId(),
    id: text('id').notNull(),
    provider: text('provider').notNull(),
    name: text('name').notNull(),
    currency: text('currency').notNull(),
    balanceCents: integer('balance_cents').notNull().default(0),
    iban: text('iban'),
    // account removed by the user: not shown, not counted
    hidden: boolean('hidden').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

/**
 * One uploaded file, and the provenance of everything it produced (ROADMAP 4.4).
 * Deleting a row here takes its transactions with it - that is the whole point,
 * and deleteImport (./index.ts) is the only sanctioned path to it.
 */
export const imports = pgTable(
  'imports',
  {
    workspaceId: workspaceId(),
    id: text('id').notNull(),
    // sha256 of the raw uploaded bytes - the file on the user's disk, hashed
    // before any decoding, sniffing or parsing (see providers/statement.ts)
    fileHash: text('file_hash').notNull(),
    sourceType: text('source_type', { enum: ['csv', 'xlsx', 'pdf'] }).notNull(),
    originalFilename: text('original_filename'),
    // What the upload asked for: the account name as the user typed it, and the
    // currency for rows whose file carries none. Recorded because Confirm is a
    // later request that does not carry the form fields, and the account id is
    // derived from the name (see uploadAccountId) rather than stored, so the two
    // cannot come to disagree. NULL on every import that never reached the parse,
    // and on every one from before the confirmation step.
    accountName: text('account_name'),
    accountCurrency: text('account_currency'),
    // user.id at upload time, deliberately NOT a foreign key: a backup restores
    // onto another server, where that user does not exist
    uploadedBy: text('uploaded_by'),
    uploadedAt: text('uploaded_at').notNull(),
    // per parser, keyed by source_type: what makes re-parsing targetable later
    parserVersion: integer('parser_version').notNull(),
    /**
     * pending = written, outcome unknown: the process died mid-import;
     * awaiting_confirmation = parsed, its rows staged in staged_transactions,
     * waiting for the user to accept the summary; committed = its rows are in the
     * database; discarded = the user looked at the numbers and said no; failed =
     * the import did not complete. Usually that means
     * the parse threw before anything was written, but the failure is caught around
     * the inserts too - so whatever rows a failed import did write stay attached
     * to it, and go with it when it is deleted.
     *
     * awaiting_confirmation is its own value rather than an overload of `pending`
     * because `pending` is a corpse: presenting one as "confirm these numbers"
     * would offer a half-written import for acceptance.
     *
     * `discarded` keeps its row instead of deleting it, and that is the point: the
     * row is what references the stored source document (4.5), which is exactly the
     * artefact a user who rejected the numbers will be asked for. It owns no
     * transactions, so nothing is deleted to reach it, and only `committed` claims
     * a file hash, so the file stays re-uploadable. On a `discarded` row
     * error_detail separates the two ways it can be reached: NULL means the user
     * declined it, a sentence means the server did (see restoreBackup).
     */
    status: text('status', {
      enum: ['pending', 'awaiting_confirmation', 'committed', 'failed', 'discarded'],
    }).notNull(),
    // rows the parser turned into transactions, and rows it could not use. How many
    // of the accepted ones were genuinely new is a COUNT over transactions.import_id
    rowsAccepted: integer('rows_accepted').notNull().default(0),
    rowsRejected: integer('rows_rejected').notNull().default(0),
    // the failure message, truncated; never a stack trace - it lands in the backup
    errorDetail: text('error_detail'),
    /**
     * The pointer to the stored source document (ROADMAP 4.5). It records two
     * things and deliberately not a third: that a document can be read for this
     * row, and which key layout it was written under. NOT the key itself - the key
     * is derived at read time from (current workspace, import id), because a key
     * read out of this row is a string a restored backup gets to choose.
     *
     * NULL means no document can be READ - the layout its bytes were written under
     * is not recorded. It does NOT mean there are no bytes on disk: an import from
     * before 4.5, a row restored from a backup (restoreBackup strips this column),
     * or one that died between the blob landing and this column being set all have
     * NULL here and may well have a document. Nothing that deletes may treat it as
     * though it meant "no document" - see deleteImport.
     */
    documentKeyVersion: integer('document_key_version'),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.id] }),
    /**
     * Layer 1 of the duplicate defence (ROADMAP 4.3): the same file twice.
     * Only `committed` blocks - a failed parse must be retryable with the same
     * bytes, and a `pending` corpse must not answer "already imported" for rows
     * that were never written.
     *
     * The cost: two concurrent uploads of one file no longer serialise on this
     * index. Accepted - the transactions dedup index still refuses the duplicate
     * rows, so the worst case is a second imports row owning nothing.
     */
    uniqueIndex('imports_file_hash_unique')
      .on(t.workspaceId, t.fileHash)
      .where(sql`status = 'committed'`),
  ],
);

export const transactions = pgTable(
  'transactions',
  {
    workspaceId: workspaceId(),
    // surrogate: a UUID assigned on insert, never derived from the row's contents
    // and never changing. Annotations and every future foreign key point at this.
    id: text('id').notNull(),
    accountId: text('account_id').notNull(),
    // "which transaction is this" as the provider sees it - the deduplication key,
    // deliberately separate from the identity above (see insertTransactions)
    dedupKey: text('dedup_key').notNull(),
    provider: text('provider').notNull(),
    amountCents: integer('amount_cents').notNull(),
    currency: text('currency').notNull(),
    date: text('date').notNull(),
    description: text('description').notNull().default(''),
    mcc: integer('mcc'),
    // category slug (see categorizer.ts); human-readable names live in the client
    category: text('category').notNull().default('other'),
    // transfer between own accounts: neither income nor expense (see classify.ts)
    transfer: boolean('transfer').notNull().default(false),
    // manual mark from the app: NULL = auto-detection decides, the user otherwise
    transferManual: boolean('transfer_manual'),
    // refund / cancelled purchase: arrives positive, but subtracts from spending
    refund: boolean('refund').notNull().default(false),
    // amount in the base currency at that date's rate, and the rate itself
    baseAmountCents: integer('base_amount_cents'),
    fxRate: doublePrecision('fx_rate'),
    // income source id (income_sources.id); *_manual - the user's explicit choice
    incomeSource: text('income_source'),
    incomeSourceManual: text('income_source_manual'),
    // recurring payment (subscription, rent): detected from history
    recurring: boolean('recurring').notNull().default(false),
    // one-off large purchase: spread over 12 months in the goal calculation
    oneOff: boolean('one_off').notNull().default(false),
    /**
     * The import that FIRST wrote this row. First writer, not every attestation:
     * a later import whose file contains the same row inserts nothing and is
     * recorded nowhere, so deleting this import removes the row even though that
     * later import still asserts it (ROADMAP 4.4).
     *
     * Nullable for the rows the deleted bank integrations wrote, and only those:
     * every insert path left carries an import id.
     */
    importId: text('import_id'),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.id] }),
    // composite, so a row can never point at another workspace's import. MATCH
    // SIMPLE: with import_id NULL the constraint is not checked at all, which is
    // what those legacy rows need.
    foreignKey({
      columns: [t.workspaceId, t.importId],
      foreignColumns: [imports.workspaceId, imports.id],
    }).onDelete('cascade'),
    // the deduplication rule itself: one transaction per key per account. Scoped
    // to the workspace - two users importing the same statement must both keep
    // their rows.
    uniqueIndex('transactions_dedup_unique').on(t.workspaceId, t.accountId, t.dedupKey),
    index('idx_tx_account').on(t.workspaceId, t.accountId),
    index('idx_tx_date').on(t.workspaceId, t.date),
    // PG does not index a foreign key for you, and the cascade delete scans on this
    index('idx_tx_import').on(t.workspaceId, t.importId),
  ],
);

/**
 * The rows of an import that is awaiting confirmation (ROADMAP 5.3). A separate
 * table rather than a status column on `transactions`: an unconfirmed row is never
 * read as data because it is not in the table every read path names, and that needs
 * no filter - so there is none to forget.
 *
 * It carries NO dedup_key, deliberately. The key is computed and arbitrated by the
 * database at confirm time, exactly as it is at import time today, so a staged row
 * claims no slot in transactions_dedup_unique: an import uploaded while this one is
 * outstanding still inserts every row it should, and discarding this one cannot
 * take away a row that other import was told already existed.
 */
export const stagedTransactions = pgTable(
  'staged_transactions',
  {
    workspaceId: workspaceId(),
    importId: text('import_id').notNull(),
    // the row's position in the file: the confirm reads by it, so the ordinals land
    // on the same rows a single-stage import would have given them
    rowNo: integer('row_no').notNull(),
    accountId: text('account_id').notNull(),
    provider: text('provider').notNull(),
    amountCents: integer('amount_cents').notNull(),
    currency: text('currency').notNull(),
    date: text('date').notNull(),
    description: text('description').notNull().default(''),
    mcc: integer('mcc'),
    category: text('category').notNull().default('other'),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.importId, t.rowNo] }),
    // composite like transactions.import_id: a single-column key would let a
    // restored or crafted import id reach another workspace's staged rows. The
    // cascade is what makes deleteImport and restoreBackup's DELETE FROM imports
    // take these with them, with no new delete written anywhere.
    foreignKey({
      columns: [t.workspaceId, t.importId],
      foreignColumns: [imports.workspaceId, imports.id],
    }).onDelete('cascade'),
  ],
);

// Workspace-scoped even though a historical rate is universal: the stored value
// is "base currency per unit", and each workspace picks its own base currency.
export const fxRates = pgTable(
  'fx_rates',
  {
    workspaceId: workspaceId(),
    date: text('date').notNull(), // YYYY-MM-DD
    currency: text('currency').notNull(), // ISO code
    rate: doublePrecision('rate').notNull(), // base currency per unit of currency
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.date, t.currency] })],
);

export const categoryRules = pgTable(
  'category_rules',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    workspaceId: workspaceId(),
    pattern: text('pattern').notNull(), // substring of the description, case-insensitive
    category: text('category').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('category_rules_pattern_unique').on(t.workspaceId, t.pattern)],
);

export const transferRules = pgTable(
  'transfer_rules',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    workspaceId: workspaceId(),
    description: text('description').notNull(),
    accountId: text('account_id').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('transfer_rules_desc_account_unique').on(t.workspaceId, t.description, t.accountId),
  ],
);

export const recurringIgnores = pgTable(
  'recurring_ignores',
  {
    workspaceId: workspaceId(),
    key: text('key').notNull(),
    description: text('description').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.key] })],
);

export const budgets = pgTable(
  'budgets',
  {
    workspaceId: workspaceId(),
    category: text('category').notNull(),
    monthlyCents: integer('monthly_cents').notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.category] })],
);

// baseline minimum line items for the Goal screen
export const baselineItems = pgTable(
  'baseline_items',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    workspaceId: workspaceId(),
    label: text('label').notNull(),
    monthlyCents: integer('monthly_cents').notNull(),
    sort: integer('sort').notNull().default(0),
  },
  (t) => [uniqueIndex('baseline_items_label_unique').on(t.workspaceId, t.label)],
);

export const incomeSources = pgTable(
  'income_sources',
  {
    workspaceId: workspaceId(),
    id: text('id').notNull(), // slug: salary, family, other, freelance...
    label: text('label').notNull(),
    kind: text('kind', { enum: ['own', 'external'] }).notNull(),
    patterns: text('patterns').notNull().default('[]'), // JSON array of strings
    sort: integer('sort').notNull().default(0),
    // seeded sources: cannot be deleted, automation is keyed on the id
    builtin: boolean('builtin').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.id] })],
);

export const settings = pgTable(
  'settings',
  {
    workspaceId: workspaceId(),
    key: text('key').notNull(),
    value: text('value').notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.key] })],
);

export const meta = pgTable(
  'meta',
  {
    workspaceId: workspaceId(),
    key: text('key').notNull(),
    value: text('value').notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.key] })],
);
