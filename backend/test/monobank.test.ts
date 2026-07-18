import { describe, expect, it } from 'vitest';
import { windowsToFetch } from '../src/providers/monobank';

const DAY = 86_400;
const now = Math.floor(Date.parse('2026-07-01T12:00:00Z') / 1000);
const iso = (sec: number) => new Date(sec * 1000).toISOString();

describe('windowsToFetch', () => {
  it('a new account: one history window from SYNC_START until now', () => {
    const start = now - 180 * DAY;
    expect(windowsToFetch(start, undefined, undefined, now)).toEqual([
      { from: start, to: now, kind: 'history' },
    ]);
  });

  it('a normal run: only the tail since the last sync (with an hour of slack)', () => {
    const start = now - 180 * DAY;
    const lastSynced = now - 2 * DAY;
    const windows = windowsToFetch(start, iso(lastSynced), iso(start), now);
    expect(windows).toEqual([{ from: lastSynced - 3600, to: now, kind: 'new' }]);
  });

  it('SYNC_START moved deeper: history backfill + tail', () => {
    const oldStart = now - 180 * DAY;
    const newStart = now - 365 * DAY;
    const lastSynced = now - DAY;
    const windows = windowsToFetch(newStart, iso(lastSynced), iso(oldStart), now);
    expect(windows).toEqual([
      { from: newStart, to: oldStart, kind: 'history' },
      { from: lastSynced - 3600, to: now, kind: 'new' },
    ]);
  });
});
