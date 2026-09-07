/**
 * The goal settings on their own: what each field is clamped to, per bound, and what a
 * stored value that will not parse falls back to. The route is http-settings.test.ts;
 * this file never opens a socket. Every clamp input is built from the bound it tests -
 * the bound itself, and one step past it.
 */
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { dbInstance, getMeta, setMeta } from '../src/db';
import { Settings, getSettings, updateSettings } from '../src/settings';

const DEFAULTS: Settings = {
  bufferPct: 10,
  windowMonths: 6,
  hourlyRate: null,
  hoursCapPerWeek: 20,
  goalMode: 'baseline',
};

beforeEach(async () => {
  await dbInstance().execute(sql`DELETE FROM meta WHERE key = 'settings'`);
});

describe('getSettings', () => {
  it('answers the defaults when nothing is stored', async () => {
    expect(await getSettings()).toEqual(DEFAULTS);
  });

  it('fills a stored partial with the defaults', async () => {
    await setMeta('settings', JSON.stringify({ bufferPct: 25 }));
    expect(await getSettings()).toEqual({ ...DEFAULTS, bufferPct: 25 });
  });

  it('answers the defaults when the stored value is not JSON', async () => {
    await setMeta('settings', JSON.stringify({ bufferPct: 25 }));
    expect((await getSettings()).bufferPct).toBe(25);

    await setMeta('settings', '{not json');
    expect(await getSettings()).toEqual(DEFAULTS);
  });
});

describe('updateSettings', () => {
  it('stores what it answers', async () => {
    const answered = await updateSettings({
      bufferPct: 15,
      windowMonths: 12,
      hourlyRate: 60,
      hoursCapPerWeek: 30,
      goalMode: 'lifestyle',
    });
    expect(answered).toEqual({
      bufferPct: 15,
      windowMonths: 12,
      hourlyRate: 60,
      hoursCapPerWeek: 30,
      goalMode: 'lifestyle',
    });
    expect(await getSettings()).toEqual(answered);
    expect(JSON.parse((await getMeta('settings'))!)).toEqual(answered);
  });

  it.each([
    [100, 100],
    [101, 100],
    [0, 0],
    [-1, 0],
  ])('bufferPct %s is stored as %s', async (sent, stored) => {
    expect((await updateSettings({ bufferPct: sent })).bufferPct).toBe(stored);
  });

  it.each([
    [24, 24],
    [25, 24],
    [1, 1],
    [0, 1],
    [6.4, 6],
    [6.5, 7],
  ])('windowMonths %s is stored as %s', async (sent, stored) => {
    expect((await updateSettings({ windowMonths: sent })).windowMonths).toBe(stored);
  });

  it.each([
    [0.01, 0.01],
    [0.009, 0.01],
    [10_000, 10_000],
    [10_001, 10_000],
  ])('hourlyRate %s is stored as %s', async (sent, stored) => {
    expect((await updateSettings({ hourlyRate: sent })).hourlyRate).toBe(stored);
  });

  it.each([
    [80, 80],
    [81, 80],
    [1, 1],
    [0, 1],
  ])('hoursCapPerWeek %s is stored as %s', async (sent, stored) => {
    expect((await updateSettings({ hoursCapPerWeek: sent })).hoursCapPerWeek).toBe(stored);
  });

  it('hourlyRate null clears a rate that was set', async () => {
    expect((await updateSettings({ hourlyRate: 60 })).hourlyRate).toBe(60);
    expect((await updateSettings({ hourlyRate: null })).hourlyRate).toBeNull();
    expect((await getSettings()).hourlyRate).toBeNull();
  });

  it('a patch without hourlyRate leaves the rate as it was', async () => {
    expect((await updateSettings({ hourlyRate: 60 })).hourlyRate).toBe(60);
    expect((await updateSettings({ bufferPct: 12 })).hourlyRate).toBe(60);
  });

  it.each([
    ['baseline', 'lifestyle'],
    ['lifestyle', 'baseline'],
  ] as const)('goalMode %s is accepted over a stored %s', async (mode, other) => {
    expect((await updateSettings({ goalMode: other })).goalMode).toBe(other);
    expect((await updateSettings({ goalMode: mode })).goalMode).toBe(mode);
  });

  it('an unknown goalMode leaves the current one', async () => {
    expect((await updateSettings({ goalMode: 'lifestyle' })).goalMode).toBe('lifestyle');
    const unknown = 'median' as unknown as Settings['goalMode'];
    expect((await updateSettings({ goalMode: unknown })).goalMode).toBe('lifestyle');
  });

  // One case per field, not one case standing for four: each `??` fallback is its own
  // constant, and a case naming a field whose stored value is already set cannot see
  // what the fallback does when it is not - which is the hourlyRate case below.
  it.each([
    ['bufferPct', 33],
    ['windowMonths', 12],
    ['hoursCapPerWeek', 30],
    ['hourlyRate', 60],
  ] as const)('%s: a value that is not a number leaves the current one', async (field, set) => {
    const stored = await updateSettings({ [field]: set } as Partial<Settings>);
    expect(stored[field]).toBe(set);
    const text = '50' as unknown as number;
    const after = await updateSettings({ [field]: text } as Partial<Settings>);
    expect(after[field]).toBe(set);
  });

  it('an hourlyRate that is not a number leaves it unset rather than at the floor', async () => {
    expect((await getSettings()).hourlyRate).toBeNull();
    const text = 'abc' as unknown as number;
    expect((await updateSettings({ hourlyRate: text })).hourlyRate).toBeNull();
    expect((await getSettings()).hourlyRate).toBeNull();
  });

  it('drops keys it does not know, from the answer and from storage', async () => {
    const answered = await updateSettings({ theme: 'dark' } as unknown as Partial<Settings>);
    expect(Object.keys(answered).sort()).toEqual(Object.keys(DEFAULTS).sort());
    expect(Object.keys(JSON.parse((await getMeta('settings'))!)).sort()).toEqual(
      Object.keys(DEFAULTS).sort(),
    );
  });
});
