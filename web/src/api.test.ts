import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, auth, onUnauthorized, SessionResult, UnauthorizedError } from './api';
import { USER } from './test/fixtures';

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

/** A request that never lands: the server is down, DNS fails, CORS refuses. */
function rejectWith(message: string): void {
  globalThis.fetch = vi.fn(async () => {
    throw new TypeError(message);
  }) as typeof fetch;
}

/** The reason, or a failure of its own if the answer was not "unreachable". */
function unreachableReason(result: SessionResult): string {
  if (result.state !== 'unreachable') throw new Error(`expected unreachable, got ${result.state}`);
  return result.reason;
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

describe('401 handling', () => {
  it('throws UnauthorizedError and notifies listeners once', async () => {
    respondWith('', 401, false);
    const seen = vi.fn();
    const off = onUnauthorized(seen);
    await expect(api.settings()).rejects.toBeInstanceOf(UnauthorizedError);
    expect(seen).toHaveBeenCalledTimes(1);
    off();
  });

  it('stops notifying after unsubscribe', async () => {
    respondWith('', 401, false);
    const seen = vi.fn();
    onUnauthorized(seen)();
    await expect(api.settings()).rejects.toBeInstanceOf(UnauthorizedError);
    expect(seen).not.toHaveBeenCalled();
  });
});

/**
 * One case per outcome of the session check. "You are signed out" is a claim only
 * the server can make; everything else is "we could not ask", and this is where
 * that mapping is pinned - App.tsx only renders whichever member comes back.
 */
describe('auth.session()', () => {
  it('reads 200 with an empty body as signed out', async () => {
    respondWith('', 200, false);
    expect(await auth.session()).toEqual({ state: 'signed-out' });
  });

  it('reads 200 with a null body as signed out', async () => {
    respondWith('null', 200);
    expect(await auth.session()).toEqual({ state: 'signed-out' });
  });

  it('reads 200 with a user as signed in', async () => {
    respondWith(JSON.stringify({ user: USER }), 200);
    expect(await auth.session()).toEqual({ state: 'signed-in', user: USER });
  });

  it('reads a 200 that is not JSON as unreachable', async () => {
    // a proxy or captive portal answering HTML: the parse has to sit inside the
    // guarded region, or the user is signed out by a network appliance
    respondWith('<html>sign in to the wifi</html>', 200, false);
    expect((await auth.session()).state).toBe('unreachable');
  });

  it('reads 401 as unreachable, and does not notify the 401 listeners', async () => {
    // this route answers a signed-out visitor 200 with null, so a 401 from it is
    // something in front of the app refusing the question, not an answer
    respondWith('', 401, false);
    const seen = vi.fn();
    const off = onUnauthorized(seen);
    expect(await auth.session()).toEqual({ state: 'unreachable', reason: 'HTTP 401' });
    expect(seen).not.toHaveBeenCalled();
    off();
  });

  it('reads a 5xx as unreachable', async () => {
    for (const status of [500, 502]) {
      respondWith('', status, false);
      expect(await auth.session()).toEqual({ state: 'unreachable', reason: `HTTP ${status}` });
    }
  });

  it('reads a rejected fetch as unreachable, carrying the reason', async () => {
    rejectWith('Failed to fetch');
    expect(await auth.session()).toEqual({ state: 'unreachable', reason: 'Failed to fetch' });
  });

  it('reads a rejection that is not an Error as unreachable', async () => {
    // nothing in this stack throws one today - the guard is here because reading
    // .message off one would reject session(), and no caller has a .catch
    globalThis.fetch = vi.fn(async () => {
      throw 'gone';
    }) as unknown as typeof fetch;
    expect(await auth.session()).toEqual({ state: 'unreachable', reason: 'gone' });
  });

  it('cuts an unbounded reason at the raw-body budget', async () => {
    rejectWith('w'.repeat(5000));
    const reason = unreachableReason(await auth.session());
    expect(reason).toHaveLength(200);
    expect(reason.endsWith('…')).toBe(true);
  });

  it('sends the session cookie', async () => {
    // the only place this is visible: under the dev proxy every request is
    // same-origin and sends it anyway, and the dom project pins VITE_API_URL
    // empty. Dropped, a cross-origin build signs the user out on every reload.
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('null'),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await auth.session();

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/auth/get-session'),
      expect.objectContaining({ credentials: 'include' }),
    );
  });
});
