import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ACCOUNTS, APP_SETTINGS, PRESETS, RECURRING, USER } from '../test/fixtures';
import { fail, mockFetch, ok, renderThemed, Routes } from '../test/harness';
import { OverviewScreen } from './OverviewScreen';

/**
 * Item 13's manual checks 1 and 2, minus what jsdom cannot see: whether the backup
 * link lands a file on disk is a browser question and stays manual.
 */

const OVERVIEW_ROUTES: Routes = {
  'GET /api/accounts': () => ok(ACCOUNTS),
  'GET /api/recurring': () => ok(RECURRING),
  'GET /api/app-settings': () => ok(APP_SETTINGS),
};

const mount = () => renderThemed(<OverviewScreen user={USER} onSignOut={vi.fn()} />);

describe('accounts list', () => {
  it('renders visible accounts and keeps hidden ones out of the list', async () => {
    mockFetch(OVERVIEW_ROUTES);
    mount();

    // anchor: an account name, which exists only once /api/accounts came back
    expect(await screen.findByText('Sparkasse Giro')).toBeInTheDocument();
    expect(screen.getByText('1,234.50 EUR')).toBeInTheDocument();

    expect(screen.queryByText('Old DKB')).not.toBeInTheDocument();
    expect(screen.getByText(/Hidden accounts: 1/)).toBeInTheDocument();
  });

  it('reveals hidden accounts and the remove/restore buttons in edit mode', async () => {
    mockFetch(OVERVIEW_ROUTES);
    mount();
    expect(await screen.findByText('Sparkasse Giro')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Edit accounts' }));

    expect(await screen.findByText('Old DKB')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove account Sparkasse Giro' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore account Old DKB' })).toBeInTheDocument();
  });

  it('renders the empty state when there are no accounts, and it opens the import panel', async () => {
    mockFetch({
      ...OVERVIEW_ROUTES,
      'GET /api/accounts': () => ok([]),
      // the control mounts CsvImport, which asks for the preset list
      'GET /api/imports/presets': () => ok(PRESETS),
    });
    mount();

    expect(await screen.findByText(/No accounts yet/)).toBeInTheDocument();
    expect(screen.queryByText(/^Error:/)).not.toBeInTheDocument();

    // the point of the control: the empty state does not send the user hunting for a pill
    fireEvent.click(screen.getByRole('button', { name: /Import a statement/ }));
    expect(await screen.findByRole('heading', { name: 'Import a statement' })).toBeInTheDocument();
  });

  it('puts the refusal above the list, not below it', async () => {
    mockFetch({
      ...OVERVIEW_ROUTES,
      'PATCH /api/accounts/acc-1': () => fail(500, { error: 'the account is locked' }),
    });
    mount();
    expect(await screen.findByText('Sparkasse Giro')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Edit accounts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove account Sparkasse Giro' }));

    // a refusal read after the list is a refusal the reader has already acted on
    const refusal = await screen.findByText(/^Error:/);
    const following =
      refusal.compareDocumentPosition(screen.getByText('Sparkasse Giro')) &
      Node.DOCUMENT_POSITION_FOLLOWING;
    expect(following).toBeTruthy();
  });

  it('says nothing about being empty when every account is hidden', async () => {
    mockFetch({
      ...OVERVIEW_ROUTES,
      'GET /api/accounts': () => ok(ACCOUNTS.map((a) => ({ ...a, hidden: true }))),
    });
    mount();

    // the hidden line is true and already actionable; "No accounts yet" above it is not
    expect(await screen.findByText(/Hidden accounts: 2/)).toBeInTheDocument();
    expect(screen.queryByText(/No accounts yet/)).not.toBeInTheDocument();
  });

  it('does not claim the accounts are empty when the request for them failed', async () => {
    mockFetch({ ...OVERVIEW_ROUTES, 'GET /api/accounts': () => fail(500) });
    mount();

    // anchor: the refusal, which only exists once the request came back
    expect(await screen.findByText(/^Error:/)).toBeInTheDocument();
    // `accounts` was never loaded, so there is nothing to be empty. The screen used
    // to say "No accounts yet" here, over data it had never once seen.
    expect(screen.queryByText(/No accounts yet/)).not.toBeInTheDocument();
  });
});

describe('the app settings block', () => {
  const currency = () => screen.getByLabelText('Base currency') as HTMLInputElement;
  const owners = () => screen.getByLabelText('Owner names') as HTMLInputElement;

  /** The anchor: no field exists until GET /api/app-settings came back. */
  const settled = () => screen.findByLabelText('Base currency');

  it('shows the stored values, with accounts present', async () => {
    // the populated fixture on purpose: settings only reachable from the empty state
    // would be the wizard again, in a smaller box
    mockFetch(OVERVIEW_ROUTES);
    mount();
    await settled();

    expect(currency().value).toBe('EUR');
    expect(owners().value).toBe('Yurii Kalvenko');
    expect(screen.getByText('Sparkasse Giro')).toBeInTheDocument();
  });

  it('offers a retry when the settings could not be read, and takes it', async () => {
    let reads = 0;
    mockFetch({
      ...OVERVIEW_ROUTES,
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
    expect(owners().value).toBe('Yurii Kalvenko');
    expect(screen.queryByText(/^Error:/)).not.toBeInTheDocument();
  });

  it('shows the server\'s refusal instead of a success mark when the save is rejected', async () => {
    mockFetch({
      ...OVERVIEW_ROUTES,
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
    // the mirror of the two tests around it: without it they would both pass against
    // a block that never shows a success mark at all
    mockFetch({
      ...OVERVIEW_ROUTES,
      'PATCH /api/app-settings': () => ok({ baseCurrency: 'USD', ownerNames: ['Yurii Kalvenko'] }),
    });
    mount();
    await settled();

    fireEvent.change(currency(), { target: { value: 'usd' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('button', { name: 'Saved ✓' })).toBeInTheDocument();
    // re-rendered from the echoed body, not from what was typed
    expect(currency().value).toBe('USD');
    expect(screen.queryByText(/^Error:/)).not.toBeInTheDocument();
  });

  it('drops the previous save\'s mark when the next save fails', async () => {
    let saves = 0;
    mockFetch({
      ...OVERVIEW_ROUTES,
      'PATCH /api/app-settings': () => {
        saves += 1;
        return saves === 1
          ? ok({ baseCurrency: 'USD', ownerNames: ['Yurii Kalvenko'] })
          : fail(500, { error: 'the settings store is unreachable' });
      },
    });
    mount();
    await settled();

    fireEvent.change(currency(), { target: { value: 'usd' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('button', { name: 'Saved ✓' })).toBeInTheDocument();

    // the second save edits nothing, so justSaved is still true when it starts: a mark
    // that outlives the save it affirms reads as current
    fireEvent.click(screen.getByRole('button', { name: 'Saved ✓' }));

    expect(await screen.findByText(/store is unreachable/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Saved/ })).not.toBeInTheDocument();
  });

  it('refuses to call a 200 a save when the body came back with something else', async () => {
    // no route reaches this today - the endpoint answers 400 rather than ignoring a
    // field. It is the client half of the same rule, and it holds for the fields
    // this endpoint gains later.
    mockFetch({
      ...OVERVIEW_ROUTES,
      'PATCH /api/app-settings': () => ok({ baseCurrency: 'EUR', ownerNames: ['Yurii Kalvenko'] }),
    });
    mount();
    await settled();

    fireEvent.change(currency(), { target: { value: 'USD' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/^Error:/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Saved/ })).not.toBeInTheDocument();
    // and the field shows what was actually stored, not the rejected edit
    expect(currency().value).toBe('EUR');
  });
});

describe('backup link', () => {
  it('points at /api/backup and asks the browser to download it', async () => {
    mockFetch(OVERVIEW_ROUTES);
    mount();
    expect(await screen.findByText('Sparkasse Giro')).toBeInTheDocument();

    const link = screen.getByRole('link', { name: /Download backup/ });
    expect(link).toHaveAttribute('href', '/api/backup');
    expect(link).toHaveAttribute('download');
  });
});

describe('what item 13 deleted', () => {
  it('offers no sync controls', async () => {
    mockFetch(OVERVIEW_ROUTES);
    mount();
    // the anchor comes first on purpose: every assertion below passes for free on a
    // screen that never loaded, and on one that crashed
    expect(await screen.findByText('Sparkasse Giro')).toBeInTheDocument();

    expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Sync journal/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Data current as of/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Sync now/)).not.toBeInTheDocument();
  });
});
