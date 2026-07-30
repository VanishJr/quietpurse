/**
 * PATCH /api/app-settings over real HTTP.
 *
 * The subject is the status code a client sees, so this drives the route rather
 * than updateAppSettings directly: the defect being pinned was a 200 answered on a
 * change that never happened, and only the route can be wrong about that.
 */
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { initAuth } from '../src/auth';
import { dbInstance } from '../src/db';

let agent: request.Agent;

beforeAll(async () => {
  initAuth(dbInstance());
  agent = request.agent(app);
  const res = await agent
    .post('/api/auth/sign-up/email')
    .send({ email: 'settings@example.com', password: 'correct-horse-battery', name: 'settings' });
  expect(res.status, `sign-up failed: ${JSON.stringify(res.body)}`).toBeLessThan(300);
});

const settings = async () => (await agent.get('/api/app-settings')).body;

describe('PATCH /api/app-settings refuses what it cannot store', () => {
  it('a currency that is not a three-letter code is refused, not dropped', async () => {
    const before = await settings();

    const res = await agent.patch('/api/app-settings').send({ baseCurrency: 'EURO' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/baseCurrency/);

    // the point of the 400: a 200 here would have told the client it was saved
    expect((await settings()).baseCurrency).toBe(before.baseCurrency);
  });

  it('ownerNames that is not an array of strings is refused', async () => {
    const res = await agent.patch('/api/app-settings').send({ ownerNames: 'Yurii' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ownerNames/);
    expect((await settings()).ownerNames).toEqual([]);
  });

  it('an absent key still means "leave it alone"', async () => {
    const before = await settings();

    const res = await agent.patch('/api/app-settings').send({ ownerNames: ['Yurii Kalvenko'] });
    expect(res.status).toBe(200);
    expect(res.body.ownerNames).toEqual(['Yurii Kalvenko']);
    expect(res.body.baseCurrency).toBe(before.baseCurrency);
  });

  it('a valid currency is stored and echoed back uppercased', async () => {
    const res = await agent.patch('/api/app-settings').send({ baseCurrency: 'usd' });
    expect(res.status).toBe(200);
    expect(res.body.baseCurrency).toBe('USD');
    expect((await settings()).baseCurrency).toBe('USD');
  });
});
