import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AUTH_REFUSALS } from '../test/auth-refusals';
import { fail, mockFetch, ok, renderThemed, requests } from '../test/harness';
import { AuthScreen } from './AuthScreen';

/**
 * The only screen reachable without an account, and the first assertion about it in
 * this repository - it has been mounted by the App test and asserted about by
 * nothing. What is pinned here is the sentence a person reads, one per refusal the
 * server really composes, because the classification alone cannot show that a Zod
 * field path written for a developer never reaches the screen.
 *
 * jsdom answers none of the six manual checks: whether the browser still refuses a
 * missing @ before any request goes out is the browser's own validation, and a real
 * 429 cannot be produced at all - backend/src/auth.ts:91 disables the limiter under
 * NODE_ENV=test, so the response here is fabricated.
 */

const HEALTH = 'GET /api/health';
const SIGN_IN = 'POST /api/auth/sign-in/email';
const SIGN_UP = 'POST /api/auth/sign-up/email';

const health = (signup: 'open' | 'invite' = 'open') => ({ [HEALTH]: () => ok({ signup }) });

const mount = (onSignedIn: () => void = vi.fn()) => {
  renderThemed(<AuthScreen onSignedIn={onSignedIn} />);
  return onSignedIn;
};

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

const fillIn = (email: string, password = 'a-password') => {
  fireEvent.change(field('Email'), { target: { value: email } });
  fireEvent.change(field('Password'), { target: { value: password } });
};

const submit = (name: 'Sign in' | 'Create account') =>
  fireEvent.click(screen.getByRole('button', { name }));

/** The register tab is behind the switch; login is the mode the screen opens in. */
const toRegister = () => fireEvent.click(screen.getByRole('button', { name: 'Register' }));

/** What the .error paragraph says, whitespace as the browser would collapse it. */
const errorText = () => document.querySelector('.error')?.textContent?.replace(/\s+/g, ' ').trim();

/**
 * One 429 sentence, asserted by equality from both tabs. classify() keys the status
 * alone - it is all a 429 carries - so a single member answers both endpoints, whose
 * windows are 60s and an hour (auth.ts:95-96). A sentence written for one tab is
 * false on the other, and equality against this constant is what fails when one is.
 */
const RATE_LIMITED = 'Too many attempts on this server just now — wait and try again.';

const TOO_MANY_REQUESTS = { message: 'Too many requests. Please try again later.' };

/**
 * The interval is the property no equality can express: equality passes just as
 * happily on a sentence that names one, and any interval named is wrong on one of
 * the two tabs. No countdown either - x-retry-after is not exposed cross-origin, so
 * one would render under the dev proxy and vanish from the deployed build.
 */
const expectRateLimitSentence = async () => {
  await waitFor(() => expect(errorText()).toBe(RATE_LIMITED));
  expect(errorText()).not.toMatch(/minute|hour|second/i);
};

describe('an address the server will not accept', () => {
  it('names the typo on the register tab, and prints no field path', async () => {
    // the measured literal off the wire, not a string composed from what the
    // classifier matches on: a fixture built from the pattern cannot notice the
    // pattern narrowing
    mockFetch({
      ...health(),
      [SIGN_UP]: () =>
        fail(400, { message: '[body.email] Invalid email address', code: 'VALIDATION_ERROR' }),
    });
    mount();

    toRegister();
    fillIn('ivan@gmail');
    submit('Create account');

    expect(await screen.findByText(/not a complete email address/)).toBeInTheDocument();
    expect(screen.queryByText(/body\.email/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Invalid email address/)).not.toBeInTheDocument();
  });

  it('names the same typo the same way on the login tab, which answers a different code', async () => {
    // the tab almost every visit uses, and the one a fix keyed on VALIDATION_ERROR
    // alone leaves untouched: /sign-in/email declares email: z.string(), so the
    // schema passes it and the handler refuses it under INVALID_EMAIL
    mockFetch({
      ...health(),
      [SIGN_IN]: () => fail(400, { message: 'Invalid email', code: 'INVALID_EMAIL' }),
    });
    mount();

    fillIn('ivan@gmail');
    submit('Sign in');

    expect(await screen.findByText(/not a complete email address/)).toBeInTheDocument();
  });
});

describe('a refusal about the account itself', () => {
  it('stays non-enumerating for a wrong password', async () => {
    mockFetch({
      ...health(),
      [SIGN_IN]: () =>
        fail(401, { message: 'Invalid email or password', code: 'INVALID_EMAIL_OR_PASSWORD' }),
    });
    mount();

    fillIn('ivan@example.com');
    submit('Sign in');

    expect(await screen.findByText(/do not match an account here/)).toBeInTheDocument();
    // it must not read as a typo in the address, which is a different repair
    expect(screen.queryByText(/not a complete email address/)).not.toBeInTheDocument();
  });

  it('sends a taken address to the other tab', async () => {
    mockFetch({
      ...health(),
      [SIGN_UP]: () =>
        fail(422, {
          message: 'User already exists. Use another email.',
          code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL',
        }),
    });
    mount();

    toRegister();
    fillIn('ivan@example.com');
    submit('Create account');

    expect(await screen.findByText(/already an account with that address/)).toBeInTheDocument();
  });

  it('names no length when the server calls the password too short', async () => {
    // this arm is reachable only once MIN_PASSWORD (api.ts) has drifted from
    // minPasswordLength (auth.ts): the pre-flight below would have caught anything
    // shorter. So the only number this client has is the one known to be wrong, and
    // printing it contradicts the password in the box. Equality cannot say that
    mockFetch({
      ...health(),
      [SIGN_UP]: () => fail(400, { message: 'Password too short', code: 'PASSWORD_TOO_SHORT' }),
    });
    mount();

    toRegister();
    fillIn('ivan@example.com'); // the default password is long enough to get past the pre-flight
    submit('Create account');

    await waitFor(() => expect(errorText()).toMatch(/password is too short/i));
    expect(errorText()).not.toMatch(/\d/);
  });
});

describe('a refusal that is nobody on this screen’s fault', () => {
  it('blames neither the visitor nor the connection for a rate limit on the login tab', async () => {
    // 5 per 60s on /sign-in/email: five wrong passwords is a thing one ordinary
    // person does, so this is not a rare sentence
    mockFetch({ ...health(), [SIGN_IN]: () => fail(429, TOO_MANY_REQUESTS) });
    mount();

    fillIn('ivan@example.com');
    submit('Sign in');

    await expectRateLimitSentence();
    expect(screen.queryByText(/do not match an account here/)).not.toBeInTheDocument();
    expect(screen.queryByText(/could not reach the server/)).not.toBeInTheDocument();
  });

  it('says the same thing for a rate limit on the register tab, whose window is an hour', async () => {
    // 10 per hour on /sign-up/email, and every attempt counts - a taken address, a
    // typo, a wrong invite code. The sentence written for the other tab told this
    // person to wait a minute, which is short by a factor of 60
    mockFetch({ ...health(), [SIGN_UP]: () => fail(429, TOO_MANY_REQUESTS) });
    mount();

    toRegister();
    fillIn('ivan@example.com');
    submit('Create account');

    await expectRateLimitSentence();
  });

  it('says the connection failed when the request never landed, and claims nothing else', async () => {
    mockFetch({
      ...health(),
      [SIGN_IN]: () => {
        throw new TypeError('Failed to fetch');
      },
    });
    mount();

    fillIn('ivan@example.com');
    submit('Sign in');

    expect(await screen.findByText(/could not reach the server/)).toBeInTheDocument();
    expect(screen.getByText(/not a problem with your account or your password/)).toBeInTheDocument();
  });
});

describe('the invite gate, which is ours and answers a different body shape', () => {
  it('puts its sentence on screen and no JSON', async () => {
    // { error } is refuse()'s contract, not better-auth's { message }: reading only
    // the latter left {"error":"registration on this server is invite-only"} on
    // screen, on the path every invite-only deployment has switched on
    mockFetch({
      ...health('invite'),
      [SIGN_UP]: () => fail(403, { error: 'registration on this server is invite-only' }),
    });
    mount();

    toRegister();
    const code = await screen.findByLabelText('Invite code');
    fireEvent.change(code, { target: { value: 'wrong-code' } });
    fillIn('ivan@example.com');
    submit('Create account');

    expect(await screen.findByText(/invite-only/)).toBeInTheDocument();
    // framed as the server's words rather than spoken in Finto's voice
    expect(screen.getByText(/The server refused this/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('{"error"');
  });
});

describe('what never reaches the server', () => {
  it('refuses a short password on the register tab before any request', async () => {
    mockFetch(health());
    mount();

    toRegister();
    fillIn('ivan@example.com', 'short');
    submit('Create account');

    expect(await screen.findByText(/at least 8 characters/)).toBeInTheDocument();
    expect(requests()).toEqual([HEALTH]);
  });

  it('does not pre-check the password on the login tab', async () => {
    // there a short password is a wrong password, and refusing it here would name a
    // cause that is not the cause - the request has to go out and be judged
    mockFetch({
      ...health(),
      [SIGN_IN]: () =>
        fail(401, { message: 'Invalid email or password', code: 'INVALID_EMAIL_OR_PASSWORD' }),
    });
    mount();

    fillIn('ivan@example.com', 'short');
    submit('Sign in');

    expect(await screen.findByText(/do not match an account here/)).toBeInTheDocument();
    expect(requests()).toContain(SIGN_IN);
  });
});

describe('the screen around the refusal', () => {
  it('signs in only on the answer that said so', async () => {
    mockFetch({ ...health(), [SIGN_IN]: () => ok({ user: { id: 'u1' } }) });
    const onSignedIn = mount();

    fillIn('ivan@example.com');
    submit('Sign in');

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
  });

  it('never signs in on a refusal', async () => {
    // onSignedIn re-checks the session, which answers signed-out and leaves the
    // person on this screen with nothing said at all
    mockFetch({
      ...health(),
      [SIGN_IN]: () =>
        fail(401, { message: 'Invalid email or password', code: 'INVALID_EMAIL_OR_PASSWORD' }),
    });
    const onSignedIn = mount();

    fillIn('ivan@example.com');
    submit('Sign in');

    expect(await screen.findByText(/do not match an account here/)).toBeInTheDocument();
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it('clears a refusal when the tab changes', async () => {
    mockFetch({
      ...health(),
      [SIGN_IN]: () =>
        fail(401, { message: 'Invalid email or password', code: 'INVALID_EMAIL_OR_PASSWORD' }),
    });
    mount();

    fillIn('ivan@example.com');
    submit('Sign in');
    expect(await screen.findByText(/do not match an account here/)).toBeInTheDocument();

    toRegister();

    expect(screen.queryByText(/do not match an account here/)).not.toBeInTheDocument();
  });

  it('holds the tab still while a request is out', async () => {
    // switching mid-flight lets the answer land and paint a sentence about the tab
    // the person has just left
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockFetch({
      ...health(),
      [SIGN_IN]: async () => {
        await held;
        return fail(401, { message: 'Invalid email or password', code: 'INVALID_EMAIL_OR_PASSWORD' });
      },
    });
    mount();

    fillIn('ivan@example.com');
    submit('Sign in');

    await waitFor(() => expect(screen.getByRole('button', { name: 'Register' })).toBeDisabled());

    release();
    expect(await screen.findByText(/do not match an account here/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Register' })).toBeEnabled();
  });
});

/**
 * The assertion whose purpose is a rule nobody wrote a case for: over the whole
 * table, about the shape of what reaches the screen rather than its value. A future
 * code whose message carries a field path is caught here even though no case names
 * it, which is the half a per-refusal assertion cannot cover.
 *
 * Every fixture is submitted through /sign-in/email, including the three only
 * /sign-up/email can produce. What this covers is the classifier, which is
 * endpoint-independent - not the tab. Copy that differs by tab is invisible here,
 * and that is the gap the register-tab 429 above exists to close.
 */
describe('no refusal in the table puts a field path on screen', () => {
  it.each(AUTH_REFUSALS)('$status $what', async (refusal) => {
    mockFetch({ ...health(), [SIGN_IN]: () => fail(refusal.status, refusal.body) });
    mount();

    fillIn('ivan@example.com');
    submit('Sign in');

    // something was said - an empty screen would pass the sweep vacuously
    await waitFor(() => expect(document.querySelector('.error')).toBeInTheDocument());
    expect(document.body.textContent).not.toContain('[body.');
  });
});
