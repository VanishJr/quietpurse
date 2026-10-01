/**
 * A refill that read one base currency, writing after the stored base has moved on.
 */
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Pool } from 'pg';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app';
import { reclassifyAll } from '../src/classify';
import {
  type BaseWrite,
  applyBaseRate,
  createAccount,
  dbInstance,
  exportBackup,
  insertTransactions,
  resetBaseAmounts,
  restoreBackup,
  seedDefaults,
  setSetting,
} from '../src/db';
import { backfillBaseAmounts } from '../src/fxrates';
import { NewTransaction } from '../src/types';
import { type Agent, serve } from './loopback';
import { freshTestDb } from './pglite';

const FRANKFURTER = 'https://api.frankfurter.dev/v1/';
const DAY = '2026-04-01';
const NEXT_DAY = '2026-04-02';
/** Fractional, and different for each base, so a stored row names the refill that wrote it. */
const EUR_PER_PLN = 0.23;
const USD_PER_PLN = 0.25;
const RATES: Record<string, number> = { EUR: EUR_PER_PLN, USD: USD_PER_PLN };

const MOVED =
  'base currency changed from EUR to USD during this refill; the refill that change started converts the rest';
const UNCONVERTED = { base_amount_cents: null, fx_rate: null };

let agent: Agent;
let accountId: string;

const row = (description: string, over: Partial<NewTransaction> = {}): NewTransaction => ({
  accountId,
  provider: 'upload',
  amount: -100,
  currency: 'PLN',
  date: `${DAY}T09:00:00.000Z`,
  description,
  category: 'other',
  fee: null,
  ...over,
});

interface StoredRow {
  base_amount_cents: number | null;
  fx_rate: number | null;
}

async function rowOf(description: string): Promise<StoredRow> {
  const res = (await dbInstance().execute(sql`
    SELECT base_amount_cents, fx_rate FROM transactions
    WHERE description = ${description}`)) as unknown as { rows: StoredRow[] };
  if (res.rows.length !== 1) {
    throw new Error(`expected one row described "${description}", found ${res.rows.length}`);
  }
  return res.rows[0];
}

const conversion = async () => {
  const res = await agent.get('/api/conversion');
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as { baseCurrency: string; converting: boolean; unconverted: number };
};

interface Parked {
  symbol: string;
  answer: () => void;
  fail: (reason: unknown) => void;
}

function rateNetwork() {
  const before = globalThis.fetch;
  let parked: Parked[] = [];
  const released = new Set<string>();
  const calls: string[] = [];
  const answer = (symbol: string): Response =>
    new Response(JSON.stringify({ rates: { [symbol]: RATES[symbol] } }));
  const take = (match: (p: Parked) => boolean): Parked[] => {
    const taken = parked.filter(match);
    parked = parked.filter((p) => !match(p));
    return taken;
  };
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith(FRANKFURTER)) {
      return Promise.reject(new Error('network disabled in tests'));
    }
    const symbol = new URL(url).searchParams.get('symbols') ?? '';
    calls.push(symbol);
    if (released.has(symbol)) return Promise.resolve(answer(symbol));
    const signal = init?.signal;
    return new Promise<Response>((resolve, reject) => {
      const call: Parked = { symbol, answer: () => resolve(answer(symbol)), fail: reject };
      parked.push(call);
      signal?.addEventListener('abort', () => {
        take((p) => p === call);
        reject(signal.reason);
      });
    });
  }) as typeof fetch;
  return {
    calls,
    waiting: (symbol: string): number => parked.filter((p) => p.symbol === symbol).length,
    release(symbol: string): void {
      released.add(symbol);
      for (const call of take((p) => p.symbol === symbol)) call.answer();
    },
    failAll(): void {
      for (const call of take(() => true)) call.fail(new Error('network disabled in tests'));
    },
    restore(): void {
      globalThis.fetch = before;
    },
  };
}

const waitForBlockedQuery = async (pool: Pool, pattern: string): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await pool.query<{ blocked: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND query ILIKE $1
      ) AS blocked
    `, [pattern]);
    if (result.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for blocked query ${pattern}`);
};

beforeAll(async () => {
  agent = await serve(app);
});

beforeEach(async () => {
  await freshTestDb();
  await seedDefaults();
  const made = await createAccount({ name: 'Zloty', currency: 'PLN' });
  if (!made.ok) throw new Error(`could not create the account: ${made.reason}`);
  accountId = made.account.id;
});

describe('a refill whose base currency moved under it', () => {
  it('leaves the row to the refill the change started, whichever answer arrives first', async () => {
    await insertTransactions([row('Warsaw lunch')]);
    const net = rateNetwork();
    try {
      const recompute = reclassifyAll();
      await vi.waitFor(() => expect(net.waiting('EUR')).toBe(1));

      const patched = await agent.patch('/api/app-settings').send({ baseCurrency: 'USD' });
      expect(patched.status, JSON.stringify(patched.body)).toBe(200);
      await vi.waitFor(() => expect(net.waiting('USD')).toBe(1));

      net.release('EUR');
      await recompute;
      net.release('USD');
      await vi.waitFor(async () => expect((await conversion()).converting).toBe(false));

      expect(await rowOf('Warsaw lunch')).toEqual({ base_amount_cents: -2500, fx_rate: USD_PER_PLN });
      expect(await conversion()).toEqual({ baseCurrency: 'USD', converting: false, unconverted: 0 });
    } finally {
      net.failAll();
      net.restore();
    }
  });

  it('writes no base-currency row at rate one once the base has moved past its first write', async () => {
    await insertTransactions([row('Berlin coffee', { amount: -12.5, currency: 'EUR' })]);
    await resetBaseAmounts();

    const db = dbInstance();
    const run = db.execute.bind(db);
    const dialect = new PgDialect();
    let parked = 0;
    let open = (): void => {};
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    const execute = vi.spyOn(db, 'execute').mockImplementation((q) => {
      const text = typeof q === 'string' ? q : dialect.sqlToQuery(q.getSQL()).sql;
      if (!text.includes('base_amount_cents = amount_cents')) return run(q);
      parked += 1;
      return opened.then(() => run(q)) as unknown as ReturnType<typeof run>;
    });
    const lines: string[] = [];
    let refill: Promise<number> | undefined;
    try {
      refill = backfillBaseAmounts((s) => lines.push(s));
      await vi.waitFor(() => expect(parked).toBe(1));

      await setSetting('base_currency', 'USD');
      await resetBaseAmounts();
      expect(parked, 'a second statement met the hold').toBe(1);
      open();
      await refill;

      expect(await rowOf('Berlin coffee')).toEqual(UNCONVERTED);
      expect(lines).toEqual([MOVED]);
    } finally {
      open();
      execute.mockRestore();
      await refill?.catch(() => undefined);
    }
  });

  it('writes nothing into the rows a restore brought in under another base', async () => {
    await insertTransactions([row('Warsaw lunch')]);
    const backup = await exportBackup();
    backup.tables.settings = backup.tables.settings.map((r) => {
      const setting = r as { key: string; value: string };
      return setting.key === 'base_currency' ? { ...setting, value: 'USD' } : setting;
    });
    expect(backup.tables.settings).toContainEqual({ key: 'base_currency', value: 'USD' });

    const net = rateNetwork();
    let refill: Promise<number> | undefined;
    try {
      refill = backfillBaseAmounts(() => {});
      await vi.waitFor(() => expect(net.waiting('EUR')).toBe(1));

      await restoreBackup(backup);
      net.release('EUR');
      await refill;

      expect(await rowOf('Warsaw lunch')).toEqual(UNCONVERTED);
    } finally {
      net.failAll();
      net.restore();
      await refill?.catch(() => undefined);
    }
  });

  it('reads the base a change of currency committed while the write waited on it', async () => {
    await insertTransactions([row('Warsaw lunch')]);
    const url = process.env.TEST_DATABASE_URL;
    if (!url) {
      await setSetting('base_currency', 'USD');
      await resetBaseAmounts();
      const answer = await applyBaseRate(DAY, 'PLN', EUR_PER_PLN, 'EUR');
      expect(await rowOf('Warsaw lunch')).toEqual(UNCONVERTED);
      expect(answer).toEqual({ moved: true, stored: 'USD' });
      return;
    }

    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: url, allowExitOnIdle: true });
    const blocker = await pool.connect();
    let open = false;
    let write: Promise<BaseWrite> | undefined;
    try {
      await blocker.query('BEGIN');
      open = true;
      // the route's order, setting then reset: the reverse deadlocks with the write, and the
      // case would then hold the deadlock detector instead of the guard
      await blocker.query(
        `INSERT INTO settings (key, value) VALUES ('base_currency', 'USD')
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      );
      await blocker.query('UPDATE transactions SET base_amount_cents = NULL, fx_rate = NULL');
      write = applyBaseRate(DAY, 'PLN', EUR_PER_PLN, 'EUR');
      await waitForBlockedQuery(pool, '%ROUND(amount_cents%');

      await blocker.query('COMMIT');
      open = false;
      const answer = await write;
      expect(await rowOf('Warsaw lunch')).toEqual(UNCONVERTED);
      expect(answer).toEqual({ moved: true, stored: 'USD' });
    } finally {
      if (open) await blocker.query('ROLLBACK');
      blocker.release();
      await write?.catch(() => undefined);
      await pool.end();
    }
  });

  it('asks for no further rate once a write finds the base moved, and says why it stopped', async () => {
    await insertTransactions([
      row('Warsaw lunch'),
      row('Warsaw dinner', { date: `${NEXT_DAY}T19:00:00.000Z` }),
    ]);
    const net = rateNetwork();
    const lines: string[] = [];
    let refill: Promise<number> | undefined;
    try {
      refill = backfillBaseAmounts((s) => lines.push(s));
      await vi.waitFor(() => expect(net.waiting('EUR')).toBe(1));

      await setSetting('base_currency', 'USD');
      await resetBaseAmounts();
      net.release('EUR');
      await refill;

      expect(await rowOf('Warsaw lunch')).toEqual(UNCONVERTED);
      expect(net.calls.filter((s) => s === 'EUR'), 'asked again for the old base after it moved').toHaveLength(1);
      expect(lines.filter((l) => l === MOVED)).toHaveLength(1);
      const log = lines.join('\n');
      for (const wording of ['not fetched', 'stopping:', 'picked up on the next recompute', 'rates left unapplied']) {
        expect(log).not.toContain(wording);
      }
    } finally {
      net.failAll();
      net.restore();
      await refill?.catch(() => undefined);
    }
  });
});
