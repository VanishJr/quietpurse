import { currencyKey } from './wire';

// keyed by ISO 4217 numeric code
export const CURRENCY_CODES: Record<number, string> = {
  980: 'UAH', 978: 'EUR', 840: 'USD', 826: 'GBP', 985: 'PLN', 203: 'CZK',
  348: 'HUF', 756: 'CHF', 949: 'TRY', 392: 'JPY', 124: 'CAD', 36: 'AUD',
  208: 'DKK', 578: 'NOK', 752: 'SEK', 946: 'RON', 975: 'BGN',
};

export function currencyName(code: number): string {
  return CURRENCY_CODES[code] || String(code);
}

/** Either case, so whoever stores a match upper-cases it first; tested on trimmed text. */
export const CURRENCY_CODE = /^[A-Za-z]{3}$/;

export { currencyKey };

export const sameCurrency = (a: string, b: string): boolean => currencyKey(a) === currencyKey(b);
