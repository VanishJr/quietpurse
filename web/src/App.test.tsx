import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { PRESETS, USER } from './test/fixtures';
import { fail, FIRST_PAINT_ROUTES, mockFetch, ok, requests, SIGNED_OUT_ROUTES } from './test/harness';

/**
 * The shell: the session gate, the five always-mounted screens, and the navigation.
 *
 * The navigation is one element in two shapes - the design's top bar on a wide window,
 * the bottom bar of the phone app on a narrow one - and which of the two is painted is
 * a media query. Nothing here can tell them apart, and nothing here should: what this
 * file is about is that the five screens are reachable, which is the same fact in both.
 *
 * jsdom applies no stylesheet, so the `hidden` attribute is the only visibility fact
 * available here - nothing below may depend on styles.css.
 */

/**
 * The budget every test in this file gets, and it is here rather than in the config
 * because it exists for `appMounted` below - the two are a pair and neither is worth
 * reading without the other.
 *
 * A wait of 5s under vitest's own 5s `testTimeout` can never reach its own limit: the
 * test is killed first, and what the run reports is a timeout of the test rather than
 * of the thing it was waiting on. That is what a cold run did here - 6.2s against the
 * 5s default, on the one test that happened to mount the app first - while the same
 * file warm, or run alone, passed. So the budget has to clear the wait plus whatever
 * the test does after it, and this is the only file that waits anywhere near that long.
 */
vi.setConfig({ testTimeout: 15_000 });

/**
 * The Overview's heading, and the anchor for "the app shell really painted".
 *
 * Its own helper for the timeout. `SignedIn` is behind `lazy()`, so this wait includes
 * vitest transforming that whole module graph the first time any test asks for it —
 * and it is a graph with five screens and recharts in it. On a cold run that landed
 * within a few milliseconds of the 1000ms default, which fails the test on the
 * transform rather than on anything the test is about. Nothing here is waiting on the
 * app.
 */
const appMounted = () =>
  screen.findByRole('heading', { name: /^Welcome,/ }, { timeout: 5_000 });

describe('signed out', () => {
  it('shows the sign-in form and nothing of the app', async () => {
    mockFetch(SIGNED_OUT_ROUTES);
    render(<App />);

    // anchor: the sign-in screen, which renders only once the session came back null
    expect(await screen.findByRole('heading', { name: 'Welcome Back!' })).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();

    expect(screen.queryByRole('navigation', { name: 'Sections' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: /^Welcome,/, hidden: true }),
    ).not.toBeInTheDocument();
  });
});

describe('signed in', () => {
  it('shows Overview and keeps the other four mounted but hidden', async () => {
    mockFetch(FIRST_PAINT_ROUTES);
    render(<App />);

    // anchor: Overview's own heading, so the app shell really painted
    expect(await appMounted()).toBeVisible();

    // `hidden: true` is required: getByRole excludes a [hidden] subtree from itself,
    // so without it these would throw - and queryByRole(...) === null would pass
    // just as well against a screen that was never mounted at all.
    // 'Your account' is in the list because a screen mounted but named by nothing is
    // asserted about by nothing, and the suite stays green while saying so
    for (const title of ['Transactions', 'Analytics', 'Goal', 'Your account']) {
      expect(screen.getByRole('heading', { name: title, hidden: true })).not.toBeVisible();
    }
  });

  it('moves aria-current and visibility when a tab is clicked', async () => {
    mockFetch(FIRST_PAINT_ROUTES);
    render(<App />);
    expect(await appMounted()).toBeVisible();

    // within the tab bar, so the Transactions *button* is not the Transactions *heading*
    const tabs = within(screen.getByRole('navigation', { name: 'Sections' }));
    expect(tabs.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');

    fireEvent.click(tabs.getByRole('link', { name: 'Transactions' }));

    expect(tabs.getByRole('link', { name: 'Transactions' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(tabs.getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('heading', { name: 'Transactions' })).toBeVisible();
    expect(screen.getByRole('heading', { name: /^Welcome,/, hidden: true })).not.toBeVisible();
  });

  it('marks Import as the page while the import panel is the window', async () => {
    // Import is a section in the bar and a panel of the Overview, and `tab` alone knows
    // only the second half of that: the bar marked Overview as the current page while a
    // full window of Import sat under it. Where the page lives is the app's business.
    mockFetch({ ...FIRST_PAINT_ROUTES, 'GET /api/imports/presets': () => ok(PRESETS) });
    render(<App />);
    expect(await appMounted()).toBeVisible();

    const tabs = within(screen.getByRole('navigation', { name: 'Sections' }));
    fireEvent.click(tabs.getByRole('link', { name: 'Import' }));

    expect(await screen.findByRole('heading', { name: 'Import a statement' })).toBeVisible();
    expect(tabs.getByRole('link', { name: 'Import' })).toHaveAttribute('aria-current', 'page');
    expect(tabs.getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');

    // and it hands the mark back on the way out, rather than leaving two of them
    fireEvent.click(screen.getByRole('button', { name: '← Back to accounts' }));

    expect(tabs.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
    expect(tabs.getByRole('link', { name: 'Import' })).not.toHaveAttribute('aria-current');
  });

  it('leaves Import by the bar, and not only by the panel’s own way out', async () => {
    // Import opens a panel OF the Overview, so the bar's Overview was already on the
    // right tab and setting it again did nothing: every click on Overview looked like
    // it bounced straight back to Import, and the only way out was the panel's Back
    mockFetch({ ...FIRST_PAINT_ROUTES, 'GET /api/imports/presets': () => ok(PRESETS) });
    render(<App />);
    expect(await appMounted()).toBeVisible();

    const tabs = within(screen.getByRole('navigation', { name: 'Sections' }));
    fireEvent.click(tabs.getByRole('link', { name: 'Import' }));
    expect(await screen.findByRole('heading', { name: 'Import a statement' })).toBeVisible();

    fireEvent.click(tabs.getByRole('link', { name: 'Overview' }));

    expect(screen.getByRole('heading', { name: /^Welcome,/ })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Import a statement' })).not.toBeInTheDocument();
    expect(tabs.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
  });

  it('does not answer with a panel the reader walked away from', async () => {
    // the screens stay mounted, so a panel left open is still open when the reader
    // comes back — and what they asked for by clicking Overview is the dashboard
    mockFetch({ ...FIRST_PAINT_ROUTES, 'GET /api/imports/presets': () => ok(PRESETS) });
    render(<App />);
    expect(await appMounted()).toBeVisible();

    const tabs = within(screen.getByRole('navigation', { name: 'Sections' }));
    fireEvent.click(tabs.getByRole('link', { name: 'Import' }));
    expect(await screen.findByRole('heading', { name: 'Import a statement' })).toBeVisible();

    fireEvent.click(tabs.getByRole('link', { name: 'Transactions' }));
    fireEvent.click(tabs.getByRole('link', { name: 'Overview' }));

    expect(screen.getByRole('heading', { name: /^Welcome,/ })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Import a statement' })).not.toBeInTheDocument();
  });

  it('writes no history entry for a click on the section already showing', async () => {
    // the app opens on `/`, where Overview is current without being named — so this
    // click has a URL it could legally write, and writing it would put an entry under
    // Back that paints the identical window. A Back that visibly does nothing is the
    // bug this whole parameter exists to fix, not one to introduce on the way.
    mockFetch(FIRST_PAINT_ROUTES);
    render(<App />);
    expect(await appMounted()).toBeVisible();

    const before = window.history.length;
    const tabs = within(screen.getByRole('navigation', { name: 'Sections' }));
    fireEvent.click(tabs.getByRole('link', { name: 'Overview' }));

    expect(window.history.length).toBe(before);
    expect(window.location.search).toBe('');
    expect(tabs.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
  });

  it('names the screen in the URL, so it can be linked and reloaded', async () => {
    mockFetch(FIRST_PAINT_ROUTES);
    render(<App />);
    expect(await appMounted()).toBeVisible();

    const tabs = within(screen.getByRole('navigation', { name: 'Sections' }));
    fireEvent.click(tabs.getByRole('link', { name: 'Analytics' }));

    expect(new URLSearchParams(window.location.search).get('screen')).toBe('analytics');
  });

  it('opens on the screen the URL names rather than always on Overview', async () => {
    // the other half of the same fact: a URL this app writes is a URL it can be given
    window.history.replaceState(null, '', '/?screen=goal');
    mockFetch(FIRST_PAINT_ROUTES);
    render(<App />);

    expect(
      await screen.findByRole('heading', { name: 'Goal' }, { timeout: 5_000 }),
    ).toBeVisible();
    expect(
      screen.getByRole('heading', { name: /^Welcome,/, hidden: true }),
    ).not.toBeVisible();
  });

  it('opens on Overview for a URL naming a screen this app does not have', async () => {
    // an old link, or a typed one. A blank window under a bar with nothing marked on
    // it is the one answer that helps nobody
    window.history.replaceState(null, '', '/?screen=nonesuch');
    mockFetch(FIRST_PAINT_ROUTES);
    render(<App />);

    expect(await appMounted()).toBeVisible();
  });

  it('answers the Back button, which nothing in the app used to answer', async () => {
    mockFetch(FIRST_PAINT_ROUTES);
    render(<App />);
    expect(await appMounted()).toBeVisible();

    const tabs = within(screen.getByRole('navigation', { name: 'Sections' }));
    fireEvent.click(tabs.getByRole('link', { name: 'Transactions' }));
    expect(screen.getByRole('heading', { name: 'Transactions' })).toBeVisible();

    act(() => window.history.back());

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /^Welcome,/ })).toBeVisible(),
    );
    expect(tabs.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
    expect(tabs.getByRole('link', { name: 'Transactions' })).not.toHaveAttribute('aria-current');
  });

  it('leaves the import panel on Back rather than only by its own way out', async () => {
    // Import is a panel of the Overview, so it is the one destination in the bar whose
    // Back is not a screen change at all — and it is the one a reader is most likely to
    // press, having opened a full-window page they did not mean to
    mockFetch({ ...FIRST_PAINT_ROUTES, 'GET /api/imports/presets': () => ok(PRESETS) });
    render(<App />);
    expect(await appMounted()).toBeVisible();

    const tabs = within(screen.getByRole('navigation', { name: 'Sections' }));
    fireEvent.click(tabs.getByRole('link', { name: 'Import' }));
    expect(await screen.findByRole('heading', { name: 'Import a statement' })).toBeVisible();

    act(() => window.history.back());

    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Import a statement' })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('heading', { name: /^Welcome,/ })).toBeVisible();
  });

  it('reaches the Account screen through the avatar, which is not in the list', async () => {
    // it is the sixth destination and the only one the section list does not carry:
    // the design puts identity at the right of the bar, which is what freed the fifth
    // slot for Import
    mockFetch(FIRST_PAINT_ROUTES);
    render(<App />);
    expect(await appMounted()).toBeVisible();

    const tabs = within(screen.getByRole('navigation', { name: 'Sections' }));
    expect(tabs.queryByRole('link', { name: 'Account' })).not.toBeInTheDocument();
    expect(tabs.getByRole('link', { name: 'Import' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: `Account: ${USER.email}` }));

    expect(screen.getByRole('heading', { name: 'Your account' })).toBeVisible();
    expect(screen.getByRole('heading', { name: /^Welcome,/, hidden: true })).not.toBeVisible();
  });

  it('carries the URL of each destination on the destination itself', async () => {
    // every section was a `<button onClick>`, which is a control that HAPPENS to change
    // the page and that no browser can find that out about: Cmd-click, middle click,
    // "Open in a new tab" and "Copy link address" were all missing from the one element
    // whose entire job is going somewhere. The href is built by the same `urlFor` the
    // click writes through, so what the status bar promises is what a click delivers.
    mockFetch(FIRST_PAINT_ROUTES);
    render(<App />);
    expect(await appMounted()).toBeVisible();

    const tabs = within(screen.getByRole('navigation', { name: 'Sections' }));
    expect(tabs.getByRole('link', { name: 'Analytics' })).toHaveAttribute(
      'href',
      '/?screen=analytics',
    );
    // Import is a panel OF the Overview, and that is a URL like any other
    expect(tabs.getByRole('link', { name: 'Import' })).toHaveAttribute(
      'href',
      '/?screen=overview&panel=import',
    );
    expect(screen.getByRole('link', { name: `Account: ${USER.email}` })).toHaveAttribute(
      'href',
      '/?screen=account',
    );
  });

  it('hands a modified click back to the browser instead of answering it', async () => {
    // Cmd/Ctrl-click is "open this somewhere else", and the browser is the only thing
    // that can do it. Answering it here would move THIS window — the one outcome a
    // reader holding a modifier explicitly did not ask for — and the new tab would
    // never open.
    mockFetch(FIRST_PAINT_ROUTES);
    render(<App />);
    expect(await appMounted()).toBeVisible();

    const tabs = within(screen.getByRole('navigation', { name: 'Sections' }));

    // The default action left standing IS the assertion, and jsdom answers a real one
    // by logging that it does not implement navigation. So it is caught at the document,
    // above everything React listens on: what the app did or did not do to the event has
    // already happened by the time this runs, and the run stays quiet.
    const catcher = (e: Event) => e.preventDefault();
    document.addEventListener('click', catcher);
    try {
      fireEvent.click(tabs.getByRole('link', { name: 'Transactions' }), { metaKey: true });
    } finally {
      document.removeEventListener('click', catcher);
    }

    // this window did not move, which is the only thing the app was asked not to do
    expect(window.location.search).toBe('');
    expect(screen.getByRole('heading', { name: /^Welcome,/ })).toBeVisible();
    expect(tabs.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
  });

  it('offers a way past the bar, which is seven controls deep', async () => {
    // the landing page has had one since it was written; the app, which is the side
    // people come back to daily, had not
    mockFetch(FIRST_PAINT_ROUTES);
    render(<App />);
    expect(await appMounted()).toBeVisible();

    const skip = screen.getByRole('link', { name: 'Skip to the content' });
    // first, or it is a link somebody has to tab through the bar to reach
    expect(screen.getAllByRole('link')[0]).toBe(skip);
    // ...and pointing at something that is really there: a skip link to a missing id is
    // a keystroke that does nothing, and nothing says so
    expect(skip).toHaveAttribute('href', '#screens');
    expect(document.getElementById('screens')).toBe(screen.getByRole('main'));
  });

  it('carries the theme control, which every screen is now reached under', async () => {
    mockFetch(FIRST_PAINT_ROUTES);
    render(<App />);
    expect(await appMounted()).toBeVisible();

    // it names the theme it is on, because a single glyph is not a state anybody can
    // read; clicking it moves to the next of the three
    const button = screen.getByRole('button', { name: 'Theme: Auto. Click to change' });
    fireEvent.click(button);

    expect(
      screen.getByRole('button', { name: 'Theme: Light. Click to change' }),
    ).toBeInTheDocument();
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
    expect(await screen.findByRole('heading', { name: 'Welcome Back!' })).toBeInTheDocument();
    // the anchor alone is satisfied by an app that never signed in, which would make
    // the assertion below true for the trivial reason: pin the request that 401'd
    expect(requests()).toContain('GET /api/accounts');
    expect(screen.queryByRole('navigation', { name: 'Sections' })).not.toBeInTheDocument();
  });
});

describe('the server is unreachable', () => {
  const dead = (): never => {
    throw new TypeError('Failed to fetch');
  };

  // SIGNED_OUT_ROUTES is spread into both tables although /api/health is never
  // requested while AuthScreen does not mount: a regression that renders it then
  // fails on the password assertion below, not on the unstubbed-request guard.

  it('says so, and offers no password field', async () => {
    mockFetch({ ...SIGNED_OUT_ROUTES, 'GET /api/auth/get-session': dead });
    render(<App />);

    expect(
      await screen.findByRole('heading', { name: 'Cannot reach the server' }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    // without this the assertions above also pass against an app that never asked
    expect(requests()).toContain('GET /api/auth/get-session');
  });

  it('reaches the app when Retry finds the server back', async () => {
    let down = true;
    mockFetch({
      ...SIGNED_OUT_ROUTES,
      ...FIRST_PAINT_ROUTES,
      'GET /api/auth/get-session': () => {
        if (!down) return ok({ user: USER });
        down = false;
        return dead();
      },
    });
    render(<App />);

    expect(
      await screen.findByRole('heading', { name: 'Cannot reach the server' }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await appMounted()).toBeVisible();
  });

  it('keeps the screen and the Retry when the retry fails again', async () => {
    mockFetch({ ...SIGNED_OUT_ROUTES, 'GET /api/auth/get-session': dead });
    render(<App />);

    expect(
      await screen.findByRole('heading', { name: 'Cannot reach the server' }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    // synchronous on purpose: the answer is still in flight here, and this is the
    // only moment the screen can blank. Awaiting first passes against the version
    // that blanks it, because by then the second failure has painted it back.
    expect(screen.getByRole('heading', { name: 'Cannot reach the server' })).toBeInTheDocument();

    await waitFor(() =>
      expect(requests().filter((r) => r === 'GET /api/auth/get-session')).toHaveLength(2),
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });
});
