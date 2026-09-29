/**
 * What leaves the server that is not the answer itself: the built client's page and
 * the cache rule on it, the shape of a path that gets the app, and the headers that
 * stop a copy being kept or a page being framed.
 *
 * The page is requested from a build this file writes under the OS temp directory,
 * through the same function the app mounts, and never from web/dist: the backend CI
 * jobs never run `npm run build`, so a case that reached for web/dist would be green
 * on this machine and red or skipped in CI.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CLIENT_NOT_BUILT,
  WEB_DIST,
  app,
  cacheControlFor,
  errorHandler,
  serveClient,
  servesTheApp,
} from '../src/app';
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
    expect(cacheControlFor(WEB_DIST, path.join(WEB_DIST, 'assets', 'index-a1b2c3.js'))).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(cacheControlFor(WEB_DIST, path.join(WEB_DIST, 'index.html'))).toBe('no-cache');
    expect(cacheControlFor(WEB_DIST, path.join(WEB_DIST, 'favicon.svg'))).toBe('no-cache');
  });

  /**
   * The defect: the rule used to read the whole path on disk, so a checkout under any
   * directory called `assets` cached index.html for a year and the person's browser
   * never saw a new version of the app again. A home directory is one somebody can
   * have, and nothing about it is visible from inside the app.
   */
  it('is not fooled by a checkout that lives under a directory called assets', () => {
    const outside = path.join(path.sep, 'home', 'someone', 'assets', 'finto', 'index.html');
    expect(cacheControlFor(WEB_DIST, outside)).toBe('no-cache');
  });
});

/**
 * `send` checks every segment of a path it is handed whole, and refuses one that starts
 * with a dot - so a page sent by its absolute path is a 404 from any checkout under such
 * a directory. The builds here differ by that dot and by the marker that names each;
 * merged into one, or with the dot dropped, they stay green over exactly that regression.
 */
describe('the page, served from wherever the checkout lives', () => {
  let tmp: string;
  const build = (where: string) => path.join(tmp, where, 'dist');

  const servedFrom = (dist: string): request.Agent => {
    const t = express();
    serveClient(t, dist);
    t.use(errorHandler);
    return request.agent(t);
  };

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'finto-serving-'));
    for (const [where, marker] of [
      ['plain', 'finto-serving-plain'],
      ['.dotted', 'finto-serving-dotted'],
    ]) {
      fs.mkdirSync(path.join(build(where), 'assets'), { recursive: true });
      fs.writeFileSync(path.join(build(where), 'index.html'), `<!doctype html><title>${marker}</title>`);
      fs.writeFileSync(path.join(build(where), 'assets', 'app-a1b2c3.js'), 'export {};\n');
    }
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it.each([
    ['plain', 'plain'],
    ['dotted', '.dotted'],
  ])('answers / with the page of a build under a %s path', async (kind, where) => {
    const res = await servedFrom(build(where)).get('/').set('Accept', 'text/html');
    expect(res.status, res.text).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.text).toContain(`finto-serving-${kind}`);
    expect(res.headers['last-modified']).toBeDefined();
  });

  it('answers a deep app path with the page too, under a dotted path', async () => {
    const res = await servedFrom(build('.dotted')).get('/transactions').set('Accept', 'text/html');
    expect(res.status, res.text).toBe(200);
    expect(res.text).toContain('finto-serving-dotted');
  });

  it('serves a hashed asset from a build under a dotted path, cached for good', async () => {
    const res = await servedFrom(build('.dotted')).get('/assets/app-a1b2c3.js');
    expect(res.status, res.text).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('refuses a bundle the build does not hold rather than answering it with the page', async () => {
    const res = await servedFrom(build('.dotted')).get('/assets/gone-a1b2c3.js').set('Accept', '*/*');
    expect(res.status, res.text).toBe(404);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.text).toBe('not found');
  });

  it.each(['/', '/transactions', '/assets/index-a1b2c3.js'])(
    'says the client is not built for %s when there is no build',
    async (p) => {
      const res = await servedFrom(build('unbuilt')).get(p).set('Accept', 'text/html');
      expect(res.status, res.text).toBe(503);
      expect(res.headers['content-type']).toMatch(/^text\/plain/);
      expect(res.text).toBe(CLIENT_NOT_BUILT);
    },
  );
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
