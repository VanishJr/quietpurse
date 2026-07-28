/**
 * The goal threshold: the bare minimum versus the median of spending.
 *
 * The regression this was all built for: the median counted holidays, two PCs and a
 * transfer into savings - the threshold ballooned to something implausible and
 * self-sufficiency halved. The bare minimum does not depend on one-off spending.
 *
 * Every test gets its own module graph AND an empty database - otherwise a
 * neighbouring test's transactions land in the window.
 */
import { describe, expect, it, vi } from 'vitest';
import { NewTransaction } from '../src/types';

const NOW = new Date('2026-07-14T00:00:00.000Z');
/** Whole months of the window when NOW = July: 2026-01 ... 2026-06. */
const MONTHS = ['01', '02', '03', '04', '05', '06'];

const tx = (over: Partial<NewTransaction>): NewTransaction => ({
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

  // the reset module graph lost the database AND the workspace scope from
  // setup.ts - re-init both on the shared PGlite (freshTestDb truncates every
  // table; the instance survives on globalThis)
  const { freshTestDb, TEST_WORKSPACE_ID } = await import('./pglite');
  db.initDb(await freshTestDb());
  db.setWorkspaceFallback(TEST_WORKSPACE_ID);
  await db.seedDefaults();

  const { computeIndependence } = await import('../src/independence');
  const { updateSettings } = await import('../src/settings');
  await updateSettings({ goalMode: 'baseline', bufferPct: 10, windowMonths: 6, hourlyRate: 60 });

  /**
   * The same expense in each of the window's 6 months. Each series gets its own
   * account: deduplication is per account, day and amount, so two series that
   * happened to spend the same amount on the same day would otherwise collapse
   * into one.
   */
  const spendEveryMonth = async (amount: number, series: string) => {
    for (const m of MONTHS) {
      await db.insertTransactions([
        tx({
          accountId: series,
          description: series,
          amount: -amount,
          date: `2026-${m}-05T12:00:00.000Z`,
        }),
      ]);
    }
  };

  return { ...db, computeIndependence, updateSettings, spendEveryMonth };
}

describe('bare minimum', () => {
  it('threshold = sum of the items * (1 + buffer), not the median of spending', async () => {
    const t = await fresh();
    await t.upsertBaselineItem('housing', 1000);
    await t.upsertBaselineItem('food', 500);
    expect(await t.baselineTotal()).toBe(1500);

    const r = await t.computeIndependence(NOW);
    expect(r.baselineSum).toBe(1500);
    expect(r.threshold).toBe(1650); // 1500 * 1.10
    expect(r.baselineItems).toHaveLength(2);
  });

  it('the threshold ignores spending: monthly restaurants only move the lifestyle figure', async () => {
    const t = await fresh();
    await t.upsertBaselineItem('housing', 1000);
    await t.spendEveryMonth(1000, 'rent');
    const before = await t.computeIndependence(NOW);
    expect(before.lifestyleThreshold).toBe(1100); // 1000 * 1.10

    // it is regular optional spending that inflates the median, not outliers:
    // a single 3000 PC in one month is something the median would survive
    await t.spendEveryMonth(700, 'restaurants');
    const after = await t.computeIndependence(NOW);

    expect(after.threshold).toBe(before.threshold); // 1100, the minimum did not move
    expect(after.baselineSum).toBe(1000);
    expect(after.lifestyleThreshold).toBe(1870); // 1700 * 1.10 - the lifestyle got pricier
  });

  it('self-sufficiency is measured against the minimum: income 750 on a minimum of 1000 = 75%', async () => {
    const t = await fresh();
    await t.upsertBaselineItem('housing', 1000);
    for (const m of MONTHS) {
      await t.insertTransactions([
        tx({
          amount: 750,
          date: `2026-${m}-20T12:00:00.000Z`,
          category: 'salary',
          description: 'Lohn',
        }),
      ]);
    }
    expect((await t.computeIndependence(NOW)).selfSufficiency).toBe(0.75);
  });

  it('an empty item list falls back to the median rather than a threshold of 0', async () => {
    const t = await fresh();
    await t.spendEveryMonth(800, 'spend');

    const r = await t.computeIndependence(NOW);
    expect(r.baselineSum).toBe(0);
    expect(r.threshold).toBe(r.lifestyleThreshold);
    expect(r.threshold).toBeGreaterThan(0);
  });
});

describe('goalMode: lifestyle - the older formula is unchanged', () => {
  it('threshold = median spending * (1 + buffer), the minimum is ignored', async () => {
    const t = await fresh();
    await t.upsertBaselineItem('housing', 1000);
    await t.spendEveryMonth(800, 'spend');
    await t.updateSettings({ goalMode: 'lifestyle' });

    const r = await t.computeIndependence(NOW);
    expect(r.avgSpend).toBe(800);
    expect(r.threshold).toBe(880); // 800 * 1.10
    expect(r.threshold).toBe(r.lifestyleThreshold);
  });
});

describe('minimum line items', () => {
  it('editing by label overwrites the item instead of duplicating it', async () => {
    const t = await fresh();
    await t.upsertBaselineItem('Gym', 35);
    await t.upsertBaselineItem('Gym', 45);
    expect(await t.listBaselineItems()).toHaveLength(1);
    expect(await t.baselineTotal()).toBe(45);
  });

  it('editing just the amount does not move the item in the list', async () => {
    const t = await fresh();
    await t.upsertBaselineItem('housing', 950, 0);
    await t.upsertBaselineItem('Gym', 35, 1);
    await t.upsertBaselineItem('Barber', 30, 2);

    // this is how the Goal screen edits: it sends only label and monthly
    await t.upsertBaselineItem('Gym', 45);

    const gym = (await t.listBaselineItems()).find((i) => i.label === 'Gym');
    expect(gym?.monthly).toBe(45);
    expect((await t.listBaselineItems()).map((i) => i.label)).toEqual([
      'housing',
      'Gym',
      'Barber',
    ]);
  });

  it('a new item without sort goes to the end of the list', async () => {
    const t = await fresh();
    await t.upsertBaselineItem('housing', 950, 0);
    await t.upsertBaselineItem('food', 700, 1);
    await t.upsertBaselineItem('Internet', 30); // no sort
    expect((await t.listBaselineItems()).map((i) => i.label)).toEqual([
      'housing',
      'food',
      'Internet',
    ]);
  });

  it('deleting an item lowers the minimum', async () => {
    const t = await fresh();
    await t.upsertBaselineItem('Gym', 35);
    await t.upsertBaselineItem('Barber', 30);
    expect(await t.deleteBaselineItem('Barber')).toBe(true);
    expect(await t.baselineTotal()).toBe(35);
    expect(await t.deleteBaselineItem('No such item')).toBe(false);
  });
});
