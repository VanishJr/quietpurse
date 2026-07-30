import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ACCOUNTS, RECURRING, USER } from '../test/fixtures';
import { mockFetch, ok, renderThemed } from '../test/harness';
import { OverviewScreen } from './OverviewScreen';

/**
 * Item 13's manual checks 1 and 2, minus what jsdom cannot see: whether the backup
 * link lands a file on disk is a browser question and stays manual.
 */

const OVERVIEW_ROUTES = {
  'GET /api/accounts': () => ok(ACCOUNTS),
  'GET /api/recurring': () => ok(RECURRING),
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

  it('renders the empty state when there are no accounts', async () => {
    mockFetch({ ...OVERVIEW_ROUTES, 'GET /api/accounts': () => ok([]) });
    mount();

    // a substring on purpose: ROADMAP row 14 rewrites the rest of this sentence
    expect(await screen.findByText(/No accounts yet/)).toBeInTheDocument();
    // OverviewScreen.tsx:160 gates the empty state on `visible.length === 0 && !loading`,
    // which a failed load also satisfies: without this the test passes on a 500
    expect(screen.queryByText(/^Error:/)).not.toBeInTheDocument();
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
