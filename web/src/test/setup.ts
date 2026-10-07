import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { resetFetch, takeUnstubbed, unstubbedMessage } from './harness';
import { TestResizeObserver, resetResizeObservers } from './resize';

/** jsdom implements neither of these, and both are on a mounted screen's path. */

// ThemeProvider calls it unconditionally and attaches a listener to the result.
window.matchMedia = (query: string): MediaQueryList =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
    addListener: () => {},
    removeListener: () => {},
  }) as unknown as MediaQueryList;

globalThis.ResizeObserver = TestResizeObserver;

beforeEach(() => {
  resetResizeObservers();
  resetFetch();
  // jsdom implements neither, and saving a downloaded statement runs through both.
  // Fresh per test rather than declared once: the call log is then reset by
  // construction, and "createObjectURL was never called" cannot pass vacuously on a
  // log left over from the test before it
  URL.createObjectURL = vi.fn(() => 'blob:test');
  URL.revokeObjectURL = vi.fn();
  // jsdom has no layout, so it implements this one not at all: called unguarded it
  // throws inside the handler that scrolls a caption into view and turns a success
  // into an error on screen. Fresh per test for the same reason as the two above.
  Element.prototype.scrollIntoView = vi.fn();
  // theme.tsx reads finto.theme at mount, and jsdom keeps localStorage across the
  // tests in a file: a test that pins a theme must not pin it for the ones after.
  localStorage.clear();
  // ...and the same for the URL, which is where the screen, the account and the panel
  // live now (url.ts). jsdom keeps one Location per file, so without this a test that
  // clicks Transactions mounts every test after it on the Transactions screen.
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  // unconditionally first: without it the second render of a screen leaves two
  // copies in the document and getByText throws "found multiple elements"
  cleanup();
  const missed = takeUnstubbed();
  if (missed.length > 0) throw new Error(unstubbedMessage(missed));
});
