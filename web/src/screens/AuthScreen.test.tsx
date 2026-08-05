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

const submit = (name: 'Login' | 'Create account') =>
  fireEvent.click(screen.getByRole('button', { name }));

/**
 * The register tab is behind the switch; login is the mode the screen opens in.
 * The names are the redesign's ("Login", "Sign up here" - Figma 2008:79), not the
 * plain ones this screen used to carry.
 */
const SWITCH = 'Sign up here';

const toRegister = () => fireEvent.click(screen.getByRole('button', { name: SWITCH }));

/**
 * A route that keeps what the request carried. The harness hands a handler its
 * RequestInit, so an assertion can be about what went out — which is the only way
 * to see two name boxes become one string, or a ticked box send nothing at all.
 *
 * Returned per test rather than held in a module-level object: a stale body from
 * the test before would let a request that never happened pass the assertion.
 */
function capturing(respond: () => Response) {
  const sent: { body: Record<string, unknown> | null } = { body: null };
  const handler = (init?: RequestInit) => {
    sent.body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    return respond();
  };
  return [handler, sent] as const;
}

const signedUp = () => ok({ user: { id: 'u1' } });

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
    submit('Login');

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
    submit('Login');

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
    submit('Login');

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
    submit('Login');

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
    submit('Login');

    expect(await screen.findByText(/do not match an account here/)).toBeInTheDocument();
    expect(requests()).toContain(SIGN_IN);
  });
});

/**
 * The register frame (Figma 2012:698) draws four password rules and a terms row
 * that the server has no opinion about at all — its whole policy is
 * minPasswordLength (backend/src/auth.ts), and it has never heard of terms. What
 * is pinned here is that they stay advice: a control that reports and a control
 * that refuses look the same in a screenshot and are not the same account.
 */
describe('the register tab’s password rules', () => {
  const rule = (text: string) => screen.getByText(text).closest('li') as HTMLLIElement;
  const met = (text: string) => rule(text).className.includes('is-met');

  it('prints the length the server actually enforces, not the frame’s 6', async () => {
    // the frame says "Use 6 or more characters" and better-auth refuses anything
    // under 8, so the frame's number is a rule that fails whoever follows it
    mockFetch(health());
    mount();

    toRegister();

    expect(screen.getByText('Use 8 or more characters')).toBeInTheDocument();
    expect(screen.queryByText(/Use 6 or more characters/)).not.toBeInTheDocument();
  });

  it('marks each rule against what has been typed', async () => {
    mockFetch(health());
    mount();

    toRegister();
    fireEvent.change(field('Password'), { target: { value: 'Hagj#hhg' } });

    expect(met('Use 8 or more characters')).toBe(true);
    expect(met('Use upper and lower case letters (e.g. Aa)')).toBe(true);
    expect(met('Use a symbol (e.g. !@#$)')).toBe(true);
    // the one the frame itself draws with a cross
    expect(met('Use a number (e.g. 1234)')).toBe(false);
  });

  it('judges nothing while the box is empty', () => {
    // four red crosses over a box nobody has touched is an accusation, and the
    // frame never drew that state - it only ever shows the list against a password
    mockFetch(health());
    mount();

    toRegister();

    expect(document.querySelector('.auth-rules')?.className).toContain('is-untouched');
  });

  it('counts a capital and a digit that are not Latin', () => {
    // /[A-Z]/ and /[0-9]/ would tell someone typing Cyrillic they had used no
    // capital when they had, on the one screen they meet before they have an account
    mockFetch(health());
    mount();

    toRegister();
    fireEvent.change(field('Password'), { target: { value: 'Пароль٣!' } });

    expect(met('Use upper and lower case letters (e.g. Aa)')).toBe(true);
    expect(met('Use a number (e.g. 1234)')).toBe(true);
  });

  it('lets a password the server would take through, however few rules it meets', async () => {
    // the three below the length are this client's invention: the server has no
    // complexity policy, so refusing here would refuse an account any other client
    // could make, and name a cause that does not exist. See REDESIGN-BACK-DEBT.md §6
    mockFetch({ ...health(), [SIGN_UP]: () => ok({ user: { id: 'u1' } }) });
    const onSignedIn = mount();

    toRegister();
    fillIn('ivan@example.com', 'passwordpassword'); // no capital, no digit, no symbol
    submit('Create account');

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
  });
});

describe('the register tab’s other two boxes', () => {
  it('joins the two name boxes into the one string the server takes', async () => {
    const [signUp, sent] = capturing(signedUp);
    mockFetch({ ...health(), [SIGN_UP]: signUp });
    mount();

    toRegister();
    fireEvent.change(field('Name'), { target: { value: ' Havana ' } });
    fireEvent.change(field('Last name'), { target: { value: 'Navaha' } });
    fillIn('ivan@example.com');
    submit('Create account');

    await waitFor(() => expect(sent.body).toMatchObject({ name: 'Havana Navaha' }));
  });

  it('still falls back to the address when both are empty', async () => {
    // the boxes are optional, as the single one before them was, and better-auth
    // wants a string either way
    const [signUp, sent] = capturing(signedUp);
    mockFetch({ ...health(), [SIGN_UP]: signUp });
    mount();

    toRegister();
    fillIn('ivan@example.com');
    submit('Create account');

    await waitFor(() => expect(sent.body).toMatchObject({ name: 'ivan' }));
  });

  it('makes an account without the terms box ticked, and sends nothing about it', async () => {
    // there is no terms document and no column that would remember the agreeing,
    // so gating on the box would make a fiction compulsory (debt §7)
    const [signUp, sent] = capturing(signedUp);
    mockFetch({ ...health(), [SIGN_UP]: signUp });
    const onSignedIn = mount();

    toRegister();
    fillIn('ivan@example.com');
    // the whole sentence names the box, not the four words before the underline
    expect(screen.getByLabelText('I agree to the Terms & Conditions')).not.toBeChecked();
    submit('Create account');

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(Object.keys(sent.body ?? {})).toEqual(['email', 'password', 'name']);
  });
});

/**
 * Figma 2009:577. The one screen in the set whose button cannot work: better-auth
 * mounts /forget-password only once `sendResetPassword` is supplied, and
 * backend/src/auth.ts supplies nothing — so what is pinned here is that the
 * request is never made, and that the person is told why in Finto's words rather
 * than shown whatever a route that does not exist answers. See debt §1.
 */
describe('Forgot Password, whose server cannot answer', () => {
  const toForgot = () => fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }));

  it('opens from the login screen', () => {
    mockFetch(health());
    mount();

    toForgot();

    expect(screen.getByRole('heading', { name: 'Forgot Password?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset Password' })).toBeInTheDocument();
    // a password box on a screen for people who do not have their password
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });

  it('says what is missing and sends nothing', async () => {
    mockFetch(health());
    mount();

    toForgot();
    fireEvent.change(field('Email'), { target: { value: 'ivan@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset Password' }));

    await waitFor(() => expect(errorText()).toMatch(/recovery is not set up on this server/i));
    // the point of the sentence: no request went out to be answered 404, and no
    // 404 reached the screen dressed as something the person could act on
    expect(requests()).toEqual([HEALTH]);
    expect(document.body.textContent).not.toContain('404');
  });

  it('tints no box, because neither of them is what is wrong', async () => {
    // the address may be perfectly good - it is the server that cannot do this -
    // and colouring the box would send someone to retype something already right
    mockFetch(health());
    mount();

    toForgot();
    fireEvent.change(field('Email'), { target: { value: 'ivan@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset Password' }));

    await waitFor(() => expect(document.querySelector('.error')).toBeInTheDocument());
    expect(document.querySelector('.auth-input.is-wrong')).toBeNull();
  });

  it('keeps the address typed on the way back to signing in', () => {
    // three modes and one form, so the box a person has already filled survives
    // the trip - which is the whole reason this is not three screens
    mockFetch(health());
    mount();

    fireEvent.change(field('Email'), { target: { value: 'ivan@example.com' } });
    toForgot();
    expect(field('Email').value).toBe('ivan@example.com');

    fireEvent.click(screen.getByRole('button', { name: 'Sign in here' }));

    expect(screen.getByRole('heading', { name: 'Welcome Back!' })).toBeInTheDocument();
    expect(field('Email').value).toBe('ivan@example.com');
  });

  it('drops the refusal on the way out, the way the tabs do', async () => {
    mockFetch(health());
    mount();

    toForgot();
    fireEvent.change(field('Email'), { target: { value: 'ivan@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset Password' }));
    await waitFor(() => expect(document.querySelector('.error')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Sign in here' }));

    expect(document.querySelector('.error')).toBeNull();
  });

  it('asks for an address and not for a phone number', () => {
    // the frame labels the box "Email or Phone Number" and this server signs
    // nobody in by phone - the same disagreement debt §5 settles for login
    mockFetch(health());
    mount();

    toForgot();

    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/phone/i);
  });
});

/**
 * Figma 2011:652 and 2012:713 — the two screens behind Forgot Password.
 *
 * Neither can be reached through the app: each is opened by a server answer this
 * deployment cannot give, and Forgot Password refuses before it would navigate
 * (debt §1). `initialMode` is what renders them, and what makes them testable
 * rather than markup nobody can look at.
 *
 * The behaviour of the six boxes lives in CodeInput.test.tsx. What is pinned here
 * is the part this screen owns: the checks that run before the wall, and which of
 * them the wall is allowed to skip. None of them, is the answer — they are the
 * checks that stay when the rest is wired up.
 */
describe('Check your Email!, which nothing can reach yet', () => {
  const mountAt = (initialMode: 'code' | 'reset') => {
    renderThemed(<AuthScreen onSignedIn={vi.fn()} initialMode={initialMode} />);
  };
  const digit = (n: number) => screen.getByLabelText(`Digit ${n} of 6`);

  it('draws the frame: six boxes, and no address to type', () => {
    mockFetch(health());
    mountAt('code');

    expect(screen.getByRole('heading', { name: 'Check your Email!' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Enter Code' })).toBeInTheDocument();
    expect(screen.getAllByRole('textbox')).toHaveLength(6);
    // the address was given on the screen before this one
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
  });

  it('refuses a code that is not six digits, and says so rather than the other thing', async () => {
    mockFetch(health());
    mountAt('code');

    fireEvent.change(digit(1), { target: { value: '123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify Code' }));

    await waitFor(() => expect(errorText()).toMatch(/code is not complete/i));
    expect(errorText()).not.toMatch(/recovery is not set up/i);
  });

  it('reaches the wall once the code is complete, and sends nothing at it', async () => {
    mockFetch(health());
    mountAt('code');

    fireEvent.change(digit(1), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify Code' }));

    await waitFor(() => expect(errorText()).toMatch(/recovery is not set up on this server/i));
    expect(requests()).toEqual([HEALTH]);
  });
});

describe('Reset Password, whose two boxes have to agree', () => {
  const mountAt = () => {
    renderThemed(<AuthScreen onSignedIn={vi.fn()} initialMode="reset" />);
  };
  const type = (label: string, value: string) =>
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  const change = () => fireEvent.click(screen.getByRole('button', { name: 'Change my Password' }));

  it('draws the frame: two password boxes, the rules, and one eye between them', () => {
    mockFetch(health());
    mountAt();

    expect(screen.getByRole('heading', { name: 'Reset Password' })).toBeInTheDocument();
    expect(screen.getByLabelText('New Password')).toBeInTheDocument();
    expect(screen.getByLabelText('Confirm New Password')).toBeInTheDocument();
    expect(screen.getByText('Use 8 or more characters')).toBeInTheDocument();
    // the frame gives the confirm box no eye, and a box that exists to be typed
    // twice proves nothing if the first one can be read off the screen
    expect(screen.getAllByRole('button', { name: /^(Show|Hide) / })).toEqual([
      screen.getByRole('button', { name: 'Show new password' }),
    ]);
  });

  it('says mismatch, and tints the box that disagrees rather than the first one', async () => {
    mockFetch(health());
    mountAt();

    type('New Password', 'Hagj#hhg1');
    type('Confirm New Password', 'Hagj#hhg2');
    change();

    await waitFor(() => expect(errorText()).toBe('Password mismatch'));
    expect(screen.getByLabelText('Confirm New Password')).toHaveClass('is-wrong');
    expect(screen.getByLabelText('New Password')).not.toHaveClass('is-wrong');
  });

  it('checks the two agree before it checks the length', async () => {
    // two passwords that disagree do not say which of them was meant, so there is
    // nothing yet whose length is worth measuring
    mockFetch(health());
    mountAt();

    type('New Password', 'short');
    type('Confirm New Password', 'shorter');
    change();

    await waitFor(() => expect(errorText()).toBe('Password mismatch'));
    expect(errorText()).not.toMatch(/at least 8/);
  });

  it('then refuses a short one that both boxes agree on', async () => {
    mockFetch(health());
    mountAt();

    type('New Password', 'short');
    type('Confirm New Password', 'short');
    change();

    await waitFor(() => expect(errorText()).toMatch(/at least 8 characters/));
    expect(screen.getByLabelText('New Password')).toHaveClass('is-wrong');
  });

  it('reaches the wall on a pair that is agreed and long enough, and sends nothing', async () => {
    mockFetch(health());
    mountAt();

    type('New Password', 'Hagj#hhg1');
    type('Confirm New Password', 'Hagj#hhg1');
    change();

    await waitFor(() => expect(errorText()).toMatch(/recovery is not set up on this server/i));
    expect(requests()).toEqual([HEALTH]);
    expect(document.querySelector('.auth-input.is-wrong')).toBeNull();
  });

  it('marks the rules against the new password and not the confirmation', () => {
    mockFetch(health());
    mountAt();

    type('New Password', 'Hagj#hhg');

    const rule = (text: string) => screen.getByText(text).closest('li') as HTMLLIElement;
    expect(rule('Use 8 or more characters').className).toContain('is-met');
    expect(rule('Use a number (e.g. 1234)').className).not.toContain('is-met');
  });
});

/**
 * The one screen with no frame behind it: the Figma file draws the reset and
 * stops. It is asserted like the others anyway, because "made up" is a reason to
 * pin it rather than a reason not to — the next person needs to be able to see
 * which parts came from the design and which from us.
 */
describe('Password Changed!, which the design does not draw', () => {
  const mountDone = () => {
    renderThemed(<AuthScreen onSignedIn={vi.fn()} initialMode="done" />);
  };

  it('is a mark, a sentence and the way out, and no form at all', () => {
    mockFetch(health());
    mountDone();

    expect(screen.getByRole('heading', { name: 'Password Changed!' })).toBeInTheDocument();
    expect(screen.getByText('Sign in with your new password.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    // nothing left to type, and nothing left to submit
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    expect(document.querySelector('form')).toBeNull();
  });

  it('carries the tick at a size, and green rather than the screen’s ink', () => {
    // the icon's stroke is currentColor and `.auth` sets that to #000, so the one
    // green thing on the screen is green only because a class says so
    mockFetch(health());
    mountDone();

    const mark = document.querySelector('.auth-mark svg');
    expect(mark).toHaveAttribute('width', String((22 / 24) * 64));
    expect(document.querySelector('.auth-mark')).toBeInTheDocument();
  });

  it('has no second way out under the button', () => {
    // every other screen ends "Already have account? Sign in here"; here the button
    // is already that, and offering it twice reads as two different things
    mockFetch(health());
    mountDone();

    expect(screen.queryByText(/Already have account\?/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in here' })).not.toBeInTheDocument();
  });

  it('goes to the login screen, which is what it says it does', () => {
    mockFetch(health());
    mountDone();

    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(screen.getByRole('heading', { name: 'Welcome Back!' })).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });
});

describe('the screen around the refusal', () => {
  it('signs in only on the answer that said so', async () => {
    mockFetch({ ...health(), [SIGN_IN]: () => ok({ user: { id: 'u1' } }) });
    const onSignedIn = mount();

    fillIn('ivan@example.com');
    submit('Login');

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
    submit('Login');

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
    submit('Login');
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
    submit('Login');

    await waitFor(() => expect(screen.getByRole('button', { name: SWITCH })).toBeDisabled());

    release();
    expect(await screen.findByText(/do not match an account here/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: SWITCH })).toBeEnabled();
  });
});

/**
 * What the refusal is to somebody who is not looking at it.
 *
 * Everything above this block asserts the sentence. None of it could tell that the
 * sentence appeared in silence, that the box it was about was marked in a colour and
 * in nothing else, or that the button stopped saying what it did while the request
 * was out - which is the whole of what this screen said to a screen reader before.
 */
describe('the refusal, to somebody who cannot see it', () => {
  const WRONG = { message: 'Invalid email or password', code: 'INVALID_EMAIL_OR_PASSWORD' };
  const refuse = (body: object, status = 401) =>
    mockFetch({ ...health(), [SIGN_IN]: () => fail(status, body) });

  it('announces itself, and the boxes it tinted point at it', async () => {
    refuse(WRONG);
    mount();

    fillIn('ivan@example.com');
    submit('Login');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/do not match an account here/);

    for (const box of [field('Email'), field('Password')]) {
      expect(box).toHaveAttribute('aria-invalid', 'true');
      expect(box.getAttribute('aria-describedby')).toContain(alert.id);
    }
  });

  it('adds itself to the rules on the password box rather than replacing them', () => {
    mockFetch(health());
    mount();

    toRegister();
    fillIn('ivan@example.com', 'short');
    submit('Create account');

    // both, in the order they are read: what the box needs, then what went wrong
    expect(field('Password')).toHaveAttribute(
      'aria-describedby',
      'auth-password-rules auth-error',
    );
  });

  it('takes focus to the box when it is about one box', () => {
    mockFetch(health());
    mount();

    toRegister();
    fillIn('ivan@example.com', 'short');
    submit('Create account');

    expect(field('Password')).toHaveFocus();
  });

  it('leaves focus alone when it is about two', async () => {
    refuse(WRONG);
    mount();

    fillIn('ivan@example.com');
    field('Password').focus();
    submit('Login');

    await screen.findByRole('alert');
    // the server declines to say which of the two it was, so there is no "first
    // error" to go to - and the address is the half that is rarely the problem
    expect(field('Password')).toHaveFocus();
  });

  it('ends the moment any box is typed in', async () => {
    refuse(WRONG);
    mount();

    fillIn('ivan@example.com');
    submit('Login');
    await screen.findByRole('alert');
    expect(field('Email')).toHaveClass('is-wrong');

    fireEvent.change(field('Email'), { target: { value: 'ivan@example.co' } });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(document.querySelector('.auth-input.is-wrong')).toBeNull();
    expect(field('Email')).not.toHaveAttribute('aria-invalid');
  });

  it('keeps the button saying what it does while the request is out', async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockFetch({
      ...health(),
      [SIGN_IN]: async () => {
        await held;
        return fail(401, WRONG);
      },
    });
    mount();

    fillIn('ivan@example.com');
    submit('Login');

    // 'Login…' and not '…', which was the button's entire name for the length of
    // the request
    const button = await screen.findByRole('button', { name: 'Login…' });
    expect(button).toHaveAttribute('aria-busy', 'true');

    release();
    await screen.findByRole('alert');
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
    submit('Login');

    // something was said - an empty screen would pass the sweep vacuously
    await waitFor(() => expect(document.querySelector('.error')).toBeInTheDocument());
    expect(document.body.textContent).not.toContain('[body.');
  });
});
