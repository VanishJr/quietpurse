import { getMeta, setMeta } from './db';

/** The two modes are derived in full in independence.ts's header. */
export type GoalMode = 'baseline' | 'lifestyle';

export interface Settings {
  /** buffer on top of the minimum/spending, % (threshold = base * (1 + bufferPct/100)) */
  bufferPct: number;
  /** averaging window for spending/income, in whole calendar months */
  windowMonths: number;
  /** net hourly rate for side work in the base currency; null = not set */
  hourlyRate: number | null;
  /** how many hours a week the user works - the cap when converting to hours */
  hoursCapPerWeek: number;
  /** what to compute the threshold from */
  goalMode: GoalMode;
}

const DEFAULTS: Settings = {
  bufferPct: 10,
  windowMonths: 6,
  hourlyRate: null,
  hoursCapPerWeek: 20,
  goalMode: 'baseline',
};

const META_KEY = 'settings';

export async function getSettings(): Promise<Settings> {
  const raw = await getMeta(META_KEY);
  if (!raw) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Partial update; unknown fields are dropped, bounds are clamped. */
export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const cur = await getSettings();
  const next: Settings = {
    bufferPct: clamp(num(patch.bufferPct, cur.bufferPct), 0, 100),
    windowMonths: Math.round(clamp(num(patch.windowMonths, cur.windowMonths), 1, 24)),
    hourlyRate:
      patch.hourlyRate === null
        ? null
        : patch.hourlyRate !== undefined
          ? clamp(num(patch.hourlyRate, cur.hourlyRate ?? 0), 0.01, 10_000)
          : cur.hourlyRate,
    hoursCapPerWeek: clamp(num(patch.hoursCapPerWeek, cur.hoursCapPerWeek), 1, 80),
    goalMode:
      patch.goalMode === 'baseline' || patch.goalMode === 'lifestyle'
        ? patch.goalMode
        : cur.goalMode,
  };
  await setMeta(META_KEY, JSON.stringify(next));
  return next;
}

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

const clamp = (v: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, v));
