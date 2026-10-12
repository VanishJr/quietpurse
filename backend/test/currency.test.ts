/**
 * One currency however a stored row spells it: an earlier version could store `eur`.
 * currencyKey and the database's CURRENCY_KEY are two writings of one fold, and nothing
 * but these tests keeps them alike.
 */
import fs from 'fs';
import path from 'path';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { parseAppSettingsPatch, updateAppSettings } from '../src/appsettings';
import { currencyKey, sameCurrency } from '../src/currency';
import {
  type AccountScope,
  type ResolvedAccountId,
  accountOtherCurrencies,
  dbInstance,
  insertTransactions,
  setSetting,
} from '../src/db';
import { NewTransaction } from '../src/types';
import { accountFor, importAndConfirm } from './helpers';
import { type Agent, serve } from './loopback';

const scopeOf = (id: string, currency: string): AccountScope => ({
  kind: 'account',
  id: id as ResolvedAccountId,
  currency,
});

const row = (accountId: string, currency: string, n: number): NewTransaction => ({
  accountId,
  provider: 'upload',
  amount: -10 - n,
  currency,
  date: '2026-03-01T00:00:00.000Z',
  description: `Invented row ${n}`,
  category: 'other',
  fee: null,
});

describe('currencyKey', () => {
  it('upper-cases ASCII letters and leaves everything else as it is', () => {
    expect(currencyKey('eur')).toBe('EUR');
    expect(currencyKey('Usd')).toBe('USD');
    expect(['933', '€', 'грн', 'ß', 'ı'].map(currencyKey)).toEqual(['933', '€', 'грн', 'ß', 'ı']);
    expect(sameCurrency('eur', 'EUR')).toBe(true);
    expect(sameCurrency('EUR', 'USD')).toBe(false);
  });
});

describe("an account's other currencies", () => {
  it('a row in the account currency is not another currency, whichever of the two is spelt in lower case', async () => {
    const upper = await accountFor('Upper Account');
    await insertTransactions([row(upper, 'eur', 1)]);
    const lower = await accountFor('Lower Account');
    await dbInstance().execute(sql`UPDATE accounts SET currency = 'eur' WHERE id = ${lower}`);
    await insertTransactions([row(lower, 'EUR', 2)]);

    expect(await accountOtherCurrencies(scopeOf(upper, 'EUR'))).toEqual([]);
    expect(await accountOtherCurrencies(scopeOf(lower, 'eur'))).toEqual([]);
  });

  it('the database folds a currency exactly as currencyKey does, outside ASCII too', async () => {
    const stored = ['xyz', 'eur', 'Usd', '933', '€', 'грн', 'ß', 'ı'];
    const account = await accountFor('Folded Account', 'XYZ');
    await insertTransactions(stored.map((currency, n) => row(account, currency, n)));

    const other = await accountOtherCurrencies(scopeOf(account, 'XYZ'));

    const expected = [...new Set(stored.map(currencyKey))].filter((c) => c !== 'XYZ');
    expect([...other].sort()).toEqual(expected.sort());
  });

  it('an upload into an account an earlier version stored as "грн" keeps its rows in that currency', async () => {
    const account = await accountFor('Hryvnia Spelt Out');
    await dbInstance().execute(sql`UPDATE accounts SET currency = 'грн' WHERE id = ${account}`);

    await importAndConfirm({
      accountId: account,
      bytes: Buffer.from(['date,amount,description', '2026-03-02,-15.00,Invented kiosk'].join('\n'), 'utf8'),
    });

    expect(await accountOtherCurrencies(scopeOf(account, 'грн'))).toEqual([]);
  });
});

describe('the base currency setting', () => {
  it('saving the base currency in another case is not a change of currency', async () => {
    await setSetting('base_currency', 'eur');
    try {
      const parsed = parseAppSettingsPatch({ baseCurrency: 'EUR' });
      if (!parsed.ok) throw new Error(parsed.error);

      const saved = await updateAppSettings(parsed.patch);

      expect(saved.baseCurrencyChanged).toBe(false);
      expect(saved.settings.baseCurrency).toBe('EUR');
    } finally {
      await setSetting('base_currency', 'EUR');
    }
  });
});

/** A client compares what it is sent, so it is sent one spelling; the backup restores, so it keeps the stored one. */
describe('what an answer sends', () => {
  let agent: Agent;
  beforeAll(async () => {
    agent = await serve(app);
  });

  it('an account, its row and its goal stored as "eur" are sent as EUR, and the backup keeps "eur"', async () => {
    const created = await agent.post('/api/accounts').send({ name: 'Answer Bank', currency: 'EUR' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id as string;
    await dbInstance().execute(sql`UPDATE accounts SET currency = 'eur' WHERE id = ${id}`);
    await insertTransactions([row(id, 'eur', 7)]);
    const goal = await agent
      .post('/api/goals')
      .send({ type: 'savings-balance', name: 'Answer savings', targetDate: null, target: 500, accountIds: [id] });
    expect(goal.status, JSON.stringify(goal.body)).toBe(201);

    const accounts = (await agent.get('/api/accounts')).body as { id: string; currency: string }[];
    expect(accounts.find((a) => a.id === id)?.currency).toBe('EUR');
    const rows = (await agent.get('/api/transactions').query({ accountId: id })).body as { currency: string }[];
    expect(rows.map((r) => r.currency)).toEqual(['EUR']);
    expect((await agent.get('/api/summary').query({ accountId: id })).body).toMatchObject({ currency: 'EUR', otherCurrencies: [] });
    expect(goal.body.currency).toBe('EUR');
    expect((await agent.get(`/api/goals/${goal.body.id as string}`)).body.currency).toBe('EUR');

    const backup = (await agent.get('/api/backup')).body as { tables: Record<string, Record<string, unknown>[]> };
    expect(backup.tables.accounts.find((a) => a.id === id)?.currency).toBe('eur');
    expect(backup.tables.transactions.filter((t) => t.accountId === id).map((t) => t.currency)).toEqual(['eur']);
    expect(backup.tables.savings_balance_goals.map((g) => g.currency)).toContain('eur');
  });

  it('a base currency setting stored as "eur" is sent as EUR', async () => {
    await setSetting('base_currency', 'eur');
    try {
      expect((await agent.get('/api/app-settings')).body.baseCurrency).toBe('EUR');
      expect((await agent.get('/api/conversion')).body.baseCurrency).toBe('EUR');
    } finally {
      await setSetting('base_currency', 'EUR');
    }
  });

  it('the CSV export writes a currency as answers send it, quoted when it holds a comma', async () => {
    const account = await accountFor('Export Bank');
    await insertTransactions([row(account, 'eur', 21), row(account, 'EU,R', 22)]);

    const csv = (await agent.get('/api/export.csv')).text;

    expect(csv).toContain(',Export Bank,-31,EUR,');
    expect(csv).toContain(',Export Bank,-32,"EU,R",');
  });
});

/**
 * Every comparison or grouping of a currency read from the database goes through
 * sameCurrency, currencyKey or CURRENCY_KEY. The parsers are out of scope: they compare
 * codes they produced themselves and fold the account's currency where they read it.
 * What a line scan cannot see: a currency used as a key of a Set, a Map or an object, and
 * one compared under a name that does not say currency.
 */
describe('no currency is compared past the shared fold', () => {
  const SRC = path.resolve(process.cwd(), 'src');
  const files = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return p === path.join(SRC, 'providers') ? [] : files(p);
      return p.endsWith('.ts') && p !== path.join(SRC, 'currency.ts') ? [p] : [];
    });
  const RAW = [
    /(?<!typeof\s+[\w.]*)\b\w*[cC]urrency\s*[!=]==(?!\s*(?:undefined|null)\b)/,
    /[!=]==\s*[\w.?!]*\b\w*[cC]urrency\b/,
    /\bcurrency\s*(?:=|<>|!=)\s*\$\{|\}\s*(?:=|<>|!=)\s*currency\b/,
    /\bcurrency\s+(?:NOT\s+)?IN\s*\(/i,
    /\b(?:DISTINCT|GROUP BY|PARTITION BY)\b(?:(?!\bAS\s+currency\b).)*[\s,(]currency\b/i,
  ];

  it('finds none in backend/src', () => {
    const found = files(SRC).flatMap((file) => {
      const code = fs
        .readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ''))
        .replace(/\/\/[^\n]*/g, '');
      return code
        .split('\n')
        .map((line, i) => ({ line: line.trim(), at: `${path.relative(SRC, file)}:${i + 1}` }))
        .filter(({ line }) => RAW.some((re) => re.test(line)))
        .map(({ line, at }) => `${at}: ${line}`);
    });
    expect(found).toEqual([]);
  });

  it('would find the comparisons this fold replaced', () => {
    const replaced = [
      'const isBase = t.currency === baseCurrency;',
      'if (expense.currency !== income.currency) return NaN;',
      "WHERE account_id = ${scope.id} AND currency <> ${scope.currency}",
      'SELECT DISTINCT SUBSTR(date, 1, 10) AS day, currency',
      'sql`currency = ${baseCurrency}`,',
    ];
    for (const line of replaced) expect(RAW.some((re) => re.test(line)), line).toBe(true);
    expect(RAW.some((re) => re.test("if (typeof body.baseCurrency !== 'string') return;"))).toBe(false);
    expect(RAW.some((re) => re.test('if (patch.currency === undefined) return;'))).toBe(false);
  });
});
