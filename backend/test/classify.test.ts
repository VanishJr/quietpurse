import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { canPair, pairingGap, reclassifyAll } from '../src/classify';
import { dbInstance, insertTransactions } from '../src/db';
import { NewTransaction, Transaction } from '../src/types';
import { calendarDay } from '../src/wire';
import { findTx } from './helpers';

const HOUR = 3600_000;

const tx = (over: Partial<NewTransaction>): NewTransaction => ({
  accountId: 'acc1',
  provider: 'monobank',
  amount: -100,
  currency: 'EUR',
  date: '2026-01-10T12:00:00.000Z',
  description: '',
  category: 'other',
  fee: null,
  ...over,
});

/** canPair works on stored rows, which have an id; it never looks at the value. */
const pairable = (over: Partial<NewTransaction>): Transaction => ({
  id: 'unused',
  ...tx(over),
  date: calendarDay(tx(over).date)!,
  fee: undefined,
  categoryManual: false,
  transfer: false,
  transferManual: null,
  refund: false,
  incomeSourceManual: false,
  recurring: false,
  oneOff: false,
});

/**
 * Ids are assigned by the database now, so the assertions below find each row by
 * the description that identifies it in the fixture.
 */
const stored = (description: string): Promise<Transaction> =>
  findTx((t) => t.description === description);

describe('canPair: pairing rules without touching the database', () => {
  const expense = pairable({ accountId: 'a', amount: -20, currency: 'EUR' });
  const income = pairable({ accountId: 'b', amount: 20, currency: 'EUR' });

  it('same currency: amounts to the cent, a 36-hour window', () => {
    expect(canPair(expense, income, 35 * HOUR, {})).toBe(true);
    expect(canPair(expense, income, 37 * HOUR, {})).toBe(false);
    expect(canPair(expense, pairable({ accountId: 'b', amount: 20.5 }), HOUR, {})).toBe(false);
  });

  it('a gap that cannot be measured never pairs', () => {
    expect(canPair(expense, income, NaN, {})).toBe(false);
  });

  it('a time that does not read is midnight of its day, and across currencies no time at all', () => {
    const restored = { ...expense, date: '2026-01-05T25:99:00.000Z' } as Transaction;
    const sameDay = { ...income, date: '2026-01-05T09:00:00.000Z' } as Transaction;
    expect(pairingGap(restored, sameDay)).toBe(9 * HOUR);
    expect(pairingGap(restored, { ...sameDay, currency: 'UAH' })).toBeNaN();
    expect(pairingGap(expense, { ...income, date: '2026-01-10T15:00:00.000Z' } as Transaction)).toBe(3 * HOUR);
  });

  it('one account never pairs with itself', () => {
    expect(canPair(expense, pairable({ accountId: 'a', amount: 20 }), HOUR, {})).toBe(false);
  });

  it('different currencies: a 10-minute window, checked against the rate', () => {
    const uahIncome = pairable({ accountId: 'b', amount: 960, currency: 'UAH' });
    const rates = { EUR: 48, UAH: 1 }; // 20 EUR = 960 UAH
    expect(canPair(expense, uahIncome, 5 * 60_000, rates)).toBe(true);
    expect(canPair(expense, uahIncome, 11 * 60_000, rates)).toBe(false);
    // the amounts differ by more than the tolerance
    const wrongIncome = pairable({ accountId: 'b', amount: 2000, currency: 'UAH' });
    expect(canPair(expense, wrongIncome, 5 * 60_000, rates)).toBe(false);
  });

  it('a currency an earlier version stored in lower case is the same currency', () => {
    const lowerIncome = pairable({ accountId: 'b', amount: 20, currency: 'eur' });
    expect(canPair(expense, lowerIncome, 2 * HOUR, {})).toBe(true);

    const restored = { ...expense, date: '2026-01-05T25:99:00.000Z' } as Transaction;
    expect(pairingGap(restored, { ...lowerIncome, date: '2026-01-05T09:00:00.000Z' } as Transaction)).toBe(9 * HOUR);

    // the rate is found under its code, so 20 EUR against 2000 UAH is no pair
    const lowerExpense = pairable({ accountId: 'a', amount: -20, currency: 'eur' });
    const uahIncome = pairable({ accountId: 'b', amount: 2000, currency: 'UAH' });
    expect(canPair(lowerExpense, uahIncome, 5 * 60_000, { EUR: 48, UAH: 1 })).toBe(false);
  });
});

describe('reclassifyAll: integration on an in-memory database', () => {
  it('pairs a time that does not read as midnight of its day, as a restore can store one', async () => {
    await insertTransactions([
      tx({ accountId: 'restored:a', amount: -77, date: '2026-01-05T08:00:00.000Z', description: 'Restored leg out' }),
      tx({ accountId: 'restored:b', amount: 77, date: '2026-01-05T09:00:00.000Z', description: 'Restored leg in' }),
      tx({ accountId: 'restored:c', amount: -88, date: '2026-01-06T08:00:00.000Z', description: 'Restored lone out' }),
      tx({ accountId: 'restored:d', amount: 88, date: '2026-03-20T08:00:00.000Z', description: 'Months later in' }),
    ]);
    // what a restore keeps from an earlier version, which no insert writes any more
    for (const description of ['Restored leg out', 'Restored lone out']) {
      await dbInstance().execute(
        sql`UPDATE transactions SET date = substr(date, 1, 10) || 'T25:99:00.000Z' WHERE description = ${description}`,
      );
    }
    expect((await stored('Restored leg out')).date).toBe('2026-01-05T25:99:00.000Z');

    await reclassifyAll();

    expect((await stored('Restored leg out')).transfer).toBe(true);
    expect((await stored('Restored leg in')).transfer).toBe(true);
    expect((await stored('Restored lone out')).transfer).toBe(false);
    expect((await stored('Months later in')).transfer).toBe(false);

    // the rows below in this file are their own; a 25:99 left here would be in their way
    await dbInstance().execute(sql`DELETE FROM transactions WHERE account_id LIKE 'restored:%'`);
  });

  it('transfers, false pairs, family, rent, recurring', async () => {
    await insertTransactions([
      // a real transfer between own accounts: a p2p MCC on both sides, same minute
      tx({
        accountId: 'mono:uah1',
        amount: -2500,
        currency: 'UAH',
        date: '2026-01-10T10:00:00.000Z',
        description: 'Переказ на картку',
        mcc: 4829,
      }),
      tx({
        accountId: 'mono:uah2',
        amount: 2500,
        currency: 'UAH',
        date: '2026-01-10T10:00:00.000Z',
        description: 'З Чорної картки',
        mcc: 4829,
      }),
      // regression: a merchant purchase must not be pulled into a pair
      tx({
        accountId: 'eb:rev',
        amount: -20,
        currency: 'EUR',
        date: '2026-01-12T00:00:00.000Z',
        description: 'Miele Operations  Paym',
      }),
      tx({
        accountId: 'eb:n26',
        amount: 20,
        currency: 'EUR',
        date: '2026-01-12T00:00:00.000Z',
        description: 'From A Stranger',
      }),
      // family support: income with source=family, never offered for pairing
      tx({
        accountId: 'mono:uah1',
        amount: 20000,
        currency: 'UAH',
        date: '2026-02-01T10:00:00.000Z',
        description: 'Від: Becker Anna',
      }),
      tx({
        accountId: 'mono:uah2',
        amount: -20000,
        currency: 'UAH',
        date: '2026-02-01T15:00:00.000Z',
        description: 'Оплата чогось',
      }),
      // own money moved in: the owner's name (the Yuriy transliteration)
      tx({
        accountId: 'eb:rev',
        amount: -300,
        currency: 'EUR',
        date: '2026-02-16T00:00:00.000Z',
        description: 'Sent from Revolut  To Yuriy Kalvenko',
      }),
      // salary
      tx({
        accountId: 'eb:n26',
        amount: 1500,
        currency: 'EUR',
        date: '2026-02-27T00:00:00.000Z',
        description: 'LOHN / GEHALT         02/26',
      }),
      ...[1, 2, 3, 4].map((m) =>
        tx({
          accountId: 'eb:n26',
          amount: m === 4 ? -1020 : -1000,
          currency: 'EUR',
          date: `2026-0${m}-01T00:00:00.000Z`,
          description: `Miete 0${m}/2026`,
        }),
      ),
    ]);

    await reclassifyAll();

    // the real pair is flagged on both sides
    expect((await stored('Переказ на картку')).transfer).toBe(true);
    expect((await stored('З Чорної картки')).transfer).toBe(true);

    // the merchant purchase did not get glued to anything
    const miele = await stored('Miele Operations  Paym');
    expect(miele.transfer).toBe(false);
    expect(miele.category).toBe('shopping');
    expect((await stored('From A Stranger')).transfer).toBe(false);

    // family: income, not a transfer, not paired with an unrelated expense
    const family = await stored('Від: Becker Anna');
    expect(family.transfer).toBe(false);
    expect(family.incomeSource).toBe('family');
    expect((await stored('Оплата чогось')).transfer).toBe(false);

    // the owner's name marks a transfer between own accounts
    expect((await stored('Sent from Revolut  To Yuriy Kalvenko')).transfer).toBe(true);

    // salary: category + source
    const salary = await stored('LOHN / GEHALT         02/26');
    expect(salary.category).toBe('salary');
    expect(salary.incomeSource).toBe('salary');

    // rent: housing category + recurring (±20% of the median keeps the 1020 month)
    for (const m of [1, 2, 3, 4]) {
      const rent = await stored(`Miete 0${m}/2026`);
      expect(rent.category).toBe('housing');
      expect(rent.recurring).toBe(true);
    }

    // base_amount: rows already in the base currency get it on insert
    expect(salary.baseAmount).toBe(1500);
    // UAH rows stay unconverted without network (filled in when the NBU is reachable)
    expect(family.baseAmount).toBeUndefined();
  });

  it('a payment is recurring across months whose rows spell its currency in either case', async () => {
    await insertTransactions(
      [1, 2, 3].map((m) =>
        tx({
          accountId: 'lower:gym',
          amount: -30,
          currency: m === 3 ? 'EUR' : 'eur',
          date: `2025-0${m}-15T00:00:00.000Z`,
          description: `Invented Gym 0${m}/2025`,
        }),
      ),
    );

    await reclassifyAll();

    for (const m of [1, 2, 3]) expect((await stored(`Invented Gym 0${m}/2025`)).recurring).toBe(true);
    await dbInstance().execute(sql`DELETE FROM transactions WHERE account_id = 'lower:gym'`);
  });
});
