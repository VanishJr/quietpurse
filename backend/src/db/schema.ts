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
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  CHART_BREAKDOWNS,
  CHART_KINDS,
  CHART_RANGES,
  IMPORT_SOURCE_TYPES,
  IMPORT_STATUSES,
  INCOME_SOURCE_KINDS,
} from '../wire';

export const accounts = pgTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    name: text('name').notNull(),
    currency: text('currency').notNull(),
    balanceCents: integer('balance_cents').notNull().default(0),
    iban: text('iban'),
    // account removed by the user: not shown, not counted
    hidden: boolean('hidden').notNull().default(false),
  },
  (t) => [
    /**
     * Folded in SQL, and every comparison against it must fold the same way - JS
     * toLowerCase() and lower() disagree (Turkish dotted I among others), and a
     * lookup that misses where the index matches is an insert that collides.
     */
    uniqueIndex('accounts_name_unique').on(sql`lower(${t.name})`),
  ],
);

export const imports = pgTable(
  'imports',
  {
    id: text('id').primaryKey(),
    // sha256 of the raw uploaded bytes - the file on the user's disk, hashed
    // before any decoding, sniffing or parsing (see providers/statement.ts)
    fileHash: text('file_hash').notNull(),
    sourceType: text('source_type', { enum: IMPORT_SOURCE_TYPES }).notNull(),
    originalFilename: text('original_filename'),
    // All three are NULL on every import that never reached the parse, and on
    // every one from before the confirmation step.
    accountName: text('account_name'),
    accountCurrency: text('account_currency'),
    accountId: text('account_id'),
    uploadedAt: text('uploaded_at').notNull(),
    // per parser, keyed by source_type: what makes re-parsing targetable later
    parserVersion: integer('parser_version').notNull(),
    status: text('status', { enum: IMPORT_STATUSES }).notNull(),
    // rows the parser turned into transactions, and rows it could not use. How many
    // of the accepted ones were genuinely new is a COUNT over transactions.import_id
    rowsAccepted: integer('rows_accepted').notNull().default(0),
    rowsRejected: integer('rows_rejected').notNull().default(0),
    // the failure message, truncated; never a stack trace - it lands in the backup
    errorDetail: text('error_detail'),
    // whether the uploaded file can be READ for this row - not whether bytes are on
    // disk: a restored row has this cleared while its file may still be there
    documentStored: boolean('document_stored').notNull().default(false),
  },
  (t) => [
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
      .on(t.fileHash)
      .where(sql`status = 'committed'`),
  ],
);

export const transactions = pgTable(
  'transactions',
  {
    // surrogate: a UUID assigned on insert, never derived from the row's contents
    // and never changing. Annotations and every future foreign key point at this.
    id: text('id').primaryKey(),
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
    // MATCH SIMPLE: with import_id NULL the constraint is not checked at all, which
    // is what the rows no import owns need
    importId: text('import_id').references(() => imports.id, { onDelete: 'cascade' }),
  },
  (t) => [
    // the deduplication rule itself: one transaction per key per account
    uniqueIndex('transactions_dedup_unique').on(t.accountId, t.dedupKey),
    index('idx_tx_account').on(t.accountId),
    index('idx_tx_date').on(t.date),
    // PG does not index a foreign key for you, and the cascade delete scans on this
    index('idx_tx_import').on(t.importId),
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
    primaryKey({ columns: [t.importId, t.rowNo] }),
    // The cascade is what makes deleteImport and restoreBackup's DELETE FROM imports
    // take these with them, with no new delete written anywhere.
    foreignKey({ columns: [t.importId], foreignColumns: [imports.id] }).onDelete('cascade'),
    check('staged_transactions_fee_cents_nonneg', sql`${t.feeCents} >= 0`),
  ],
);

export const fxRates = pgTable(
  'fx_rates',
  {
    date: text('date').notNull(), // YYYY-MM-DD
    currency: text('currency').notNull(), // ISO code
    rate: doublePrecision('rate').notNull(), // base currency per unit of currency
  },
  (t) => [primaryKey({ columns: [t.date, t.currency] })],
);

export const categoryRules = pgTable('category_rules', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  pattern: text('pattern').notNull().unique(), // substring of the description, case-insensitive
  category: text('category').notNull(),
  createdAt: text('created_at').notNull(),
});

export const transferRules = pgTable(
  'transfer_rules',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    description: text('description').notNull(),
    accountId: text('account_id').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('transfer_rules_desc_account_unique').on(t.description, t.accountId)],
);

export const recurringIgnores = pgTable('recurring_ignores', {
  key: text('key').primaryKey(),
  description: text('description').notNull(),
  createdAt: text('created_at').notNull(),
});

export const budgets = pgTable('budgets', {
  category: text('category').primaryKey(),
  monthlyCents: integer('monthly_cents').notNull(),
});

export const baselineItems = pgTable('baseline_items', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  label: text('label').notNull().unique(),
  monthlyCents: integer('monthly_cents').notNull(),
  sort: integer('sort').notNull().default(0),
});

export const incomeSources = pgTable('income_sources', {
  id: text('id').primaryKey(), // slug: salary, family, other, freelance...
  label: text('label').notNull(),
  kind: text('kind', { enum: INCOME_SOURCE_KINDS }).notNull(),
  patterns: text('patterns').notNull().default('[]'), // JSON array of strings
  sort: integer('sort').notNull().default(0),
  // seeded sources: cannot be deleted, automation is keyed on the id
  builtin: boolean('builtin').notNull().default(false),
});

// sql.raw, not a parameter: drizzle-kit serialises a check into DDL, where a
// bound $1 is not a thing. The values are the wire module's `as const` tuples, nothing
// a caller sends.
const inList = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(', ');

/** The list is replaced whole, so `sort` is assigned 0..n-1 on every write. */
export const analyticsCharts = pgTable(
  'analytics_charts',
  {
    // the client's own id, and ?chart= in the URL names it - never minted here
    id: text('id').primaryKey(),
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
     * chart of one account into a chart of every account under its old title.
     */
    accountId: text('account_id'),
    metrics: text('metrics').notNull().default('[]'), // JSON array of measure keys
  },
  (t) => [
    check('analytics_charts_kind', sql`${t.kind} IN (${sql.raw(inList(CHART_KINDS))})`),
    check('analytics_charts_range', sql`${t.range} IN (${sql.raw(inList(CHART_RANGES))})`),
    check(
      'analytics_charts_breakdown',
      sql`${t.breakdown} IN (${sql.raw(inList(CHART_BREAKDOWNS))})`,
    ),
  ],
);

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const meta = pgTable('meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
