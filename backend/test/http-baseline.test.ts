/**
 * The minimum-budget routes over real HTTP: what a PUT refuses, what it does with the
 * label, what `monthly: null` means, and that editing an amount does not move the line
 * item - the list on the Goal screen is ordered by `sort`, and the app sends only
 * `monthly` when an amount is edited.
 */
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { seedDefaults } from '../src/db';
import { freshTestDb } from './pglite';

interface Item {
  id: number;
  label: string;
  monthly: number;
  sort: number;
}

interface Payload {
  baseCurrency: string;
  items: Item[];
  total: number;
}

let agent: request.Agent;

const put = (body: object) => agent.put('/api/baseline').send(body);

const read = async (): Promise<Payload> => {
  const res = await agent.get('/api/baseline');
  expect(res.status).toBe(200);
  return res.body as Payload;
};

const labels = (p: Payload): string[] => p.items.map((i) => i.label);

const item = (p: Payload, label: string): Item => {
  const found = p.items.find((i) => i.label === label);
  expect(found, `no item labelled ${label}`).toBeDefined();
  return found!;
};

beforeAll(async () => {
  await freshTestDb();
  await seedDefaults();
  agent = request.agent(app);
});

describe('GET /api/baseline', () => {
  it('answers the base currency, no items and a total of zero on a fresh database', async () => {
    expect(await read()).toEqual({ baseCurrency: 'EUR', items: [], total: 0 });
  });
});

describe('PUT /api/baseline', () => {
  it.each([
    ['missing', {}],
    ['blank', { label: '   ' }],
    ['not text', { label: 7 }],
  ])('refuses a label that is %s', async (_what, body) => {
    const res = await put({ ...body, monthly: 100 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'label: non-empty string' });
  });

  it.each([0, -5, 'abc', true])('refuses a monthly of %s', async (monthly) => {
    const res = await put({ label: 'Rent', monthly });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'monthly: a positive number or null' });
  });

  it('the refusals above stored nothing', async () => {
    expect(await read()).toEqual({ baseCurrency: 'EUR', items: [], total: 0 });
  });

  it('creates the item under the trimmed label and answers the whole payload', async () => {
    const res = await put({ label: '  Rent  ', monthly: 800 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({
      baseCurrency: 'EUR',
      items: [{ id: expect.any(Number), label: 'Rent', monthly: 800, sort: 0 }],
      total: 800,
    });
    expect(await read()).toEqual(res.body);
  });

  it('a new item without a sort goes after every existing one', async () => {
    const res = await put({ label: 'Food', monthly: 300 });
    expect(res.status).toBe(200);
    const body = res.body as Payload;
    expect(labels(body)).toEqual(['Rent', 'Food']);
    expect(item(body, 'Food').sort).toBe(1);
    expect(body.total).toBe(1100);
  });

  it('a sort in the body places the item', async () => {
    const res = await put({ label: 'Phone', monthly: 20, sort: -5 });
    expect(res.status).toBe(200);
    const body = res.body as Payload;
    expect(labels(body)).toEqual(['Phone', 'Rent', 'Food']);
    expect(item(body, 'Phone').sort).toBe(-5);
    expect(body.total).toBe(1120);
  });

  it('editing an amount without a sort keeps the item where it was', async () => {
    const res = await put({ label: 'Phone', monthly: 25 });
    expect(res.status).toBe(200);
    const body = res.body as Payload;
    expect(item(body, 'Phone')).toMatchObject({ monthly: 25, sort: -5 });
    expect(labels(body)).toEqual(['Phone', 'Rent', 'Food']);
    expect(body.total).toBe(1125);
  });

  it('monthly null deletes the line item', async () => {
    expect(labels(await read())).toContain('Rent');

    const res = await put({ label: 'Rent', monthly: null });
    expect(res.status).toBe(200);
    const body = res.body as Payload;
    expect(labels(body)).toEqual(['Phone', 'Food']);
    expect(body.total).toBe(325);
    expect(await read()).toEqual(body);
  });

  it('deleting a label no item has is answered with the unchanged payload', async () => {
    const before = await read();
    const res = await put({ label: 'Nothing Here', monthly: null });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(before);
  });

  it('the total is the sum of the items', async () => {
    const body = await read();
    expect(body.total).toBe(body.items.reduce((sum, i) => sum + i.monthly, 0));
    expect(body.items.length).toBe(2);
  });
});
