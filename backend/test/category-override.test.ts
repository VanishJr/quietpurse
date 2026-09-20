/**
 * A category set by hand on one transaction.
 *
 * The whole feature is two columns: `category` is what the categorizer decided and
 * `category_manual` is the user's own answer, and every read that reports a category
 * to a person has to go through COALESCE(category_manual, category). SQL text is
 * invisible to tsc and a named fragment is a convention a new query can skip, so the
 * sweep is held by the enumeration in describe 2 rather than by anything structural -
 * one override, read back from every surface that reports a category.
 *
 * Describe 1 is the data layer; describe 2 is the same feature over real HTTP, and it
 * starts from an empty database of its own because every figure it asserts is exact.
 */
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { reclassifyAll } from '../src/classify';
import {
  addCategoryRule,
  avgMonthlyByCategory,
  countCategoryRuleMatches,
  createAccount,
  dbInstance,
  deleteCategoryRule,
  exportBackup,
  getTransaction,
  insertTransactions,
  listRecurringGroups,
  listTransactions,
  parseBackup,
  restoreBackup,
  seedDefaults,
  setCategoryOverride,
  summaryByCategory,
  summaryIncomeByCategory,
  updateAccount,
} from '../src/db';
import { Account, NewTransaction, Transaction } from '../src/types';
import { idOf } from './helpers';
import { freshTestDb } from './pglite';

// ---------- describe 1: the data layer ----------

/** A window over the whole data-layer fixture. */
const FROM = '2026-01-01T00:00:00.000Z';
const TO = '2026-12-31T23:59:59.999Z';

/** The two rows that must land in ONE bucket: one auto, one overridden. */
const AUTO_SPEND = 10;
const MANUAL_SPEND = 20;
const AUTO_INCOME = 100;
const MANUAL_INCOME = 200;
/** The rent group: three months of it, and the newest one is the overridden row. */
const RENT = 400;
/** The row the manual mark is set on, and one of the four rows the rule caption counts. */
const STRAY = 5;
const CAPTION_ROW = 1;
/** Every row that really is 'other' - the moved one is deliberately not among them. */
const OTHER_SPEND = RENT * 2 + STRAY + CAPTION_ROW * 2;

const tx = (over: Partial<NewTransaction>): NewTransaction => ({
  accountId: 'unset',
  provider: 'upload',
  amount: 0,
  currency: 'EUR',
  date: '2026-03-05T12:00:00.000Z',
  description: '',
  category: 'other',
  fee: null,
  ...over,
});

const make = async (name: string): Promise<Account> => {
  const created = await createAccount({ name, currency: 'EUR' });
  if (!created.ok) throw new Error(`could not create "${name}": ${created.reason}`);
  return created.account;
};

/**
 * Both columns as the database holds them. The point of the split is that the API
 * reports one value where there are two, so a test that only reads the API cannot
 * tell "the mark survived" from "the mark was written over the auto answer".
 */
async function columnsOf(id: string): Promise<{ category: string; manual: string | null }> {
  const res = (await dbInstance().execute(
    sql`SELECT category, category_manual FROM transactions WHERE id = ${id}`,
  )) as unknown as { rows: { category: string; category_manual: string | null }[] };
  expect(res.rows).toHaveLength(1);
  return { category: res.rows[0].category, manual: res.rows[0].category_manual };
}

const totalOf = (rows: { category: string; total: number }[], category: string): number | undefined =>
  rows.find((r) => r.category === category)?.total;

let manualAccount: Account;
let concealed: Account;

beforeAll(async () => {
  manualAccount = await make('Manual');
  concealed = await make('Concealed');

  await insertTransactions([
    // The spending arm: an auto 'transport' row and an auto 'other' row that
    // the user moves to 'transport'. One bucket, or the SELECT and the GROUP BY are
    // not the same expression.
    tx({ accountId: manualAccount.id, amount: -AUTO_SPEND, description: 'Bolt ride' }),
    tx({ accountId: manualAccount.id, amount: -MANUAL_SPEND, description: 'ZZ Mystery One' }),
    // the same shape on the income arm
    tx({ accountId: manualAccount.id, amount: AUTO_INCOME, description: 'Gehalt Maerz' }),
    tx({ accountId: manualAccount.id, amount: MANUAL_INCOME, description: 'ZZ Mystery Two' }),
    // the overridden row: it gets an override and then a rule that moves its auto answer
    tx({ accountId: manualAccount.id, amount: -STRAY, description: 'ZZ Mystery Three' }),
    // three months of the same payment, so the detector calls it recurring. The group
    // reports its NEWEST row's category, which is the one the override goes on.
    tx({
      accountId: manualAccount.id,
      amount: -RENT,
      description: 'ZZ Monthly Rent',
      date: '2026-01-05T12:00:00.000Z',
    }),
    tx({
      accountId: manualAccount.id,
      amount: -RENT,
      description: 'ZZ Monthly Rent',
      date: '2026-02-05T12:00:00.000Z',
    }),
    tx({
      accountId: manualAccount.id,
      amount: -RENT,
      description: 'ZZ Monthly Rent',
      date: '2026-03-05T12:00:00.000Z',
    }),
    // the rule caption's four rows: three visible, one on an account that is hidden
    tx({ accountId: manualAccount.id, amount: -CAPTION_ROW, description: 'CAPTION alpha' }),
    tx({ accountId: manualAccount.id, amount: -CAPTION_ROW, description: 'CAPTION beta' }),
    tx({ accountId: manualAccount.id, amount: -CAPTION_ROW, description: 'CAPTION gamma' }),
    tx({ accountId: concealed.id, amount: -CAPTION_ROW, description: 'CAPTION delta' }),
  ]);
  expect((await updateAccount(concealed.id, { hidden: true })).ok).toBe(true);

  // the categorizer's own answers, and `recurring`, before any override exists - so
  // every stored auto category below is what a recompute would write anyway, and no
  // case in this file depends on another having run first
  await reclassifyAll();

  await setCategoryOverride(await idOf('ZZ Mystery One'), 'transport');
  await setCategoryOverride(await idOf('ZZ Mystery Two'), 'salary');
  await setCategoryOverride(await newestRentId(), 'housing');
  await setCategoryOverride(await idOf('CAPTION beta'), 'food');
});

/** The newest row of the rent group - the one listRecurringGroups reports. */
async function newestRentId(): Promise<string> {
  const rows = (await listTransactions({ from: FROM, to: TO, limit: 1000 })).filter(
    (t) => t.description === 'ZZ Monthly Rent',
  );
  expect(rows).toHaveLength(3);
  return rows.sort((a, b) => a.date.localeCompare(b.date))[2].id;
}

describe('the data layer: a manual category, and what may not touch it', () => {
  /**
   * The user corrects one row, then writes a rule that moves that row's AUTO answer. The
   * rule may not clear the mark, the mark still wins, and the auto column underneath must
   * be brought up to date by the recompute - because that is what a later clear falls
   * back to. A recompute that skipped overridden rows would leave a months-old answer
   * there and nothing on screen would say so.
   */
  it('survives a recompute, and the auto answer underneath is kept current', async () => {
    const id = await idOf('ZZ Mystery Three');
    expect(await columnsOf(id)).toEqual({ category: 'other', manual: null });

    await setCategoryOverride(id, 'health');
    expect(await columnsOf(id)).toEqual({ category: 'other', manual: 'health' });
    expect((await getTransaction(id))!.category).toBe('health');

    const rule = await addCategoryRule('Mystery Three', 'shopping');
    try {
      await reclassifyAll();

      // the rule did not erase the annotation, and it still beats the rule
      expect((await columnsOf(id)).manual).toBe('health');
      expect((await getTransaction(id))!.category).toBe('health');
      expect((await getTransaction(id))!.categoryManual).toBe(true);
      // ...and the categorizer's answer was refreshed underneath it
      expect((await columnsOf(id)).category).toBe('shopping');

      // so handing the row back to auto-detection lands on the CURRENT answer
      const cleared = await setCategoryOverride(id, null);
      expect(cleared!.category).toBe('shopping');
      expect(cleared!.categoryManual).toBe(false);
    } finally {
      expect(await deleteCategoryRule(rule.id)).toBe(true);
      await setCategoryOverride(id, null);
      await reclassifyAll();
    }
    expect(await columnsOf(id)).toEqual({ category: 'other', manual: null });
  });

  /**
   * Two rows in the same effective category, one auto and one overridden, must
   * be one bucket. `SELECT COALESCE(...) AS category ... GROUP BY category` resolves
   * the name to the input column and errors; a sweep that misses the GROUP BY entirely
   * splits them in two.
   */
  it('an overridden row shares a bucket with an auto row of the same category', async () => {
    const spend = await summaryByCategory({ kind: 'all' }, FROM, TO);
    expect(spend.filter((r) => r.category === 'transport')).toHaveLength(1);
    expect(totalOf(spend, 'transport')).toBe(AUTO_SPEND + MANUAL_SPEND);

    const income = await summaryIncomeByCategory({ kind: 'all' }, FROM, TO);
    expect(income.filter((r) => r.category === 'salary')).toHaveLength(1);
    expect(totalOf(income, 'salary')).toBe(AUTO_INCOME + MANUAL_INCOME);

    // and the row is gone from the bucket it used to be counted in: 'other' is every
    // row that really is one, and none of the moved amount
    expect(totalOf(spend, 'other')).toBe(OTHER_SPEND);
  });

  it('avgMonthlyByCategory reports it too, over the same one bucket', async () => {
    const rows = await avgMonthlyByCategory(FROM, TO, 1);
    expect(rows.filter((r) => r.category === 'transport')).toHaveLength(1);
    expect(totalOf(rows, 'transport')).toBe(AUTO_SPEND + MANUAL_SPEND);
  });

  /** The group reports its newest row's category, so that is the row overridden above. */
  it('a recurring group reports the override on its newest row', async () => {
    const groups = await listRecurringGroups('2025-12-01T00:00:00.000Z');
    const rent = groups.filter((g) => g.description === 'ZZ Monthly Rent');
    expect(rent).toHaveLength(1);
    expect(rent[0]).toMatchObject({ category: 'housing', months: 3, monthlyAvg: RENT });
  });

  /**
   * The filter is SQL and the value on the row is TypeScript, and the fragment
   * names only one of the two. Presence alone is green when the SQL half is what put
   * the row in the list, so the returned value is what this asserts.
   */
  it('the category filter selects by the effective value, and the row agrees with it', async () => {
    const transport = await listTransactions({ from: FROM, to: TO, category: 'transport' });
    const moved = transport.filter((t) => t.description === 'ZZ Mystery One');
    expect(moved).toHaveLength(1);
    expect(moved[0].category).toBe('transport');
    expect(moved[0].categoryManual).toBe(true);
    // the auto row of the same category is in the same answer
    expect(transport.map((t) => t.description)).toContain('Bolt ride');

    const other = await listTransactions({ from: FROM, to: TO, category: 'other' });
    expect(other.map((t) => t.description)).not.toContain('ZZ Mystery One');
    // not vacuous: the filter does answer rows that really are 'other'
    expect(other.map((t) => t.description)).toContain('CAPTION alpha');
  });

  /**
   * `matches` keeps meaning "rows whose description contains the
   * pattern" - four here, one of them on a hidden account, because
   * countCategoryRuleMatches carries WS() and no VISIBLE_ACCOUNT() and `overridden`
   * must carry exactly the same filters. Take one of the two through the visibility
   * filter and `matches - overridden` is wrong for anyone with a hidden
   * account, quietly.
   */
  it('the rule caption counts the rows it cannot change, through the same filters', async () => {
    expect(await countCategoryRuleMatches('caption')).toEqual({ matches: 4, overridden: 1 });

    // the hidden row is really there and really invisible to the list, which is what
    // makes the 4 above a statement about the filters rather than about the fixture
    const listed = await listTransactions({ from: FROM, to: TO, limit: 1000 });
    expect(listed.map((t) => t.description)).not.toContain('CAPTION delta');
  });

  /**
   * Both directions. sanitizeRow drops an unrecognised key with no error and
   * no count, so "a backup taken before this change restores to auto" and "a backup
   * taken after it carries the mark back" are two different facts and neither is
   * implied by the other. POST /api/restore runs reclassifyAll immediately after
   * restoring, which is the one place a manual mark meets a full table rewrite on a
   * path the user did not start.
   */
  it('rides out and back in a backup, and a pre-change backup restores to auto', async () => {
    const id = await idOf('ZZ Mystery One');
    const backup = parseBackup(JSON.parse(JSON.stringify(await exportBackup())));
    const rows = backup.tables.transactions as { description: string; categoryManual?: unknown }[];
    expect(rows.find((r) => r.description === 'ZZ Mystery One')?.categoryManual).toBe('transport');

    try {
      await setCategoryOverride(id, null);
      expect((await getTransaction(id))!.category).toBe('other');

      await restoreBackup(backup);
      await reclassifyAll(); // as POST /api/restore does
      expect(await columnsOf(id)).toEqual({ category: 'other', manual: 'transport' });
      expect((await getTransaction(id))!.category).toBe('transport');

      // the same file as it would have been written before this column existed
      const older = parseBackup(JSON.parse(JSON.stringify(backup)));
      for (const row of older.tables.transactions as Record<string, unknown>[]) {
        delete row.categoryManual;
      }
      await restoreBackup(older);
      expect(await columnsOf(await idOf('ZZ Mystery One'))).toEqual({
        category: 'other',
        manual: null,
      });
    } finally {
      await restoreBackup(backup);
    }
    expect((await getTransaction(await idOf('ZZ Mystery One')))!.category).toBe('transport');
  });
});

// ---------- describe 2: over real HTTP ----------

const now = new Date();
const monthStartAt = (delta: number): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + delta, 1));
/** The `day`th of the month `delta` months from this one, as the CSV writes dates. */
const dayIn = (delta: number, day: number): string =>
  `${monthStartAt(delta).toISOString().slice(0, 8)}${String(day).padStart(2, '0')}`;

/** The current calendar month: what category goals and GET /api/summary use. */
const THIS_MONTH = dayIn(0, 1);

const OVERRIDDEN_SPEND = 40;
const AUTO_FOOD = 10;
const OVERRIDDEN_INCOME = 150;
const FOOD_BUDGET = 500;
const PAST_RENT = 400;
/** Whole months behind today, so the recurring detector can see them. */
const PAST_MONTHS = 3;

const statement = Buffer.from(
  [
    'date,amount,description',
    `${THIS_MONTH},-${OVERRIDDEN_SPEND}.00,ZZ Mystery Shop`,
    `${THIS_MONTH},-${AUTO_FOOD}.00,REWE Berlin`,
    `${THIS_MONTH},${OVERRIDDEN_INCOME}.00,ZZ Mystery Income`,
    `${THIS_MONTH},-1.00,ZZ Mystery Clear`,
  ].join('\n'),
  'utf8',
);

/**
 * Whole months, and behind us: GET /api/recurring needs the same description in
 * several of them. A fixture in the current month is invisible to that detector.
 */
const pastStatement = Buffer.from(
  [
    'date,amount,description',
    ...Array.from(
      { length: PAST_MONTHS },
      (_, i) => `${dayIn(-1 - i, 5)},-${PAST_RENT}.00,ZZ Monthly Rent`,
    ),
  ].join('\n'),
  'utf8',
);

let agent: request.Agent;
let walletId: string;
let shopId: string;
let clearId: string;

const makeAccount = async (a: request.Agent, name: string): Promise<string> => {
  const res = await a.post('/api/accounts').send({ name, currency: 'EUR' });
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

const listed = async (a: request.Agent): Promise<Transaction[]> => {
  const res = await a.get('/api/transactions?limit=1000');
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as Transaction[];
};

const one = async (a: request.Agent, description: string): Promise<Transaction> => {
  const found = (await listed(a)).filter((t) => t.description === description);
  expect(found, `expected exactly one "${description}"`).toHaveLength(1);
  return found[0];
};

const patchCategory = (a: request.Agent, id: string, body: unknown) =>
  a.patch(`/api/transactions/${id}/category`).send(body as object);

describe('over HTTP: the route, and every surface that reports a category', () => {
  beforeAll(async () => {
    // the data layer's cases above left rows behind, and the figures below are
    // exact: start from the empty database this describe would have as its own file
    await freshTestDb();
    await seedDefaults();

    agent = request.agent(app);

    walletId = await makeAccount(agent, 'Wallet');
    const pastAccountId = await makeAccount(agent, 'Past');

    await importCsv(agent, walletId, statement);
    await importCsv(agent, pastAccountId, pastStatement);

    shopId = (await one(agent, 'ZZ Mystery Shop')).id;
    clearId = (await one(agent, 'ZZ Mystery Clear')).id;

    // the fixture every read below is about is built by the route under test
    expect((await patchCategory(agent, shopId, { category: 'food' })).status).toBe(200);
    const income = await one(agent, 'ZZ Mystery Income');
    expect((await patchCategory(agent, income.id, { category: 'salary' })).status).toBe(200);

    const rent = (await listed(agent))
      .filter((t) => t.description === 'ZZ Monthly Rent')
      .sort((a, b) => a.date.localeCompare(b.date));
    expect(rent).toHaveLength(PAST_MONTHS);
    expect((await patchCategory(agent, rent[PAST_MONTHS - 1].id, { category: 'housing' })).status)
      .toBe(200);

    const budget = await agent.post('/api/goals').send({
      type: 'category-spending-limit',
      name: 'Food limit',
      category: 'food',
      monthlyLimit: FOOD_BUDGET,
    });
    expect(budget.status, JSON.stringify(budget.body)).toBe(201);
  });

  describe('PATCH /api/transactions/:id/category', () => {
    /**
     * There is no CHECK on the column, so the route is the whole of
     * what keeps an unknown slug out of it: a bucket every summary answers, that no
     * client dictionary can label and no budget ever matches.
     */
    it('refuses a slug that is not a category, in the sentence the rules route uses', async () => {
      const res = await patchCategory(agent, shopId, { category: 'groceries' });
      expect(res.status).toBe(400);

      // word for word the same refusal, so the client renders one sentence and not two
      const rule = await agent.post('/api/category-rules').send({ pattern: 'x', category: 'groceries' });
      expect(rule.status).toBe(400);
      expect(res.body).toEqual(rule.body);
    });

    it('refuses a non-string that is not null', async () => {
      const res = await patchCategory(agent, shopId, { category: 7 });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/^category must be one of: /);
    });

    /**
     * The absent key is its own arm, and it is not the same request as `null`: an
     * undefined must not reach the data layer, where drizzle's one-field .set()
     * refuses to build a statement at all - a 500 rather than a refusal.
     */
    it('refuses a body with no category key at all', async () => {
      const res = await patchCategory(agent, shopId, {});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/^category must be one of: /);
    });

    it('an unknown id is 404', async () => {
      const unknown = await patchCategory(agent, 'no-such-transaction', { category: 'food' });
      expect(unknown.status).toBe(404);
      expect(unknown.body).toEqual({ error: 'transaction not found' });
    });

    /** null is the only thing that clears the column, and it answers 200. */
    it('null hands the row back to auto-detection', async () => {
      const set = await patchCategory(agent, clearId, { category: 'health' });
      expect(set.status).toBe(200);
      expect(set.body).toMatchObject({ category: 'health', categoryManual: true });

      const cleared = await patchCategory(agent, clearId, { category: null });
      expect(cleared.status).toBe(200);
      expect(cleared.body).toMatchObject({ category: 'other', categoryManual: false });
    });
  });

  /**
   * The enumeration. Every surface is asserted positively - the
   * overridden category present with the amount the fixture says - before anything is
   * asserted about the slug it left, because `not.toContain` over an empty payload is
   * green whether the sweep landed or not.
   */
  describe('the effective category on every surface that reports one', () => {
    it('GET /api/transactions: the value, and whether a person chose it', async () => {
      const shop = await one(agent, 'ZZ Mystery Shop');
      expect(shop).toMatchObject({ category: 'food', categoryManual: true });

      // the auto row of the same category, so the flag is not just always true
      expect(await one(agent, 'REWE Berlin')).toMatchObject({
        category: 'food',
        categoryManual: false,
      });
    });

    it('GET /api/transactions?category=: selects by the effective value', async () => {
      const food = await agent.get('/api/transactions?category=food');
      expect(food.status).toBe(200);
      const moved = (food.body as Transaction[]).filter((t) => t.description === 'ZZ Mystery Shop');
      expect(moved).toHaveLength(1);
      expect(moved[0].category).toBe('food');
      expect((food.body as Transaction[]).map((t) => t.description)).toContain('REWE Berlin');

      const other = await agent.get('/api/transactions?category=other');
      expect(other.status).toBe(200);
      expect((other.body as Transaction[]).map((t) => t.description)).not.toContain(
        'ZZ Mystery Shop',
      );
    });

    it('GET /api/export.csv: the category cell', async () => {
      const res = await agent.get('/api/export.csv');
      expect(res.status).toBe(200);
      const line = res.text.split('\n').filter((l) => l.includes('ZZ Mystery Shop'));
      expect(line).toHaveLength(1);
      // date,account,amount,currency,base_amount,base_currency,category,description,...
      expect(line[0].split(',')[6]).toBe('food');
    });

    it('GET /api/summary: spending and income by category, on the arm over every account', async () => {
      const res = await agent.get('/api/summary');
      expect(res.status).toBe(200);
      expect(res.body.byCategory).toContainEqual({
        category: 'food',
        total: OVERRIDDEN_SPEND + AUTO_FOOD,
      });
      expect(res.body.incomeByCategory).toContainEqual({
        category: 'salary',
        total: OVERRIDDEN_INCOME,
      });
      // the moved amount is not still sitting in the slug it came from
      const other = (res.body.byCategory as { category: string; total: number }[]).find(
        (c) => c.category === 'other',
      );
      expect(other?.total ?? 0).toBeLessThan(OVERRIDDEN_SPEND);
    });

    /**
     * Both arms call the same two functions, so sweeping the function covers this
     * by construction - which is a test that passes because of how the code is
     * factored. The card on the account screen is the one place a user's correction
     * could silently fail to appear.
     */
    it('GET /api/summary?accountId=: the same, on the per-account arm', async () => {
      const res = await agent.get(`/api/summary?accountId=${walletId}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ scope: 'account', accountId: walletId });
      expect(res.body.byCategory).toContainEqual({
        category: 'food',
        total: OVERRIDDEN_SPEND + AUTO_FOOD,
      });
      expect(res.body.incomeByCategory).toContainEqual({
        category: 'salary',
        total: OVERRIDDEN_INCOME,
      });
    });

    it('GET /api/goals: the spend counted against the category limit', async () => {
      const res = await agent.get('/api/goals');
      expect(res.status).toBe(200);
      const goal = res.body.goals.find(
        (item: { type: string; category?: string }) =>
          item.type === 'category-spending-limit' && item.category === 'food',
      );
      expect(goal).toMatchObject({
        category: 'food',
        progress: {
          target: FOOD_BUDGET,
          current: OVERRIDDEN_SPEND + AUTO_FOOD,
          semantic: 'used',
        },
      });
    });

    it('GET /api/recurring: the group takes its newest row’s category', async () => {
      const res = await agent.get('/api/recurring');
      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(1);
      expect(res.body.groups[0]).toMatchObject({
        description: 'ZZ Monthly Rent',
        category: 'housing',
        months: PAST_MONTHS,
      });
    });
  });

  /**
   * On the wire: both payloads that carry `matches` carry `overridden`
   * beside it, or the caption is honest in one place and false in the other.
   */
  describe('the category rules payloads', () => {
    it('GET and POST /api/category-rules both count the rows the rule cannot change', async () => {
      // stated here rather than inherited from whichever case ran first: the count
      // below is about two overridden rows out of three, and nothing else
      expect((await patchCategory(agent, clearId, { category: null })).status).toBe(200);

      const created = await agent.post('/api/category-rules').send({
        pattern: 'ZZ Mystery',
        category: 'entertainment',
      });
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      // Shop, Income and Clear - and the two the user has answered for by hand
      expect(created.body).toMatchObject({ matches: 3, overridden: 2 });

      const list = await agent.get('/api/category-rules');
      expect(list.status).toBe(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0]).toMatchObject({ pattern: 'ZZ Mystery', matches: 3, overridden: 2 });

      // the rule really did move the row it was allowed to move, and really did not
      // move the two it was not
      expect(await one(agent, 'ZZ Mystery Clear')).toMatchObject({ category: 'entertainment' });
      expect(await one(agent, 'ZZ Mystery Shop')).toMatchObject({ category: 'food' });
      expect(await one(agent, 'ZZ Mystery Income')).toMatchObject({ category: 'salary' });
    });
  });
});
