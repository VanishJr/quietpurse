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

declare const checked: unique symbol;

/**
 * A patch that has been through parseAppSettingsPatch, and the only thing
 * updateAppSettings accepts. The brand is what carries the rule: this function used
 * to take `unknown` fields and drop a bad currency in silence, so the route could
 * answer 200 on a change that never happened. A guard at the route would only move
 * that defect one caller away - the next one, on the mobile client's behalf, would
 * meet it again. With the brand it cannot be called with an unchecked body at all.
 */
export type AppSettingsPatch = {
  baseCurrency?: string;
  ownerNames?: string[];
} & { readonly [checked]: true };

export type ParsedAppSettingsPatch =
  | { ok: true; patch: AppSettingsPatch }
  | { ok: false; error: string };

/**
 * An absent key means "leave it alone"; a present one that cannot be stored is
 * refused rather than coerced - EURO is not somebody's guess at EUR.
 */
export function parseAppSettingsPatch(body: {
  baseCurrency?: unknown;
  ownerNames?: unknown;
}): ParsedAppSettingsPatch {
  const patch: { baseCurrency?: string; ownerNames?: string[] } = {};

  if (body.baseCurrency !== undefined) {
    if (typeof body.baseCurrency !== 'string' || !/^[A-Za-z]{3}$/.test(body.baseCurrency.trim())) {
      return { ok: false, error: 'baseCurrency: a three-letter ISO code, e.g. EUR' };
    }
    patch.baseCurrency = body.baseCurrency.trim().toUpperCase();
  }

  if (body.ownerNames !== undefined) {
    if (!Array.isArray(body.ownerNames) || body.ownerNames.some((n) => typeof n !== 'string')) {
      return { ok: false, error: 'ownerNames: an array of strings' };
    }
    patch.ownerNames = (body.ownerNames as string[]).map((s) => s.trim()).filter(Boolean);
  }

  return { ok: true, patch: patch as AppSettingsPatch };
}

/** Partial update. Returns the new settings and exactly what changed. */
export async function updateAppSettings(
  patch: AppSettingsPatch,
): Promise<{ settings: AppSettings; baseCurrencyChanged: boolean; ownerNamesChanged: boolean }> {
  const before = await getAppSettings();

  let baseCurrencyChanged = false;
  if (patch.baseCurrency !== undefined && patch.baseCurrency !== before.baseCurrency) {
    await setSetting('base_currency', patch.baseCurrency);
    baseCurrencyChanged = true;
  }

  let ownerNamesChanged = false;
  if (
    patch.ownerNames !== undefined &&
    JSON.stringify(patch.ownerNames) !== JSON.stringify(before.ownerNames)
  ) {
    await setSetting('owner_names', JSON.stringify(patch.ownerNames));
    ownerNamesChanged = true;
  }

  return { settings: await getAppSettings(), baseCurrencyChanged, ownerNamesChanged };
}
