/**
 * The summary queries on both arms: the whole workspace in the base currency, or
 * one named account in that account's own currency.
 *
 * What is worth asserting here is that the two arms cannot borrow each other's
 * clauses. The workspace arm excludes hidden accounts and rows with no exchange
 * rate, and it must keep doing both; the account arm must do neither, because a
 * query about one account that drops that account's own rows answers a number the
 * balance printed beside it contradicts. Both are one word of SQL apart, and the
 * sabotage that swaps them leaves the rest of this suite green.
 */
import fs from 'fs';
import path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type AccountScope,
  type ResolvedAccountId,
  accountOtherCurrencies,
  createAccount,
  getAccount,
  insertTransactions,
  recalcAccountBalanceFromTransactions,
  setTransferOverride,
  summaryByCategory,
  summaryIncomeByCategory,
  summaryIncomeBySource,
  summaryMonthlyTotals,
  summaryTotals,
  updateAccount,
} from '../src/db';
import { Account, NewTransaction, SummaryTotals } from '../src/types';
import { idOf } from './helpers';

/** A window over the whole fixture. */
const FROM = '2026-01-01T00:00:00.000Z';
const TO = '2026-12-31T23:59:59.999Z';

// The fixture, in one place: every number asserted below is an expression of
// these, never a figure read back out of the code.
const MAIN_EXPENSE = 100;
const MAIN_INCOME = 500;
/** in UAH, so base_amount_cents is NULL - the state a real import is in before backfillBaseAmounts */
const UAH_EXPENSE = 30;
const UAH_INCOME = 40;
const TRANSFER_OUT = 20;
const SECOND_EXPENSE = 7;
const HIDDEN_EXPENSE = 1000;
const HIDDEN_INCOME = 2000;

/** The account arm sees its own rows whatever currency they are in. */
const MAIN_ARM_EXPENSE = MAIN_EXPENSE + UAH_EXPENSE;
const MAIN_ARM_INCOME = MAIN_INCOME + UAH_INCOME;
/** The workspace arm: converted rows of visible accounts, transfers excluded. */
const WORKSPACE_EXPENSE = MAIN_EXPENSE + SECOND_EXPENSE;
const WORKSPACE_INCOME = MAIN_INCOME;

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

/**
 * The scope a route builds once getAccount has said yes. The assertion is what
 * ResolvedAccountId is for: an id read off a row of this workspace, never a string
 * that arrived unread.
 */
const scopeOf = (account: Account): AccountScope => ({
  kind: 'account',
  id: account.id as ResolvedAccountId,
  currency: account.currency,
});

const make = async (name: string, currency = 'EUR'): Promise<Account> => {
  const created = await createAccount({ name, currency });
  if (!created.ok) throw new Error(`could not create "${name}": ${created.reason}`);
  return created.account;
};

let main: Account;
let second: Account;
let hidden: Account;
let empty: Account;
let mainScope: AccountScope;
let secondScope: AccountScope;
let hiddenScope: AccountScope;
let emptyScope: AccountScope;

beforeAll(async () => {
  main = await make('Main');
  second = await make('Second');
  hidden = await make('Hidden');
  empty = await make('Empty');

  await insertTransactions([
    tx({ accountId: main.id, amount: -MAIN_EXPENSE, category: 'food', description: 'groceries' }),
    tx({
      accountId: main.id,
      amount: MAIN_INCOME,
      category: 'salary',
      date: '2026-03-06T12:00:00.000Z',
      description: 'salary',
    }),
    // the two rows the workspace arm may not touch and the account arm must: no
    // exchange rate has been fetched, so base_amount_cents is NULL on both
    tx({
      accountId: main.id,
      amount: -UAH_EXPENSE,
      currency: 'UAH',
      category: 'transport',
      date: '2026-03-07T12:00:00.000Z',
      description: 'kyiv taxi',
    }),
    tx({
      accountId: main.id,
      amount: UAH_INCOME,
      currency: 'UAH',
      category: 'gift',
      date: '2026-03-08T12:00:00.000Z',
      description: 'kyiv gift',
    }),
    // April holds this and nothing else, so the month exists only if a transfer
    // keeps it alive
    tx({
      accountId: main.id,
      amount: -TRANSFER_OUT,
      category: 'savings',
      date: '2026-04-10T12:00:00.000Z',
      description: 'to savings',
    }),
    tx({ accountId: second.id, amount: -SECOND_EXPENSE, category: 'food', description: 'coffee' }),
    tx({ accountId: hidden.id, amount: -HIDDEN_EXPENSE, category: 'home', description: 'rent' }),
    tx({
      accountId: hidden.id,
      amount: HIDDEN_INCOME,
      category: 'bonus',
      date: '2026-03-06T12:00:00.000Z',
      description: 'bonus',
    }),
  ]);
  await setTransferOverride(await idOf('to savings'), true);
  expect((await updateAccount(hidden.id, { hidden: true })).ok).toBe(true);

  mainScope = scopeOf(main);
  secondScope = scopeOf(second);
  hiddenScope = scopeOf(hidden);
  emptyScope = scopeOf(empty);
});

const bothWays = (t: SummaryTotals): number => t.expense + t.income;
const summed = (rows: { total: number }[]): number => rows.reduce((s, r) => s + r.total, 0);
const categories = (rows: { category: string }[]): string[] => rows.map((r) => r.category);

/**
 * All five summary queries reduced to one number each, so a case about the clause
 * list can be stated once and run against every query that carries it. The two arms
 * get their own closures rather than a shared one taking a SummaryScope, because
 * summaryMonthlyTotals answers a different type per arm.
 */
interface SummaryQuery {
  name: string;
  account: (scope: AccountScope) => Promise<number>;
  workspace: () => Promise<number>;
  /** what the fixture says this query attributes to Main... */
  main: number;
  /** ...to the hidden account... */
  hidden: number;
  /** ...and to the workspace. */
  whole: number;
}

const QUERIES: SummaryQuery[] = [
  {
    name: 'summaryTotals',
    account: async (s) => bothWays(await summaryTotals(s, FROM, TO)),
    workspace: async () => bothWays(await summaryTotals({ kind: 'workspace' }, FROM, TO)),
    main: MAIN_ARM_EXPENSE + MAIN_ARM_INCOME,
    hidden: HIDDEN_EXPENSE + HIDDEN_INCOME,
    whole: WORKSPACE_EXPENSE + WORKSPACE_INCOME,
  },
  {
    name: 'summaryByCategory',
    account: async (s) => summed(await summaryByCategory(s, FROM, TO)),
    workspace: async () => summed(await summaryByCategory({ kind: 'workspace' }, FROM, TO)),
    main: MAIN_ARM_EXPENSE,
    hidden: HIDDEN_EXPENSE,
    whole: WORKSPACE_EXPENSE,
  },
  {
    name: 'summaryIncomeByCategory',
    account: async (s) => summed(await summaryIncomeByCategory(s, FROM, TO)),
    workspace: async () => summed(await summaryIncomeByCategory({ kind: 'workspace' }, FROM, TO)),
    main: MAIN_ARM_INCOME,
    hidden: HIDDEN_INCOME,
    whole: WORKSPACE_INCOME,
  },
  {
    name: 'summaryIncomeBySource',
    account: async (s) => summed(await summaryIncomeBySource(s, FROM, TO)),
    workspace: async () => summed(await summaryIncomeBySource({ kind: 'workspace' }, FROM, TO)),
    main: MAIN_ARM_INCOME,
    hidden: HIDDEN_INCOME,
    whole: WORKSPACE_INCOME,
  },
  {
    name: 'summaryMonthlyTotals',
    account: async (s) =>
      (await summaryMonthlyTotals(s, FROM, TO)).reduce((t, m) => t + m.income + m.expense, 0),
    workspace: async () =>
      (await summaryMonthlyTotals({ kind: 'workspace' }, FROM, TO)).reduce(
        (t, m) => t + m.income + m.expense,
        0,
      ),
    main: MAIN_ARM_EXPENSE + MAIN_ARM_INCOME,
    hidden: HIDDEN_EXPENSE + HIDDEN_INCOME,
    whole: WORKSPACE_EXPENSE + WORKSPACE_INCOME,
  },
];

describe('the account arm and the workspace arm answer different questions', () => {
  it('one account in its own currency, or every visible account in the base one', async () => {
    expect(await summaryTotals(mainScope, FROM, TO)).toEqual({
      expense: MAIN_ARM_EXPENSE,
      income: MAIN_ARM_INCOME,
    });
    expect(await summaryTotals(secondScope, FROM, TO)).toEqual({
      expense: SECOND_EXPENSE,
      income: 0,
    });
    expect(await summaryTotals({ kind: 'workspace' }, FROM, TO)).toEqual({
      expense: WORKSPACE_EXPENSE,
      income: WORKSPACE_INCOME,
    });
  });

  /**
   * I4(a). A row whose rate has not been fetched has no base_amount_cents, so the
   * workspace arm leaves it out rather than adding hryvnias to euros - and the
   * account arm must count it, because it is a real movement of that account's own
   * money and the balance beside these figures already includes it.
   */
  it.each(QUERIES)(
    '$name: an unconverted row counts on the account arm and not on the workspace arm',
    async (q) => {
      expect(await q.account(mainScope)).toBe(q.main);
      expect(await q.workspace()).toBe(q.whole);
    },
  );

  it('and it is the unconverted row itself that separates the two answers', async () => {
    // 'transport' and 'gift' are the two UAH rows' categories and nothing else's
    expect(await summaryByCategory(mainScope, FROM, TO)).toContainEqual({
      category: 'transport',
      total: UAH_EXPENSE,
    });
    expect(categories(await summaryByCategory({ kind: 'workspace' }, FROM, TO))).not.toContain(
      'transport',
    );
    expect(await summaryIncomeByCategory(mainScope, FROM, TO)).toContainEqual({
      category: 'gift',
      total: UAH_INCOME,
    });
    expect(
      categories(await summaryIncomeByCategory({ kind: 'workspace' }, FROM, TO)),
    ).not.toContain('gift');
  });

  /**
   * I4(b). VISIBLE_ACCOUNT() keeps a hidden account out of the workspace totals.
   * Applied to a query about one named account it is not a filter but a mute
   * switch: the caller asked about that account by id.
   */
  it.each(QUERIES)(
    '$name: a hidden account answers its real numbers and contributes none of them to the workspace',
    async (q) => {
      expect(await q.account(hiddenScope)).toBe(q.hidden);
      expect(await q.workspace()).toBe(q.whole);
    },
  );

  it('and the hidden account’s categories appear in no workspace figure', async () => {
    expect(categories(await summaryByCategory(hiddenScope, FROM, TO))).toEqual(['home']);
    expect(categories(await summaryByCategory({ kind: 'workspace' }, FROM, TO))).not.toContain(
      'home',
    );
    expect(categories(await summaryIncomeByCategory({ kind: 'workspace' }, FROM, TO))).not.toContain(
      'bonus',
    );
  });
});

describe('an account’s months', () => {
  /**
   * I5. The months are only readable next to the balance if they are computed by
   * the same rule, so `net` sums every row of the month - transfers and unconverted
   * rows included - exactly as recalcAccountBalanceFromTransactions does.
   */
  it('add up to the balance, both sides computed', async () => {
    await recalcAccountBalanceFromTransactions(main.id);
    const balance = (await getAccount(main.id))!.balance;
    const months = await summaryMonthlyTotals(mainScope, FROM, TO);

    // not vacuous: a zero balance over one month would prove nothing
    expect(balance).not.toBe(0);
    expect(months.length).toBeGreaterThan(1);
    // summed in cents: the months are money and adding floats is not
    const net = months.reduce((t, m) => t + Math.round(m.net * 100), 0);
    expect(net).toBe(Math.round(balance * 100));
  });

  /**
   * I6. This is the one query whose GROUP BY can lose a whole bucket, so
   * NOT_TRANSFER lives inside the income and expense CASEs here and in no other
   * query. A month that vanishes from the chart reads as "nothing happened".
   */
  it('include a month whose only row is a transfer', async () => {
    const months = await summaryMonthlyTotals(mainScope, FROM, TO);
    expect(months.map((m) => m.month)).toEqual(['2026-03', '2026-04']);
    expect(months[1]).toEqual({
      month: '2026-04',
      income: 0,
      expense: 0,
      net: -TRANSFER_OUT,
    });
    // and March keeps the rule the other way round: the transfer is not income
    expect(months[0]).toEqual({
      month: '2026-03',
      income: MAIN_ARM_INCOME,
      expense: MAIN_ARM_EXPENSE,
      net: MAIN_ARM_INCOME - MAIN_ARM_EXPENSE,
    });
  });

  /**
   * I6's mirror, and the defect an over-general reading of the rule above produces:
   * NOT_TRANSFER stays in the WHERE of every other query, so moving your own money
   * into savings is not spending in the "savings" category.
   */
  it('but a transfer is not spending in its category on either arm', async () => {
    expect(categories(await summaryByCategory(mainScope, FROM, TO))).not.toContain('savings');
    expect(categories(await summaryByCategory({ kind: 'workspace' }, FROM, TO))).not.toContain(
      'savings',
    );
  });
});

describe('an account in more than one currency says so', () => {
  /** I8. The path is reachable: a row's currency comes from the file when it names one. */
  it('lists the currencies of its rows that are not its own, and [] when there are none', async () => {
    expect(await accountOtherCurrencies(mainScope)).toEqual(['UAH']);
    expect(await accountOtherCurrencies(secondScope)).toEqual([]);
    expect(await accountOtherCurrencies(emptyScope)).toEqual([]);
  });
});

describe('an account with no rows in the window', () => {
  /** Trap 3: an aggregate over nothing is NULL, and fromCents(NaN) serialises as null. */
  it('answers zeroes and empty lists, never nulls', async () => {
    expect(await summaryTotals(emptyScope, FROM, TO)).toEqual({ expense: 0, income: 0 });
    expect(await summaryByCategory(emptyScope, FROM, TO)).toEqual([]);
    expect(await summaryIncomeByCategory(emptyScope, FROM, TO)).toEqual([]);
    expect(await summaryIncomeBySource(emptyScope, FROM, TO)).toEqual([]);
    expect(await summaryMonthlyTotals(emptyScope, FROM, TO)).toEqual([]);

    // and an account that has rows, asked about a window with none in it
    const june = ['2026-06-01T00:00:00.000Z', '2026-06-30T23:59:59.999Z'] as const;
    expect(await summaryTotals(mainScope, june[0], june[1])).toEqual({ expense: 0, income: 0 });
    expect(await summaryMonthlyTotals(mainScope, june[0], june[1])).toEqual([]);
  });
});

/**
 * The clause list is a convention - SQL is a string, and there is no type that can
 * refuse a sixth summary query written with the workspace arm's filters. The cases
 * above cover the five that exist; this one covers the one nobody has written yet.
 *
 * It reads source, so it asserts nothing at all if its anchors move: the first three
 * expectations are the guard that the slice is really the summary block.
 */
describe('nothing but scopeSql picks the filters', () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), 'src/db/index.ts'), 'utf8');
  const start = source.indexOf('const CONVERTED = sql');
  const end = source.indexOf('// ---------- imports (provenance');
  const block = start < 0 || end < 0 ? '' : source.slice(source.indexOf('\n', start) + 1, end);
  /** the rule is about code, not about the comments explaining it */
  const code = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('the block this reads is the summary block', () => {
    expect(block, 'the summary block was not found - did CONVERTED or the imports marker move?')
      .not.toBe('');
    for (const name of [
      'scopeSql',
      'summaryByCategory',
      'summaryIncomeByCategory',
      'summaryIncomeBySource',
      'summaryTotals',
      'summaryMonthlyTotals',
      'avgMonthlyByCategory',
    ]) {
      expect(code, `${name} is not in the slice - the anchors no longer bound it`).toContain(name);
    }
  });

  /**
   * A count rather than a span. Excising "the helper" as everything between
   * `const scopeSql` and the next `export` leaves a window a new fragment written
   * beside the helper falls into unseen - which is exactly where someone adding one
   * would put it. Each token is named once in the block today, inside scopeSql, so
   * a second occurrence anywhere is the thing to look at.
   */
  it.each(['CONVERTED', 'VISIBLE_ACCOUNT', 'base_amount_cents'])(
    '%s is named once, and it is the helper naming it',
    (token) => {
      const named = code.split(token).length - 1;
      // absent and duplicated are different regressions and get different sentences:
      // a count assertion that reports "more than once" for zero names the wrong one
      expect(
        named,
        `${token} is named nowhere below CONVERTED: the clause was deleted rather than moved, and the arm that used to carry it now answers a different question`,
      ).toBeGreaterThan(0);
      expect(
        named,
        `${token} is named more than once below CONVERTED: either a query picks one arm's filter without its column, or scopeSql itself uses it twice - both want reading`,
      ).toBe(1);
      expect(
        code.indexOf(token),
        `${token} is named above scopeSql, so whatever names it is not the helper`,
      ).toBeGreaterThan(code.indexOf('const scopeSql'));
    },
  );
});
