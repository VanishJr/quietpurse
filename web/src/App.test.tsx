import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { importsResponse, PRESETS } from './test/fixtures';
import { FIRST_PAINT_ROUTES, mockFetch, ok } from './test/harness';

/**
 * The shell: the five always-mounted screens and the navigation.
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
 * Its own helper for the timeout. The whole module graph - five screens and recharts -
 * is transformed the first time anything imports this file, and a cold run has been
 * measured landing within a few milliseconds of the 1000ms default. Nothing here is
 * waiting on the app.
 */
const appMounted = () => screen.findByRole('heading', { name: 'Overview' }, { timeout: 5_000 });

describe('the shell', () => {
  it('shows Overview and keeps the other four mounted but hidden', async () => {
    mockFetch(FIRST_PAINT_ROUTES);
    render(<App />);

    // anchor: Overview's own heading, so the app shell really painted
    expect(await appMounted()).toBeVisible();

    // `hidden: true` is required: getByRole excludes a [hidden] subtree from itself,
    // so without it these would throw - and queryByRole(...) === null would pass
    // just as well against a screen that was never mounted at all.
    // 'Settings' is in the list because a screen mounted but named by nothing is
    // asserted about by nothing, and the suite stays green while saying so.
    for (const title of ['Transactions', 'Analytics', 'Goals', 'Settings']) {
      expect(
        screen.getByRole('heading', { name: title, level: 1, hidden: true }),
      ).not.toBeVisible();
    }
  });

  it('asks for no session and offers no sign-in', async () => {
    mockFetch(FIRST_PAINT_ROUTES);
    render(<App />);
    expect(await appMounted()).toBeVisible();

    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign/i })).not.toBeInTheDocument();
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
    expect(screen.getByRole('heading', { name: 'Overview', hidden: true })).not.toBeVisible();
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

    expect(screen.getByRole('heading', { name: 'Overview' })).toBeVisible();
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

    expect(screen.getByRole('heading', { name: 'Overview' })).toBeVisible();
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
      await screen.findByRole('heading', { name: 'Goals' }, { timeout: 5_000 }),
    ).toBeVisible();
    expect(
      screen.getByRole('heading', { name: 'Overview', hidden: true }),
    ).not.toBeVisible();
  });

  it('opens on Overview for a URL naming a screen this app does not have', async () => {
    // an old link, or a typed one - `?screen=account` is one now. A blank window under
    // a bar with nothing marked on it is the one answer that helps nobody
    window.history.replaceState(null, '', '/?screen=account');
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
      expect(screen.getByRole('heading', { name: 'Overview' })).toBeVisible(),
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
    expect(screen.getByRole('heading', { name: 'Overview' })).toBeVisible();
  });

  it('puts Settings after Import in the Sections navigation and marks only the current link', async () => {
    mockFetch(FIRST_PAINT_ROUTES);
    render(<App />);
    expect(await appMounted()).toBeVisible();

    const tabs = within(screen.getByRole('navigation', { name: 'Sections' }));
    expect(tabs.getAllByRole('link').map((link) => link.textContent)).toEqual([
      'Overview', 'Transactions', 'Analytics', 'Goals', 'Import', 'Settings',
    ]);
    const settings = tabs.getByRole('link', { name: 'Settings' });
    expect(settings).not.toHaveAttribute('aria-current');

    fireEvent.click(settings);

    expect(window.location.search).toBe('?screen=settings');
    expect(settings).toHaveAttribute('aria-current', 'page');
    expect(tabs.getAllByRole('link').filter((link) => link.hasAttribute('aria-current'))).toEqual([
      settings,
    ]);
    expect(screen.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Overview', hidden: true })).not.toBeVisible();

    fireEvent.click(tabs.getByRole('link', { name: 'Goals' }));
    expect(settings).not.toHaveAttribute('aria-current');
    expect(tabs.getByRole('link', { name: 'Goals' })).toHaveAttribute('aria-current', 'page');
  });

  it('opens Settings from its URL and keeps Import available from Settings', async () => {
    window.history.replaceState(null, '', '/?screen=settings');
    mockFetch({ ...FIRST_PAINT_ROUTES, 'GET /api/imports/presets': () => ok(PRESETS) });
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    const tabs = within(screen.getByRole('navigation', { name: 'Sections' }));
    expect(tabs.getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
    fireEvent.click(screen.getByRole('button', { name: /Import a statement/ }));
    expect(await screen.findByRole('heading', { name: 'Import a statement' })).toBeVisible();
    expect(window.location.search).toBe('?screen=overview&panel=import');
    expect(tabs.getByRole('link', { name: 'Import' })).toHaveAttribute('aria-current', 'page');
    expect(tabs.getByRole('link', { name: 'Settings' })).not.toHaveAttribute('aria-current');
  });

  it('closes Settings history on Back and when navigating away from Settings', async () => {
    mockFetch({ ...FIRST_PAINT_ROUTES, 'GET /api/imports': () => ok(importsResponse([])) });
    render(<App />);
    expect(await appMounted()).toBeVisible();

    const tabs = within(screen.getByRole('navigation', { name: 'Sections' }));
    fireEvent.click(tabs.getByRole('link', { name: 'Settings' }));
    fireEvent.click(screen.getByRole('button', { name: /^Import history/ }));
    expect(screen.getByRole('heading', { name: 'Import history' })).toBeVisible();
    expect(window.location.search).toBe('?screen=settings&panel=history');

    act(() => window.history.back());
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Data & backup' })).toBeVisible());
    expect(screen.queryByRole('heading', { name: 'Import history' })).not.toBeInTheDocument();
    expect(window.location.search).toBe('?screen=settings');

    fireEvent.click(screen.getByRole('button', { name: /^Import history/ }));
    fireEvent.click(tabs.getByRole('link', { name: 'Transactions' }));
    expect(window.location.search).toBe('?screen=transactions');
    fireEvent.click(tabs.getByRole('link', { name: 'Settings' }));
    expect(screen.getByRole('heading', { name: 'Data & backup' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Import history' })).not.toBeInTheDocument();
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
    expect(tabs.getByRole('link', { name: 'Settings' })).toHaveAttribute(
      'href',
      '/?screen=settings',
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

    // Observe whether React cancelled the event before preventing jsdom's own navigation.
    const prevented: boolean[] = [];
    const catcher = (e: Event) => {
      prevented.push(e.defaultPrevented);
      e.preventDefault();
    };
    document.addEventListener('click', catcher);
    try {
      fireEvent.click(tabs.getByRole('link', { name: 'Transactions' }), { metaKey: true });
      fireEvent.click(tabs.getByRole('link', { name: 'Settings' }), { ctrlKey: true });
      fireEvent.click(tabs.getByRole('link', { name: 'Settings' }), { button: 1 });
    } finally {
      document.removeEventListener('click', catcher);
    }

    expect(prevented).toEqual([false, false, false]);
    expect(window.location.search).toBe('');
    expect(screen.getByRole('heading', { name: 'Overview' })).toBeVisible();
    expect(tabs.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
  });

  it('offers a way past the navigation controls', async () => {
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

  it('selects one named theme at a time, remembers each choice, and shows the device status once', async () => {
    mockFetch(FIRST_PAINT_ROUTES);
    let view = render(<App />);
    expect(await appMounted()).toBeVisible();

    const group = () => within(screen.getByRole('group', { name: 'Theme' }));
    const selected = (name: string) =>
      group().getByRole('button', { name: `${name} theme, selected` });
    const choices = () => group().getAllByRole('button');
    expect(choices()).toHaveLength(3);
    expect(selected('Dark')).toHaveAttribute('aria-pressed', 'true');
    expect(choices().filter((button) => button.getAttribute('aria-pressed') === 'true')).toEqual([
      selected('Dark'),
    ]);
    expect(screen.getAllByText('Stored on this device')).toHaveLength(1);

    for (const name of ['System', 'Light', 'Dark'] as const) {
      fireEvent.click(group().getByRole('button', { name: `${name} theme` }));
      expect(selected(name)).toHaveAttribute('aria-pressed', 'true');
      expect(choices().filter((button) => button.getAttribute('aria-pressed') === 'true')).toEqual([
        selected(name),
      ]);
      expect(localStorage.getItem('finto.theme')).toBe(name.toLowerCase());
      view.unmount();
      view = render(<App />);
      expect(await appMounted()).toBeVisible();
      expect(selected(name)).toHaveAttribute('aria-pressed', 'true');
    }
  });

  it('follows OS changes in System mode, but holds a chosen palette in Light mode', async () => {
    const original = window.matchMedia;
    let onChange: ((event: MediaQueryListEvent) => void) | undefined;
    window.matchMedia = vi.fn((query: string) => ({
      matches: false,
      media: query,
      addEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => { onChange = listener; },
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    try {
      mockFetch(FIRST_PAINT_ROUTES);
      render(<App />);
      expect(await appMounted()).toBeVisible();
      const group = within(screen.getByRole('group', { name: 'Theme' }));
      fireEvent.click(group.getByRole('button', { name: 'System theme' }));
      expect(document.documentElement.dataset.theme).toBe('light');

      act(() => onChange?.({ matches: true } as MediaQueryListEvent));
      expect(document.documentElement.dataset.theme).toBe('dark');

      fireEvent.click(group.getByRole('button', { name: 'Light theme' }));
      act(() => onChange?.({ matches: false } as MediaQueryListEvent));
      act(() => onChange?.({ matches: true } as MediaQueryListEvent));
      expect(document.documentElement.dataset.theme).toBe('light');

      fireEvent.click(group.getByRole('button', { name: 'System theme' }));
      expect(document.documentElement.dataset.theme).toBe('dark');
    } finally {
      window.matchMedia = original;
    }
  });

  it('opens on a previously saved theme', async () => {
    localStorage.setItem('finto.theme', 'light');
    mockFetch(FIRST_PAINT_ROUTES);
    render(<App />);
    expect(await appMounted()).toBeVisible();

    expect(screen.getByRole('button', { name: 'Light theme, selected' })).toHaveAttribute(
      'aria-pressed', 'true',
    );
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});
