/**
 * Transaction ids are surrogate UUIDs assigned on insert, so a test
 * can no longer choose one and use it afterwards. It inserts rows and looks the
 * id back up by whatever actually distinguishes the row - which is closer to how
 * the app works anyway: the client gets its ids from a list endpoint too.
 */
import { sql } from 'drizzle-orm';
import {
  allTransactions,
  confirmImport,
  createAccount,
  dbInstance,
  findAccountByName,
} from '../src/db';
import { StatementImportRequest, importStatement } from '../src/providers/statement';
import { Transaction } from '../src/types';

/** The one stored transaction matching the predicate. Throws if it isn't unique. */
export async function findTx(match: (t: Transaction) => boolean): Promise<Transaction> {
  const found = (await allTransactions()).filter(match);
  if (found.length !== 1) {
    throw new Error(`expected exactly one matching transaction, found ${found.length}`);
  }
  return found[0];
}

/** Shorthand for the common case: a row identified by its description. */
export const idOf = async (description: string): Promise<string> =>
  (await findTx((t) => t.description === description)).id;

/**
 * Marks a fabricated import committed, in SQL. There is no data-layer function for
 * this any more and there must not be: confirmImport is the only thing that puts an
 * import into `committed`, and it does so in the same transaction as the rows. This
 * is for fixtures that need a committed import without a real file behind it.
 */
export async function markImportCommitted(
  id: string,
  rowsAccepted: number,
  rowsRejected: number,
): Promise<void> {
  await dbInstance().execute(sql`
    UPDATE imports SET status = 'committed', rows_accepted = ${rowsAccepted},
      rows_rejected = ${rowsRejected}
    WHERE id = ${id}`);
}

/** What an upload used to answer, before it stopped importing anything. */
export interface ImportedStatement {
  accountId: string;
  accountIds: string[];
  inserted: number;
  skipped: number;
  total: number;
  problems: string[];
  importId: string;
  duplicate?: boolean;
  uploadedAt?: string;
}

/**
 * The account an upload's rows go into, created if there is not one of that name
 * yet. It stands exactly where resolveUploadAccountId's branch (a) stood: the cases
 * that reach it are about parsing, deduplication, provenance and documents and
 * merely need AN account - and several of them upload twice under one name and
 * expect one account, which a lookup-then-create reproduces and a bare create does
 * not. The HTTP tests go through POST /api/accounts instead, because the door is
 * what they are about.
 */
export async function accountFor(name: string, currency = 'EUR'): Promise<string> {
  const existing = await findAccountByName(name);
  if (existing) return existing.id;
  const made = await createAccount({ name, currency });
  if (!made.ok) throw new Error(`could not create account "${name}": ${made.reason}`);
  return made.account.id;
}

/**
 * The Error a refusal rejected with. Not a cast: a call that RESOLVES is a
 * regression from a refusal into an acceptance, and this says so in one sentence
 * instead of a matcher error or a TypeError on `undefined` at whichever line read
 * `.message` first.
 */
export async function rejectionOf(attempt: Promise<unknown>): Promise<Error> {
  let resolved: unknown;
  try {
    resolved = await attempt;
  } catch (e) {
    if (e instanceof Error) return e;
    throw new Error(`expected a refusal, and it rejected with a non-Error: ${String(e)}`);
  }
  throw new Error(`expected a refusal, and it resolved: ${JSON.stringify(resolved)}`);
}

/**
 * Upload and confirm in one call, answering in the shape the upload had before the
 * confirmation step existed. It is here so that the cases about
 * parsing, deduplication and provenance keep asserting exactly what they asserted
 * before - a test rewritten around the new response is no longer evidence that the
 * old guarantee still holds.
 *
 * The confirmation step itself is deliberately NOT tested through this: see
 * confirmation.test.ts, which drives importStatement and confirmImport apart.
 */
export async function importAndConfirm(
  req: StatementImportRequest,
): Promise<ImportedStatement> {
  const staged = await importStatement(req);
  if (staged.outcome === 'duplicate') {
    const { outcome: _outcome, ...rest } = staged;
    return { ...rest, inserted: 0, problems: [], duplicate: true };
  }
  const { summary } = staged;
  const confirmed = await confirmImport(summary.importId);
  if (!confirmed || !confirmed.confirmed) {
    throw new Error(`confirming ${summary.importId} failed: ${JSON.stringify(confirmed)}`);
  }
  return {
    accountId: confirmed.accountId,
    accountIds: confirmed.accountIds,
    inserted: confirmed.inserted,
    skipped: summary.skipped,
    total: summary.total,
    problems: summary.problems,
    importId: summary.importId,
  };
}
