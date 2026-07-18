/**
 * Restoring a dump taken before migration 002 (money as REAL, columns named `amount`,
 * `balance`, `monthly`). Every backup the user already has is one of these, so the
 * copy in restoreFrom has to translate them into the cents columns - see
 * LEGACY_COLUMNS in db.ts. Without that translation the columns would simply be
 * skipped and the INSERT would fail on NOT NULL.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  getAccount,
  getTransaction,
  listBaselineItems,
  migrateAfterRestore,
  restoreFrom,
} from '../src/db';
import { migration001 } from '../src/migrations/001-initial';

const legacyDump = path.join(os.tmpdir(), `finto-test-legacy-${process.pid}.db`);

afterAll(() => {
  fs.rmSync(legacyDump, { force: true });
});

/** A dump in the pre-002 schema: migration 001 alone is exactly that schema. */
function writeLegacyDump(): void {
  fs.rmSync(legacyDump, { force: true });
  const db = new Database(legacyDump);
  migration001.up(db);
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1')").run();

  db.prepare(
    `INSERT INTO accounts (id, provider, name, currency, balance)
     VALUES ('legacy-acc', 'monobank', 'Legacy', 'EUR', 1234.56)`,
  ).run();
  db.prepare(
    `INSERT INTO transactions (id, account_id, provider, amount, currency, date, description, category, base_amount, fx_rate)
     VALUES ('legacy-tx', 'legacy-acc', 'monobank', -42.35, 'EUR', '2026-01-10T12:00:00.000Z', 'legacy', 'other', -42.35, 1)`,
  ).run();
  // base_amount NULL (rate never fetched) must survive the copy as NULL, not as 0
  db.prepare(
    `INSERT INTO transactions (id, account_id, provider, amount, currency, date, description, category, base_amount, fx_rate)
     VALUES ('legacy-tx-norate', 'legacy-acc', 'monobank', -7.01, 'UAH', '2026-01-11T12:00:00.000Z', 'no rate', 'other', NULL, NULL)`,
  ).run();
  db.prepare(`INSERT INTO baseline_items (label, monthly, sort) VALUES ('Rent', 575.5, 0)`).run();
  db.close();
}

describe('restoring a pre-cents dump', () => {
  it('converts the old REAL money columns into cents', () => {
    writeLegacyDump();

    const { rows } = restoreFrom(legacyDump);
    migrateAfterRestore();
    expect(rows).toBeGreaterThan(0);

    // the domain API speaks decimals, so the values come back exactly as they went in
    expect(getTransaction('legacy-tx')!.amount).toBe(-42.35);
    expect(getTransaction('legacy-tx')!.baseAmount).toBe(-42.35);
    expect(getAccount('legacy-acc')!.balance).toBe(1234.56);
    expect(listBaselineItems().find((i) => i.label === 'Rent')!.monthly).toBe(575.5);

    // an unconverted row keeps "no base amount yet" instead of turning into 0
    expect(getTransaction('legacy-tx-norate')!.amount).toBe(-7.01);
    expect(getTransaction('legacy-tx-norate')!.baseAmount).toBeUndefined();
  });
});
