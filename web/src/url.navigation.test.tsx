import { useEffect, useRef, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerNavigationGuard, setUrl, urlFor, useUrl } from './url';
import type { AppUrl } from './url';
import { GoalsScreen } from './screens/GoalsScreen';
import { App } from './App';
import { ACCOUNTS, APP_SETTINGS, SAVINGS_GOAL, SUMMARY } from './test/fixtures';
import { FIRST_PAINT_ROUTES, mockFetch, ok, renderThemed, requests } from './test/harness';

type Entry = { url: string; state: unknown };
let entries: Entry[];
let index: number;
let queued: (() => void)[];
let snapshot: AppUrl;
const nativeReplace = window.history.replaceState.bind(window.history);

function flushOne(): void {
  queued.shift()?.();
}

function flush(): void {
  let remaining = 30;
  while (queued.length && remaining-- > 0) flushOne();
  expect(queued).toHaveLength(0);
}

beforeEach(() => {
  entries = [{ url: '/', state: null }];
  index = 0;
  queued = [];
  vi.spyOn(window.history, 'pushState').mockImplementation((state, _title, url) => {
    const entry = { url: String(url), state: structuredClone(state) };
    entries.splice(index + 1, entries.length, entry);
    index++;
    nativeReplace(entry.state, '', entry.url);
  });
  vi.spyOn(window.history, 'replaceState').mockImplementation((state, _title, url) => {
    entries[index] = { url: String(url), state: structuredClone(state) };
    nativeReplace(entries[index].state, '', entries[index].url);
  });
  vi.spyOn(window.history, 'go').mockImplementation((delta = 0) => {
    queued.push(() => {
      const next = index + delta;
      if (next < 0 || next >= entries.length || next === index) return;
      const oldURL = window.location.href;
      index = next;
      nativeReplace(structuredClone(entries[index].state), '', entries[index].url);
      const newURL = window.location.href;
      window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
      if (new URL(oldURL).hash !== new URL(newURL).hash) {
        window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL }));
      }
    });
  });
});

afterEach(() => {
  cleanup();
  flush();
  vi.restoreAllMocks();
});

function GoalDraft() {
  const url = useUrl();
  const [draft, setDraft] = useState('');
  useEffect(() => { setDraft(''); }, [url.goal]);
  return <input aria-label="Goal draft" value={draft} onChange={(event) => setDraft(event.target.value)} />;
}

function Reader() {
  const url = useUrl();
  return <output data-testid="other-reader">{url.screen}:{url.goal}</output>;
}

function NavigationHarness() {
  const url = useUrl();
  snapshot = url;
  const dirty = useRef(false);
  const proceed = useRef<(() => void) | null>(null);
  const [guardOpen, setGuardOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => registerNavigationGuard((next) => {
    if (!dirty.current) return false;
    proceed.current = next;
    setGuardOpen(true);
    return true;
  }), []);
  return <>
    <div hidden={url.screen !== 'goal'} onChange={() => { dirty.current = true; }}>
      <GoalDraft />
    </div>
    <Reader />
    <span data-testid="revision">{revision}</span>
    <button onClick={() => setRevision((value) => value + 1)}>Unrelated render</button>
    <a href={urlFor({ screen: 'analytics', goal: null })} onClick={(event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      setUrl({ screen: 'analytics', goal: null });
    }}>Analytics</a>
    {guardOpen && <div role="dialog" aria-label="Unsaved changes">
      <button onClick={() => { proceed.current = null; setGuardOpen(false); }}>Keep editing</button>
      <button onClick={() => {
        dirty.current = false;
        setGuardOpen(false);
        proceed.current?.();
        proceed.current = null;
      }}>Discard changes</button>
    </div>}
  </>;
}

function managedHistory(): void {
  window.history.replaceState({ foreign: 'kept' }, '', '/app/?ref=mail&screen=overview#top');
  setUrl({ screen: 'transactions' });
  setUrl({ screen: 'goal', goal: 'g1' });
}

function dirtyDraft(): void {
  fireEvent.change(screen.getByRole('textbox', { name: 'Goal draft' }), { target: { value: 'Unsaved goal' } });
}

function expectDraftRetained(original: AppUrl): void {
  fireEvent.click(screen.getByRole('button', { name: 'Unrelated render' }));
  expect(snapshot).toBe(original);
  expect(screen.getByRole('textbox', { name: 'Goal draft' })).toHaveValue('Unsaved goal');
  expect(screen.getByTestId('other-reader')).toHaveTextContent('goal:g1');
}

describe('published navigation snapshot', () => {
  it.each([{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }])(
    'updates real Shell destinations before a modified/native click after hash-only navigation (%j)', async (modifiers) => {
      window.history.replaceState({ foreign: 'state-kept' }, '', '/?screen=overview&foreign=kept#before');
      mockFetch(FIRST_PAINT_ROUTES);
      render(<App />);
      await screen.findByRole('heading', { name: 'Overview', level: 1 });
      const link = screen.getByRole('navigation', { name: 'Sections' }).querySelector<HTMLAnchorElement>('a[href*="screen=transactions"]')!;
      expect(link).toHaveAttribute('href', '/?screen=transactions&foreign=kept#before');
      const oldURL = window.location.href;
      act(() => {
        window.history.pushState(null, '', '/?screen=overview&foreign=kept#screens');
        window.dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: window.location.href }));
      });
      expect(link).toHaveAttribute('href', '/?screen=transactions&foreign=kept#screens');
      const currentURL = window.location.href;
      const push = vi.mocked(window.history.pushState).mockClear();
      const suppressBrowser = (event: Event) => {
        expect(event.defaultPrevented).toBe(false);
        expect(link.href).toBe(`${window.location.origin}/?screen=transactions&foreign=kept#screens`);
        event.preventDefault();
      };
      document.addEventListener('click', suppressBrowser, { once: true });
      act(() => { link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...modifiers })); });
      expect(push).not.toHaveBeenCalled();
      expect(window.location.href).toBe(currentURL);
      expect(screen.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
    },
  );

  it.each([
    ['hash', '/?screen=overview&foreign=kept#screens', '/?screen=settings&foreign=kept#screens'],
    ['path', '/other/?screen=overview&foreign=kept#old', '/other/?screen=settings&foreign=kept#old'],
  ])('refreshes the rendered Settings destination after %s-only popstate', async (_change, destination, expectedHref) => {
    window.history.replaceState(null, '', '/?screen=overview&foreign=kept#old');
    mockFetch(FIRST_PAINT_ROUTES);
    render(<App />);
    await screen.findByRole('heading', { name: 'Overview', level: 1 });
    const link = screen.getByRole('navigation', { name: 'Sections' }).querySelector<HTMLAnchorElement>('a[href*="screen=settings"]')!;
    expect(link).toHaveAttribute('href', '/?screen=settings&foreign=kept#old');
    act(() => {
      window.history.pushState(null, '', destination);
      window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
    });
    expect(link).toHaveAttribute('href', expectedHref);
    const push = vi.mocked(window.history.pushState).mockClear();
    const preserveNativeClick = (event: Event) => {
      expect(event.defaultPrevented).toBe(false);
      expect(link.href).toBe(`${window.location.origin}${expectedHref}`);
      event.preventDefault();
    };
    document.addEventListener('click', preserveNativeClick, { once: true });
    act(() => { link.dispatchEvent(new MouseEvent('click', { button: 1, bubbles: true, cancelable: true })); });
    expect(push).not.toHaveBeenCalled();
    expect(window.location.pathname + window.location.search + window.location.hash).toBe(destination);
  });

  it.each([false, true])('keeps a committed goal read-only and defers its close at an unknown history entry (Back while saving: %s)', async (backWhileSaving) => {
    window.history.replaceState({ older: 'kept' }, '', '/?screen=settings&foreign=older#old');
    window.history.pushState({ direct: 'kept' }, '', '/?screen=goal&goal=new&ref=draft#draft');
    const saved = { ...SAVINGS_GOAL, id: 'saved-income', type: 'monthly-income' as const,
      name: 'Income target', target: 3000, incomeScope: 'own' as const, windowMonths: 6 };
    let created = false;
    let resolveWrite!: (response: Response) => void;
    const write = new Promise<Response>((resolve) => { resolveWrite = resolve; });
    mockFetch({
      'GET /api/goals': () => ok({ goals: created ? [saved] : [] }),
      'GET /api/accounts': () => ok(ACCOUNTS),
      'GET /api/app-settings': () => ok(APP_SETTINGS),
      'POST /api/goals': () => { created = true; return backWhileSaving ? write : ok(saved); },
    });
    renderThemed(<div className="screen"><GoalsScreen /></div>);
    fireEvent.click(await screen.findByRole('button', { name: /^Monthly income/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Income target' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Monthly target (EUR)' }), { target: { value: '3000' } });
    const before = structuredClone(entries);
    const push = vi.mocked(window.history.pushState).mockClear();
    const replace = vi.mocked(window.history.replaceState).mockClear();
    if (backWhileSaving) fireEvent.click(screen.getByRole('button', { name: 'Create goal' }));
    act(() => { window.history.go(-1); flush(); });
    if (!backWhileSaving) {
      fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
      expect(screen.getByText(/can't tell where this view is in the browser history/)).toBeVisible();
      fireEvent.click(screen.getByRole('button', { name: 'Create goal' }));
    } else await act(async () => { resolveWrite(ok(saved)); });
    await screen.findByRole('heading', { name: 'Goal saved' });
    expect(screen.getByText(/address bar will update when you go back/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Create goal' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(index).toBe(0);
    expect(entries).toEqual(before);
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(requests().filter((request) => request === 'POST /api/goals')).toHaveLength(1);
    const leave = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(leave);
    expect(leave.defaultPrevented).toBe(false);
    act(() => { window.history.go(1); flush(); });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(index).toBe(1);
    expect(entries[0]).toEqual(before[0]);
    expect(entries[1].url).toBe('/?screen=goal&ref=draft#draft');
    expect(entries[1].state).toMatchObject({ direct: 'kept' });
    expect(entries).toHaveLength(2);
    expect(replace).toHaveBeenCalledOnce();
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Edit Income target' })).toBeVisible();
  });

  it('keeps an optimistic chart write immediate while its selection waits for the original history entry', async () => {
    window.history.replaceState({ older: 'kept' }, '', '/?screen=settings&foreign=older#old');
    window.history.pushState({ direct: 'kept' }, '', '/?screen=analytics&ref=draft#draft');
    let charts: Array<{ id: string; title: string }> = [];
    mockFetch({
      ...FIRST_PAINT_ROUTES,
      'GET /api/analytics/charts': () => ok({ version: 0, charts: [] }),
      'PUT /api/analytics/charts': (init) => {
        charts = JSON.parse(String(init?.body)).charts;
        return ok({ version: 1, charts });
      },
      'GET /api/accounts': () => ok(ACCOUNTS),
      'GET /api/summary': () => ok(SUMMARY),
      'GET /api/summary/months': () => ok({ scope: 'all', baseCurrency: 'EUR', from: '', to: '', months: [] }),
    });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Build your first chart' }));
    fireEvent.click(screen.getByRole('button', { name: 'Line' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Chart name' }), { target: { value: 'Synthetic chart' } });
    const before = structuredClone(entries);
    const push = vi.mocked(window.history.pushState).mockClear();
    const replace = vi.mocked(window.history.replaceState).mockClear();
    act(() => { window.history.go(-1); flush(); });
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create chart' }));
    await screen.findByRole('heading', { name: 'Synthetic chart' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText(/address bar will update when you go back/)).toBeVisible();
    await waitFor(() => expect(charts).toHaveLength(1));
    expect(entries).toEqual(before);
    expect(index).toBe(0);
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    act(() => { window.history.go(1); flush(); });
    expect(index).toBe(2);
    expect(entries.slice(0, 2)).toEqual(before);
    expect(new URL(entries[2].url, window.location.origin).searchParams.get('chart')).toBe(charts[0].id);
    expect(entries[2].url).toContain('ref=draft');
    expect(entries[2].url).toContain('#draft');
    expect(push).toHaveBeenCalledOnce();
    expect(replace).not.toHaveBeenCalled();
    expect(requests().filter((request) => request === 'PUT /api/analytics/charts')).toHaveLength(1);
    expect(screen.queryByText(/address bar will update when you go back/)).not.toBeInTheDocument();
  });

  it('keeps every reader and the editor stable during Back, cancellation, and unrelated renders', () => {
    managedHistory();
    render(<NavigationHarness />);
    dirtyDraft();
    const original = snapshot;
    const before = structuredClone(entries);
    const push = vi.mocked(window.history.pushState).mockClear();
    const replace = vi.mocked(window.history.replaceState).mockClear();
    act(() => { window.history.go(-2); flushOne(); });
    expect(index).toBe(0);
    expect(window.location.search).toContain('screen=overview');
    expect(screen.getByRole('dialog', { name: 'Unsaved changes' })).toBeInTheDocument();
    expectDraftRetained(original);
    act(flush);
    expect(index).toBe(2);
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expectDraftRetained(original);
    expect(entries).toEqual(before);
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    act(() => { window.history.go(-2); flush(); });
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    act(flush);
    expect(index).toBe(0);
    expect(snapshot.screen).toBe('overview');
    expect(snapshot).not.toBe(original);
    act(() => { window.history.go(2); flush(); });
    expect(index).toBe(2);
    expect(snapshot.goal).toBe('g1');
    expect(screen.getByRole('textbox', { name: 'Goal draft' })).toHaveValue('');
    expect(entries).toEqual(before);
  });

  it('stages normal app links, cancels without a write, and publishes accepted navigation once', () => {
    managedHistory();
    render(<NavigationHarness />);
    dirtyDraft();
    const original = snapshot;
    const push = vi.mocked(window.history.pushState).mockClear();
    fireEvent.click(screen.getByRole('link', { name: 'Analytics' }));
    expectDraftRetained(original);
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('link', { name: 'Analytics' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(push).toHaveBeenCalledTimes(1);
    expect(snapshot.screen).toBe('analytics');
    expect(snapshot.goal).toBeNull();
    expect(window.history.state).toMatchObject({ foreign: 'kept' });
    expect(entries).toHaveLength(4);
  });

  it('leaves modified and nonprimary clicks to the browser without opening a draft guard', () => {
    managedHistory();
    render(<NavigationHarness />);
    dirtyDraft();
    const original = snapshot;
    const link = screen.getByRole('link', { name: 'Analytics' });
    const push = vi.mocked(window.history.pushState).mockClear();
    for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true, ...modifiers });
      // Suppress jsdom's default page navigation after observing the app's policy.
      const suppressBrowser = (observed: Event) => {
        expect(observed.defaultPrevented).toBe(false);
        observed.preventDefault();
      };
      document.addEventListener('click', suppressBrowser, { once: true });
      act(() => { link.dispatchEvent(event); });
    }
    expect(push).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expectDraftRetained(original);
  });

  it('freezes a direct-entry draft on an untracked Back without inventing an entry', () => {
    window.history.replaceState({ older: 'kept' }, '', '/?screen=transactions');
    window.history.pushState({ direct: 'kept' }, '', '/app/?screen=goal&goal=g1#top');
    render(<NavigationHarness />);
    dirtyDraft();
    const original = snapshot;
    const before = structuredClone(entries);
    const push = vi.mocked(window.history.pushState).mockClear();
    const replace = vi.mocked(window.history.replaceState).mockClear();
    act(() => { window.history.go(-1); flush(); });
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expectDraftRetained(original);
    expect(index).toBe(0);
    expect(window.location.search).toBe('?screen=transactions');
    expect(entries).toEqual(before);
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    act(() => { window.history.go(1); flush(); });
    expect(index).toBe(1);
    expectDraftRetained(original);
    expect(entries).toEqual(before);
  });

  it('shares one central popstate subscriber across mounted URL readers and the blocker', () => {
    managedHistory();
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const view = render(<NavigationHarness />);
    expect(add.mock.calls.filter(([type]) => type === 'popstate')).toHaveLength(1);
    expect(add.mock.calls.filter(([type]) => type === 'hashchange')).toHaveLength(1);
    view.unmount();
    expect(remove.mock.calls.filter(([type]) => type === 'popstate')).toHaveLength(1);
    expect(remove.mock.calls.filter(([type]) => type === 'hashchange')).toHaveLength(1);
  });
});
