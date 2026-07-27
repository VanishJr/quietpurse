import { describe, expect, it } from 'vitest';
import { reclassifyAll } from '../src/classify';
import {
  deleteIncomeSource,
  getTransaction,
  insertTransactions,
  listIncomeSources,
  setIncomeSourceOverride,
  summaryMonthlyTotals,
  upsertIncomeSource,
} from '../src/db';
import { Transaction } from '../src/types';

const tx = (over: Partial<Transaction>): Transaction => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  accountId: 'acc1',
  provider: 'monobank',
  amount: 100,
  currency: 'EUR',
  date: '2026-03-05T12:00:00.000Z',
  description: '',
  category: 'other',
  ...over,
});

describe('income_sources', () => {
  it('defaults are seeded, family gets its patterns from FAMILY_NAMES', async () => {
    const sources = await listIncomeSources();
    const ids = sources.map((s) => s.id);
    expect(ids).toContain('salary');
    expect(ids).toContain('family');
    expect(ids).toContain('other');
    const family = sources.find((s) => s.id === 'family')!;
    expect(family.kind).toBe('external');
    expect(family.builtin).toBe(true);
    // from test/setup.ts: FAMILY_NAMES = 'ANNA BECKER, Becker Anna'
    expect(family.patterns).toContain('ANNA BECKER');
  });

  it('a custom source with patterns tags income and shows up in the by-kind summaries', async () => {
    await upsertIncomeSource({
      id: 'scholarship',
      label: 'Stipend',
      kind: 'external',
      patterns: ['Musterstiftung Musterstadt'],
    });
    await insertTransactions([
      tx({
        id: 'stip-1',
        amount: 300,
        date: '2026-03-05T12:00:00.000Z',
        description: 'Von: Musterstiftung  Musterstadt  Stipendium 03/26',
      }),
      tx({
        id: 'plain-income',
        amount: 50,
        date: '2026-03-06T12:00:00.000Z',
        description: 'Von: Random Person',
      }),
    ]);
    await reclassifyAll();

    expect((await getTransaction('stip-1'))!.incomeSource).toBe('scholarship');

    const march = (
      await summaryMonthlyTotals('2026-03-01T00:00:00.000Z', '2026-03-31T23:59:59.999Z')
    ).find((m) => m.month === '2026-03')!;
    // the stipend is external, an unrelated income is own (falls into other)
    expect(march.incomeExternal).toBe(300);
    expect(march.incomeOwn).toBeGreaterThanOrEqual(50);

    // deleting a source returns its transactions to other
    expect(await deleteIncomeSource('scholarship')).toBe(true);
    expect((await getTransaction('stip-1'))!.incomeSource).toBe('other');
  });

  it('a builtin source cannot be deleted, a manual mark beats auto-detection', async () => {
    expect(await deleteIncomeSource('salary')).toBe(false);
    await insertTransactions([tx({ id: 'manual-src', amount: 77, description: 'Von: Random' })]);
    expect((await setIncomeSourceOverride('manual-src', 'family'))!.incomeSource).toBe('family');
    expect((await setIncomeSourceOverride('manual-src', null))!.incomeSource).toBe('other');
  });
});
