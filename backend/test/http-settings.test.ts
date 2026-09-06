/**
 * The settings routes over real HTTP. The clamps are settings.test.ts; this file holds
 * the door: that what a PATCH answers is what was stored, and that a body the module
 * does not know changes nothing.
 */
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { seedDefaults } from '../src/db';
import { freshTestDb } from './pglite';

const DEFAULTS = {
  bufferPct: 10,
  windowMonths: 6,
  hourlyRate: null,
  hoursCapPerWeek: 20,
  goalMode: 'baseline',
};

let agent: request.Agent;

beforeAll(async () => {
  await freshTestDb();
  await seedDefaults();
  agent = request.agent(app);
});

describe('GET /api/settings', () => {
  it('answers the defaults on a fresh database', async () => {
    const res = await agent.get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(DEFAULTS);
  });
});

describe('PATCH /api/settings', () => {
  it('echoes the stored object - clamped, not as sent - and GET agrees', async () => {
    const res = await agent
      .patch('/api/settings')
      .send({ bufferPct: 150, hourlyRate: 45.5, goalMode: 'lifestyle' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      bufferPct: 100,
      windowMonths: 6,
      hourlyRate: 45.5,
      hoursCapPerWeek: 20,
      goalMode: 'lifestyle',
    });
    expect((await agent.get('/api/settings')).body).toEqual(res.body);
  });

  it('a body with an unknown key changes nothing', async () => {
    const before = (await agent.get('/api/settings')).body;
    expect(before.goalMode).toBe('lifestyle');

    const res = await agent.patch('/api/settings').send({ theme: 'dark' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(before);
    expect((await agent.get('/api/settings')).body).toEqual(before);
  });
});
