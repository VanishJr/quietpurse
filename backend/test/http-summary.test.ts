/**
 * Both summary routes over real HTTP: what `?accountId=` does, and what it refuses.
 *
 * Driven through supertest, because everything worth asserting here is the wire -
 * the status code, the sentence each refusal composes, and which currency field the
 * body carries. A per-account body that answered `baseCurrency` would render a UAH
 * figure labelled EUR, and nothing below the route can see that.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { seedDefaults } from '../src/db';
import { freshTestDb } from './pglite';

const FROM = '2026-01-01';
const TO = '2026-12-31';
const WINDOW = `from=${FROM}&to=${TO}`;

const EXPENSE = 10;
const INCOME = 100;

/** the day the income row is dated, and the single-day window asked about below */
const INCOME_DAY = '2026-03-02';

/** The account whose currency is not the base one, and the row the file said was EUR. */
const FOREIGN_EXPENSE = 50;
const FOREIGN_BASE_EXPENSE = 25;

/** Both routes take the same parameter and must refuse it the same way. */
const ROUTES = ['/api/summary', '/api/summary/months'];

const statement = Buffer.from(
  [
    'date,amount,description',
    `2026-03-01,-${EXPENSE}.00,REWE Berlin`,
    `${INCOME_DAY},${INCOME}.00,Gehalt Maerz`,
  ].join('\n'),
  'utf8',
);

/**
 * A currency column, so one row of a UAH account is in EUR - the generic mapping
 * reads it (providers/csv.ts) and rowCurrency prefers it over the account's, which
 * is the reachable path to a mixed account and the only reason otherCurrencies
 * exists.
 */
const mixedStatement = Buffer.from(
  [
    'date,amount,description,currency',
    `2026-03-01,-${FOREIGN_EXPENSE}.00,Kyiv taxi,UAH`,
    `2026-03-02,-${FOREIGN_BASE_EXPENSE}.00,Berlin coffee,EUR`,
  ].join('\n'),
  'utf8',
);

let agent: request.Agent;
let walletId: string;
let foreignId: string;

const makeAccount = async (a: request.Agent, name: string, currency = 'EUR'): Promise<string> => {
  const res = await a.post('/api/accounts').send({ name, currency });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
};

const importCsv = async (a: request.Agent, accountId: string, file: Buffer): Promise<void> => {
  const staged = await a
    .post('/api/imports')
    .field('accountId', accountId)
    .attach('file', file, 'statement.csv');
  expect(staged.status, JSON.stringify(staged.body)).toBe(200);
  const confirmed = await a.post(`/api/imports/${staged.body.summary.importId}/confirm`);
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
};

/**
 * Two accounts in one database, so every figure over every account is the sum of
 * both: the wallet's rows, and the one row of the hryvnia account that the file
 * declared in EUR - the hryvnia row itself has no rate and counts nowhere but on
 * its own account's arm.
 */
const ALL_EXPENSE = EXPENSE + FOREIGN_BASE_EXPENSE;

/**
 * Everything asserted below is exact, so the file starts from an empty database. The
 * setup file already truncates and seeds before every file; this pair is here anyway,
 * so the exactness rests on a line in this file rather than on a setup file this one
 * does not name.
 */
beforeAll(async () => {
  await freshTestDb();
  await seedDefaults();
  agent = request.agent(app);

  walletId = await makeAccount(agent, 'Wallet');
  foreignId = await makeAccount(agent, 'Hryvnia', 'UAH');

  await importCsv(agent, walletId, statement);
  await importCsv(agent, foreignId, mixedStatement);
});

describe('GET /api/summary', () => {
  /**
   * The wire's word for the all-accounts scope, named on its own line so a reader
   * sees what the client narrows on. It is NOT the only holder and cannot fail by
   * itself: the case below asserts the same literal inside a whole body, and three
   * more do further down, so a rename reds all of them together.
   */
  it('names the all-accounts scope by its exact wire literal', async () => {
    const res = await agent.get(`/api/summary?${WINDOW}`);
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('all');
  });

  it('answers every account in the base currency when no account is named', async () => {
    const res = await agent.get(`/api/summary?${WINDOW}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      scope: 'all',
      from: FROM,
      to: TO,
      baseCurrency: 'EUR',
      totals: { expense: ALL_EXPENSE, income: INCOME },
    });
    // the unit is named once per body: no account arm field leaks onto this one
    expect(res.body).not.toHaveProperty('currency');
    expect(res.body).not.toHaveProperty('accountId');
    expect(res.body).not.toHaveProperty('otherCurrencies');
  });

  it('answers one account in the account’s own currency when one is named', async () => {
    const res = await agent.get(`/api/summary?accountId=${walletId}&${WINDOW}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      scope: 'account',
      from: FROM,
      to: TO,
      accountId: walletId,
      currency: 'EUR',
      otherCurrencies: [],
      totals: { expense: EXPENSE, income: INCOME },
    });
    // and there is no base currency on it to read the figures against
    expect(res.body).not.toHaveProperty('baseCurrency');
  });
});

describe('GET /api/summary/months', () => {
  it('answers the chart over every account with the independence figures on it', async () => {
    const res = await agent.get(`/api/summary/months?${WINDOW}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ scope: 'all', baseCurrency: 'EUR' });
    expect(res.body.months).toHaveLength(1);
    expect(res.body.months[0]).toMatchObject({
      month: '2026-03',
      expense: ALL_EXPENSE,
      income: INCOME,
      expenseOneOff: 0,
    });
  });

  /**
   * The exact shape the client reads, pinned to numbers: a SUM comes back as a
   * string from node-postgres and as a number from PGlite, and a missing Number()
   * at the boundary is green on one driver and red on the other.
   */
  it('answers the account chart with net, and no independence figures', async () => {
    const res = await agent.get(`/api/summary/months?accountId=${walletId}&${WINDOW}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      scope: 'account',
      accountId: walletId,
      currency: 'EUR',
      otherCurrencies: [],
    });
    expect(res.body).not.toHaveProperty('baseCurrency');
    expect(res.body.months).toEqual([
      { month: '2026-03', income: INCOME, expense: EXPENSE, net: INCOME - EXPENSE },
    ]);
  });
});

/**
 * `date` is a full ISO stamp, so `to` only means the whole of its day
 * because each route pads it: without that padding every row dated on the last day
 * of the window disappears from all four bodies, and nothing else here notices -
 * every other window in this file ends nine months from the nearest row.
 *
 * The narrowest window that can say so, over a row that is already in the fixture.
 */
describe('the last day of the window is inside it', () => {
  it.each(ROUTES)('%s: a row dated on `to` is counted', async (route) => {
    const res = await agent.get(
      `${route}?accountId=${walletId}&from=${INCOME_DAY}&to=${INCOME_DAY}`,
    );

    expect(res.status).toBe(200);
    const income = route.endsWith('months')
      ? (res.body.months[0]?.income ?? 0)
      : res.body.totals.income;
    expect(income).toBe(INCOME);
  });
});

/**
 * The only place in this file where a right implementation and a
 * wrong one disagree about these two fields. Every other account here is EUR, which
 * is also BASE_CURRENCY, so a route answering baseCurrency where it promises the
 * account's currency reads identically - and an otherCurrencies hard-coded to []
 * reads identically to one nobody computed. This account is UAH and holds one row
 * the file declared EUR, so both substitutions are visible.
 */
describe('an account whose currency is not the base currency', () => {
  it.each(ROUTES)('%s: says its own currency, and names the row not in it', async (route) => {
    const res = await agent.get(`${route}?accountId=${foreignId}&${WINDOW}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      scope: 'account',
      accountId: foreignId,
      currency: 'UAH',
      otherCurrencies: ['EUR'],
    });
    // the field that would label these hryvnias as euros is not on this body at all
    expect(res.body).not.toHaveProperty('baseCurrency');
  });

  /**
   * Both arms end to end: the account arm sums its own rows whatever currency they
   * are in, and the arm over every account sums the converted ones in the base
   * currency. A row with no rate is a real movement of that account's money and a
   * number the other arm may not add to euros - so it is in one figure and not the
   * other.
   */
  it('counts its unconverted row on its own arm and on no other', async () => {
    const account = await agent.get(`/api/summary?accountId=${foreignId}&${WINDOW}`);
    expect(account.status).toBe(200);
    expect(account.body.totals).toEqual({
      expense: FOREIGN_EXPENSE + FOREIGN_BASE_EXPENSE,
      income: 0,
    });

    const all = await agent.get(`/api/summary?${WINDOW}`);
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({
      scope: 'all',
      baseCurrency: 'EUR',
      totals: { expense: ALL_EXPENSE, income: INCOME },
    });
    expect(all.body).not.toHaveProperty('currency');
  });
});

/**
 * q() maps both '' and a repeated parameter to undefined, and undefined means
 * every account - so a caller building `?accountId=${account?.id ?? ''}` would be
 * handed every account's money labelled as one account's. Neither route may route
 * this through q(), and the two causes get their own sentences: `?accountId=` was
 * sent exactly once.
 */
describe('a malformed accountId never means every account', () => {
  it.each(ROUTES)('%s: an empty accountId is refused as empty', async (route) => {
    const res = await agent.get(`${route}?accountId=&${WINDOW}`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'accountId must not be empty' });
  });

  it.each(ROUTES)('%s: whitespace is empty too', async (route) => {
    const res = await agent.get(`${route}?accountId=%20%20&${WINDOW}`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'accountId must not be empty' });
  });

  it.each(ROUTES)('%s: a repeated accountId is refused as repeated', async (route) => {
    // Express 5's default `simple` parser hands a repeat over as ['a', 'b']
    const res = await agent.get(`${route}?accountId=a&accountId=b&${WINDOW}`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'accountId must be sent once, as a single value' });
  });

  /**
   * Recorded rather than defended against: the `simple` parser does no bracket
   * expansion, so `?accountId[]=x` arrives under the key `accountId[]` and there is
   * no accountId parameter at all. Changing the query parser would change this, and
   * this is the case that would say so.
   */
  it.each(ROUTES)('%s: bracket syntax arrives under another key entirely', async (route) => {
    const res = await agent.get(`${route}?accountId[]=x&${WINDOW}`);
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('all');
  });

  it.each(ROUTES)('%s: a well-formed id with spaces around it resolves', async (route) => {
    const res = await agent.get(`${route}?accountId=%20${walletId}%20&${WINDOW}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ scope: 'account', accountId: walletId });
  });
});

/**
 * A body about an account has to state a currency, and there is no
 * currency without an account - so an id that resolves to nothing is a refusal and
 * not a 200 of zeroes.
 */
describe('an accountId that resolves to nothing', () => {
  it.each(ROUTES)('%s: an unknown id is 404', async (route) => {
    const res = await agent.get(`${route}?accountId=no-such-account&${WINDOW}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'account not found' });
  });
});

/**
 * Hiding an account keeps it out of the totals over every account - that is
 * what VISIBLE_ACCOUNT() is for. Asked about by id it answers its real numbers: the
 * caller named it, and a removed account whose figures read as zero is
 * indistinguishable from an empty one.
 *
 * Last in the file, and put back afterwards: it changes what the other arm sums.
 */
describe('a hidden account', () => {
  afterAll(async () => {
    await agent.patch(`/api/accounts/${walletId}`).send({ hidden: false });
  });

  it('answers its real numbers by id while contributing nothing to the figures over every account', async () => {
    expect((await agent.patch(`/api/accounts/${walletId}`).send({ hidden: true })).status).toBe(200);

    // the hryvnia account's converted row is all that is left
    const all = await agent.get(`/api/summary?${WINDOW}`);
    expect(all.status).toBe(200);
    expect(all.body.totals).toEqual({ expense: FOREIGN_BASE_EXPENSE, income: 0 });

    const account = await agent.get(`/api/summary?accountId=${walletId}&${WINDOW}`);
    expect(account.status).toBe(200);
    expect(account.body.totals).toEqual({ expense: EXPENSE, income: INCOME });
  });
});
