/**
 * An account's identity is its id, not its name.
 *
 * Two things are asserted here that nothing else can hold. **No two accounts share a
 * name**, and that is the database's job: accounts_name_unique over lower(name). So
 * the first test inserts straight into the table rather than through a function that
 * could be checking in JS. And **an upload records the id it was given and the
 * confirm reads it back**, so the two requests cannot come to disagree about where
 * the rows went. Everything else in the file is a consequence of those two.
 */
import { sql, type SQL } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_CASCADE_TABLES,
  ACCOUNT_NAME_MAX,
  type ResolvedAccountId,
  addTransferRule,
  clearImportDocument,
  confirmImport,
  createAccount,
  createImport,
  dbInstance,
  deleteAccount,
  findAccountByName,
  getAccount,
  insertTransactions,
  listTransactions,
  recalcAccountBalanceFromTransactions,
  stageImport,
  updateAccount,
} from '../src/db';
import {
  ACCOUNT_NOT_FOUND,
  ACCOUNT_REMOVED,
  ImportSummary,
  importStatement,
} from '../src/providers/statement';
import { NewTransaction } from '../src/types';
import { accountFor, markImportCommitted } from './helpers';

const csvFile = (...rows: string[]): string => ['date,amount,description', ...rows].join('\n');

/** The account is picked, so the request carries no name and no currency. */
async function uploadTo(accountId: string, csv: string): Promise<ImportSummary> {
  const result = await importStatement({ accountId, bytes: Buffer.from(csv, 'utf8') });
  if (result.outcome !== 'awaiting_confirmation') {
    throw new Error(`expected a summary, got ${JSON.stringify(result)}`);
  }
  return result.summary;
}

/** The id read off the import row's own column, not off the response that echoed it. */
async function recordedAccountId(importId: string): Promise<string | null> {
  const res = (await dbInstance().execute(
    sql`SELECT account_id FROM imports
        WHERE id = ${importId}`,
  )) as unknown as { rows: { account_id: string | null }[] };
  return res.rows[0].account_id;
}

/** The other two columns of the same row: what this import was uploaded as. */
async function recordedAccount(
  importId: string,
): Promise<{ name: string | null; currency: string | null }> {
  const res = (await dbInstance().execute(
    sql`SELECT account_name, account_currency FROM imports
        WHERE id = ${importId}`,
  )) as unknown as { rows: { account_name: string | null; account_currency: string | null }[] };
  return { name: res.rows[0].account_name, currency: res.rows[0].account_currency };
}

/** A refusal above createImport adds none, which is the half a message cannot show. */
async function importCount(): Promise<number> {
  const res = (await dbInstance().execute(
    sql`SELECT COUNT(*) AS n FROM imports`,
  )) as unknown as { rows: { n: string }[] };
  return Number(res.rows[0].n);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('a name is unique, case-insensitively', () => {
  /**
   * Straight into the table: createAccount catches the violation and turns it into a
   * refusal, so going through it would pass just as well against a check written in
   * JS. This one fails if accounts_name_unique is not in the database.
   */
  it('the database refuses two names differing only in case', async () => {
    await dbInstance().execute(
      sql`INSERT INTO accounts (id, provider, name, currency, balance_cents)
          VALUES ('idx-a', 'upload', 'Revolut', 'EUR', 0)`,
    );
    // drizzle wraps the driver error, so the constraint is read off the cause, which is
    // the same chain isUniqueViolation walks. Asserted by NAME: any unique violation
    // would satisfy the code alone, and only this one is evidence that
    // accounts_name_unique is what refused the insert
    const refused = await dbInstance()
      .execute(
        sql`INSERT INTO accounts (id, provider, name, currency, balance_cents)
            VALUES ('idx-b', 'upload', 'REVOLUT', 'EUR', 0)`,
      )
      .then(
        () => undefined,
        (e: { cause?: unknown }) => e.cause,
      );
    expect(refused).toMatchObject({ code: '23505', constraint: 'accounts_name_unique' });
  });

  /**
   * Renaming an account to a case-variant of its own name is not a collision, because
   * Postgres does not treat a row's own superseded version as a conflicting tuple.
   * Asserted rather than assumed: if it were false, a user could not fix the
   * capitalisation of their own account name and would be refused on behalf of the
   * very row they were editing.
   */
  it('but an account may be renamed to a case-variant of its own name', async () => {
    const created = await createAccount({ name: 'Sparkasse', currency: 'EUR' });
    expect(created.ok).toBe(true);
    const id = created.ok ? created.account.id : '';

    expect(await updateAccount(id, { name: 'SPARKASSE' })).toMatchObject({
      ok: true,
      account: { id, name: 'SPARKASSE' },
    });
  });

  it('and the same name is refused with the holder, hidden or not', async () => {
    const first = await createAccount({ name: 'N26', currency: 'EUR' });
    expect(first.ok).toBe(true);

    expect(await createAccount({ name: 'n26', currency: 'EUR' })).toMatchObject({
      ok: false,
      reason: 'name-taken',
      // the STORED name, which is the one on the user's screen
      taken: { name: 'N26' },
    });

    const id = first.ok ? first.account.id : '';
    await updateAccount(id, { hidden: true });
    expect(await createAccount({ name: 'n26', currency: 'EUR' })).toMatchObject({
      ok: false,
      reason: 'name-taken',
      taken: { name: 'N26', hidden: true },
    });
  });

  /**
   * The lookup folds a name the way the index folds it, held here by something that
   * fails rather than by findAccountByName's docstring alone. Every other name in the
   * suite is ASCII, where JS and SQL agree, so a JS fold would leave the file green.
   * Under one, 'İSTANBUL' beside an account stored as 'istanbul' could be refused by
   * accounts_name_unique while the lookup finds no holder for the refusal to name.
   *
   * The AGREEMENT is what is asserted, never one collation's answer: an engine whose
   * lower() maps U+0130 differently is not a defect, two doors disagreeing is.
   */
  it('the lookup and the index fold a name the same way', async () => {
    await createAccount({ name: 'istanbul', currency: 'EUR' });

    const probe = 'İSTANBUL';
    const found = await findAccountByName(probe);
    const created = await createAccount({ name: probe, currency: 'EUR' });

    // exactly one of the two: either the lookup sees the holder, or the insert is free
    expect(found === undefined).toBe(created.ok);
  });
});

/**
 * The id arm: the screen offers the accounts that exist and the upload carries the id
 * of the one that was picked. There is no name and no currency in the request at all,
 * so neither can be typed wrong. The two columns the import records come off the
 * account's own row, and that is what stops the currency overwrite that was accepted
 * as a consequence when identity moved to the id.
 */
describe('an upload that picks its account by id', () => {
  it("records the account's own name and currency, never the request's", async () => {
    const created = await createAccount({ name: 'Picked Bank', currency: 'EUR' });
    const id = created.ok ? created.account.id : '';

    const summary = await uploadTo(id, csvFile('2026-04-01,-41.00,Picked'));
    expect(summary.accountId).toBe(id);
    expect(summary.accountName).toBe('Picked Bank');
    expect(await recordedAccountId(summary.importId)).toBe(id);
    expect(await recordedAccount(summary.importId)).toEqual({
      name: 'Picked Bank',
      currency: 'EUR',
    });
  });

  /**
   * The case accepted as a consequence when identity moved to the id: there is no
   * currency in the request to overwrite the account's with, because the column the
   * import records is read off the account's own row. Since the upload stopped taking a
   * name, there is no other arm for one to arrive on.
   *
   * It is closed from the other side as well: the confirm does not call
   * upsertAccountOn, whose conflict set leaves `currency` out anyway, so nothing
   * rewrites an existing account's currency at confirm either.
   */
  it("leaves the account's currency alone when the statement states another", async () => {
    const created = await createAccount({ name: 'Savings', currency: 'EUR' });
    const id = created.ok ? created.account.id : '';

    const usd = ['date,amount,description,currency', '2026-04-02,-42.00,Dollar spend,USD'].join(
      '\n',
    );
    const summary = await uploadTo(id, usd);
    expect(summary.totals).toEqual([{ currency: 'USD', net: -42 }]);
    expect((await recordedAccount(summary.importId)).currency).toBe('EUR');

    expect(await confirmImport(summary.importId)).toMatchObject({ confirmed: true, inserted: 1 });
    expect((await getAccount(id))!.currency).toBe('EUR');
    // and the row keeps the currency its own file stated
    expect((await listTransactions({ accountId: id }))[0].currency).toBe('USD');
  });

  it('refuses an id no account answers to, and stages nothing', async () => {
    const before = await importCount();
    // not a UUID on purpose: nothing validates the shape, because an id restored
    // from a backup or written before identity moved to the id is not one either
    await expect(uploadTo('no-such-account', csvFile('2026-04-03,-43.00,Nowhere'))).rejects.toThrow(
      ACCOUNT_NOT_FOUND,
    );
    expect(await importCount()).toBe(before);
  });

  /**
   * The boundary sits at the upload: it does not stage against an
   * account the user removed, because a summary card reading "they'll join your
   * existing X" for an account the confirm is about to refuse is a promise the server
   * breaks one request later.
   *
   * Above createImport, so there is nothing left behind to explain: no import row, no
   * stored document, no history entry.
   */
  it('refuses a removed account, and leaves it exactly as it was', async () => {
    const created = await createAccount({ name: 'Picked Then Removed', currency: 'EUR' });
    const id = created.ok ? created.account.id : '';
    await updateAccount(id, { hidden: true });
    const before = await importCount();

    await expect(uploadTo(id, csvFile('2026-04-04,-44.00,Gone'))).rejects.toThrow(ACCOUNT_REMOVED);
    expect(await importCount()).toBe(before);
    expect((await getAccount(id))!.hidden).toBe(true);
  });

  /**
   * Since the upload stopped taking a name, a rename is no longer reverted by the next
   * upload.
   */
  it('a rename survives the next import into the same account', async () => {
    const id = await accountFor('Renamed Bank');
    const first = await uploadTo(id, csvFile('2026-01-09,-14.00,Before'));
    await confirmImport(first.importId);
    expect(await updateAccount(id, { name: 'Renamed Bank EUR' })).toMatchObject({ ok: true });

    // the second upload records the account's CURRENT name and writes nothing back:
    // the confirm creates no account, so imports.account_name reaches accounts.name
    // through nothing at all
    const second = await uploadTo(id, csvFile('2026-01-10,-15.00,After'));
    expect((await recordedAccount(second.importId)).name).toBe('Renamed Bank EUR');
    await confirmImport(second.importId);

    expect((await getAccount(id))!.name).toBe('Renamed Bank EUR');
    expect(await listTransactions({ accountId: id })).toHaveLength(2);
  });

  /**
   * The confirm reads imports.account_id and derives nothing from the other two
   * columns. The case rewrites account_name to a string no account answers to: if
   * anything below the null guard still read it, the rows would land somewhere else or
   * not at all. It asserts on the column rather than on the response, because an id
   * echoed back from the request would pass either way.
   */
  it('the confirm uses the id recorded on the import row, not the name', async () => {
    const id = await accountFor('Recorded Bank');
    const summary = await uploadTo(id, csvFile('2026-01-11,-16.00,Recorded'));
    expect(await recordedAccountId(summary.importId)).toBe(id);

    await dbInstance().execute(
      sql`UPDATE imports SET account_name = 'Something Else Entirely'
          WHERE id = ${summary.importId}`,
    );

    expect(await confirmImport(summary.importId)).toMatchObject({ confirmed: true, accountId: id });
    expect(await findAccountByName('Something Else Entirely')).toBeUndefined();
    expect(await listTransactions({ accountId: id })).toHaveLength(1);
  });

  /**
   * `accountId` on a duplicate says where the EARLIER import's rows are, and that
   * import may have put them somewhere else entirely. The picked id must never stand
   * in for it.
   */
  it("answers a duplicate with the earlier import's account, not the picked one", async () => {
    const target = await createAccount({ name: 'Duplicate Target', currency: 'EUR' });
    const targetId = target.ok ? target.account.id : '';
    const other = await createAccount({ name: 'Somewhere Else', currency: 'EUR' });
    const otherId = other.ok ? other.account.id : '';

    const csv = csvFile('2026-04-05,-45.00,Duplicated by id');
    const staged = await uploadTo(targetId, csv);
    await confirmImport(staged.importId);

    const again = await importStatement({ accountId: otherId, bytes: Buffer.from(csv, 'utf8') });
    expect(again.outcome).toBe('duplicate');
    if (again.outcome !== 'duplicate') return;
    expect(again.accountId).toBe(targetId);
    expect(again.accountIds).toEqual([targetId]);
  });
});

/**
 * The delete that is not a hide. Asserted per table with raw counts rather than through
 * the functions that read them. listTransactions and listImports both filter, so a
 * delete that left rows behind an account nothing displays would pass every one of them.
 */
const countOf = async (q: SQL): Promise<number> => {
  const res = (await dbInstance().execute(q)) as unknown as { rows: { n: string | number }[] };
  return Number(res.rows[0].n);
};

const rowsOfAccount = (accountId: string): Promise<number> =>
  countOf(sql`SELECT COUNT(*) AS n FROM transactions
              WHERE account_id = ${accountId}`);

const importsOfAccount = (accountId: string): Promise<number> =>
  countOf(sql`SELECT COUNT(*) AS n FROM imports
              WHERE account_id = ${accountId}`);

const stagedOfAccount = (accountId: string): Promise<number> =>
  countOf(sql`SELECT COUNT(*) AS n FROM staged_transactions
              WHERE account_id = ${accountId}`);

const rulesOfAccount = (accountId: string): Promise<number> =>
  countOf(sql`SELECT COUNT(*) AS n FROM transfer_rules
              WHERE account_id = ${accountId}`);

const stagedOfImport = (importId: string): Promise<number> =>
  countOf(sql`SELECT COUNT(*) AS n FROM staged_transactions
              WHERE import_id = ${importId}`);

const balanceOf = (accountId: string): Promise<number> =>
  countOf(sql`SELECT balance_cents AS n FROM accounts
              WHERE id = ${accountId}`);

/** One row, always in the same dedup group: one account, one day, one amount. */
const stagedRow = (accountId: string): NewTransaction => ({
  accountId,
  provider: 'upload',
  amount: -5,
  currency: 'EUR',
  date: '2026-06-15T00:00:00.000Z',
  description: 'attributed elsewhere',
  category: 'other',
  fee: null,
});

const newAccount = async (name: string): Promise<string> => {
  const created = await createAccount({ name, currency: 'EUR' });
  expect(created, `creating ${name}`).toMatchObject({ ok: true });
  return created.ok ? created.account.id : '';
};

/**
 * An import attributed to an account with nothing staged under it. This is the only way
 * to write imports.account_id without going through a real file.
 */
async function importFor(accountId: string, fileHash: string): Promise<string> {
  const record = await createImport({ fileHash, sourceType: 'csv', parserVersion: 1 });
  await stageImport(record.id, [], 0, {
    id: accountId as ResolvedAccountId,
    name: fileHash,
    currency: 'EUR',
  });
  await markImportCommitted(record.id, 0, 0);
  return record.id;
}

describe('deleting an account', () => {
  /** One of everything the cascade has to reach, and no two counts alike. */
  async function populate(name: string): Promise<string> {
    const id = await newAccount(name);
    const first = await uploadTo(
      id,
      csvFile(`2026-06-01,-61.00,${name} one`, `2026-06-02,-62.00,${name} two`),
    );
    expect(await confirmImport(first.importId)).toMatchObject({ confirmed: true, inserted: 2 });
    const second = await uploadTo(id, csvFile(`2026-06-03,-63.00,${name} three`));
    expect(await confirmImport(second.importId)).toMatchObject({ confirmed: true, inserted: 1 });
    // one of the two no longer claims a readable document, so `documents` and
    // `imports` are different numbers. Equal ones would hide a column that arrived
    // undefined through rowsVia and read as "no pointer"
    await clearImportDocument(second.importId);
    await addTransferRule(`${name} transfer`, id);
    return id;
  }

  it('removes its transactions, imports, transfer rules and the account row', async () => {
    const id = await populate('Doomed');
    expect(await rowsOfAccount(id)).toBe(3);
    expect(await importsOfAccount(id)).toBe(2);
    expect(await rulesOfAccount(id)).toBe(1);

    expect(await deleteAccount(id)).toEqual({
      ok: true,
      deleted: { transactions: 3, imports: 2, documents: 1, transferRules: 1 },
    });

    expect(await rowsOfAccount(id)).toBe(0);
    expect(await importsOfAccount(id)).toBe(0);
    expect(await stagedOfAccount(id)).toBe(0);
    expect(await rulesOfAccount(id)).toBe(0);
    expect(await getAccount(id)).toBeUndefined();
  });

  /**
   * The staged rows go by the foreign key on import_id and not by a statement of this
   * delete's own. That is why ACCOUNT_CASCADE answers their entry with
   * CASCADES_FROM_IMPORTS. Reachable only through rows the account does not own:
   * staged rows carrying its OWN id refuse the delete instead (the case below).
   *
   * What it pins is not only that: the import destroyed here is awaiting_confirmation,
   * which the delete is meant to refuse, and it is destroyed behind ok: true
   * because the guard reads staged rows by account_id while the delete removes imports
   * by attribution. This asserts the cascade, not that outcome: the guard and the cascade
   * disagree on a key, and that is a known gap rather than a rule.
   */
  it('takes the staged rows of every import it destroys', async () => {
    const owner = await newAccount('Staged Owner');
    const elsewhere = await newAccount('Staged Elsewhere');
    const record = await createImport({
      fileHash: 'staged-under-another-account',
      sourceType: 'csv',
      parserVersion: 1,
    });
    await stageImport(record.id, [stagedRow(elsewhere)], 0, {
      id: owner as ResolvedAccountId,
      name: 'Staged Owner',
      currency: 'EUR',
    });
    expect(await stagedOfImport(record.id)).toBe(1);

    expect(await deleteAccount(owner)).toMatchObject({ ok: true, deleted: { imports: 1 } });
    expect(await stagedOfImport(record.id)).toBe(0);
  });

  it('leaves another account exactly as it was', async () => {
    const doomed = await populate('Neighbour Doomed');
    const kept = await populate('Neighbour Kept');
    const balance = await balanceOf(kept);
    expect(balance).toBe(-18600);

    expect(await deleteAccount(doomed)).toMatchObject({ ok: true });

    expect(await rowsOfAccount(kept)).toBe(3);
    expect(await importsOfAccount(kept)).toBe(2);
    expect(await rulesOfAccount(kept)).toBe(1);
    expect(await balanceOf(kept)).toBe(balance);
  });

  /** Hiding is what people do before deleting, so the two must compose. */
  it('deletes a hidden account, which is what hiding is usually the first half of', async () => {
    const id = await populate('Hidden Then Deleted');
    expect(await updateAccount(id, { hidden: true })).toMatchObject({ ok: true });

    expect(await deleteAccount(id)).toMatchObject({
      ok: true,
      deleted: { transactions: 3, imports: 2 },
    });
    expect(await getAccount(id)).toBeUndefined();
  });

  /**
   * accounts_name_unique is an unconditional index on lower(name), with nothing partial
   * about it. So a delete that left the row behind would make the name permanently
   * unusable, with nothing on any screen holding it.
   */
  it('frees the name it held', async () => {
    const id = await populate('Reusable Name');
    expect(await deleteAccount(id)).toMatchObject({ ok: true });

    const again = await createAccount({ name: 'reusable name', currency: 'USD' });
    expect(again).toMatchObject({ ok: true });
    expect(again.ok ? again.account.id : '').not.toBe(id);
  });

  it('answers not-found for an id no account has, twice over', async () => {
    expect(await deleteAccount('no-such-account')).toEqual({ ok: false, reason: 'not-found' });

    const id = await populate('Deleted Twice');
    expect(await deleteAccount(id)).toMatchObject({ ok: true });
    expect(await deleteAccount(id)).toEqual({ ok: false, reason: 'not-found' });
  });

  /**
   * Committed imports do NOT refuse the delete, because an account worth deleting is
   * precisely one that holds them, as in the case above. This state is different in
   * kind: it is momentary and one click from over in either direction.
   *
   * Without the clause the delete takes the outstanding import too, and the summary the
   * user is looking at answers "import not found" on Confirm.
   */
  it('refuses while an import for it is awaiting confirmation, and deletes once it is gone', async () => {
    const id = await populate('Awaiting Confirmation');
    const staged = await uploadTo(id, csvFile('2026-06-04,-64.00,Still waiting'));

    expect(await deleteAccount(id)).toEqual({ ok: false, reason: 'staged-import' });
    // nothing of the account went with the refusal: the guard is a clause of the
    // statements themselves, so a refused delete rolls the whole cascade back
    expect(await rowsOfAccount(id)).toBe(3);
    expect(await importsOfAccount(id)).toBe(3);
    expect(await rulesOfAccount(id)).toBe(1);
    expect(await getAccount(id)).toBeDefined();

    // transient, not a latch. Confirming is a way out as well as discarding, which is
    // what the route's sentence offers
    expect(await confirmImport(staged.importId)).toMatchObject({ confirmed: true });
    expect(await deleteAccount(id)).toMatchObject({
      ok: true,
      deleted: { transactions: 4, imports: 3 },
    });
  });

  /**
   * restoreBackup inserts `imports` and `transactions` straight from a user-supplied file
   * and sanitizeRow checks each row on its own, never against another, so an import
   * attributed to one account owning another account's rows is constructible and nothing
   * in the repository refuses it. The rows go with the provenance being destroyed
   * (deleteImport's semantics), and what is left in the surviving account is repaired:
   * the ordinals go back to a dense 1..n and the balance is recomputed. Refusing instead
   * would make an account undeletable over a state its owner can neither see nor repair.
   */
  it("takes rows an import claims for another account, and repairs what is left there", async () => {
    const doomed = await newAccount('Stray Owner');
    const victim = await newAccount('Stray Victim');
    const strayImport = await importFor(doomed, 'stray-attributed');
    const ownImport = await importFor(victim, 'victim-own');

    // ordinal 1 of the group, owned by an import belonging to the doomed account
    expect(await insertTransactions([stagedRow(victim)], strayImport)).toBe(1);
    // and ordinals 2 and 3, owned by the victim's own import: a batch is numbered
    // from 1 and the index rejects the collision
    expect(
      await insertTransactions(
        [stagedRow(victim), stagedRow(victim), stagedRow(victim)],
        ownImport,
      ),
    ).toBe(2);
    await recalcAccountBalanceFromTransactions(victim);
    expect(await balanceOf(victim)).toBe(-1500);

    // the count on the wire is the doomed account's OWN rows, and it has none. What the
    // cascade took from the victim is in the log, not in this number
    expect(await deleteAccount(doomed)).toEqual({
      ok: true,
      deleted: { transactions: 0, imports: 1, documents: 0, transferRules: 0 },
    });

    expect(await rowsOfAccount(victim)).toBe(2);
    expect(await balanceOf(victim)).toBe(-1000);
    // the ordinals are dense again, asserted by the property a hole breaks: with the
    // group at {2,3} a re-import of the two rows that are still there claims 1 and 2,
    // finds 1 free, and inserts a duplicate
    expect(await insertTransactions([stagedRow(victim), stagedRow(victim)], ownImport)).toBe(0);
    expect(await rowsOfAccount(victim)).toBe(2);
  });

  /**
   * The compile-time census has a hole `satisfies` cannot close: it proves an entry
   * exists, not that it is executed. So a new account-scoped table must also make a
   * test fail, not only the type checker.
   */
  it('accounts for every account-scoped table in the schema', () => {
    expect([...ACCOUNT_CASCADE_TABLES].sort()).toEqual([
      'analyticsCharts',
      'debtPayoffGoals',
      'goalAccounts',
      'imports',
      'stagedTransactions',
      'transactions',
      'transferRules',
    ]);
  });
});

describe('the account name bound', () => {
  it('is one number, and a name of exactly that length is stored and found again', async () => {
    // built FROM the constant, never beside it: a literal here stops testing the
    // bound the moment the bound moves
    const longest = 'x'.repeat(ACCOUNT_NAME_MAX);
    const created = await createAccount({ name: longest, currency: 'EUR' });
    expect(created).toMatchObject({ ok: true });

    const id = created.ok ? created.account.id : '';
    // the lookup as well as the insert: a bound the column accepts and the index
    // folds differently would store a name nothing could find again
    expect((await findAccountByName(longest))!.id).toBe(id);
  });
});
