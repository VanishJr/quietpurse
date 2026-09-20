import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from './api';

/**
 * These cover the one thing between a refusal the backend composed and the
 * sentence a person reads: how request() cuts it. The backend writes to a budget
 * (ERROR_DETAIL_MAX) on the premise that all of it arrives, so a client cut below
 * that budget silently deletes the clause it put last.
 */

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

/** The rejection, or a failure of its own if the call unexpectedly succeeded. */
async function failureOf(call: Promise<unknown>): Promise<Error> {
  try {
    await call;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected the request to reject, it resolved');
}

function respondWith(body: string, status: number, json = true): void {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(body, {
        status,
        headers: json ? { 'Content-Type': 'application/json' } : {},
      }),
  ) as typeof fetch;
}

describe('request() error messages', () => {
  it('passes a refusal through whole at the backend budget', async () => {
    const detail = 'x'.repeat(500);
    respondWith(JSON.stringify({ error: detail }), 400);
    await expect(api.goals()).rejects.toThrow(detail);
  });

  it('marks the cut when there is more behind it', async () => {
    respondWith(JSON.stringify({ error: 'y'.repeat(501) }), 400);
    const err = await failureOf(api.goals());
    expect(err.message).toHaveLength(500);
    expect(err.message.endsWith('…')).toBe(true);
  });

  it('cuts an unbounded non-JSON body much shorter, with the status', async () => {
    // a proxy's error page is not written for a person and has no budget
    respondWith('<html>' + 'z'.repeat(5000) + '</html>', 502, false);
    const err = await failureOf(api.goals());
    expect(err.message).toHaveLength(200);
    expect(err.message.startsWith('502: ')).toBe(true);
    expect(err.message.endsWith('…')).toBe(true);
  });

  it('falls back to status and body when the JSON carries no error field', async () => {
    respondWith(JSON.stringify({ detail: 'wrong shape' }), 500);
    const err = await failureOf(api.goals());
    expect(err.message.startsWith('500: ')).toBe(true);
    expect(err.message).toContain('wrong shape');
  });

  it('keeps the HTTP status available to callers that own status-specific recovery', async () => {
    respondWith(JSON.stringify({ error: 'goal not found' }), 404);
    const err = await failureOf(api.goal('missing'));
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 404, message: 'goal not found' });
  });
});

/**
 * The URL, and it is observable nowhere else: harness.tsx's keyOf discards the query
 * string, so `GET /api/accounts?all=1` and `GET /api/accounts` are one route key and
 * no dom test can tell a component asking for hidden accounts from one that is not.
 */
describe('api.accounts()', () => {
  /** The URL the call requested. Params declared, so mock.calls is typed. */
  async function urlOf(call: () => Promise<unknown>): Promise<string> {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('[]'),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await call();
    return String(fetchMock.mock.calls[0][0]);
  }

  /**
   * The import picker calls this one, and it must never offer an account the server
   * would refuse an upload into. Filtering hidden accounts in the component instead
   * would render the same list and move the decision to the layer that does not hold
   * the contract.
   */
  it('asks for visible accounts only by default', async () => {
    const url = await urlOf(() => api.accounts());
    expect(url).toContain('/api/accounts');
    expect(url).not.toContain('all=1');
  });

  /** And the accounts screen's own call, which is what restoring one goes through. */
  it('asks for hidden ones too when it is told to', async () => {
    expect(await urlOf(() => api.accounts(true))).toContain('/api/accounts?all=1');
  });
});

describe('api.deleteAccount()', () => {
  /**
   * The id is a path segment, and an account id is not guaranteed to be url-safe —
   * an unencoded one would address a route that does not exist, or a different one.
   */
  it('sends DELETE to the account, with the id encoded', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('{"deleted":true,"transactions":0,"imports":0,"documents":0}'),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await api.deleteAccount('acc 1');

    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/accounts/acc%201');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('DELETE');
  });
});

/**
 * The calls no screen pins by URL. harness.tsx keys its route table on the pathname
 * alone, so the method, the body and the encoding of an id are observable only here.
 */
describe('the calls the offline product depends on', () => {
  interface Sent {
    url: string;
    method: string | undefined;
    body: unknown;
    contentType: string | undefined;
  }

  /** What one call handed fetch: the URL, the method, the parsed JSON body, the type. */
  async function sent(call: () => Promise<unknown>, answer = '{}'): Promise<Sent> {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(answer, { headers: { 'Content-Type': 'application/json' } }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await call();
    const [input, init] = fetchMock.mock.calls[0];
    const headers = (init?.headers ?? {}) as Record<string, string>;
    return {
      url: String(input),
      method: init?.method,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
      contentType: headers['Content-Type'],
    };
  }

  it('api.backup() GETs /api/backup and hands back the bytes as a Blob', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('{"format":"finto-backup"}'),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const blob = await api.backup();

    expect(blob).toBeInstanceOf(Blob);
    expect(await blob.text()).toBe('{"format":"finto-backup"}');
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/backup');
    // The effective method, not the absence of an init: passing no init IS a GET, and
    // a header added later must not read as this assertion breaking.
    expect(fetchMock.mock.calls[0][1]?.method ?? 'GET').toBe('GET');
  });

  it('api.backup() rejects with the server sentence instead of handing back the refusal as bytes', async () => {
    respondWith(JSON.stringify({ error: 'the database is busy' }), 500);
    await expect(api.backup()).rejects.toThrow('the database is busy');
  });

  it('sends the complete Goals CRUD contract with encoded ids', async () => {
    const goal = {
      type: 'monthly-income' as const,
      name: 'Income',
      target: 3000,
      incomeScope: 'own' as const,
      windowMonths: 6,
    };
    expect(await sent(() => api.goals())).toMatchObject({ url: '/api/goals', method: undefined });
    expect(await sent(() => api.goal('goal/1'))).toMatchObject({
      url: '/api/goals/goal%2F1',
      method: undefined,
    });
    expect(await sent(() => api.createGoal(goal))).toEqual({
      url: '/api/goals',
      method: 'POST',
      body: goal,
      contentType: 'application/json',
    });
    expect(await sent(() => api.updateGoal('goal 1', { ...goal, target: 3500 }))).toEqual({
      url: '/api/goals/goal%201',
      method: 'PUT',
      body: { ...goal, target: 3500 },
      contentType: 'application/json',
    });
    expect(await sent(() => api.deleteGoal('goal/1'))).toMatchObject({
      url: '/api/goals/goal%2F1',
      method: 'DELETE',
      body: undefined,
    });
  });

  it('sends the category preview pattern and binds application to its token', async () => {
    expect(await sent(() => api.categoryRulePreview('REWE'))).toMatchObject({
      url: '/api/category-rules/preview', method: 'POST', body: { pattern: 'REWE' },
    });
    expect(await sent(() => api.addCategoryRule({ pattern: 'REWE' }, 'food', 'token'))).toMatchObject({
      url: '/api/category-rules', method: 'POST', body: { pattern: 'REWE', category: 'food', previewToken: 'token' },
    });
  });

  it('the transfer-rule calls: GET the list, POST the txId, DELETE the rule by id in the path', async () => {
    expect(await sent(() => api.transferRules(), '[]')).toMatchObject({
      url: '/api/transfer-rules',
      method: undefined,
    });
    expect(await sent(() => api.addTransferRule('tx-1'))).toEqual({
      url: '/api/transfer-rules',
      method: 'POST',
      body: { txId: 'tx-1' },
      contentType: 'application/json',
    });
    expect(await sent(() => api.deleteTransferRule(7))).toMatchObject({
      url: '/api/transfer-rules/7',
      method: 'DELETE',
      body: undefined,
    });
    expect(await sent(() => api.transferRulePreview('tx/a'))).toMatchObject({
      url: '/api/transactions/tx%2Fa/transfer-rule-preview', method: undefined,
    });
    expect(await sent(() => api.transaction('tx/a'))).toMatchObject({
      url: '/api/transactions/tx%2Fa', method: undefined,
    });
    expect(await sent(() => api.addTransferRule('tx-1', 'preview-token'))).toMatchObject({
      body: { txId: 'tx-1', matchMode: 'similar-v1', previewToken: 'preview-token' },
    });
  });

  it('api.setTransfer() PATCHes the transaction with the id encoded and the flag in the body, null included', async () => {
    expect(await sent(() => api.setTransfer('tx 1', null))).toEqual({
      url: '/api/transactions/tx%201/transfer',
      method: 'PATCH',
      body: { transfer: null },
      contentType: 'application/json',
    });
    expect((await sent(() => api.setTransfer('tx-2', true))).body).toEqual({ transfer: true });
  });
});
