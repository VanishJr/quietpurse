/**
 * Money is stored in the database as an integer number of minor units (cents) and
 * crosses into the rest of the app as a decimal.
 *
 * Why: floats cannot represent 0.1 exactly, so a sum of REAL amounts drifts. The old
 * schema papered over that with ROUND(..., 2) on every aggregate - the rounding was
 * not a formatting choice, it was damage control. With integer cents SUM() is exact
 * and the ROUND calls are gone.
 *
 * The boundary is deliberately narrow: the *_cents columns exist only inside db.ts,
 * which converts in its row mappers. Domain types (Transaction.amount and friends),
 * the JSON API and the client all keep working in decimals - values there are either
 * displayed or fed into genuinely fractional math (medians, ratios, hours), where
 * integer cents would add ceremony without adding precision.
 */

/**
 * Decimal amount -> integer cents, rounding half away from zero to match SQLite's
 * ROUND() (used by migration 002 to convert the existing rows).
 *
 * toPrecision(15) first: 1.005 * 100 is 100.49999999999999 in binary floating point,
 * and a naive Math.round would give 100 instead of 101.
 */
export function toCents(amount: number): number {
  const scaled = Number((amount * 100).toPrecision(15));
  return scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
}

/** Integer cents -> decimal amount, for the domain types and the API. */
export function fromCents(cents: number): number {
  return cents / 100;
}

/** Nullable variants - base_amount is NULL until the exchange rate is fetched. */
export function toCentsOrNull(amount: number | null | undefined): number | null {
  return amount === null || amount === undefined ? null : toCents(amount);
}

export function fromCentsOrUndefined(cents: number | null): number | undefined {
  return cents === null ? undefined : fromCents(cents);
}
