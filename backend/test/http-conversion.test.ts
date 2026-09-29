/**
 * GET /api/conversion: what a client waits on after a base-currency change, whose
 * answer comes back with every converted amount reset and the refill still running.
 */
import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app';
import { insertTransactions, seedDefaults } from '../src/db';
import { NewTransaction } from '../src/types';
import { freshTestDb } from './pglite';

let agent: request.Agent;

const conversion = async () => {
  const res = await agent.get('/api/conversion');
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as { baseCurrency: string; converting: boolean; unconverted: number };
};

beforeAll(async () => {
  await freshTestDb();
  await seedDefaults();
  agent = request.agent(app);
  const created = await agent.post('/api/accounts').send({ name: 'Two Currencies', currency: 'EUR' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const tx = (currency: string, description: string): NewTransaction => ({
    accountId: created.body.id as string,
    provider: 'upload',
    amount: -12.5,
    currency,
    date: '2026-05-04T09:00:00.000Z',
    description,
    category: 'other',
    fee: null,
  });
  await insertTransactions([tx('EUR', 'Euro row'), tx('USD', 'Dollar row')]);
});

describe('GET /api/conversion', () => {
  it('counts the rows still without a base amount while nothing is refilling them', async () => {
    expect(await conversion()).toEqual({ baseCurrency: 'EUR', converting: false, unconverted: 1 });
  });

  it('says a refill is running from the answer that started it until it stops, and what it left', async () => {
    const realFetch = globalThis.fetch;
    const held: (() => void)[] = [];
    let offline = false;
    globalThis.fetch = (() =>
      offline
        ? Promise.reject(new Error('network disabled in tests'))
        : new Promise<Response>((_, reject) => {
            held.push(() => reject(new Error('network disabled in tests')));
          })) as typeof fetch;
    try {
      const patched = await agent.patch('/api/app-settings').send({ baseCurrency: 'USD' });
      expect(patched.status, JSON.stringify(patched.body)).toBe(200);
      expect(await conversion()).toEqual({ baseCurrency: 'USD', converting: true, unconverted: 1 });

      await vi.waitFor(() => expect(held.length).toBeGreaterThan(0));
      offline = true;
      for (const fail of held) fail();
      await vi.waitFor(async () => expect((await conversion()).converting).toBe(false));
      expect(await conversion()).toEqual({ baseCurrency: 'USD', converting: false, unconverted: 1 });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
