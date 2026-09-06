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
import { NewTransaction } from '../src/types';
import { idOf } from './helpers';

const tx = (over: Partial<NewTransaction>): NewTransaction => ({
  accountId: 'acc1',
  provider: 'monobank',
  amount: 100,
  currency: 'EUR',
  date: '2026-03-05T12:00:00.000Z',
  description: '',
  category: 'other',
  fee: null,
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
    // a literal, never the seed's own symbol: the id is data and does not move, and
    // the label is the one thing about this row that a stranger reads
    expect(family.label).toBe('Support');
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
        amount: 300,
        date: '2026-03-05T12:00:00.000Z',
        description: 'Von: Musterstiftung  Musterstadt  Stipendium 03/26',
      }),
      tx({
        amount: 50,
        date: '2026-03-06T12:00:00.000Z',
        description: 'Von: Random Person',
      }),
    ]);
    await reclassifyAll();

    const stipend = await idOf('Von: Musterstiftung  Musterstadt  Stipendium 03/26');
    expect((await getTransaction(stipend))!.incomeSource).toBe('scholarship');

    const march = (
      await summaryMonthlyTotals(
        { kind: 'all' },
        '2026-03-01T00:00:00.000Z',
        '2026-03-31T23:59:59.999Z',
      )
    ).find((m) => m.month === '2026-03')!;
    // the stipend is external, an unrelated income is own (falls into other)
    expect(march.incomeExternal).toBe(300);
    expect(march.incomeOwn).toBeGreaterThanOrEqual(50);

    // deleting a source returns its transactions to other
    expect(await deleteIncomeSource('scholarship')).toBe(true);
    expect((await getTransaction(stipend))!.incomeSource).toBe('other');
  });

  it('a builtin source cannot be deleted, a manual mark beats auto-detection', async () => {
    expect(await deleteIncomeSource('salary')).toBe(false);
    await insertTransactions([tx({ amount: 77, description: 'Von: Random' })]);
    const id = await idOf('Von: Random');
    expect((await setIncomeSourceOverride(id, 'family'))!.incomeSource).toBe('family');
    expect((await setIncomeSourceOverride(id, null))!.incomeSource).toBe('other');
  });
});
