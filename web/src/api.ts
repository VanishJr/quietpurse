import {
  Account,
  AppSettings,
  BaselineResponse,
  BudgetsResponse,
  CategoryRule,
  CsvImportResult,
  ImportConfirmed,
  Independence,
  IncomeSource,
  IncomeSourceDef,
  IncomeSourceKind,
  MonthlySummary,
  OnboardingStatus,
  RecurringSummary,
  Settings,
  Summary,
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

/**
 * Thrown when the backend says "sign in required". The app catches it to send the
 * user back to the login screen instead of showing a raw error on every panel
 * (a session can expire while the tab sits open).
 */
export class UnauthorizedError extends Error {
  constructor() {
    super('sign in required');
    this.name = 'UnauthorizedError';
  }
}

/** Listeners notified once when any request comes back 401 (App.tsx re-checks the session). */
const unauthorizedListeners = new Set<() => void>();

export function onUnauthorized(fn: () => void): () => void {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

/**
 * The backend composes a refusal to exactly this budget (ERROR_DETAIL_MAX in
 * backend/src/db/index.ts) and orders the clauses of the long ones on the premise
 * that all of it is read. Cutting it shorter here drops the clause it put last and
 * ends the sentence mid-token.
 */
const MAX_ERROR_CHARS = 500;

/** A proxy's error page is unbounded and is not written for a person to read. */
const MAX_RAW_BODY_CHARS = 200;

/** Cut with a mark, so a message with more behind it does not read as a broken one. */
const bounded = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    // the session lives in a cookie: it has to ride along on cross-origin
    // requests too (a production build pointed at VITE_API_URL)
    credentials: 'include',
    headers: { ...(init?.headers || {}) },
  });
  if (res.status === 401) {
    for (const fn of unauthorizedListeners) fn();
    throw new UnauthorizedError();
  }
  if (!res.ok) {
    // the API reports a failure as { error } and the sentence in it is written for
    // the user ("export the statement as CSV or Excel…"); showing the raw body
    // buries it in JSON on every screen
    const body = await res.text();
    let message = bounded(`${res.status}: ${body}`, MAX_RAW_BODY_CHARS);
    try {
      const parsed = JSON.parse(body) as { error?: unknown };
      if (typeof parsed.error === 'string') message = bounded(parsed.error, MAX_ERROR_CHARS);
    } catch {
      // not JSON — the status and the body are all there is
    }
    throw new Error(message);
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

// ---------- auth (better-auth, /api/auth/*) ----------

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

/**
 * Auth calls go through their own request function: a 401 here means "wrong
 * password", not "your session expired", and must not kick the app back to the
 * login screen it is already on. better-auth reports failures as
 * { message, code } - the message is what the user should read.
 */
async function authRequest<T>(
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const res = await fetch(`${API_BASE}/api/auth${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 200);
    try {
      const parsed = JSON.parse(text) as { message?: string };
      if (parsed.message) message = parsed.message;
    } catch {
      // not JSON - fall back to the raw body
    }
    throw new Error(message);
  }
  return (text ? JSON.parse(text) : null) as T;
}

export const auth = {
  /** The signed-in user, or null. Called once at startup to decide login vs app. */
  session: async (): Promise<SessionUser | null> => {
    const res = await fetch(`${API_BASE}/api/auth/get-session`, { credentials: 'include' });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text) return null;
    const data = JSON.parse(text) as { user?: SessionUser } | null;
    return data?.user ?? null;
  },

  /**
   * Whether this server lets anyone register or requires an invite code
   * (SIGNUP_INVITE_CODE on the backend). Open endpoint - safe before signing in.
   */
  signupMode: async (): Promise<'open' | 'invite'> => {
    try {
      const res = await fetch(`${API_BASE}/api/health`);
      if (!res.ok) return 'open';
      return ((await res.json()) as { signup?: string }).signup === 'invite' ? 'invite' : 'open';
    } catch {
      return 'open'; // backend unreachable - the form will fail loudly on submit anyway
    }
  },

  /**
   * Registration also creates and seeds the user's personal workspace (backend
   * side). The invite code, when the server asks for one, travels as a header:
   * it gates the request rather than being part of the account.
   */
  register: (email: string, password: string, name: string, inviteCode?: string) =>
    authRequest<{ user: SessionUser }>(
      '/sign-up/email',
      { email, password, name },
      inviteCode ? { 'x-invite-code': inviteCode } : undefined,
    ),

  login: (email: string, password: string) =>
    authRequest<{ user: SessionUser }>('/sign-in/email', { email, password }),

  logout: () => authRequest<unknown>('/sign-out'),
};

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

  /**
   * Statement import: any bank without an API. One endpoint for every format —
   * the file field carries the bytes and the backend works out what they are. No
   * Content-Type here on purpose: the browser sets it, with the multipart boundary.
   *
   * It imports nothing. The rows are staged behind a summary, and confirmImport
   * below is what makes them part of the user's data.
   */
  importStatement: (form: FormData) =>
    request<CsvImportResult>('/api/imports', { method: 'POST', body: form }),

  /** Accepts a summary: the rows land and the backend answers with what actually did. */
  confirmImport: (importId: string) =>
    request<ImportConfirmed>(`/api/imports/${encodeURIComponent(importId)}/confirm`, {
      method: 'POST',
    }),

  /** Rejects it: the staged rows go, and the same file can be uploaded again. */
  discardImport: (importId: string) =>
    request<{ discarded: boolean; importId: string }>(
      `/api/imports/${encodeURIComponent(importId)}/discard`,
      { method: 'POST' },
    ),

  importPresets: () =>
    request<{ presets: { key: string; title: string }[] }>('/api/imports/presets'),
};

/**
 * URL for a full backup of the current workspace — opened as a normal link.
 * The session cookie rides along with the navigation by itself, so unlike the
 * shared-secret era this needs no credentials in the query string.
 */
export const backupUrl = (): string => `${API_BASE}/api/backup`;
