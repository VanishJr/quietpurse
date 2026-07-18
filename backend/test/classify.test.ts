import { describe, expect, it } from 'vitest';
import { canPair, reclassifyAll } from '../src/classify';
import { getTransaction, insertTransactions } from '../src/db';
import { Transaction } from '../src/types';

const HOUR = 3600_000;

const tx = (over: Partial<Transaction>): Transaction => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  accountId: 'acc1',
  provider: 'monobank',
  amount: -100,
  currency: 'EUR',
  date: '2026-01-10T12:00:00.000Z',
  description: '',
  category: 'other',
  ...over,
});

describe('canPair: pairing rules without touching the database', () => {
  const expense = tx({ accountId: 'a', amount: -20, currency: 'EUR' });
  const income = tx({ accountId: 'b', amount: 20, currency: 'EUR' });

  it('same currency: amounts to the cent, a 36-hour window', () => {
    expect(canPair(expense, income, 35 * HOUR, {})).toBe(true);
    expect(canPair(expense, income, 37 * HOUR, {})).toBe(false);
    expect(canPair(expense, tx({ accountId: 'b', amount: 20.5 }), HOUR, {})).toBe(false);
  });

  it('one account never pairs with itself', () => {
    expect(canPair(expense, tx({ accountId: 'a', amount: 20 }), HOUR, {})).toBe(false);
  });

  it('different currencies: a 10-minute window, checked against the rate', () => {
    const uahIncome = tx({ accountId: 'b', amount: 960, currency: 'UAH' });
    const rates = { EUR: 48, UAH: 1 }; // 20 EUR = 960 UAH
    expect(canPair(expense, uahIncome, 5 * 60_000, rates)).toBe(true);
    expect(canPair(expense, uahIncome, 11 * 60_000, rates)).toBe(false);
    // the amounts differ by more than the tolerance
    const wrongIncome = tx({ accountId: 'b', amount: 2000, currency: 'UAH' });
    expect(canPair(expense, wrongIncome, 5 * 60_000, rates)).toBe(false);
  });
});

describe('reclassifyAll: integration on an in-memory database', () => {
  it('transfers, false pairs, family, rent, recurring', async () => {
    insertTransactions([
      // a real transfer between own accounts: a p2p MCC on both sides, same minute
      tx({
        id: 'leg-out',
        accountId: 'mono:uah1',
        amount: -2500,
        currency: 'UAH',
        date: '2026-01-10T10:00:00.000Z',
        description: 'Переказ на картку',
        mcc: 4829,
      }),
      tx({
        id: 'leg-in',
        accountId: 'mono:uah2',
        amount: 2500,
        currency: 'UAH',
        date: '2026-01-10T10:00:00.000Z',
        description: 'З Чорної картки',
        mcc: 4829,
      }),
      // regression: a merchant purchase must not be pulled into a pair
      tx({
        id: 'miele',
        accountId: 'eb:rev',
        amount: -20,
        currency: 'EUR',
        date: '2026-01-12T00:00:00.000Z',
        description: 'Miele Operations  Paym',
      }),
      tx({
        id: 'stranger',
        accountId: 'eb:n26',
        amount: 20,
        currency: 'EUR',
        date: '2026-01-12T00:00:00.000Z',
        description: 'From A Stranger',
      }),
      // family support: income with source=family, never offered for pairing
      tx({
        id: 'family',
        accountId: 'mono:uah1',
        amount: 20000,
        currency: 'UAH',
        date: '2026-02-01T10:00:00.000Z',
        description: 'Від: Becker Anna',
      }),
      tx({
        id: 'unrelated-expense',
        accountId: 'mono:uah2',
        amount: -20000,
        currency: 'UAH',
        date: '2026-02-01T15:00:00.000Z',
        description: 'Оплата чогось',
      }),
      // own money moved in: the owner's name (the Yuriy transliteration)
      tx({
        id: 'own-name',
        accountId: 'eb:rev',
        amount: -300,
        currency: 'EUR',
        date: '2026-02-16T00:00:00.000Z',
        description: 'Sent from Revolut  To Yuriy Kalvenko',
      }),
      // salary
      tx({
        id: 'salary',
        accountId: 'eb:n26',
        amount: 1500,
        currency: 'EUR',
        date: '2026-02-27T00:00:00.000Z',
        description: 'LOHN / GEHALT         02/26',
      }),
      // rent 4 months running - a recurring payment in the housing category
      ...[1, 2, 3, 4].map((m) =>
        tx({
          id: `rent-${m}`,
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
    expect(getTransaction('leg-out')!.transfer).toBe(true);
    expect(getTransaction('leg-in')!.transfer).toBe(true);

    // the merchant purchase did not get glued to anything
    expect(getTransaction('miele')!.transfer).toBe(false);
    expect(getTransaction('miele')!.category).toBe('shopping');
    expect(getTransaction('stranger')!.transfer).toBe(false);

    // family: income, not a transfer, not paired with an unrelated expense
    const family = getTransaction('family')!;
    expect(family.transfer).toBe(false);
    expect(family.incomeSource).toBe('family');
    expect(getTransaction('unrelated-expense')!.transfer).toBe(false);

    // the owner's name marks a transfer between own accounts
    expect(getTransaction('own-name')!.transfer).toBe(true);

    // salary: category + source
    const salary = getTransaction('salary')!;
    expect(salary.category).toBe('salary');
    expect(salary.incomeSource).toBe('salary');

    // rent: housing category + recurring (±20% of the median keeps the 1020 month)
    for (const m of [1, 2, 3, 4]) {
      const rent = getTransaction(`rent-${m}`)!;
      expect(rent.category).toBe('housing');
      expect(rent.recurring).toBe(true);
    }

    // base_amount: rows already in the base currency get it on insert
    expect(getTransaction('salary')!.baseAmount).toBe(1500);
    // UAH rows stay unconverted without network (filled in when the NBU is reachable)
    expect(getTransaction('family')!.baseAmount).toBeUndefined();
  });
});
