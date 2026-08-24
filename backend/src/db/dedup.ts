/**
 * The key for a provider that has no stable reference of its own (an uploaded
 * statement in any format, and the banks that omit entry_reference): the calendar
 * day, the amount in minor units, the currency, and the ordinal among otherwise
 * identical rows.
 *
 * **The description is deliberately not in here**, which looks like an omission
 * and is not. It is the least stable field a parser produces: with the
 * description in the key, an improved parser that extracts "REWE SAGT DANKE
 * 12345" where it used to extract "REWE SAGT DANKE" would turn every affected
 * row into a second transaction across the user's entire history - an
 * improvement that presents as data corruption. Normalising the description
 * instead only hides the problem, since the normalisation is itself
 * parser-dependent. The ordinal covers the one case the description would have
 * earned its place on: two identical coffees on the same day.
 *
 * The calendar day rather than the stored instant, for the same reason: a
 * re-export that shifts a booking time by a second is the same instability in
 * another spelling, and a statement date is a calendar day anyway.
 */
export const COMPUTED_PREFIX = 'c:';

export const computedDedupKey = (
  day: string,
  amountCents: number,
  currency: string,
  n: number,
): string => `${COMPUTED_PREFIX}${day}|${amountCents}|${currency.toUpperCase()}|${n}`;

/** The group identical rows are numbered within: one account, one day, one amount. */
export const dedupGroup = (
  accountId: string,
  day: string,
  amountCents: number,
  currency: string,
): string => `${accountId}|${day}|${amountCents}|${currency.toUpperCase()}`;

/**
 * The ordinals in a group must stay dense 1..n, because insertTransactions
 * numbers an incoming batch from 1 and lets the unique index reject the
 * collisions - with a hole, a batch of k rows inserts more than it should.
 * Deleting an import punches holes, so deleteImport renumbers the groups it
 * touched, and the helpers below are how it takes a key apart and puts it back
 * together.
 */

const computedKeyGroup = (dedupKey: string): string =>
  dedupKey.slice(0, dedupKey.lastIndexOf('|'));

/**
 * The prefix every key in a group shares and no other group's key begins with -
 * the trailing separator is what makes that true. This is the only shape of the
 * key that leaves this file: deleteImport hands it to SQL as an opaque string,
 * so the format is still owned here. Only computed keys have a group at all; a
 * provider reference (mono:, eb:) is opaque and is never renumbered, which is
 * what COMPUTED_PREFIX selects on.
 */
export const computedGroupPrefix = (dedupKey: string): string =>
  `${computedKeyGroup(dedupKey)}|`;

export const computedKeyOrdinal = (dedupKey: string): number =>
  Number(dedupKey.slice(dedupKey.lastIndexOf('|') + 1));

export const withOrdinal = (dedupKey: string, n: number): string =>
  `${computedKeyGroup(dedupKey)}|${n}`;

/**
 * A key that cannot collide with anything: renumbering moves rows through this
 * namespace first, since writing the final keys directly would trip the unique
 * index whenever a target slot is still held by a row that has not moved yet.
 * The transaction id makes it unique within the workspace.
 */
export const parkedDedupKey = (transactionId: string): string => `park:${transactionId}`;
