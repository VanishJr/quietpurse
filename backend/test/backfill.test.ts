/**
 * backfillBaseAmounts and the SQL under it: a resolved rate reaching the rows, the
 * rounding mode money is rounded with, and a log that never describes a failed
 * write as a failed fetch.
 *
 * **The fixture rate must have a fractional part.** At k = 1 the unfixed statement
 * does not merely pass, it writes the raw foreign-currency amount as base cents, so
 * a whole rate disarms this whole file. The Number.isInteger assertion in the first
 * case is what holds that; this sentence is for whoever edits UAH_PER_EUR.
 *
 * Offline by construction, so setup.ts's rejecting fetch is never reached: UAH is
 * not an ECB currency, so resolveRate falls to the NBU provider, whose UAH leg is
 * the constant 1 and whose EUR leg reads fx_rates under the bare 'EUR' key. One
 * saveFxRate per day therefore fixes k with no network at all - and a day left
 * unseeded is how the fetch failure is provoked.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createAccount,
  dbInstance,
  insertTransactions,
  resetBaseAmounts,
  saveFxRate,
  seedDefaults,
} from '../src/db';
import { backfillBaseAmounts } from '../src/fxrates';
import { toCents } from '../src/money';
import { NewTransaction } from '../src/types';

/** Hryvnia per euro. Fractional on purpose - see the header. */
const UAH_PER_EUR = 51.0334;
/** What resolveRate answers for UAH -> EUR: euros per hryvnia. */
const K = 1 / UAH_PER_EUR;
/** One hryvnia row and one euro row, so a single call covers both arms of the backfill. */
const UAH_AMOUNT = -1118.21;
const EUR_AMOUNT = -12.34;
/** Hryvnia per lari, and a lari row to spend it on. GEL is not an ECB currency either. */
const UAH_PER_GEL = 15.2891;
const K_GEL = UAH_PER_GEL / UAH_PER_EUR;
const GEL_AMOUNT = -45.67;

const CONVERTED_DAY = '2026-05-04';
const HALF_CENT_DAY = '2026-05-05';
const OVERFLOW_DAY = '2026-05-06';
/** After OVERFLOW_DAY, so the loop reaches it only if a failed write lets the run go on. */
const AFTER_OVERFLOW_DAY = '2026-05-07';
const UNSEEDED_DAY = '2026-05-08';
/** After UNSEEDED_DAY, so listUnconvertedDays' ORDER BY day reaches the broken one first. */
const SEEDED_DAY = '2026-05-09';
/** Two currencies on this one date - two rates and one day. */
const TWO_RATE_DAY = '2026-05-10';
const ACCOUNT_NUMBER = 'PL61109010140000071219812874';
const ACCOUNT_NUMBER_DAY = '2026-04-01';
const NOT_A_CODE = 'TAX';
const NOT_A_CODE_DAY = '2026-04-01';
/** Hryvnia per kuna. The kuna is withdrawn, and it is not an ECB currency either. */
const UAH_PER_HRK = 4.0712;
const K_HRK = UAH_PER_HRK / UAH_PER_EUR;
const HRK_AMOUNT = -75.5;
const HRK_DAY = '2022-06-15';

/** ROUND(numeric) is half away from zero; Math.round is half toward +infinity. */
const roundHalfAway = (n: number): number => (n < 0 ? -Math.round(-n) : Math.round(n));

let accountId: string;

const tx = (over: Partial<NewTransaction>): NewTransaction => ({
  accountId,
  provider: 'upload',
  amount: 0,
  currency: 'UAH',
  date: `${CONVERTED_DAY}T09:00:00.000Z`,
  description: '',
  category: 'other',
  fee: null,
  ...over,
});

interface StoredRow {
  description: string;
  base_amount_cents: number | null;
  fx_rate: number | null;
}

/**
 * The stored columns, not the domain type: Transaction carries base_amount as a
 * decimal and no fx_rate at all, and both of those are what this file is about.
 * Plain columns rather than an aggregate - COUNT comes back as a string on
 * node-postgres and a number on PGlite.
 */
async function rowOf(description: string): Promise<StoredRow> {
  const res = (await dbInstance().execute(sql`
    SELECT description, base_amount_cents, fx_rate FROM transactions
    WHERE description = ${description}`)) as unknown as {
    rows: StoredRow[];
  };
  if (res.rows.length !== 1) {
    throw new Error(`expected one row described "${description}", found ${res.rows.length}`);
  }
  return res.rows[0];
}

beforeAll(async () => {
  const made = await createAccount({ name: 'Hryvnia', currency: 'UAH' });
  if (!made.ok) throw new Error(`could not create the account: ${made.reason}`);
  accountId = made.account.id;
});

async function clearWorkspaceRows(): Promise<void> {
  await dbInstance().execute(sql`DELETE FROM transactions`);
  await dbInstance().execute(sql`DELETE FROM fx_rates`);
}

/**
 * Each case owns the whole unconverted set: a row a previous case deliberately left
 * NULL would otherwise be re-listed here and add lines to somebody else's log
 * assertions. freshTestDb() is the wrong tool - it truncates organization too.
 */
beforeEach(clearWorkspaceRows);

/**
 * And this file cleans up after itself where its neighbours don't: setup.ts truncates
 * once for the whole run, and these cases end holding rows in the one state the
 * conversion path keys on - base_amount_cents IS NULL - which every later file that
 * drives an import would otherwise walk through backfillBaseAmounts.
 */
afterAll(clearWorkspaceRows);

describe('backfillBaseAmounts', () => {
  it('a resolved fractional rate reaches the rows, and the base-currency rows keep their own cents', async () => {
    // At k = 1 the unfixed statement passes and writes the raw foreign-currency
    // amount as base cents, so a rate without a fractional part disarms this file.
    expect(Number.isInteger(K)).toBe(false);

    const rows = [
      tx({ amount: UAH_AMOUNT, description: 'kyiv taxi' }),
      tx({ amount: EUR_AMOUNT, currency: 'EUR', description: 'berlin coffee' }),
    ];
    await saveFxRate(CONVERTED_DAY, 'EUR', UAH_PER_EUR);
    expect(await insertTransactions(rows)).toBe(rows.length);
    // the state a base-currency change leaves behind (app.ts): every base_amount
    // NULL, so one call covers setBaseForBaseCurrency and applyBaseRate both
    expect(await resetBaseAmounts()).toBe(rows.length);

    const lines: string[] = [];
    const converted = await backfillBaseAmounts((s) => lines.push(s));
    // The refusal from the other side, and the reason it is asserted before the count: a
    // write that threw arrives here with its SQLSTATE, where the count alone would
    // only say a number was short.
    expect(lines.join('\n')).not.toContain('not written');
    // a run that applied every rate must not also claim one was left over:
    // ratesApplied is what keeps the summary and the outcome from contradicting
    expect(lines.join('\n')).not.toContain('rates left unapplied');
    expect(converted).toBe(rows.length);

    const uah = await rowOf('kyiv taxi');
    expect(uah.base_amount_cents).toBe(roundHalfAway(toCents(UAH_AMOUNT) * K));
    expect(uah.fx_rate).toBe(K);
    const eur = await rowOf('berlin coffee');
    expect(eur.base_amount_cents).toBe(toCents(EUR_AMOUNT));
    expect(eur.fx_rate).toBe(1);
  });

  it('rounds half away from zero, on an expense as well as on income', async () => {
    // k = 1/2 exactly, so five cents times it is exactly half a cent: ROUND(numeric)
    // gives 3, ROUND(double precision) gives 2 - which is what ::float8 would buy.
    await saveFxRate(HALF_CENT_DAY, 'EUR', 2);
    await insertTransactions([
      tx({ amount: -0.05, date: `${HALF_CENT_DAY}T09:00:00.000Z`, description: 'half cent out' }),
      tx({ amount: 0.05, date: `${HALF_CENT_DAY}T10:00:00.000Z`, description: 'half cent in' }),
    ]);

    await backfillBaseAmounts(() => {});

    expect((await rowOf('half cent out')).base_amount_cents).toBe(-3);
    expect((await rowOf('half cent in')).base_amount_cents).toBe(3);
  });

  it('a write that fails is reported as a write, and the days after it are still converted', async () => {
    // k = 2, and an amount whose product overruns an integer: the UPDATE throws
    // 22003 server-side while the rate itself resolved perfectly well.
    await saveFxRate(OVERFLOW_DAY, 'EUR', 0.5);
    // the second day is what tells `continue` from `break`: it is reachable only
    // if a failed write leaves the loop running
    await saveFxRate(AFTER_OVERFLOW_DAY, 'EUR', UAH_PER_EUR);
    await insertTransactions([
      tx({ amount: 20_000_000, date: `${OVERFLOW_DAY}T09:00:00.000Z`, description: 'too big' }),
      tx({
        amount: UAH_AMOUNT,
        date: `${AFTER_OVERFLOW_DAY}T09:00:00.000Z`,
        description: 'the day after',
      }),
    ]);

    const lines: string[] = [];
    expect(await backfillBaseAmounts((s) => lines.push(s))).toBe(1);

    const log = lines.join('\n');
    expect(log).toContain('not written');
    expect(log).toContain(OVERFLOW_DAY);
    // the sentence the failure is NOT allowed to arrive as
    expect(log).not.toContain('not fetched');
    // drizzle's own wrapper message, identical on both drivers: its presence would
    // mean the SQL text was logged where the reason belongs
    expect(log).not.toContain('Failed query:');
    // Postgres's SQLSTATE, not a driver's wording
    expect(log).toContain('22003');
    expect(log).toContain('rates left unapplied: 1 of 2');
    expect(log).toContain('transactions converted: 1');
    expect((await rowOf('too big')).base_amount_cents).toBe(null);
    expect((await rowOf('the day after')).base_amount_cents).toBe(
      roundHalfAway(toCents(UAH_AMOUNT) * K),
    );
  });

  it('a fetch failure stops the run and names the days it never tried', async () => {
    await saveFxRate(SEEDED_DAY, 'EUR', UAH_PER_EUR);
    await insertTransactions([
      tx({ amount: -10, date: `${UNSEEDED_DAY}T09:00:00.000Z`, description: 'first day' }),
      tx({ amount: -20, date: `${SEEDED_DAY}T09:00:00.000Z`, description: 'second day' }),
    ]);

    const lines: string[] = [];
    expect(await backfillBaseAmounts((s) => lines.push(s))).toBe(0);

    const log = lines.join('\n');
    expect(log).toContain(`rate UAH on ${UNSEEDED_DAY} not fetched`);
    expect(log).toContain('stopping: 1 of 2 rates were not tried this run');
    // the day whose rate was there all along, left NULL because the run stopped
    expect((await rowOf('second day')).base_amount_cents).toBe(null);
  });

  it('needs one rate per currency on a day, so a single date in two currencies needs two', async () => {
    // neither UAH nor GEL is an ECB currency, so both pairs take the NBU leg and one
    // seeded fx_rates row under each bare key resolves them with no network at all
    await saveFxRate(TWO_RATE_DAY, 'EUR', UAH_PER_EUR);
    await saveFxRate(TWO_RATE_DAY, 'GEL', UAH_PER_GEL);
    await insertTransactions([
      tx({ amount: UAH_AMOUNT, date: `${TWO_RATE_DAY}T09:00:00.000Z`, description: 'kyiv metro' }),
      tx({
        amount: GEL_AMOUNT,
        currency: 'GEL',
        date: `${TWO_RATE_DAY}T10:00:00.000Z`,
        description: 'tbilisi bakery',
      }),
    ]);

    const lines: string[] = [];
    expect(await backfillBaseAmounts((s) => lines.push(s))).toBe(2);

    const log = lines.join('\n');
    expect(log).toContain('rates needed: 2');
    expect(log).not.toContain('rates left unapplied');
    expect((await rowOf('kyiv metro')).base_amount_cents).toBe(
      roundHalfAway(toCents(UAH_AMOUNT) * K),
    );
    expect((await rowOf('tbilisi bakery')).base_amount_cents).toBe(
      roundHalfAway(toCents(GEL_AMOUNT) * K_GEL),
    );
  });

  it('converts under the configured base currency while its setting is missing', async () => {
    const rows = [
      tx({ amount: UAH_AMOUNT, description: 'kyiv taxi' }),
      tx({ amount: EUR_AMOUNT, currency: 'EUR', description: 'berlin coffee' }),
    ];
    await saveFxRate(CONVERTED_DAY, 'EUR', UAH_PER_EUR);
    await insertTransactions(rows);
    try {
      await dbInstance().execute(sql`DELETE FROM settings WHERE key = 'base_currency'`);
      await resetBaseAmounts();

      expect(await backfillBaseAmounts(() => {})).toBe(rows.length);
      expect(await rowOf('kyiv taxi')).toEqual({
        description: 'kyiv taxi',
        base_amount_cents: roundHalfAway(toCents(UAH_AMOUNT) * K),
        fx_rate: K,
      });
      expect(await rowOf('berlin coffee')).toEqual({
        description: 'berlin coffee',
        base_amount_cents: toCents(EUR_AMOUNT),
        fx_rate: 1,
      });
    } finally {
      await seedDefaults();
    }
  });

  it('asks no provider for a rate when the row carries something other than a currency code', async () => {
    await insertTransactions([
      tx({
        amount: -100,
        currency: ACCOUNT_NUMBER,
        date: `${ACCOUNT_NUMBER_DAY}T09:00:00.000Z`,
        description: 'rent april',
      }),
    ]);
    const urls: string[] = [];
    const before = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request) => {
      urls.push(String(input));
      return Promise.reject(new Error('network disabled in tests'));
    }) as typeof fetch;
    try {
      await backfillBaseAmounts(() => {});

      expect(urls).toEqual([]);
      expect((await rowOf('rent april')).base_amount_cents).toBe(null);
    } finally {
      globalThis.fetch = before;
    }
  });

  it('asks no provider for a rate when the row carries three capitals that are no currency code', async () => {
    await insertTransactions([
      tx({
        amount: -100,
        currency: NOT_A_CODE,
        date: `${NOT_A_CODE_DAY}T09:00:00.000Z`,
        description: 'city tax',
      }),
    ]);
    const urls: string[] = [];
    const before = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request) => {
      urls.push(String(input));
      return Promise.reject(new Error('network disabled in tests'));
    }) as typeof fetch;
    try {
      await backfillBaseAmounts(() => {});

      expect(urls).toEqual([]);
      expect((await rowOf('city tax')).base_amount_cents).toBe(null);
    } finally {
      globalThis.fetch = before;
    }
  });

  it('converts a row in a withdrawn currency through the NBU', async () => {
    await saveFxRate(HRK_DAY, 'EUR', UAH_PER_EUR);
    await saveFxRate(HRK_DAY, 'HRK', UAH_PER_HRK);
    await insertTransactions([
      tx({
        amount: HRK_AMOUNT,
        currency: 'HRK',
        date: `${HRK_DAY}T09:00:00.000Z`,
        description: 'split ferry',
      }),
    ]);

    expect(await backfillBaseAmounts(() => {})).toBe(1);
    expect(await rowOf('split ferry')).toEqual({
      description: 'split ferry',
      base_amount_cents: roundHalfAway(toCents(HRK_AMOUNT) * K_HRK),
      fx_rate: K_HRK,
    });
  });
});
