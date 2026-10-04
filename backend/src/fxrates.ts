/**
 * Two shapes share the rate cache's key space and have to stay distinguishable: a bare
 * currency means hryvnia per unit of it, and `FROM:TO` means units of `to` per unit of
 * `from`. The bare shape has been written since the first version, so an old cache
 * keeps working only while it keeps that meaning.
 */
import { config } from './config';
import {
  type BaseWrite,
  type FxMiss,
  applyBaseRate,
  currentBaseCurrency,
  getFxRateOrMiss,
  listUnconvertedDays,
  saveFxMiss,
  saveFxRate,
  setBaseForBaseCurrency,
} from './db';
import { logFx } from './logger';

/**
 * No rate, and every answer that said so is a fresh miss - read now or recorded now - so nothing
 * is asked for it again before MISS_AGE_MS has passed. null stays "no rate" for every other reason.
 */
export const REMEMBERED_NONE = Symbol('no rate, remembered');

type Rate = number | null | typeof REMEMBERED_NONE;

export interface RateProvider {
  name: string;
  /** whether the provider handles this pair (without hitting the network) */
  supports: (from: string, to: string) => boolean;
  /** units of `to` per unit of `from` on that day (or the nearest previous) */
  getRate: (day: string, from: string, to: string) => Promise<Rate>;
}

/**
 * A remembered NBU "no rate" is for a day already past, where it means a currency the NBU does not
 * publish, and asking again sooner finds the same: a shorter age buys re-asks that find nothing.
 * What it costs is how long a rate published after the answer waits for the recompute that
 * converts with it.
 */
export const MISS_AGE_MS = 24 * 60 * 60 * 1000;
const MISS_AGE = `${MISS_AGE_MS / (60 * 60 * 1000)} hours`;

/**
 * Ahead of the clock is stale: a clock moved back, or a crafted backup, would otherwise keep a
 * miss fresh until the clock caught up with it.
 */
function fresh(missedAt: string, now = Date.now()): boolean {
  const at = Date.parse(missedAt);
  return at <= now && now - at < MISS_AGE_MS;
}

const FETCH_TIMEOUT_MS = 10_000;

/**
 * Hardcoded because the resolver has to answer "can I do this" synchronously and offline.
 * The hryvnia is not in it, which is why the NBU provider exists - though `supports` below
 * refuses every pair carrying a code outside this set, not the hryvnia's alone.
 */
const ECB_CURRENCIES = new Set([
  'AUD', 'BGN', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'EUR', 'GBP', 'HKD',
  'HUF', 'IDR', 'ILS', 'INR', 'ISK', 'JPY', 'KRW', 'MXN', 'MYR', 'NOK', 'NZD',
  'PHP', 'PLN', 'RON', 'SEK', 'SGD', 'THB', 'TRY', 'USD', 'ZAR',
]);

/**
 * ISO 4217's alphabetic codes: its list of current currencies and funds, and its list of
 * historic denominations. The historic ones stay because a statement can predate the
 * withdrawal of the currency it is in.
 */
const ISO_CURRENCIES = new Set([
  'ADP', 'AED', 'AFA', 'AFN', 'ALK', 'ALL', 'AMD', 'ANG', 'AOA', 'AOK', 'AON',
  'AOR', 'ARA', 'ARP', 'ARS', 'ARY', 'ATS', 'AUD', 'AWG', 'AYM', 'AZM', 'AZN',
  'BAD', 'BAM', 'BBD', 'BDT', 'BEC', 'BEF', 'BEL', 'BGJ', 'BGK', 'BGL', 'BGN',
  'BHD', 'BIF', 'BMD', 'BND', 'BOB', 'BOP', 'BOV', 'BRB', 'BRC', 'BRE', 'BRL',
  'BRN', 'BRR', 'BSD', 'BTN', 'BUK', 'BWP', 'BYB', 'BYN', 'BYR', 'BZD', 'CAD',
  'CDF', 'CHC', 'CHE', 'CHF', 'CHW', 'CLF', 'CLP', 'CNY', 'COP', 'COU', 'CRC',
  'CSD', 'CSJ', 'CSK', 'CUC', 'CUP', 'CVE', 'CYP', 'CZK', 'DDM', 'DEM', 'DJF',
  'DKK', 'DOP', 'DZD', 'ECS', 'ECV', 'EEK', 'EGP', 'ERN', 'ESA', 'ESB', 'ESP',
  'ETB', 'EUR', 'FIM', 'FJD', 'FKP', 'FRF', 'GBP', 'GEK', 'GEL', 'GHC', 'GHP',
  'GHS', 'GIP', 'GMD', 'GNE', 'GNF', 'GNS', 'GQE', 'GRD', 'GTQ', 'GWE', 'GWP',
  'GYD', 'HKD', 'HNL', 'HRD', 'HRK', 'HTG', 'HUF', 'IDR', 'IEP', 'ILP', 'ILR',
  'ILS', 'INR', 'IQD', 'IRR', 'ISJ', 'ISK', 'ITL', 'JMD', 'JOD', 'JPY', 'KES',
  'KGS', 'KHR', 'KMF', 'KPW', 'KRW', 'KWD', 'KYD', 'KZT', 'LAJ', 'LAK', 'LBP',
  'LKR', 'LRD', 'LSL', 'LSM', 'LTL', 'LTT', 'LUC', 'LUF', 'LUL', 'LVL', 'LVR',
  'LYD', 'MAD', 'MDL', 'MGA', 'MGF', 'MKD', 'MLF', 'MMK', 'MNT', 'MOP', 'MRO',
  'MRU', 'MTL', 'MTP', 'MUR', 'MVQ', 'MVR', 'MWK', 'MXN', 'MXP', 'MXV', 'MYR',
  'MZE', 'MZM', 'MZN', 'NAD', 'NGN', 'NIC', 'NIO', 'NLG', 'NOK', 'NPR', 'NZD',
  'OMR', 'PAB', 'PEH', 'PEI', 'PEN', 'PES', 'PGK', 'PHP', 'PKR', 'PLN', 'PLZ',
  'PTE', 'PYG', 'QAR', 'RHD', 'ROK', 'ROL', 'RON', 'RSD', 'RUB', 'RUR', 'RWF',
  'SAR', 'SBD', 'SCR', 'SDD', 'SDG', 'SDP', 'SEK', 'SGD', 'SHP', 'SIT', 'SKK',
  'SLE', 'SLL', 'SOS', 'SRD', 'SRG', 'SSP', 'STD', 'STN', 'SUR', 'SVC', 'SYP',
  'SZL', 'THB', 'TJR', 'TJS', 'TMM', 'TMT', 'TND', 'TOP', 'TPE', 'TRL', 'TRY',
  'TTD', 'TWD', 'TZS', 'UAH', 'UAK', 'UGS', 'UGW', 'UGX', 'USD', 'USN', 'USS',
  'UYI', 'UYN', 'UYP', 'UYU', 'UYW', 'UZS', 'VEB', 'VED', 'VEF', 'VES', 'VNC',
  'VND', 'VUV', 'WST', 'XAD', 'XAF', 'XAG', 'XAU', 'XBA', 'XBB', 'XBC', 'XBD',
  'XCD', 'XCG', 'XDR', 'XEU', 'XFO', 'XFU', 'XOF', 'XPD', 'XPF', 'XPT', 'XRE',
  'XSU', 'XTS', 'XUA', 'XXX', 'YDD', 'YER', 'YUD', 'YUM', 'YUN', 'ZAL', 'ZAR',
  'ZMK', 'ZMW', 'ZRN', 'ZRZ', 'ZWC', 'ZWD', 'ZWG', 'ZWL', 'ZWN', 'ZWR',
]);

const FRANKFURTER = 'https://api.frankfurter.dev/v1';

export const ecbProvider: RateProvider = {
  name: 'ecb',
  supports: (from, to) => ECB_CURRENCIES.has(from) && ECB_CURRENCIES.has(to),
  async getRate(day, from, to) {
    const cacheKey = `${from}:${to}`;
    const miss: FxMiss = { provider: 'ecb', day, from, to };
    const known = await getFxRateOrMiss(cacheKey, miss);
    if (known && 'rate' in known) return known.rate;
    if (known && fresh(known.missedAt)) return REMEMBERED_NONE;

    const url = `${FRANKFURTER}/${day}?base=${encodeURIComponent(from)}&symbols=${encodeURIComponent(to)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`frankfurter ${url} -> ${res.status}`);
    const data = (await res.json()) as { rates?: Record<string, number> };
    const rates = data.rates;
    const ratesObject = typeof rates === 'object' && rates !== null && !Array.isArray(rates);
    if (ratesObject && !Object.hasOwn(rates, to)) {
      await saveFxMiss(miss);
      return REMEMBERED_NONE;
    }
    const rate = rates?.[to];
    if (typeof rate !== 'number' || rate <= 0) return null;
    await saveFxRate(day, cacheKey, rate);
    return rate;
  },
};

const NBU = 'https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange';
/** how many days back to look for a rate if the NBU didn't publish one for the requested date */
export const MAX_LOOKBACK_DAYS = 7;

function shiftDay(day: string, deltaDays: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

interface NbuRow {
  rate: number;
  cc: string;
}

const MISSED = Symbol('the NBU has no rate for that day');

/**
 * NBU rate (hryvnia per unit of currency) for exactly that day, no fallbacks. MISSED = it answered
 * that it has none for a day already past, recorded here; null = any other answer that is not a
 * rate.
 */
async function fetchNbuRate(currency: string, day: string): Promise<number | typeof MISSED | null> {
  const url = `${NBU}?valcode=${encodeURIComponent(currency)}&date=${day.replace(/-/g, '')}&json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`NBU ${url} -> ${res.status}`);
  const rows = (await res.json()) as NbuRow[];
  if (Array.isArray(rows) && rows.length === 0) {
    // a day the NBU has not set yet answers the same; remembered, it would be skipped once its
    // rate is out, and the lookback would cache the day before's under it for good
    if (day >= new Date().toISOString().slice(0, 10)) return null;
    await saveFxMiss({ provider: 'nbu', day, currency });
    return MISSED;
  }
  const rate = rows[0]?.rate;
  return typeof rate === 'number' && rate > 0 ? rate : null;
}

/** Throws on a network error - the caller decides what to do. */
export async function rateToUah(currency: string, day: string): Promise<Rate> {
  if (currency === 'UAH') return 1;
  let everyProbeMissed = true;
  for (let back = 0; back <= MAX_LOOKBACK_DAYS; back++) {
    const probeDay = shiftDay(day, -back);
    const known = await getFxRateOrMiss(currency, { provider: 'nbu', day: probeDay, currency });
    if (known && 'rate' in known) {
      if (back > 0) await saveFxRate(day, currency, known.rate);
      return known.rate;
    }
    // a fresh miss is a fact about probeDay alone: it skips that day's request and never
    // ends the lookback
    if (known && fresh(known.missedAt)) continue;
    const rate = await fetchNbuRate(currency, probeDay);
    if (rate === MISSED) continue;
    if (rate === null) {
      everyProbeMissed = false;
      continue;
    }
    // cache it under the REQUESTED day: weekends always resolve to Friday, and
    // a repeat request for the same day then never goes to the network
    await saveFxRate(day, currency, rate);
    return rate;
  }
  return everyProbeMissed ? REMEMBERED_NONE : null;
}

export const nbuProvider: RateProvider = {
  name: 'nbu',
  // cross-rate through UAH: whether the NBU publishes both legs is not known in advance,
  // so any two codes count - and getRate answers no rate if not. Codes only: each one goes
  // into a request
  supports: (from, to) => ISO_CURRENCIES.has(from) && ISO_CURRENCIES.has(to),
  async getRate(day, from, to) {
    const rFrom = await rateToUah(from, day);
    const rTo = await rateToUah(to, day);
    if (rFrom === null || rTo === null || rTo === 0) return null;
    if (rFrom === REMEMBERED_NONE || rTo === REMEMBERED_NONE) return REMEMBERED_NONE;
    return rFrom / rTo;
  },
};

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
 * The first rate a provider that handles the pair has. REMEMBERED_NONE = every provider that
 * handles it answered so, and a provider's remembered answer is never the pair's while another
 * is left to ask; null = no provider can do it, or no rate for another reason. The caller logs
 * either. Network errors propagate.
 */
export async function resolveRate(day: string, from: string, to: string): Promise<Rate> {
  if (from === to) return 1;
  let supported = false;
  let everyAnswerRemembered = true;
  for (const p of activeProviders()) {
    if (!p.supports(from, to)) continue;
    supported = true;
    const rate = await p.getRate(day, from, to);
    if (typeof rate === 'number') return rate;
    if (rate === null) everyAnswerRemembered = false;
  }
  return supported && everyAnswerRemembered ? REMEMBERED_NONE : null;
}

/**
 * drizzle wraps every driver error in one whose message is the SQL and the bound
 * parameters, with the reason one `cause` deeper - so the outer message reads like a
 * diagnosis and is not one. Not causeChain() from logger.ts: the whole chain leads with
 * that statement and every bound value, which is the noise this exists to drop.
 */
function sqlReason(e: unknown): string {
  const c = (e as { cause?: { message?: string; code?: string } })?.cause;
  const msg = c?.message ?? (e as Error).message;
  return c?.code ? `[${c.code}] ${msg}` : msg;
}

/** How many runs are refilling base amounts right now: callers overlap, so a count. */
let running = 0;

export const baseAmountsConverting = (): boolean => running > 0;

/**
 * Neither a network error nor a failed write fails the call: those rows stay NULL and
 * are picked up on the next recompute. The fetch and the write are caught apart so that
 * the wording of one can never describe the other - a whole account went unconverted for
 * months behind a line that said the rate had not been fetched.
 * @returns how many rows got a base_amount
 */
export async function backfillBaseAmounts(
  log: (s: string) => void = (s) => logFx.info(s),
): Promise<number> {
  // before the first await, so a caller that starts one and answers at once has already
  // made it visible to the next read of baseAmountsConverting
  running += 1;
  try {
    return await fillBaseAmounts(log);
  } finally {
    running -= 1;
  }
}

async function fillBaseAmounts(log: (s: string) => void): Promise<number> {
  const base = await currentBaseCurrency();
  const moved = (stored: string, converted: number): number => {
    log(`base currency changed from ${base} to ${stored} during this refill; the refill that change started converts the rest`);
    return converted;
  };
  let own: BaseWrite | undefined;
  try {
    own = await setBaseForBaseCurrency(base);
  } catch (e) {
    log(`base_amount for ${base} not written: ${sqlReason(e)}`);
  }
  if (own?.moved) return moved(own.stored, 0);
  let done = own?.written ?? 0;

  const keys = await listUnconvertedDays();
  if (keys.length === 0) return done;

  // counted in rates rather than days: a key is a (day, currency) pair, so one date
  // carrying two currencies needs two, and all three summary lines use that unit
  log(`converting to ${base}: rates needed: ${keys.length}...`);
  let ratesApplied = 0;
  let attempted = 0;
  let remembered = 0;
  for (const { day, currency } of keys) {
    attempted++;
    let k: Rate;
    try {
      k = await resolveRate(day, currency, base);
    } catch (e) {
      log(`rate ${currency} on ${day} not fetched: ${sqlReason(e)}`);
      // a network error is almost certainly global - don't bother the providers with the rest
      log(`stopping: ${keys.length - attempted} of ${keys.length} rates were not tried this run`);
      break;
    }
    if (k === REMEMBERED_NONE) {
      remembered++;
      log(
        `rate ${currency} -> ${base} on ${day}: no provider has one, by an answer remembered for ${MISS_AGE}; not asked for until it is that old`,
      );
      continue;
    }
    if (k === null || k === 0) {
      log(`rate ${currency} -> ${base} on ${day}: no provider returned one`);
      continue;
    }
    let write: BaseWrite;
    try {
      write = await applyBaseRate(day, currency, k, base);
    } catch (e) {
      // local to one day's rows (an amount whose product overruns an integer, say),
      // so the remaining days still get converted
      log(`base_amount for ${currency} on ${day} not written: ${sqlReason(e)}`);
      continue;
    }
    if (write.moved) return moved(write.stored, done);
    done += write.written;
    ratesApplied++;
  }
  const left = keys.length - ratesApplied;
  if (left > 0) {
    log(
      remembered === 0
        ? `rates left unapplied: ${left} of ${keys.length} (picked up on the next recompute)`
        : `rates left unapplied: ${left} of ${keys.length} (${remembered} remembered as having none, asked again once that answer is ${MISS_AGE} old; any other on the next recompute)`,
    );
  }
  log(`transactions converted: ${done}`);
  return done;
}
