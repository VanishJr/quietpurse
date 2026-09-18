import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { reclassifyAll, reclassifyIfRulesChanged } from '../src/classify';
import { addTransferRule, allTransactions, exportBackup, insertTransactions, listTransferRules, parseBackup, restoreBackup, seedDefaults, setTransferOverride } from '../src/db';
import type { NewTransaction } from '../src/types';
import type { TransferRulePreview } from '../src/wire';
import { freshTestDb } from './pglite';

const agent = request(app);
let accountId: string;
const description = 'Example Person Gutschriften';

const transaction = (date: string, text = `${description} Wertstellung ${date.slice(8)}.${date.slice(5, 7)}.${date.slice(0, 4)}`): NewTransaction => ({
  accountId, provider: 'upload', date, description: text, amount: 50, currency: 'EUR', category: 'other', fee: null,
});

async function preview(id: string): Promise<TransferRulePreview> {
  const res = await agent.get(`/api/transactions/${id}/transfer-rule-preview`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

const apply = (p: TransferRulePreview) => agent.post('/api/transfer-rules').send({
  txId: p.txId, matchMode: 'similar-v1', previewToken: p.previewToken,
});

async function account(name: string): Promise<string> {
  const res = await agent.post('/api/accounts').send({ name, currency: 'EUR' });
  expect(res.status).toBe(201);
  return res.body.id;
}

beforeEach(async () => {
  await freshTestDb();
  await seedDefaults();
  accountId = await account('Similar transfers');
});

describe('similar transfer rules over HTTP', () => {
  it('removes only the trailing value date when a title itself contains another labelled date', async () => {
    const title = 'Example Wertstellung 01.01.2026';
    await insertTransactions([
      transaction('2026-08-31', `${title} Wertstellung 31.08.2026`),
      transaction('2026-09-01', `${title} Wertstellung 01.09.2026`),
      transaction('2026-09-02', 'Example Wertstellung 02.09.2026'),
    ]);
    const [source] = await allTransactions();
    const p = await preview(source.id);
    expect(p.matches).toBe(2);
    expect(p.transactions.every((t) => t.displayDescription === title)).toBe(true);
    expect((await apply(p)).status).toBe(200);
    expect((await allTransactions()).map((t) => t.transfer)).toEqual([true, true, false]);
    expect((await preview(source.id)).activeRule?.description).toBe(source.description);
  });

  it('previews and applies beyond the transactions endpoint default page', async () => {
    await insertTransactions(Array.from({ length: 1001 }, () => transaction('2026-08-31')));
    const list = await agent.get(`/api/transactions?accountId=${accountId}`);
    expect(list.body).toHaveLength(1000);
    const p = await preview(list.body[0].id);
    expect(p.transactions).toHaveLength(1001);
    expect(p.matches).toBe(1001);
    const res = await apply(p);
    expect(res.status).toBe(200);
    expect(res.body.matches).toBe(1001);
    expect((await allTransactions()).filter((t) => t.transfer)).toHaveLength(1001);
  });

  it('previews every date on the source account and applies the same set, retaining source descriptions', async () => {
    const other = await account('Another account');
    await insertTransactions([
      transaction('2025-08-31'), transaction('2026-08-31'),
      transaction('2026-09-01', ' EXAMPLE  PERSON Gutschriften Wertstellung 01.09.2026'),
      transaction('2026-09-02', 'Another Person Gutschriften Wertstellung 02.09.2026'),
      transaction('2026-09-03', `${description} contract 123 Wertstellung 03.09.2026`),
      transaction('2026-09-04', `${description} contract 124 Wertstellung 04.09.2026`),
      { ...transaction('2026-08-31'), accountId: other },
    ]);
    const before = await allTransactions();
    const source = before.find((t) => t.date === '2026-08-31' && t.accountId === accountId)!;
    const marked = before.find((t) => t.date === '2025-08-31')!;
    await setTransferOverride(marked.id, false);
    const p = await preview(source.id);
    expect(p).toMatchObject({ matches: 3, manualOverrides: 1, activeRule: null });
    expect(p.transactions.map((t) => t.date)).toEqual(['2026-09-01', '2026-08-31', '2025-08-31']);
    expect(p.transactions.find((t) => t.id === source.id)).toMatchObject({
      description: source.description, displayDescription: description, valueDate: '2026-08-31',
    });
    const res = await apply(p);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ matches: 3, rule: { matchMode: 'similar-v1', accountId } });
    const after = await allTransactions();
    expect(after.filter((t) => t.transfer).map((t) => t.id).sort()).toEqual(p.transactions.map((t) => t.id).sort());
    expect(after.map((t) => t.description)).toEqual(before.map((t) => t.description));
    expect(after.find((t) => t.id === marked.id)?.transferManual).toBeNull();
    const rules = await agent.get('/api/transfer-rules');
    expect(rules.body).toMatchObject([{ matches: 3 }]);
    const current = await agent.get(`/api/transactions/${source.id}`);
    expect(current.body).toMatchObject({ transfer: true, description: source.description });

    await insertTransactions([transaction('2026-10-01')]);
    await reclassifyAll();
    expect((await allTransactions()).find((t) => t.date === '2026-10-01')?.transfer).toBe(true);
    await setTransferOverride(source.id, false);
    await reclassifyAll();
    expect((await allTransactions()).find((t) => t.id === source.id)?.transfer).toBe(false);
    const removed = await agent.delete(`/api/transfer-rules/${res.body.rule.id}`);
    expect(removed.status).toBe(200);
    expect((await allTransactions()).filter((t) => t.transfer)).toEqual([]);
  });

  it('only expands legacy rules when the user applies the preview and consolidates the group', async () => {
    await insertTransactions([transaction('2026-08-31'), transaction('2026-09-01')]);
    const [first, second] = await allTransactions();
    const old = await addTransferRule(first.description, accountId);
    await reclassifyAll();
    expect((await allTransactions()).map((t) => t.transfer)).toEqual([true, false]);
    expect((await preview(first.id)).activeRule).toMatchObject({ id: old.id, matchMode: 'exact' });
    await addTransferRule(second.description, accountId);
    const res = await apply(await preview(first.id));
    expect(res.status).toBe(200);
    expect(await listTransferRules()).toMatchObject([{ matchMode: 'similar-v1' }]);
    expect(await listTransferRules()).toHaveLength(1);
    expect((await preview(second.id)).activeRule?.id).toBe(res.body.rule.id);
  });

  it.each(['new transaction', 'manual override', 'new rule'] as const)('refuses a stale preview after a %s without changing data', async (change) => {
    await insertTransactions([transaction('2026-08-31')]);
    const [source] = await allTransactions();
    const p = await preview(source.id);
    if (change === 'new transaction') await insertTransactions([transaction('2026-09-01')]);
    if (change === 'manual override') await setTransferOverride(source.id, false);
    if (change === 'new rule') await addTransferRule(source.description, accountId);
    const before = await exportBackup();
    const res = await apply(p);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Refresh the preview/);
    expect((await exportBackup()).tables).toEqual(before.tables);
    expect((await apply(await preview(source.id))).status).toBe(200);
  });

  it('preserves explicit rules and manual exceptions across backup, restore and reclassification', async () => {
    await insertTransactions([transaction('2026-08-31'), transaction('2026-09-01')]);
    const [source, other] = await allTransactions();
    expect((await apply(await preview(source.id))).status).toBe(200);
    await setTransferOverride(other.id, false);
    const backup = parseBackup(JSON.parse(JSON.stringify(await exportBackup())));
    await restoreBackup(backup);
    await reclassifyAll();
    expect((await allTransactions()).map((t) => t.transfer)).toEqual([true, false]);
    expect((await preview(source.id)).activeRule?.matchMode).toBe('similar-v1');
    expect(await reclassifyIfRulesChanged()).toBe(false);

    const legacy = await exportBackup();
    legacy.tables.transfer_rules = [{ description: source.description, accountId, createdAt: '2026-09-01' }];
    await restoreBackup(parseBackup(legacy));
    expect(await reclassifyIfRulesChanged()).toBe(true);
    expect((await listTransferRules())[0].matchMode).toBe('exact');
    expect((await allTransactions()).map((t) => t.transfer)).toEqual([true, false]);
  });

  it('refuses missing previews, unknown modes and absent transactions', async () => {
    const missing = await agent.get('/api/transactions/missing/transfer-rule-preview');
    expect(missing.status).toBe(404);
    expect((await agent.get('/api/transactions/missing')).status).toBe(404);
    expect((await agent.post('/api/transfer-rules').send({ txId: 'missing', matchMode: 'similar-v1' })).status).toBe(400);
    expect((await agent.post('/api/transfer-rules').send({ txId: 'missing', matchMode: 'anything' })).status).toBe(400);
    expect((await agent.post('/api/transfer-rules').send({ txId: 'missing', matchMode: 'similar-v1', previewToken: 'a'.repeat(64) })).status).toBe(404);
    await insertTransactions([transaction('2026-08-31', '  ')]);
    const [blank] = await allTransactions();
    const p = await preview(blank.id);
    expect(p.matches).toBe(0);
    expect((await apply(p)).status).toBe(400);
  });
});
