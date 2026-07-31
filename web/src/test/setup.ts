import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { resetFetch, takeUnstubbed, unstubbedMessage } from './harness';

/** jsdom implements neither of these, and both are on a mounted screen's path. */

// theme.tsx:139/145 calls it unconditionally and attaches a listener to the result.
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

// recharts constructs one in ResponsiveContainer; nothing in web/src does. No test
// here mounts a chart, so this is insurance for the first one that does.
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

beforeEach(() => {
  resetFetch();
  // jsdom implements neither, and saving a downloaded statement runs through both.
  // Fresh per test rather than declared once: the call log is then reset by
  // construction, and "createObjectURL was never called" cannot pass vacuously on a
  // log left over from the test before it
  URL.createObjectURL = vi.fn(() => 'blob:test');
  URL.revokeObjectURL = vi.fn();
  // theme.tsx reads finto.theme at mount, and jsdom keeps localStorage across the
  // tests in a file: a test that pins a theme must not pin it for the ones after.
  localStorage.clear();
});

afterEach(() => {
  // unconditionally first: without it the second render of a screen leaves two
  // copies in the document and getByText throws "found multiple elements"
  cleanup();
  const missed = takeUnstubbed();
  if (missed.length > 0) throw new Error(unstubbedMessage(missed));
});
