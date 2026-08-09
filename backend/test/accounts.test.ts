/**
 * An account's identity is its id, not its name (ROADMAP 5.1, row 25).
 *
 * Two things are asserted here that nothing else can hold. **No two accounts in one
 * workspace share a name**, and that is the database's job - accounts_name_unique
 * over (workspace_id, lower(name)) - so the first test inserts straight into the
 * table rather than through a function that could be checking in JS. And **one name
 * resolves to one id, once**: an upload records the id it resolved on the import row
 * and the confirm reads it back, so the two requests cannot come to disagree about
 * where the rows went. Everything else in the file is a consequence of those two.
 *
 * PGlite is single-connection (CLAUDE.md), so the resolution window branch (b) does
 * not close - two uploads of a new name overlapping before either stages - is not
 * reproducible here. Its outcome is the confirm-time collision asserted below.
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
  resolveUploadAccountId,
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
import { markImportCommitted } from './helpers';
import { TEST_WORKSPACE_ID } from './pglite';

const csvFile = (...rows: string[]): string => ['date,amount,description', ...rows].join('\n');

async function upload(
  accountName: string,
  csv: string,
  currency = 'EUR',
): Promise<ImportSummary> {
  const result = await importStatement({
    accountName,
    currency,
    bytes: Buffer.from(csv, 'utf8'),
  });
  if (result.outcome !== 'awaiting_confirmation') {
    throw new Error(`expected a summary, got ${JSON.stringify(result)}`);
  }
  return result.summary;
}

/** The id arm: the account is picked, so the request carries no name and no currency. */
async function uploadTo(accountId: string, csv: string): Promise<ImportSummary> {
  const result = await importStatement({ accountId, bytes: Buffer.from(csv, 'utf8') });
  if (result.outcome !== 'awaiting_confirmation') {
    throw new Error(`expected a summary, got ${JSON.stringify(result)}`);
  }
  return result.summary;
}

/** What the import row itself records - the column, not the response that echoed it. */
async function recordedAccountId(importId: string): Promise<string | null> {
  const res = (await dbInstance().execute(
    sql`SELECT account_id FROM imports
        WHERE workspace_id = ${TEST_WORKSPACE_ID} AND id = ${importId}`,
  )) as unknown as { rows: { account_id: string | null }[] };
  return res.rows[0].account_id;
}

/** The other two columns of the same row: what this import was uploaded as. */
async function recordedAccount(
  importId: string,
): Promise<{ name: string | null; currency: string | null }> {
  const res = (await dbInstance().execute(
    sql`SELECT account_name, account_currency FROM imports
        WHERE workspace_id = ${TEST_WORKSPACE_ID} AND id = ${importId}`,
  )) as unknown as { rows: { account_name: string | null; account_currency: string | null }[] };
  return { name: res.rows[0].account_name, currency: res.rows[0].account_currency };
}

/** A refusal above createImport adds none, which is the half a message cannot show. */
async function importCount(): Promise<number> {
  const res = (await dbInstance().execute(
    sql`SELECT COUNT(*) AS n FROM imports WHERE workspace_id = ${TEST_WORKSPACE_ID}`,
  )) as unknown as { rows: { n: string }[] };
  return Number(res.rows[0].n);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('a name is unique per workspace, case-insensitively', () => {
  /**
   * Straight into the table: createAccount catches the violation and turns it into a
   * refusal, so going through it would pass just as well against a check written in
   * JS. This one fails if accounts_name_unique is not in the database.
   */
  it('the database refuses two names differing only in case', async () => {
    await dbInstance().execute(
      sql`INSERT INTO accounts (workspace_id, id, provider, name, currency, balance_cents)
          VALUES (${TEST_WORKSPACE_ID}, 'idx-a', 'upload', 'Revolut', 'EUR', 0)`,
    );
    // drizzle wraps the driver error, so the constraint is read off the cause - the
    // same chain isUniqueViolation walks. Asserted by NAME: any unique violation
    // would satisfy the code alone, and only this one is evidence that
    // accounts_name_unique is what refused the insert
    const refused = await dbInstance()
      .execute(
        sql`INSERT INTO accounts (workspace_id, id, provider, name, currency, balance_cents)
            VALUES (${TEST_WORKSPACE_ID}, 'idx-b', 'upload', 'REVOLUT', 'EUR', 0)`,
      )
      .then(
        () => undefined,
        (e: { cause?: unknown }) => e.cause,
      );
    expect(refused).toMatchObject({ code: '23505', constraint: 'accounts_name_unique' });
  });

  /**
   * Renaming an account to a case-variant of its own name is not a collision -
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

  it('and the same name in a workspace is refused with the holder, hidden or not', async () => {
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
   * suite is ASCII, where JS and SQL agree, so a JS fold would leave the file green -
   * and under one, an upload typed 'İSTANBUL' against an account stored as 'istanbul'
   * misses branch (a), mints a fresh id, and the confirm meets accounts_name_unique.
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

describe('an upload resolves its account name to one id', () => {
  it('joins an existing account, whose id is a UUID', async () => {
    const created = await createAccount({ name: 'Existing Bank', currency: 'EUR' });
    expect(created.ok).toBe(true);
    const id = created.ok ? created.account.id : '';
    expect(id).toMatch(UUID);

    // typed in a different case: the comparison runs in SQL, folded the way the
    // unique index folds it
    const summary = await upload('existing bank', csvFile('2026-01-05,-9.00,Joined'));
    expect(summary.accountId).toBe(id);
    expect(summary.accountExists).toBe(true);
    expect(await recordedAccountId(summary.importId)).toBe(id);

    expect(await confirmImport(summary.importId)).toMatchObject({
      confirmed: true,
      accountId: id,
      inserted: 1,
    });
    // and the name the user gave the account is not overwritten by the one typed
    // at upload: the upsert's conflict arm does not touch it
    expect((await getAccount(id))!.name).toBe('Existing Bank');
  });

  /**
   * Branch (b): two statements for one NEW bank, both staged before either is
   * confirmed. Without it each would mint its own id, the first confirm would create
   * the account and the second would meet accounts_name_unique - a working flow
   * turning into a refusal.
   */
  it('two uploads of one new account name land in one account', async () => {
    const first = await upload('Two Tabs Bank', csvFile('2026-01-06,-11.00,Tab one'));
    const second = await upload('two tabs bank', csvFile('2026-01-07,-12.00,Tab two'));

    expect(second.accountId).toBe(first.accountId);
    expect(first.accountId).toMatch(UUID);
    // neither exists yet: the account is created at confirm, not at upload
    expect(first.accountExists).toBe(false);
    expect(second.accountExists).toBe(false);
    expect(await getAccount(first.accountId)).toBeUndefined();

    expect(await confirmImport(first.importId)).toMatchObject({ confirmed: true, inserted: 1 });
    expect(await confirmImport(second.importId)).toMatchObject({ confirmed: true, inserted: 1 });
    expect(await listTransactions({ accountId: first.accountId })).toHaveLength(2);
  });

  /**
   * The mirror of the case above, and the reason branch (b) checks its precondition
   * instead of asserting it. An outstanding import records the id it resolved; if the
   * account behind that id has since been renamed, branch (a) misses - so the id names
   * an account answering to a DIFFERENT name, and handing it back would put this
   * statement's rows in it behind a 200, with no account delete to undo the merge.
   */
  it('does not join an outstanding import whose account has since been renamed', async () => {
    const created = await createAccount({ name: 'Split Bank', currency: 'EUR' });
    const holder = created.ok ? created.account.id : '';
    const outstanding = await upload('Split Bank', csvFile('2026-01-20,-31.00,Before the rename'));
    expect(outstanding.accountId).toBe(holder);

    // the import is left awaiting confirmation, still carrying `holder`
    await updateAccount(holder, { name: 'Split Bank EUR' });
    expect(await findAccountByName('Split Bank')).toBeUndefined();

    // a different bank, typed under the freed name
    const other = await upload('Split Bank', csvFile('2026-01-21,-32.00,A different bank'));
    expect(other.accountId).not.toBe(holder);
    expect(other.accountId).toMatch(UUID);
    expect(other.accountExists).toBe(false);

    // and a third upload joins that one rather than minting again: the precondition
    // is checked inside the query, so the ordering picks the oldest ELIGIBLE import
    // and not the ineligible one that happens to be older
    const third = await upload('split bank', csvFile('2026-01-22,-33.00,Same different bank'));
    expect(third.accountId).toBe(other.accountId);

    expect(await confirmImport(other.importId)).toMatchObject({ confirmed: true, inserted: 1 });
    expect(await confirmImport(third.importId)).toMatchObject({ confirmed: true, inserted: 1 });
    expect((await getAccount(other.accountId))!.name).toBe('Split Bank');
    expect(await listTransactions({ accountId: other.accountId })).toHaveLength(2);
    expect(await listTransactions({ accountId: holder })).toHaveLength(0);
  });

  /**
   * Row 24's boundary, and where row 26a moved it: a hidden account is still matched
   * by name - the refusal below is the evidence, because a lookup that missed it
   * would mint a fresh id, create a second account at confirm and answer 200 - but
   * the upload no longer stages against it. Both arms are refused, because a summary
   * card reading "they'll join your existing X" for an account the confirm is about
   * to refuse is a promise the server breaks one request later.
   *
   * Above createImport, so there is nothing left behind to explain: no import row,
   * no stored document, no history entry.
   */
  it('refuses an upload naming a removed account, and makes no second one', async () => {
    const created = await createAccount({ name: 'Removed Bank', currency: 'EUR' });
    const id = created.ok ? created.account.id : '';
    await updateAccount(id, { hidden: true });
    const before = await importCount();

    await expect(
      upload('Removed Bank', csvFile('2026-01-08,-13.00,Into the hidden')),
    ).rejects.toThrow(ACCOUNT_REMOVED);

    expect(await importCount()).toBe(before);
    // the name still answers to the one account, and it is still hidden
    expect((await findAccountByName('Removed Bank'))!.id).toBe(id);
    expect((await getAccount(id))!.hidden).toBe(true);
  });

  /** Consequence (b) of the row: a rename is no longer reverted by the next upload. */
  it('a rename survives the next import into the same account', async () => {
    const first = await upload('Renamed Bank', csvFile('2026-01-09,-14.00,Before'));
    await confirmImport(first.importId);
    expect(await updateAccount(first.accountId, { name: 'Renamed Bank EUR' })).toMatchObject({
      ok: true,
    });

    // typed with the account's NEW name, so branch (a) finds it: the rename stands,
    // and the upload does not write imports.account_name back over it
    const second = await upload('Renamed Bank EUR', csvFile('2026-01-10,-15.00,After'));
    expect(second.accountId).toBe(first.accountId);
    await confirmImport(second.importId);

    expect((await getAccount(first.accountId))!.name).toBe('Renamed Bank EUR');
    expect(await listTransactions({ accountId: first.accountId })).toHaveLength(2);
  });

  /**
   * The confirm reads imports.account_id and derives nothing. Asserted on the column
   * rather than on the response: an id echoed back from the request would pass a test
   * written against the response even if the confirm re-derived its own.
   */
  it('the confirm uses the id recorded on the import row, not the name', async () => {
    const created = await createAccount({ name: 'Recorded Bank', currency: 'EUR' });
    const id = created.ok ? created.account.id : '';
    const summary = await upload('Recorded Bank', csvFile('2026-01-11,-16.00,Recorded'));
    expect(await recordedAccountId(summary.importId)).toBe(id);

    // the name on the import is rewritten to one no account answers to; the id is
    // left alone. If the confirm derived from the name it would create a second
    // account, and the staged rows would be strays
    await dbInstance().execute(
      sql`UPDATE imports SET account_name = 'Something Else Entirely'
          WHERE workspace_id = ${TEST_WORKSPACE_ID} AND id = ${summary.importId}`,
    );

    expect(await confirmImport(summary.importId)).toMatchObject({ confirmed: true, accountId: id });
    expect(await findAccountByName('Something Else Entirely')).toBeUndefined();
    expect(await listTransactions({ accountId: id })).toHaveLength(1);
  });

  /**
   * A duplicate upload imports nothing, so it resolves nothing: minting an id there
   * would answer with a fresh, meaningless identifier for an account that does not
   * exist, on a request that wrote nothing.
   */
  it('a duplicate upload mints no id', async () => {
    const csv = csvFile('2026-01-12,-17.00,Duplicate');
    const first = await upload('Duplicate Bank', csv);
    await confirmImport(first.importId);

    const again = await importStatement({
      accountName: 'Nobody Has This Name',
      currency: 'EUR',
      bytes: Buffer.from(csv, 'utf8'),
    });
    expect(again.outcome).toBe('duplicate');
    if (again.outcome !== 'duplicate') return;
    expect(again.accountId).toBe(first.accountId);
    expect(await findAccountByName('Nobody Has This Name')).toBeUndefined();
  });
});

/**
 * The id arm (ROADMAP row 26a): the screen offers the accounts that exist and the
 * upload carries the id of the one that was picked. There is no name and no currency
 * in the request at all, so neither can be typed wrong - and the two columns the
 * import records come off the account's own row, which is what stops the currency
 * overwrite row 25's §20 accepted as a consequence.
 */
describe('an upload that picks its account by id', () => {
  it("records the account's own name and currency, never the request's", async () => {
    const created = await createAccount({ name: 'Picked Bank', currency: 'EUR' });
    const id = created.ok ? created.account.id : '';

    const summary = await uploadTo(id, csvFile('2026-04-01,-41.00,Picked'));
    expect(summary.accountId).toBe(id);
    expect(summary.accountName).toBe('Picked Bank');
    // always true on this arm: the lookup that produced the id is what proved it
    expect(summary.accountExists).toBe(true);
    expect(await recordedAccountId(summary.importId)).toBe(id);
    expect(await recordedAccount(summary.importId)).toEqual({
      name: 'Picked Bank',
      currency: 'EUR',
    });
  });

  /**
   * The case row 25's §20 accepted, closed here from the id side: there is no
   * currency in the request to overwrite the account's with, because the column the
   * import records is read off the account's own row.
   *
   * Row 65 closed it from the other side as well - `currency` left upsertAccountOn's
   * conflict set, so no arm rewrites an existing account's currency at all. The name
   * arm's half of that is the case below.
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

  it('refuses an id no account in this workspace answers to, and stages nothing', async () => {
    const before = await importCount();
    // not a UUID on purpose: nothing validates the shape, because an id restored
    // from a backup or written before row 25 is not one either
    await expect(uploadTo('no-such-account', csvFile('2026-04-03,-43.00,Nowhere'))).rejects.toThrow(
      ACCOUNT_NOT_FOUND,
    );
    expect(await importCount()).toBe(before);
  });

  it('refuses a removed account by id as well as by name', async () => {
    const created = await createAccount({ name: 'Picked Then Removed', currency: 'EUR' });
    const id = created.ok ? created.account.id : '';
    await updateAccount(id, { hidden: true });
    const before = await importCount();

    await expect(uploadTo(id, csvFile('2026-04-04,-44.00,Gone'))).rejects.toThrow(ACCOUNT_REMOVED);
    expect(await importCount()).toBe(before);
  });

  /**
   * `accountId` on a duplicate says where the EARLIER import's rows are, and that
   * import may have put them somewhere else entirely. The picked id must never stand
   * in for it - on this arm there is not even a name to look up as a fallback.
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
 * The other arm of the same guarantee (ROADMAP row 65). The name arm is the one that
 * hands a typed currency to an account it never read - uploadDestination returns the
 * request's own currency, and branch (a) of the id resolution then joins an account
 * that already exists - so uploading under an existing account's name used to
 * re-denominate it at confirm, at 200 and with nothing said.
 *
 * Held by the statement rather than by a branch: `currency` is not in
 * upsertAccountOn's conflict set, so there is no arm left for a later change to drop.
 */
describe('an upload that names an account that already exists', () => {
  it("does not re-denominate it, whatever currency the request stated", async () => {
    const created = await createAccount({ name: 'Named Bank', currency: 'EUR' });
    const id = created.ok ? created.account.id : '';

    const summary = await upload('Named Bank', csvFile('2026-04-06,-46.00,Named'), 'USD');
    expect(summary.accountId).toBe(id);
    expect(summary.accountExists).toBe(true);
    // what the FILE was uploaded as, which is allowed to disagree with the account
    // now: the column decides the currency of an account the confirm CREATES, and is
    // inert for one that is already there
    expect((await recordedAccount(summary.importId)).currency).toBe('USD');

    expect(await confirmImport(summary.importId)).toMatchObject({ confirmed: true, inserted: 1 });
    expect((await getAccount(id))!.currency).toBe('EUR');
    // and the rows keep the unit they were read in - nothing is reconverted
    expect((await listTransactions({ accountId: id }))[0].currency).toBe('USD');
  });
});

describe('a name taken between the upload and the confirm', () => {
  /**
   * The id was minted for an account that did not exist, and by confirm time
   * something else holds the name. Landing the rows in whoever holds it would merge
   * two banks' history with no account delete to undo it, so the confirm refuses -
   * and the refusal has to leave the import exactly as confirmable as it found it.
   */
  it('refuses, imports nothing, and stays confirmable once the obstacle moves', async () => {
    const csv = csvFile('2026-02-01,-21.00,Collided');
    const summary = await upload('Contested Bank', csv);
    const blocker = await createAccount({ name: 'Contested Bank', currency: 'EUR' });
    expect(blocker.ok).toBe(true);
    const blockerId = blocker.ok ? blocker.account.id : '';
    expect(blockerId).not.toBe(summary.accountId);

    expect(await confirmImport(summary.importId)).toEqual({
      confirmed: false,
      reason: 'account-name-taken',
      accountName: 'Contested Bank',
      taken: expect.objectContaining({ id: blockerId, name: 'Contested Bank' }),
    });
    // the whole transaction rolled back: no rows in either account, no account
    // under the staged id, and the import is where it was
    expect(await listTransactions({ accountId: summary.accountId })).toHaveLength(0);
    expect(await listTransactions({ accountId: blockerId })).toHaveLength(0);
    expect(await getAccount(summary.accountId)).toBeUndefined();
    expect(await recordedAccountId(summary.importId)).toBe(summary.accountId);

    // the obstacle renamed away, the same import confirms
    await updateAccount(blockerId, { name: 'Contested Bank Old' });
    expect(await confirmImport(summary.importId)).toMatchObject({
      confirmed: true,
      accountId: summary.accountId,
      inserted: 1,
    });
  });

  /**
   * The other exit, and the one the refusal's own sentence tells the user to take:
   * upload the file again. Only `committed` claims a file hash, so the bytes still
   * parse - and resolution consults existing accounts BEFORE outstanding imports, so
   * the re-upload finds the holder instead of the stale id that just collided. With
   * the two branches the other way round it would collide again, every time, and the
   * server's own advice would be a promise it breaks.
   */
  it('and re-uploading the same bytes joins the account holding the name', async () => {
    const csv = csvFile('2026-02-02,-22.00,Advised');
    const summary = await upload('Advised Bank', csv);
    const blocker = await createAccount({ name: 'Advised Bank', currency: 'EUR' });
    const blockerId = blocker.ok ? blocker.account.id : '';

    expect(await confirmImport(summary.importId)).toMatchObject({
      confirmed: false,
      reason: 'account-name-taken',
    });

    const again = await upload('Advised Bank', csv);
    expect(again.accountId).toBe(blockerId);
    expect(await confirmImport(again.importId)).toMatchObject({
      confirmed: true,
      accountId: blockerId,
      inserted: 1,
    });
    expect(await listTransactions({ accountId: blockerId })).toHaveLength(1);
  });
});

/**
 * Row 11a: the delete that is not a hide. Asserted per table with raw counts rather
 * than through the functions that read them - listTransactions and listImports both
 * filter, and a delete that left rows behind an account nothing displays would pass
 * every one of them.
 */
const countOf = async (q: SQL): Promise<number> => {
  const res = (await dbInstance().execute(q)) as unknown as { rows: { n: string | number }[] };
  return Number(res.rows[0].n);
};

const rowsOfAccount = (accountId: string): Promise<number> =>
  countOf(sql`SELECT COUNT(*) AS n FROM transactions
              WHERE workspace_id = ${TEST_WORKSPACE_ID} AND account_id = ${accountId}`);

const importsOfAccount = (accountId: string): Promise<number> =>
  countOf(sql`SELECT COUNT(*) AS n FROM imports
              WHERE workspace_id = ${TEST_WORKSPACE_ID} AND account_id = ${accountId}`);

const stagedOfAccount = (accountId: string): Promise<number> =>
  countOf(sql`SELECT COUNT(*) AS n FROM staged_transactions
              WHERE workspace_id = ${TEST_WORKSPACE_ID} AND account_id = ${accountId}`);

const rulesOfAccount = (accountId: string): Promise<number> =>
  countOf(sql`SELECT COUNT(*) AS n FROM transfer_rules
              WHERE workspace_id = ${TEST_WORKSPACE_ID} AND account_id = ${accountId}`);

const stagedOfImport = (importId: string): Promise<number> =>
  countOf(sql`SELECT COUNT(*) AS n FROM staged_transactions
              WHERE workspace_id = ${TEST_WORKSPACE_ID} AND import_id = ${importId}`);

const balanceOf = (accountId: string): Promise<number> =>
  countOf(sql`SELECT balance_cents AS n FROM accounts
              WHERE workspace_id = ${TEST_WORKSPACE_ID} AND id = ${accountId}`);

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
 * An import attributed to an account with nothing staged under it - the fixture
 * shape tenant-isolation.test.ts already uses, and the only way to write
 * imports.account_id without going through a real file.
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
    // `imports` are different numbers - equal ones would hide a column that arrived
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
   * The staged rows go by the foreign key on (workspace_id, import_id) and not by a
   * statement of this delete's own - which is the entry ACCOUNT_CASCADE answers with
   * CASCADES_FROM_IMPORTS. Reachable only through rows the account does not own:
   * staged rows carrying its OWN id refuse the delete instead (the case below).
   *
   * What it pins is not only that: the import destroyed here is awaiting_confirmation,
   * which settled decision 2 says must be refused, and it is destroyed behind ok: true
   * because the guard reads staged rows by account_id while the delete removes imports
   * by attribution. This asserts the cascade, not that outcome - see DEBT.md, "The
   * account delete's guard and its cascade disagree on a key".
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

  it('leaves another account in the same workspace exactly as it was', async () => {
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

  /** Trap 7: hiding is what people do before deleting, so the two must compose. */
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
   * accounts_name_unique is unconditional - (workspace_id, lower(name)), nothing
   * partial about it - so a delete that left the row behind would make the name
   * permanently unusable with nothing on any screen holding it.
   */
  it('frees the name it held', async () => {
    const id = await populate('Reusable Name');
    expect(await deleteAccount(id)).toMatchObject({ ok: true });

    const again = await createAccount({ name: 'reusable name', currency: 'USD' });
    expect(again).toMatchObject({ ok: true });
    expect(again.ok ? again.account.id : '').not.toBe(id);
  });

  it('answers not-found for an id this workspace does not have, twice over', async () => {
    expect(await deleteAccount('no-such-account')).toEqual({ ok: false, reason: 'not-found' });

    const id = await populate('Deleted Twice');
    expect(await deleteAccount(id)).toMatchObject({ ok: true });
    expect(await deleteAccount(id)).toEqual({ ok: false, reason: 'not-found' });
  });

  /**
   * Settled decision 2. Committed imports do NOT refuse - an account worth deleting
   * is precisely one that holds those, which is the case above - and this state is
   * different in kind: it is momentary and one click from over in either direction.
   *
   * Without the clause the delete takes the outstanding import too, and the summary
   * the user is looking at answers "import not found" on Confirm. Measured, not
   * assumed: with the clause removed this assertion reads
   * `{ ok: true, deleted: { imports: 3, transactions: 3, ... } }`.
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

    // transient, not a latch - and confirming is a way out as well as discarding,
    // which is what the route's sentence offers
    expect(await confirmImport(staged.importId)).toMatchObject({ confirmed: true });
    expect(await deleteAccount(id)).toMatchObject({
      ok: true,
      deleted: { transactions: 4, imports: 3 },
    });
  });

  /**
   * Trap 2's second direction. restoreBackup inserts `imports` and `transactions`
   * straight from a user-supplied file and sanitizeRow checks column names and types
   * only, so an import attributed to one account owning another account's rows is
   * constructible and nothing in the repository refuses it. The rows go with the
   * provenance being destroyed (deleteImport's semantics), and what is left in the
   * surviving account is repaired: the ordinals go back to a dense 1..n and the
   * balance is recomputed. Refusing instead would make an account undeletable over
   * a state its owner can neither see nor repair.
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

    // the count on the wire is the doomed account's OWN rows - it has none. What the
    // cascade took from the victim is in the log, not in this number
    expect(await deleteAccount(doomed)).toEqual({
      ok: true,
      deleted: { transactions: 0, imports: 1, documents: 0, transferRules: 0 },
    });

    expect(await rowsOfAccount(victim)).toBe(2);
    expect(await balanceOf(victim)).toBe(-1000);
    // the ordinals are dense again, asserted by the property a hole breaks: with the
    // group at {2,3} a re-import of the two rows that are still there claims 1 and 2,
    // finds 1 free, and inserts a duplicate (ROADMAP 4.4)
    expect(await insertTransactions([stagedRow(victim), stagedRow(victim)], ownImport)).toBe(0);
    expect(await rowsOfAccount(victim)).toBe(2);
  });

  /**
   * The compile-time census has a hole `satisfies` cannot close - it proves an entry
   * exists, not that it is executed - so a fifth account-scoped table must also make
   * a test fail, not only the type checker. Four names, spelled out.
   */
  it('accounts for every account-scoped table in the schema', () => {
    expect([...ACCOUNT_CASCADE_TABLES].sort()).toEqual([
      'imports',
      'stagedTransactions',
      'transactions',
      'transferRules',
    ]);
  });
});

describe('the account name bound', () => {
  it('is one number, and the resolver accepts a name of exactly that length', async () => {
    // built FROM the constant, never beside it: a literal here stops testing the
    // bound the moment the bound moves
    const longest = 'x'.repeat(ACCOUNT_NAME_MAX);
    const created = await createAccount({ name: longest, currency: 'EUR' });
    expect(created).toMatchObject({ ok: true });

    const id = created.ok ? created.account.id : '';
    expect(await resolveUploadAccountId(longest)).toBe(id);
  });
});
