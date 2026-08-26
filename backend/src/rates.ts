/** A public endpoint, so there is no credential here to handle and nothing to rotate. */
import { currencyName } from './currency';

const API = 'https://api.monobank.ua';
const CACHE_TTL_MS = 10 * 60 * 1000;
const UAH_CODE = 980;

interface CurrencyInfo {
  currencyCodeA: number;
  currencyCodeB: number;
  date: number;
  rateSell?: number;
  rateBuy?: number;
  rateCross?: number;
}

let cache: { at: number; uahPerUnit: Record<string, number> } | null = null;

/** How many hryvnia one unit of a currency costs (UAH: 980), for converting between currencies. */
export async function getRatesToUAH(): Promise<Record<string, number>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.uahPerUnit;

  let list: CurrencyInfo[];
  try {
    const res = await fetch(`${API}/bank/currency`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Monobank /bank/currency -> ${res.status}`);
    list = (await res.json()) as CurrencyInfo[];
  } catch (e) {
    if (cache) return cache.uahPerUnit; // a stale cache beats an error
    throw e;
  }

  const uahPerUnit: Record<string, number> = { UAH: 1 };
  for (const c of list) {
    if (c.currencyCodeB !== UAH_CODE) continue;
    const rate = c.rateCross ?? (c.rateBuy && c.rateSell ? (c.rateBuy + c.rateSell) / 2 : undefined);
    if (!rate) continue;
    uahPerUnit[currencyName(c.currencyCodeA)] = rate;
  }

  cache = { at: Date.now(), uahPerUnit };
  return uahPerUnit;
}
