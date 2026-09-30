/**
 * PATCH /api/app-settings over real HTTP.
 *
 * The subject is the status code a client sees, so this drives the route rather
 * than updateAppSettings directly: the defect being pinned was a 200 answered on a
 * change that never happened, and only the route can be wrong about that.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { seedDefaults } from '../src/db';
import { type Agent, serve } from './loopback';
import { freshTestDb } from './pglite';

let agent: Agent;

/**
 * Everything asserted below is exact, so the file starts from an empty database. The
 * setup file already truncates and seeds before every file; this pair is here anyway,
 * so the exactness rests on a line in this file rather than on a setup file this one
 * does not name.
 */
beforeAll(async () => {
  await freshTestDb();
  await seedDefaults();
  agent = await serve(app);
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
    const before = await settings();

    const res = await agent.patch('/api/app-settings').send({ ownerNames: 'Yurii' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ownerNames/);
    expect((await settings()).ownerNames).toEqual(before.ownerNames);
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
