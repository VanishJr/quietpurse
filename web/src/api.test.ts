import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  auth,
  AuthAttempt,
  MAX_RAW_BODY_CHARS,
  onUnauthorized,
  SessionResult,
  UnauthorizedError,
} from './api';
import { AUTH_REFUSALS } from './test/auth-refusals';
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

  /*
   * putCharts is the one call that leaves request(), because a 409 on that route
   * carries the current list and refuse() would throw it away. Everything else about
   * it still has to go through refuse - a session that expires with Analytics open
   * would otherwise leave the reader on "Not saved: 401", with a Try again that can
   * only re-refuse, instead of on the sign-in screen.
   */
  it('reaches the sign-in screen from a chart save too, not only from request()', async () => {
    // the version is minted from a body the server sent, which is the only way to get
    // one - the brand is what stops a number reaching the PUT
    respondWith(JSON.stringify({ version: 4, charts: [] }), 200);
    const { version } = await api.charts();

    respondWith('', 401, false);
    const seen = vi.fn();
    const off = onUnauthorized(seen);
    await expect(api.putCharts(version, [])).rejects.toBeInstanceOf(UnauthorizedError);
    expect(seen).toHaveBeenCalledTimes(1);
    off();
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

/**
 * The one classification the row turns on. better-auth writes the new password and
 * only then replaces the sessions, outside a transaction, so "the request failed"
 * and "nothing changed" are two different claims and only one of them is ever safe
 * to make. Every BAD_REQUEST in the handler is thrown above the write - that is why
 * the branch is the status and not the message, which a 429 also carries.
 */
describe('auth.changePassword()', () => {
  const change = () => auth.changePassword('old-password', 'new-password');

  /** Not 'unknown', or every successful change reads as one. */
  it('reads a 200 as changed', async () => {
    respondWith(JSON.stringify({ token: 'session-token', user: USER }), 200);
    expect(await change()).toEqual({ outcome: 'changed' });
  });

  it("reads better-auth's invalid-password 400 as a refusal that changed nothing", async () => {
    respondWith(JSON.stringify({ message: 'Invalid password', code: 'INVALID_PASSWORD' }), 400);
    expect(await change()).toEqual({
      outcome: 'refused',
      message: 'Invalid password',
      wrongCurrent: true,
    });
  });

  it('keeps a 400 about the new password out of that wording', async () => {
    // "Invalid password" on a form with three password fields does not say which one,
    // so the copy for the current-password case is ours - and only for that code
    respondWith(JSON.stringify({ message: 'Password too long', code: 'PASSWORD_TOO_LONG' }), 400);
    expect(await change()).toEqual({
      outcome: 'refused',
      message: 'Password too long',
      wrongCurrent: false,
    });
  });

  it('reads a 429 as an unknown outcome, not as a refusal', async () => {
    // the rate limiter's body is a message and no code (rate-limiter/index.mjs:65).
    // /change-password is 3 per 10s by better-auth's default, which two mistyped
    // attempts and a retry reach, so this arrives in normal use - and anything keyed
    // on "is there a message" would print it as "your current password is wrong".
    respondWith(JSON.stringify({ message: 'Too many requests. Please try again later.' }), 429);
    expect(await change()).toEqual({
      outcome: 'unknown',
      detail: 'Too many requests. Please try again later.',
    });
  });

  it('reads a 500 as an unknown outcome', async () => {
    // the window this type exists for: the password is already written when the
    // session work below it fails, and this 500 is what the user is told about it
    respondWith(
      JSON.stringify({ message: 'Failed to get session', code: 'FAILED_TO_GET_SESSION' }),
      500,
    );
    expect(await change()).toEqual({ outcome: 'unknown', detail: 'Failed to get session' });
  });

  it('reads a fetch that never landed as an unknown outcome', async () => {
    // the connection dropping after the write looks exactly like this from here
    rejectWith('Failed to fetch');
    expect(await change()).toEqual({ outcome: 'unknown', detail: 'Failed to fetch' });
  });

  it('reads a 401 as signed out, and does not notify the 401 listeners', async () => {
    // the session middleware refuses above the handler, so nothing was written and
    // 'unknown' would manufacture doubt. Firing the listeners is request()'s job.
    respondWith(JSON.stringify({ message: 'Unauthorized', code: 'UNAUTHORIZED' }), 401);
    const seen = vi.fn();
    const off = onUnauthorized(seen);
    expect(await change()).toEqual({ outcome: 'signed-out' });
    expect(seen).not.toHaveBeenCalled();
    off();
  });

  it('cuts an unbounded failure at the raw-body budget', async () => {
    rejectWith('w'.repeat(5000));
    const result = await change();
    if (result.outcome !== 'unknown') throw new Error(`expected unknown, got ${result.outcome}`);
    expect(result.detail).toHaveLength(200);
    expect(result.detail.endsWith('…')).toBe(true);
  });

  it('asks for the other sessions to be revoked, and sends the session cookie', async () => {
    // without the flag a password changed because somebody else is signed in leaves
    // them signed in, and the screen said it worked
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ token: 'session-token', user: USER })),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await change();

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/auth/change-password');
    expect(init).toMatchObject({ method: 'POST', credentials: 'include' });
    expect(JSON.parse(String(init?.body))).toEqual({
      currentPassword: 'old-password',
      newPassword: 'new-password',
      revokeOtherSessions: true,
    });
  });
});

/**
 * The classification behind the only screen a person meets before they have an
 * account. Neither call rejects any more, so a failure cannot reach a catch block
 * and be printed as whatever the server composed; what is pinned here is which
 * member each measured refusal becomes, and AuthScreen.test.tsx pins the sentence.
 */
describe('auth.login() / auth.register()', () => {
  const login = () => auth.login('ivan@example.com', 'a-password');
  const register = () => auth.register('ivan@example.com', 'a-password', 'ivan');

  /** The detail, or a failure of its own if the answer was not 'unexpected'. */
  function unexpectedDetail(result: AuthAttempt): string {
    if (result.outcome !== 'unexpected')
      throw new Error(`expected unexpected, got ${result.outcome}`);
    return result.detail;
  }

  it('reads a 200 as signed in, on both calls', async () => {
    respondWith(JSON.stringify({ user: USER }), 200);
    expect(await login()).toEqual({ outcome: 'signed-in' });
    respondWith(JSON.stringify({ user: USER }), 200);
    expect(await register()).toEqual({ outcome: 'signed-in' });
  });

  // one case per row of the mirror in api.ts, driven by the table the dom sweep
  // also reads, so the two cannot disagree about what the server sends
  it.each(AUTH_REFUSALS)('classifies $status $what as $outcome', async (refusal) => {
    respondWith(JSON.stringify(refusal.body), refusal.status);
    expect((await login()).outcome).toBe(refusal.outcome);
  });

  // the classifier reads the message authRequest has already bounded, so
  // onlyAboutEmail splits a cut string: a validation failure longer than the budget
  // loses its later clauses and passes as an email one. Nothing better-auth composes
  // is that long - both sides are read live here, so the day either moves is the day
  // this goes red rather than the day somebody reads the arithmetic wrong
  it.each(AUTH_REFUSALS)('says all of $what inside the raw-body budget', (refusal) => {
    const body = refusal.body as { message?: string; error?: string };
    expect((body.message ?? body.error ?? '').length).toBeLessThanOrEqual(MAX_RAW_BODY_CHARS);
  });

  it('names the address for the code the sign-up schema answers, and carries no text', async () => {
    // the measured literal, copied off the wire rather than composed from what
    // onlyAboutEmail matches: a fixture built from the pattern cannot notice the
    // pattern narrowing
    respondWith(
      JSON.stringify({ message: '[body.email] Invalid email address', code: 'VALIDATION_ERROR' }),
      400,
    );
    expect(await register()).toEqual({ outcome: 'bad-email' });
  });

  it('keeps a validation failure that is not only about the address off that sentence', async () => {
    // telling someone to fix their address when the failing field was another one
    // is the defect this degrades away from
    respondWith(
      JSON.stringify({
        message: '[body.email] Invalid email address; [body.password] Too small',
        code: 'VALIDATION_ERROR',
      }),
      400,
    );
    expect(await register()).toEqual({ outcome: 'malformed-request' });
  });

  it('reads a 429 by its status, since it carries no code', async () => {
    respondWith(JSON.stringify({ message: 'Too many requests. Please try again later.' }), 429);
    expect(await login()).toEqual({ outcome: 'rate-limited' });
  });

  it('does not read a 401 that is not about credentials as a wrong password', async () => {
    // sign-in answers 401 for FAILED_TO_CREATE_SESSION too: the password was right,
    // and "email and password do not match" sends that person to retype it forever
    respondWith(
      JSON.stringify({ message: 'Failed to create session', code: 'FAILED_TO_CREATE_SESSION' }),
      401,
    );
    expect(await login()).toEqual({ outcome: 'unexpected', detail: 'Failed to create session' });
  });

  it("carries the invite gate's sentence, which is not better-auth's body shape", async () => {
    // { error } is refuse()'s contract; reading only { message } left the raw JSON
    // on screen on the one path every invite-only deployment has switched on
    respondWith(JSON.stringify({ error: 'registration on this server is invite-only' }), 403);
    expect(await register()).toEqual({
      outcome: 'unexpected',
      detail: 'registration on this server is invite-only',
    });
  });

  it('reads a fetch that never landed as unreachable, carrying the reason', async () => {
    rejectWith('Failed to fetch');
    expect(await login()).toEqual({ outcome: 'unreachable', reason: 'Failed to fetch' });
  });

  it('cuts an unbounded reason at the raw-body budget', async () => {
    rejectWith('w'.repeat(5000));
    const result = await login();
    if (result.outcome !== 'unreachable')
      throw new Error(`expected unreachable, got ${result.outcome}`);
    expect(result.reason).toHaveLength(200);
    expect(result.reason.endsWith('…')).toBe(true);
  });

  it('marks the cut when the server said more than the budget', async () => {
    // the unmarked slice(0, 200) this replaced ended mid-token, so a message with
    // more behind it read as a finished sentence
    respondWith(JSON.stringify({ message: 'y'.repeat(500), code: 'SOMETHING_NEW' }), 400);
    const detail = unexpectedDetail(await login());
    expect(detail).toHaveLength(200);
    expect(detail.endsWith('…')).toBe(true);
  });

  it('keeps the status when the server sends an empty message', async () => {
    // '' is the server saying nothing, and quoting it renders "It said:" and then
    // the end of the sentence - with the status gone too, so nothing on screen
    // tells this refusal from any other
    respondWith(JSON.stringify({ message: '', code: 'SOMETHING_NEW' }), 400);
    expect(unexpectedDetail(await login()).startsWith('400: ')).toBe(true);
  });

  it('keeps the status when the body is not JSON at all', async () => {
    // a proxy's error page carries no message and no code; dropping the status left
    // nothing at all to tell one failure from another
    respondWith('<html>' + 'z'.repeat(5000) + '</html>', 502, false);
    const detail = unexpectedDetail(await login());
    expect(detail.startsWith('502: ')).toBe(true);
    expect(detail).toHaveLength(200);
    expect(detail.endsWith('…')).toBe(true);
  });

  it('sends the invite code as a header, and the session cookie', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ user: USER })),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await auth.register('ivan@example.com', 'a-password', 'ivan', 'the-code');

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/auth/sign-up/email');
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'include',
      headers: { 'x-invite-code': 'the-code' },
    });
  });
});
