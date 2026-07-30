/**
 * The session middleware, over real HTTP.
 *
 * tenant-isolation.test.ts proves the data layer scopes every query to a workspace. It
 * cannot prove the part that decides WHICH workspace: that lives in app.ts, runs
 * only on a request, and is what actually stands between two users' finances. So
 * this suite drives the whole chain - better-auth cookie, membership lookup,
 * runWithWorkspace, route - through supertest, with two users registered the way
 * real ones would be.
 *
 * The process-wide test fallback is cleared for the duration: with it armed, a
 * request that never entered a workspace context would silently answer from the
 * test workspace instead of throwing, which is the exact bug this file exists to
 * catch.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { initAuth } from '../src/auth';
import { config } from '../src/config';
import { dbInstance, setWorkspaceFallback } from '../src/db';
import { TEST_WORKSPACE_ID } from './pglite';

/** A two-row statement, enough to give a workspace data of its own. */
const csvFor = (label: string, amount: string) =>
  ['date,amount,description', `2026-03-01,-${amount},${label} groceries`, `2026-03-02,${amount},${label} salary`].join(
    '\n',
  );

/** Registers a user and returns an agent that carries their session cookie. */
async function signUp(email: string) {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/auth/sign-up/email')
    .send({ email, password: 'correct-horse-battery', name: email.split('@')[0] });
  expect(res.status, `sign-up failed: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  return agent;
}

let alice: request.Agent;
let bob: request.Agent;

beforeAll(async () => {
  initAuth(dbInstance());
  setWorkspaceFallback(undefined);

  alice = await signUp('alice@example.com');
  bob = await signUp('bob@example.com');

  for (const [agent, label] of [
    [alice, 'alice'],
    [bob, 'bob'],
  ] as const) {
    const res = await agent
      .post('/api/imports')
      .field('accountName', `${label} bank`)
      .field('currency', 'EUR')
      .field('preset', 'generic')
      .attach(
        'file',
        Buffer.from(csvFor(label, label === 'alice' ? '10.00' : '77.00'), 'utf8'),
        'statement.csv',
      );
    expect(res.status, `import failed: ${JSON.stringify(res.body)}`).toBe(200);
    // an upload only stages: nothing is this workspace's data until it is confirmed
    const confirmed = await agent.post(`/api/imports/${res.body.summary.importId}/confirm`);
    expect(confirmed.status, `confirm failed: ${JSON.stringify(confirmed.body)}`).toBe(200);
    expect(confirmed.body.inserted).toBe(2);
  }
});

afterAll(() => {
  // the fallback is process-wide - the rest of the run expects it armed
  setWorkspaceFallback(TEST_WORKSPACE_ID);
});

describe('API requires a session', () => {
  it('health is open and reports the signup mode', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, signup: 'open' });
  });

  it('every data route answers 401 without a session', async () => {
    for (const [method, path] of [
      ['get', '/api/accounts'],
      ['get', '/api/transactions'],
      ['get', '/api/summary'],
      ['get', '/api/app-settings'],
      ['get', '/api/backup'],
      ['post', '/api/sync'],
    ] as const) {
      const res = await request(app)[method](path);
      expect(res.status, `${method.toUpperCase()} ${path}`).toBe(401);
      expect(res.body.error).toMatch(/sign in required/);
    }
  });

  it('a forged session cookie is not accepted', async () => {
    const res = await request(app)
      .get('/api/accounts')
      .set('Cookie', 'better-auth.session_token=not-a-real-token');
    expect(res.status).toBe(401);
  });
});

describe('two users on one server', () => {
  it('each sees only their own accounts', async () => {
    const a = await alice.get('/api/accounts');
    const b = await bob.get('/api/accounts');
    expect(a.body.map((x: { name: string }) => x.name)).toEqual(['alice bank']);
    expect(b.body.map((x: { name: string }) => x.name)).toEqual(['bob bank']);
  });

  it('each sees only their own transactions, and totals do not mix', async () => {
    const a = await alice.get('/api/transactions?limit=100');
    const b = await bob.get('/api/transactions?limit=100');
    expect(a.body).toHaveLength(2);
    expect(b.body).toHaveLength(2);
    for (const t of a.body) expect(t.description).toMatch(/alice/);
    for (const t of b.body) expect(t.description).toMatch(/bob/);
    // amounts differ per user: a leak would show up as the other's number
    expect(a.body.map((t: { amount: number }) => Math.abs(t.amount)).sort()).toEqual([10, 10]);
    expect(b.body.map((t: { amount: number }) => Math.abs(t.amount)).sort()).toEqual([77, 77]);
  });

  it("one user cannot reach the other's transaction by id", async () => {
    const theirs = (await bob.get('/api/transactions?limit=100')).body[0] as { id: string };
    const res = await alice.patch(`/api/transactions/${theirs.id}/transfer`).send({ transfer: true });
    expect(res.status).toBe(404);
    // and the row really is untouched in bob's workspace
    const after = (await bob.get('/api/transactions?limit=100')).body as { id: string; transfer: boolean }[];
    expect(after.find((t) => t.id === theirs.id)!.transfer).toBe(false);
  });

  it("a backup contains only the requesting user's data", async () => {
    const res = await alice.get('/api/backup');
    expect(res.status).toBe(200);
    const data = JSON.parse(res.text) as { tables: Record<string, { description?: string }[]> };
    expect(data.tables.transactions).toHaveLength(2);
    for (const t of data.tables.transactions) expect(t.description).toMatch(/alice/);
  });

  it('a fresh user does not inherit the operator\'s OWNER_NAMES from .env', async () => {
    // the regression this guards: seedDefaults used to copy the server operator's
    // household names into every workspace, mis-tagging strangers' transfers and
    // showing them the operator's relatives in the settings screen
    for (const agent of [alice, bob]) {
      const res = await agent.get('/api/app-settings');
      expect(res.status).toBe(200);
      expect(res.body.ownerNames).toEqual([]);
    }
  });
});

describe('the organization plugin is not a public API', () => {
  // Mounting the plugin publishes its whole REST surface under /api/auth. Two of
  // those endpoints matter: create makes a workspace seedDefaults() never ran on,
  // delete cascades away every transaction a user owns in one request.
  it('a signed-in user cannot reach its endpoints', async () => {
    for (const path of [
      '/api/auth/organization/create',
      '/api/auth/organization/delete',
      '/api/auth/organization/invite-member',
    ]) {
      const res = await alice.post(path).send({ name: 'sneaky', slug: 'sneaky', organizationId: 'x' });
      expect(res.status, path).toBe(404);
    }
  });

  it('closing it breaks neither the session nor the workspace scope', async () => {
    expect((await alice.get('/api/auth/get-session')).status).toBe(200);
    expect((await alice.get('/api/accounts')).status).toBe(200);
  });
});

describe('registration gate', () => {
  it('rejects sign-up without the invite code once one is configured', async () => {
    const before = config.signupInviteCode;
    config.signupInviteCode = 'let-me-in';
    try {
      const denied = await request(app)
        .post('/api/auth/sign-up/email')
        .send({ email: 'stranger@example.com', password: 'correct-horse-battery', name: 'stranger' });
      expect(denied.status).toBe(403);
      expect(denied.body.error).toMatch(/invite-only/);

      const allowed = await request(app)
        .post('/api/auth/sign-up/email')
        .set('x-invite-code', 'let-me-in')
        .send({ email: 'invited@example.com', password: 'correct-horse-battery', name: 'invited' });
      expect(allowed.status).toBeLessThan(300);

      // health advertises the mode so the sign-up form can ask for a code
      expect((await request(app).get('/api/health')).body.signup).toBe('invite');
    } finally {
      config.signupInviteCode = before;
    }
  });

  it('signing in still works while the gate is up', async () => {
    const before = config.signupInviteCode;
    config.signupInviteCode = 'let-me-in';
    try {
      const res = await request(app)
        .post('/api/auth/sign-in/email')
        .send({ email: 'alice@example.com', password: 'correct-horse-battery' });
      expect(res.status).toBeLessThan(300);
    } finally {
      config.signupInviteCode = before;
    }
  });
});
