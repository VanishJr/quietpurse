import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
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
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.id] }),
    /**
     * Folded in SQL, and every comparison against it must fold the same way - JS
     * toLowerCase() and lower() disagree (Turkish dotted I among others), and a
     * lookup that misses where the index matches is an insert that collides.
     */
    uniqueIndex('accounts_name_unique').on(t.workspaceId, sql`lower(${t.name})`),
  ],
);

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
    // All three are NULL on every import that never reached the parse, and on
    // every one from before the confirmation step.
    accountName: text('account_name'),
    accountCurrency: text('account_currency'),
    accountId: text('account_id'),
    // user.id at upload time, deliberately NOT a foreign key: a backup restores
    // onto another server, where that user does not exist
    uploadedBy: text('uploaded_by'),
    uploadedAt: text('uploaded_at').notNull(),
    // per parser, keyed by source_type: what makes re-parsing targetable later
    parserVersion: integer('parser_version').notNull(),
    status: text('status', {
      enum: ['pending', 'awaiting_confirmation', 'committed', 'failed', 'discarded'],
    }).notNull(),
    // rows the parser turned into transactions, and rows it could not use. How many
    // of the accepted ones were genuinely new is a COUNT over transactions.import_id
    rowsAccepted: integer('rows_accepted').notNull().default(0),
    rowsRejected: integer('rows_rejected').notNull().default(0),
    // the failure message, truncated; never a stack trace - it lands in the backup
    errorDetail: text('error_detail'),
    documentKeyVersion: integer('document_key_version'),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.id] }),
    /**
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
    // The fee the source stated for this operation, as it printed it (positive).
    // amount_cents is the whole movement and is already net of this, so nothing
    // reading an amount has to know the column exists.
    //
    // NULL is "the source stated none", and it is not the same fact as a stated
    // zero: a Sparkasse export names no fee at all, where a Revolut row writing
    // 0.00 asserts one. A default of 0 would make every statement claim the second.
    feeCents: integer('fee_cents'),
    currency: text('currency').notNull(),
    date: text('date').notNull(),
    description: text('description').notNull().default(''),
    mcc: integer('mcc'),
    // category slug (see categorizer.ts); human-readable names live in the client
    category: text('category').notNull().default('other'),
    // the user's own answer for this one row: NULL = auto-detection decides. Its own
    // column so that a recompute cannot erase it - reclassifyAll keeps `category`
    // current underneath, which is what a later clear falls back to.
    categoryManual: text('category_manual'),
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
    // A fee is a magnitude and the mapper subtracts it, so a negative one would
    // INCREASE the movement. Here rather than in the mapper because the mapper is
    // not the last producer this column will have - the PDF path states its fees on
    // a continuation line and reads none of them yet.
    check('transactions_fee_cents_nonneg', sql`${t.feeCents} >= 0`),
  ],
);

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
    // as on transactions: NULL = the source stated no fee, and amount_cents is
    // already net of a stated one
    feeCents: integer('fee_cents'),
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
    check('staged_transactions_fee_cents_nonneg', sql`${t.feeCents} >= 0`),
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

export const CHART_KINDS = ['line', 'column', 'area', 'donut', 'ranking', 'radar'] as const;
export const CHART_RANGES = ['3m', '6m', '12m', '24m', '3y', '5y'] as const;
export const CHART_BREAKDOWNS = [
  'expense-categories',
  'income-categories',
  'income-sources',
] as const;
export const CHART_METRICS = ['income', 'expense', 'net'] as const;

// sql.raw, not a parameter: drizzle-kit serialises a check into DDL, where a
// bound $1 is not a thing. The values are this file's own literals.
const inList = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(', ');

/** The list is replaced whole, so `sort` is assigned 0..n-1 on every write. */
export const analyticsCharts = pgTable(
  'analytics_charts',
  {
    workspaceId: workspaceId(),
    // the client's own id, and ?chart= in the URL names it - never minted here
    id: text('id').notNull(),
    sort: integer('sort').notNull(),
    title: text('title').notNull(),
    kind: text('kind', { enum: CHART_KINDS }).notNull(),
    range: text('range', { enum: CHART_RANGES }).notNull(),
    breakdown: text('breakdown', { enum: CHART_BREAKDOWNS }).notNull(),
    /**
     * NULL = every account together. Deliberately not a foreign key: a chart
     * naming an account that has been deleted is a state the client draws on
     * purpose ("that account is no longer here"). A cascade would take the
     * reader's tab away with nothing said, and SET NULL would silently turn a
     * chart of one account into a chart of the whole workspace under its old
     * title.
     */
    accountId: text('account_id'),
    metrics: text('metrics').notNull().default('[]'), // JSON array of measure keys
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.id] }),
    check('analytics_charts_kind', sql`${t.kind} IN (${sql.raw(inList(CHART_KINDS))})`),
    check('analytics_charts_range', sql`${t.range} IN (${sql.raw(inList(CHART_RANGES))})`),
    check(
      'analytics_charts_breakdown',
      sql`${t.breakdown} IN (${sql.raw(inList(CHART_BREAKDOWNS))})`,
    ),
  ],
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
