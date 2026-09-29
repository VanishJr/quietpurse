// made on first use and guarded, not at module scope: where Intl.DisplayNames is missing,
// a constructor run on import takes the whole app down instead of only the name hint
let displayNames: Intl.DisplayNames | null | undefined;

const names = (): Intl.DisplayNames | null => {
  if (displayNames === undefined) {
    try {
      displayNames = new Intl.DisplayNames('en', { type: 'currency' });
    } catch {
      displayNames = null;
    }
  }
  return displayNames;
};

export const CURRENCY_SUGGESTIONS = [
  'EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD', 'JPY', 'PLN', 'SEK', 'NOK', 'DKK', 'INR',
] as const;

export function currencyName(code: string): string | null {
  const normalized = code.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) return null;
  const name = names()?.of(normalized);
  return name && name !== normalized ? name : null;
}
