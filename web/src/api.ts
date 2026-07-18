import {
  Account,
  AppSettings,
  BaselineResponse,
  BudgetsResponse,
  CategoryRule,
  CsvImportResult,
  Independence,
  IncomeSource,
  IncomeSourceDef,
  IncomeSourceKind,
  MonthlySummary,
  OnboardingStatus,
  RecurringSummary,
  Settings,
  Summary,
  SyncJournalRun,
  SyncStatus,
  Transaction,
  TransferRule,
} from './types';

/**
 * Backend address.
 *
 * In dev this is '' — the Vite dev server proxies /api to the backend (see
 * vite.config.ts), so requests go to our own origin and there's no CORS at all.
 * A production build needs the real address in VITE_API_URL, unless the bundle is
 * served by something that proxies /api itself.
 */
function detectBaseUrl(): string {
  const fromEnv = import.meta.env.VITE_API_URL;
  return fromEnv ? fromEnv.replace(/\/$/, '') : '';
}

export const API_BASE = detectBaseUrl();

/** Human-readable API address for the "API: …" hint in the UI. */
export const apiLabel = (): string => API_BASE || `${window.location.origin} (proxy)`;

/** Shared backend secret (API_KEY in backend/.env). Set in web/.env. */
const API_KEY = import.meta.env.VITE_API_KEY ?? '';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(API_KEY ? { 'x-api-key': API_KEY } : {}),
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export interface TxQuery {
  from?: string;
  to?: string;
  accountId?: string;
  category?: string;
  limit?: number;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const api = {
  /** includeHidden — include hidden accounts (Accounts screen, so they can be restored). */
  accounts: (includeHidden = false) =>
    request<Account[]>(`/api/accounts${includeHidden ? '?all=1' : ''}`),

  /** Remove an account from the app or bring it back. */
  setAccountHidden: (id: string, hidden: boolean) =>
    request<Account>(`/api/accounts/${encodeURIComponent(id)}`, json('PATCH', { hidden })),

  transactions: (query: TxQuery) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v) qs.set(k, String(v));
    return request<Transaction[]>(`/api/transactions?${qs.toString()}`);
  },

  /** Set/clear "transfer between own accounts". null — hand the decision back to auto-detection. */
  setTransfer: (id: string, transfer: boolean | null) =>
    request<Transaction>(
      `/api/transactions/${encodeURIComponent(id)}/transfer`,
      json('PATCH', { transfer }),
    ),

  transferRules: () => request<TransferRule[]>('/api/transfer-rules'),

  /**
   * "Mark every transaction like this as a transfer" — a rule by the transaction's
   * description and account. Applied to the whole history at once and to every new
   * transaction from then on.
   */
  addTransferRule: (txId: string) =>
    request<{ rule: TransferRule; matches: number }>(
      '/api/transfer-rules',
      json('POST', { txId }),
    ),

  deleteTransferRule: (id: number) =>
    request<{ deleted: boolean }>(`/api/transfer-rules/${id}`, json('DELETE')),

  summary: (from: string, to: string) =>
    request<Summary>(`/api/summary?from=${from}&to=${to}`),

  /** Spending/income by month — the "over the year" chart. */
  months: (from: string, to: string) =>
    request<MonthlySummary>(`/api/summary/months?from=${from}&to=${to}`),

  /** Manually set the income source. null — hand the decision back to auto-detection. */
  setIncomeSource: (id: string, source: IncomeSource | null) =>
    request<Transaction>(
      `/api/transactions/${encodeURIComponent(id)}/source`,
      json('PATCH', { source }),
    ),

  /** Set/clear "one-off large purchase" (amortized into average spending). */
  setOneOff: (id: string, oneOff: boolean) =>
    request<Transaction>(
      `/api/transactions/${encodeURIComponent(id)}/one-off`,
      json('PATCH', { oneOff }),
    ),

  /** Recurring payments over the last 12 months. */
  recurring: () => request<RecurringSummary>('/api/recurring'),

  /** Hide a group of recurring payments from the Overview or bring it back. */
  setRecurringIgnored: (description: string, ignored: boolean) =>
    request<RecurringSummary>('/api/recurring/ignore', json('POST', { description, ignored })),

  /** The headline metric: how much you need to earn. */
  independence: () => request<Independence>('/api/independence'),

  settings: () => request<Settings>('/api/settings'),
  updateSettings: (patch: Partial<Settings>) =>
    request<Settings>('/api/settings', json('PATCH', patch)),

  /** Baseline minimum line items: what "living on your own" adds up to. */
  baseline: () => request<BaselineResponse>('/api/baseline'),

  /** monthly = null deletes the line item. */
  setBaselineItem: (label: string, monthly: number | null) =>
    request<BaselineResponse>('/api/baseline', json('PUT', { label, monthly })),

  categoryRules: () => request<CategoryRule[]>('/api/category-rules'),

  /**
   * A "description contains … -> category" rule (+ a full recompute on the backend).
   *
   * Take `pattern` where the bank appends something changing to every line — a month
   * in a rent reference, a contract number: a rule built from one full description
   * would then match that single transaction and nothing else. `txId` is the shorthand
   * for "the whole description as it is".
   */
  addCategoryRule: (target: { txId: string } | { pattern: string }, category: string) =>
    request<{ rule: CategoryRule; matches: number }>(
      '/api/category-rules',
      json('POST', { ...target, category }),
    ),

  deleteCategoryRule: (id: number) =>
    request<{ deleted: boolean }>(`/api/category-rules/${id}`, json('DELETE')),

  budgets: () => request<BudgetsResponse>('/api/budgets'),

  /** monthly = null removes the budget from the category. */
  setBudget: (category: string, monthly: number | null) =>
    request<{ budgets: { category: string; monthly: number }[] }>(
      '/api/budgets',
      json('PUT', { category, monthly }),
    ),

  startSync: () =>
    request<{ started: boolean; status: SyncStatus }>('/api/sync', { method: 'POST' }),

  syncStatus: () => request<SyncStatus>('/api/sync/status'),

  syncJournal: (limit = 10) =>
    request<{ runs: SyncJournalRun[] }>(`/api/sync/journal?limit=${limit}`),

  incomeSources: () => request<IncomeSourceDef[]>('/api/income-sources'),

  addIncomeSource: (label: string, kind: IncomeSourceKind, patterns: string[] = []) =>
    request<IncomeSourceDef>('/api/income-sources', json('POST', { label, kind, patterns })),

  updateIncomeSource: (
    id: string,
    patch: Partial<Pick<IncomeSourceDef, 'label' | 'kind' | 'patterns'>>,
  ) =>
    request<IncomeSourceDef>(`/api/income-sources/${encodeURIComponent(id)}`, json('PUT', patch)),

  deleteIncomeSource: (id: string) =>
    request<{ deleted: boolean }>(`/api/income-sources/${encodeURIComponent(id)}`, json('DELETE')),

  appSettings: () => request<AppSettings>('/api/app-settings'),
  updateAppSettings: (patch: Partial<AppSettings>) =>
    request<AppSettings>('/api/app-settings', json('PATCH', patch)),

  onboardingStatus: () => request<OnboardingStatus>('/api/onboarding/status'),

  /** CSV statement import: any bank without an API. */
  csvImport: (payload: {
    accountName: string;
    currency: string;
    preset?: string;
    csv: string;
  }) => request<CsvImportResult>('/api/csv/import', json('POST', payload)),

  csvPresets: () => request<{ presets: { key: string; title: string }[] }>('/api/csv/presets'),
};

/**
 * URL for a full DB backup — opened as a normal link, and a plain navigation can't
 * carry headers, so the key goes as a query parameter (see the backend).
 */
export const backupUrl = (): string =>
  `${API_BASE}/api/backup${API_KEY ? `?key=${encodeURIComponent(API_KEY)}` : ''}`;
