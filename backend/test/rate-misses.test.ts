/**
 * A miss's recorded time is planted through the data layer and the clock is never moved: a
 * faked timer also stops the timeouts the fetch and the idle hook run on, and a faked Date
 * left behind under isolate: false runs every later file in a moved clock.
 */
import { sql } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { reclassifyAll } from '../src/classify';
import {
  type FxMiss,
  FX_MISS_PREFIX,
  countUnconverted,
  createAccount,
  dbInstance,
  getFxRate,
  getFxRateOrMiss,
  insertTransactions,
  saveFxMiss,
  saveFxRate,
} from '../src/db';
import { MAX_LOOKBACK_DAYS, MISS_AGE_MS, backfillBaseAmounts } from '../src/fxrates';
import { NewTransaction } from '../src/types';
import { type Agent, serve } from './loopback';

const NBU = 'https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange';
const FRANKFURTER = 'https://api.frankfurter.dev/v1/';
const DAY = '2026-03-02';
const UAH_PER_EUR = 48.25;
const UAH_PER_GEL = 15.2891;
const UAH_PER_USD = 41.37;
const AGE = `${MISS_AGE_MS / (60 * 60 * 1000)} hours`;

const realFetch = globalThis.fetch;
let accountId: string;
let agent: Agent;

const shift = (day: string, deltaDays: number): string => {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
};

const probeDays = (day: string): string[] =>
  Array.from({ length: MAX_LOOKBACK_DAYS + 1 }, (_, back) => shift(day, -back));

const row = (currency: string, day: string, description: string): NewTransaction => ({
  accountId,
  provider: 'upload',
  amount: -100,
  currency,
  date: `${day}T09:00:00.000Z`,
  description,
  category: 'other',
  fee: null,
});

const json = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), { status });

type Answer = Response | Error;

/**
 * Anything but the two rate providers is rejected, never answered: Monobank, which a recompute
 * asks first, keeps a list it was answered with in memory for the rest of the process.
 */
function network(answers: {
  nbu?: (currency: string, day: string) => Answer;
  frankfurter?: (day: string, from: string, to: string) => Answer;
}) {
  const asked = {
    nbu: [] as { currency: string; day: string }[],
    frankfurter: [] as { day: string; from: string; to: string }[],
  };
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = new URL(String(input));
    let answer: Answer = new Error('network disabled in tests');
    if (String(input).startsWith(NBU)) {
      const currency = url.searchParams.get('valcode') ?? '';
      const d = url.searchParams.get('date') ?? '';
      const day = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
      asked.nbu.push({ currency, day });
      if (answers.nbu) answer = answers.nbu(currency, day);
    } else if (String(input).startsWith(FRANKFURTER)) {
      const day = url.pathname.split('/').pop() ?? '';
      const from = url.searchParams.get('base') ?? '';
      const to = url.searchParams.get('symbols') ?? '';
      asked.frankfurter.push({ day, from, to });
      if (answers.frankfurter) answer = answers.frankfurter(day, from, to);
    }
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  }) as typeof fetch;
  return asked;
}

async function stored(description: string): Promise<{ base: number | null; k: number | null }> {
  const res = (await dbInstance().execute(sql`
    SELECT base_amount_cents AS base, fx_rate AS k FROM transactions
    WHERE description = ${description}`)) as unknown as {
    rows: { base: number | null; k: number | null }[];
  };
  expect(res.rows, description).toHaveLength(1);
  return res.rows[0];
}

const nbuMiss = (day: string, currency: string): FxMiss => ({ provider: 'nbu', day, currency });
const ecbMiss = (day: string, from: string, to: string): FxMiss => ({
  provider: 'ecb',
  day,
  from,
  to,
});

beforeAll(async () => {
  const made = await createAccount({ name: 'Remembered Misses', currency: 'EUR' });
  if (!made.ok) throw new Error(`could not create the account: ${made.reason}`);
  accountId = made.account.id;
  agent = await serve(app);
});

/**
 * Misses outlive the case that recorded them, and one left behind would suppress a request
 * the next case counts.
 */
beforeEach(async () => {
  await dbInstance().execute(sql`DELETE FROM transactions`);
  await dbInstance().execute(sql`DELETE FROM fx_rates`);
  await dbInstance().execute(sql`DELETE FROM meta WHERE starts_with(key, ${FX_MISS_PREFIX})`);
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('a remembered "no rate"', () => {
  it('a currency the NBU answers with no rate is not asked for again by the next recompute', async () => {
    const days = ['2026-03-02', '2026-03-03', '2026-03-04'];
    await insertTransactions(days.map((day) => row('ARS', day, `pesos ${day}`)));
    const asked = network({
      nbu: (currency) => json(currency === 'EUR' ? [{ cc: 'EUR', rate: UAH_PER_EUR }] : []),
    });

    await reclassifyAll();
    const first = asked.nbu.length;
    const pesoDays = asked.nbu.filter((a) => a.currency === 'ARS').map((a) => a.day);
    await reclassifyAll();

    expect(first).toBeGreaterThan(0);
    expect(new Set(pesoDays).size, 'a day asked twice in one run').toBe(pesoDays.length);
    expect(asked.nbu.slice(first)).toEqual([]);
    expect(await countUnconverted()).toBe(days.length);
  });

  it('keeps the rows it covers without a base amount, counted, and says so in the log', async () => {
    await insertTransactions([row('ARS', DAY, 'remembered pesos')]);
    await saveFxRate(DAY, 'EUR', UAH_PER_EUR);
    for (const day of probeDays(DAY)) await saveFxMiss(nbuMiss(day, 'ARS'));
    const asked = network({});
    const lines: string[] = [];

    expect(await backfillBaseAmounts((s) => lines.push(s))).toBe(0);

    expect(asked).toEqual({ nbu: [], frankfurter: [] });
    expect(await stored('remembered pesos')).toEqual({ base: null, k: null });
    const res = await agent.get('/api/conversion');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ baseCurrency: 'EUR', converting: false, unconverted: 1 });
    const log = lines.join('\n');
    expect(log).toContain(
      `rate ARS -> EUR on ${DAY}: no provider has one, by an answer remembered for ${AGE}; not asked for until it is that old`,
    );
    expect(log).toContain(
      `rates left unapplied: 1 of 1 (1 remembered as having none, asked again once that answer is ${AGE} old; any other on the next recompute)`,
    );
    expect(log).not.toContain('picked up on the next recompute');
  });

  it('is asked again once it is older than the age, and recorded afresh', async () => {
    await insertTransactions([row('ARS', DAY, 'stale pesos')]);
    await saveFxRate(DAY, 'EUR', UAH_PER_EUR);
    const planted = new Date(Date.now() - MISS_AGE_MS - 60_000);
    for (const day of probeDays(DAY)) await saveFxMiss(nbuMiss(day, 'ARS'), planted);
    const asked = network({ nbu: () => json([]) });
    const before = Date.now();

    await backfillBaseAmounts(() => {});

    expect(asked.nbu).toEqual(probeDays(DAY).map((day) => ({ currency: 'ARS', day })));
    for (const day of probeDays(DAY)) {
      const known = await getFxRateOrMiss('ARS', nbuMiss(day, 'ARS'));
      expect(known, day).toEqual({ missedAt: expect.any(String) });
      expect(Date.parse((known as { missedAt: string }).missedAt), day).toBeGreaterThanOrEqual(before);
    }
  });

  it('is asked again when it was recorded ahead of the clock', async () => {
    await insertTransactions([row('ARS', DAY, 'future pesos')]);
    await saveFxRate(DAY, 'EUR', UAH_PER_EUR);
    const planted = new Date(Date.now() + 60 * 60 * 1000);
    for (const day of probeDays(DAY)) await saveFxMiss(nbuMiss(day, 'ARS'), planted);
    const asked = network({ nbu: () => json([]) });

    await backfillBaseAmounts(() => {});

    expect(asked.nbu).toEqual(probeDays(DAY).map((day) => ({ currency: 'ARS', day })));
  });

  it('from Frankfurter is asked again once it is older than the age', async () => {
    await insertTransactions([row('USD', DAY, 'stale dollars')]);
    const planted = new Date(Date.now() - MISS_AGE_MS - 60_000);
    await saveFxMiss(ecbMiss(DAY, 'USD', 'EUR'), planted);
    const asked = network({ frankfurter: () => json({ rates: { EUR: 0.9 } }) });

    await backfillBaseAmounts(() => {});

    expect(asked.frankfurter).toEqual([{ day: DAY, from: 'USD', to: 'EUR' }]);
    expect((await stored('stale dollars')).k).toBe(0.9);
  });

  it('from Frankfurter is asked again when it was recorded ahead of the clock', async () => {
    await insertTransactions([row('USD', DAY, 'future dollars')]);
    const planted = new Date(Date.now() + 60 * 60 * 1000);
    await saveFxMiss(ecbMiss(DAY, 'USD', 'EUR'), planted);
    const asked = network({ frankfurter: () => json({ rates: { EUR: 0.9 } }) });

    await backfillBaseAmounts(() => {});

    expect(asked.frankfurter).toEqual([{ day: DAY, from: 'USD', to: 'EUR' }]);
    expect((await stored('future dollars')).k).toBe(0.9);
  });

  it('on the row\'s own day does not end the lookback: a stored rate the day before converts it', async () => {
    await insertTransactions([row('GEL', DAY, 'lari, stored the day before')]);
    await saveFxMiss(nbuMiss(DAY, 'GEL'));
    await saveFxRate(shift(DAY, -1), 'GEL', UAH_PER_GEL);
    await saveFxRate(DAY, 'EUR', UAH_PER_EUR);
    const asked = network({});

    expect(await backfillBaseAmounts(() => {})).toBe(1);

    expect(asked).toEqual({ nbu: [], frankfurter: [] });
    expect((await stored('lari, stored the day before')).k).toBe(UAH_PER_GEL / UAH_PER_EUR);
  });

  it('on the row\'s own day does not end the lookback: the day before is fetched and converts it', async () => {
    await insertTransactions([row('GEL', DAY, 'lari, fetched the day before')]);
    await saveFxMiss(nbuMiss(DAY, 'GEL'));
    await saveFxRate(DAY, 'EUR', UAH_PER_EUR);
    const asked = network({
      nbu: (currency, day) =>
        currency === 'GEL' && day === shift(DAY, -1)
          ? json([{ cc: 'GEL', rate: UAH_PER_GEL }])
          : new Error('network disabled in tests'),
    });

    expect(await backfillBaseAmounts(() => {})).toBe(1);

    expect(asked.nbu).toEqual([{ currency: 'GEL', day: shift(DAY, -1) }]);
    expect((await stored('lari, fetched the day before')).k).toBe(UAH_PER_GEL / UAH_PER_EUR);
  });

  it('is never recorded for a day not yet past: the rate the NBU sets for it later converts it', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const [prev, d, next] = [today, shift(today, 1), shift(today, 2)];
    const calendar = new Map([[`EUR|${prev}`, 45]]);
    const asked = network({
      nbu: (currency, day) => {
        const rate = calendar.get(`${currency}|${day}`);
        return json(rate === undefined ? [] : [{ cc: currency, rate }]);
      },
    });

    await insertTransactions([row('UAH', next, 'hryvnia, two days ahead')]);
    await backfillBaseAmounts(() => {});
    calendar.set(`EUR|${d}`, 50);
    const first = asked.nbu.length;
    await insertTransactions([row('UAH', d, 'hryvnia, a day ahead')]);
    await backfillBaseAmounts(() => {});

    expect(asked.nbu.slice(first)).toEqual([{ currency: 'EUR', day: d }]);
    expect((await stored('hryvnia, a day ahead')).k).toBe(1 / 50);
    expect(await getFxRate(d, 'EUR')).toBe(50);
  });

  it('gives way to a rate stored for the same day', async () => {
    await insertTransactions([row('GEL', DAY, 'lari, rate and miss')]);
    await saveFxMiss(nbuMiss(DAY, 'GEL'));
    await saveFxRate(DAY, 'GEL', UAH_PER_GEL);
    await saveFxRate(DAY, 'EUR', UAH_PER_EUR);
    const asked = network({});

    expect(await backfillBaseAmounts(() => {})).toBe(1);

    expect(asked).toEqual({ nbu: [], frankfurter: [] });
    expect((await stored('lari, rate and miss')).k).toBe(UAH_PER_GEL / UAH_PER_EUR);
  });

  it('an OK Frankfurter body whose rates lack the symbol is remembered, and the pair is not asked for again', async () => {
    await insertTransactions([row('USD', DAY, 'dollars, symbol missing')]);
    const asked = network({ frankfurter: () => json({ rates: {} }) });

    await backfillBaseAmounts(() => {});
    expect(asked.frankfurter).toEqual([{ day: DAY, from: 'USD', to: 'EUR' }]);
    expect(await getFxRateOrMiss('USD:EUR', ecbMiss(DAY, 'USD', 'EUR'))).toEqual({
      missedAt: expect.any(String),
    });

    await backfillBaseAmounts(() => {});
    expect(asked.frankfurter).toHaveLength(1);
  });

  it('from Frankfurter still leaves the pair to the NBU', async () => {
    await insertTransactions([row('USD', DAY, 'dollars, through the NBU')]);
    const asked = network({
      frankfurter: () => json({ rates: {} }),
      nbu: (currency) =>
        json([{ cc: currency, rate: currency === 'USD' ? UAH_PER_USD : UAH_PER_EUR }]),
    });

    expect(await backfillBaseAmounts(() => {})).toBe(1);

    expect(asked.frankfurter).toHaveLength(1);
    expect((await stored('dollars, through the NBU')).k).toBe(UAH_PER_USD / UAH_PER_EUR);
    expect(await getFxRateOrMiss('USD:EUR', ecbMiss(DAY, 'USD', 'EUR'))).toEqual({
      missedAt: expect.any(String),
    });
  });

  it('a null leg beats a remembered one', async () => {
    await insertTransactions([row('ARS', DAY, 'pesos, euro leg not a rate')]);
    network({ nbu: (c) => json(c === 'EUR' ? [{ cc: 'EUR', rate: 0 }] : []) });
    const lines: string[] = [];

    await backfillBaseAmounts((s) => lines.push(s));

    expect(lines.join('\n')).toContain(`rate ARS -> EUR on ${DAY}: no provider returned one`);
  });

  it('a null provider beats a remembered one', async () => {
    await insertTransactions([row('USD', DAY, 'dollars, Frankfurter not a rate')]);
    network({
      frankfurter: () => json({ rates: { EUR: null } }),
      nbu: (c) => json(c === 'EUR' ? [{ cc: 'EUR', rate: UAH_PER_EUR }] : []),
    });
    const lines: string[] = [];

    await backfillBaseAmounts((s) => lines.push(s));

    expect(lines.join('\n')).toContain(`rate USD -> EUR on ${DAY}: no provider returned one`);
  });
});

describe('an answer that does not say "no rate" records nothing, and is asked again', () => {
  const askedAgainLog = [
    `rate GEL -> EUR on ${DAY}: no provider returned one`,
    'rates left unapplied: 1 of 1 (picked up on the next recompute)',
  ];
  const nbuAnswers: [string, () => Answer, string[]][] = [
    ['a thrown fetch', () => new Error('connection reset'), []],
    ['a non-OK status', () => json({}, 503), []],
    ['a body that is not an array', () => json({}), askedAgainLog],
    ['a rate that is not positive', () => json([{ cc: 'GEL', rate: 0 }]), askedAgainLog],
  ];
  for (const [shape, answer, log] of nbuAnswers) {
    it(`the NBU: ${shape}`, async () => {
      await insertTransactions([row('GEL', DAY, `lari, ${shape}`)]);
      await saveFxRate(DAY, 'EUR', UAH_PER_EUR);
      const asked = network({ nbu: answer });
      const lines: string[] = [];

      await backfillBaseAmounts((s) => lines.push(s));
      for (const line of log) expect(lines.join('\n')).toContain(line);
      const first = asked.nbu.slice();
      expect(first.length).toBeGreaterThan(0);
      for (const { day } of first) {
        expect(await getFxRateOrMiss('GEL', nbuMiss(day, 'GEL')), day).toBeUndefined();
      }

      await backfillBaseAmounts(() => {});
      expect(asked.nbu.slice(first.length)).toEqual(first);
    });
  }

  const frankfurterAnswers: [string, () => Answer][] = [
    ['a non-OK status', () => json({ message: 'not found' }, 404)],
    ['a body without a rates object', () => json({})],
    ['a rate that is not a number', () => json({ rates: { EUR: null } })],
  ];
  for (const [shape, answer] of frankfurterAnswers) {
    it(`Frankfurter: ${shape}`, async () => {
      await insertTransactions([row('USD', DAY, `dollars, ${shape}`)]);
      const asked = network({ frankfurter: answer });

      await backfillBaseAmounts(() => {});
      expect(asked.frankfurter).toEqual([{ day: DAY, from: 'USD', to: 'EUR' }]);
      expect(await getFxRateOrMiss('USD:EUR', ecbMiss(DAY, 'USD', 'EUR'))).toBeUndefined();

      await backfillBaseAmounts(() => {});
      expect(asked.frankfurter).toEqual([
        { day: DAY, from: 'USD', to: 'EUR' },
        { day: DAY, from: 'USD', to: 'EUR' },
      ]);
    });
  }
});
