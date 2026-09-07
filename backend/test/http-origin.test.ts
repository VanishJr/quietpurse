/**
 * Where a request is allowed to come from (row 72, FIXES finding 4).
 *
 * This is the whole boundary. Row 72 deleted the sign-in, the session middleware and
 * the CORS allowlist, and after it the only thing between a person's finances and a
 * page they happen to visit is this check - so it is held over real HTTP, header by
 * header, and each header is asserted on its own rather than through a request that
 * would fail three ways at once.
 *
 * The three refusals are independent by construction: a bad Host with nothing else
 * wrong, a bad Origin with a good Host, and a cross-site write with both of those
 * good. A guard that only checked one of them would be green on a table that varied
 * all three together.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app';
import { config } from '../src/config';
import { seedDefaults } from '../src/db';
import { freshTestDb } from './pglite';

let agent: request.Agent;

/**
 * The sentence is asserted by equality wherever a refusal is checked: it must name no
 * header, no address and no route, because it is read by a person whose browser sent
 * something they never chose.
 */
const REFUSAL =
  'this request did not come from Finto on this machine, so nothing was read or changed - open the app at the address the server printed when it started';

beforeAll(async () => {
  await freshTestDb();
  await seedDefaults();
  agent = request.agent(app);
});

describe('the request has to have come from this machine', () => {
  it('serves the app its own request, which carries a loopback Host and no Origin', async () => {
    const res = await agent.get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  /**
   * DNS rebinding, and the reason the rule is about names rather than about a list of
   * three addresses: everything else in a rebound request is genuinely same-origin,
   * and the attacker's own name in Host is the only part of it that is still theirs.
   */
  it.each(['evil.example', 'evil.example:4000', 'finto.localhost', 'localhost.evil.example'])(
    'refuses a request whose Host is the name %j',
    async (host) => {
      const res = await agent.get('/api/health').set('Host', host);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe(REFUSAL);
    },
  );

  it.each(['localhost', 'localhost:4000', '127.0.0.1:4000', '127.1.2.3', '[::1]:4000'])(
    'serves a request whose Host is %j',
    async (host) => {
      const res = await agent.get('/api/health').set('Host', host);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    },
  );

  it.each(['[evil.example]', '[evil:example]:4000', '[not-hex::zz]'])(
    'refuses %j on the default bind, like every other name',
    async (host) => {
      const res = await agent.get('/api/health').set('Host', host);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe(REFUSAL);
    },
  );
});

/**
 * `FINTO_HOST=0.0.0.0` — the documented way to open the port so a phone on the same Wi-Fi
 * can reach it. The whole arm is unreachable on the loopback default, so without this
 * block the rule that governs the OPEN configuration would be held by nothing.
 *
 * What widens is exactly one thing: an address as well as a loopback name. A DNS name
 * is refused in both configurations, which is the half rebinding needs, and brackets
 * are not what makes something an address.
 */
describe('with FINTO_HOST set, an address is accepted and a name still is not', () => {
  const restore = config.host;
  beforeAll(() => {
    config.host = '0.0.0.0';
  });
  afterAll(() => {
    config.host = restore;
  });

  it.each(['192.168.1.5:4000', '10.4.115.7', '[fe80::1]:4000', '[::1]:4000', 'localhost'])(
    'serves a request whose Host is %j',
    async (host) => {
      const res = await agent.get('/api/health').set('Host', host);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    },
  );

  it.each(['evil.example', 'phone.local:4000', '[evil.example]', '[evil:example]', '[not-hex::zz]'])(
    'still refuses a request whose Host is %j',
    async (host) => {
      const res = await agent.get('/api/health').set('Host', host);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe(REFUSAL);
    },
  );

  it('takes an Origin on the same widened rule, and refuses a named one', async () => {
    expect((await agent.get('/api/health').set('Origin', 'http://192.168.1.5:4000')).status).toBe(200);
    expect((await agent.get('/api/health').set('Origin', 'https://evil.example')).status).toBe(403);
  });

  /**
   * A GET is enough to show the Origin rule on its own: this request's Host is
   * loopback and it carries no Sec-Fetch-Site, so the only thing wrong with it is
   * the Origin, and a guard that had dropped that clause would answer 200.
   */
  it.each([
    'https://evil.example',
    'http://evil.example:4000',
    'null',
    'not a url',
  ])('refuses a request whose Origin is %j', async (origin) => {
    const res = await agent.get('/api/health').set('Origin', origin);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(REFUSAL);
  });

  it.each(['http://localhost:4000', 'http://127.0.0.1:5173', 'http://[::1]:4000'])(
    'serves a request whose Origin is %j',
    async (origin) => {
      const res = await agent.get('/api/health').set('Origin', origin);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    },
  );

  /**
   * The cross-origin form post, which needs no rebind: multipart/form-data is
   * CORS-safelisted, so the browser sends it and the write lands. Held on a route
   * that writes, with a Host and an Origin that both pass, so Sec-Fetch-Site is the
   * only thing refusing it.
   */
  it('refuses a cross-site write while its Host and Origin are both this server', async () => {
    const res = await agent
      .post('/api/accounts')
      .set('Origin', 'http://localhost:4000')
      .set('Sec-Fetch-Site', 'cross-site')
      .send({ name: 'Cross Site Bank', currency: 'EUR' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(REFUSAL);
  });

  it('serves a same-origin write carrying the same header', async () => {
    const res = await agent
      .post('/api/accounts')
      .set('Origin', 'http://localhost:4000')
      .set('Sec-Fetch-Site', 'same-origin')
      .send({ name: 'Same Origin Bank', currency: 'EUR' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  /**
   * A read is left alone by the Sec-Fetch-Site clause on purpose: a cross-site GET
   * cannot read what it gets back, and the two headers above are what answer a
   * rebound one. Asserted so that tightening it later is a decision somebody makes
   * rather than a case that quietly starts passing.
   */
  it('serves a cross-site read, which the other two headers are what answer', async () => {
    const res = await agent.get('/api/health').set('Sec-Fetch-Site', 'cross-site');
    expect(res.status).toBe(200);
  });

  /**
   * Every /api route, and health with them: it is the route most likely to be waved
   * through as harmless, and an exemption there is the precedent for the next one.
   * Checked against a route that reads data too, so "the guard is mounted" is not
   * held by one path.
   */
  it.each(['/api/health', '/api/accounts', '/api/imports', '/api/backup'])(
    'covers %s',
    async (route) => {
      const res = await agent.get(route).set('Host', 'evil.example');
      expect(res.status).toBe(403);
      expect(res.body.error).toBe(REFUSAL);
    },
  );
});

/**
 * Which variable opens the port, held behaviourally rather than by reading the source.
 *
 * `HOST` is a name shells, container images and PaaS wrappers set for their own
 * reasons. Reading it would let an environment nobody wrote for this app bind every
 * interface AND widen the Host rule to any address literal, with no line typed by the
 * owner. The namespaced name is the whole defence, so the arm that matters is the
 * second case: HOST set and ignored.
 */
describe('the variable that opens the port', () => {
  const load = async (vars: { HOST?: string; FINTO_HOST?: string }): Promise<string> => {
    const saved = { HOST: process.env.HOST, FINTO_HOST: process.env.FINTO_HOST };
    const put = (k: 'HOST' | 'FINTO_HOST', v?: string): void => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    put('HOST', vars.HOST);
    put('FINTO_HOST', vars.FINTO_HOST);
    try {
      vi.resetModules();
      return (await import('../src/config')).config.host;
    } finally {
      put('HOST', saved.HOST);
      put('FINTO_HOST', saved.FINTO_HOST);
      vi.resetModules();
    }
  };

  it('is FINTO_HOST', async () => {
    expect(await load({ FINTO_HOST: '0.0.0.0' })).toBe('0.0.0.0');
  });

  it('is not HOST, whatever other software set it to', async () => {
    expect(await load({ HOST: '0.0.0.0' })).toBe('127.0.0.1');
  });
});
