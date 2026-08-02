import { AuthAttempt } from '../api';

/**
 * Every refusal an ordinary person can reach on the sign-in / register form, as the
 * server really composes it - measured on the wire against better-auth 1.6.23 and
 * this backend, not composed from whatever the classifier matches on. A fixture
 * built from the pattern cannot notice the pattern narrowing.
 *
 * Its own file rather than fixtures.ts: everything in that file is declared with
 * the client's own types and drifts under tsc when one moves, and these are raw
 * response bodies typed by nothing. One table, read by both projects - the unit
 * test classifies each of them, the dom test renders each and asserts no Zod field
 * path survives to the screen. Two copies would let the sweep drift behind the
 * classifier and still pass.
 */
export interface AuthRefusal {
  /** What the person did to reach it. */
  what: string;
  status: number;
  body: unknown;
  /** Typed, so renaming a member of the union fails here rather than in the sweep. */
  outcome: AuthAttempt['outcome'];
}

export const AUTH_REFUSALS: AuthRefusal[] = [
  {
    what: 'register with an address missing its ending',
    status: 400,
    // refused by the endpoint's own body schema, above the handler
    body: { message: '[body.email] Invalid email address', code: 'VALIDATION_ERROR' },
    outcome: 'bad-email',
  },
  {
    what: 'register with a bad address and an empty password',
    status: 400,
    // the '; '-joined form: two failing fields, and only one of them the address.
    // Unreachable from this client today - it always sends three required strings -
    // and the shape the narrow condition in onlyAboutEmail exists for
    body: {
      message:
        '[body.email] Invalid email address; [body.password] Too small: expected string to have >=1 characters',
      code: 'VALIDATION_ERROR',
    },
    outcome: 'malformed-request',
  },
  {
    what: 'sign in with an address missing its ending',
    status: 400,
    // the same typo as the first row, on the other tab: no format check in this
    // endpoint's schema, so the handler refuses it under a different code
    body: { message: 'Invalid email', code: 'INVALID_EMAIL' },
    outcome: 'bad-email',
  },
  {
    what: 'sign in with an unknown address, or the wrong password',
    status: 401,
    body: { message: 'Invalid email or password', code: 'INVALID_EMAIL_OR_PASSWORD' },
    outcome: 'wrong-credentials',
  },
  {
    what: 'register an address that already has an account',
    status: 422,
    body: {
      message: 'User already exists. Use another email.',
      code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL',
    },
    outcome: 'email-taken',
  },
  {
    what: 'register with a password below the minimum',
    status: 400,
    body: { message: 'Password too short', code: 'PASSWORD_TOO_SHORT' },
    outcome: 'password-too-short',
  },
  {
    what: 'one attempt past the limit, on either tab',
    status: 429,
    // no code field at all, so the status is the only key there is - and it is the
    // same key for both endpoints, whose windows are 60s and an hour (auth.ts:95-96)
    body: { message: 'Too many requests. Please try again later.' },
    outcome: 'rate-limited',
  },
  {
    what: 'register with a wrong invite code',
    status: 403,
    // ours, not better-auth's: { error } is refuse()'s contract, and reading only
    // { message } is what put this on screen as literal JSON
    body: { error: 'registration on this server is invite-only' },
    outcome: 'unexpected',
  },
  {
    what: 'sign in before verifying the address',
    status: 403,
    // not reachable until email verification lands; here because it is the case
    // 'unexpected' has to carry the server's own words for
    body: { message: 'Email not verified', code: 'EMAIL_NOT_VERIFIED' },
    outcome: 'unexpected',
  },
];
