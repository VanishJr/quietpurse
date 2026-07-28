/**
 * Monobank personal API: https://api.monobank.ua/docs/
 * - GET /personal/client-info - accounts
 * - GET /personal/statement/{account}/{from}/{to} - statement (unix seconds)
 *
 * API limits taken into account here:
 * - a statement window of at most 31 days + 1 hour (2,682,000 seconds);
 * - at most 1 statement request per 60 seconds - we wait between requests;
 * - at most 500 operations per response: if exactly 500 arrive, the window is
 *   read again with to = the timestamp of the oldest operation - 1.
 */
import { config } from '../config';
import { categorize } from '../categorizer';
import { currencyName } from '../currency';
import {
  insertTransactions,
  listAccounts,
  markAccountHistoryFrom,
  markAccountSynced,
  setMeta,
  upsertAccount,
} from '../db';
import { SyncReporter } from './provider';
import { NewTransaction } from '../types';

const API = 'https://api.monobank.ua';
const MAX_RANGE_SEC = 2_682_000; // 31 days + 1 hour
const RATE_DELAY_MS = 61_000;
const STATEMENT_PAGE_LIMIT = 500;

interface MonoAccount {
  id: string;
  balance: number; // minor units
  creditLimit: number;
  currencyCode: number;
  maskedPan: string[];
  type: string;
  iban: string;
}

interface MonoClientInfo {
  clientId: string;
  name: string;
  accounts: MonoAccount[];
}

interface MonoStatementItem {
  id: string;
  time: number; // unix seconds
  description: string;
  mcc: number;
  originalMcc: number;
  amount: number; // minor units, spending < 0
  operationAmount: number;
  currencyCode: number;
  balance: number;
  hold: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let lastStatementCallAt = 0;

/** Guarantees a pause of >= 60 s between statement requests. */
async function statementRateLimit(log: (s: string) => void): Promise<void> {
  const wait = lastStatementCallAt + RATE_DELAY_MS - Date.now();
  if (wait > 0) {
    log(`monobank: waiting ${Math.ceil(wait / 1000)} s (limit 1 request/60 s)...`);
    await sleep(wait);
  }
  lastStatementCallAt = Date.now();
}

const FETCH_TIMEOUT_MS = 30_000;
const MAX_429_RETRIES = 3;

async function monoGet<T>(path: string, attempt = 0): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { 'X-Token': config.monobankToken },
    // without a timeout a hung request would leave sync in running: true forever
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status === 429) {
    if (attempt >= MAX_429_RETRIES) {
      throw new Error(`Monobank ${path} -> 429 after ${MAX_429_RETRIES} retries`);
    }
    await sleep(RATE_DELAY_MS);
    return monoGet<T>(path, attempt + 1);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Monobank ${path} -> ${res.status}: ${body}`);
  }
  return (await res.json()) as T;
}

function toTransaction(accountDbId: string, accountCurrency: string, item: MonoStatementItem): NewTransaction {
  // amount is already in the account's currency; currencyCode on a statement item is
  // the currency of the OPERATION (contrary to the Monobank docs), so the account's
  // currency is used instead of it
  const amount = item.amount / 100;
  return {
    // Monobank gives every operation a stable id of its own - the dedup key needs
    // nothing computed, and paging a statement window is therefore harmless
    dedupKey: `mono:${item.id}`,
    accountId: accountDbId,
    provider: 'monobank',
    amount,
    currency: accountCurrency,
    date: new Date(item.time * 1000).toISOString(),
    description: item.description || '',
    mcc: item.mcc || undefined,
    category: categorize(item.mcc, item.description, amount),
  };
}

/** Reads one window [from, to], honouring the 500-operations-per-response limit. */
async function fetchWindow(
  account: MonoAccount,
  accountDbId: string,
  fromSec: number,
  toSec: number,
  log: (s: string) => void,
): Promise<number> {
  let inserted = 0;
  let curTo = toSec;
  for (;;) {
    await statementRateLimit(log);
    const items = await monoGet<MonoStatementItem[]>(
      `/personal/statement/${account.id}/${fromSec}/${curTo}`,
    );
    const accountCurrency = currencyName(account.currencyCode);
    inserted += await insertTransactions(
      items.map((i) => toTransaction(accountDbId, accountCurrency, i)),
    );
    if (items.length < STATEMENT_PAGE_LIMIT) break;
    // a full page arrived - continue from the oldest operation
    const oldest = items[items.length - 1].time;
    if (oldest - 1 <= fromSec) break;
    curTo = oldest - 1;
  }
  return inserted;
}

/**
 * Which intervals to request from the bank for an account:
 * - the "tail" - from the last sync until now (with an hour of slack);
 * - the "history backfill" - from SYNC_START to the earliest transaction already
 *   loaded, if SYNC_START moved deeper (e.g. the default became a year, not 90 days).
 * Duplicates are dropped on insert by the operation id, so overlaps are harmless.
 */
export function windowsToFetch(
  syncStartSec: number,
  lastSyncedAt: string | undefined,
  historyFrom: string | undefined,
  nowSec: number,
): { from: number; to: number; kind: 'history' | 'new' }[] {
  if (!lastSyncedAt) return [{ from: syncStartSec, to: nowSec, kind: 'history' }];

  const forwardFrom = Math.floor(Date.parse(lastSyncedAt) / 1000) - 3600;
  const loadedFrom = historyFrom ? Math.floor(Date.parse(historyFrom) / 1000) : forwardFrom;
  const windows: { from: number; to: number; kind: 'history' | 'new' }[] = [];
  if (syncStartSec < loadedFrom) {
    windows.push({ from: syncStartSec, to: Math.min(loadedFrom, nowSec), kind: 'history' });
  }
  windows.push({ from: forwardFrom, to: nowSec, kind: 'new' });
  return windows;
}

/** How many statement requests an interval needs (the API window is 31 days). */
function windowCount(from: number, to: number): number {
  return Math.max(1, Math.ceil((to - from) / MAX_RANGE_SEC));
}

export async function syncMonobank(r: SyncReporter): Promise<void> {
  const log = r.log;
  log('monobank: requesting the list of accounts...');
  const info = await monoGet<MonoClientInfo>('/personal/client-info');

  // the owner's name is one of the hints for finding transfers between own accounts
  if (info.name) await setMeta('monobank_client_name', info.name);

  for (const a of info.accounts) {
    const name = `Mono ${a.type}${a.maskedPan?.[0] ? ' ' + a.maskedPan[0] : ''} (${currencyName(a.currencyCode)})`;
    await upsertAccount({
      id: `mono:${a.id}`,
      provider: 'monobank',
      name,
      currency: currencyName(a.currencyCode),
      balance: (a.balance - a.creditLimit) / 100,
      iban: a.iban,
    });
  }
  log(`monobank: accounts: ${info.accounts.length}`);

  const dbAccounts = new Map((await listAccounts(true)).map((a) => [a.id, a]));
  const nowSec = Math.floor(Date.now() / 1000);
  const syncStartSec = Math.floor(Date.parse(config.monobankSyncStart + 'T00:00:00Z') / 1000);
  const syncStartIso = new Date(syncStartSec * 1000).toISOString();

  // Hidden accounts are not fetched: every statement costs a minute of waiting
  // (limit 1 request/60 s), and the account stays out of analytics anyway.
  const visible = info.accounts.filter((a) => !dbAccounts.get(`mono:${a.id}`)?.hidden);
  const skipped = info.accounts.length - visible.length;
  if (skipped > 0) log(`monobank: skipping hidden accounts: ${skipped}`);

  const plan = visible.map((a) => ({
    account: a,
    dbId: `mono:${a.id}`,
    windows: windowsToFetch(
      syncStartSec,
      dbAccounts.get(`mono:${a.id}`)?.lastSyncedAt,
      dbAccounts.get(`mono:${a.id}`)?.historyFrom,
      nowSec,
    ),
  }));

  // warn up front: the 1 request/60 s limit makes backfilling a year slow
  const requests = plan.reduce(
    (n, p) => n + p.windows.reduce((m, w) => m + windowCount(w.from, w.to), 0),
    0,
  );
  if (requests > 4) {
    log(
      `monobank: history since ${config.monobankSyncStart}; ~${requests} statement requests, about ${Math.ceil((requests * RATE_DELAY_MS) / 60_000)} min (limit 1 request/60 s)`,
    );
  }

  for (const { account: a, dbId, windows } of plan) {
    // an error on one account must not abort the others (same as EB)
    try {
      let total = 0;
      for (const w of windows) {
        let fromSec = w.from;
        while (fromSec < w.to) {
          const toSec = Math.min(fromSec + MAX_RANGE_SEC, w.to);
          log(
            `monobank: ${dbId} ${w.kind} ${new Date(fromSec * 1000).toISOString().slice(0, 10)} — ${new Date(toSec * 1000).toISOString().slice(0, 10)}...`,
          );
          total += await fetchWindow(a, dbId, fromSec, toSec, log);
          fromSec = toSec + 1;
        }
      }
      await markAccountSynced(dbId, new Date().toISOString());
      await markAccountHistoryFrom(dbId, syncStartIso);
      r.addInserted(total);
      log(`monobank: ${dbId} new transactions: ${total}`);
    } catch (e) {
      r.error(`monobank: error on ${dbId}: ${(e as Error).message}`);
    }
  }
}
