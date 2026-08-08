import {
  Account,
  AppSettings,
  BaselineResponse,
  BudgetsResponse,
  CategoryRule,
  CsvImportResult,
  ImportConfirmed,
  ImportRecord,
  Independence,
  IncomeSource,
  IncomeSourceDef,
  IncomeSourceKind,
  MonthlySummary,
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

/**
 * A proxy's error page is unbounded and is not written for a person to read.
 * Exported for the one test that has to know it: the auth classifier reads a
 * message this bound has already cut, so a refusal longer than it is classified
 * on a truncated string.
 */
export const MAX_RAW_BODY_CHARS = 200;

/** Cut with a mark, so a message with more behind it does not read as a broken one. */
const bounded = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/**
 * What a non-2xx becomes. Shared by both callers below rather than written twice:
 * a download that skipped it would build an object URL from a body nobody read and
 * write the refusal to disk under the name of a statement (item 10's D23).
 */
async function refuse(res: Response): Promise<never> {
  if (res.status === 401) {
    for (const fn of unauthorizedListeners) fn();
    throw new UnauthorizedError();
  }
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    // the session lives in a cookie: it has to ride along on cross-origin
    // requests too (a production build pointed at VITE_API_URL)
    credentials: 'include',
    headers: { ...(init?.headers || {}) },
  });
  if (!res.ok) await refuse(res);
  return (await res.json()) as T;
}

/**
 * Bytes or a throw — never a Response and never a URL. A route answering a file is
 * a route that can answer 401 or 500, and `<a href download>` saves both.
 */
async function download(path: string): Promise<Blob> {
  const res = await fetch(`${API_BASE}${path}`, { credentials: 'include' });
  if (!res.ok) await refuse(res);
  return await res.blob();
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
 * Mirrors better-auth's minPasswordLength (backend/src/auth.ts). A courtesy that
 * saves a round trip, never the holder: the endpoint refuses a short password
 * itself whatever the client believes.
 */
export const MIN_PASSWORD = 8;

/**
 * "You are signed out" is a claim only the server can make: it answers a signed-out
 * visitor 200 with no user. Everything else — a status, an unreadable body, a fetch
 * that never landed — is "we could not ask", and flattening the two onto null is
 * what handed a dead server's visitor a password form.
 */
export type SessionResult =
  | { state: 'signed-in'; user: SessionUser }
  | { state: 'signed-out' }
  | { state: 'unreachable'; reason: string };

/**
 * What an auth call failed with, rather than only what to print. A caller reading
 * .message alone is unaffected; changePassword below cannot be written without the
 * status, and reconstructing it from the message is what makes a rate limit read as
 * a wrong password.
 *
 * Not exported: a screen that could catch this could branch on the status itself,
 * which is the classification PasswordChange exists to keep out of components.
 */
class AuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * Auth calls go through their own request function: a 401 here means "wrong
 * password", not "your session expired", and must not kick the app back to the
 * login screen it is already on. better-auth reports failures as { message, code }.
 *
 * The cut is MAX_RAW_BODY_CHARS and not MAX_ERROR_CHARS: 500 is the budget the
 * backend composes import refusals to, and nothing on this path is written to it.
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
    // the status the way refuse() keeps it, and the cut marked, so a proxy's error
    // page does not arrive as 200 characters of markup reading like a finished sentence
    let message = bounded(`${res.status}: ${text}`, MAX_RAW_BODY_CHARS);
    let code: string | undefined;
    try {
      const parsed = JSON.parse(text) as { message?: unknown; error?: unknown; code?: unknown };
      // better-auth says { message }; the invite gate in backend/src/app.ts says
      // { error }, which is refuse()'s contract - read both, or a wrong invite code
      // reaches the screen as literal JSON
      const said =
        typeof parsed.message === 'string'
          ? parsed.message
          : typeof parsed.error === 'string'
            ? parsed.error
            : undefined;
      // truthiness rather than `!== undefined`: an empty string is the server
      // saying nothing, and quoting it renders "It said:" and then the end of the
      // sentence, with the status thrown away as well
      if (said) message = bounded(said, MAX_RAW_BODY_CHARS);
      if (typeof parsed.code === 'string') code = parsed.code;
    } catch {
      // not JSON - the status and the body are all there is
    }
    throw new AuthError(message, res.status, code);
  }
  return (text ? JSON.parse(text) : null) as T;
}

/**
 * Every outcome of a password change, because two of them are indistinguishable to
 * a catch block. better-auth writes the new password and only then deletes the old
 * sessions and mints a replacement, outside any transaction - so a failure after
 * the write leaves the account on the NEW password with nothing on the wire saying
 * so, and "could not change your password" would send the owner back to a password
 * that no longer works.
 *
 * The branch is the HTTP status, which is the only rule the library's own ordering
 * guarantees: every BAD_REQUEST in the handler is thrown above the write, and the
 * session middleware's 401 above the handler.
 */
export type PasswordChange =
  | { outcome: 'changed' }
  /** Refused before the write, so the old password still stands. */
  | { outcome: 'refused'; message: string; wrongCurrent: boolean }
  /** No session to change a password for; nothing was written. */
  | { outcome: 'signed-out' }
  /** The password may or may not be the new one. Only signing in can tell. */
  | { outcome: 'unknown'; detail: string };

/**
 * Every outcome of a sign-in or a sign-up. One type for both because they fail in
 * the same ways and one switch in AuthScreen reads them, and total because a catch
 * block is how the server's own words - a Zod field path, a library's message -
 * reached the one screen a person meets before they have an account.
 *
 * A named member carries no server text: the classification decides which failure
 * it is, the screen decides what to say. 'unexpected' is the exception and has to
 * be, see its own comment.
 */
export type AuthAttempt =
  /** Carries no user: the caller re-asks the server, exactly as PasswordChange.changed does. */
  | { outcome: 'signed-in' }
  /** Not an address this server will accept - a missing ending, a typo. */
  | { outcome: 'bad-email' }
  /** Deliberately non-enumerating: the server will not say which of the two is wrong. */
  | { outcome: 'wrong-credentials' }
  | { outcome: 'email-taken' }
  | { outcome: 'password-too-short' }
  /** The bucket is shared, so waiting is the action and it may not have been this visitor. */
  | { outcome: 'rate-limited' }
  /** This client sent a body the schema refused. Carries no text: it is written for a developer. */
  | { outcome: 'malformed-request' }
  /** The request never landed, so nothing can be said about the account. */
  | { outcome: 'unreachable'; reason: string }
  /**
   * The server refused and this client has no name for it. It carries the server's
   * text and dropping it would be the defect: when email verification lands, sign-in
   * gains a refusal this client will not know by name, and "something went wrong"
   * would leave a solvable problem with no way to see it. Bounded and framed as the
   * server's words, not replaced with ours.
   */
  | { outcome: 'unexpected'; detail: string };

/**
 * A VALIDATION_ERROR message is a '; '-joined list, one clause per failing field
 * (better-call's validator). Matching the email clause alone would call
 * "[body.email] …; [body.password] …" an email problem and drop the other half, so
 * the condition is every clause and anything else degrades to malformed-request -
 * never to a sentence telling someone to fix an address that was not the problem.
 */
const onlyAboutEmail = (message: string): boolean =>
  message.split('; ').every((clause) => clause.startsWith('[body.email]'));

/**
 * Hand-maintained mirror of the codes better-auth answers on /sign-in/email and
 * /sign-up/email (BASE_ERROR_CODES in @better-auth/core). Like ImportSourceType it
 * is checked by nothing: a code the library adds arrives at 'unexpected' with no
 * compile error anywhere, which is why 'unexpected' prints what the server said
 * rather than a sentence of ours.
 *
 * The two tabs answer one typo two different ways - /sign-up/email declares
 * email: z.email() and is refused by the schema above the handler, /sign-in/email
 * declares email: z.string() and is refused inside it - so this cannot be a rule
 * about VALIDATION_ERROR alone or the tab almost every visit uses is untouched.
 */
const classify = (e: unknown): AuthAttempt => {
  // a fetch that never landed is not a refusal, and nothing below it can read one
  if (!(e instanceof AuthError))
    return {
      outcome: 'unreachable',
      reason: bounded(e instanceof Error ? e.message : String(e), MAX_RAW_BODY_CHARS),
    };
  // the rate limiter answers a message and no code, so the status is the only key
  if (e.status === 429) return { outcome: 'rate-limited' };
  // the one code whose message is known to be written for a developer, answered
  // above the table so that it can never reach 'unexpected', which prints it
  if (e.code === 'VALIDATION_ERROR')
    return onlyAboutEmail(e.message) ? { outcome: 'bad-email' } : { outcome: 'malformed-request' };
  switch (e.code) {
    case 'INVALID_EMAIL':
      return { outcome: 'bad-email' };
    // not status 401: sign-in also answers 401 for FAILED_TO_CREATE_SESSION, and
    // telling that person their password is wrong sends them to retype a correct one
    case 'INVALID_EMAIL_OR_PASSWORD':
      return { outcome: 'wrong-credentials' };
    case 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL':
      return { outcome: 'email-taken' };
    case 'PASSWORD_TOO_SHORT':
      return { outcome: 'password-too-short' };
    default:
      return { outcome: 'unexpected', detail: e.message };
  }
};

/** Bounded here rather than at each return, so a later outcome cannot skip the cut. */
const unreachable = (reason: string): SessionResult => ({
  state: 'unreachable',
  reason: bounded(reason, MAX_RAW_BODY_CHARS),
});

export const auth = {
  /**
   * Signed in, signed out, or "we could not ask" — never a bare null. Called at
   * startup to decide login vs app, and again by the Retry on the unreachable
   * screen. It does not go through refuse(): a 401 here would fire the
   * onUnauthorized listeners and mean "signed out" again, by a longer road.
   */
  session: async (): Promise<SessionResult> => {
    try {
      const res = await fetch(`${API_BASE}/api/auth/get-session`, { credentials: 'include' });
      if (!res.ok) return unreachable(`HTTP ${res.status}`);
      // inside the try on purpose: a captive portal answering HTML with a 200 is
      // not the server saying the visitor is signed out
      const text = await res.text();
      const data = text ? (JSON.parse(text) as { user?: SessionUser } | null) : null;
      return data?.user ? { state: 'signed-in', user: data.user } : { state: 'signed-out' };
    } catch (e) {
      // a rejection that is not an Error must not throw out of here: nothing calling
      // session() has a .catch, and the app would sit on the blank checking screen
      return unreachable(e instanceof Error ? e.message : String(e));
    }
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
  register: async (
    email: string,
    password: string,
    name: string,
    inviteCode?: string,
  ): Promise<AuthAttempt> => {
    try {
      await authRequest<{ user: SessionUser }>(
        '/sign-up/email',
        { email, password, name },
        inviteCode ? { 'x-invite-code': inviteCode } : undefined,
      );
      return { outcome: 'signed-in' };
    } catch (e) {
      return classify(e);
    }
  },

  login: async (email: string, password: string): Promise<AuthAttempt> => {
    try {
      await authRequest<{ user: SessionUser }>('/sign-in/email', { email, password });
      return { outcome: 'signed-in' };
    } catch (e) {
      return classify(e);
    }
  },

  logout: () => authRequest<unknown>('/sign-out'),

  /**
   * revokeOtherSessions is asked for deliberately and is what opens the window the
   * 'unknown' branch exists for: a person changes their password because they think
   * somebody else is signed in, and a change that leaves those sessions alive does
   * not serve that at all.
   *
   * It never rejects - every outcome is a member of PasswordChange, so no caller
   * can flatten the two failures onto one sentence with a catch.
   */
  changePassword: async (currentPassword: string, newPassword: string): Promise<PasswordChange> => {
    try {
      await authRequest<{ token: string | null; user: SessionUser }>('/change-password', {
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      });
      return { outcome: 'changed' };
    } catch (e) {
      if (e instanceof AuthError && e.status === 400) {
        return {
          outcome: 'refused',
          message: e.message,
          // "Invalid password" on a form with three password fields does not say which
          wrongCurrent: e.code === 'INVALID_PASSWORD',
        };
      }
      if (e instanceof AuthError && e.status === 401) return { outcome: 'signed-out' };
      // a 429 carries a message and no code, so anything keyed on the message would
      // render a rate limit as "your current password is wrong"
      return {
        outcome: 'unknown',
        detail: bounded(e instanceof Error ? e.message : String(e), MAX_RAW_BODY_CHARS),
      };
    }
  },
};

export const api = {
  /** includeHidden — include hidden accounts (Accounts screen, so they can be restored). */
  accounts: (includeHidden = false) =>
    request<Account[]>(`/api/accounts${includeHidden ? '?all=1' : ''}`),

  /**
   * An empty account, named. The currency is the server's: it defaults the account to
   * the workspace's base currency, and there is nowhere in this signature to put a
   * guess — which is the whole of how no client makes one.
   */
  createAccount: (name: string) => request<Account>('/api/accounts', json('POST', { name })),

  renameAccount: (id: string, name: string) =>
    request<Account>(`/api/accounts/${encodeURIComponent(id)}`, json('PATCH', { name })),

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

  /**
   * The import history. The backend caps the list and sends neither a total nor a
   * cursor, so this is the most recent imports and the client cannot know how many
   * are behind them.
   */
  imports: () => request<{ imports: ImportRecord[] }>('/api/imports'),

  /**
   * Removes the import and the transactions it FIRST wrote — a row an earlier
   * import already owned stays with that one, so the count in the answer is what
   * actually left.
   */
  deleteImport: (id: string) =>
    request<{ deleted: boolean; transactions: number }>(
      `/api/imports/${encodeURIComponent(id)}`,
      json('DELETE'),
    ),

  /** The stored statement itself. */
  importDocument: (id: string) => download(`/api/imports/${encodeURIComponent(id)}/document`),

  /** bytesRemoved false is not a failure: most rows never had a document (010 D5). */
  deleteImportDocument: (id: string) =>
    request<{ deleted: boolean; importId: string; bytesRemoved: boolean }>(
      `/api/imports/${encodeURIComponent(id)}/document`,
      json('DELETE'),
    ),

  /**
   * Every transaction, account and setting as readable JSON. Not a disaster-recovery
   * backup: it is unencrypted, and the uploaded statements are not in it — those are
   * downloaded one at a time from the import history.
   */
  backup: () => download('/api/backup'),
};
