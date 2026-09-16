import {
  Account,
  AccountDeleted,
  AccountMonthlySummary,
  AccountSummary,
  AppSettings,
  BaselineResponse,
  BudgetsResponse,
  BudgetsWritten,
  CategoryRuleCreated,
  CategoryRuleWithCounts,
  Deleted,
  DocumentDeleted,
  ImportConfirmed,
  ImportDeleted,
  ImportDiscarded,
  ImportList,
  ImportPresets,
  Independence,
  IncomeSource,
  IncomeSourceDef,
  IncomeSourceKind,
  MonthlySummary,
  RecurringSummary,
  Settings,
  StatementImportResult,
  Summary,
  Transaction,
  TransferRuleCreated,
  TransferRuleWithMatches,
} from './types';
import type { ERROR_DETAIL_MAX } from './types';
import { Category } from './categories';
import { ChartEntry, chartEntry, entryWire } from './analytics';

/**
 * The API is always this page's own origin: the Vite dev server proxies /api to the
 * backend (see vite.config.ts), and `npm start` serves this bundle from the backend
 * itself. So there is no address to configure and no cross-origin request anywhere.
 */
export const API_BASE = '';

export const apiLabel = (): string => window.location.origin;

/**
 * The backend composes a refusal to exactly this budget (`ERROR_DETAIL_MAX`, on the
 * wire) and orders the clauses of the long ones on the premise that all of it is read.
 * Cutting it shorter here drops the clause it put last and ends the sentence
 * mid-token.
 */
export const MAX_ERROR_CHARS = 500 satisfies typeof ERROR_DETAIL_MAX;

/** A proxy's error page is unbounded and is not written for a person to read. */
export const MAX_RAW_BODY_CHARS = 200;

/** Cut with a mark, so a message with more behind it does not read as a broken one. */
const bounded = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/**
 * What a non-2xx becomes. Shared by both callers below rather than written twice:
 * a download that skipped it would build an object URL from a body nobody read and
 * write the refusal to disk under the name of a statement.
 */
async function refuse(res: Response): Promise<never> {
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
    headers: { ...(init?.headers || {}) },
  });
  if (!res.ok) await refuse(res);
  return (await res.json()) as T;
}

/**
 * A summary body, checked against the unit it was asked for.
 *
 * Both summary endpoints answer a discriminated union: every account together in the
 * base currency, or one account in its own. `scope` is the only thing that says which
 * - `all` for the first, `account` for the second - and an account request answered
 * with the other body would put all the money on screen under one account's name and
 * currency code: right-looking, wrong, and permanent.
 *
 * So this throws where a client fallback is normally a sentence. The difference is what
 * the bad shape means: not a skew between a new client and an old server, but what this
 * repository produces the day a query-builder edit drops the `accountId`. Both arms are
 * called inside a `try` that renders the screen's own refusal, so the throw is a refusal
 * and never a blank.
 */
async function scoped<T extends { scope: 'all' | 'account' }>(
  path: string,
  want: T['scope'],
  accountId: string | null,
  what: string,
): Promise<T> {
  const body = await request<T>(path);
  if (body.scope !== want) {
    throw new Error(
      want === 'account'
        ? `the API answered the ${what} over every account where account ${accountId} was asked for`
        : `the API answered a ${what} for one account where every account was asked for (${path})`,
    );
  }
  if (accountId !== null) {
    const answered = (body as { accountId?: string }).accountId;
    if (answered !== accountId) {
      throw new Error(
        `the API answered a ${what} for account ${answered} where ${accountId} was asked for`,
      );
    }
  }
  return body;
}

const allAccountsBody = <T extends { scope: 'all' }>(path: string, what: string): Promise<T> =>
  scoped<T>(path, 'all', null, what);

const accountBody = <T extends { scope: 'account'; accountId: string }>(
  path: string,
  accountId: string,
  what: string,
): Promise<T> => scoped<T>(path, 'account', accountId, what);

/**
 * The id is written in unconditionally, against the URLSearchParams idiom
 * `transactions` uses below: an id of '' is SENT rather than dropped, because the
 * server refuses it and dropping it would answer with every account under one
 * account's name. Same reasoning as `imports`. `from` and `to` are YYYY-MM-DD built
 * by the caller; only the id is user-shaped.
 */
const accountSummaryPath = (base: string, accountId: string, from: string, to: string): string =>
  `${base}?accountId=${encodeURIComponent(accountId)}&from=${from}&to=${to}`;

/**
 * Bytes or a throw — never a Response and never a URL. A route answering a file is
 * a route that can answer 500, and `<a href download>` saves that too.
 */
async function download(path: string): Promise<Blob> {
  const res = await fetch(`${API_BASE}${path}`);
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

/**
 * The version the chart list was read at, and the only thing a PUT may send as its
 * expected value.
 *
 * Branded, and minted in one place: `parseChartList`, over a body the server sent.
 * The route's compare-and-swap is the whole of what keeps two devices from silently
 * overwriting each other, and it is defeated by arithmetic — `version + 1` after an
 * optimistic save is right until one PUT is refused, and from then on every save
 * lands on somebody else's list and is answered 200. `putCharts(3, …)` does not
 * compile, so there is no arithmetic here because there is no number here.
 */
declare const chartsVersion: unique symbol;
export type ChartsVersion = number & { readonly [chartsVersion]: true };

export interface ChartList {
  version: ChartsVersion;
  /** Array position is the dock's order, kept for rows this client cannot read. */
  entries: ChartEntry[];
}

/**
 * A PUT refused because the list moved on. It carries the current list because
 * the route puts it in the refusal body — a client refused for staleness re-syncs
 * from the refusal and never asks a second time to find out what happened.
 *
 * The server's own sentence is not carried: it ends "save again and it will go
 * through", which is true of a client that re-applies and false of this one. The
 * screen says what happened on this surface.
 */
export class ChartsStaleError extends Error {
  constructor(readonly current: ChartList) {
    super('the chart list changed elsewhere');
    this.name = 'ChartsStaleError';
  }
}

/**
 * `{ version, charts }`, or a throw. One parser for both bodies the route answers
 * with: the 200 and the 409 carry the same pair, which is what makes re-syncing from
 * a refusal the same code as reading.
 *
 * It throws where a client fallback is normally a sentence, for `scoped()`'s reason:
 * a body that is not this shape is not a new client against an old server, it is what
 * this repository produces the day the route changes shape — and a fallback here
 * composes the next PUT at a version nobody answered.
 */
function parseChartList(body: unknown): ChartList {
  const o = body as { version?: unknown; charts?: unknown } | null;
  if (
    typeof o !== 'object' ||
    o === null ||
    !Number.isSafeInteger(o.version) ||
    (o.version as number) < 0 ||
    !Array.isArray(o.charts)
  ) {
    throw new Error('the API answered something other than a chart list for the saved charts');
  }
  return {
    version: o.version as ChartsVersion,
    entries: (o.charts as unknown[]).map(chartEntry),
  };
}

export const api = {
  /** includeHidden — include hidden accounts (Accounts screen, so they can be restored). */
  accounts: (includeHidden = false) =>
    request<Account[]>(`/api/accounts${includeHidden ? '?all=1' : ''}`),

  /**
   * An empty account, named. The currency is the server's: it defaults the account to
   * the base currency, and there is nowhere in this signature to put a guess — which
   * is the whole of how no client makes one.
   */
  createAccount: (name: string) => request<Account>('/api/accounts', json('POST', { name })),

  renameAccount: (id: string, name: string) =>
    request<Account>(`/api/accounts/${encodeURIComponent(id)}`, json('PATCH', { name })),

  setAccountHidden: (id: string, hidden: boolean) =>
    request<Account>(`/api/accounts/${encodeURIComponent(id)}`, json('PATCH', { hidden })),

  /**
   * Destroys the account, its transactions, its imports and their stored statements.
   * The counts are the delete's own and not the preview's; transfer rules go too and
   * are not in the answer (app.ts).
   */
  deleteAccount: (id: string) =>
    request<AccountDeleted>(`/api/accounts/${encodeURIComponent(id)}`, json('DELETE')),

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

  transferRules: () => request<TransferRuleWithMatches[]>('/api/transfer-rules'),

  /**
   * "Mark every transaction like this as a transfer" — a rule by the transaction's
   * description and account. Applied to the whole history at once and to every new
   * transaction from then on.
   */
  addTransferRule: (txId: string) =>
    request<TransferRuleCreated>('/api/transfer-rules', json('POST', { txId })),

  deleteTransferRule: (id: number) =>
    request<Deleted>(`/api/transfer-rules/${id}`, json('DELETE')),

  summary: (from: string, to: string) =>
    allAccountsBody<Summary>(`/api/summary?from=${from}&to=${to}`, 'summary'),

  months: (from: string, to: string) =>
    allAccountsBody<MonthlySummary>(`/api/summary/months?from=${from}&to=${to}`, 'monthly summary'),

  /**
   * The same two questions about ONE account, in that account's own currency — a
   * separate function and not an overload of the two above: the point of the union
   * the backend answers is that the unit is named by the type, so a caller who asks
   * for one account gets the account shape or an error, never a body to narrow.
   *
   * `to` is inclusive of that whole day server-side, so a `to` short by one day drops
   * the last day of the range from every figure it feeds.
   */
  accountSummary: (accountId: string, from: string, to: string) =>
    accountBody<AccountSummary>(
      accountSummaryPath('/api/summary', accountId, from, to),
      accountId,
      'summary',
    ),

  /** That account's months — only the ones with rows; the gaps are the caller's. */
  accountMonths: (accountId: string, from: string, to: string) =>
    accountBody<AccountMonthlySummary>(
      accountSummaryPath('/api/summary/months', accountId, from, to),
      accountId,
      'monthly summary',
    ),

  /** Manually set the income source. null — hand the decision back to auto-detection. */
  setIncomeSource: (id: string, source: IncomeSource | null) =>
    request<Transaction>(
      `/api/transactions/${encodeURIComponent(id)}/source`,
      json('PATCH', { source }),
    ),

  /**
   * This one transaction's category and no other's; null hands the row back to
   * auto-detection. A manual category outranks every rule, so this is also how a row
   * is pinned against one.
   */
  setCategory: (id: string, category: Category | null) =>
    request<Transaction>(
      `/api/transactions/${encodeURIComponent(id)}/category`,
      json('PATCH', { category }),
    ),

  /** Set/clear "one-off large purchase" (amortized into average spending). */
  setOneOff: (id: string, oneOff: boolean) =>
    request<Transaction>(
      `/api/transactions/${encodeURIComponent(id)}/one-off`,
      json('PATCH', { oneOff }),
    ),

  recurring: () => request<RecurringSummary>('/api/recurring'),

  setRecurringIgnored: (description: string, ignored: boolean) =>
    request<RecurringSummary>('/api/recurring/ignore', json('POST', { description, ignored })),

  independence: () => request<Independence>('/api/independence'),

  settings: () => request<Settings>('/api/settings'),
  updateSettings: (patch: Partial<Settings>) =>
    request<Settings>('/api/settings', json('PATCH', patch)),

  baseline: () => request<BaselineResponse>('/api/baseline'),

  /** monthly = null deletes the line item. */
  setBaselineItem: (label: string, monthly: number | null) =>
    request<BaselineResponse>('/api/baseline', json('PUT', { label, monthly })),

  categoryRules: () => request<CategoryRuleWithCounts[]>('/api/category-rules'),

  /**
   * A "description contains … -> category" rule (+ a full recompute on the backend).
   *
   * Take `pattern` where the bank appends something changing to every line — a month
   * in a rent reference, a contract number: a rule built from one full description
   * would then match that single transaction and nothing else. `txId` is the shorthand
   * for "the whole description as it is".
   *
   * The counts are beside `rule` on the wire and not inside it — `rule` is the stored
   * row and carries neither.
   */
  addCategoryRule: (target: { txId: string } | { pattern: string }, category: Category) =>
    request<CategoryRuleCreated>('/api/category-rules', json('POST', { ...target, category })),

  deleteCategoryRule: (id: number) =>
    request<Deleted>(`/api/category-rules/${id}`, json('DELETE')),

  budgets: () => request<BudgetsResponse>('/api/budgets'),

  /** monthly = null removes the budget from the category. */
  setBudget: (category: string, monthly: number | null) =>
    request<BudgetsWritten>('/api/budgets', json('PUT', { category, monthly })),

  incomeSources: () => request<IncomeSourceDef[]>('/api/income-sources'),

  addIncomeSource: (label: string, kind: IncomeSourceKind, patterns: string[] = []) =>
    request<IncomeSourceDef>('/api/income-sources', json('POST', { label, kind, patterns })),

  updateIncomeSource: (
    id: string,
    patch: Partial<Pick<IncomeSourceDef, 'label' | 'kind' | 'patterns'>>,
  ) =>
    request<IncomeSourceDef>(`/api/income-sources/${encodeURIComponent(id)}`, json('PUT', patch)),

  deleteIncomeSource: (id: string) =>
    request<Deleted>(`/api/income-sources/${encodeURIComponent(id)}`, json('DELETE')),

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
    request<StatementImportResult>('/api/imports', { method: 'POST', body: form }),

  /** Accepts a summary: the rows land and the backend answers with what actually did. */
  confirmImport: (importId: string) =>
    request<ImportConfirmed>(`/api/imports/${encodeURIComponent(importId)}/confirm`, {
      method: 'POST',
    }),

  /** Rejects it: the staged rows go, and the same file can be uploaded again. */
  discardImport: (importId: string) =>
    request<ImportDiscarded>(`/api/imports/${encodeURIComponent(importId)}/discard`, {
      method: 'POST',
    }),

  importPresets: () => request<ImportPresets>('/api/imports/presets'),

  /**
   * The import history: one account's when an id is given, every account's otherwise.
   * The page is capped, and `totals` counts the whole filtered set - so how many are not
   * listed is something the caller reads rather than guesses.
   *
   * An id of '' is SENT rather than dropped, against the URLSearchParams idiom
   * `transactions` uses above: the server refuses it, and a caller writing
   * `?accountId=${account?.id ?? ''}` has to meet that refusal. Dropping it here would
   * answer with every import there is and let a panel print them as one account's.
   */
  imports: (accountId?: string) =>
    request<ImportList>(
      accountId === undefined
        ? '/api/imports'
        : `/api/imports?accountId=${encodeURIComponent(accountId)}`,
    ),

  /**
   * Removes the import and the transactions it FIRST wrote — a row an earlier
   * import already owned stays with that one, so the count in the answer is what
   * actually left.
   */
  deleteImport: (id: string) =>
    request<ImportDeleted>(`/api/imports/${encodeURIComponent(id)}`, json('DELETE')),

  importDocument: (id: string) => download(`/api/imports/${encodeURIComponent(id)}/document`),

  /** bytesRemoved false is not a failure: most rows never had a document. */
  deleteImportDocument: (id: string) =>
    request<DocumentDeleted>(`/api/imports/${encodeURIComponent(id)}/document`, json('DELETE')),

  /** The saved charts, and the version they were read at. */
  charts: async (): Promise<ChartList> =>
    parseChartList(await request<unknown>('/api/analytics/charts')),

  /**
   * The whole list at the version it was read at, or a refusal.
   *
   * Not through `request<T>`, which is the one call here that could not be: `refuse`
   * reads `{ error }` and throws the rest of the body away, and the rest of a 409 on
   * this route is the current version and the current list — put there by the route
   * so that a stale client does not have to ask again. Everything else still goes
   * through `refuse`, so any other refusal reads as every other call's does.
   */
  putCharts: async (version: ChartsVersion, entries: ChartEntry[]): Promise<ChartList> => {
    const res = await fetch(
      `${API_BASE}/api/analytics/charts`,
      json('PUT', { version, charts: entries.map(entryWire) }),
    );
    if (res.status === 409) throw new ChartsStaleError(parseChartList(await res.json()));
    if (!res.ok) await refuse(res);
    return parseChartList(await res.json());
  },

  /**
   * Every transaction, account and setting as readable JSON. Not a disaster-recovery
   * backup: it is unencrypted, and the uploaded statements are not in it — those are
   * downloaded one at a time from the import history.
   */
  backup: () => download('/api/backup'),
};
