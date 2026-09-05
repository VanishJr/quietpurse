import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

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
    await expect(api.settings()).rejects.toThrow(detail);
  });

  it('marks the cut when there is more behind it', async () => {
    respondWith(JSON.stringify({ error: 'y'.repeat(501) }), 400);
    const err = await failureOf(api.settings());
    expect(err.message).toHaveLength(500);
    expect(err.message.endsWith('…')).toBe(true);
  });

  it('cuts an unbounded non-JSON body much shorter, with the status', async () => {
    // a proxy's error page is not written for a person and has no budget
    respondWith('<html>' + 'z'.repeat(5000) + '</html>', 502, false);
    const err = await failureOf(api.settings());
    expect(err.message).toHaveLength(200);
    expect(err.message.startsWith('502: ')).toBe(true);
    expect(err.message.endsWith('…')).toBe(true);
  });

  it('falls back to status and body when the JSON carries no error field', async () => {
    respondWith(JSON.stringify({ detail: 'wrong shape' }), 500);
    const err = await failureOf(api.settings());
    expect(err.message.startsWith('500: ')).toBe(true);
    expect(err.message).toContain('wrong shape');
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
