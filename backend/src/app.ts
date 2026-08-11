/**
 * The Express application: middleware chain + every route. Deliberately separate
 * from the process entry point (index.ts, which connects the database and calls
 * listen) so that tests can mount this app against an embedded PGlite and drive
 * the real middleware chain over HTTP - the session check and the workspace
 * scoping are the parts most worth testing, and they only exist here.
 */
import express from 'express';
import multer from 'multer';
import { z } from 'zod';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import { ensureWorkspace, getAuth } from './auth';
import { CATEGORIES } from './categorizer';
import { reclassifyAll } from './classify';
import { config } from './config';
import {
  ACCOUNT_NAME_MAX,
  type ConfirmOutcome,
  ImportNotConfirmable,
  ImportStatus,
  type ResolvedAccountId,
  type SummaryScope,
  accountOtherCurrencies,
  addCategoryRule,
  addTransferRule,
  clearImportDocument,
  clearManualForRule,
  confirmImport,
  discardImport,
  countCategoryRuleMatches,
  countRuleMatches,
  currentBaseCurrency,
  dbInstance,
  listUserWorkspaceIds,
  runWithWorkspace,
  deleteAccount,
  deleteCategoryRule,
  deleteImport,
  exportBackup,
  listImports,
  parseBackup,
  restoreBackup,
  deleteIncomeSource,
  deleteTransferRule,
  getAccount,
  getImportDocumentInfo,
  getImportDocumentRef,
  getIncomeSource,
  getTransaction,
  type ImportDocumentInfo,
  listIncomeSources,
  resetBaseAmounts,
  upsertIncomeSource,
  listAccounts,
  baselineTotal,
  createAccount,
  deleteBaselineItem,
  listBaselineItems,
  listBudgets,
  listCategoryRules,
  listRecurringGroups,
  listTransactions,
  listTransferRules,
  setBudget,
  setIncomeSourceOverride,
  setOneOff,
  setRecurringIgnored,
  setTransferOverride,
  summaryByCategory,
  summaryIncomeByCategory,
  summaryIncomeBySource,
  summaryMonthlyTotals,
  summaryTotals,
  updateAccount,
  upsertBaselineItem,
} from './db';
import {
  DOCUMENT_DELETE_REFUSED,
  DOCUMENT_NOT_READABLE,
  DOCUMENT_READ_REFUSED,
  deleteDocument,
  getDocument,
  knowsKeyVersion,
} from './documents';
import { backfillBaseAmounts } from './fxrates';
import { computeIndependence } from './independence';
import { causeChain, logHttp, logImport, logger } from './logger';
import { CSV_PRESETS, CsvMapping } from './providers/csv';
import { type StatementDestination, importStatement } from './providers/statement';
import { getAppSettings, parseAppSettingsPatch, updateAppSettings } from './appsettings';
import { getSettings, updateSettings } from './settings';
import { Account, AccountMonthlySummary, AccountSummary, MonthlySummary, Summary } from './types';

export const app = express();

// CORS for a web client served from a different origin (allowlisted in
// CORS_ORIGINS). Cookie sessions require credentials, and with credentials the
// wildcard origin is forbidden - the exact origin is echoed back instead.
// Allow-Methods is required: the browser preflights a PATCH with a JSON body, and
// without this header the preflight fails (Express's Allow: does not count for CORS).
// Same-origin setups (the Vite dev proxy, a production host proxying /api) never
// send a cross-site Origin and skip this entirely.
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && config.corsOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    // x-invite-code: without it a cross-origin sign-up fails the preflight
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-invite-code');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    // Content-Disposition is not CORS-safelisted, so cross-origin JS cannot read the
    // filename of a download it fetched without this. Invisible under the same-origin
    // dev proxy and absent only in the deployed image, which is the worst place to find it
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

// better-auth handles registration/login/logout/session itself. Mounted BEFORE
// express.json: the handler consumes the raw request body.
app.all('/api/auth/*splat', (req, res) => {
  // Invite gate (SIGNUP_INVITE_CODE): checked here rather than inside better-auth
  // so it needs no access to the parsed body - a header keeps this independent of
  // the sign-up payload schema. Unset = open registration, the dev default.
  if (
    config.signupInviteCode &&
    req.path.startsWith('/api/auth/sign-up') &&
    req.get('x-invite-code') !== config.signupInviteCode
  ) {
    res.status(403).json({ error: 'registration on this server is invite-only' });
    return;
  }
  // The organization plugin is mounted for its schema and membership model only,
  // but that also publishes ~30 endpoints here - create, delete, invite-member.
  // Nothing in the app calls them (the session middleware below picks the
  // workspace from `member`), so they stay closed until multi-user workspaces land.
  if (req.path.startsWith('/api/auth/organization')) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  void toNodeHandler(getAuth())(req, res);
});

// HTTP log at debug level: enabled with LOG_LEVEL=debug, quiet otherwise
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    logHttp.debug(`${req.method} ${req.originalUrl} -> ${res.statusCode} ${Date.now() - startedAt}ms`);
  });
  next();
});

// ---------- API protection: cookie sessions (better-auth) ----------

// Every /api/* route below requires a signed-in session (only /api/health is open;
// /api/auth/* was already handled above). The session's workspace becomes the
// ambient scope for every db query in the request - membership is the only check,
// there are no per-role permissions inside a workspace (companies are out of scope).
app.use(async (req, res, next) => {
  if (req.path === '/api/health') {
    next();
    return;
  }
  const session = await getAuth().api.getSession({ headers: fromNodeHeaders(req.headers) });
  if (!session) {
    res.status(401).json({ error: 'sign in required' });
    return;
  }
  const memberships = await listUserWorkspaceIds(session.user.id);
  const active = session.session.activeOrganizationId;
  // A workspace the user is no longer a member of never wins - fall back to one
  // they actually belong to. Users with none get one built here: registration
  // normally does it, but that hook is not transactional with the user row, and a
  // stranded account beats no account (see ensureWorkspace in auth.ts).
  const workspaceId =
    active && memberships.includes(active)
      ? active
      : (memberships[0] ?? (await ensureWorkspace(dbInstance(), session.user.id)));
  // who is acting, for the routes that record it (imports.uploaded_by), and where -
  // the workspace travels as data too, for the body parsers below (see withWorkspace)
  res.locals.userId = session.user.id;
  res.locals.workspaceId = workspaceId;
  runWithWorkspace(workspaceId, () => next());
});

// Body parsing sits AFTER the session check on purpose: with a 25 MB limit,
// parsing before authenticating would let anyone who can reach the port make the
// server chew through 25 MB of JSON per request for free. The multipart parser on
// /api/imports obeys the same rule, and for the same reason.
// (The limit itself is for a backup restored as JSON - 100 kb is not enough.)
//
// And every parser that reads the body is mounted through withWorkspace(). The
// runWithWorkspace() above holds its store for the synchronous run of next() and
// for whatever inherits from it; the socket was created when the connection was
// accepted, outside that run, so a parser finishing on a later socket read calls
// next() with an empty store and the handler's first db call throws. A browser
// streams a multipart body, so that is every real upload. body-parser hands next()
// a plain callback in exactly the same way and survives only because raw-body binds
// it through AsyncResource - that package's choice, not a rule this app can rest
// its central invariant on.
export const withWorkspace =
  (mw: express.RequestHandler): express.RequestHandler =>
  (req, res, next) => {
    mw(req, res, (err?: unknown) => {
      const ws = res.locals.workspaceId as string | undefined;
      // /api/health calls next() before the workspace is resolved
      if (!ws) {
        next(err);
        return;
      }
      runWithWorkspace(ws, () => next(err));
    });
  };

app.use(withWorkspace(express.json({ limit: '25mb' })));

const q = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

// Open endpoint: also tells the web client whether registration needs an invite
// code, so the sign-up form can ask for one (see AuthScreen).
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, signup: config.signupInviteCode ? 'invite' : 'open' });
});

/**
 * An account name, at every door that writes one: create, rename, and the upload's
 * free-text field. One schema rather than three checks, because a rename that cannot
 * restore the name an account already has is worse than no bound at all - and zod
 * runs its checks in the order they are added, so a `.max()` written before `.trim()`
 * at one door bounds the untrimmed string while the next door bounds the trimmed one.
 */
const accountNameSchema = z
  .string({ error: 'account name must be text' })
  .trim()
  .max(ACCOUNT_NAME_MAX, { error: `account name must be at most ${ACCOUNT_NAME_MAX} characters` })
  .min(1, { error: 'account name must not be empty' });

/**
 * One schema at both doors it guards, for accountNameSchema's reason. Its message
 * no longer says "required": the field is optional at the account doors now (row
 * 65) and a sentence that is true at one door and false at the other is worse than
 * one that describes the value at both.
 */
const currencyCode = z
  .string({ error: 'currency must be a 3-letter ISO code' })
  .trim()
  .regex(/^[A-Za-z]{3}$/, { error: 'currency must be a 3-letter ISO code' });

/**
 * The account doors normalise, in one place covering both of them - a second
 * .toUpperCase() to remember is a second one to forget, and an account stored as
 * 'usd' lists every one of its own transactions as foreign to it on Overview.
 * The upload's door keeps the untransformed schema because it guards only the name
 * arm's typed currency - the id arm refuses the field outright, before any schema -
 * and uploadDestination upper-cases that arm's value itself, so transforming here
 * would normalise the same value twice. The raw case statement.ts argues for is the
 * id arm's account.currency, read back off the row, which passes no schema at all.
 */
const accountCurrency = currencyCode.transform((c) => c.toUpperCase());

// strict, for the reason mappingSchema is: a stripped unknown key is a field the
// user meant to send, silently not applied, answered 200
const newAccountSchema = z.strictObject({
  name: accountNameSchema,
  currency: accountCurrency.optional(),
});

const accountPatchSchema = z.strictObject({
  name: accountNameSchema.optional(),
  hidden: z.boolean({ error: 'hidden must be true or false' }).optional(),
  currency: accountCurrency.optional(),
});

/**
 * The currency may be corrected only while the account is empty, and the sentence
 * has to carry the way out because there is no control for it: deleting the
 * account's imports takes their transactions with them (transactions.import_id
 * cascades), which empties it and makes it correctable again.
 */
const HAS_TRANSACTIONS =
  'this account holds transactions, and changing its currency would relabel amounts that were never in it - delete the imports behind this account, which empties it, and the currency can be changed again';

/**
 * The other half of the same rule, and a different sentence because the advice
 * differs: holding transactions is permanent, an outstanding import is one click.
 * Confirming is not offered - its rows were prepared in the currency being replaced,
 * and once they land the account can no longer be corrected at all.
 */
const STAGED_IMPORT =
  'this account has an import waiting to be confirmed, and its rows were already prepared in the currency it has now - discard that import, change the currency, then upload the statement again';

/**
 * The same state refusing a different write, and it offers both ways out where the
 * sentence above offers only discard: confirming into an account that is about to
 * be deleted is harmless, where for a currency correction it defeats the correction.
 * A reader who compares the two learns something true.
 */
const DELETE_STAGED_IMPORT =
  'this account has an import waiting to be confirmed - confirm it or discard it, then delete the account';

/** The first zod issue as a sentence, unknown keys named rather than counted. */
const badRequest = (error: z.ZodError): string => {
  const issue = error.issues[0];
  return issue?.code === 'unrecognized_keys'
    ? `unknown field: ${issue.keys.map((k) => `"${k}"`).join(', ')}`
    : (issue?.message ?? 'the request body is not valid');
};

/**
 * accounts_name_unique refused the write. The holder's STORED name is quoted rather
 * than the string that was sent: the two differ in case exactly when the refusal is
 * most confusing, and the stored one is the one on the user's screen. A hidden holder
 * is named as hidden - otherwise the user is refused on behalf of a row nothing shows.
 */
const nameTaken = (taken: Account | undefined, requested: string): string => {
  const name = taken?.name ?? requested;
  return taken?.hidden
    ? `an account called "${name}" already has that name, and it has been removed from the app - restore it, or pick another name`
    : `an account called "${name}" already has that name`;
};

// ?all=1 - including hidden ones (the Accounts screen shows them so they can be restored)
app.get('/api/accounts', async (req, res) => {
  res.json(await listAccounts(q(req.query.all) === '1'));
});

/** An empty account: a name can exist before any statement has been uploaded into it. */
app.post('/api/accounts', async (req, res) => {
  const parsed = newAccountSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: badRequest(parsed.error) });
    return;
  }
  const result = await createAccount({
    name: parsed.data.name,
    // absent means the workspace's own unit, never a guess the client made on the
    // server's behalf (row 65). This is the one path into accounts.currency that
    // currencyCode does not see: the value is validated where it is written -
    // appsettings.ts refuses anything but three letters and uppercases, config.ts
    // uppercases the env seed - so the asymmetry is deliberate rather than missed.
    // POST {name, currency: 'euro'} is a 400; POST {name} against a settings row a
    // restored backup filled with junk is a 201.
    currency: parsed.data.currency ?? (await currentBaseCurrency()).toUpperCase(),
  });
  if (!result.ok) {
    res.status(409).json({ error: nameTaken(result.taken, parsed.data.name) });
    return;
  }
  res.status(201).json(result.account);
});

/**
 * Rename an account, remove it from the app, bring it back, or correct the currency
 * it was created in - the last only while it holds no rows, which is the whole of
 * what row 65 opened. There is no control for it yet, deliberately: the account menu
 * is row 27's and a step added now is a step rewritten twice.
 */
app.patch('/api/accounts/:id', async (req, res) => {
  const parsed = accountPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: badRequest(parsed.error) });
    return;
  }
  const { name, hidden, currency } = parsed.data;
  // the wire's half of what the patch type holds at the call site: a body that asks
  // for nothing is refused, never answered 200 for a write that did not happen
  const patch =
    name !== undefined
      ? { name, hidden, currency }
      : hidden !== undefined
        ? { hidden, currency }
        : currency !== undefined
          ? { currency }
          : undefined;
  if (!patch) {
    res
      .status(400)
      .json({ error: 'nothing to change: send name, hidden, currency, or any of them' });
    return;
  }
  const result = await updateAccount(req.params.id, patch);
  if (result.ok) {
    res.json(result.account);
    return;
  }
  // one switch over the union rather than a chain of ifs, for confirmConflict's
  // reason: a refusal added to AccountWrite is a compile error here instead of
  // falling through to "account not found", for an account on the user's screen
  switch (result.reason) {
    case 'name-taken':
      // only a patch that carried a name can meet accounts_name_unique, and
      // narrowing on it here is what keeps the refusal from having to invent a
      // requested name - the sentence has no arm that quotes an account called ""
      if (name !== undefined) {
        res.status(409).json({ error: nameTaken(result.taken, name) });
        return;
      }
      break;
    case 'has-transactions':
      res.status(409).json({ error: HAS_TRANSACTIONS });
      return;
    case 'staged-import':
      res.status(409).json({ error: STAGED_IMPORT });
      return;
    case 'not-found':
      break;
    default: {
      const unreachable: never = result;
      return unreachable;
    }
  }
  res.status(404).json({ error: 'account not found' });
});

/**
 * Removes the account for good, with its transactions, its imports, their staged
 * rows and their stored statements - the counts in the answer are what was
 * destroyed, taken from the deletes themselves. Distinct from hiding, which is the
 * PATCH above and is reversible (ROADMAP 5.1, 6.1).
 *
 * A hidden account is deletable: hiding is what people do before deleting. What is
 * refused is an import waiting to be confirmed - without that refusal this delete
 * takes the import too, and the summary card still on the user's screen answers
 * "import not found" when they press Confirm (see deleteAccount).
 *
 * The counts answer for THIS delete and not for the preview the client showed: for
 * a hidden account the panel counts transactions by summing over the account's
 * imports, which is a different fact from "rows with this account_id" - a row an
 * earlier import already wrote belongs to that earlier import. The two legitimately
 * differ.
 */
app.delete('/api/accounts/:id', async (req, res) => {
  const result = await deleteAccount(req.params.id);
  if (result.ok) {
    const { transactions, imports, documents, transferRules } = result.deleted;
    logger.info(
      `account ${req.params.id} deleted: ${transactions} transactions, ${imports} imports, ${documents} documents, ${transferRules} transfer rules removed`,
    );
    // transfer pairing changes when a whole leg disappears, and allTransactions()
    // deliberately included this account's rows (see VISIBLE_ACCOUNT in db/index.ts)
    await reclassifyAll();
    res.json({ deleted: true, transactions, imports, documents });
    return;
  }
  // one switch over the union, as the PATCH above: a refusal added to AccountDelete
  // is a compile error here instead of falling through to "account not found"
  switch (result.reason) {
    case 'staged-import':
      res.status(409).json({ error: DELETE_STAGED_IMPORT });
      return;
    case 'not-found':
      break;
    default: {
      const unreachable: never = result;
      return unreachable;
    }
  }
  res.status(404).json({ error: 'account not found' });
});

app.get('/api/transactions', async (req, res) => {
  const limit = q(req.query.limit) ? parseInt(q(req.query.limit)!, 10) : undefined;
  res.json(
    await listTransactions({
      from: q(req.query.from),
      to: q(req.query.to),
      accountId: q(req.query.accountId),
      category: q(req.query.category),
      limit,
    }),
  );
});

/** Manual "transfer between own accounts" mark; null hands the decision back to auto-detection. */
app.patch('/api/transactions/:id/transfer', async (req, res) => {
  const value = (req.body as { transfer?: unknown }).transfer;
  if (value !== true && value !== false && value !== null) {
    res.status(400).json({ error: 'transfer field required: true | false | null' });
    return;
  }
  const tx = await setTransferOverride(req.params.id, value);
  if (!tx) {
    res.status(404).json({ error: 'transaction not found' });
    return;
  }
  res.json(tx);
});

// ---------- "all transactions like this are transfers" rules ----------

/** matches: how many transactions each rule covers (the caption next to the switch). */
app.get('/api/transfer-rules', async (_req, res) => {
  const rules = await listTransferRules();
  res.json(
    await Promise.all(
      rules.map(async (r) => ({
        ...r,
        matches: await countRuleMatches(r.description, r.accountId),
      })),
    ),
  );
});

/**
 * "Mark every transaction like this as a transfer": the rule is built from the
 * description + account of transaction txId and applied to the whole history at
 * once, and to every new transaction after a sync.
 */
app.post('/api/transfer-rules', async (req, res) => {
  const txId = (req.body as { txId?: unknown }).txId;
  if (typeof txId !== 'string' || !txId) {
    res.status(400).json({ error: 'txId field required' });
    return;
  }
  const tx = await getTransaction(txId);
  if (!tx) {
    res.status(404).json({ error: 'transaction not found' });
    return;
  }
  if (!tx.description) {
    res.status(400).json({ error: 'the transaction has an empty description - there is nothing to hang a rule on' });
    return;
  }
  const rule = await addTransferRule(tx.description, tx.accountId);
  // otherwise an old manual "this is not a transfer" would override the rule just created
  await clearManualForRule(tx.description, tx.accountId);
  await reclassifyAll();
  res.json({ rule, matches: await countRuleMatches(rule.description, rule.accountId) });
});

/** Dropping a rule returns its transactions to auto-detection. */
app.delete('/api/transfer-rules/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'invalid rule id' });
    return;
  }
  if (!(await deleteTransferRule(id))) {
    res.status(404).json({ error: 'rule not found' });
    return;
  }
  await reclassifyAll();
  res.json({ deleted: true });
});

type ScopeResult =
  | { ok: true; scope: SummaryScope }
  | { ok: false; status: number; error: string };

/**
 * Which summary a request is asking for, written once so the two routes below
 * cannot drift.
 *
 * Not q(): it maps both '' and a repeated parameter to undefined, and undefined
 * here means the whole workspace in the base currency - so a caller building
 * `?accountId=${account?.id ?? ''}` would be handed every account's money labelled
 * as one account's. Presence first, then the type, then the trimmed string, and
 * each of the two refusals says its own cause: `?accountId=` was sent exactly once
 * (Express 5's simple parser hands it over as ''), so answering it with the
 * repeated-parameter sentence names something that did not happen.
 *
 * An unresolvable id is a 404 rather than a 200 of zeroes: a per-account body has
 * to state a currency and there is no currency without an account. getAccount is
 * workspace-scoped, so another workspace's id and a nonexistent one produce the
 * same answer. A hidden account resolves like any other - the caller named it by
 * id, and VISIBLE_ACCOUNT() keeps hidden accounts out of workspace totals, not out
 * of their own.
 */
async function summaryScope(raw: unknown): Promise<ScopeResult> {
  if (raw === undefined) return { ok: true, scope: { kind: 'workspace' } };
  if (typeof raw !== 'string') {
    return { ok: false, status: 400, error: 'accountId must be sent once, as a single value' };
  }
  const id = raw.trim();
  if (!id) return { ok: false, status: 400, error: 'accountId must not be empty' };
  const account = await getAccount(id);
  if (!account) return { ok: false, status: 404, error: 'account not found' };
  // branded here and only here on this path: the id is the one read off the row, so
  // no string that arrived in the query can reach a summary query unproven
  return {
    ok: true,
    scope: { kind: 'account', id: account.id as ResolvedAccountId, currency: account.currency },
  };
}

/**
 * The current calendar month by default, or an explicit ?from=&to=. Without
 * ?accountId= this is the whole workspace in the base currency; with one it is that
 * account alone, in the account's own currency, and the body says which by its
 * `scope` field. Transfers between your own accounts are excluded from every figure
 * on both arms, refunds are subtracted from spending in their own category (see
 * classify.ts).
 */
app.get('/api/summary', async (req, res) => {
  const picked = await summaryScope(req.query.accountId);
  if (!picked.ok) {
    res.status(picked.status).json({ error: picked.error });
    return;
  }
  const now = new Date();
  let from = q(req.query.from);
  let to = q(req.query.to);
  if (!from || !to) {
    from = `${now.toISOString().slice(0, 7)}-01`;
    to = now.toISOString().slice(0, 10);
  }
  const fromIso = `${from}T00:00:00.000Z`;
  const toIso = `${to}T23:59:59.999Z`;
  const scope = picked.scope;
  if (scope.kind === 'account') {
    const summary: AccountSummary = {
      scope: 'account',
      from,
      to,
      accountId: scope.id,
      currency: scope.currency,
      otherCurrencies: await accountOtherCurrencies(scope),
      totals: await summaryTotals(scope, fromIso, toIso),
      byCategory: await summaryByCategory(scope, fromIso, toIso),
      incomeByCategory: await summaryIncomeByCategory(scope, fromIso, toIso),
      incomeBySource: await summaryIncomeBySource(scope, fromIso, toIso),
    };
    res.json(summary);
    return;
  }
  const summary: Summary = {
    scope: 'workspace',
    from,
    to,
    baseCurrency: await currentBaseCurrency(),
    totals: await summaryTotals(scope, fromIso, toIso),
    byCategory: await summaryByCategory(scope, fromIso, toIso),
    incomeByCategory: await summaryIncomeByCategory(scope, fromIso, toIso),
    incomeBySource: await summaryIncomeBySource(scope, fromIso, toIso),
  };
  res.json(summary);
});

/**
 * Spending/income by month - the "over the year" chart, for the workspace in the
 * base currency or for one ?accountId= in its own. The account arm answers `net`
 * as well, every row of the month summed, so over a window covering the account's
 * whole history the bars add up to the balance shown beside them; over a shorter
 * one - the calendar year this route defaults to, for instance - they add up to
 * that window's movement and the balance does not.
 */
app.get('/api/summary/months', async (req, res) => {
  const picked = await summaryScope(req.query.accountId);
  if (!picked.ok) {
    res.status(picked.status).json({ error: picked.error });
    return;
  }
  const now = new Date();
  const from = q(req.query.from) ?? `${now.getUTCFullYear()}-01-01`;
  const to = q(req.query.to) ?? `${now.getUTCFullYear()}-12-31`;
  const fromIso = `${from}T00:00:00.000Z`;
  const toIso = `${to}T23:59:59.999Z`;
  const scope = picked.scope;
  if (scope.kind === 'account') {
    const months: AccountMonthlySummary = {
      scope: 'account',
      from,
      to,
      accountId: scope.id,
      currency: scope.currency,
      otherCurrencies: await accountOtherCurrencies(scope),
      months: await summaryMonthlyTotals(scope, fromIso, toIso),
    };
    res.json(months);
    return;
  }
  const months: MonthlySummary = {
    scope: 'workspace',
    from,
    to,
    baseCurrency: await currentBaseCurrency(),
    months: await summaryMonthlyTotals(scope, fromIso, toIso),
  };
  res.json(months);
});

// ---------- income sources / one-off / recurring ----------

/** Manual income source mark (an id from income_sources); null - back to auto-detection. */
app.patch('/api/transactions/:id/source', async (req, res) => {
  const source = (req.body as { source?: unknown }).source;
  if (source !== null && (typeof source !== 'string' || !(await getIncomeSource(source)))) {
    const ids = (await listIncomeSources()).map((s) => s.id);
    res.status(400).json({ error: `source field required: ${ids.join(' | ')} | null` });
    return;
  }
  const tx = await setIncomeSourceOverride(req.params.id, source);
  if (!tx) {
    res.status(404).json({ error: 'transaction not found' });
    return;
  }
  res.json(tx);
});

// ---------- income sources (catalog) ----------

app.get('/api/income-sources', async (_req, res) => {
  res.json(await listIncomeSources());
});

/** Transliteration and slug for a new source id (a Cyrillic label -> a latin slug). */
function slugifySourceId(label: string): string {
  const translit: Record<string, string> = {
    а: 'a', б: 'b', в: 'v', г: 'g', ґ: 'g', д: 'd', е: 'e', ё: 'e', є: 'ie',
    ж: 'zh', з: 'z', и: 'i', і: 'i', ї: 'i', й: 'i', к: 'k', л: 'l', м: 'm',
    н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh',
    ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ы: 'y', э: 'e', ю: 'iu', я: 'ia',
    ь: '', ъ: '',
  };
  const base = label
    .toLowerCase()
    .split('')
    .map((ch) => translit[ch] ?? ch)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'source';
}

const isKind = (v: unknown): v is 'own' | 'external' => v === 'own' || v === 'external';

const parsePatterns = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : undefined;

/**
 * A new source (freelance, stipend, a grant...). The id is derived from the label;
 * after creation the database is re-tagged - the patterns may explain older income.
 */
app.post('/api/income-sources', async (req, res) => {
  const body = req.body as { label?: unknown; kind?: unknown; patterns?: unknown };
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  if (!label) {
    res.status(400).json({ error: 'label: non-empty string' });
    return;
  }
  if (!isKind(body.kind)) {
    res.status(400).json({ error: "kind: 'own' (your own earnings) | 'external' (help from outside)" });
    return;
  }
  let id = slugifySourceId(label);
  for (let n = 2; await getIncomeSource(id); n++) id = `${slugifySourceId(label)}-${n}`;
  const source = await upsertIncomeSource({
    id,
    label,
    kind: body.kind,
    patterns: parsePatterns(body.patterns) ?? [],
  });
  await reclassifyAll();
  res.json(source);
});

app.put('/api/income-sources/:id', async (req, res) => {
  const existing = await getIncomeSource(req.params.id);
  if (!existing) {
    res.status(404).json({ error: 'source not found' });
    return;
  }
  const body = req.body as { label?: unknown; kind?: unknown; patterns?: unknown };
  const source = await upsertIncomeSource({
    id: existing.id,
    label: typeof body.label === 'string' && body.label.trim() ? body.label.trim() : existing.label,
    kind: isKind(body.kind) ? body.kind : existing.kind,
    patterns: parsePatterns(body.patterns) ?? existing.patterns,
  });
  await reclassifyAll();
  res.json(source);
});

app.delete('/api/income-sources/:id', async (req, res) => {
  if (!(await deleteIncomeSource(req.params.id))) {
    res.status(400).json({ error: 'source not found or builtin (salary/family/other)' });
    return;
  }
  await reclassifyAll();
  res.json({ deleted: true });
});

/** Flag a one-off large purchase - amortized in average spending (1/12 per month). */
app.patch('/api/transactions/:id/one-off', async (req, res) => {
  const oneOff = (req.body as { oneOff?: unknown }).oneOff;
  if (typeof oneOff !== 'boolean') {
    res.status(400).json({ error: 'oneOff field required: true | false' });
    return;
  }
  const tx = await setOneOff(req.params.id, oneOff);
  if (!tx) {
    res.status(404).json({ error: 'transaction not found' });
    return;
  }
  res.json(tx);
});

/**
 * Recurring payments over the last 12 months. Groups hidden by the user come back
 * with ignored=true and are excluded from the monthly total - the app shows them
 * only in edit mode.
 */
async function recurringPayload() {
  const since = new Date();
  since.setUTCMonth(since.getUTCMonth() - 12);
  const groups = await listRecurringGroups(since.toISOString());
  const monthlyTotal = groups
    .filter((g) => !g.ignored)
    .reduce((s, g) => s + g.monthlyAvg, 0);
  return {
    baseCurrency: await currentBaseCurrency(),
    monthlyTotal: Math.round(monthlyTotal * 100) / 100,
    groups,
  };
}

app.get('/api/recurring', async (_req, res) => {
  res.json(await recurringPayload());
});

/**
 * Hide a group from the Overview (you disagree that it is recurring) or bring it
 * back. The group is identified by its normalized description, as in the detector.
 */
app.post('/api/recurring/ignore', async (req, res) => {
  const body = req.body as { description?: unknown; ignored?: unknown };
  if (typeof body.description !== 'string' || !body.description.trim()) {
    res.status(400).json({ error: 'description field required' });
    return;
  }
  if (typeof body.ignored !== 'boolean') {
    res.status(400).json({ error: 'ignored field required: true | false' });
    return;
  }
  await setRecurringIgnored(body.description, body.ignored);
  res.json(await recurringPayload());
});

// ---------- independence and settings ----------

/** The headline metric: how much you need to earn. */
app.get('/api/independence', async (_req, res) => {
  res.json(await computeIndependence());
});

app.get('/api/settings', async (_req, res) => {
  res.json(await getSettings());
});

app.patch('/api/settings', async (req, res) => {
  res.json(await updateSettings(req.body as Record<string, unknown>));
});

// ---------- app settings (the settings table, formerly .env) ----------

app.get('/api/app-settings', async (_req, res) => {
  res.json(await getAppSettings());
});

/**
 * Changing the currency resets base_amount and starts a background reconversion;
 * changing the owner names re-tags transfers immediately.
 */
app.patch('/api/app-settings', async (req, res) => {
  const parsed = parseAppSettingsPatch(req.body as { baseCurrency?: unknown; ownerNames?: unknown });
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const { settings, baseCurrencyChanged, ownerNamesChanged } = await updateAppSettings(parsed.patch);
  if (baseCurrencyChanged) {
    const reset = await resetBaseAmounts();
    logger.info(`base currency -> ${settings.baseCurrency}: recomputing base_amount for ${reset} transactions`);
    void backfillBaseAmounts().catch((e: Error) =>
      logger.error(`reconversion failed: ${e.message}`),
    );
  }
  if (ownerNamesChanged) await reclassifyAll();
  res.json(settings);
});

// ---------- baseline minimum ----------

const baselinePayload = async () => ({
  baseCurrency: await currentBaseCurrency(),
  items: await listBaselineItems(),
  total: await baselineTotal(),
});

app.get('/api/baseline', async (_req, res) => {
  res.json(await baselinePayload());
});

/** monthly: null deletes the line item. */
app.put('/api/baseline', async (req, res) => {
  const body = req.body as { label?: unknown; monthly?: unknown; sort?: unknown };
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  if (!label) {
    res.status(400).json({ error: 'label: non-empty string' });
    return;
  }
  if (body.monthly === null) {
    await deleteBaselineItem(label);
    res.json(await baselinePayload());
    return;
  }
  if (typeof body.monthly !== 'number' || !Number.isFinite(body.monthly) || body.monthly <= 0) {
    res.status(400).json({ error: 'monthly: a positive number or null' });
    return;
  }
  // sort not provided - keep the previous one (editing an amount sends only monthly)
  await upsertBaselineItem(label, body.monthly, typeof body.sort === 'number' ? body.sort : undefined);
  res.json(await baselinePayload());
});

// ---------- category rules ----------

app.get('/api/category-rules', async (_req, res) => {
  const rules = await listCategoryRules();
  res.json(
    await Promise.all(
      rules.map(async (r) => ({ ...r, matches: await countCategoryRuleMatches(r.pattern) })),
    ),
  );
});

/**
 * Sets the category for every transaction whose description contains the pattern
 * (case-insensitive). With txId the pattern becomes the transaction's full description.
 */
app.post('/api/category-rules', async (req, res) => {
  const body = req.body as { txId?: unknown; pattern?: unknown; category?: unknown };
  const category = typeof body.category === 'string' ? body.category : '';
  if (!(CATEGORIES as readonly string[]).includes(category)) {
    res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(', ')}` });
    return;
  }
  let pattern = typeof body.pattern === 'string' ? body.pattern.trim() : '';
  if (!pattern && typeof body.txId === 'string') {
    const tx = await getTransaction(body.txId);
    if (!tx) {
      res.status(404).json({ error: 'transaction not found' });
      return;
    }
    pattern = tx.description.trim();
  }
  if (!pattern) {
    res.status(400).json({ error: 'pattern field required (or txId with a non-empty description)' });
    return;
  }
  const rule = await addCategoryRule(pattern, category);
  await reclassifyAll();
  res.json({ rule, matches: await countCategoryRuleMatches(rule.pattern) });
});

app.delete('/api/category-rules/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'invalid rule id' });
    return;
  }
  if (!(await deleteCategoryRule(id))) {
    res.status(404).json({ error: 'rule not found' });
    return;
  }
  await reclassifyAll();
  res.json({ deleted: true });
});

// ---------- budgets ----------

/** Limits + this month's actuals + a forecast from the current pace. */
app.get('/api/budgets', async (_req, res) => {
  const now = new Date();
  const from = `${now.toISOString().slice(0, 7)}-01T00:00:00.000Z`;
  const to = now.toISOString();
  const spent = new Map(
    (await summaryByCategory({ kind: 'workspace' }, from, to)).map((c) => [c.category, c.total]),
  );
  const dayOfMonth = now.getUTCDate();
  const daysInMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
  ).getUTCDate();
  res.json({
    baseCurrency: await currentBaseCurrency(),
    budgets: (await listBudgets()).map((b) => {
      const s = spent.get(b.category) ?? 0;
      return {
        ...b,
        spent: s,
        // linear forecast to the end of the month at the current pace
        forecast: Math.round(((s / dayOfMonth) * daysInMonth) * 100) / 100,
      };
    }),
  });
});

/** monthly: null removes the budget from the category. */
app.put('/api/budgets', async (req, res) => {
  const body = req.body as { category?: unknown; monthly?: unknown };
  const category = typeof body.category === 'string' ? body.category : '';
  if (!(CATEGORIES as readonly string[]).includes(category)) {
    res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(', ')}` });
    return;
  }
  if (body.monthly !== null && (typeof body.monthly !== 'number' || body.monthly <= 0)) {
    res.status(400).json({ error: 'monthly: a positive number or null' });
    return;
  }
  await setBudget(category, body.monthly as number | null);
  res.json({ budgets: await listBudgets() });
});

// ---------- export ----------

/** The whole history (or a period) as CSV. */
app.get('/api/export.csv', async (req, res) => {
  const txs = await listTransactions({
    from: q(req.query.from),
    to: q(req.query.to),
    limit: 1_000_000,
  });
  const baseCurrency = await currentBaseCurrency();
  const accountNames = new Map((await listAccounts(true)).map((a) => [a.id, a.name]));
  const esc = (v: unknown): string => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header =
    'date,account,amount,currency,base_amount,base_currency,category,description,transfer,refund,income_source,recurring,one_off';
  const lines = txs.map((t) =>
    [
      t.date,
      esc(accountNames.get(t.accountId) ?? t.accountId),
      t.amount,
      t.currency,
      t.baseAmount ?? '',
      baseCurrency,
      esc(t.category),
      esc(t.description),
      t.transfer ? 1 : 0,
      t.refund ? 1 : 0,
      t.incomeSource ?? '',
      t.recurring ? 1 : 0,
      t.oneOff ? 1 : 0,
    ].join(','),
  );
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="finto.csv"');
  // BOM - so Excel opens UTF-8 with non-latin characters without a fight
  res.send('\uFEFF' + [header, ...lines].join('\n'));
});

// ---------- imports: the one upload surface, and provenance ----------

/** 25 MB of statement is years of transactions in any format we read. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** One constant per limit, so the number enforced and the number in the message agree. */
const UPLOAD_LIMITS = {
  fileSize: MAX_UPLOAD_BYTES,
  files: 1,
  fields: 10,
  fieldSize: 1024 * 1024, // multer's own default, written down
};

/**
 * The file lands in memory, never on disk: the hash is over the bytes and the XLSX
 * reader takes a Buffer. Mounted per route rather than globally, and therefore
 * below the session check - a global multipart parser would let anyone who can
 * reach the port make the server buffer 25 MB per request (see the note there).
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: UPLOAD_LIMITS,
  // multer defaults this to latin1 while browsers write filename= as raw UTF-8 bytes:
  // the two disagree without failing, so the name simply arrives wrong. Field VALUES
  // already decode as utf8 (busboy's own defCharset), which is why only this was.
  defParamCharset: 'utf8',
});

/**
 * multer's own errors, answered by this endpoint instead of as a 500 by the global
 * handler. One message per code: a field over the size limit reported as a problem
 * with the file field sends the caller looking in the wrong place, and the caller
 * that hits these is the mobile client, which has no screen to read the code off.
 */
function uploadError(err: unknown): string {
  if (!(err instanceof multer.MulterError)) return 'the upload is not a valid multipart form';
  // caller-supplied, and on its way into a response body
  const field = String(err.field ?? 'form').slice(0, 40);
  const mb = (bytes: number): number => bytes / 1024 / 1024;
  switch (err.code) {
    case 'LIMIT_FILE_SIZE':
      return `the file is larger than ${mb(UPLOAD_LIMITS.fileSize)} MB`;
    case 'LIMIT_UNEXPECTED_FILE':
    case 'LIMIT_FILE_COUNT':
    case 'LIMIT_PART_COUNT':
      return 'the upload must carry exactly one file field named "file"';
    case 'LIMIT_FIELD_VALUE':
      return `the "${field}" field is larger than ${mb(UPLOAD_LIMITS.fieldSize)} MB - it carries text, not the statement`;
    case 'LIMIT_FIELD_COUNT':
      return `the upload carries more than ${UPLOAD_LIMITS.fields} form fields`;
    case 'LIMIT_FIELD_KEY':
      return `a form field name is too long ("${field}")`;
    default:
      return `the upload could not be read (${err.code})`;
  }
}

const uploadFile: express.RequestHandler = (req, res, next) => {
  withWorkspace(upload.single('file'))(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    res.status(400).json({ error: uploadError(err) });
  });
};

/** A column name from the file's header. Empty is not a name - it resolves to nothing. */
const column = (field: string) =>
  z
    .string({ error: `mapping.${field} must be a string` })
    .trim()
    .min(1, { error: `mapping.${field} must not be empty` });

/**
 * The mapping is the one field of this request the user writes by hand, so it is
 * checked rather than cast: a number where a column name belongs used to reach the
 * parser, throw "name.trim is not a function", and land that string in the import's
 * error_detail. Strict, because a stripped unknown key ("date_format" for
 * "dateFormat") imports the file against the wrong date format and answers 200.
 *
 * Tied to CsvMapping at both ends: the shape must name every column of it, and the
 * result must still be one - a field added there cannot quietly go unchecked here.
 */
const mappingSchema: z.ZodType<Partial<CsvMapping>> = z.strictObject({
  date: column('date').optional(),
  amount: column('amount').optional(),
  description: z
    .union(
      [
        column('description'),
        // the bound carries the sentence itself: the union's own error covers a
        // wrong type, not an array that is merely empty
        z
          .array(column('description'))
          .min(1, { error: 'mapping.description must be a column name or a list of column names' }),
      ],
      { error: 'mapping.description must be a column name or a list of column names' },
    )
    .optional(),
  currency: column('currency').optional(),
  dateFormat: z
    .enum(['iso', 'dmy', 'auto'], { error: 'mapping.dateFormat must be iso, dmy or auto' })
    .optional(),
  decimal: z
    .enum([',', '.', 'auto'], { error: "mapping.decimal must be ',', '.' or auto" })
    .optional(),
  // parseCsv compares one character at a time, so a longer delimiter never matches
  // and the whole file parses as a single column
  delimiter: z
    .string({ error: 'mapping.delimiter must be a string' })
    .length(1, { error: 'mapping.delimiter must be a single character' })
    .optional(),
  onlyWhen: z
    .strictObject({
      column: column('onlyWhen.column'),
      equals: z
        .union(
          [
            z.string(),
            // the bound carries the sentence itself, as description's does: an
            // accept list with nothing in it filters every row away, and the user
            // is then told no row could be parsed - their own input, zeroed and
            // reported back as a fault in the file
            z
              .array(z.string())
              .min(1, {
                error: 'mapping.onlyWhen.equals must be a status value or a list of status values',
              }),
          ],
          {
            error: 'mapping.onlyWhen.equals must be a status value or a list of status values',
          },
        ),
    })
    .optional(),
} satisfies Record<keyof CsvMapping, z.ZodType>);

type ParsedMapping = { ok: true; mapping: Partial<CsvMapping> } | { ok: false; error: string };

/** The mapping travels as a JSON string: multipart carries text fields, not objects. */
function parseMapping(raw: string): ParsedMapping {
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'mapping must be a JSON object' };
  }
  // ahead of the schema, so "this is not a mapping at all" keeps its own wording
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'mapping must be a JSON object' };
  }
  const parsed = mappingSchema.safeParse(input);
  if (parsed.success) return { ok: true, mapping: parsed.data };
  const issue = parsed.error.issues[0];
  return {
    ok: false,
    error:
      issue?.code === 'unrecognized_keys'
        ? // the path is where the key sits, so a key inside onlyWhen names onlyWhen
          `${['mapping', ...issue.path].join('.')} has an unknown field: ${issue.keys.map((k) => `"${k}"`).join(', ')}`
        : (issue?.message ?? 'mapping is not a valid column mapping'),
  };
}

/** Mapping presets + generic with column auto-detection. */
app.get('/api/imports/presets', (_req, res) => {
  res.json({
    presets: [
      { key: 'generic', title: 'Any statement (auto-detect the date, amount and description columns)' },
      ...Object.entries(CSV_PRESETS).map(([key, p]) => ({ key, title: p.title })),
    ],
  });
});

/**
 * A statement from any bank, in whatever format it was downloaded: the file type
 * is sniffed from its bytes, not from its name.
 *
 * **This does not import anything** (ROADMAP 5.3). It parses the file, stages the
 * rows, and answers with a summary to accept - nothing on any screen moves until
 * POST /api/imports/:id/confirm. A file this workspace already committed answers
 * outcome: 'duplicate' instead and is not parsed again.
 */
app.post('/api/imports', uploadFile, async (req, res) => {
  const body = req.body as Record<string, unknown>;
  // The runtime half of a StatementDestination that has one member now. Multipart
  // fields carry no type, so nothing above this route can hold it, and this route is
  // where curl and a mobile client meet it.
  //
  // The two retired fields are refused rather than ignored: a request carrying
  // accountName states a destination, and dropping it silently is exactly the guess
  // the exclusivity refusal used to be here to prevent. Refused ahead of accountId,
  // so a request carrying only currency reads the sentence about currency rather
  // than one about a field it did not send.
  if (body.accountName !== undefined) {
    res.status(400).json({
      error:
        'an upload goes to an account that already exists - create it with POST /api/accounts, then send its accountId',
    });
    return;
  }
  if (body.currency !== undefined) {
    res.status(400).json({
      error:
        'an account keeps its own currency - it is set when the account is created (POST /api/accounts) and corrected with PATCH /api/accounts/:id',
    });
    return;
  }
  if (body.accountId === undefined) {
    res.status(400).json({ error: 'accountId field required' });
    return;
  }
  // Presence is "the field arrived", never "the field is a string": multer turns a
  // repeated field into an array. Refused rather than normalised - taking the first
  // or the last picks between two values the caller may not agree on.
  if (typeof body.accountId !== 'string') {
    res.status(400).json({ error: 'accountId must be sent once, as a single value' });
    return;
  }
  const pickedId = body.accountId.trim();
  if (!pickedId) {
    res.status(400).json({ error: 'accountId must not be empty' });
    return;
  }
  // no shape check beyond that, deliberately: an id restored from a backup or
  // written before row 25 is not a UUID, and the lookup is what decides whether an
  // id is real
  const destination: StatementDestination = { accountId: pickedId };
  if (!req.file) {
    res.status(400).json({ error: 'file field required (the statement itself)' });
    return;
  }
  const rawMapping = typeof body.mapping === 'string' ? body.mapping.trim() : '';
  let mapping: Partial<CsvMapping> | undefined;
  if (rawMapping) {
    const parsed = parseMapping(rawMapping);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    mapping = parsed.mapping;
  }
  try {
    const result = await importStatement({
      ...destination,
      preset: typeof body.preset === 'string' ? body.preset : undefined,
      mapping,
      bytes: req.file.buffer,
      originalFilename: req.file.originalname || undefined,
      uploadedBy: res.locals.userId as string | undefined,
    });
    if (result.outcome === 'duplicate') {
      const where = result.accountIds.join(', ') || 'no account (its rows were already there)';
      logImport.info(`already imported as ${result.importId}, rows in ${where}`);
      res.json(result);
      return;
    }
    const { summary } = result;
    logImport.info(
      `import ${summary.importId} staged for ${summary.accountId}: ${summary.accepted} rows read, ${summary.newRows} new, skipped ${summary.skipped} of ${summary.total}`,
    );
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** Why an import cannot be confirmed, in the words of the screen that shows it. */
const confirmRefusal = (status: ImportStatus): string => {
  switch (status) {
    case 'committed':
      return 'this import has already been confirmed - its rows are in your data';
    case 'discarded':
      return 'this import was discarded - upload the file again to import it';
    default:
      return `this import is ${status}, not awaiting confirmation`;
  }
};

/**
 * Every refusal the confirm can answer, as one switch over the union rather than a
 * ternary over two of its members: a member added to ConfirmOutcome is then a
 * compile error here instead of a new refusal rendered with somebody else's
 * sentence - on the one screen whose job is telling a person whether their rows
 * landed.
 */
const confirmConflict = (result: Extract<ConfirmOutcome, { confirmed: false }>): string => {
  switch (result.reason) {
    case 'status':
      return confirmRefusal(result.status);
    case 'file-committed':
      return `these bytes were imported as ${result.heldBy} while this import was waiting - its rows are already in your data`;
    case 'account-missing':
      return 'nothing was imported: the account these rows go to was deleted while this import was waiting, and it cannot be brought back. Discard this import and upload the file again into another account';
    case 'account-hidden':
      return 'nothing was imported: the account these rows go to has been removed from the app - restore it, then press Confirm again';
    default: {
      const unreachable: never = result;
      return unreachable;
    }
  }
};

/**
 * Accepts a staged import: the rows become data and the pipeline runs over them.
 * The answer is what actually landed - `inserted` is the database's own count -
 * which can be less than the summary promised if another import wrote some of these
 * rows in between.
 */
app.post('/api/imports/:id/confirm', async (req, res) => {
  let result: Awaited<ReturnType<typeof confirmImport>>;
  try {
    result = await confirmImport(req.params.id);
  } catch (e) {
    if (!(e instanceof ImportNotConfirmable)) throw e;
    // A broken invariant, not a bad request, so the status stays 5xx: the operator's
    // alerting must not read a refusal the server caused as one the user's file did
    // (ROADMAP 6.4). What changes is the body - the global handler's `internal error`
    // reads as transient on the one screen whose job is saying whether the data
    // landed, so the person presses Confirm again and gets it again. The real message
    // names the import and goes to the log; the sentence names the way out.
    logImport.error(`import ${req.params.id} cannot be confirmed: ${(e as Error).message}`);
    res.status(500).json({
      error:
        'this import cannot be confirmed - confirming it again will fail the same way. Discard it and upload the file again',
    });
    return;
  }
  if (!result) {
    res.status(404).json({ error: 'import not found' });
    return;
  }
  if (!result.confirmed) {
    res.status(409).json({ error: confirmConflict(result) });
    return;
  }
  logImport.info(
    `import ${req.params.id} confirmed into ${result.accountId}: new ${result.inserted} of ${result.rowsAccepted}`,
  );
  await reclassifyAll(); // categories, transfers, sources, base_amount
  res.json({
    importId: req.params.id,
    accountId: result.accountId,
    accountIds: result.accountIds,
    inserted: result.inserted,
    skipped: result.rowsRejected,
    total: result.rowsAccepted + result.rowsRejected,
  });
});

/**
 * The user rejected the summary. The staged rows go, the import row stays at
 * `discarded` holding on to the stored statement, and the same file can be uploaded
 * again. Idempotent - a second discard reports the state that already holds - but a
 * `committed` import is refused: its rows are real data, and DELETE /api/imports/:id
 * is the path that removes those (ROADMAP 4.4).
 */
app.post('/api/imports/:id/discard', async (req, res) => {
  const result = await discardImport(req.params.id);
  if (!result) {
    res.status(404).json({ error: 'import not found' });
    return;
  }
  if (!result.discarded) {
    res.status(409).json({
      error:
        result.status === 'committed'
          ? 'this import is already part of your data - delete it instead of discarding it'
          : `this import is ${result.status}, not awaiting confirmation`,
    });
    return;
  }
  logImport.info(`import ${req.params.id} discarded`);
  res.json({ discarded: true, importId: req.params.id });
});

/**
 * The page and, beside it, totals over the whole filtered set - so a client can say
 * how many are not listed instead of counting what it was sent.
 *
 * Presence then shape, deliberately not q(): q() maps both '' and a repeated
 * parameter to undefined, and undefined here means the whole workspace. A caller
 * writing `?accountId=${account?.id ?? ''}` would then be answered with every import
 * this workspace has and print it as one account's. Same test and same sentence as
 * the upload route above. An id that matches no account is not an error: another
 * workspace's id has to stay indistinguishable from a nonexistent one.
 */
app.get('/api/imports', async (req, res) => {
  if (req.query.accountId !== undefined) {
    const accountId = req.query.accountId;
    if (typeof accountId !== 'string' || accountId.length === 0) {
      res.status(400).json({ error: 'accountId must be sent once, as a single value' });
      return;
    }
    res.json(await listImports({ accountId }));
    return;
  }
  res.json(await listImports());
});

/** Removes the import AND the transactions it wrote - the count is in the answer. */
app.delete('/api/imports/:id', async (req, res) => {
  const result = await deleteImport(req.params.id);
  if (!result) {
    res.status(404).json({ error: 'import not found' });
    return;
  }
  logger.info(`import ${req.params.id} deleted: ${result.removed} transactions removed`);
  await reclassifyAll(); // transfer pairing changes when the other leg disappears
  res.json({ deleted: true, transactions: result.removed });
});

// ---------- the stored statement itself (ROADMAP 4.5) ----------

/**
 * Everything a filename may still be after this: letters, digits, dot, underscore,
 * hyphen. A whitelist and not a known-bad list, so a character nobody thought of is
 * replaced rather than passed through.
 */
const asciiName = (name: string): string => name.replace(/[^A-Za-z0-9._-]/g, '_');

/** encodeURIComponent, plus the four characters it leaves that are not attr-chars. */
const rfc5987 = (name: string): string =>
  encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/**
 * Runs BEFORE both encodings, so neither half can carry a path: percent-encoding
 * stops header injection but not a client that saves what it decodes.
 *
 * By code point rather than by UTF-16 unit, and unpaired surrogates go: the RFC 5987
 * half's encodeURIComponent THROWS on a lone one, which the global handler would
 * answer as a 500 on a download that worked. A cap splitting an emoji makes one, and
 * a restored row's name is a foreign JSON's string, where a lone surrogate is legal.
 */
const cleanName = (name: string): string =>
  Array.from(name.replace(/[\u0000-\u001f\u007f\\/]/g, ''))
    .filter((c) => c.length > 1 || c < '\ud800' || c > '\udfff')
    .slice(0, 100)
    .join('')
    .replace(/^[.\s]+/, '')
    .trim();

/**
 * The Content-Disposition for a name the USER chose. storage.ts's KEY comment is on
 * the record that original_filename must never be passed through a guard believed to
 * be a sanitiser, so this builds the whole value in one place instead: a CRLF in it
 * splits the response, a `"` ends the quoted string early, and anything above U+00FF
 * makes setHeader throw on a route that otherwise worked.
 *
 * `info` is optional because the row can go between the two reads on the download
 * route; the id-derived fallback is still the honest name. That fallback goes through
 * the same two encodings as the user's string, because the id is not always this
 * server's UUID - a restored backup reproduces ids from a foreign JSON.
 */
export function attachmentDisposition(importId: string, info?: ImportDocumentInfo): string {
  const derived = info ? `import-${importId}.${info.sourceType}` : `import-${importId}`;
  const wanted = cleanName(info?.originalFilename ?? '') || cleanName(derived) || 'statement';
  return `attachment; filename="${asciiName(wanted)}"; filename*=UTF-8''${rfc5987(wanted)}`;
}

/**
 * The uploaded statement, decrypted, as a download - whatever the import's status:
 * a failed or a discarded import's document is exactly the artefact ROADMAP 4.5
 * retains it for.
 */
app.get('/api/imports/:id/document', async (req, res) => {
  const ref = await getImportDocumentRef(req.params.id);
  if (!ref) {
    // absent, another workspace's, and "no readable document" are one answer, because
    // the select is workspace-scoped and they are one code path. A sentence per case
    // would make this route an existence oracle. It says READ and never "kept": a
    // restored row has its pointer stripped while its bytes are still on disk
    res.status(404).json({ error: DOCUMENT_NOT_READABLE });
    return;
  }
  let bytes: Buffer;
  try {
    bytes = await getDocument(ref);
  } catch (e) {
    // 500 and not 400 - the user's file is not at fault (ROADMAP 6.4), and the whole
    // chain goes to the log or a rotated DOCUMENT_ENCRYPTION_KEY reaches the operator
    // as an integrity failure. The client gets no path, no errno and no filename
    logImport.error(
      { err: e },
      `import ${req.params.id} document could not be read: ${causeChain(e)}`,
    );
    res.status(500).json({ error: DOCUMENT_READ_REFUSED });
    return;
  }
  const info = await getImportDocumentInfo(req.params.id);
  // attachment + nosniff + octet-stream, all three: these are user-uploaded bytes
  // served back from the origin that holds the session cookie
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // res.send(Buffer) sets an ETag and no Cache-Control, which permits heuristic
  // caching of a decrypted bank statement
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Disposition', attachmentDisposition(req.params.id, info));
  logImport.info(
    `import ${req.params.id} document sent to ${res.locals.userId as string} (${bytes.length} bytes)`,
  );
  res.send(bytes);
});

/**
 * Removes the stored statement and keeps everything else - the import row, its
 * transactions and its provenance (ROADMAP 4.5's retention, 6.1's Article 17).
 */
app.delete('/api/imports/:id/document', async (req, res) => {
  // on the ROW, never on the pointer: a row whose pointer is NULL may still have
  // bytes, and those are exactly the rows a retention policy has to reach. And it
  // runs before any disk access - checking afterwards would delete the blob at
  // <this workspace>/<id> for an id with no row here, then answer "not found"
  const info = await getImportDocumentInfo(req.params.id);
  if (!info) {
    res.status(404).json({ error: 'import not found' });
    return;
  }
  let bytesRemoved: boolean;
  try {
    bytesRemoved = await deleteDocument(req.params.id);
  } catch (e) {
    // the pointer stays: it still describes what is on disk
    logImport.error(
      { err: e },
      `import ${req.params.id} document could not be removed: ${causeChain(e)}`,
    );
    res.status(500).json({ error: DOCUMENT_DELETE_REFUSED });
    return;
  }
  // Bytes first, pointer second, and the two crash windows are not equivalent: this
  // one leaves a row claiming a readable document whose bytes are gone, which every
  // read reports loudly and a second Delete converges on. The other order leaves an
  // unreferenced bank statement on disk while the user has been told it is deleted,
  // and no purge exists to revisit it.
  //
  // `false` is not a failure - most rows never had a document - and the pointer is
  // cleared either way, or the row goes on claiming a readable one.
  await clearImportDocument(req.params.id);
  if (info.keyVersion !== null && !knowsKeyVersion(info.keyVersion)) {
    // deleteDocument tried every layout this server knows, and this row's is not one
    // of them, so its bytes are still there - and the pointer that named the layout
    // has just been cleared. Mirrors deleteImport's line, for the same recovery
    logImport.error(
      `import ${req.params.id} document was written under key layout ${info.keyVersion}, which this server cannot address - remove it by hand`,
    );
  }
  logImport.info(
    `import ${req.params.id} document deleted by ${res.locals.userId as string} (bytes removed: ${bytesRemoved})`,
  );
  res.json({ deleted: true, importId: req.params.id, bytesRemoved });
});

// ---------- backup / restore ----------

/** A full JSON dump of every user table in one click ("my data is mine"). */
app.get('/api/backup', async (_req, res) => {
  const stamp = new Date().toISOString().slice(0, 10);
  const data = await exportBackup();
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="finto-backup-${stamp}.json"`);
  res.send(JSON.stringify(data));
});

/**
 * Restore from a JSON backup (the request body is the file itself). Current data
 * is REPLACED, then fully recomputed. SQLite dumps from the pre-Postgres era are
 * not accepted here - the transfer script handles those.
 */
app.post(
  '/api/restore',
  // same ceiling as the JSON parser above - 25 MB of backup is six figures of transactions
  withWorkspace(express.raw({ type: 'application/octet-stream', limit: '25mb' })),
  async (req, res) => {
    // the file arrives either as a raw octet-stream (Buffer) or, when the client
    // sends application/json, already parsed by the global json middleware
    const raw: unknown = req.body;
    if (Buffer.isBuffer(raw) && raw.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) {
      res.status(400).json({
        error:
          'this is a SQLite dump from the pre-Postgres era - import it on the server with: npm run migrate:sqlite -- <file>',
      });
      return;
    }
    try {
      const input: unknown = Buffer.isBuffer(raw) ? JSON.parse(raw.toString('utf8')) : raw;
      const data = parseBackup(input);
      const { tables, rows } = await restoreBackup(data);
      await reclassifyAll(); // the backup may predate the current tagging rules
      logger.info(`restored from backup: tables ${tables}, rows ${rows}`);
      res.json({ restored: true, tables, rows });
    } catch (e) {
      res.status(400).json({ error: `backup could not be restored: ${(e as Error).message}` });
    }
  },
);

// single error handler (Express 5 catches rejections from async routes itself).
// The message goes to the log, not to the client: it tends to carry table names
// and SQL fragments, and routes with something useful to say answer 400 themselves.
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logHttp.error(err);
  res.status(500).json({ error: 'internal error' });
});
