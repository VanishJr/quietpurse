/** Not settings.ts, which holds the Goal screen's settings and stores them elsewhere. */
import { currentBaseCurrency, getSetting, setSetting } from './db';

export interface AppSettings {
  /** base currency of all totals; changing it requires recomputing base_amount */
  baseCurrency: string;
  ownerNames: string[];
}

export async function getAppSettings(): Promise<AppSettings> {
  // No env fallback: OWNER_NAMES is the operator's own household, so falling back to
  // it would show those names in another user's settings.
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

/** The brand is the rule: updateAppSettings cannot be called with an unchecked body at all. */
export type AppSettingsPatch = {
  baseCurrency?: string;
  ownerNames?: string[];
} & { readonly [checked]: true };

export type ParsedAppSettingsPatch =
  | { ok: true; patch: AppSettingsPatch }
  | { ok: false; error: string };

/** An absent key means "leave it alone"; a present one that cannot be stored is refused, never coerced. */
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
