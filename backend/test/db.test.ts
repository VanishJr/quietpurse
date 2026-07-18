import { describe, expect, it } from 'vitest';
import {
  applyClassification,
  getTransaction,
  insertTransactions,
  listRecurringGroups,
  setOneOff,
  setRecurringIgnored,
} from '../src/db';
import { Transaction } from '../src/types';

const tx = (over: Partial<Transaction>): Transaction => ({
  id: 'dup-1',
  accountId: 'acc1',
  provider: 'monobank',
  amount: -100,
  currency: 'EUR',
  date: '2026-01-10T12:00:00.000Z',
  description: 'test',
  category: 'other',
  ...over,
});

describe('insertTransactions', () => {
  it('deduplication by id: a repeated insert is silently skipped', () => {
    expect(insertTransactions([tx({})])).toBe(1);
    expect(insertTransactions([tx({}), tx({ id: 'dup-2' })])).toBe(1);
  });

  it('the base currency gets base_amount at once, the rest get null', () => {
    insertTransactions([
      tx({ id: 'eur-1', amount: -50, currency: 'EUR' }),
      tx({ id: 'uah-1', amount: -2000, currency: 'UAH' }),
    ]);
    expect(getTransaction('eur-1')!.baseAmount).toBe(-50);
    expect(getTransaction('uah-1')!.baseAmount).toBeUndefined();
  });
});

describe('setOneOff', () => {
  it('the mark lives in its own column and survives repeated calls', () => {
    insertTransactions([tx({ id: 'big-1', amount: -768, currency: 'EUR' })]);
    expect(setOneOff('big-1', true)!.oneOff).toBe(true);
    expect(setOneOff('big-1', false)!.oneOff).toBe(false);
    expect(setOneOff('missing', true)).toBeUndefined();
  });
});

describe('hiding recurring groups', () => {
  it('ignored is set by the normalized key and can be cleared again', () => {
    // three months of "rent" with a changing month in the description - one group
    insertTransactions(
      [1, 2, 3].map((m) =>
        tx({
          id: `rent-ign-${m}`,
          amount: -900,
          currency: 'EUR',
          date: `2026-0${m}-01T00:00:00.000Z`,
          description: `Miete 0${m}/2026`,
        }),
      ),
    );
    applyClassification(
      [1, 2, 3].map((m) => ({
        id: `rent-ign-${m}`,
        category: 'housing',
        transfer: false,
        refund: false,
        incomeSource: null,
        recurring: true,
      })),
    );

    const before = listRecurringGroups('2026-01-01T00:00:00.000Z');
    const group = before.find((g) => g.description.startsWith('Miete'))!;
    expect(group.ignored).toBe(false);

    // hide by one spelling - the whole group hides (the key is normalized)
    setRecurringIgnored('Miete 01/2026', true);
    const hidden = listRecurringGroups('2026-01-01T00:00:00.000Z').find((g) =>
      g.description.startsWith('Miete'),
    )!;
    expect(hidden.ignored).toBe(true);

    setRecurringIgnored('Miete 03/2026', false);
    const restored = listRecurringGroups('2026-01-01T00:00:00.000Z').find((g) =>
      g.description.startsWith('Miete'),
    )!;
    expect(restored.ignored).toBe(false);
  });
});
