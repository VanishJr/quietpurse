/**
 * What leaves the server that is not the answer itself (row 72, FIXES findings 8, 13
 * and 14): the cache rule on the built client, the shape of a path that gets the app,
 * and the two headers that stop a copy being kept or a page being framed.
 *
 * The two decisions about the client are pure functions here rather than requests,
 * and that is not a shortcut: the backend CI jobs never run `npm run build`, so a
 * case that reached for web/dist would be green on this machine and skipped in CI -
 * which is exactly the direction this repository has been burned in before. What the
 * functions decide is the whole of the defect either way.
 */
import path from 'path';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { WEB_DIST, app, cacheControlFor, servesTheApp } from '../src/app';
import { seedDefaults } from '../src/db';
import { freshTestDb } from './pglite';

let agent: request.Agent;

beforeAll(async () => {
  await freshTestDb();
  await seedDefaults();
  agent = request.agent(app);
});

describe('the cache rule on the built client', () => {
  it('caches only what Vite content-hashed, and reads the path relative to the build', () => {
    expect(cacheControlFor(path.join(WEB_DIST, 'assets', 'index-a1b2c3.js'))).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(cacheControlFor(path.join(WEB_DIST, 'index.html'))).toBe('no-cache');
    expect(cacheControlFor(path.join(WEB_DIST, 'landing.html'))).toBe('no-cache');
    expect(cacheControlFor(path.join(WEB_DIST, 'favicon.svg'))).toBe('no-cache');
  });

  /**
   * The defect: the rule used to read the whole path on disk, so a checkout under any
   * directory called `assets` cached index.html for a year and the person's browser
   * never saw a new version of the app again. A home directory is one somebody can
   * have, and nothing about it is visible from inside the app.
   */
  it('is not fooled by a checkout that lives under a directory called assets', () => {
    const outside = path.join(path.sep, 'home', 'someone', 'assets', 'finto', 'index.html');
    expect(cacheControlFor(outside)).toBe('no-cache');
  });
});

describe('which paths get the app', () => {
  it.each(['/', '/transactions', '/analytics/spending', '/accounts/some-id'])(
    'serves the app for %s',
    (p) => {
      expect(servesTheApp(p, true)).toBe(true);
    },
  );

  /**
   * A request for a FILE that is not there is a 404 and never a page. After a rebuild
   * a stale index.html asks for a bundle whose name is gone; answering it with HTML
   * makes the browser report a syntax error inside a script, which sends whoever
   * reads it to the wrong file entirely.
   */
  it.each([
    '/assets/index-a1b2c3.js',
    '/assets/index-a1b2c3.css',
    '/favicon.svg',
    '/nope.html',
    '/deep/path/thing.woff2',
  ])('refuses %s rather than answering it with a page', (p) => {
    expect(servesTheApp(p, true)).toBe(false);
  });

  it('refuses a client that does not want HTML, whatever the path looks like', () => {
    expect(servesTheApp('/transactions', false)).toBe(false);
  });
});

describe('the headers every answer carries', () => {
  it('refuses to be framed, on an API answer and on a refusal alike', async () => {
    expect((await agent.get('/api/health')).headers['x-frame-options']).toBe('DENY');
    expect((await agent.get('/api/health').set('Host', 'evil.example')).headers['x-frame-options']).toBe(
      'DENY',
    );
  });

  /**
   * Both of these are the whole database in one response, and res.send sets an ETag
   * and no Cache-Control - which permits a cache to keep a copy the person did not
   * ask anybody to keep. The document download already said so; these two did not.
   */
  it.each(['/api/backup', '/api/export.csv'])('sends %s with nothing allowed to keep it', async (route) => {
    const res = await agent.get(route);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
