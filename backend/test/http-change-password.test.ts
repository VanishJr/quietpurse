/**
 * A password change over real HTTP.
 *
 * better-auth serves the endpoint; what is not visible below the wire is whether
 * the other sessions really stop working, and whether the replacement cookie it
 * sets lands through this app's toNodeHandler mount and carries a usable workspace.
 * The second half is the one that decides whether any repair machinery is needed
 * after a change - measured here rather than assumed, so none gets built.
 *
 * Its own users on purpose: http-auth.test.ts registers alice and bob once and
 * reuses their agents, and revokeOtherSessions deletes every session a user has -
 * a change on a shared account would kill an agent in a test about something else.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { initAuth } from '../src/auth';
import { dbInstance, setWorkspaceFallback } from '../src/db';
import { TEST_WORKSPACE_ID } from './pglite';

const OLD_PASSWORD = 'correct-horse-battery';
const NEW_PASSWORD = 'staple-battery-horse';

async function signUp(email: string) {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/auth/sign-up/email')
    .send({ email, password: OLD_PASSWORD, name: email.split('@')[0] });
  expect(res.status, `sign-up failed: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  return agent;
}

async function signIn(email: string, password: string) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/sign-in/email').send({ email, password });
  expect(res.status, `sign-in failed: ${JSON.stringify(res.body)}`).toBeLessThan(300);
  return agent;
}

const changePassword = (agent: request.Agent, currentPassword: string, newPassword: string) =>
  agent
    .post('/api/auth/change-password')
    .send({ currentPassword, newPassword, revokeOtherSessions: true });

beforeAll(() => {
  initAuth(dbInstance());
  // as in http-auth.test.ts: armed, a request that never entered a workspace context
  // would answer from the test workspace instead of throwing, and the marker below
  // would prove nothing
  setWorkspaceFallback(undefined);
});

afterAll(() => {
  // process-wide - the rest of the run expects it armed
  setWorkspaceFallback(TEST_WORKSPACE_ID);
});

describe('changing the password', () => {
  it('ends the other sessions and leaves the one that made the change working', async () => {
    const changer = await signUp('changer@example.com');
    const elsewhere = await signIn('changer@example.com', OLD_PASSWORD);
    expect((await elsewhere.get('/api/accounts')).status).toBe(200);

    // a marker only this workspace can answer with: /api/accounts alone answers []
    // for a fresh user, which a request landing in the wrong workspace would too
    const marked = await changer.patch('/api/app-settings').send({ ownerNames: ['Changer Marker'] });
    expect(marked.status, JSON.stringify(marked.body)).toBe(200);

    const changed = await changePassword(changer, OLD_PASSWORD, NEW_PASSWORD);
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);

    // the reason the flag is sent at all: somebody else signed in as you stops being
    // signed in as you
    expect((await elsewhere.get('/api/accounts')).status).toBe(401);

    const mine = await changer.get('/api/accounts');
    expect(mine.status).toBe(200);
    expect((await changer.get('/api/app-settings')).body.ownerNames).toEqual(['Changer Marker']);
  });

  it('makes the new password the only one that signs in', async () => {
    const agent = await signUp('rotates@example.com');
    expect((await changePassword(agent, OLD_PASSWORD, NEW_PASSWORD)).status).toBe(200);

    await signIn('rotates@example.com', NEW_PASSWORD);

    const refused = await request(app)
      .post('/api/auth/sign-in/email')
      .send({ email: 'rotates@example.com', password: OLD_PASSWORD });
    expect(refused.status).toBe(401);
  });

  /**
   * The wire contract the client's two branches are keyed on. A 400 is a clean
   * refusal because every BAD_REQUEST in the handler is thrown above the write - if
   * better-auth ever reorders those lines, or renames the code, this goes red rather
   * than the client quietly reporting an unknown outcome as "wrong password".
   */
  it('refuses a wrong current password with a 400 and INVALID_PASSWORD, having written nothing', async () => {
    const agent = await signUp('mistypes@example.com');

    const res = await changePassword(agent, 'not-my-password', NEW_PASSWORD);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PASSWORD');
    // the refusal really did not reach the write
    await signIn('mistypes@example.com', OLD_PASSWORD);
    // and this session was never revoked either
    expect((await agent.get('/api/accounts')).status).toBe(200);
  });
});
