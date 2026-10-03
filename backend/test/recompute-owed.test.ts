import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app';
import { reclassifyAll, reclassifyIfStale } from '../src/classify';
import {
  allTransactions,
  dbInstance,
  deleteAccount,
  deleteImport,
  exportBackup,
  getMeta,
  insertTransactions,
  parseBackup,
  restoreBackup,
  seedDefaults,
  setCategoryOverride,
} from '../src/db';
import type { NewTransaction } from '../src/types';
import { accountFor, findTx, importAndConfirm, rejectionOf } from './helpers';
import { type Agent, serve } from './loopback';
import { freshTestDb } from './pglite';

const MONOBANK = 'https://api.monobank.ua/bank/currency';

let agent: Agent;
let income: string;
let spending: string;

const leg = (accountId: string, description: string, amount: number): NewTransaction => ({
  accountId, provider: 'upload', description, amount, date: '2026-08-10', currency: 'EUR', category: 'other', fee: null,
});
const incoming = (): NewTransaction => leg(income, 'Incoming amount', 300);
const outgoing = (): NewTransaction => leg(spending, 'Outgoing amount', -300);
const csvOf = (row: NewTransaction): Buffer =>
  Buffer.from(`date,amount,description\n${row.date},${row.amount.toFixed(2)},${row.description}\n`, 'utf8');

async function transfers(): Promise<Record<string, boolean>> {
  return Object.fromEntries((await allTransactions()).map((t) => [t.description, t.transfer]));
}

async function control(): Promise<void> {
  await reclassifyAll();
  expect(await reclassifyIfStale(), 'the control found something owed').toBe(false);
}

beforeAll(async () => {
  agent = await serve(app);
});

beforeEach(async () => {
  await freshTestDb();
  await seedDefaults();
  income = await accountFor('Owed income');
  spending = await accountFor('Owed spending');
});

describe('a row write leaves a recompute owed until a run has read past it', () => {
  it('confirming an import', async () => {
    await insertTransactions([incoming()]);
    await control();

    const confirmed = await importAndConfirm({ accountId: spending, bytes: csvOf(outgoing()) });
    expect(confirmed.inserted).toBe(1);
    expect(await transfers()).toEqual({ 'Incoming amount': false, 'Outgoing amount': false });

    expect(await reclassifyIfStale(), 'the confirmed rows were never offered for pairing').toBe('rows');
    expect(await transfers()).toEqual({ 'Incoming amount': true, 'Outgoing amount': true });
    expect(await reclassifyIfStale()).toBe(false);
  });

  it('deleting an import', async () => {
    const imported = await importAndConfirm({ accountId: income, bytes: csvOf(incoming()) });
    await insertTransactions([outgoing()]);
    await control();
    expect(await transfers()).toEqual({ 'Incoming amount': true, 'Outgoing amount': true });

    await deleteImport(imported.importId);
    expect(await transfers()).toEqual({ 'Outgoing amount': true });

    expect(await reclassifyIfStale(), 'the surviving leg kept a pair that is gone').toBe('rows');
    expect(await transfers()).toEqual({ 'Outgoing amount': false });
    expect(await reclassifyIfStale()).toBe(false);
  });

  it('deleting an account', async () => {
    await insertTransactions([incoming(), outgoing()]);
    await control();
    expect(await transfers()).toEqual({ 'Incoming amount': true, 'Outgoing amount': true });

    expect(await deleteAccount(spending)).toMatchObject({ ok: true });
    expect(await transfers()).toEqual({ 'Incoming amount': true });

    expect(await reclassifyIfStale(), 'the surviving leg kept a pair that is gone').toBe('rows');
    expect(await transfers()).toEqual({ 'Incoming amount': false });
    expect(await reclassifyIfStale()).toBe(false);
  });

  it('restoring a backup whose own stamps say nothing is owed', async () => {
    await insertTransactions([incoming(), outgoing()]);
    await control();
    const dump = parseBackup(JSON.parse(JSON.stringify(await exportBackup())));
    dump.tables.transactions = dump.tables.transactions.map((row) => ({ ...(row as object), transfer: false }));

    await restoreBackup(dump);
    expect(await transfers()).toEqual({ 'Incoming amount': false, 'Outgoing amount': false });

    expect(await reclassifyIfStale(), 'the restored stamps were taken at their word').toBe('rows');
    expect(await transfers()).toEqual({ 'Incoming amount': true, 'Outgoing amount': true });
    expect(await reclassifyIfStale()).toBe(false);
  });

  it('a manual category entering and leaving Support, and no other', async () => {
    await insertTransactions([incoming(), outgoing()]);
    await control();
    const help = await findTx((t) => t.amount > 0);
    const spent = await findTx((t) => t.amount < 0);

    const entered = await setCategoryOverride(help.id, 'support');
    expect(await transfers()).toEqual({ 'Incoming amount': true, 'Outgoing amount': true });
    expect(await reclassifyIfStale(), 'entering Support left the pair as it was').toBe('rows');
    expect(entered?.reclassify).toBe(true);
    expect(await transfers()).toEqual({ 'Incoming amount': false, 'Outgoing amount': false });
    expect(await reclassifyIfStale()).toBe(false);

    const left = await setCategoryOverride(help.id, null);
    expect(await transfers()).toEqual({ 'Incoming amount': false, 'Outgoing amount': false });
    expect(await reclassifyIfStale(), 'leaving Support left the pair broken').toBe('rows');
    expect(left?.reclassify).toBe(true);
    expect(await transfers()).toEqual({ 'Incoming amount': true, 'Outgoing amount': true });
    expect(await reclassifyIfStale()).toBe(false);

    const other = await setCategoryOverride(spent.id, 'food');
    expect(other?.reclassify, 'a category the classifier does not read asked for a recompute').toBe(false);
    expect(await reclassifyIfStale(), 'a category the classifier does not read left a debt').toBe(false);
  });

  it('is paid by the run of the door that wrote it', async () => {
    const made = await agent.post('/api/accounts').send({ name: 'Owed by a door', currency: 'EUR' });
    expect(made.status).toBe(201);
    await insertTransactions([leg(made.body.id, 'Door row', -12)]);
    await control();

    expect((await agent.delete(`/api/accounts/${made.body.id}`)).status).toBe(200);
    expect(await reclassifyIfStale(), 'the door answered and its own run left the debt unpaid').toBe(false);
  });

  it('leaves the signature as the rules make it', async () => {
    await insertTransactions([incoming()]);
    await control();
    const signed = await getMeta('classify_version');

    await insertTransactions([outgoing()]);
    expect(await reclassifyIfStale()).toBe('rows');
    expect(await getMeta('classify_version')).toBe(signed);
  });
});

describe('a run held at its rate call', () => {
  const realFetch = globalThis.fetch;
  let holding = false;
  let parked: (() => void)[] = [];

  const offline = (): Promise<Response> => Promise.reject(new Error('network disabled in tests'));

  // a rejection and never a rate list: rates.ts caches an answer for every later run
  const release = (): void => {
    const waiting = parked;
    parked = [];
    for (const fail of waiting) fail();
  };

  beforeEach(() => {
    holding = false;
    parked = [];
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      if (String(input) !== MONOBANK || !holding) return offline();
      const signal = init?.signal;
      return new Promise<Response>((_, reject) => {
        parked.push(() => reject(new Error('released')));
        signal?.addEventListener('abort', () => reject(signal.reason));
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    holding = false;
    release();
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('pays only the debt it loaded, not one written while it waited', async () => {
    await insertTransactions([incoming()]);
    await control();

    holding = true;
    const run = reclassifyAll();
    try {
      await vi.waitFor(() => expect(parked).toHaveLength(1));
      await insertTransactions([outgoing()]);
    } finally {
      holding = false;
      release();
      await run.catch(() => undefined);
    }

    expect(await transfers()).toEqual({ 'Incoming amount': false, 'Outgoing amount': false });
    expect(await reclassifyIfStale(), 'the run paid a write its rows never received').toBe('rows');
    expect(await transfers()).toEqual({ 'Incoming amount': true, 'Outgoing amount': true });
  });

  it('leaves the debt owed when its re-tag fails', async () => {
    await insertTransactions([incoming()]);
    await control();
    await insertTransactions([outgoing()]);

    const boom = new Error('the re-tag write failed');
    holding = true;
    const run = rejectionOf(reclassifyAll());
    let execute: { mockRestore: () => void } | undefined;
    try {
      await vi.waitFor(() => expect(parked).toHaveLength(1));
      execute = vi.spyOn(dbInstance(), 'execute').mockRejectedValueOnce(boom);
    } finally {
      holding = false;
      release();
      await run.catch(() => undefined);
      execute?.mockRestore();
    }

    expect(await run).toBe(boom);
    expect(await transfers()).toEqual({ 'Incoming amount': false, 'Outgoing amount': false });
    expect(await reclassifyIfStale(), 'a run that died half way recorded its debt paid').toBe('rows');
    expect(await transfers()).toEqual({ 'Incoming amount': true, 'Outgoing amount': true });
  });
});
