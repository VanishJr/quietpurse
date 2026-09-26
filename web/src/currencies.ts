const displayNames = new Intl.DisplayNames('en', { type: 'currency' });

export const CURRENCY_SUGGESTIONS = [
  'EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD', 'JPY', 'PLN', 'SEK', 'NOK', 'DKK', 'INR',
] as const;

export function currencyName(code: string): string | null {
  const normalized = code.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) return null;
  const name = displayNames.of(normalized);
  return name && name !== normalized ? name : null;
}
