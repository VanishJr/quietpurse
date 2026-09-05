import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { APP_SETTINGS, importsResponse, RECURRING } from '../test/fixtures';
import { fail, mockFetch, ok, renderThemed, requests, Routes } from '../test/harness';
import { setUrl } from '../url';
import { SettingsScreen } from './SettingsScreen';

/**
 * The screen that holds everything about the whole of the data rather than one
 * account. What jsdom cannot answer stays manual: the screen at two widths.
 */

/**
 * The two reads that came here with the settings blocks. They were the Overview's
 * before, and both were already on the app's first paint - what moved is which screen
 * asks, not how many requests the app makes when it starts.
 */
const BASE: Routes = {
  'GET /api/recurring': () => ok(RECURRING),
  'GET /api/app-settings': () => ok(APP_SETTINGS),
};

const mount = () => renderThemed(<SettingsScreen onOpenImport={vi.fn()} />);

describe('the screen itself', () => {
  it('asks for the two reads that moved here, and nothing else', async () => {
    // It is always mounted behind `hidden`, so a load here is a load on the app's first
    // paint. Both of these already were one - they were the Overview's - so what moved
    // is which screen asks, not how many requests the app makes when it starts. The
    // assertion is the whole set, because a third read added here is a third read on
    // every visit to the app, whatever screen it lands on.
    mockFetch(BASE);
    mount();

    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect([...new Set(requests())].sort()).toEqual([
      'GET /api/app-settings',
      'GET /api/recurring',
    ]);
  });

  it('carries no password, no address and no sign-out, since there is no account', async () => {
    mockFetch(BASE);
    mount();

    await screen.findByRole('heading', { name: 'Settings' });
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign out/i })).not.toBeInTheDocument();
  });
});

/**
 * The three blocks that came here from the Overview, in the order the screen puts
 * them: how Finto counts, what it found, your data. The tests moved with them
 * unchanged except for where they mount.
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

describe('the import history across every account', () => {
  it('opens every account, and comes back', async () => {
    mockFetch({ ...BASE, 'GET /api/imports': () => ok(importsResponse([])) });
    mount();
    await screen.findByRole('heading', { name: 'Your data' });

    fireEvent.click(screen.getByRole('button', { name: /Import history \(every account\)/ }));

    expect(await screen.findByRole('heading', { name: 'Import history' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '← Back to accounts' }));

    expect(await screen.findByRole('heading', { name: 'Your data' })).toBeInTheDocument();
  });

  /**
   * The takeover is a place the reader can BE, so it lives in the URL like every other
   * one. It was a useState, and Shell keeps every screen mounted under `hidden` - so
   * the state outlived the screen, and leaving Settings and coming back answered with
   * the history instead of the settings that were asked for.
   *
   * The second half is the defect and is asserted WITHOUT a click: `{ screen:
   * 'settings', panel: null }` is exactly what Shell writes on every move between
   * screens, and against a useState it changes nothing at all.
   */
  it('puts the takeover in the URL, so a move between screens closes it', async () => {
    mockFetch({ ...BASE, 'GET /api/imports': () => ok(importsResponse([])) });
    mount();
    await screen.findByRole('heading', { name: 'Your data' });

    fireEvent.click(screen.getByRole('button', { name: /Import history \(every account\)/ }));
    expect(await screen.findByRole('heading', { name: 'Import history' })).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get('panel')).toBe('history');

    act(() => setUrl({ screen: 'settings', panel: null }));

    expect(await screen.findByRole('heading', { name: 'Your data' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Import history' })).not.toBeInTheDocument();
  });
});

describe('recurring payments', () => {
  it('lists what was found, and says so when nothing was', async () => {
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
