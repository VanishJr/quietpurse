/**
 * GET /api/conversion: what a client waits on after a base-currency change, whose
 * answer comes back with every converted amount reset and the refill still running.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app';
import { insertTransactions, seedDefaults } from '../src/db';
import { NewTransaction } from '../src/types';
import { type Agent, serve } from './loopback';
import { freshTestDb } from './pglite';

let agent: Agent;

const conversion = async () => {
  const res = await agent.get('/api/conversion');
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as { baseCurrency: string; converting: boolean; unconverted: number };
};

beforeAll(async () => {
  await freshTestDb();
  await seedDefaults();
  agent = await serve(app);
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
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      if (offline) return Promise.reject(new Error('network disabled in tests'));
      const signal = init?.signal;
      return new Promise<Response>((_, reject) => {
        held.push(() => reject(new Error('network disabled in tests')));
        signal?.addEventListener('abort', () => reject(signal.reason));
      });
    }) as typeof fetch;
    try {
      const patched = await agent.patch('/api/app-settings').send({ baseCurrency: 'USD' });
      expect(patched.status, JSON.stringify(patched.body)).toBe(200);
      // no count yet: the refill fills the base-currency rows after this answer, and on
      // Postgres this read can land first; they are filled before its first rate call
      expect(await conversion()).toMatchObject({ baseCurrency: 'USD', converting: true });

      await vi.waitFor(() => expect(held.length).toBeGreaterThan(0));
      expect(await conversion()).toEqual({ baseCurrency: 'USD', converting: true, unconverted: 1 });
      offline = true;
      for (const fail of held) fail();
      await vi.waitFor(async () => expect((await conversion()).converting).toBe(false));
      expect(await conversion()).toEqual({ baseCurrency: 'USD', converting: false, unconverted: 1 });
    } finally {
      for (const fail of held) fail();
      globalThis.fetch = realFetch;
    }
  });
});
