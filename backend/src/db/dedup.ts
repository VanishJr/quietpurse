/**
 * The deduplication key format, in one place because two callers depend on it
 * being byte-identical: insertTransactions (./index.ts), which assigns keys to
 * every incoming row, and scripts/migrate-sqlite-to-pg.ts, which reconstructs
 * them for a history imported from the SQLite era. If those two ever disagreed,
 * the first re-import after a migration would duplicate the user's whole history.
 *
 * See ROADMAP 4.2 for why identity and deduplication are separate columns.
 */

/**
 * The key for a provider that has no stable reference of its own (CSV, and the
 * banks that omit entry_reference): the calendar day, the amount in minor units,
 * the currency, and the ordinal among otherwise identical rows.
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
 * another spelling, and a statement date is a calendar day anyway (ROADMAP 4.6).
 */
export const computedDedupKey = (
  day: string,
  amountCents: number,
  currency: string,
  n: number,
): string => `c:${day}|${amountCents}|${currency.toUpperCase()}|${n}`;

/** The group identical rows are numbered within: one account, one day, one amount. */
export const dedupGroup = (
  accountId: string,
  day: string,
  amountCents: number,
  currency: string,
): string => `${accountId}|${day}|${amountCents}|${currency.toUpperCase()}`;
