/**
 * Transaction ids are surrogate UUIDs assigned on insert (ROADMAP 4.2), so a test
 * can no longer choose one and use it afterwards. It inserts rows and looks the
 * id back up by whatever actually distinguishes the row - which is closer to how
 * the app works anyway: the client gets its ids from a list endpoint too.
 */
import { allTransactions } from '../src/db';
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
