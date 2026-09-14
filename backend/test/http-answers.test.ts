/**
 * The seam that parses every JSON answer against its declaration, and the walk that
 * refuses an undeclared route at import. Built on throwaway apps, the way
 * http-body.test.ts builds its bare() app, so each case can register a route the
 * real app does not have; the real app appears only as the control at the end.
 */
import express from 'express';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ANSWER_CHECK,
  type AnswerReporter,
  answerCheck,
  app,
  assertAnswersDeclared,
  errorHandler,
  registeredAnswerKeys,
} from '../src/app';
import { seedDefaults } from '../src/db';
import { installAnswerCheck } from './answers';
import { freshTestDb } from './pglite';

const throwaway = (reporter = true) => {
  const t = express();
  t.use(answerCheck);
  const check = reporter ? installAnswerCheck(t) : undefined;
  return { app: t, drain: () => check?.drain() ?? [] };
};

describe('what the wrapper records', () => {
  it('a 2xx JSON body answered by no route at all', async () => {
    const { app: t, drain } = throwaway();
    t.use((_req, res) => {
      res.json({ ok: true });
    });
    const res = await request(t).get('/anything');
    expect(res.status).toBe(200);
    expect(drain()).toEqual(['GET /anything (no route) answered 200: no route matched']);
  });

  it('a 2xx JSON body from a route the registry does not carry', async () => {
    const { app: t, drain } = throwaway();
    t.get('/api/probe', (_req, res) => {
      res.json({ ok: true });
    });
    await request(t).get('/api/probe');
    expect(drain()).toEqual(['GET /api/probe (GET /api/probe) answered 200: not declared in ANSWERS']);
  });

  it('a field the declaration lacks, named', async () => {
    const { app: t, drain } = throwaway();
    t.get('/api/health', (_req, res) => {
      res.json({ ok: true, extra: 1 });
    });
    await request(t).get('/api/health');
    const [only, ...rest] = drain();
    expect(rest).toEqual([]);
    expect(only).toContain('GET /api/health (GET /api/health) answered 200');
    expect(only).toContain('Unrecognized key: "extra"');
  });

  it('a field the declaration has under another name, with the path', async () => {
    const { app: t, drain } = throwaway();
    t.get('/api/settings', (_req, res) => {
      res.json({ bufferPct: 10, windowMonths: 6, hourlyRate: null, hoursCapPerWeek: 20, mode: 'baseline' });
    });
    await request(t).get('/api/settings');
    const [only] = drain();
    expect(only).toContain('goalMode:');
    expect(only).toContain('Unrecognized key: "mode"');
  });

  it('a status other than the declared one', async () => {
    const { app: t, drain } = throwaway();
    t.post('/api/accounts', (_req, res) => {
      res.status(200).json({ id: 'a', provider: 'upload', name: 'n', currency: 'EUR', balance: 0, hidden: false });
    });
    await request(t).post('/api/accounts');
    expect(drain()).toEqual(['POST /api/accounts (POST /api/accounts) answered 200: declared 201']);
  });

  it('a JSON body on a route declared as not JSON', async () => {
    const { app: t, drain } = throwaway();
    t.get('/api/export.csv', (_req, res) => {
      res.json({ rows: [] });
    });
    await request(t).get('/api/export.csv');
    expect(drain()).toEqual(['GET /api/export.csv (GET /api/export.csv) answered 200: declared not-json, answered JSON']);
  });

  it('a refusal that is not the envelope, and the charts 409 that is its own', async () => {
    const { app: t, drain } = throwaway();
    t.get('/api/health', (_req, res) => {
      res.status(400).json({ message: 'no' });
    });
    t.put('/api/analytics/charts', (_req, res) => {
      res.status(409).json({ error: 'stale', version: 3, charts: [] });
    });
    t.get('/api/accounts', (_req, res) => {
      res.status(409).json({ error: 'stale', version: 3, charts: [] });
    });
    await request(t).get('/api/health');
    const [refusal] = drain();
    expect(refusal).toContain('GET /api/health (GET /api/health) answered 400');
    expect(refusal).toContain('error:');
    expect(refusal).toContain('Unrecognized key: "message"');

    await request(t).put('/api/analytics/charts');
    expect(drain()).toEqual([]);

    await request(t).get('/api/accounts');
    const [elsewhere] = drain();
    expect(elsewhere).toContain('GET /api/accounts (GET /api/accounts) answered 409');
    expect(elsewhere).toContain('Unrecognized keys: "version", "charts"');
  });

  it('a refusal answered before any route matched is held to the envelope', async () => {
    const { app: t, drain } = throwaway();
    t.use((_req, res) => {
      res.status(403).json({ error: 'not from here' });
    });
    const res = await request(t).get('/api/health');
    expect(res.status).toBe(403);
    expect(drain()).toEqual([]);
  });

  it('a declared JSON route answering through res.send, and a not-json route that may', async () => {
    const { app: t, drain } = throwaway();
    t.get('/api/health', (_req, res) => {
      res.type('json').send(JSON.stringify({ ok: true }));
    });
    t.get('/api/export.csv', (_req, res) => {
      res.type('text/csv').send('a,b');
    });
    t.get('/api/accounts', (_req, res) => {
      res.status(503).type('text/plain').send('later');
    });
    const res = await request(t).get('/api/health');
    expect(res.body).toEqual({ ok: true });
    expect(drain()).toEqual([
      'GET /api/health (GET /api/health) answered 200: declared JSON route answered through res.send',
    ]);
    await request(t).get('/api/export.csv');
    await request(t).get('/api/accounts');
    expect(drain()).toEqual([]);
  });

  it('a body the serialiser refuses is recorded, and the original is still called', async () => {
    const { app: t, drain } = throwaway();
    t.get('/api/health', (_req, res) => {
      res.json({ n: 1n });
    });
    t.use(errorHandler);
    const res = await request(t).get('/api/health');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal error' });
    const [threw] = drain();
    expect(threw).toContain('GET /api/health answered 200: the answer check threw:');
    expect(threw).toContain('BigInt');
  });

  it('the body the case reads is the body the route answered, mismatch or not', async () => {
    const { app: t, drain } = throwaway();
    t.get('/api/health', (_req, res) => {
      res.json({ ok: true, extra: 1 });
    });
    const res = await request(t).get('/api/health');
    expect(res.body).toEqual({ ok: true, extra: 1 });
    expect(drain()).toHaveLength(1);
  });

  it('drains once: a second drain answers nothing', async () => {
    const { app: t, drain } = throwaway();
    t.get('/api/probe', (_req, res) => {
      res.json({});
    });
    await request(t).get('/api/probe');
    expect(drain()).toHaveLength(1);
    expect(drain()).toEqual([]);
  });

  it('with no reporter set, the wrapper changes nothing and records nothing', async () => {
    const { app: t } = throwaway(false);
    t.get('/api/health', (_req, res) => {
      res.json({ ok: true, extra: 1 });
    });
    const res = await request(t).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, extra: 1 });
    expect(t.get('answer check')).toBeUndefined();
  });
});

describe('what the walk refuses at import', () => {
  const withRoutes = (...register: ((t: express.Express) => void)[]) => {
    const t = express();
    for (const r of register) r(t);
    return t;
  };

  it('a route no declaration carries, by key', () => {
    const t = withRoutes((t) => {
      t.get('/api/probe', (_req, res) => {
        res.json({ ok: true });
      });
    });
    expect(() => assertAnswersDeclared(t)).toThrow(/registered and not declared: GET \/api\/probe;/);
  });

  it('a declaration no route carries, by key', () => {
    const t = withRoutes((t) => {
      t.get('/api/health', (_req, res) => {
        res.json({ ok: true });
      });
    });
    expect(() => assertAnswersDeclared(t)).toThrow(/declared and not registered: .*GET \/api\/accounts/);
  });

  it('a router mounted under a prefix, whose routes it cannot see', () => {
    const t = withRoutes((t) => {
      const r = express.Router();
      r.get('/probe', (_req, res) => {
        res.json({ ok: true });
      });
      t.use('/api', r);
    });
    expect(() => registeredAnswerKeys(t)).toThrow(/a router is mounted on the app/);
  });

  it('an express() app mounted under a prefix, which is a router by another name', () => {
    const t = withRoutes((t) => {
      const sub = express();
      sub.get('/probe', (_req, res) => {
        res.json({ ok: true });
      });
      t.use('/api', sub);
    });
    expect(() => registeredAnswerKeys(t)).toThrow(/a router is mounted on the app/);
  });

  it('a handler mounted with app.use, anonymous or named, which answers with no route to key it', () => {
    const anonymous = withRoutes((t) => {
      t.use('/api/probe', (_req, res) => {
        res.json({ ok: true });
      });
    });
    expect(() => registeredAnswerKeys(anonymous)).toThrow(
      /a middleware the door does not name is on the app: anonymous - /,
    );
    const named = withRoutes((t) => {
      t.use(function probeMiddleware(_req, res) {
        res.json({ ok: true });
      });
    });
    expect(() => registeredAnswerKeys(named)).toThrow(
      /a middleware the door does not name is on the app: probeMiddleware - /,
    );
  });

  it('keys a route once per method, upper-cased, and a regexp route by its source', () => {
    const t = withRoutes((t) => {
      t.get('/x', (_req, res) => res.end());
      t.post('/x', (_req, res) => res.end());
      t.get(/^\/y.*/, (_req, res) => res.end());
    });
    expect(registeredAnswerKeys(t)).toEqual(['GET /x', 'POST /x', 'GET /^\\/y.*/']);
  });

  it('passes the real app, which is the boot the row ships', () => {
    expect(() => assertAnswersDeclared(app)).not.toThrow();
  });
});

describe('the real app under the reporter', () => {
  let agent: request.Agent;

  beforeAll(async () => {
    await freshTestDb();
    await seedDefaults();
    agent = request.agent(app);
  });

  /**
   * Chained in front of the reporter test/setup.ts installed and put back after, so
   * this case can read what was recorded without taking the setup drain's list away
   * from the rest of the file.
   */
  const recordedBy = async (drive: () => Promise<void>): Promise<string[]> => {
    const previous = app.get(ANSWER_CHECK) as AnswerReporter;
    expect(previous, 'test/setup.ts installs the reporter on the real app').toBeTypeOf('function');
    const mine: string[] = [];
    app.set(ANSWER_CHECK, (mismatch: string) => {
      mine.push(mismatch);
      previous(mismatch);
    });
    try {
      await drive();
    } finally {
      app.set(ANSWER_CHECK, previous);
    }
    return mine;
  };

  it('answers the health and accounts routes with nothing recorded', async () => {
    const recorded = await recordedBy(async () => {
      expect((await agent.get('/api/health')).status).toBe(200);
      expect((await agent.get('/api/accounts')).status).toBe(200);
    });
    expect(recorded).toEqual([]);
  });

  it('reads a HEAD as the GET it is answered by', async () => {
    const recorded = await recordedBy(async () => {
      expect((await agent.head('/api/health')).status).toBe(200);
    });
    expect(recorded).toEqual([]);
  });

  it('holds the refusal envelope on a route the real app refuses', async () => {
    const recorded = await recordedBy(async () => {
      expect((await agent.get('/api/summary?accountId=nope')).status).toBe(404);
    });
    expect(recorded).toEqual([]);
  });
});
