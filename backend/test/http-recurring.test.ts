/**
 * Hiding a recurring group over HTTP. The detector and the data
 * layer's hide are held in db.test.ts; what is worth asserting here is the payload
 * the route answers with - the group still listed once hidden, and the monthly total
 * that stops counting it - because Settings renders that answer directly.
 *
 * The dates are built from today: the route reads a fixed window back from now, so
 * a literal year is green until it is not, for a reason nobody connects to this file.
 */
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { RecurringGroup, applyClassification, insertTransactions, seedDefaults } from '../src/db';
import { NewTransaction } from '../src/types';
import { idOf } from './helpers';
import { freshTestDb } from './pglite';

const RENT = 900;
/** The last three whole months: well inside the window the route reads. */
const DELTAS = [-3, -2, -1];

const now = new Date();
const monthStartAt = (delta: number): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + delta, 1));
/** "Miete 03/2026" for the month `delta` months from this one: digits the group key collapses. */
const rentLine = (delta: number): string => {
  const d = monthStartAt(delta);
  return `Miete ${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
};

/** What GET /api/recurring and the ignore route answer. */
interface RecurringSummary {
  baseCurrency: string;
  monthlyTotal: number;
  groups: RecurringGroup[];
}

let agent: request.Agent;

const recurring = async (): Promise<RecurringSummary> => {
  const res = await agent.get('/api/recurring');
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as RecurringSummary;
};

const rentGroup = (payload: RecurringSummary) =>
  payload.groups.find((g) => g.description.startsWith('Miete'));

const ignore = (body: object) => agent.post('/api/recurring/ignore').send(body);

beforeAll(async () => {
  await freshTestDb();
  await seedDefaults();
  agent = request.agent(app);
  const created = await agent.post('/api/accounts').send({ name: 'Rent Bank', currency: 'EUR' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const accountId = created.body.id as string;

  const tx = (delta: number): NewTransaction => ({
    accountId,
    provider: 'upload',
    amount: -RENT,
    currency: 'EUR',
    date: monthStartAt(delta).toISOString(),
    description: rentLine(delta),
    category: 'housing',
    fee: null,
  });
  await insertTransactions(DELTAS.map(tx));
  // recurring is the classifier's column, not the insert's; the base currency is EUR
  // in the suite, so these rows carry the base amount the group needs
  await applyClassification(
    await Promise.all(
      DELTAS.map(async (delta) => ({
        id: await idOf(rentLine(delta)),
        category: 'housing',
        transfer: false,
        refund: false,
        incomeSource: null,
        recurring: true,
      })),
    ),
  );

  const before = await recurring();
  expect(rentGroup(before)).toMatchObject({ months: 3, monthlyAvg: RENT, ignored: false });
  expect(before.monthlyTotal).toBe(RENT);
});

describe('POST /api/recurring/ignore', () => {
  it('hides the group: still listed, marked, and out of the monthly total', async () => {
    const res = await ignore({ description: rentLine(-3), ignored: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const payload = res.body as RecurringSummary;
    expect(rentGroup(payload)).toMatchObject({ monthlyAvg: RENT, ignored: true });
    expect(payload.monthlyTotal).toBe(0);
  });

  /** Its own case: a handler writing a literal `true` is invisible to the one above. */
  it('shows the group again, and the total counts it again', async () => {
    expect(rentGroup((await ignore({ description: rentLine(-3), ignored: true })).body)).toMatchObject({
      ignored: true,
    });

    const res = await ignore({ description: rentLine(-1), ignored: false });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const payload = res.body as RecurringSummary;
    expect(rentGroup(payload)).toMatchObject({ monthlyAvg: RENT, ignored: false });
    expect(payload.monthlyTotal).toBe(RENT);
  });

  it.each([
    ['no description', { ignored: true }],
    ['a blank description', { description: '   ', ignored: true }],
  ])('refuses %s', async (_what, body) => {
    const res = await ignore(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'description field required' });
  });

  it('refuses an ignored that is not a boolean', async () => {
    const res = await ignore({ description: rentLine(-1), ignored: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'ignored field required: true | false' });
  });
});
