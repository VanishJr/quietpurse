import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { APP_SETTINGS, RECURRING, USER } from '../test/fixtures';
import { fail, mockFetch, ok, renderThemed, requests, Routes } from '../test/harness';
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

/**
 * The two reads that came here with the workspace blocks. They were the Overview's
 * before, and both were already on the app's first paint - what moved is which screen
 * asks, not how many requests the app makes when it starts.
 */
const BASE: Routes = {
  'GET /api/recurring': () => ok(RECURRING),
  'GET /api/app-settings': () => ok(APP_SETTINGS),
};

const mount = (onSignOut: () => void = vi.fn()) => {
  renderThemed(
    <AccountScreen user={USER} onSignOut={onSignOut} onOpenImport={vi.fn()} />,
  );
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
  it('asks for the two workspace reads that moved here, and nothing else', async () => {
    // It is always mounted behind `hidden`, so a load here is a load on the app's first
    // paint. Both of these already were one - they were the Overview's - so what moved
    // is which screen asks, not how many requests the app makes when it starts. The
    // assertion is the whole set, because a third read added here is a third read on
    // every visit to the app, whatever screen it lands on.
    mockFetch(BASE);
    mount();

    expect(await screen.findByRole('heading', { name: 'Your account' })).toBeInTheDocument();
    expect([...new Set(requests())].sort()).toEqual([
      'GET /api/app-settings',
      'GET /api/recurring',
    ]);
  });

  it('shows the address as the form field a password manager files under', async () => {
    mockFetch(BASE);
    mount();

    const email = field('Signed in as');
    expect(email.value).toBe(USER.email);
    expect(email).toHaveAttribute('readonly');
    expect(email).toHaveAttribute('autocomplete', 'username');
    // change email is a different row and there is no mailer behind it
    expect(screen.queryByRole('button', { name: /email/i })).not.toBeInTheDocument();
  });

  it('hands the sign-out control straight to its prop', async () => {
    mockFetch(BASE);
    const onSignOut = mount();

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
});

describe('a change the server accepted', () => {
  it('affirms it and empties all three fields', async () => {
    mockFetch({ ...BASE, [CHANGE]: () => ok({ token: 'session-token', user: USER }) });
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
      ...BASE,
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
      ...BASE,
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
    mockFetch({ ...BASE, [CHANGE]: () => fail(500, { message: 'Failed to get session' }) });
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
    mockFetch({ ...BASE, [CHANGE]: () => fail(429, { message: 'Too many requests. Please try again later.' }) });
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
      ...BASE,
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
    mockFetch({ ...BASE, [CHANGE]: () => fail(401, { message: 'Unauthorized', code: 'UNAUTHORIZED' }) });
    mount();

    fillIn('old-password', 'new-password');
    submit();
    noAffirmationYet();

    expect(await screen.findByText(/You are signed out/)).toBeInTheDocument();
    expect(screen.queryByText(/cannot tell whether/)).not.toBeInTheDocument();
  });
});

describe('what never reaches the server', () => {
  /**
   * The request is the assertion: setup.ts throws on one no route matched. The two
   * mount reads are subtracted rather than allowed for — what these tests are about is
   * that the CHANGE never went out, and a settings read is not a password change.
   */
  const noRequest = () =>
    expect(requests().filter((r) => !Object.keys(BASE).includes(r))).toEqual([]);

  it('refuses a confirmation that does not match', async () => {
    // there is no password reset in this product, so a new password mistyped once is
    // an account nobody can get back into without editing the database
    mockFetch(BASE);
    mount();

    fillIn('old-password', 'new-password', 'new-passwrod');
    submit();

    expect(await screen.findByText(/do not match/)).toBeInTheDocument();
    noRequest();
  });

  it('refuses a new password below the minimum', async () => {
    mockFetch(BASE);
    mount();

    fillIn('old-password', 'short');
    submit();

    expect(await screen.findByText(/at least 8 characters/)).toBeInTheDocument();
    noRequest();
  });

  it('refuses a new password identical to the current one', async () => {
    // the server answers 200 to this and changes nothing, and the screen would
    // affirm a change that did not happen
    mockFetch(BASE);
    mount();

    fillIn('old-password', 'old-password');
    submit();

    expect(await screen.findByText(/already using/)).toBeInTheDocument();
    expect(affirmation()).not.toBeInTheDocument();
    noRequest();
  });
});

/**
 * The four blocks that came here from the Overview, in the order the screen puts
 * them: how Finto counts, what it found, your data, leaving. The tests moved with
 * them unchanged except for where they mount.
 */

describe('how Finto counts', () => {
  const currency = () => screen.getByLabelText('Base currency') as HTMLInputElement;
  const owners = () => screen.getByLabelText('Owner names') as HTMLInputElement;

  /** The anchor: no field exists until GET /api/app-settings came back. */
  const settled = () => screen.findByLabelText('Base currency');

  it('shows the stored values', async () => {
    mockFetch(BASE);
    mount();
    await settled();

    expect(currency().value).toBe('EUR');
    expect(owners().value).toBe('Yurii Kalvenko');
  });

  it('offers a retry when the settings could not be read, and takes it', async () => {
    let reads = 0;
    mockFetch({
      ...BASE,
      'GET /api/app-settings': () => {
        reads += 1;
        return reads === 1 ? fail(500, { error: 'settings unavailable' }) : ok(APP_SETTINGS);
      },
    });
    mount();

    expect(await screen.findByText(/settings unavailable/)).toBeInTheDocument();
    // no fields: a form prefilled with values nobody stored is the lie this block avoids
    expect(screen.queryByLabelText('Base currency')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await settled();
    expect(currency().value).toBe('EUR');
  });

  it("shows the server's refusal instead of a success mark when the save is rejected", async () => {
    mockFetch({
      ...BASE,
      'PATCH /api/app-settings': () =>
        fail(400, { error: 'baseCurrency: a three-letter ISO code, e.g. EUR' }),
    });
    mount();
    await settled();

    fireEvent.change(currency(), { target: { value: 'EURO' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/three-letter ISO code/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Saved/ })).not.toBeInTheDocument();
  });

  it('marks the save done when the response echoes what was asked for', async () => {
    mockFetch({
      ...BASE,
      'PATCH /api/app-settings': () => ok({ baseCurrency: 'USD', ownerNames: ['Yurii Kalvenko'] }),
    });
    mount();
    await settled();

    fireEvent.change(currency(), { target: { value: 'usd' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('button', { name: 'Saved ✓' })).toBeInTheDocument();
    // re-rendered from the echoed body, not from what was typed
    expect(currency().value).toBe('USD');
  });

  it('refuses to call a 200 a save when the body came back with something else', async () => {
    mockFetch({
      ...BASE,
      'PATCH /api/app-settings': () => ok({ baseCurrency: 'EUR', ownerNames: ['Yurii Kalvenko'] }),
    });
    mount();
    await settled();

    fireEvent.change(currency(), { target: { value: 'USD' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/^Error:/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Saved/ })).not.toBeInTheDocument();
    expect(currency().value).toBe('EUR');
  });
});

describe('the data export', () => {
  const exportControl = () => screen.getByRole('button', { name: /Export my data/ });

  it('fetches the backup and saves what came back', async () => {
    mockFetch({ ...BASE, 'GET /api/backup': () => ok({ transactions: [] }) });
    mount();
    await screen.findByRole('heading', { name: 'Your data' });

    fireEvent.click(exportControl());

    // the object URL is the subject: it exists only once a checked 200 came back
    await vi.waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1));
  });

  it('shows the refusal beside the control and writes no file', async () => {
    // as a link this landed in Downloads as finto-backup-<date>.json, and the user
    // believed they held every transaction they own
    mockFetch({
      ...BASE,
      'GET /api/backup': () => fail(500, { error: 'the export could not be assembled' }),
    });
    mount();
    await screen.findByRole('heading', { name: 'Your data' });

    fireEvent.click(exportControl());

    expect(await screen.findByText(/the export could not be assembled/)).toBeInTheDocument();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('starts one backup per click, not one per impatient click', async () => {
    let release: (res: Response) => void = () => {};
    mockFetch({
      ...BASE,
      // held open on purpose: /api/backup serialises every table, and nothing on the
      // screen moves while it does
      'GET /api/backup': () => new Promise<Response>((resolve) => (release = resolve)),
    });
    mount();
    await screen.findByRole('heading', { name: 'Your data' });

    fireEvent.click(exportControl());
    expect(exportControl()).toBeDisabled();
    fireEvent.click(exportControl());
    release(ok({ transactions: [] }));

    await vi.waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1));
    expect(requests().filter((r) => r === 'GET /api/backup')).toHaveLength(1);
    expect(exportControl()).toBeEnabled();
  });
});

describe('the workspace import history', () => {
  it('opens every account, and comes back', async () => {
    mockFetch({ ...BASE, 'GET /api/imports': () => ok({ imports: [] }) });
    mount();
    await screen.findByRole('heading', { name: 'Your data' });

    fireEvent.click(screen.getByRole('button', { name: /Import history \(every account\)/ }));

    expect(await screen.findByRole('heading', { name: 'Import history' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '← Back to accounts' }));

    expect(await screen.findByRole('heading', { name: 'Your data' })).toBeInTheDocument();
  });
});

describe('recurring payments', () => {
  it('lists what the workspace found, and says so when it found nothing', async () => {
    mockFetch(BASE);
    mount();

    expect(await screen.findByRole('heading', { name: 'Recurring payments' })).toBeInTheDocument();
    // the fixture is empty, and an empty list has to read as "not yet" rather than as
    // a block that failed to load
    expect(screen.getByText(/A payment has to appear in several months/)).toBeInTheDocument();
  });

  it('hides a group and takes the list the server answers with', async () => {
    const group = {
      description: 'Spotify',
      category: 'subscriptions',
      months: 6,
      count: 6,
      avgAmount: -10,
      monthlyAvg: -10,
      lastDate: '2026-07-01',
      ignored: false,
    };
    mockFetch({
      ...BASE,
      'GET /api/recurring': () =>
        ok({ baseCurrency: 'EUR', monthlyTotal: 10, groups: [group] }),
      'POST /api/recurring/ignore': () =>
        ok({ baseCurrency: 'EUR', monthlyTotal: 0, groups: [{ ...group, ignored: true }] }),
    });
    mount();

    fireEvent.click(await screen.findByRole('button', { name: 'Hide payment Spotify' }));

    expect(
      await screen.findByRole('button', { name: 'Restore payment Spotify' }),
    ).toBeInTheDocument();
  });
});
