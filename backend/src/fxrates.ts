/**
 * Historical exchange rates and filling in base_amount - a transaction's amount in
 * the base currency (config.baseCurrency) at the rate on its date.
 *
 * Providers (the RateProvider interface, resolver below):
 *  - ECB via frankfurter.dev - the default: ~30 currencies, no key, history since 1999;
 *  - NBU - for pairs involving the hryvnia (the ECB doesn't publish it): the official
 *    rate for any day since 1996, cross-rate through UAH.
 * A pair no provider can handle produces a clear error in the log rather than silent
 * NULLs. The order can be overridden: FX_PROVIDER=ecb|nbu (auto by default).
 *
 * The cache is the fx_rates table, and it never expires (a historical rate doesn't change):
 *  - NBU rows: (day, 'EUR') -> hryvnia per unit - the format has been alive since the
 *    first version, so an old cache keeps working;
 *  - ECB rows: (day, 'USD:EUR') -> units of `to` per unit of `from`.
 * Providers publish no rate on weekends - the nearest previous day is used
 * (frankfurter does this itself; for the NBU there's a lookback of up to 7 days).
 */
import { config } from './config';
import {
  applyBaseRate,
  currentBaseCurrency,
  getFxRate,
  listUnconvertedDays,
  saveFxRate,
  setBaseForBaseCurrency,
} from './db';
import { logFx } from './logger';

export interface RateProvider {
  name: string;
  /** whether the provider handles this pair (without hitting the network) */
  supports: (from: string, to: string) => boolean;
  /** units of `to` per unit of `from` on that day (or the nearest previous); null = no rate */
  getRate: (day: string, from: string, to: string) => Promise<number | null>;
}

const FETCH_TIMEOUT_MS = 10_000;

// ---------- ECB (frankfurter.dev) ----------

/**
 * ECB currencies (frankfurter.dev/v1/currencies). The list has been stable for years,
 * so it is hardcoded: the resolver needs to answer "can I do this" synchronously and offline.
 */
const ECB_CURRENCIES = new Set([
  'AUD', 'BGN', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'EUR', 'GBP', 'HKD',
  'HUF', 'IDR', 'ILS', 'INR', 'ISK', 'JPY', 'KRW', 'MXN', 'MYR', 'NOK', 'NZD',
  'PHP', 'PLN', 'RON', 'SEK', 'SGD', 'THB', 'TRY', 'USD', 'ZAR',
]);

const FRANKFURTER = 'https://api.frankfurter.dev/v1';

export const ecbProvider: RateProvider = {
  name: 'ecb',
  supports: (from, to) => ECB_CURRENCIES.has(from) && ECB_CURRENCIES.has(to),
  async getRate(day, from, to) {
    const cacheKey = `${from}:${to}`;
    const cached = await getFxRate(day, cacheKey);
    if (cached !== undefined) return cached;

    const url = `${FRANKFURTER}/${day}?base=${encodeURIComponent(from)}&symbols=${encodeURIComponent(to)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`frankfurter ${url} -> ${res.status}`);
    const data = (await res.json()) as { rates?: Record<string, number> };
    const rate = data.rates?.[to];
    if (typeof rate !== 'number' || rate <= 0) return null;
    await saveFxRate(day, cacheKey, rate);
    return rate;
  },
};

// ---------- NBU ----------

const NBU = 'https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange';
/** how many days back to look for a rate if the NBU didn't publish one for the requested date */
const MAX_LOOKBACK_DAYS = 7;

function shiftDay(day: string, deltaDays: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

interface NbuRow {
  rate: number;
  cc: string;
}

/** NBU rate (hryvnia per unit of currency) for exactly that day, no fallbacks. null = the NBU returned nothing. */
async function fetchNbuRate(currency: string, day: string): Promise<number | null> {
  const url = `${NBU}?valcode=${encodeURIComponent(currency)}&date=${day.replace(/-/g, '')}&json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`NBU ${url} -> ${res.status}`);
  const rows = (await res.json()) as NbuRow[];
  const rate = rows[0]?.rate;
  return typeof rate === 'number' && rate > 0 ? rate : null;
}

/**
 * Hryvnia per unit of currency on a day (cache -> NBU -> previous days).
 * Throws on a network error - the caller decides what to do.
 */
export async function rateToUah(currency: string, day: string): Promise<number | null> {
  if (currency === 'UAH') return 1;
  const cached = await getFxRate(day, currency);
  if (cached !== undefined) return cached;

  for (let back = 0; back <= MAX_LOOKBACK_DAYS; back++) {
    const probeDay = shiftDay(day, -back);
    const probeCached = back > 0 ? await getFxRate(probeDay, currency) : undefined;
    const rate = probeCached ?? (await fetchNbuRate(currency, probeDay));
    if (rate !== null && rate !== undefined) {
      // cache it under the REQUESTED day: weekends always resolve to Friday, and
      // a repeat request for the same day then never goes to the network
      await saveFxRate(day, currency, rate);
      return rate;
    }
  }
  return null;
}

export const nbuProvider: RateProvider = {
  name: 'nbu',
  // cross-rate through UAH: the pair counts as supported if the NBU publishes both
  // legs; that is not known in advance, hence "yes" - and getRate returns null if not
  supports: () => true,
  async getRate(day, from, to) {
    const rFrom = await rateToUah(from, day);
    const rTo = await rateToUah(to, day);
    if (rFrom === null || rTo === null || rTo === 0) return null;
    return rFrom / rTo;
  },
};

// ---------- resolver ----------

function activeProviders(): RateProvider[] {
  switch (config.fxProvider) {
    case 'ecb':
      return [ecbProvider];
    case 'nbu':
      return [nbuProvider];
    default:
      return [ecbProvider, nbuProvider];
  }
}

/**
 * Units of `to` per unit of `from` on a day: the first provider that handles the pair.
 * null = no provider can do it, or there is no rate - the caller logs it.
 * Network errors propagate.
 */
export async function resolveRate(day: string, from: string, to: string): Promise<number | null> {
  if (from === to) return 1;
  for (const p of activeProviders()) {
    if (!p.supports(from, to)) continue;
    const rate = await p.getRate(day, from, to);
    if (rate !== null) return rate;
  }
  return null;
}

/**
 * drizzle wraps every driver error in a DrizzleQueryError whose message is the SQL
 * and the bound parameters; the reason is one `cause` deeper. ROADMAP row 70 lost a
 * week to that sentence being logged as if it were the diagnosis.
 * Not causeChain() from logger.ts: the whole chain leads with the statement and every
 * bound parameter, which is the noise this exists to drop.
 */
function sqlReason(e: unknown): string {
  const c = (e as { cause?: { message?: string; code?: string } })?.cause;
  const msg = c?.message ?? (e as Error).message;
  return c?.code ? `[${c.code}] ${msg}` : msg;
}

/**
 * Fills in base_amount for every transaction that doesn't have one yet.
 * Idempotent and cheap once everything is converted (a single SELECT).
 * Neither a network error nor a failed write fails the call: those rows stay NULL
 * and are picked up on the next recompute (after every sync and at startup).
 * The fetch and the write are caught apart so that the wording of one can never
 * describe the other - a whole account went unconverted for months behind a line
 * that said the rate had not been fetched.
 * @returns how many rows got a base_amount
 */
export async function backfillBaseAmounts(
  log: (s: string) => void = (s) => logFx.info(s),
): Promise<number> {
  const base = await currentBaseCurrency();
  let done = await setBaseForBaseCurrency(base);

  const keys = await listUnconvertedDays();
  if (keys.length === 0) return done;

  // counted in rates rather than days: a key is a (day, currency) pair, so one date
  // carrying two currencies needs two, and all three summary lines use that unit
  log(`converting to ${base}: rates needed: ${keys.length}...`);
  let ratesApplied = 0;
  let attempted = 0;
  for (const { day, currency } of keys) {
    attempted++;
    let k: number | null;
    try {
      k = await resolveRate(day, currency, base);
    } catch (e) {
      log(`rate ${currency} on ${day} not fetched: ${sqlReason(e)}`);
      // a network error is almost certainly global - don't bother the providers with the rest
      log(`stopping: ${keys.length - attempted} of ${keys.length} rates were not tried this run`);
      break;
    }
    if (k === null || k === 0) {
      log(`rate ${currency} -> ${base} on ${day}: no provider returned one`);
      continue;
    }
    try {
      done += await applyBaseRate(day, currency, k);
      ratesApplied++;
    } catch (e) {
      // local to one day's rows (an amount whose product overruns an integer, say),
      // so the remaining days still get converted
      log(`base_amount for ${currency} on ${day} not written: ${sqlReason(e)}`);
    }
  }
  const left = keys.length - ratesApplied;
  if (left > 0) {
    log(`rates left unapplied: ${left} of ${keys.length} (picked up on the next recompute)`);
  }
  log(`transactions converted: ${done}`);
  return done;
}
