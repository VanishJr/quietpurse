import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, onUnauthorized, UnauthorizedError } from './api';

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
