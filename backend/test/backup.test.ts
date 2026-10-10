import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  BackupData,
  createImport,
  dbInstance,
  deleteImport,
  exportBackup,
  getImportDocumentRef,
  getTransaction,
  insertTransactions,
  listAccounts,
  listImports,
  listTransactions,
  LOCAL_TABLES,
  parseBackup,
  recordImportDocument,
  restoreBackup,
  setOneOff,
} from '../src/db';
import { DocumentMissing, getDocument, putDocument } from '../src/documents';
import { storageRoot } from '../src/storage';
import { NewTransaction } from '../src/types';
import { accountFor, idOf, importAndConfirm, markImportCommitted } from './helpers';
import { schemaTables } from './pglite';

const queryRows = async <T>(query: ReturnType<typeof sql>): Promise<T[]> =>
  ((await dbInstance().execute(query)) as unknown as { rows: T[] }).rows;

const tx = (description: string, amount: number): NewTransaction => ({
  accountId: 'acc1',
  provider: 'monobank',
  amount,
  currency: 'EUR',
  date: '2026-01-10T12:00:00.000Z',
  description,
  category: 'other',
  fee: null,
});

describe('backup and restore (JSON)', () => {
  it('a backup restores the data, manual marks included', async () => {
    await insertTransactions([tx('backup marked', -10), tx('backup plain', -20)]);
    const marked = await idOf('backup marked');
    await setOneOff(marked, true);

    const data = await exportBackup();
    expect(data.format).toBe('quietpurse-backup');
    expect(data.version).toBe(2);
    expect(data.tables.transactions.length).toBeGreaterThanOrEqual(2);

    // the file survives a JSON round-trip (that is exactly what the endpoint sends)
    const reparsed = parseBackup(JSON.parse(JSON.stringify(data)));

    // "disaster": the mark is cleared, then we restore from the backup
    await setOneOff(marked, false);
    expect((await getTransaction(marked))!.oneOff).toBe(false);

    const { tables, rows } = await restoreBackup(reparsed);
    expect(tables).toBeGreaterThan(0);
    expect(rows).toBeGreaterThan(0);
    // the id survives the round-trip too: a restore is not a re-import, the rows
    // keep the identity the annotations were attached to
    expect((await getTransaction(marked))!.oneOff).toBe(true);
    expect((await listTransactions({ accountId: 'acc1' })).length).toBeGreaterThanOrEqual(2);
  });

  /**
   * exportBackup selects whole rows and sanitizeRow looks columns up through
   * getTableColumns, so a new column should ride along for free. Verified rather
   * than assumed: a fee that exports and does not restore is silent loss at exactly
   * the moment a user is relying on the file.
   */
  it('a stated fee survives export and restore, and so does a stated nothing', async () => {
    await insertTransactions([
      { ...tx('backup with fee', -63.62), fee: 0.44 },
      tx('backup without fee', -21.03),
    ]);

    const data = parseBackup(JSON.parse(JSON.stringify(await exportBackup())));
    await restoreBackup(data);

    const txs = await listTransactions({ accountId: 'acc1' });
    expect(txs.find((t) => t.description === 'backup with fee')!.fee).toBe(0.44);
    // NULL, not 0 - the fact "the source stated none" is what round-trips
    expect(txs.find((t) => t.description === 'backup without fee')!.fee).toBeUndefined();
  });

  /** imports restore before transactions, or import_id would have nothing to point at. */
  it('an import and the provenance of its rows survive the round-trip', async () => {
    const record = await createImport({
      fileHash: 'backup-hash',
      sourceType: 'csv',
      parserVersion: 1,
      originalFilename: 'statement.csv',
    });
    await markImportCommitted(record.id, 1, 0);
    await insertTransactions([tx('backup provenance', -33)], record.id);

    await restoreBackup(parseBackup(JSON.parse(JSON.stringify(await exportBackup()))));

    const restored = (await listImports()).imports.find((i) => i.id === record.id)!;
    expect(restored).toMatchObject({
      fileHash: 'backup-hash',
      originalFilename: 'statement.csv',
      status: 'committed',
    });
    expect(restored.transactions).toBe(1);
  });

  /**
   * The person's own backup, restored onto the machine that holds their statements:
   * the documents must still open. The key is derived from originalFilename, id and
   * sourceType, and a backup carries all three, so the pointer is reconstructible and
   * stripping it threw away something the restore can rebuild. Asserted on the DISK
   * and through getDocument both - a pointer that comes back and a file that does not
   * would pass either one alone.
   */
  it('a restore keeps the documents readable, and deleting the import still removes them', async () => {
    const csv = 'date,amount,description\n2026-05-05,-21.00,Restore then delete\n';
    const imported = await importAndConfirm({
      accountId: await accountFor('Restore Document Bank'),
      bytes: Buffer.from(csv, 'utf8'),
    });
    const blob = path.join(storageRoot(), `statement_${imported.importId}.csv`);
    const exists = (): Promise<boolean> =>
      fs
        .access(blob)
        .then(() => true)
        .catch(() => false);
    expect(await exists()).toBe(true);

    await restoreBackup(parseBackup(JSON.parse(JSON.stringify(await exportBackup()))));

    // the pointer came back with the row, and it names the file that is still there
    const ref = await getImportDocumentRef(imported.importId);
    expect(ref).toBeDefined();
    expect(await getDocument(ref!)).toEqual(Buffer.from(csv, 'utf8'));
    expect(await exists()).toBe(true);
    expect(
      (await listImports()).imports.find((i) => i.id === imported.importId)!.documentAvailable,
    ).toBe(true);

    expect(await deleteImport(imported.importId)).toBeDefined();
    expect(await exists()).toBe(false);
  });

  /**
   * The other arm of the restore, and the crafted backup with it. A claim the disk
   * cannot honour is not refused at restore time any more - it is answered at read
   * time, by the hash the row carries: a claim reaches a file only where the derived
   * key names one, and the bytes under it must hash to what the row recorded. So the
   * forged row resolves to a ref (the column is restored) and reads as nothing.
   */
  it('a restored claim reaches no file the row did not record', async () => {
    const statement = Buffer.from('date,amount,description\n2026-06-06,-42.00,Claimed\n', 'utf8');
    const fileHash = crypto.createHash('sha256').update(statement).digest('hex');
    const record = await createImport({ fileHash, sourceType: 'csv', parserVersion: 1 });
    await markImportCommitted(record.id, 1, 0);
    await putDocument({ importId: record.id, originalFilename: null, sourceType: 'csv' }, statement);
    await recordImportDocument(record.id);
    expect(await getDocument((await getImportDocumentRef(record.id))!)).toEqual(statement);

    const data = JSON.parse(JSON.stringify(await exportBackup())) as BackupData;
    const claimed = crypto.randomUUID();
    data.tables.imports.push({
      id: claimed,
      // its own hash: two committed imports of one file are what the partial index refuses
      fileHash: crypto.createHash('sha256').update('claimed').digest('hex'),
      sourceType: 'csv',
      originalFilename: 'claimed.csv',
      uploadedAt: new Date().toISOString(),
      parserVersion: 1,
      status: 'committed',
      rowsAccepted: 1,
      rowsRejected: 0,
      errorDetail: null,
      documentStored: true,
    });
    await restoreBackup(parseBackup(data));

    const stored = (await dbInstance().execute(
      sql`SELECT id, document_stored FROM imports WHERE id IN (${record.id}, ${claimed}) ORDER BY id`,
    )) as unknown as { rows: { id: string; document_stored: boolean }[] };
    expect(stored.rows).toHaveLength(2);
    expect(stored.rows.map((r) => r.document_stored)).toEqual([true, true]);

    // the forged row's key names no file, so the read refuses with the class the
    // route turns into a 404 rather than with a fault
    const forged = await getImportDocumentRef(claimed);
    expect(forged).toBeDefined();
    await expect(getDocument(forged!)).rejects.toBeInstanceOf(DocumentMissing);

    // and the real row reads its own bytes back, restore or no restore
    await expect(
      getDocument({ importId: record.id, originalFilename: null, sourceType: 'csv', fileHash }),
    ).resolves.toEqual(statement);
  });

  /**
   * The operator's own upgrade path: a backup taken before the bank
   * integrations were deleted is the file they restore from AFTER dropping and
   * recreating the database, so it has to keep working with tables and columns this
   * schema no longer has. The two halves are held differently and both are asserted
   * here - restoreBackup iterates BACKUP_TABLES, so a removed table's key is
   * structurally unreachable, while a removed COLUMN is dropped by sanitizeRow, which
   * is ordinary application code a later change can delete.
   *
   * `tables: 1` is the pin on the first half: the three legacy keys contributed
   * nothing and, more to the point, were never offered to a table that does not exist.
   */
  it('a backup taken before the bank integrations were removed still restores', async () => {
    const legacy = {
      format: 'quietpurse-backup' as const,
      version: 1 as const,
      exportedAt: '2026-05-01T00:00:00.000Z',
      tables: {
        accounts: [
          {
            id: 'acc-legacy',
            provider: 'monobank',
            name: 'Legacy Mono UAH',
            currency: 'UAH',
            balanceCents: 123456,
            iban: null,
            hidden: false,
            // the three columns this task dropped, exactly as an old export wrote them
            ebSessionId: 'eb-session-abc',
            lastSyncedAt: '2026-04-30T21:00:00.000Z',
            historyFrom: '2025-05-01',
          },
        ],
        // three tables this schema no longer knows
        eb_sessions: [
          {
            sessionId: 'eb-session-abc',
            aspspName: 'Revolut',
            aspspCountry: 'LT',
            validUntil: '2026-08-01T00:00:00.000Z',
            createdAt: '2026-05-01T00:00:00.000Z',
          },
        ],
        eb_auth_state: [
          {
            state: 'state-xyz',
            aspspName: 'Revolut',
            aspspCountry: 'LT',
            createdAt: '2026-05-01T00:00:00.000Z',
          },
        ],
        sync_log: [
          {
            id: 1,
            startedAt: '2026-04-30T21:00:00.000Z',
            finishedAt: '2026-04-30T21:04:00.000Z',
            ok: true,
            inserted: 7,
            errors: '[]',
            log: '["done"]',
          },
        ],
      },
    };

    const { tables, rows } = await restoreBackup(parseBackup(legacy));
    expect(tables).toBe(1);
    expect(rows).toBe(1);

    const account = (await listAccounts(true)).find((a) => a.id === 'acc-legacy');
    expect(account).toMatchObject({
      name: 'Legacy Mono UAH',
      currency: 'UAH',
      balance: 1234.56,
      provider: 'monobank',
    });
  });

  it('a version-one restore replaces stale goals and converts Goal data and budgets', async () => {
    await dbInstance().execute(sql`
      INSERT INTO goals (id, type, name, target_date, created_at, updated_at)
      VALUES ('stale-goal', 'monthly-income', 'Stale', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `);
    await dbInstance().execute(sql`
      INSERT INTO monthly_income_goals
        (goal_id, goal_type, target_monthly_cents, income_scope, window_months, base_currency)
      VALUES ('stale-goal', 'monthly-income', 100000, 'own', 6, 'EUR')
    `);

    const legacy = parseBackup({
      format: 'quietpurse-backup',
      version: 1,
      exportedAt: '2026-05-01T00:00:00.000Z',
      tables: {
        settings: [{ key: 'base_currency', value: 'GBP' }],
        meta: [
          {
            key: 'settings',
            value: JSON.stringify({
              goalMode: 'lifestyle',
              bufferPct: 15,
              windowMonths: 12,
              hourlyRate: 25,
              hoursCapPerWeek: 30,
            }),
          },
        ],
        baseline_items: [{ id: 9, label: 'Rent', monthlyCents: 90000, sort: 0 }],
        budgets: [{ category: 'food', monthlyCents: 45000 }],
      },
    });

    await restoreBackup(legacy);

    const goals = await queryRows<{ id: string; type: string }>(
      sql`SELECT id, type FROM goals ORDER BY type`,
    );
    expect(goals).toEqual([
      expect.objectContaining({ type: 'category-spending-limit' }),
      {
        id: '00000000-0000-4000-8000-000000000001',
        type: 'financial-independence',
      },
    ]);
    expect(goals).not.toContainEqual(expect.objectContaining({ id: 'stale-goal' }));

    const financial = await queryRows<{
      basis: string;
      buffer_pct: number;
      window_months: number;
      base_currency: string;
      hourly_rate_cents: number | null;
      hours_per_week: number;
    }>(sql`
      SELECT basis, buffer_pct, window_months, base_currency, hourly_rate_cents, hours_per_week
      FROM financial_independence_goals
    `);
    expect(financial[0]).toEqual({
      basis: 'current-spending',
      buffer_pct: 15,
      window_months: 12,
      base_currency: 'GBP',
      hourly_rate_cents: 2500,
      hours_per_week: 30,
    });
    const baseline = await queryRows<{ goal_id: string; label: string; monthly_cents: number }>(
      sql`SELECT goal_id, label, monthly_cents FROM baseline_items`,
    );
    expect(baseline).toEqual([
      {
        goal_id: '00000000-0000-4000-8000-000000000001',
        label: 'Rent',
        monthly_cents: 90000,
      },
    ]);
    const category = await queryRows<{
      category: string;
      monthly_limit_cents: number;
      base_currency: string;
    }>(sql`SELECT category, monthly_limit_cents, base_currency FROM category_spending_goals`);
    expect(category).toEqual([
      { category: 'food', monthly_limit_cents: 45000, base_currency: 'GBP' },
    ]);
    const oldSettings = await queryRows<{ key: string }>(
      sql`SELECT key FROM meta WHERE key = 'settings'`,
    );
    expect(oldSettings).toEqual([]);
  });

  it('a sparse version-one restore preserves omitted tables but replaces the goal family', async () => {
    await insertTransactions([tx('sparse restore survivor', -17)]);
    await dbInstance().execute(sql`
      INSERT INTO settings (key, value) VALUES ('sparse_restore_survivor', 'kept')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `);
    await dbInstance().execute(sql`
      INSERT INTO meta (key, value) VALUES ('sparse_restore_meta_survivor', 'kept')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `);
    const stamp = '2026-05-01T00:00:00.000Z';
    await dbInstance().execute(sql`
      INSERT INTO goals (id, type, name, target_date, created_at, updated_at)
      VALUES ('sparse-stale-goal', 'monthly-income', 'Stale', NULL, ${stamp}, ${stamp})
    `);
    await dbInstance().execute(sql`
      INSERT INTO monthly_income_goals
        (goal_id, goal_type, target_monthly_cents, income_scope, window_months, base_currency)
      VALUES ('sparse-stale-goal', 'monthly-income', 100000, 'own', 6, 'EUR')
    `);

    const restored = await restoreBackup(
      parseBackup({
        format: 'quietpurse-backup',
        version: 1,
        tables: {
          transfer_rules: [
            {
              id: 7,
              description: 'Sparse legacy rule',
              accountId: 'old',
              createdAt: '2026-05-01',
            },
          ],
        },
      }),
    );

    expect(restored).toEqual({ tables: 1, rows: 1 });
    expect((await listTransactions({ accountId: 'acc1' })).map((row) => row.description)).toContain(
      'sparse restore survivor',
    );
    expect(
      await queryRows<{ value: string }>(
        sql`SELECT value FROM settings WHERE key = 'sparse_restore_survivor'`,
      ),
    ).toEqual([{ value: 'kept' }]);
    expect(
      await queryRows<{ value: string }>(
        sql`SELECT value FROM meta WHERE key = 'sparse_restore_meta_survivor'`,
      ),
    ).toEqual([{ value: 'kept' }]);
    expect(await queryRows(sql`SELECT id FROM goals WHERE id = 'sparse-stale-goal'`)).toEqual([]);
  });

  it('refuses imports without transactions before their cascade can delete omitted rows', async () => {
    const record = await createImport({
      fileHash: 'sparse-import-hash',
      sourceType: 'csv',
      parserVersion: 1,
    });
    await markImportCommitted(record.id, 1, 0);
    await insertTransactions([tx('sparse import survivor', -23)], record.id);

    await expect(
      restoreBackup(
        parseBackup({
          format: 'quietpurse-backup',
          version: 1,
          tables: { imports: [] },
        }),
      ),
    ).rejects.toThrow('backup table imports requires transactions');

    expect((await listImports()).imports.map((row) => row.id)).toContain(record.id);
    expect((await listTransactions({ accountId: 'acc1' })).map((row) => row.description)).toContain(
      'sparse import survivor',
    );
  });

  it('refuses malformed legacy rows and settings instead of dropping them during conversion', async () => {
    const withSettings = (settings: Record<string, unknown>): Record<string, unknown[]> => ({
      meta: [{ key: 'settings', value: JSON.stringify(settings) }],
    });
    const malformed: Array<[Record<string, unknown[]>, RegExp]> = [
      [{ meta: [null] }, /meta: a row is not an object/],
      [{ baseline_items: ['bad'] }, /baseline_items: a row is not an object/],
      [{ meta: [{ key: 'settings', value: '{' }] }, /meta\.settings: invalid JSON/],
      [
        {
          meta: [
            { key: 'settings', value: '{"bufferPct":10}' },
            { key: 'settings', value: '{"bufferPct":20}' },
          ],
        },
        /meta\.settings: duplicate singleton rows/,
      ],
      [withSettings({ windowMonths: 'six' }), /windowMonths: expected a whole number/],
      [withSettings({ windowMonths: 6.5 }), /windowMonths: expected a whole number/],
      [withSettings({ bufferPct: -20 }), /bufferPct: expected a finite number/],
      [withSettings({ hourlyRate: -5 }), /hourlyRate: expected a finite number/],
      [withSettings({ hourlyRate: 12.345 }), /hourlyRate: expected a number with at most two decimal places/],
      [withSettings({ hoursCapPerWeek: 0 }), /hoursCapPerWeek: expected a finite number/],
      [{ budgets: [{ category: 'food', monthlyCents: 0 }] }, /budgets: invalid category/],
      [{ budgets: [{ category: 'groceriez', monthlyCents: 45000 }] }, /budgets: invalid category/],
    ];

    for (const [tables, message] of malformed) {
      await expect(
        restoreBackup(parseBackup({ format: 'quietpurse-backup', version: 1, tables })),
      ).rejects.toThrow(message);
    }
  });

  it('version two round-trips every goal subtype and its owned rows', async () => {
    await dbInstance().execute(sql`DELETE FROM goals`);
    const stamp = '2026-05-01T00:00:00.000Z';
    await dbInstance().execute(sql`
      INSERT INTO goals (id, type, name, target_date, created_at, updated_at) VALUES
        ('g-fi', 'financial-independence', 'FI', NULL, ${stamp}, ${stamp}),
        ('g-ef', 'emergency-fund', 'Emergency', '2027-01-01', ${stamp}, ${stamp}),
        ('g-sb', 'savings-balance', 'Savings', NULL, ${stamp}, ${stamp}),
        ('g-dp', 'debt-payoff', 'Debt', NULL, ${stamp}, ${stamp}),
        ('g-mi', 'monthly-income', 'Income', NULL, ${stamp}, ${stamp}),
        ('g-sr', 'savings-rate', 'Rate', NULL, ${stamp}, ${stamp}),
        ('g-cs', 'category-spending-limit', 'Food', NULL, ${stamp}, ${stamp})
    `);
    await dbInstance().execute(sql`
      INSERT INTO financial_independence_goals
        (goal_id, goal_type, basis, buffer_pct, window_months, base_currency, hourly_rate_cents, hours_per_week)
      VALUES ('g-fi', 'financial-independence', 'essential-costs', 10, 6, 'EUR', 2500, 20)
    `);
    await dbInstance().execute(sql`
      INSERT INTO emergency_fund_goals
        (goal_id, goal_type, monthly_essentials_cents, coverage_months, currency)
      VALUES ('g-ef', 'emergency-fund', 100000, 6, 'EUR')
    `);
    await dbInstance().execute(sql`
      INSERT INTO savings_balance_goals (goal_id, goal_type, target_cents, currency)
      VALUES ('g-sb', 'savings-balance', 500000, 'EUR')
    `);
    await dbInstance().execute(sql`
      INSERT INTO debt_payoff_goals
        (goal_id, goal_type, account_id, starting_debt_cents, target_debt_cents, currency)
      VALUES ('g-dp', 'debt-payoff', 'debt-account', 400000, 0, 'EUR')
    `);
    await dbInstance().execute(sql`
      INSERT INTO monthly_income_goals
        (goal_id, goal_type, target_monthly_cents, income_scope, window_months, base_currency)
      VALUES ('g-mi', 'monthly-income', 300000, 'own', 6, 'EUR')
    `);
    await dbInstance().execute(sql`
      INSERT INTO savings_rate_goals
        (goal_id, goal_type, target_basis_points, income_scope, window_months)
      VALUES ('g-sr', 'savings-rate', 2000, 'all', 12)
    `);
    await dbInstance().execute(sql`
      INSERT INTO category_spending_goals
        (goal_id, goal_type, category, monthly_limit_cents, base_currency)
      VALUES ('g-cs', 'category-spending-limit', 'groceries', 45000, 'EUR')
    `);
    await dbInstance().execute(sql`
      INSERT INTO goal_accounts (goal_id, account_id, position) VALUES
        ('g-ef', 'cash-a', 0), ('g-ef', 'cash-b', 1), ('g-sb', 'cash-a', 0)
    `);
    await dbInstance().execute(sql`
      INSERT INTO baseline_items (goal_id, label, monthly_cents, sort)
      VALUES ('g-fi', 'Rent', 90000, 0)
    `);

    const data = parseBackup(JSON.parse(JSON.stringify(await exportBackup())));
    await dbInstance().execute(sql`DELETE FROM goals`);
    await restoreBackup(data);

    const restored = await queryRows<{ type: string }>(sql`SELECT type FROM goals ORDER BY type`);
    expect(restored.map((row) => row.type)).toEqual([
      'category-spending-limit',
      'debt-payoff',
      'emergency-fund',
      'financial-independence',
      'monthly-income',
      'savings-balance',
      'savings-rate',
    ]);
    const links = await queryRows<{ goal_id: string; account_id: string; position: number }>(
      sql`SELECT goal_id, account_id, position FROM goal_accounts ORDER BY goal_id, position`,
    );
    expect(links).toEqual([
      { goal_id: 'g-ef', account_id: 'cash-a', position: 0 },
      { goal_id: 'g-ef', account_id: 'cash-b', position: 1 },
      { goal_id: 'g-sb', account_id: 'cash-a', position: 0 },
    ]);
    const costs = await queryRows<{ goal_id: string; label: string; monthly_cents: number }>(
      sql`SELECT goal_id, label, monthly_cents FROM baseline_items`,
    );
    expect(costs).toEqual([{ goal_id: 'g-fi', label: 'Rent', monthly_cents: 90000 }]);
    const financial = await queryRows<{ base_currency: string }>(
      sql`SELECT base_currency FROM financial_independence_goals`,
    );
    expect(financial).toEqual([{ base_currency: 'EUR' }]);
  });

  /**
   * imports.account_id is an ordinary column, so it exports and restores with no code
   * of its own - exportBackup selects whole rows and sanitizeRow keeps every real
   * column a restore carries like any other. Asserted rather than assumed, because the failure is
   * silent: an import that restores without the id it was staged against is one whose
   * confirm can no longer find its account.
   */
  it('the account an import was staged for survives the round-trip', async () => {
    const imported = await importAndConfirm({
      accountId: await accountFor('Account Id Backup Bank'),
      bytes: Buffer.from('date,amount,description\n2026-06-06,-44.00,Round trip\n', 'utf8'),
    });

    await restoreBackup(parseBackup(JSON.parse(JSON.stringify(await exportBackup()))));

    const restored = (await listImports()).imports.find((i) => i.id === imported.importId)!;
    expect(restored.accountId).toBe(imported.accountId);
    expect(restored.accountName).toBe('Account Id Backup Bank');
  });

  /**
   * accounts_name_unique applies to a restore, which inserts the file's accounts
   * wholesale: a backup holding two names differing only in case now fails, whole.
   * Accepted, and what makes it acceptable rather than catastrophic is that the DELETE
   * and every INSERT are one transaction - a refused restore leaves the database
   * exactly as it was, which is the half asserted here.
   */
  it('a restore refused by the name index leaves the existing rows untouched', async () => {
    await insertTransactions([tx('restore refusal survivor', -12)]);
    const before = await listTransactions({ accountId: 'acc1', limit: 100 });
    expect(before.length).toBeGreaterThan(0);
    const accountsBefore = (await listAccounts(true)).map((a) => a.id).sort();
    expect(accountsBefore.length).toBeGreaterThan(0);

    const clashing = {
      format: 'quietpurse-backup' as const,
      version: 1 as const,
      tables: {
        accounts: [
          { id: 'dup-a', provider: 'upload', name: 'Doubled', currency: 'EUR', balanceCents: 0 },
          { id: 'dup-b', provider: 'upload', name: 'DOUBLED', currency: 'EUR', balanceCents: 0 },
        ],
      },
    };
    // the constraint is read off the cause: drizzle wraps the driver error, and only
    // the name is evidence that this index is what refused the restore
    const refused = await restoreBackup(parseBackup(clashing)).then(
      () => undefined,
      (e: { cause?: unknown }) => e.cause,
    );
    expect(refused).toMatchObject({ code: '23505', constraint: 'accounts_name_unique' });

    expect(await listTransactions({ accountId: 'acc1', limit: 100 })).toHaveLength(before.length);
    // this is the line that depends on the rollback: accounts IS in the backup, so
    // its DELETE ran and only the rollback put the person's own accounts back. The
    // transactions line above does not - a table the backup omits is skipped whole
    expect((await listAccounts(true)).map((a) => a.id).sort()).toEqual(accountsBefore);
    expect((await listAccounts(true)).map((a) => a.id)).not.toContain('dup-a');
  });

  it('parseBackup rejects files that are not a Quietpurse backup', () => {
    expect(() => parseBackup(null)).toThrow(/not a Quietpurse backup/);
    expect(() => parseBackup({ format: 'something-else' })).toThrow(/not a Quietpurse backup/);
    expect(() => parseBackup({ format: 'quietpurse-backup', version: 99, tables: {} })).toThrow(
      /unsupported backup version/,
    );
    expect(() => parseBackup({ format: 'quietpurse-backup', version: 1 })).toThrow(/no tables/);
    expect(() =>
      parseBackup({ format: 'quietpurse-backup', version: 1, tables: { accounts: 'oops' } }),
    ).toThrow(/is not an array/);
  });

  it('parseBackup reads a backup written under the earlier name, finto-backup', () => {
    const parsed = parseBackup({ format: 'finto-backup', version: 2, tables: { accounts: [] } });
    expect(parsed.format).toBe('quietpurse-backup');
    expect(parsed.tables).toEqual({ accounts: [] });
  });

  /**
   * Export and restore iterate one object, so its order is the order a restore inserts in; if
   * the two ever stop sharing it, this holds the export alone.
   */
  it('a table a backup carries follows every table it references, and references none it leaves out', async () => {
    const references = await queryRows<{ child: string; parent: string }>(sql`
      SELECT c.relname AS child, p.relname AS parent
      FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid
      JOIN pg_class p ON p.oid = k.confrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE k.contype = 'f' AND n.nspname = 'public'`);
    expect(references).toContainEqual({ child: 'transactions', parent: 'imports' });

    const order = Object.keys((await exportBackup()).tables);
    for (const { child, parent } of references) {
      if (child === parent || !order.includes(child)) continue;
      expect(order, `${child} references ${parent}, which a backup does not carry`).toContain(
        parent,
      );
      expect(
        order.indexOf(parent),
        `${parent} is restored after ${child}, which references it`,
      ).toBeLessThan(order.indexOf(child));
    }
  });

  /**
   * A literal on purpose: moving a table to the local set is one line in the classification,
   * it drops that table out of every backup, and export and restore both still succeed. The
   * move has to show up as an edit here.
   */
  it('an export carries exactly these tables', async () => {
    expect(Object.keys((await exportBackup()).tables).sort()).toEqual([
      'accounts',
      'analytics_charts',
      'baseline_items',
      'category_rules',
      'category_spending_goals',
      'debt_payoff_goals',
      'emergency_fund_goals',
      'financial_independence_goals',
      'fx_rates',
      'goal_accounts',
      'goals',
      'imports',
      'income_sources',
      'meta',
      'monthly_income_goals',
      'recurring_ignores',
      'savings_balance_goals',
      'savings_rate_goals',
      'settings',
      'transactions',
      'transfer_rules',
    ]);
  });

  /**
   * Beside the typecheck, not instead of it: tsc reads the schema's types, and a table typed out
   * of its sight passes it undecided.
   */
  it('every table the schema exports is carried by a backup or local, once, under its SQL name', async () => {
    expect(
      [...Object.keys((await exportBackup()).tables), ...Object.keys(LOCAL_TABLES)].sort(),
    ).toEqual((await schemaTables()).sort());
  });

  /**
   * Over the local set itself, so a table classified local later is held the day it is. No
   * imports in the dump: deleting them cascades into staged rows, which is intended and is not
   * what this asserts.
   */
  it('a dump restores nothing into a local table it names', async () => {
    const goalTables = [
      'goals',
      'financial_independence_goals',
      'emergency_fund_goals',
      'savings_balance_goals',
      'debt_payoff_goals',
      'monthly_income_goals',
      'savings_rate_goals',
      'category_spending_goals',
      'goal_accounts',
      'baseline_items',
    ];
    for (const name of Object.keys(LOCAL_TABLES)) {
      const stored = () =>
        queryRows<{ row: string }>(
          sql`SELECT t::text AS row FROM ${sql.raw(name)} t ORDER BY 1`,
        );
      const before = await stored();
      const dump = parseBackup({
        format: 'quietpurse-backup',
        version: 2,
        tables: {
          ...Object.fromEntries(goalTables.map((goal) => [goal, []])),
          [name]: [{ marker: 'a row a dump carried under a local name' }],
        },
      });

      expect(await restoreBackup(dump), name).toEqual({ tables: goalTables.length, rows: 0 });
      expect(await stored(), name).toEqual(before);
    }
  });
});
