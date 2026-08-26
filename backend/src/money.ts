/**
 * Decimal amount -> integer cents, rounding half away from zero to match the SQLite
 * ROUND() the rows were first converted with.
 *
 * Floats cannot represent 0.1 exactly, so a sum of decimal amounts drifts; integer
 * cents is what makes a SUM exact. toPrecision(15) first, because 1.005 * 100 is
 * 100.49999999999999 in binary floating point and a naive Math.round gives 100
 * instead of 101.
 */
export function toCents(amount: number): number {
  const scaled = Number((amount * 100).toPrecision(15));
  return scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
}

/** Integer cents -> decimal amount, for the domain types and the API. */
export function fromCents(cents: number): number {
  return cents / 100;
}

/** base_amount is NULL until the exchange rate for that date is fetched. */
export function toCentsOrNull(amount: number | null | undefined): number | null {
  return amount === null || amount === undefined ? null : toCents(amount);
}

export function fromCentsOrUndefined(cents: number | null): number | undefined {
  return cents === null ? undefined : fromCents(cents);
}
