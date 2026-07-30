/**
 * App settings from the settings table (seeded by the initial migration).
 * Edited via PATCH /api/app-settings; .env is left for secrets and process
 * parameters only (port, database path).
 *
 * Not to be confused with settings.ts - that holds the Goal screen's settings
 * (buffer, window, hourly rate), which live in meta as a single JSON string.
 */
import { currentBaseCurrency, getSetting, setSetting } from './db';

export interface AppSettings {
  /** base currency of all totals; changing it requires recomputing base_amount */
  baseCurrency: string;
  /**
   * Account owner names: a transaction with all the words of one of these names
   * in its description is a transfer between your own accounts (see classify.ts).
   */
  ownerNames: string[];
}

export async function getAppSettings(): Promise<AppSettings> {
  // No env fallback: OWNER_NAMES is the operator's own household, so falling back
  // to it would show those names in another user's settings. seedDefaults() writes
  // the key for every workspace, empty for all but the owner's.
  let ownerNames: string[] = [];
  const raw = await getSetting('owner_names');
  if (raw !== undefined) {
    try {
      const v = JSON.parse(raw);
      if (Array.isArray(v)) ownerNames = v.map(String).filter(Boolean);
    } catch {
      // corrupted value - treat it as not set
    }
  }
  return {
    baseCurrency: await currentBaseCurrency(),
    ownerNames,
  };
}

/** Partial update. Returns the new settings and exactly what changed. */
export async function updateAppSettings(patch: {
  baseCurrency?: unknown;
  ownerNames?: unknown;
}): Promise<{ settings: AppSettings; baseCurrencyChanged: boolean; ownerNamesChanged: boolean }> {
  const before = await getAppSettings();

  let baseCurrencyChanged = false;
  if (typeof patch.baseCurrency === 'string' && /^[A-Za-z]{3}$/.test(patch.baseCurrency.trim())) {
    const next = patch.baseCurrency.trim().toUpperCase();
    if (next !== before.baseCurrency) {
      await setSetting('base_currency', next);
      baseCurrencyChanged = true;
    }
  }

  let ownerNamesChanged = false;
  if (Array.isArray(patch.ownerNames)) {
    const next = patch.ownerNames.map(String).map((s) => s.trim()).filter(Boolean);
    if (JSON.stringify(next) !== JSON.stringify(before.ownerNames)) {
      await setSetting('owner_names', JSON.stringify(next));
      ownerNamesChanged = true;
    }
  }

  return { settings: await getAppSettings(), baseCurrencyChanged, ownerNamesChanged };
}
