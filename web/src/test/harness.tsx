import { render, RenderResult } from '@testing-library/react';
import React from 'react';
import { ThemeProvider } from '../theme';
import {
  ACCOUNTS,
  BUDGETS,
  INCOME_SOURCES,
  INDEPENDENCE,
  ONBOARDING_DONE,
  RECURRING,
  SUMMARY,
  TRANSACTIONS,
  TRANSFER_RULES,
  USER,
} from './fixtures';

/**
 * Deny-by-default fetch for the jsdom project.
 *
 * The rejection this returns for an unknown route is not what holds the line. Six
 * background loads in this client end in `.catch(() => {})` - App.tsx,
 * CsvImport.tsx, OverviewScreen.tsx and three in TransactionsScreen.tsx - and
 * auth.signupMode() swallows its own with a try/catch, so a rejection changes
 * nothing observable and the screen renders in its empty state. What holds it is
 * the afterEach in setup.ts, which throws naming every request no route matched.
 *
 * Which is why requests() exists. Where the subject of a test is a request - a 401
 * that signs the user out, a confirm that must never fire - the assertion you want
 * is that a request happened, not that a frame was painted: a frame is also painted
 * by the app that never signed in, and awaiting one races the two loads.
 *
 * Known limit: the guard sees only what was requested by the time its afterEach
 * runs. One arriving later is wiped by the next test's resetFetch(), or never read
 * at all after the last test in a file. Unreachable while nothing in web/src uses
 * setTimeout, setInterval or requestAnimationFrame - real with the first debounced
 * or polled request, which is when this needs fixing.
 */

type Handler = (init?: RequestInit) => Response | Promise<Response>;

/** Key: `${METHOD} ${pathname}`. No patterns, no ordering, no fallthrough. */
export type Routes = Record<string, Handler>;

let routes: Routes = {};
let seen: string[] = [];
let unstubbed: string[] = [];

export const ok = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

export const fail = (status: number, body: unknown = { error: `HTTP ${status}` }): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** The query string is discarded, so /api/accounts?all=1 and /api/accounts are one key. */
const keyOf = (input: RequestInfo | URL, init?: RequestInit): string => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? 'GET').toUpperCase();
  return `${method} ${new URL(url, 'http://localhost').pathname}`;
};

/** Installed by setup.ts in beforeEach, so no test can reach the network by forgetting. */
export function resetFetch(): void {
  routes = {};
  seen = [];
  unstubbed = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = keyOf(input, init);
    seen.push(key);
    const handler = routes[key];
    if (!handler) {
      unstubbed.push(key);
      throw new Error(`no route for ${key}`);
    }
    return handler(init);
  }) as typeof fetch;
}

/** Replaces the table for this test. Spread FIRST_PAINT_ROUTES to override one route. */
export function mockFetch(table: Routes): void {
  routes = { ...table };
}

/** Every request the test made, matched or not, in order. */
export const requests = (): string[] => [...seen];

/** Reads and clears, so a throw in the guard cannot leak into the next test. */
export function takeUnstubbed(): string[] {
  const missed = unstubbed;
  unstubbed = [];
  return missed;
}

export function unstubbedMessage(missed: string[]): string {
  const counts = new Map<string, number>();
  for (const key of missed) counts.set(key, (counts.get(key) ?? 0) + 1);
  const lines = [...counts].map(([key, n]) => `  ${key}${n > 1 ? `  (x${n})` : ''}`);
  return [
    `${missed.length} request${missed.length === 1 ? '' : 's'} had no route in this test:`,
    ...lines,
    'Declare them in the table passed to mockFetch(), or in FIRST_PAINT_ROUTES if',
    'the app fires them on first paint.',
  ].join('\n');
}

/** For a screen mounted on its own: App brings its own ThemeProvider. */
export const renderThemed = (ui: React.ReactNode): RenderResult =>
  render(<ThemeProvider>{ui}</ThemeProvider>);

/**
 * Every request the signed-in app fires on first paint, produced by running the App
 * test against an empty table and reading the guard's list - not by reading the
 * screens. A row that adds a first-paint request is told so by a red test.
 *
 * /api/summary/months (range === 'year') and /api/imports/presets (once CsvImport
 * mounts) are deliberately absent: neither is first paint.
 */
export const FIRST_PAINT_ROUTES: Routes = {
  'GET /api/auth/get-session': () => ok({ user: USER }),
  'GET /api/onboarding/status': () => ok(ONBOARDING_DONE),
  'GET /api/accounts': () => ok(ACCOUNTS),
  'GET /api/recurring': () => ok(RECURRING),
  'GET /api/income-sources': () => ok(INCOME_SOURCES),
  'GET /api/transfer-rules': () => ok(TRANSFER_RULES),
  'GET /api/transactions': () => ok(TRANSACTIONS),
  'GET /api/summary': () => ok(SUMMARY),
  'GET /api/budgets': () => ok(BUDGETS),
  'GET /api/independence': () => ok(INDEPENDENCE),
};

/** The signed-out shell: AuthScreen asks the backend whether registration is open. */
export const SIGNED_OUT_ROUTES: Routes = {
  'GET /api/auth/get-session': () => ok(null),
  'GET /api/health': () => ok({ signup: 'open' }),
};
