/**
 * The saved chart list over real HTTP: what a PUT stores, what it answers, and what
 * it refuses.
 *
 * Driven through supertest, because everything worth asserting
 * here is the wire - the status code, the sentence each refusal composes, and the
 * fact that a 200 body is the list read back out of the table rather than the
 * request echoed. A route that answers with what it was sent reports a write that
 * did not happen as a success, and nothing below the route can see that.
 */
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { CHARTS_STALE, app } from '../src/app';
import {
  CHARTS_MAX,
  CHART_ACCOUNT_ID_MAX,
  CHART_ID_MAX,
  CHART_METRICS,
  CHART_TITLE_MAX,
  seedDefaults,
} from '../src/db';
import { freshTestDb } from './pglite';

const CHARTS = '/api/analytics/charts';

/**
 * Loosely typed on purpose: the refusal cases below build their bodies out of this
 * same helper, and a field typed to the vocabulary could not carry a value the door
 * is supposed to reject.
 */
interface ChartBody {
  id: string;
  kind: string;
  title: string;
  accountId: string | null;
  metrics: string[];
  breakdown: string;
  range: string;
}

const chart = (over: Partial<ChartBody> = {}): ChartBody => ({
  id: 'cbase0001',
  kind: 'line',
  title: 'Spending',
  accountId: null,
  metrics: ['income', 'expense'],
  breakdown: 'expense-categories',
  range: '12m',
  ...over,
});

let agent: request.Agent;
let walletId: string;

const makeAccount = async (a: request.Agent, name: string): Promise<string> => {
  const res = await a.post('/api/accounts').send({ name, currency: 'EUR' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
};

/** The stored list, and the version to send with the next write. */
const read = async (a: request.Agent): Promise<{ version: number; charts: ChartBody[] }> => {
  const res = await a.get(CHARTS);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
};

/** A save from the version the server last answered - never from a literal. */
const save = async (a: request.Agent, charts: ChartBody[]): Promise<request.Response> => {
  const { version } = await read(a);
  return a.put(CHARTS).send({ version, charts });
};

/**
 * Everything asserted below is exact, so the file starts from an empty database: the
 * suite runs in one process with no truncation between files, and the rows an earlier
 * file left behind would otherwise be in every unfiltered answer here.
 */
beforeAll(async () => {
  await freshTestDb();
  await seedDefaults();
  agent = request.agent(app);
  walletId = await makeAccount(agent, 'Wallet');
});

/** First in the file on purpose: it is the one answer a save anywhere below would change. */
describe('GET /api/analytics/charts', () => {
  it('answers a database that has never saved with version 0 and no charts', async () => {
    const res = await agent.get(CHARTS);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ version: 0, charts: [] });
  });
});

describe('PUT /api/analytics/charts', () => {
  /**
   * The dock order is array position, carried in a `sort` column the wire never
   * mentions. The ids are chosen to sort the other way round on purpose: an
   * unordered read answers the primary key's order, so `czz1, cmm2, caa3` is the one
   * arrangement that can tell "ordered by sort" from "whatever came back".
   */
  it('stores a list in order, and answers the list it read back', async () => {
    const charts = [
      // an empty measure list is legal: the client has words for "no measure is picked"
      // rather than substituting one, and refusing it here would refuse a whole list on
      // the client's first migration
      chart({ id: 'czz1', title: 'Third alphabetically, first in the dock', metrics: [] }),
      // an empty title is legal too - the dock falls back to a suggestion
      chart({ id: 'cmm2', title: '', accountId: walletId }),
      chart({
        id: 'caa3',
        kind: 'donut',
        // an id naming no account: the chart says so on the card, and the state
        // survives the round trip rather than being refused or blanked
        accountId: 'no-such-account',
        breakdown: 'income-sources',
        range: '3y',
        metrics: ['net'],
      }),
    ];

    const put = await agent.put(CHARTS).send({ version: 0, charts });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body).toEqual({ version: 1, charts });

    // the body was the table, not the request: a GET afterwards says the same thing
    expect(await read(agent)).toEqual(put.body);
  });

  /**
   * Reordering the dock is the same whole-list write as any other, and the `sort`
   * column is rewritten from the new positions rather than kept from the old ones -
   * a replace that reused them would answer the previous arrangement for ever.
   */
  it('a list saved in another order comes back in that order', async () => {
    const before = await read(agent);
    const moved = [before.charts[2], before.charts[0], before.charts[1]];

    const res = await agent.put(CHARTS).send({ version: before.version, charts: moved });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.charts).toEqual(moved);
    expect((await read(agent)).charts).toEqual(moved);
  });

  /**
   * The case the version exists for, and it is written as its own because the stale
   * case below passes for the wrong reason when everything is stale: it asks for a
   * 409 and gets one. Its version comes out of the previous response's body - a
   * literal here would be the same tautology one level down.
   */
  it('accepts a second save at the version the first save answered', async () => {
    const first = await save(agent, [chart({ id: 'cver1', title: 'Before' })]);
    expect(first.status, JSON.stringify(first.body)).toBe(200);

    const second = await agent
      .put(CHARTS)
      .send({ version: first.body.version, charts: [chart({ id: 'cver1', title: 'After' })] });

    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.version).toBe(first.body.version + 1);
    expect(second.body.charts).toEqual([chart({ id: 'cver1', title: 'After' })]);
  });

  it('refuses a save at a stale version, and the refusal carries the current list', async () => {
    const stale = (await read(agent)).version;
    const winner = await agent
      .put(CHARTS)
      .send({ version: stale, charts: [chart({ id: 'cwin1', title: 'The one that landed' })] });
    expect(winner.status, JSON.stringify(winner.body)).toBe(200);

    const loser = await agent
      .put(CHARTS)
      .send({ version: stale, charts: [chart({ id: 'close1', title: 'The one that lost' })] });

    expect(loser.status).toBe(409);
    expect(loser.body.version).toBe(winner.body.version);
    expect(loser.body.charts).toEqual(winner.body.charts);
    // the constant rather than a copy of the sentence: two literals checked against
    // each other go green on a route that stopped composing it
    expect(loser.body.error).toBe(CHARTS_STALE);
    // and it wrote nothing: a refused save must not store part of the list, or the
    // client's next read is a mixture of two devices
    expect(await read(agent)).toEqual(winner.body);
  });

  it('clears the dock when the list it is sent is empty', async () => {
    const before = await read(agent);
    const res = await agent.put(CHARTS).send({ version: before.version, charts: [] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ version: before.version + 1, charts: [] });
    expect(await read(agent)).toEqual(res.body);
  });

  /**
   * No foreign key and no check at the door, deliberately: a chart naming an account
   * that is gone is a state the client draws on purpose. A cascade would take the
   * reader's tab away with nothing said.
   */
  it('leaves a chart standing when the account it names is deleted', async () => {
    const doomed = await makeAccount(agent, 'Chart Account');
    const saved = await save(agent, [chart({ id: 'cdoomed1', accountId: doomed })]);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);

    const deleted = await agent.delete(`/api/accounts/${doomed}`);
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);

    expect((await read(agent)).charts).toEqual([chart({ id: 'cdoomed1', accountId: doomed })]);
  });
});

describe('what the door refuses', () => {
  /** What the last accepted save left, read once so the closing case can compare. */
  let untouched: { version: number; charts: ChartBody[] };

  beforeAll(async () => {
    untouched = await read(agent);
  });

  /** Each refusal is asserted on the sentence it composes, not merely on the 400. */
  const refused = async (body: unknown): Promise<string> => {
    const res = await agent.put(CHARTS).send(body as object);
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    return res.body.error as string;
  };

  const put = (charts: unknown[], over: Record<string, unknown> = {}): unknown => ({
    version: 0,
    charts,
    ...over,
  });

  it('an unknown field, at either level, is named rather than dropped', async () => {
    expect(await refused(put([], { force: true }))).toBe('unknown field: "force"');
    expect(await refused(put([{ ...chart(), colour: 'red' }]))).toBe('unknown field: "colour"');
  });

  it('a value outside one of the three vocabularies', async () => {
    expect(await refused(put([chart({ kind: 'pie' })]))).toMatch(/^chart kind must be one of: /);
    expect(await refused(put([chart({ range: '7m' })]))).toMatch(/^chart range must be one of: /);
    expect(await refused(put([chart({ breakdown: 'everything' })]))).toMatch(
      /^chart breakdown must be one of: /,
    );
    expect(await refused(put([chart({ metrics: ['profit'] })]))).toMatch(
      /^chart metrics must be from: /,
    );
  });

  it('a measure listed twice, named', async () => {
    expect(await refused(put([chart({ metrics: ['income', 'income'] })]))).toBe(
      'chart metrics: "income" is listed twice',
    );
  });

  it('two charts with one id, named - the URL could only ever name one of them', async () => {
    expect(await refused(put([chart({ id: 'ctwice1' }), chart({ id: 'ctwice1' })]))).toBe(
      'two charts share the id "ctwice1" - the URL names a chart by its id, so it can only name one',
    );
  });

  it('an id that is empty, over-long, or carries something the URL would have to escape', async () => {
    expect(await refused(put([chart({ id: '' })]))).toBe('chart id must not be empty');
    // built FROM the constant, never beside it: a literal stops testing the bound
    // the moment the bound moves
    expect(await refused(put([chart({ id: 'c'.repeat(CHART_ID_MAX + 1) })]))).toBe(
      `chart id must be at most ${CHART_ID_MAX} characters`,
    );
    expect(await refused(put([chart({ id: 'c/1?x' })]))).toBe(
      'chart id may contain only letters, digits, and . _ ~ -',
    );
  });

  it('a title or an accountId past its bound', async () => {
    expect(await refused(put([chart({ title: 'x'.repeat(CHART_TITLE_MAX + 1) })]))).toBe(
      `chart title must be at most ${CHART_TITLE_MAX} characters`,
    );
    expect(
      await refused(put([chart({ accountId: 'a'.repeat(CHART_ACCOUNT_ID_MAX + 1) })])),
    ).toBe(`chart accountId must be at most ${CHART_ACCOUNT_ID_MAX} characters`);
  });

  it('more measures than there are measures, and more charts than the dock holds', async () => {
    expect(await refused(put([chart({ metrics: [...CHART_METRICS, 'net'] })]))).toBe(
      'a chart may not repeat a measure',
    );
    const tooMany = Array.from({ length: CHARTS_MAX + 1 }, (_, i) => chart({ id: `cmany${i}` }));
    expect(await refused(put(tooMany))).toBe(`at most ${CHARTS_MAX} charts can be saved`);
  });

  it('a version that is missing, negative, or not a whole number', async () => {
    expect(await refused({ charts: [] })).toBe('version must be a whole number');
    expect(await refused(put([], { version: -1 }))).toBe('version must not be negative');
    expect(await refused(put([], { version: 1.5 }))).toBe('version must be a whole number');
  });

  it('and none of them wrote anything', async () => {
    // the version as well as the list: a refusal that had reached the transaction
    // would have moved the counter even if it stored no chart
    expect(await read(agent)).toEqual(untouched);
  });
});
