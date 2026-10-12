import { render, RenderResult } from '@testing-library/react';
import React from 'react';
import { ThemeProvider } from '../theme';
import {
  ACCOUNTS,
  APP_SETTINGS,
  GOALS,
  INCOME_SOURCES,
  RECURRING,
  TRANSACTIONS,
  NO_CHARTS,
  TRANSFER_RULES,
} from './fixtures';

/**
 * Deny-by-default fetch for the jsdom project.
 *
 * The rejection this returns for an unknown route is not what holds the line. Several
 * background loads in this client end in `.catch(() => {})`, so a rejection changes
 * nothing observable and the screen renders in its empty state. What holds it is the
 * afterEach in setup.ts, which throws naming every request no route matched.
 *
 * Which is why requests() exists. Where the subject of a test is a request, such as a
 * confirm that must never fire, the assertion you want is on the requests, not on a
 * painted frame: a frame is also painted by a screen that never asked, and awaiting
 * one races the two loads.
 *
 * Known limit: the guard sees only what was requested by the time its afterEach
 * runs. One arriving later is wiped by the next test's resetFetch(), or never read
 * at all after the last test in a file. A request made from a timer stays inside
 * that limit only while its timer stops when its component unmounts: setup.ts's
 * afterEach unmounts before the guard reads. One that outlives its component is
 * when this needs fixing.
 */

/**
 * The URL is the second argument because `keyOf` throws the query string away, and one
 * path now answers two different shapes: `/api/summary` is the workspace's body or one
 * account's depending on `?accountId=`, and api.ts throws on the wrong one. Every
 * handler that does not care ignores it.
 */
type Handler = (init?: RequestInit, url?: string) => Response | Promise<Response>;

/** Key: `${METHOD} ${pathname}`. No patterns, no ordering, no fallthrough. */
export type Routes = Record<string, Handler>;

let routes: Routes = {};
let seen: string[] = [];
let seenUrls: string[] = [];
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

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

/** The query string is discarded, so /api/accounts?all=1 and /api/accounts are one key. */
const keyOf = (input: RequestInfo | URL, init?: RequestInit): string => {
  const method = (init?.method ?? 'GET').toUpperCase();
  return `${method} ${new URL(urlOf(input), 'http://localhost').pathname}`;
};

/** Installed by setup.ts in beforeEach, so no test can reach the network by forgetting. */
export function resetFetch(): void {
  routes = {};
  seen = [];
  seenUrls = [];
  unstubbed = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = keyOf(input, init);
    seen.push(key);
    seenUrls.push(`${(init?.method ?? 'GET').toUpperCase()} ${urlOf(input)}`);
    const handler = routes[key];
    if (!handler) {
      unstubbed.push(key);
      throw new Error(`no route for ${key}`);
    }
    return handler(init, urlOf(input));
  }) as typeof fetch;
}

/** Replaces the table for this test. Spread FIRST_PAINT_ROUTES to override one route. */
export function mockFetch(table: Routes): void {
  routes = { ...table };
}

/** Every request the test made, matched or not, in order. */
export const requests = (): string[] => [...seen];

/**
 * The same list with the query string kept. It is the only place a parameter the
 * client SENT can be asserted, since keyOf drops it and a handler is called with no URL.
 * Beside requests() rather than instead of it: putting the query into the key would
 * break every route declared in the suite.
 */
export const requestUrls = (): string[] => [...seenUrls];

/**
 * The account a request named, or '' when it named none. For a handler answering a
 * path whose two arms differ by that parameter: a static account body is a body about
 * whichever account the fixture was written for, and api.ts refuses it for every other.
 */
export const askedFor = (url = ''): string =>
  new URL(url, 'http://localhost').searchParams.get('accountId') ?? '';

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
 * Every request the app fires on first paint, produced by running the App test
 * against an empty table and reading the guard's list, not by reading the screens.
 * A row that adds a first-paint request is told so by a red test.
 *
 * /api/imports/presets (once CsvImport mounts) is deliberately absent: it is not first
 * paint.
 *
 * Neither is any summary request, and that is now true from both directions. Overview
 * asks for every account that HAS a transaction, but TRANSACTIONS here is empty, so it
 * short-circuits on `recent.length === 0` and fires neither. Give that fixture a row and
 * Overview fires both; the guard then names the missing one, which is this mechanism
 * working rather than a hole in it. Analytics is a board of charts the reader builds:
 * an empty one asks for the account list and for the charts themselves, which live on
 * the server. /api/summary is requested only when a saved chart needs it.
 *
 * The charts row answers version 0 with nothing in it, which is deliberately the one
 * response that would set the migration going. It stays quiet here because there is
 * nothing in localStorage to migrate. A test that seeds that key gets a PUT, which
 * is the migration and not a first-paint request.
 */
export const FIRST_PAINT_ROUTES: Routes = {
  'GET /api/accounts': () => ok(ACCOUNTS),
  'GET /api/analytics/charts': () => ok(NO_CHARTS),
  'GET /api/app-settings': () => ok(APP_SETTINGS),
  'GET /api/recurring': () => ok(RECURRING),
  'GET /api/income-sources': () => ok(INCOME_SOURCES),
  'GET /api/transfer-rules': () => ok(TRANSFER_RULES),
  'GET /api/transactions': () => ok(TRANSACTIONS),
  'GET /api/goals': () => ok(GOALS),
};
