/**
 * The four /api/income-sources routes over real HTTP - the first test any of them
 * has had.
 *
 * Driven through supertest, because what is worth asserting here
 * is the wire: the status codes, the sentence each refusal composes, and the id the
 * route mints from a label the client never sees. Before Settings had a control for
 * them nothing in web/src called three of these four routes, so every refusal below was
 * unreachable and therefore unwritten; that control is what makes them a door.
 */
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { INCOME_SOURCE_LABEL_MAX, seedDefaults } from '../src/db';
import { freshTestDb } from './pglite';

const SOURCES = '/api/income-sources';

interface SourceBody {
  id: string;
  label: string;
  kind: string;
  patterns: string[];
  builtin: boolean;
}

let agent: request.Agent;

/** The catalog as the API answers it. */
const list = async (): Promise<SourceBody[]> => {
  const res = await agent.get(SOURCES);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as SourceBody[];
};

const create = async (body: unknown) => agent.post(SOURCES).send(body as object);

const created = async (body: unknown): Promise<SourceBody> => {
  const res = await create(body);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as SourceBody;
};

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
});

describe('GET /api/income-sources', () => {
  /**
   * The seeded catalog a first start produces. Both halves are literals: the id is
   * data that reaches transactions.income_source and does not move, the label is the
   * only part of this row anybody reads, and the patterns are FAMILY_NAMES as
   * test/setup.ts sets it - the environment seeds, the row owns.
   */
  it('seeds a neutral external source with the family names from the environment', async () => {
    const family = (await list()).find((s) => s.id === 'family')!;

    expect(family.label).toBe('Support');
    expect(family.kind).toBe('external');
    expect(family.builtin).toBe(true);
    expect(family.patterns).toEqual(['ANNA BECKER', 'Becker Anna']);
  });
});

describe('POST /api/income-sources', () => {
  it('mints an id from the label, trims the patterns, and lists what it stored', async () => {
    const source = await created({
      label: '  Stipend  ',
      kind: 'external',
      patterns: ['  Musterstiftung Musterstadt ', '   ', ''],
    });

    expect(source).toMatchObject({
      id: 'stipend',
      label: 'Stipend',
      kind: 'external',
      patterns: ['Musterstiftung Musterstadt'],
      builtin: false,
    });
    expect((await list()).map((s) => s.id)).toContain('stipend');
  });

  /**
   * The collision loop, which until now was reachable only through the data layer.
   * Two sources may share a label - the id is derived and the user never types it -
   * so the second one gets a suffix rather than a refusal.
   */
  it('gives a second source of the same label an id of its own', async () => {
    const first = await created({ label: 'Grant', kind: 'external' });
    const second = await created({ label: 'Grant', kind: 'external' });

    expect(first.id).toBe('grant');
    expect(second.id).toBe('grant-2');
  });

  it('refuses a kind outside the two', async () => {
    const res = await create({ label: 'Nonsense', kind: 'gift' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      "income source kind must be 'own' (your own earnings) or 'external' (support from outside)",
    );
  });

  it('refuses a label of blanks', async () => {
    const res = await create({ label: '   ', kind: 'own' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('income source label must not be empty');
  });

  it('refuses an unknown field rather than dropping it', async () => {
    const res = await create({ label: 'Strict', kind: 'own', builtin: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unknown field: "builtin"');
  });
});

/**
 * Both halves of the bound, at both doors. The refusing half on its own is a message
 * that proves nothing: a client and a server whose numbers moved together read the
 * same as a bound nobody touched.
 */
describe('the income source label bound is one number at both doors that write one', () => {
  // built FROM the constant rather than beside it: a literal 61 here goes on passing
  // over a bound that has moved
  const tooLong = 'x'.repeat(INCOME_SOURCE_LABEL_MAX + 1);
  const longest = 'y'.repeat(INCOME_SOURCE_LABEL_MAX);
  const sentence = `income source label must be at most ${INCOME_SOURCE_LABEL_MAX} characters`;

  it('refuses an over-long label on create and on edit', async () => {
    const refused = await create({ label: tooLong, kind: 'own' });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe(sentence);

    const source = await created({ label: longest, kind: 'own' });
    expect(source.label).toBe(longest);

    const renamed = await agent.put(`${SOURCES}/${source.id}`).send({ label: tooLong });
    expect(renamed.status).toBe(400);
    expect(renamed.body.error).toBe(sentence);
  });

  /**
   * A label accepted on create that its own edit door would refuse is reachable only
   * if the two doors bound different strings - which one schema, trimming before it
   * bounds, is what prevents.
   */
  it('and a label accepted on create can be sent back to the edit door', async () => {
    const atTheBound = 'z'.repeat(INCOME_SOURCE_LABEL_MAX);
    const padded = `  ${atTheBound}  `;
    const source = await created({ label: padded, kind: 'own' });
    expect(source.label).toBe(atTheBound);

    const renamed = await agent.put(`${SOURCES}/${source.id}`).send({ label: padded });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(renamed.body.label).toBe(atTheBound);
  });
});

describe('PUT /api/income-sources/:id', () => {
  const make = async (label: string, kind = 'external') => created({ label, kind });

  it('edits the label, the kind and the patterns together', async () => {
    const source = await make('Editable');

    const res = await agent
      .put(`${SOURCES}/${source.id}`)
      .send({ label: 'Edited', kind: 'own', patterns: [' Acme GmbH '] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      id: source.id,
      label: 'Edited',
      kind: 'own',
      patterns: ['Acme GmbH'],
    });
  });

  /**
   * A patch touches only the fields it names, and that claim takes two cases rather
   * than one. A PUT naming the label alone cannot see the label fallback at all -
   * `parsed.data.label` is present, so the `??` short-circuits and a constant on its
   * right is invisible - so a single label-only case holds two arms of three and
   * reads as holding all three.
   */
  it('leaves the kind and the patterns alone when only the label is named', async () => {
    const source = await created({
      label: 'Kept Whole',
      kind: 'external',
      patterns: ['Musterstiftung Musterstadt'],
    });

    const res = await agent.put(`${SOURCES}/${source.id}`).send({ label: 'Renamed' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      label: 'Renamed',
      kind: 'external',
      patterns: ['Musterstiftung Musterstadt'],
    });
  });

  it('leaves the label and the kind alone when only the patterns are named', async () => {
    const source = await created({
      label: 'Kept Patterns',
      kind: 'external',
      patterns: ['Musterstiftung Musterstadt'],
    });

    const res = await agent.put(`${SOURCES}/${source.id}`).send({ patterns: ['Acme GmbH Berlin'] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      label: 'Kept Patterns',
      kind: 'external',
      patterns: ['Acme GmbH Berlin'],
    });
  });

  /**
   * The owner renaming theirs, over the wire. The conflict clause in
   * upsertIncomeSource does not set `builtin`, so a rename cannot turn a seeded
   * source into a deletable one - which is what makes editing one safe.
   */
  it('renames a builtin and leaves it a builtin', async () => {
    const res = await agent.put(`${SOURCES}/family`).send({ label: 'Family support' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ id: 'family', label: 'Family support', builtin: true });
    expect((await agent.delete(`${SOURCES}/family`)).status).toBe(400);
  });

  it('refuses a kind outside the two rather than keeping the old one', async () => {
    const source = await make('Kept Kind');

    const res = await agent.put(`${SOURCES}/${source.id}`).send({ kind: 'gift' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      "income source kind must be 'own' (your own earnings) or 'external' (support from outside)",
    );
    expect((await list()).find((s) => s.id === source.id)!.kind).toBe('external');
  });

  it('refuses a label of blanks rather than keeping the old one', async () => {
    const source = await make('Kept Label');

    const res = await agent.put(`${SOURCES}/${source.id}`).send({ label: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('income source label must not be empty');
    expect((await list()).find((s) => s.id === source.id)!.label).toBe('Kept Label');
  });

  it('refuses an unknown field rather than dropping it', async () => {
    const source = await make('Strict Patch');

    const res = await agent.put(`${SOURCES}/${source.id}`).send({ sort: 99 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unknown field: "sort"');
  });

  it('answers 404 for a source that is not there', async () => {
    const res = await agent.put(`${SOURCES}/nothing-here`).send({ label: 'Anything' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('source not found');
  });

  /**
   * The id is looked up before the body is parsed, so a request that would fail both
   * checks is told which source it meant rather than what is wrong with a body that
   * was never going to be applied. Only a body that ALSO fails the schema can say
   * which check ran first: every refusal above names an id that exists, and the case
   * above sends a body that parses, so between them the order is unheld.
   */
  it('names the missing source before it looks at the body', async () => {
    const res = await agent.put(`${SOURCES}/nothing-here`).send({ kind: 'gift' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('source not found');
  });
});

describe('DELETE /api/income-sources/:id', () => {
  it('refuses a builtin', async () => {
    const res = await agent.delete(`${SOURCES}/family`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('source not found or builtin (salary/family/other)');
    expect((await list()).map((s) => s.id)).toContain('family');
  });

  it('deletes one the user made', async () => {
    const source = await created({ label: 'Temporary', kind: 'external' });

    const res = await agent.delete(`${SOURCES}/${source.id}`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ deleted: true });
    expect((await list()).map((s) => s.id)).not.toContain(source.id);
  });
});
