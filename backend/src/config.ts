import 'dotenv/config';
import fs from 'fs';
import path from 'path';

function monthsAgo(n: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 10);
}

const port = parseInt(process.env.PORT || '4000', 10);

const syncStart = process.env.SYNC_START || monthsAgo(12);

export const config = {
  port,
  /**
   * Shared secret for API access: the server listens on 0.0.0.0, and without a
   * key anyone on the same Wi-Fi network could read accounts and transactions.
   * The web client sends the key in the x-api-key header (VITE_API_KEY in
   * web/.env). An empty value = protection off (only acceptable on a trusted network).
   */
  apiKey: process.env.API_KEY || '',
  /**
   * Base currency of all totals (average spending, independence threshold, budgets).
   * SOURCE OF TRUTH — settings.base_currency (editable from the app); env is the
   * seed at the initial migration and a fallback. Each transaction gets a base_amount —
   * its value in this currency at the rate on its date (see fxrates.ts).
   */
  baseCurrency: (process.env.BASE_CURRENCY || 'EUR').toUpperCase(),
  /**
   * FX rate provider: auto (default) — ECB for the app's currencies, NBU for pairs
   * with the hryvnia; ecb / nbu — force a single provider (see fxrates.ts).
   */
  fxProvider: (['auto', 'ecb', 'nbu'].includes(process.env.FX_PROVIDER || 'auto')
    ? process.env.FX_PROVIDER || 'auto'
    : 'auto') as 'auto' | 'ecb' | 'nbu',
  monobankToken: process.env.MONOBANK_TOKEN || '',
  /**
   * From which date (YYYY-MM-DD) to keep history; by default — a year ago.
   * This isn't only the first sync's starting point: if the date moves back
   * (or the value is changed in .env), the sync backfills the missing chunk of
   * history — see the account's history_from.
   */
  syncStart,
  /**
   * A separate depth for Monobank: it returns at most 31 days per request and
   * enforces a 1 request / 60 s limit, so history costs time (a year — ≈47 minutes
   * to walk, half a year — half that). Enable Banking has no such limit, and there's
   * no reason to trim history there — hence the different defaults.
   */
  monobankSyncStart: process.env.MONOBANK_SYNC_START || process.env.SYNC_START || monthsAgo(6),
  /**
   * Account owner names, comma-separated — every spelling banks use
   * ("Yurii Kalvenko, Yuriy Kalvenko").
   * SOURCE OF TRUTH — the settings table (owner_names, editable from the app);
   * the env value is the seed at the initial migration and a fallback.
   * A transaction with all the words of one of these names in its description is a
   * transfer between your own accounts - neither income nor expense.
   */
  ownerNames: (process.env.OWNER_NAMES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  /**
   * Family member names. SOURCE OF TRUTH — the patterns of the family source in the
   * income_sources table (editable from the app); env is only the seed at the initial
   * migration. Works OPPOSITE to OWNER_NAMES: owner = "not income at all",
   * family = "income, but external" (kind = external).
   */
  familyNames: (process.env.FAMILY_NAMES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  ebAppId: process.env.EB_APP_ID || '',
  ebPrivateKeyPath: process.env.EB_PRIVATE_KEY_PATH || '',
  redirectUrl:
    process.env.REDIRECT_URL || `http://localhost:${port}/api/enablebanking/callback`,
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'finto.db'),
  /**
   * Auto-sync every N minutes (0 = off). SOURCE OF TRUTH —
   * settings.sync_interval_min (editable from the app without a restart);
   * env is the seed at the initial migration.
   */
  syncIntervalMin: parseInt(process.env.SYNC_INTERVAL_MIN || '360', 10) || 0,
};

let cachedKey: string | null = null;

/** Enable Banking private key (PEM). Read lazily so the backend starts even without it. */
export function ebPrivateKey(): string {
  if (cachedKey) return cachedKey;
  if (!config.ebPrivateKeyPath) {
    throw new Error('EB_PRIVATE_KEY_PATH is not set in .env');
  }
  const p = path.isAbsolute(config.ebPrivateKeyPath)
    ? config.ebPrivateKeyPath
    : path.join(__dirname, '..', config.ebPrivateKeyPath);
  cachedKey = fs.readFileSync(p, 'utf8');
  return cachedKey;
}
