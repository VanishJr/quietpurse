/**
 * The goal threshold: the bare minimum versus the median of spending.
 *
 * The regression this was all built for: the median counted holidays, two PCs and a
 * transfer into savings - the threshold ballooned to something implausible and
 * self-sufficiency halved. The bare minimum does not depend on one-off spending.
 *
 * db.ts opens its own in-memory database on import, so every test needs its own
 * module graph - otherwise a neighbouring test's transactions land in the window.
 */
import { describe, expect, it, vi } from 'vitest';
import { Transaction } from '../src/types';

const NOW = new Date('2026-07-14T00:00:00.000Z');
/** Whole months of the window when NOW = July: 2026-01 ... 2026-06. */
const MONTHS = ['01', '02', '03', '04', '05', '06'];

const tx = (over: Partial<Transaction> & { id: string }): Transaction => ({
  accountId: 'acc1',
  provider: 'monobank',
  amount: -100,
  currency: 'EUR',
  date: '2026-06-10T12:00:00.000Z',
  description: 'test',
  category: 'other',
  ...over,
});

/** A clean database + default goal settings. */
async function fresh() {
  vi.resetModules();
  const db = await import('../src/db');
  const { computeIndependence } = await import('../src/independence');
  const { updateSettings } = await import('../src/settings');
  updateSettings({ goalMode: 'baseline', bufferPct: 10, windowMonths: 6, hourlyRate: 60 });

/** The same expense in each of the window's 6 months. */
  const spendEveryMonth = (amount: number, prefix: string) =>
    MONTHS.forEach((m) =>
      db.insertTransactions([
        tx({ id: `${prefix}-${m}`, amount: -amount, date: `2026-${m}-05T12:00:00.000Z` }),
      ]),
    );

  return { ...db, computeIndependence, updateSettings, spendEveryMonth };
}

describe('bare minimum', () => {
  it('threshold = sum of the items * (1 + buffer), not the median of spending', async () => {
    const t = await fresh();
    t.upsertBaselineItem('housing', 1000);
    t.upsertBaselineItem('food', 500);
    expect(t.baselineTotal()).toBe(1500);

    const r = t.computeIndependence(NOW);
    expect(r.baselineSum).toBe(1500);
    expect(r.threshold).toBe(1650); // 1500 * 1.10
    expect(r.baselineItems).toHaveLength(2);
  });

  it('the threshold ignores spending: monthly restaurants only move the lifestyle figure', async () => {
    const t = await fresh();
    t.upsertBaselineItem('housing', 1000);
    t.spendEveryMonth(1000, 'rent');
    const before = t.computeIndependence(NOW);
    expect(before.lifestyleThreshold).toBe(1100); // 1000 * 1.10

    // it is regular optional spending that inflates the median, not outliers:
    // a single 3000 PC in one month is something the median would survive
    t.spendEveryMonth(700, 'restaurants');
    const after = t.computeIndependence(NOW);

    expect(after.threshold).toBe(before.threshold); // 1100, the minimum did not move
    expect(after.baselineSum).toBe(1000);
    expect(after.lifestyleThreshold).toBe(1870); // 1700 * 1.10 - the lifestyle got pricier
  });

  it('self-sufficiency is measured against the minimum: income 750 on a minimum of 1000 = 75%', async () => {
    const t = await fresh();
    t.upsertBaselineItem('housing', 1000);
    MONTHS.forEach((m) =>
      t.insertTransactions([
        tx({
          id: `salary-${m}`,
          amount: 750,
          date: `2026-${m}-20T12:00:00.000Z`,
          category: 'salary',
          description: 'Lohn',
        }),
      ]),
    );
    expect(t.computeIndependence(NOW).selfSufficiency).toBe(0.75);
  });

  it('an empty item list falls back to the median rather than a threshold of 0', async () => {
    const t = await fresh();
    t.spendEveryMonth(800, 'spend');

    const r = t.computeIndependence(NOW);
    expect(r.baselineSum).toBe(0);
    expect(r.threshold).toBe(r.lifestyleThreshold);
    expect(r.threshold).toBeGreaterThan(0);
  });
});

describe('goalMode: lifestyle - the older formula is unchanged', () => {
  it('threshold = median spending * (1 + buffer), the minimum is ignored', async () => {
    const t = await fresh();
    t.upsertBaselineItem('housing', 1000);
    t.spendEveryMonth(800, 'spend');
    t.updateSettings({ goalMode: 'lifestyle' });

    const r = t.computeIndependence(NOW);
    expect(r.avgSpend).toBe(800);
    expect(r.threshold).toBe(880); // 800 * 1.10
    expect(r.threshold).toBe(r.lifestyleThreshold);
  });
});

describe('minimum line items', () => {
  it('editing by label overwrites the item instead of duplicating it', async () => {
    const t = await fresh();
    t.upsertBaselineItem('Gym', 35);
    t.upsertBaselineItem('Gym', 45);
    expect(t.listBaselineItems()).toHaveLength(1);
    expect(t.baselineTotal()).toBe(45);
  });

  it('editing just the amount does not move the item in the list', async () => {
    const t = await fresh();
    t.upsertBaselineItem('housing', 950, 0);
    t.upsertBaselineItem('Gym', 35, 1);
    t.upsertBaselineItem('Barber', 30, 2);

    // this is how the Goal screen edits: it sends only label and monthly
    t.upsertBaselineItem('Gym', 45);

    const gym = t.listBaselineItems().find((i) => i.label === 'Gym');
    expect(gym?.monthly).toBe(45);
    expect(t.listBaselineItems().map((i) => i.label)).toEqual(['housing', 'Gym', 'Barber']);
  });

  it('a new item without sort goes to the end of the list', async () => {
    const t = await fresh();
    t.upsertBaselineItem('housing', 950, 0);
    t.upsertBaselineItem('food', 700, 1);
    t.upsertBaselineItem('Internet', 30); // no sort
    expect(t.listBaselineItems().map((i) => i.label)).toEqual(['housing', 'food', 'Internet']);
  });

  it('deleting an item lowers the minimum', async () => {
    const t = await fresh();
    t.upsertBaselineItem('Gym', 35);
    t.upsertBaselineItem('Barber', 30);
    expect(t.deleteBaselineItem('Barber')).toBe(true);
    expect(t.baselineTotal()).toBe(35);
    expect(t.deleteBaselineItem('No such item')).toBe(false);
  });
});
