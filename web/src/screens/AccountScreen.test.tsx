import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { USER } from '../test/fixtures';
import { fail, mockFetch, ok, renderThemed, requests } from '../test/harness';
import { AccountScreen } from './AccountScreen';

/**
 * The screen the row is about. Two things are asserted here that nothing else can:
 * that the affirmation exists only where a change really landed, and that a failure
 * whose outcome nobody knows is not reported as "nothing happened" - the endpoint
 * writes the password before it replaces the sessions, and not in one transaction.
 *
 * What jsdom cannot answer stays manual: five tabs at two widths, and whether the
 * new password actually signs in.
 */

const CHANGE = 'POST /api/auth/change-password';

const mount = (onSignOut: () => void = vi.fn()) => {
  renderThemed(<AccountScreen user={USER} onSignOut={onSignOut} />);
  return onSignOut;
};

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

const fillIn = (current: string, next: string, confirm = next) => {
  fireEvent.change(field('Current password'), { target: { value: current } });
  fireEvent.change(field('New password'), { target: { value: next } });
  fireEvent.change(field('Confirm new password'), { target: { value: confirm } });
};

const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Change password' }));

const affirmation = () => screen.queryByText(/Password changed/);

/**
 * Call this between submit() and the first await, never after it: the answer is still
 * in flight at that moment, and it is the only one an affirmation set before the await
 * is on screen for. Awaiting first passes against exactly the version this exists to
 * catch, because by then the real result has painted over the flash.
 */
const noAffirmationYet = () => expect(affirmation()).not.toBeInTheDocument();

describe('the screen itself', () => {
  it('asks the server for nothing when it mounts', async () => {
    // it is always mounted behind `hidden`, so a load here is a load on the app's
    // first paint - and setup.ts's afterEach throws on any request no route matched
    mockFetch({});
    mount();

    expect(await screen.findByRole('heading', { name: 'Your account' })).toBeInTheDocument();
    expect(requests()).toEqual([]);
  });

  it('shows the address as the form field a password manager files under', async () => {
    mockFetch({});
    mount();

    const email = field('Signed in as');
    expect(email.value).toBe(USER.email);
    expect(email).toHaveAttribute('readonly');
    expect(email).toHaveAttribute('autocomplete', 'username');
    // change email is a different row and there is no mailer behind it
    expect(screen.queryByRole('button', { name: /email/i })).not.toBeInTheDocument();
  });

  it('hands the sign-out control straight to its prop', async () => {
    mockFetch({});
    const onSignOut = mount();

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
});

describe('a change the server accepted', () => {
  it('affirms it and empties all three fields', async () => {
    mockFetch({ [CHANGE]: () => ok({ token: 'session-token', user: USER }) });
    mount();

    fillIn('old-password', 'new-password');
    submit();

    expect(await screen.findByText(/Password changed/)).toBeInTheDocument();
    expect(field('Current password').value).toBe('');
    expect(field('New password').value).toBe('');
    expect(field('Confirm new password').value).toBe('');
  });
});

describe('a change the server refused', () => {
  it('names the current password and affirms nothing', async () => {
    mockFetch({
      [CHANGE]: () => fail(400, { message: 'Invalid password', code: 'INVALID_PASSWORD' }),
    });
    mount();

    fillIn('wrong-password', 'new-password');
    submit();
    noAffirmationYet();

    expect(await screen.findByText(/not your current password/)).toBeInTheDocument();
    expect(affirmation()).not.toBeInTheDocument();
    // a refusal changed nothing, so it must not send anyone to the new password
    expect(screen.queryByText(/NEW password/)).not.toBeInTheDocument();
    // and the typed fields survive, so a retry is one correction and not four
    expect(field('New password').value).toBe('new-password');
  });

  it("passes the server's own words through for a 400 that is not about the current one", async () => {
    mockFetch({
      [CHANGE]: () => fail(400, { message: 'Password too long', code: 'PASSWORD_TOO_LONG' }),
    });
    mount();

    fillIn('old-password', 'x'.repeat(200));
    submit();
    noAffirmationYet();

    expect(await screen.findByText(/Password too long/)).toBeInTheDocument();
    expect(affirmation()).not.toBeInTheDocument();
  });
});

describe('a failure nobody knows the outcome of', () => {
  it('says so, and names the new password as the way to find out', async () => {
    // a 500 can arrive after the password was already written: telling the owner
    // "could not change your password" sends them back to one that now fails, and
    // the honest reading on their side is that the account is broken
    mockFetch({ [CHANGE]: () => fail(500, { message: 'Failed to get session' }) });
    mount();

    fillIn('old-password', 'new-password');
    submit();
    noAffirmationYet();

    expect(await screen.findByText(/cannot tell whether/)).toBeInTheDocument();
    expect(screen.getByText(/NEW password/)).toBeInTheDocument();
    expect(affirmation()).not.toBeInTheDocument();
  });

  it('does not report a rate limit as a wrong password', async () => {
    // 3 per 10s per IP, before this project's rules are consulted: two mistyped
    // attempts and a retry reach it. The body carries a message and no code.
    mockFetch({ [CHANGE]: () => fail(429, { message: 'Too many requests. Please try again later.' }) });
    mount();

    fillIn('old-password', 'new-password');
    submit();

    expect(await screen.findByText(/cannot tell whether/)).toBeInTheDocument();
    expect(screen.queryByText(/not your current password/)).not.toBeInTheDocument();
  });

  it('survives a retry that answers 401, because that 401 is the same failure', async () => {
    // the half of the write that failed had already deleted every session, so the
    // retry cannot reach the handler. Letting it print "nothing was changed" would
    // overwrite the one correct diagnosis with a promise the request cannot make.
    let attempt = 0;
    mockFetch({
      [CHANGE]: () =>
        ++attempt === 1
          ? fail(500, { message: 'Failed to get session' })
          : fail(401, { message: 'Unauthorized', code: 'UNAUTHORIZED' }),
    });
    mount();

    fillIn('old-password', 'new-password');
    submit();
    expect(await screen.findByText(/cannot tell whether/)).toBeInTheDocument();

    submit();
    expect(requests().filter((r) => r === CHANGE)).toHaveLength(2);

    expect(await screen.findByText(/cannot tell whether/)).toBeInTheDocument();
    expect(screen.queryByText(/You are signed out/)).not.toBeInTheDocument();
  });
});

describe('a session that is already gone', () => {
  it('says so where no unknown came first, since that request wrote nothing', async () => {
    mockFetch({ [CHANGE]: () => fail(401, { message: 'Unauthorized', code: 'UNAUTHORIZED' }) });
    mount();

    fillIn('old-password', 'new-password');
    submit();
    noAffirmationYet();

    expect(await screen.findByText(/You are signed out/)).toBeInTheDocument();
    expect(screen.queryByText(/cannot tell whether/)).not.toBeInTheDocument();
  });
});

describe('what never reaches the server', () => {
  /** The request is the assertion: setup.ts throws on one no route matched. */
  const noRequest = () => expect(requests()).toEqual([]);

  it('refuses a confirmation that does not match', async () => {
    // there is no password reset in this product, so a new password mistyped once is
    // an account nobody can get back into without editing the database
    mockFetch({});
    mount();

    fillIn('old-password', 'new-password', 'new-passwrod');
    submit();

    expect(await screen.findByText(/do not match/)).toBeInTheDocument();
    noRequest();
  });

  it('refuses a new password below the minimum', async () => {
    mockFetch({});
    mount();

    fillIn('old-password', 'short');
    submit();

    expect(await screen.findByText(/at least 8 characters/)).toBeInTheDocument();
    noRequest();
  });

  it('refuses a new password identical to the current one', async () => {
    // the server answers 200 to this and changes nothing, and the screen would
    // affirm a change that did not happen
    mockFetch({});
    mount();

    fillIn('old-password', 'old-password');
    submit();

    expect(await screen.findByText(/already using/)).toBeInTheDocument();
    expect(affirmation()).not.toBeInTheDocument();
    noRequest();
  });
});
