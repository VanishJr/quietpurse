import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';
import { fail, FIRST_PAINT_ROUTES, mockFetch, requests, SIGNED_OUT_ROUTES } from './test/harness';

/**
 * The shell: the session gate, the four always-mounted screens, and the tab bar.
 *
 * jsdom applies no stylesheet, so the `hidden` attribute is the only visibility fact
 * available here - nothing below may depend on styles.css.
 */

describe('signed out', () => {
  it('shows the sign-in form and nothing of the app', async () => {
    mockFetch(SIGNED_OUT_ROUTES);
    render(<App />);

    // anchor: the sign-in screen, which renders only once the session came back null
    expect(await screen.findByRole('heading', { name: 'Finto' })).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();

    expect(screen.queryByRole('navigation', { name: 'Sections' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Accounts', hidden: true }),
    ).not.toBeInTheDocument();
  });
});

describe('signed in', () => {
  it('shows Overview and keeps the other three mounted but hidden', async () => {
    mockFetch(FIRST_PAINT_ROUTES);
    render(<App />);

    // anchor: Overview's own heading, so the app shell really painted
    expect(await screen.findByRole('heading', { name: 'Accounts' })).toBeVisible();

    // `hidden: true` is required: getByRole excludes a [hidden] subtree from itself,
    // so without it these would throw - and queryByRole(...) === null would pass
    // just as well against a screen that was never mounted at all.
    for (const title of ['Transactions', 'Analytics', 'Goal']) {
      expect(screen.getByRole('heading', { name: title, hidden: true })).not.toBeVisible();
    }
  });

  it('moves aria-current and visibility when a tab is clicked', async () => {
    mockFetch(FIRST_PAINT_ROUTES);
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Accounts' })).toBeVisible();

    // within the tab bar, so the Transactions *button* is not the Transactions *heading*
    const tabs = within(screen.getByRole('navigation', { name: 'Sections' }));
    expect(tabs.getByRole('button', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');

    fireEvent.click(tabs.getByRole('button', { name: 'Transactions' }));

    expect(tabs.getByRole('button', { name: 'Transactions' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(tabs.getByRole('button', { name: 'Overview' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('heading', { name: 'Transactions' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Accounts', hidden: true })).not.toBeVisible();
  });

  it('drops back to the sign-in form when a mount request comes back 401', async () => {
    // the union of both tables, signed-in first paint winning the session: the way
    // back out lands on AuthScreen, which asks /api/health for the signup mode
    mockFetch({
      ...SIGNED_OUT_ROUTES,
      ...FIRST_PAINT_ROUTES,
      'GET /api/accounts': () => fail(401),
    });
    render(<App />);

    // anchor: the sign-in screen, reached only by way of onUnauthorized
    expect(await screen.findByRole('heading', { name: 'Finto' })).toBeInTheDocument();
    // the anchor alone is satisfied by an app that never signed in, which would make
    // the assertion below true for the trivial reason: pin the request that 401'd
    expect(requests()).toContain('GET /api/accounts');
    expect(screen.queryByRole('navigation', { name: 'Sections' })).not.toBeInTheDocument();
  });
});
