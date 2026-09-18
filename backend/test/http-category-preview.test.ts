import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import { reclassifyAll } from '../src/classify';
import { allTransactions, insertTransactions, listCategoryRules, seedDefaults, setCategoryOverride } from '../src/db';
import type { NewTransaction } from '../src/types';
import type { CategoryRulePreview } from '../src/wire';
import { freshTestDb } from './pglite';

const agent = request(app);
let accountId: string;
const row = (description = 'REWE Berlin Wertstellung 31.08.2026', date = '2026-08-31'): NewTransaction => ({
  accountId, provider: 'upload', description, date, amount: -20, currency: 'EUR', category: 'other', fee: null,
});
async function account(name: string): Promise<string> {
  const res = await agent.post('/api/accounts').send({ name, currency: 'EUR' });
  expect(res.status).toBe(201);
  return res.body.id;
}
async function preview(pattern = 'REWE Berlin'): Promise<CategoryRulePreview> {
  const res = await agent.post('/api/category-rules/preview').send({ pattern });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}
const apply = (p: CategoryRulePreview, category = 'shopping') => agent.post('/api/category-rules').send({
  pattern: p.pattern, category, previewToken: p.previewToken,
});

beforeEach(async () => {
  await freshTestDb();
  await seedDefaults();
  accountId = await account('Main');
});

describe('category rule preview', () => {
  it('previews full history including hidden accounts, preserves manual choices, and governs future imports', async () => {
    const hidden = await account('Hidden');
    await insertTransactions([
      row(), row('REWE Berlin Wertstellung 01.01.2025', '2025-01-01'),
      { ...row('rewe berlin Wertstellung 01.09.2026', '2026-09-01'), accountId: hidden }, row('Another shop'),
    ]);
    expect((await agent.patch(`/api/accounts/${hidden}`).send({ hidden: true })).status).toBe(200);
    const manual = (await allTransactions()).find((tx) => tx.date === '2025-01-01')!;
    await setCategoryOverride(manual.id, 'health');
    await reclassifyAll();
    const p = await preview();
    expect(p).toMatchObject({ matches: 3, overridden: 1, activeRule: null, otherRules: [] });
    expect(p.transactions.some((tx) => tx.accountId === hidden)).toBe(true);
    expect(await listCategoryRules()).toEqual([]);
    const res = await apply(p);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ matches: 3, overridden: 1 });
    expect((await allTransactions()).find((tx) => tx.id === manual.id)).toMatchObject({ category: 'health', categoryManual: true });
    await insertTransactions([row('REWE Berlin Wertstellung 15.09.2026', '2026-09-15')]);
    await reclassifyAll();
    expect((await allTransactions()).filter((tx) => tx.category === 'shopping')).toHaveLength(3);
    const updated = await preview();
    expect(updated.activeRule?.id).toBe(res.body.rule.id);
    expect((await agent.delete(`/api/category-rules/${res.body.rule.id}`)).status).toBe(200);
    expect((await allTransactions()).filter((tx) => tx.category === 'shopping')).toHaveLength(0);
    expect((await allTransactions()).find((tx) => tx.id === manual.id)?.category).toBe('health');
  });

  it('previews exactly the rows the rule tags where SQL and JavaScript lowercase a letter differently', async () => {
    await insertTransactions([row('İSTANBUL MARKET'), row('istanbul market', '2026-08-30'), row('ΟΔΟΣ ΑΘΗΝΑΣ 12', '2026-08-29')]);
    for (const [pattern, category] of [['istanbul', 'shopping'], ['οδος', 'housing']] as const) {
      const p = await preview(pattern);
      const res = await apply(p, category);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const tagged = (await allTransactions()).filter((tx) => tx.category === category).map((tx) => tx.id).sort();
      expect(p.transactions.map((tx) => tx.id).sort(), pattern).toEqual(tagged);
      expect(res.body.matches, pattern).toBe(tagged.length);
    }
  });

  it('is not capped by the transactions list and treats wildcards literally', async () => {
    await insertTransactions([...Array.from({ length: 1001 }, () => row('Shop 50%_')), row('Shop 500')]);
    const p = await preview('  Shop 50%_  ');
    expect(p.pattern).toBe('Shop 50%_');
    expect(p.matches).toBe(1001);
    expect(p.transactions).toHaveLength(1001);
    const res = await apply(p);
    expect(res.status).toBe(200);
    expect(res.body.matches).toBe(p.matches);
  });

  it.each(['import', 'manual', 'rule', 'pattern'] as const)('refuses a changed %s without saving the proposed rule', async (change) => {
    await insertTransactions([row()]);
    const p = await preview();
    if (change === 'import') await insertTransactions([row('REWE Berlin Wertstellung 01.09.2026', '2026-09-01')]);
    if (change === 'manual') await setCategoryOverride(p.transactions[0].id, 'health');
    if (change === 'rule') await agent.post('/api/category-rules').send({ pattern: 'REWE', category: 'food' });
    if (change === 'pattern') p.pattern = 'REWE';
    const before = await listCategoryRules();
    const res = await apply(p);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Refresh the preview');
    expect(await listCategoryRules()).toEqual(before);
  });

  it('makes broader existing rules discoverable and editable without changing their scope', async () => {
    await insertTransactions([row(), row('REWE Mitte')]);
    const created = await agent.post('/api/category-rules').send({ pattern: 'REWE', category: 'shopping' });
    expect(created.status).toBe(200);
    expect((await preview()).otherRules.map((rule) => rule.id)).toEqual([created.body.rule.id]);
    const p = await preview('REWE');
    expect(p.activeRule?.id).toBe(created.body.rule.id);
    expect(p.matches).toBe(2);
    expect((await apply(p, 'health')).status).toBe(200);
    expect(await listCategoryRules()).toHaveLength(1);
    expect((await allTransactions()).every((tx) => tx.category === 'health')).toBe(true);
  });

  it('allows a reviewed rule for future matches and refuses invalid input', async () => {
    for (const pattern of [undefined, '', '   ', 7]) {
      expect((await agent.post('/api/category-rules/preview').send({ pattern })).status).toBe(400);
    }
    const p = await preview('Future shop');
    expect(p.matches).toBe(0);
    expect((await apply(p)).status).toBe(200);
    expect((await agent.post('/api/category-rules').send({ pattern: 'Shop', category: 'food', previewToken: '' })).status).toBe(400);
    expect((await apply(p, 'not-a-category')).status).toBe(400);
  });
});
