import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ACCOUNTS, APP_SETTINGS } from '../test/fixtures';
import { fail, mockFetch, ok, renderThemed } from '../test/harness';
import { GoalsScreen } from './GoalsScreen';

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('GoalsScreen stale goal location', () => {
  it('returns a missing goal link to the list with an explicit notice', async () => {
    window.history.replaceState(null, '', '/?screen=goal&goal=missing');
    mockFetch({
      'GET /api/goals': () => ok({ goals: [] }),
      'GET /api/accounts': () => ok(ACCOUNTS),
      'GET /api/app-settings': () => ok(APP_SETTINGS),
      'GET /api/goals/missing': () => fail(404, { error: 'goal not found' }),
    });

    renderThemed(<GoalsScreen />);

    expect(await screen.findByRole('status')).toHaveTextContent(
      'That goal is no longer available.',
    );
    await waitFor(() => {
      expect(new URLSearchParams(window.location.search).get('goal')).toBeNull();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(screen.getByText('No goals yet.')).toBeVisible();
  });
});
