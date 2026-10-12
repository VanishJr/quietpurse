/**
 * What the door answers when there is no body to read, and what the last handler
 * answers when a parser refused one. The route files hold each route's own sentences.
 * This file holds what every JSON route shares: the helper that refuses a body that is
 * not an object, and the handler that keeps a parser's status instead of calling it
 * the server's fault. It also holds the check that reads app.ts and refuses a route
 * written past the helper.
 */
import fs from 'fs';
import path from 'path';
import express from 'express';
import { beforeAll, describe, expect, it } from 'vitest';
import { app, errorHandler } from '../src/app';
import { seedDefaults } from '../src/db';
import { type Agent, serve } from './loopback';
import { freshTestDb } from './pglite';

const NOT_A_JSON_OBJECT =
  'the request body is not a JSON object. Send the fields as a JSON object with Content-Type: application/json';

const NOT_MULTIPART = 'the upload is not a valid multipart form';

const BODY_TOO_LARGE =
  'the request body is larger than 25 MB, the ceiling for a JSON body or a backup file. Nothing was changed';

/** An independent literal: a pin that imported the constant would move with it. */
const CEILING = 25 * 1024 * 1024;

/** A JSON body of exactly `size` bytes, holding nothing but one padding key. */
const paddedPatch = (size: number): string => {
  const head = '{"pad":"';
  const tail = '"}';
  const body = `${head}${'x'.repeat(size - head.length - tail.length)}${tail}`;
  expect(Buffer.byteLength(body, 'utf8')).toBe(size);
  return body;
};

type Method = 'post' | 'put' | 'patch';

/**
 * Every route that reads a JSON body without a schema in front of it. Each reads the
 * body before it looks anything up, so an id no row has never pre-empts the refusal.
 */
const JSON_ROUTES: [Method, string][] = [
  ['patch', '/api/transactions/nope/transfer'],
  ['patch', '/api/transactions/nope/category'],
  ['patch', '/api/transactions/nope/source'],
  ['patch', '/api/transactions/nope/one-off'],
  ['post', '/api/transfer-rules'],
  ['post', '/api/recurring/ignore'],
  ['post', '/api/goals'],
  ['put', '/api/goals/nope'],
  ['patch', '/api/app-settings'],
  ['post', '/api/category-rules'],
  ['post', '/api/category-rules/preview'],
];

let agent: Agent;

beforeAll(async () => {
  await freshTestDb();
  await seedDefaults();
  agent = await serve(app);
});

describe('a write with no body', () => {
  it.each(JSON_ROUTES)('%s %s with no body is refused as not a JSON object', async (method, route) => {
    const res = await agent[method](route);
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body).toEqual({ error: NOT_A_JSON_OBJECT });
  });

  /** The upload door is not a JSON door: what it wants to hear about is multipart. */
  it('POST /api/imports with no body is refused as not a multipart form', async () => {
    const res = await agent.post('/api/imports');
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body).toEqual({ error: NOT_MULTIPART });
  });

  /** No body cannot tell a multipart guard from a body-presence guard; a JSON object can. */
  it('POST /api/imports with a JSON object is refused as not a multipart form', async () => {
    const res = await agent.post('/api/imports').send({ accountId: 'x' });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body).toEqual({ error: NOT_MULTIPART });
  });

  /**
   * The guard is per route and not a rule over every POST: the shipped client
   * confirms and discards an import with no body and no content type, and both must
   * keep reaching their route.
   */
  it('POST /api/imports/:id/confirm with no body still reaches the route', async () => {
    const res = await agent.post('/api/imports/nope/confirm');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'import not found' });
  });
});

describe('a body the JSON parser does not claim', () => {
  const rule = () => agent.post('/api/transfer-rules');

  it('a JSON string sent as text/plain is refused as not a JSON object', async () => {
    const res = await rule().set('Content-Type', 'text/plain').send(JSON.stringify({ txId: 'abc' }));
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body).toEqual({ error: NOT_A_JSON_OBJECT });
  });

  /** No parser on this route claims a form, so it is the helper that refuses it. */
  it('a multipart form sent to a JSON route is refused as not a JSON object', async () => {
    const res = await rule().field('txId', 'abc');
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body).toEqual({ error: NOT_A_JSON_OBJECT });
  });

  /** An array is JSON and is not an object; without this clause `.length` reads as a field. */
  it('a JSON array is refused as not a JSON object', async () => {
    const res = await rule().send([1, 2]);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: NOT_A_JSON_OBJECT });
  });

  /** The parser hands an empty JSON body over as `{}`, and an empty object is an object. */
  it('an empty body under application/json reaches the route, which refuses the missing field', async () => {
    const res = await rule().set('Content-Type', 'application/json').send('');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'txId field required' });
  });
});

describe('what the last handler answers', () => {
  /**
   * On a route that is not the restore, so the pass-through is shown to be the
   * handler's. Under a moved ceiling this route refuses the padded body as a goal it
   * cannot read, a 400, and never a 413.
   */
  it('one byte over the ceiling on a JSON route is a 413 that names the ceiling', async () => {
    const res = await agent
      .post('/api/goals')
      .set('Content-Type', 'application/json')
      .send(paddedPatch(CEILING + 1));
    expect(res.status, JSON.stringify(res.body)).toBe(413);
    expect(res.body).toEqual({ error: BODY_TOO_LARGE });
  });

  /**
   * The general exposed-4xx arm. The phrase is body-parser's, not this door's: when
   * this reds on an upgrade, that is the side that moved.
   */
  it("a charset the parser does not read is a 415 in the parser's words", async () => {
    const res = await agent
      .post('/api/transfer-rules')
      .set('Content-Type', 'application/json; charset=koi8-r')
      .send('{"txId":"abc"}');
    expect(res.status, JSON.stringify(res.body)).toBe(415);
    expect(res.body).toEqual({ error: 'unsupported charset "KOI8-R"' });
  });

  /**
   * That phrase carries the caller's own charset back, so the echo is cut at a
   * bound the door owns. The short charset above cannot see the cut. The length is
   * an independent literal, because a pin that imported the bound would move with
   * it. The match stops at the phrase: what follows is the caller's charset,
   * upper-cased by body-parser.
   */
  it("a long charset is echoed in the 415 only up to the door's bound", async () => {
    const res = await agent
      .post('/api/transfer-rules')
      .set('Content-Type', `application/json; charset=${'k'.repeat(300)}`)
      .send('{"txId":"abc"}');
    expect(res.status, JSON.stringify(res.body)).toBe(415);
    expect(res.body.error).toMatch(/^unsupported charset "K/);
    expect(res.body.error).toHaveLength(200);
  });

  /**
   * Built inside the case and not beside the describe: on a tree with no
   * errorHandler export, an app built at collection time would take every case in
   * this file down with it.
   */
  const bare = async (route: express.RequestHandler) => {
    const throwaway = express();
    throwaway.get('/t', route);
    throwaway.use(errorHandler);
    return (await serve(throwaway)).get('/t');
  };

  it('a plain Error is still a 500 whose message stays out of the body', async () => {
    const res = await bare(() => {
      throw new Error('SELECT secret FROM t');
    });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal error' });
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });

  /** What res.sendFile hands next on a missing file: a 4xx status, and expose false. */
  it('a 4xx the server did not mean to expose is still a 500', async () => {
    const res = await bare((_req, _res, next) => {
      next(Object.assign(new Error('ENOENT: /home/x/index.html'), { status: 404, expose: false }));
    });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal error' });
    expect(JSON.stringify(res.body)).not.toContain('/home');
  });
});

/**
 * The rule no type holds: a route may read req.body only through one of the shapes
 * `SHAPES` names, because a bare read of a body no parser claimed is a TypeError
 * answered as the server's fault. Held by reading app.ts as text, so it sees the
 * next route written the old way. The only token it reads is `req.body`. It does not
 * see a read spelled without that token, such as a renamed request parameter,
 * `const { body } = req`, `req['body']` or an alias, nor a line whose read sits after
 * a `//` inside a string. None of those gaps is closed here: the failure this exists
 * for is a copied neighbour.
 */
describe('no route reads req.body bare', () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), 'src/app.ts'), 'utf8');
  // comments go, line numbers stay: a block comment is replaced by its own newlines
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ''))
    .replace(/\/\/[^\n]*/g, '');
  const lines = code.split('\n').map((l) => l.trimEnd());

  /**
   * The nearest line at or above `i` that starts at column 0 with a letter, which is a
   * route registration or a top-level declaration. It is joined with the line after
   * it, because the restore route writes `app.post(` and its path on separate lines.
   */
  const ownerOf = (i: number): string => {
    let j = i;
    while (j > 0 && !/^[A-Za-z]/.test(lines[j])) j -= 1;
    return `${lines[j]}\n${lines[j + 1] ?? ''}`;
  };

  /**
   * Each shape is a line pattern and an owner pattern. Why each is allowed:
   * zod: the schema narrows undefined to a 400 of its own.
   * helper: the one read every JSON route goes through, and `unknown` makes a bare
   *   property read a compile error.
   * restore: a Buffer or parsed JSON by content type, narrowed by Buffer.isBuffer
   *   and a try.
   * upload: what multer populated, behind uploadFile's multipart guard.
   */
  const SHAPES = {
    zod: { line: /\.safeParse\(req\.body\)/, owner: /./ },
    helper: { line: /^\s*const body: unknown = req\.body;$/, owner: /^(const|function) jsonBody\b/ },
    restore: { line: /^\s*const raw: unknown = req\.body;$/, owner: /'\/api\/restore'/ },
    upload: {
      line: /^\s*const body = req\.body as Record<string, unknown>;$/,
      owner: /'\/api\/imports', uploadFile/,
    },
  } as const;
  type Shape = keyof typeof SHAPES;

  const reads = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => line.includes('req.body'));

  const shapeOf = ({ line, i }: { line: string; i: number }): Shape | undefined => {
    // one read per line, so a second read cannot hide behind an allowed one
    if ((line.match(/req\.body/g) ?? []).length !== 1) return undefined;
    const owner = ownerOf(i);
    return (Object.keys(SHAPES) as Shape[]).find(
      (s) => SHAPES[s].line.test(line) && SHAPES[s].owner.test(owner),
    );
  };

  const counts = Object.fromEntries(
    (Object.keys(SHAPES) as Shape[]).map((s) => [s, reads.filter((r) => shapeOf(r) === s).length]),
  ) as Record<Shape, number>;

  /**
   * Green over nothing is the failure of a check that reads a file: the floors are
   * the sites this rule leaves behind, as literals, so a renamed helper or a
   * rewritten restore path fails here with its shape named rather than passing.
   */
  it('the file was read and every allowed shape is present', () => {
    expect(source.length).toBeGreaterThan(0);
    expect(reads.length, 'fewer req.body reads than the door has doors').toBeGreaterThanOrEqual(8);
    expect(counts.zod, 'the zod shape matched fewer than the schema routes').toBeGreaterThanOrEqual(5);
    expect(counts.helper, 'jsonBody no longer reads req.body into unknown').toBeGreaterThanOrEqual(1);
    expect(counts.restore, 'the restore route no longer reads req.body into unknown').toBeGreaterThanOrEqual(1);
    expect(counts.upload, "the upload route's read moved out from behind uploadFile").toBeGreaterThanOrEqual(1);
  });

  it('every req.body read is one of the shapes SHAPES names', () => {
    const bare = reads
      .filter((r) => shapeOf(r) === undefined)
      .map(({ line, i }) => `src/app.ts:${i + 1}: ${line.trim()} - read the body through jsonBody(req, res)`);
    expect(bare).toEqual([]);
  });

  /**
   * The helper answers the 400 and returns undefined, and the route has to stop:
   * `parseAppSettingsPatch(jsonBody(req, res) ?? {})` compiles, answers the refusal
   * and keeps running, so a write lands behind a 400. The call is therefore held to
   * one two-line shape, the same identifier on both lines.
   */
  it('every jsonBody call is a binding followed by its return', () => {
    const PAIR = /^\s*const (\w+) = jsonBody\(req, res\);\n\s*if \(!\1\) return;$/;
    const uses = lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => /\bjsonBody\b/.test(line) && !/^(const|function) jsonBody\b/.test(line));
    const odd = uses
      .filter(({ line, i }) => !PAIR.test(`${line}\n${lines[i + 1] ?? ''}`))
      .map(({ line, i }) => `src/app.ts:${i + 1}: ${line.trim()} - bind it, then return when it is undefined`);
    expect(odd).toEqual([]);
    expect(uses.length, 'fewer jsonBody calls than JSON routes').toBeGreaterThanOrEqual(11);
    expect(uses.length, 'a jsonBody route with no row in JSON_ROUTES').toBe(JSON_ROUTES.length);
  });

  /**
   * The pair above holds every caller and is blind to the callee: `return {};` on
   * the refusal arm compiles, and every `if (!body) return;` is then dead.
   */
  it("jsonBody's refusal arm returns undefined", () => {
    const ARM = /^\s*res\.status\(400\)\.json\(\{ error: NOT_A_JSON_OBJECT \}\);$/;
    const arms = lines
      .map((line, i) => ({ line, i }))
      .filter(({ line, i }) => ARM.test(line) && SHAPES.helper.owner.test(ownerOf(i)));
    expect(arms.length, 'jsonBody no longer answers NOT_A_JSON_OBJECT on a line of its own').toBe(1);
    const at = arms[0].i + 1;
    const next = lines[at] ?? '';
    expect(
      next,
      `src/app.ts:${at + 1}: ${next.trim()} - the arm must return undefined, so the route's if (!body) return; fires`,
    ).toMatch(/^\s*return undefined;$/);
  });
});
