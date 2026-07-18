/**
 * Enable Banking (https://enablebanking.com/docs/api/reference/) - the aggregator
 * through which Revolut, N26 and any other bank from their catalog are connected.
 *
 * The flow:
 * 1. POST /auth -> the bank's authorization URL (the user goes through it in a browser);
 * 2. the bank redirects to REDIRECT_URL with ?code=...&state=...;
 * 3. POST /sessions { code } -> session_id + the list of accounts;
 * 4. GET /accounts/{uid}/balances and /accounts/{uid}/transactions.
 *
 * App authorization is JWT RS256 (kid = app_id from the Control Panel).
 * A bank is parameterized by the pair (name, country) = ASPSP, so adding a new
 * bank is just another startAuth call with a different ASPSP.
 */
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { config, ebPrivateKey } from '../config';
import { categorize } from '../categorizer';
import {
  insertTransactions,
  listAccounts,
  listEbSessions,
  markAccountHistoryFrom,
  markAccountSynced,
  saveAuthState,
  saveEbSession,
  takeAuthState,
  updateAccountBalance,
  upsertAccount,
} from '../db';
import { SyncReporter } from './provider';
import { Transaction } from '../types';

const API = 'https://api.enablebanking.com';
const SESSION_DAYS = 90; // consent lifetime (PSD2)
const RESYNC_OVERLAP_DAYS = 7; // re-fetch the tail so late-posted operations aren't lost

export function ebConfigured(): boolean {
  return Boolean(config.ebAppId && config.ebPrivateKeyPath);
}

function appJwt(): string {
  return jwt.sign({}, ebPrivateKey(), {
    algorithm: 'RS256',
    keyid: config.ebAppId,
    issuer: 'enablebanking.com',
    audience: 'api.enablebanking.com',
    expiresIn: 3600,
  });
}

const FETCH_TIMEOUT_MS = 60_000;

async function ebFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    // without a timeout a hung request would leave sync in running: true forever
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${appJwt()}`,
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Enable Banking ${path} -> ${res.status}: ${body}`);
  }
  return (await res.json()) as T;
}

// ---------- bank catalog ----------

export async function listAspsps(country: string): Promise<{ name: string; country: string }[]> {
  const data = await ebFetch<{ aspsps: { name: string; country: string }[] }>(
    `/aspsps?country=${encodeURIComponent(country)}`,
  );
  return data.aspsps.map((a) => ({ name: a.name, country: a.country }));
}

// ---------- auth flow ----------

/** Step 1: returns the URL where the user authorizes with their bank. */
export async function startAuth(aspspName: string, aspspCountry: string): Promise<string> {
  const state = crypto.randomUUID();
  saveAuthState(state, aspspName, aspspCountry);
  const validUntil = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  const data = await ebFetch<{ url: string }>('/auth', {
    method: 'POST',
    body: JSON.stringify({
      access: { valid_until: validUntil },
      aspsp: { name: aspspName, country: aspspCountry },
      state,
      redirect_url: config.redirectUrl,
      psu_type: 'personal',
    }),
  });
  return data.url;
}

interface EbAccountResource {
  uid: string;
  account_id?: { iban?: string };
  name?: string;
  product?: string;
  currency?: string;
  cash_account_type?: string;
}

/** Step 2 (callback): exchange the code for a session and store the accounts. */
export async function completeAuth(
  code: string,
  state: string,
): Promise<{ bank: string; accounts: string[] }> {
  const st = takeAuthState(state);
  if (!st) throw new Error('Unknown or already used state in the callback');

  const session = await ebFetch<{
    session_id: string;
    accounts: EbAccountResource[];
    access?: { valid_until?: string };
  }>('/sessions', { method: 'POST', body: JSON.stringify({ code }) });

  const validUntil =
    session.access?.valid_until ||
    new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();

  saveEbSession({
    sessionId: session.session_id,
    aspspName: st.aspspName,
    aspspCountry: st.aspspCountry,
    validUntil,
  });

  const names: string[] = [];
  for (const acc of session.accounts) {
    const ibanTail = acc.account_id?.iban ? '…' + acc.account_id.iban.slice(-4) : '';
    const name =
      `${st.aspspName} ${acc.product || acc.name || acc.cash_account_type || ''} ${ibanTail}`
        .replace(/\s+/g, ' ')
        .trim();
    upsertAccount({
      id: `eb:${acc.uid}`,
      provider: 'enablebanking',
      name,
      currency: acc.currency || 'EUR',
      balance: 0, // filled in on the first sync
      iban: acc.account_id?.iban,
      ebSessionId: session.session_id,
    });
    names.push(name);
  }
  return { bank: st.aspspName, accounts: names };
}

// ---------- data ----------

interface EbBalance {
  balance_type?: string;
  balance_amount: { currency: string; amount: string };
}

interface EbTransaction {
  entry_reference?: string;
  merchant_category_code?: string;
  transaction_amount: { currency: string; amount: string };
  credit_debit_indicator: 'CRDT' | 'DBIT';
  status?: string;
  booking_date?: string;
  value_date?: string;
  transaction_date?: string;
  remittance_information?: string[];
  creditor?: { name?: string };
  debtor?: { name?: string };
  note?: string;
}

function txDescription(t: EbTransaction): string {
  const rem = (t.remittance_information || []).filter(Boolean).join(' ').trim();
  if (rem) return rem;
  if (t.credit_debit_indicator === 'DBIT' && t.creditor?.name) return t.creditor.name;
  if (t.credit_debit_indicator === 'CRDT' && t.debtor?.name) return t.debtor.name;
  return t.note || '';
}

function txId(accountUid: string, t: EbTransaction): string {
  if (t.entry_reference) return `eb:${accountUid}:${t.entry_reference}`;
  // some banks have no entry_reference - a deterministic hash of the contents
  const hash = crypto.createHash('sha256').update(JSON.stringify(t)).digest('hex').slice(0, 32);
  return `eb:${accountUid}:h:${hash}`;
}

function toTransaction(accountUid: string, t: EbTransaction): Transaction {
  const abs = Math.abs(parseFloat(t.transaction_amount.amount));
  const amount = t.credit_debit_indicator === 'DBIT' ? -abs : abs;
  const date = t.booking_date || t.transaction_date || t.value_date || '';
  const description = txDescription(t);
  const mcc = t.merchant_category_code ? parseInt(t.merchant_category_code, 10) : undefined;
  return {
    id: txId(accountUid, t),
    accountId: `eb:${accountUid}`,
    provider: 'enablebanking',
    amount,
    currency: t.transaction_amount.currency,
    date: date ? `${date}T00:00:00.000Z` : new Date().toISOString(),
    description,
    mcc: mcc && !Number.isNaN(mcc) ? mcc : undefined,
    category: categorize(mcc && !Number.isNaN(mcc) ? mcc : undefined, description, amount),
  };
}

async function syncEbAccount(
  accountDbId: string,
  lastSyncedAt: string | undefined,
  historyFrom: string | undefined,
  r: SyncReporter,
): Promise<void> {
  const log = r.log;
  const uid = accountDbId.replace(/^eb:/, '');

  // balance: prefer booked (CLBD), otherwise whichever comes first
  const balData = await ebFetch<{ balances: EbBalance[] }>(`/accounts/${uid}/balances`);
  const bal =
    balData.balances.find((b) => b.balance_type === 'CLBD') || balData.balances[0];
  if (bal) updateAccountBalance(accountDbId, parseFloat(bal.balance_amount.amount));

  // Normally we only fetch the tail (with a 7-day overlap). But if the history isn't
  // loaded as deep as SYNC_START asks, fetch everything from SYNC_START: duplicates
  // are dropped by id, and the missing year appears.
  const needHistory = !historyFrom || historyFrom.slice(0, 10) > config.syncStart;
  const dateFrom =
    !needHistory && lastSyncedAt
      ? new Date(Date.parse(lastSyncedAt) - RESYNC_OVERLAP_DAYS * 86_400_000)
          .toISOString()
          .slice(0, 10)
      : config.syncStart;
  if (needHistory) log(`enablebanking: ${accountDbId} backfilling history since ${config.syncStart}`);

  let inserted = 0;
  let continuationKey: string | undefined;
  do {
    const qs = new URLSearchParams({ date_from: dateFrom });
    if (continuationKey) qs.set('continuation_key', continuationKey);
    const page = await ebFetch<{ transactions: EbTransaction[]; continuation_key?: string }>(
      `/accounts/${uid}/transactions?${qs.toString()}`,
    );
    const booked = page.transactions.filter((t) => !t.status || t.status === 'BOOK');
    inserted += insertTransactions(booked.map((t) => toTransaction(uid, t)));
    continuationKey = page.continuation_key;
  } while (continuationKey);

  markAccountSynced(accountDbId, new Date().toISOString());
  markAccountHistoryFrom(accountDbId, `${dateFrom}T00:00:00.000Z`);
  r.addInserted(inserted);
  log(`enablebanking: ${accountDbId} new transactions: ${inserted}`);
}

export async function syncEnableBanking(r: SyncReporter): Promise<void> {
  const log = r.log;
  const sessions = listEbSessions();
  if (sessions.length === 0) {
    log('enablebanking: no banks connected (open /api/enablebanking/connect?bank=...&country=...)');
    return;
  }

  const now = Date.now();
  const validIds = new Set(
    sessions.filter((s) => Date.parse(s.validUntil) > now).map((s) => s.sessionId),
  );
  for (const s of sessions) {
    if (!validIds.has(s.sessionId)) {
      r.error(`enablebanking: the ${s.aspspName} session expired on ${s.validUntil} - reconnect the bank`);
    }
  }

  // listAccounts() without an argument returns visible ones only - sync skips hidden accounts
  const ebAccounts = listAccounts().filter((a) => a.provider === 'enablebanking');
  for (const acc of ebAccounts) {
    if (!acc.ebSessionId || !validIds.has(acc.ebSessionId)) {
      log(`enablebanking: skipping ${acc.name} - no valid session`);
      continue;
    }
    try {
      log(`enablebanking: syncing ${acc.name}...`);
      await syncEbAccount(acc.id, acc.lastSyncedAt, acc.historyFrom, r);
    } catch (e) {
      // do not fail the whole sync because of one account
      r.error(`enablebanking: error on ${acc.name}: ${(e as Error).message}`);
    }
  }
}
