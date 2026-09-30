import fs from 'fs';
import path from 'path';
import express from 'express';
import multer from 'multer';
import { z } from 'zod';
import { CATEGORIES, type Category } from './categorizer';
import { config } from './config';
import { reclassifyAll } from './classify';
import {
  ACCOUNT_NAME_MAX,
  CHARTS_MAX,
  CHART_ACCOUNT_ID_MAX,
  CHART_BREAKDOWNS,
  CHART_ID_MAX,
  CHART_ID_SHAPE,
  CHART_KINDS,
  CHART_METRICS,
  CHART_RANGES,
  CHART_TITLE_MAX,
  type ConfirmOutcome,
  ImportNotConfirmable,
  ImportStatus,
  type ResolvedAccountId,
  type SummaryScope,
  accountOtherCurrencies,
  addCategoryRule,
  applyPreviewedCategoryRule,
  addTransferRule,
  applySimilarTransferRule,
  clearImportDocument,
  clearManualForRule,
  confirmImport,
  discardImport,
  countCategoryRuleMatches,
  countRuleMatches,
  countTransferRuleMatches,
  currentBaseCurrency,
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
  previewTransferRule,
  previewCategoryRule,
  type ImportDocumentInfo,
  INCOME_SOURCE_LABEL_MAX,
  listIncomeSources,
  replaceGoal,
  resetBaseAmounts,
  upsertIncomeSource,
  listAccounts,
  createAccount,
  createGoal,
  deleteGoal,
  GoalWriteError,
  listCategoryRules,
  listRecurringGroups,
  countUnconverted,
  listTransactions,
  listTransferRules,
  listCharts,
  replaceCharts,
  setCategoryOverride,
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
} from './db';
import {
  DOCUMENT_DELETE_REFUSED,
  DOCUMENT_NOT_READABLE,
  DOCUMENT_READ_REFUSED,
  DocumentMissing,
  deleteDocument,
  getDocument,
} from './documents';
import { backfillBaseAmounts, baseAmountsConverting } from './fxrates';
import { getGoalProgress, listGoalProgress } from './goals';
import { causeChain, logHttp, logImport, logger, reasonFirst } from './logger';
import { CSV_PRESETS, CsvMapping } from './providers/csv';
import { type StatementDestination, importStatement } from './providers/statement';
import { getAppSettings, parseAppSettingsPatch, updateAppSettings } from './appsettings';
import { Account, AccountMonthlySummary, AccountSummary, MonthlySummary, Summary } from './types';
import {
  ANSWERS,
  type AnswerBody,
  type Declared,
  goalCreateSchema,
  type GoalCreate,
  INCOME_SOURCE_KINDS,
  type JsonRoute,
  refusalSchema,
} from './wire';

export const app = express();

export const ANSWER_CHECK = 'answer check';

export type AnswerReporter = (mismatch: string) => void;

const declaredAnswer = (key: string | undefined): Declared | undefined =>
  key === undefined ? undefined : (ANSWERS as Record<string, Declared | undefined>)[key];

const answerKey = (req: express.Request): string | undefined => {
  const route = req.route as { path: unknown } | undefined;
  if (!route) return undefined;
  return `${req.method === 'HEAD' ? 'GET' : req.method} ${String(route.path)}`;
};

const issuePaths = (error: z.ZodError): string =>
  error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; ');

/**
 * How what a route answered disagrees with ANSWERS, or undefined. The body is parsed
 * in its serialised form: an undefined property and a Date are different things
 * before and after the wire.
 */
export function answerMismatch(
  req: express.Request,
  status: number,
  body: unknown,
  via: 'json' | 'send',
): string | undefined {
  const key = answerKey(req);
  const entry = declaredAnswer(key);
  const where = `${req.method} ${req.originalUrl} (${key ?? 'no route'}) answered ${status}`;
  const success = status >= 200 && status < 300;
  if (via === 'send') {
    return success && entry?.kind === 'json'
      ? `${where}: declared JSON route answered through res.send`
      : undefined;
  }
  let schema: z.ZodType;
  if (success) {
    if (!entry) return `${where}: ${key === undefined ? 'no route matched' : 'not declared in ANSWERS'}`;
    if (entry.kind !== 'json') return `${where}: declared ${entry.kind}, answered JSON`;
    if (status !== entry.status) return `${where}: declared ${entry.status}`;
    schema = entry.body;
  } else {
    schema = (entry?.kind === 'json' && entry.refusals?.[status]) || refusalSchema;
  }
  const parsed = schema.safeParse(JSON.parse(JSON.stringify(body)));
  return parsed.success ? undefined : `${where}: ${issuePaths(parsed.error)}`;
}

export const answerCheck: express.RequestHandler = (req, res, next) => {
  const report = req.app.get(ANSWER_CHECK) as AnswerReporter | undefined;
  if (!report) {
    next();
    return;
  }
  const json = res.json.bind(res);
  const send = res.send.bind(res);
  let viaJson = false;
  const check = (via: 'json' | 'send', body: unknown): void => {
    try {
      const mismatch = answerMismatch(req, res.statusCode, body, via);
      if (mismatch) report(mismatch);
    } catch (e) {
      report(
        `${req.method} ${req.originalUrl} answered ${res.statusCode}: the answer check threw: ${(e as Error).message}`,
      );
    }
  };
  res.json = ((body: unknown) => {
    viaJson = true;
    check('json', body);
    return json(body);
  }) as typeof res.json;
  res.send = ((body?: unknown) => {
    if (!viaJson) check('send', body);
    return send(body);
  }) as typeof res.send;
  next();
};

app.use(answerCheck);

const answer = <R extends JsonRoute>(res: express.Response, route: R, body: AnswerBody<R>): void => {
  res.status(ANSWERS[route].status).json(body);
};

const headersAndLog: express.RequestHandler = (req, res, next) => {
  const startedAt = Date.now();
  // Nothing may frame this app. There is no sign-in, so a page that gets it into an
  // iframe can walk the person through their own Delete with their own session -
  // which is every session, always. On every response and not only on the pages: a
  // header that is right for some paths is one somebody has to keep right.
  res.setHeader('X-Frame-Options', 'DENY');
  // Everything this app loads it ships itself; there is no CDN, no analytics and no
  // embed. Nothing reachable today injects markup, so this is the header that keeps
  // that true rather than one repairing a hole.
  res.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.on('finish', () => {
    logHttp.debug(`${req.method} ${req.originalUrl} -> ${res.statusCode} ${Date.now() - startedAt}ms`);
  });
  next();
};

app.use(headersAndLog);

/**
 * Where the request came from, which is the whole of the boundary: there is no
 * sign-in, so any page that can talk to this server can read and change everything.
 * Binding to loopback keeps other machines off the port; it does nothing about a
 * page in the owner's OWN browser, which is on this machine by definition.
 *
 * Three headers, and each closes something the other two do not.
 *
 * Host closes DNS rebinding. A page at http://evil.example whose name is made to
 * resolve to 127.0.0.1 arrives here same-origin with itself, and the only part of it
 * still under the attacker's control is the NAME in this header - so a name is
 * refused and an address is not. That also leaves FINTO_HOST=0.0.0.0 working: a phone on
 * the same Wi-Fi reaches this server by its address and never by a name.
 *
 * Origin closes the plain cross-origin write, which needs no rebind at all.
 * multipart/form-data is CORS-safelisted, so any page on the web can POST a
 * statement to /api/imports and the browser will send it - the response is
 * unreadable to that page, but the import lands. A POST carries Origin whatever its
 * content type, and an opaque origin arrives as the literal `null`, which is not a
 * URL and is refused with everything else that is not one.
 *
 * Sec-Fetch-Site is third and needs no list at all: same-origin or refused. It is a
 * defence a browser that omits the header does not provide, so Host and Origin are
 * what stand behind it rather than the other way round.
 *
 * /api/health is inside the check like everything else. There is no proxy and no
 * probe that would need it exempt, and an exemption is how the next route gets one.
 */
const REQUEST_NOT_LOCAL =
  'this request did not come from Finto on this machine, so nothing was read or changed - open the app at the address the server printed when it started';

const isLoopbackName = (name: string): boolean =>
  name === 'localhost' || name === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);

/**
 * An address literal in either family, checked as one rather than by the presence of a
 * colon: hostPart has already taken the port off, so the only colon that survives is
 * inside brackets - but `[evil:example]` survives that way too, and it is a name.
 */
const isAddressLiteral = (name: string): boolean =>
  /^\d{1,3}(?:\.\d{1,3}){3}$/.test(name) || /^[0-9a-f:]*:[0-9a-f:.]*$/.test(name);

/**
 * Set HOST and the owner opened the port deliberately - README and SECURITY.md both
 * say what that costs. The phone that use case exists for arrives by address, so the
 * widening is exactly "an address as well as a loopback name", and a DNS name stays
 * refused in both configurations. That is the half rebinding needs.
 *
 * Read per request rather than captured at module load. Nothing else in this file
 * caches a setting, and a value captured here would make the widened arm unreachable
 * from a test - the suite runs on the loopback default, so that arm would be held by
 * nothing at all while being the arm that governs the open configuration.
 */
const namesThisServer = (name: string): boolean =>
  isLoopbackName(name) || (!isLoopbackName(config.host) && isAddressLiteral(name));

/** The host part of a Host header or of an origin: port off, IPv6 brackets off. */
const hostPart = (value: string): string => {
  const v = value.trim().toLowerCase();
  if (v.startsWith('[')) {
    const close = v.indexOf(']');
    return close === -1 ? v.slice(1) : v.slice(1, close);
  }
  const colon = v.indexOf(':');
  return colon === -1 ? v : v.slice(0, colon);
};

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const originIsLocal = (origin: string): boolean => {
  try {
    return namesThisServer(hostPart(new URL(origin).host));
  } catch {
    return false;
  }
};

const originCheck: express.RequestHandler = (req, res, next) => {
  const host = req.headers.host;
  const origin = req.headers.origin;
  const site = req.headers['sec-fetch-site'];
  const refuse = (why: string): void => {
    logHttp.warn(`refused ${req.method} ${req.originalUrl}: ${why}`);
    res.status(403).json({ error: REQUEST_NOT_LOCAL });
  };
  if (!host || !namesThisServer(hostPart(host))) {
    refuse(`Host ${JSON.stringify(host ?? '')} does not name this server`);
    return;
  }
  if (origin !== undefined && !originIsLocal(origin)) {
    refuse(`Origin ${JSON.stringify(origin)} is not this server`);
    return;
  }
  if (STATE_CHANGING.has(req.method) && typeof site === 'string' && site !== 'same-origin') {
    refuse(`Sec-Fetch-Site ${JSON.stringify(site)} on a ${req.method}`);
    return;
  }
  next();
};

app.use('/api', originCheck);

// the ceiling is raised from the default for one caller: a backup restored as JSON
const MAX_BODY_BYTES = 25 * 1024 * 1024;
const BODY_TOO_LARGE =
  `the request body is larger than ${MAX_BODY_BYTES / 1024 / 1024} MB, the ceiling for a JSON body or a backup file - nothing was changed`;

app.use(express.json({ limit: MAX_BODY_BYTES }));

const q = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

const isCategory = (v: unknown): v is Category => (CATEGORIES as readonly unknown[]).includes(v);

app.get('/api/health', (_req, res) => {
  answer(res, 'GET /api/health', { ok: true });
});

/**
 * One schema rather than a check per door, because a rename that cannot restore the
 * name an account already has is worse than no bound at all - and zod runs its checks
 * in the order they are added, so a `.max()` written before `.trim()` at one door
 * bounds the untrimmed string while the next door bounds the trimmed one.
 */
const accountNameSchema = z
  .string({ error: 'account name must be text' })
  .trim()
  .max(ACCOUNT_NAME_MAX, { error: `account name must be at most ${ACCOUNT_NAME_MAX} characters` })
  .min(1, { error: 'account name must not be empty' });

/**
 * One schema wherever a currency is accepted, for accountNameSchema's reason. The
 * message describes the value and never its requiredness: the field is optional
 * wherever this schema is used, and a message saying `required` would be false at a
 * door that omits it.
 */
const currencyCode = z
  .string({ error: 'currency must be a 3-letter ISO code' })
  .trim()
  .regex(/^[A-Za-z]{3}$/, { error: 'currency must be a 3-letter ISO code' });

/**
 * The account doors normalise, in one place covering both - a second .toUpperCase()
 * to remember is a second one to forget, and an account stored as 'usd' lists every
 * one of its own transactions as foreign to it on Overview.
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
 * sentence above offers only discard: confirming into an account that is about to be
 * deleted is harmless, where for a currency correction it defeats the correction.
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

const NOT_A_JSON_OBJECT =
  'the request body is not a JSON object - send the fields as a JSON object with Content-Type: application/json';

/** Answers the refusal itself; a route that gets undefined back returns. */
const jsonBody = (req: express.Request, res: express.Response): Record<string, unknown> | undefined => {
  const body: unknown = req.body;
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  res.status(400).json({ error: NOT_A_JSON_OBJECT });
  return undefined;
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

app.get('/api/accounts', async (req, res) => {
  answer(res, 'GET /api/accounts', await listAccounts(q(req.query.all) === '1'));
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
    // absent means the base currency, never a guess made on the client's
    // behalf. This is the one path into accounts.currency that currencyCode does not
    // see: the fallback is validated at the settings door, so the asymmetry is
    // deliberate rather than missed.
    currency: parsed.data.currency ?? (await currentBaseCurrency()).toUpperCase(),
  });
  if (!result.ok) {
    res.status(409).json({ error: nameTaken(result.taken, parsed.data.name) });
    return;
  }
  answer(res, 'POST /api/accounts', result.account);
});

/**
 * The currency arm has no control on any screen yet, deliberately: it belongs in an
 * account menu that does not exist, and a step added now is a step rewritten twice.
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
    answer(res, 'PATCH /api/accounts/:id', result.account);
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
 * Distinct from hiding, which is the PATCH above and is reversible. A hidden account
 * is deletable - hiding is what people do before deleting. What is refused is an
 * import waiting to be confirmed: without that refusal this delete takes the import
 * with it, and the summary card still on the user's screen answers "import not
 * found" when they press Confirm.
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
    answer(res, 'DELETE /api/accounts/:id', { deleted: true, transactions, imports, documents });
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
  answer(
    res,
    'GET /api/transactions',
    await listTransactions({
      from: q(req.query.from),
      to: q(req.query.to),
      accountId: q(req.query.accountId),
      category: q(req.query.category),
      limit,
    }),
  );
});

app.get('/api/transactions/:id', async (req, res) => {
  const tx = await getTransaction(req.params.id);
  if (!tx) {
    res.status(404).json({ error: 'transaction not found' });
    return;
  }
  answer(res, 'GET /api/transactions/:id', tx);
});

app.get('/api/transactions/:id/transfer-rule-preview', async (req, res) => {
  const preview = await previewTransferRule(req.params.id);
  if (!preview) {
    res.status(404).json({ error: 'transaction not found' });
    return;
  }
  answer(res, 'GET /api/transactions/:id/transfer-rule-preview', preview);
});

/** Manual "transfer between own accounts" mark; null hands the decision back to auto-detection. */
app.patch('/api/transactions/:id/transfer', async (req, res) => {
  const body = jsonBody(req, res);
  if (!body) return;
  const value = body.transfer;
  if (value !== true && value !== false && value !== null) {
    res.status(400).json({ error: 'transfer field required: true | false | null' });
    return;
  }
  const tx = await setTransferOverride(req.params.id, value);
  if (!tx) {
    res.status(404).json({ error: 'transaction not found' });
    return;
  }
  answer(res, 'PATCH /api/transactions/:id/transfer', tx);
});

app.patch('/api/transactions/:id/category', async (req, res) => {
  const body = jsonBody(req, res);
  if (!body) return;
  const category = body.category;
  if (category !== null && !isCategory(category)) {
    res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(', ')}` });
    return;
  }
  const before = await getTransaction(req.params.id);
  let tx = await setCategoryOverride(req.params.id, category);
  if (tx && (before?.category === 'support' || tx.category === 'support')) {
    await reclassifyAll();
    tx = await getTransaction(req.params.id);
  }
  if (!tx) {
    res.status(404).json({ error: 'transaction not found' });
    return;
  }
  answer(res, 'PATCH /api/transactions/:id/category', tx);
});

app.get('/api/transfer-rules', async (_req, res) => {
  const rules = await listTransferRules();
  const matches = await countTransferRuleMatches(rules);
  answer(res, 'GET /api/transfer-rules', rules.map((r) => ({ ...r, matches: matches.get(r.id) ?? 0 })));
});

app.post('/api/transfer-rules', async (req, res) => {
  const body = jsonBody(req, res);
  if (!body) return;
  const txId = body.txId;
  if (typeof txId !== 'string' || !txId) {
    res.status(400).json({ error: 'txId field required' });
    return;
  }
  if (body.matchMode !== undefined && body.matchMode !== 'exact' && body.matchMode !== 'similar-v1') {
    res.status(400).json({ error: 'unknown transfer rule matching mode' });
    return;
  }
  if (body.matchMode === 'similar-v1') {
    if (typeof body.previewToken !== 'string' || !/^[a-f0-9]{64}$/.test(body.previewToken)) {
      res.status(400).json({ error: 'preview the matching transactions before applying this rule' });
      return;
    }
    const result = await applySimilarTransferRule(txId, body.previewToken);
    if (!result.ok) {
      switch (result.reason) {
        case 'not-found': res.status(404).json({ error: 'transaction not found' }); return;
        case 'empty': res.status(400).json({ error: 'the transaction has an empty description - there is nothing to hang a rule on' }); return;
        case 'changed': res.status(409).json({ error: 'The matching transactions changed. Refresh the preview before applying the rule.' }); return;
      }
    }
    await reclassifyAll();
    answer(res, 'POST /api/transfer-rules', { rule: result.rule, matches: result.matches });
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
  answer(res, 'POST /api/transfer-rules', {
    rule,
    matches: await countRuleMatches(rule),
  });
});

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
  answer(res, 'DELETE /api/transfer-rules/:id', { deleted: true });
});

type ScopeResult =
  | { ok: true; scope: SummaryScope }
  | { ok: false; status: number; error: string };

/**
 * Deliberately not q(): it maps both '' and a repeated parameter to undefined, and
 * undefined here means every account in the base currency - so a caller
 * building `?accountId=${account?.id ?? ''}` would be handed every account's money
 * labelled as one account's. Presence first, then the type, then the trimmed string,
 * and each of the two refusals says its own cause: `?accountId=` was sent exactly
 * once (Express 5's simple parser hands it over as ''), so answering it with the
 * repeated-parameter sentence names something that did not happen.
 *
 * An unresolvable id is a 404 rather than a 200 of zeroes: a per-account body has to
 * state a currency and there is no currency without an account. A hidden account
 * resolves like any other - the caller named it by id.
 */
async function summaryScope(raw: unknown): Promise<ScopeResult> {
  if (raw === undefined) return { ok: true, scope: { kind: 'all' } };
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

/** The month so far by default: from the 1st to today, not to the month's end. */
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
    answer(res, 'GET /api/summary', summary);
    return;
  }
  const summary: Summary = {
    scope: 'all',
    from,
    to,
    baseCurrency: await currentBaseCurrency(),
    totals: await summaryTotals(scope, fromIso, toIso),
    byCategory: await summaryByCategory(scope, fromIso, toIso),
    incomeByCategory: await summaryIncomeByCategory(scope, fromIso, toIso),
    incomeBySource: await summaryIncomeBySource(scope, fromIso, toIso),
  };
  answer(res, 'GET /api/summary', summary);
});

/** The whole calendar year by default, its unreached months included. */
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
    answer(res, 'GET /api/summary/months', months);
    return;
  }
  const months: MonthlySummary = {
    scope: 'all',
    from,
    to,
    baseCurrency: await currentBaseCurrency(),
    months: await summaryMonthlyTotals(scope, fromIso, toIso),
  };
  answer(res, 'GET /api/summary/months', months);
});

/**
 * Nothing here is coupled to `kind`: `metrics` and `breakdown` are both present
 * whatever the shape is, and a donut whose measures were cleared before the shape was
 * switched is a state the builder reaches on purpose. A door that refused it would
 * refuse the reader's whole list rather than one chart.
 */
const chartSchema = z.strictObject({
  id: z
    .string({ error: 'chart id must be text' })
    .min(1, { error: 'chart id must not be empty' })
    .max(CHART_ID_MAX, { error: `chart id must be at most ${CHART_ID_MAX} characters` })
    .regex(CHART_ID_SHAPE, {
      error: 'chart id may contain only letters, digits, and . _ ~ -',
    }),
  kind: z.enum(CHART_KINDS, { error: `chart kind must be one of: ${CHART_KINDS.join(', ')}` }),
  // no minimum: an untitled chart is legal, and the dock falls back to a suggestion
  title: z
    .string({ error: 'chart title must be text' })
    .max(CHART_TITLE_MAX, { error: `chart title must be at most ${CHART_TITLE_MAX} characters` }),
  // null is every account together. An id naming no account is accepted: the chart
  // says so on the card, and refusing it here would refuse a whole list because one
  // chart points at an account deleted last week
  accountId: z
    .string({ error: 'chart accountId must be text or null' })
    .max(CHART_ACCOUNT_ID_MAX, {
      error: `chart accountId must be at most ${CHART_ACCOUNT_ID_MAX} characters`,
    })
    .nullable(),
  metrics: z
    .array(
      z.enum(CHART_METRICS, { error: `chart metrics must be from: ${CHART_METRICS.join(', ')}` }),
      { error: 'chart metrics must be a list' },
    )
    // uniqueness over a closed vocabulary is what bounds the length; the .max() is
    // what chooses the sentence a longer list is refused with, since its issue is
    // raised before the refinement's and badRequest reads the first one
    .max(CHART_METRICS.length, { error: 'a chart may not repeat a measure' })
    .superRefine((metrics, ctx) => {
      const seen = new Set<string>();
      for (const m of metrics) {
        if (seen.has(m)) {
          ctx.addIssue({ code: 'custom', message: `chart metrics: "${m}" is listed twice` });
          return;
        }
        seen.add(m);
      }
    }),
  breakdown: z.enum(CHART_BREAKDOWNS, {
    error: `chart breakdown must be one of: ${CHART_BREAKDOWNS.join(', ')}`,
  }),
  range: z.enum(CHART_RANGES, { error: `chart range must be one of: ${CHART_RANGES.join(', ')}` }),
});

const chartsPutSchema = z.strictObject({
  // required, and there is no force flag: a way to overwrite by default is a way to
  // lose another device's work by default
  version: z
    .int({ error: 'version must be a whole number' })
    .min(0, { error: 'version must not be negative' }),
  charts: z
    .array(chartSchema, { error: 'charts must be a list' })
    .max(CHARTS_MAX, { error: `at most ${CHARTS_MAX} charts can be saved` })
    .superRefine((charts, ctx) => {
      const seen = new Set<string>();
      for (const c of charts) {
        if (seen.has(c.id)) {
          ctx.addIssue({
            code: 'custom',
            message: `two charts share the id "${c.id}" - the URL names a chart by its id, so it can only name one`,
          });
          return;
        }
        seen.add(c.id);
      }
    }),
});

export const CHARTS_STALE =
  'These charts were changed somewhere else after this list was loaded. What you see now is the current version - save again and it will go through.';

app.get('/api/analytics/charts', async (_req, res) => {
  answer(res, 'GET /api/analytics/charts', await listCharts());
});

app.put('/api/analytics/charts', async (req, res) => {
  const parsed = chartsPutSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: badRequest(parsed.error) });
    return;
  }
  const result = await replaceCharts(parsed.data.version, parsed.data.charts);
  if (!result.ok) {
    res.status(409).json({ error: CHARTS_STALE, version: result.version, charts: result.charts });
    return;
  }
  answer(res, 'PUT /api/analytics/charts', { version: result.version, charts: result.charts });
});

/** Manual income source mark (an id from income_sources); null - back to auto-detection. */
app.patch('/api/transactions/:id/source', async (req, res) => {
  const body = jsonBody(req, res);
  if (!body) return;
  const source = body.source;
  if (source !== null && (typeof source !== 'string' || !(await getIncomeSource(source)))) {
    const ids = (await listIncomeSources()).map((s) => s.id);
    res.status(400).json({ error: `source field required: ${ids.join(' | ')} | null` });
    return;
  }
  const existing = await getTransaction(req.params.id);
  if (existing?.category === 'support' && existing.amount > 0 && !existing.refund) {
    res.status(409).json({ error: 'Support is external income. Change the category before choosing another income source.' });
    return;
  }
  const tx = await setIncomeSourceOverride(req.params.id, source);
  if (!tx) {
    res.status(404).json({ error: 'transaction not found' });
    return;
  }
  answer(res, 'PATCH /api/transactions/:id/source', tx);
});

app.get('/api/income-sources', async (_req, res) => {
  answer(res, 'GET /api/income-sources', await listIncomeSources());
});

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

/**
 * In accountNameSchema's idiom and for its reason: zod runs its checks in the order
 * they are added, so a `.max()` written before `.trim()` at one door bounds the
 * untrimmed string while the next door bounds the trimmed one, and a rename that
 * cannot restore the label a source already has is worse than no bound at all.
 */
const incomeSourceLabelSchema = z
  .string({ error: 'income source label must be text' })
  .trim()
  .max(INCOME_SOURCE_LABEL_MAX, {
    error: `income source label must be at most ${INCOME_SOURCE_LABEL_MAX} characters`,
  })
  .min(1, { error: 'income source label must not be empty' });

const incomeSourceKindSchema = z.enum(INCOME_SOURCE_KINDS, {
  error:
    "income source kind must be 'own' (your own earnings) or 'external' (support from outside)",
});

/** A trailing comma asked for nothing, not for something wrong. */
const incomeSourcePatternsSchema = z
  .array(z.string({ error: 'each income source pattern must be text' }), {
    error: 'income source patterns must be a list',
  })
  .transform((list) => list.map((p) => p.trim()).filter(Boolean));

// strict, for the reason newAccountSchema is: a stripped unknown key is a field the
// user meant to send, silently not applied, answered 200
const newIncomeSourceSchema = z.strictObject({
  label: incomeSourceLabelSchema,
  kind: incomeSourceKindSchema,
  patterns: incomeSourcePatternsSchema.optional(),
});

const incomeSourcePatchSchema = z.strictObject({
  label: incomeSourceLabelSchema.optional(),
  kind: incomeSourceKindSchema.optional(),
  patterns: incomeSourcePatternsSchema.optional(),
});

/** Re-tagged after creation: the new patterns may explain income already imported. */
app.post('/api/income-sources', async (req, res) => {
  const parsed = newIncomeSourceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: badRequest(parsed.error) });
    return;
  }
  const { label, kind, patterns } = parsed.data;
  let id = slugifySourceId(label);
  for (let n = 2; await getIncomeSource(id); n++) id = `${slugifySourceId(label)}-${n}`;
  const source = await upsertIncomeSource({ id, label, kind, patterns: patterns ?? [] });
  await reclassifyAll();
  answer(res, 'POST /api/income-sources', source);
});

/**
 * A builtin is editable here and refused by DELETE below: renaming the seeded external
 * source is how a database that predates a change to its label reaches the word it
 * wants.
 */
app.put('/api/income-sources/:id', async (req, res) => {
  const existing = await getIncomeSource(req.params.id);
  if (!existing) {
    res.status(404).json({ error: 'source not found' });
    return;
  }
  const parsed = incomeSourcePatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: badRequest(parsed.error) });
    return;
  }
  const source = await upsertIncomeSource({
    id: existing.id,
    label: parsed.data.label ?? existing.label,
    kind: parsed.data.kind ?? existing.kind,
    patterns: parsed.data.patterns ?? existing.patterns,
  });
  await reclassifyAll();
  answer(res, 'PUT /api/income-sources/:id', source);
});

app.delete('/api/income-sources/:id', async (req, res) => {
  if (!(await deleteIncomeSource(req.params.id))) {
    res.status(400).json({ error: 'source not found or builtin (salary/family/other)' });
    return;
  }
  await reclassifyAll();
  answer(res, 'DELETE /api/income-sources/:id', { deleted: true });
});

app.patch('/api/transactions/:id/one-off', async (req, res) => {
  const body = jsonBody(req, res);
  if (!body) return;
  const oneOff = body.oneOff;
  if (typeof oneOff !== 'boolean') {
    res.status(400).json({ error: 'oneOff field required: true | false' });
    return;
  }
  const tx = await setOneOff(req.params.id, oneOff);
  if (!tx) {
    res.status(404).json({ error: 'transaction not found' });
    return;
  }
  answer(res, 'PATCH /api/transactions/:id/one-off', tx);
});

/** Groups hidden by the user still come back, so the app can show them in edit mode. */
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
  answer(res, 'GET /api/recurring', await recurringPayload());
});

/** The group is identified by its normalized description, as in the detector. */
app.post('/api/recurring/ignore', async (req, res) => {
  const body = jsonBody(req, res);
  if (!body) return;
  if (typeof body.description !== 'string' || !body.description.trim()) {
    res.status(400).json({ error: 'description field required' });
    return;
  }
  if (typeof body.ignored !== 'boolean') {
    res.status(400).json({ error: 'ignored field required: true | false' });
    return;
  }
  await setRecurringIgnored(body.description, body.ignored);
  answer(res, 'POST /api/recurring/ignore', await recurringPayload());
});

const parseGoalBody = (
  body: Record<string, unknown>,
  res: express.Response,
): GoalCreate | undefined => {
  const parsed = goalCreateSchema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const at = issue?.path.length ? `${issue.path.join('.')}: ` : '';
  res.status(400).json({ error: `${at}${issue?.message ?? 'invalid goal'}` });
  return undefined;
};

const goalConstraint = (error: unknown): string | undefined => {
  let current = error;
  const seen = new Set<unknown>();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const value = current as { constraint?: unknown; cause?: unknown };
    if (typeof value.constraint === 'string') return value.constraint;
    current = value.cause;
  }
  return undefined;
};

const answerGoalWriteError = (error: unknown, res: express.Response): boolean => {
  if (error instanceof GoalWriteError) {
    const conflict = new Set([
      'account-unavailable',
      'currency-mismatch',
      'debt-account-immutable',
      'duplicate-category',
      'goal-capacity',
      'not-debt',
      'target-debt-invalid',
    ]).has(error.code);
    res.status(conflict ? 409 : 400).json({ error: error.message });
    return true;
  }
  if (goalConstraint(error) === 'category_spending_goals_category_unique') {
    res.status(409).json({ error: 'a category spending limit already tracks this category' });
    return true;
  }
  return false;
};

app.get('/api/goals', async (_req, res) => {
  answer(res, 'GET /api/goals', await listGoalProgress());
});

app.post('/api/goals', async (req, res) => {
  const raw = jsonBody(req, res);
  if (!raw) return;
  const body = parseGoalBody(raw, res);
  if (!body) return;
  try {
    const created = await createGoal(body);
    const detail = await getGoalProgress(created.id);
    if (!detail) throw new Error(`created goal ${created.id} could not be read back`);
    answer(res, 'POST /api/goals', detail);
  } catch (error) {
    if (!answerGoalWriteError(error, res)) throw error;
  }
});

app.get('/api/goals/:id', async (req, res) => {
  const detail = await getGoalProgress(req.params.id);
  if (!detail) {
    res.status(404).json({ error: 'goal not found' });
    return;
  }
  answer(res, 'GET /api/goals/:id', detail);
});

app.put('/api/goals/:id', async (req, res) => {
  const raw = jsonBody(req, res);
  if (!raw) return;
  const body = parseGoalBody(raw, res);
  if (!body) return;
  try {
    const written = await replaceGoal(req.params.id, body);
    if (!written.ok) {
      if (written.reason === 'not-found') {
        res.status(404).json({ error: 'goal not found' });
      } else {
        res.status(409).json({ error: 'a goal type cannot be changed' });
      }
      return;
    }
    const detail = await getGoalProgress(req.params.id);
    if (!detail) throw new Error(`updated goal ${req.params.id} could not be read back`);
    answer(res, 'PUT /api/goals/:id', detail);
  } catch (error) {
    if (!answerGoalWriteError(error, res)) throw error;
  }
});

app.delete('/api/goals/:id', async (req, res) => {
  if (!(await deleteGoal(req.params.id))) {
    res.status(404).json({ error: 'goal not found' });
    return;
  }
  answer(res, 'DELETE /api/goals/:id', { deleted: true, id: req.params.id });
});

app.get('/api/app-settings', async (_req, res) => {
  answer(res, 'GET /api/app-settings', await getAppSettings());
});

app.patch('/api/app-settings', async (req, res) => {
  const body = jsonBody(req, res);
  if (!body) return;
  const parsed = parseAppSettingsPatch(body);
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
  answer(res, 'PATCH /api/app-settings', settings);
});

app.get('/api/conversion', async (_req, res) => {
  answer(res, 'GET /api/conversion', {
    baseCurrency: await currentBaseCurrency(),
    converting: baseAmountsConverting(),
    unconverted: await countUnconverted(),
  });
});

app.get('/api/category-rules', async (_req, res) => {
  const rules = await listCategoryRules();
  answer(
    res,
    'GET /api/category-rules',
    await Promise.all(
      rules.map(async (r) => ({ ...r, ...(await countCategoryRuleMatches(r.pattern)) })),
    ),
  );
});

app.post('/api/category-rules/preview', async (req, res) => {
  const body = jsonBody(req, res);
  if (!body) return;
  const pattern = typeof body.pattern === 'string' ? body.pattern.trim() : '';
  if (!pattern) {
    res.status(400).json({ error: 'Enter the part of the description to match.' });
    return;
  }
  answer(res, 'POST /api/category-rules/preview', await previewCategoryRule(pattern));
});

app.post('/api/category-rules', async (req, res) => {
  const body = jsonBody(req, res);
  if (!body) return;
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
  if (body.previewToken !== undefined && (typeof body.previewToken !== 'string' || !/^[a-f0-9]{64}$/.test(body.previewToken))) {
    res.status(400).json({ error: 'Preview the matching transactions before applying this rule.' });
    return;
  }
  const rule = body.previewToken === undefined
    ? await addCategoryRule(pattern, category)
    : await applyPreviewedCategoryRule(pattern, category, body.previewToken);
  if (!rule) {
    res.status(409).json({ error: 'The matching transactions or rules changed. Refresh the preview before applying the rule.' });
    return;
  }
  await reclassifyAll();
  answer(res, 'POST /api/category-rules', { rule, ...(await countCategoryRuleMatches(rule.pattern)) });
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
  answer(res, 'DELETE /api/category-rules/:id', { deleted: true });
});

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
  // every transaction the person has, in one response: res.send sets an ETag and no
  // Cache-Control, which permits heuristic caching of the whole of it
  res.setHeader('Cache-Control', 'no-store');
  // BOM - so Excel opens UTF-8 with non-latin characters without a fight
  res.send('\uFEFF' + [header, ...lines].join('\n'));
});

/** Years of transactions in any format this reads. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** One constant per limit, so the number enforced and the number in the message agree. */
const UPLOAD_LIMITS = {
  fileSize: MAX_UPLOAD_BYTES,
  files: 1,
  fields: 10,
  fieldSize: 1024 * 1024, // multer's own default, written down
};

/**
 * In memory, never on disk: the hash is over the bytes and the XLSX reader takes a
 * Buffer. Mounted per route rather than globally, so no other route pays for a
 * multipart parse it never asked for.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: UPLOAD_LIMITS,
  // multer defaults this to latin1 while browsers write filename= as raw UTF-8
  // bytes: the two disagree without failing, so the name simply arrives wrong
  defParamCharset: 'utf8',
});

const NOT_MULTIPART = 'the upload is not a valid multipart form';

/**
 * One message per code: a field over the size limit reported as a problem with the
 * file field sends the caller looking in the wrong place.
 */
function uploadError(err: unknown): string {
  if (!(err instanceof multer.MulterError)) return NOT_MULTIPART;
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
  if (!req.is('multipart')) {
    res.status(400).json({ error: NOT_MULTIPART });
    return;
  }
  upload.single('file')(req, res, (err: unknown) => {
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
 * The one field of this request the user writes by hand, so it is checked rather than
 * cast: a number where a column name belongs otherwise reaches the parser and lands an
 * internal TypeError in the import's error_detail. Strict, because a stripped unknown
 * key ("date_format" for "dateFormat") imports the file against the wrong date format
 * and answers 200.
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

app.get('/api/imports/presets', (_req, res) => {
  answer(res, 'GET /api/imports/presets', {
    presets: [
      { key: 'generic', title: 'Any statement (auto-detect the date, amount and description columns)' },
      ...Object.entries(CSV_PRESETS).map(([key, p]) => ({ key, title: p.title })),
    ],
  });
});

/** **This does not import anything.** It stages, and confirm is what commits. */
app.post('/api/imports', uploadFile, async (req, res) => {
  const body = req.body as Record<string, unknown>;
  // Checked by hand rather than by a schema: multipart fields carry no type, so
  // nothing above this route can hold a StatementDestination.
  //
  // The two retired fields are refused rather than ignored - a request carrying
  // accountName states a destination, and dropping it silently is the guess this
  // route exists to refuse. Refused ahead of accountId, so a request carrying only
  // currency reads the sentence about currency rather than one about a field it did
  // not send.
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
  // no shape check beyond that, deliberately: an id restored from a backup is not
  // always a UUID, and the lookup is what decides whether an id is real
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
    });
    if (result.outcome === 'duplicate') {
      const where = result.accountIds.join(', ') || 'no account (its rows were already there)';
      logImport.info(`already imported as ${result.importId}, rows in ${where}`);
      answer(res, 'POST /api/imports', result);
      return;
    }
    const { summary } = result;
    logImport.info(
      `import ${summary.importId} staged for ${summary.accountId}: ${summary.accepted} rows read, ${summary.newRows} new, skipped ${summary.skipped} of ${summary.total}`,
    );
    answer(res, 'POST /api/imports', result);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

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
 * One switch over the union rather than a ternary over two of its members: a member
 * added to ConfirmOutcome is then a compile error here instead of a new refusal
 * rendered with somebody else's sentence.
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

app.post('/api/imports/:id/confirm', async (req, res) => {
  let result: Awaited<ReturnType<typeof confirmImport>>;
  try {
    result = await confirmImport(req.params.id);
  } catch (e) {
    if (!(e instanceof ImportNotConfirmable)) throw e;
    // A broken invariant, not a bad request, so the status stays 5xx. What changes is
    // the body: the global handler's `internal error` reads as transient on the one
    // screen whose job is saying whether the data landed, so the person presses
    // Confirm again and gets it again. The real message goes to the log.
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
  await reclassifyAll();
  answer(res, 'POST /api/imports/:id/confirm', {
    importId: req.params.id,
    accountId: result.accountId,
    accountIds: result.accountIds,
    inserted: result.inserted,
    skipped: result.rowsRejected,
    total: result.rowsAccepted + result.rowsRejected,
  });
});

/**
 * Idempotent - a second discard reports the state that already holds - but a
 * `committed` import is refused: its rows are real data, and DELETE /api/imports/:id
 * is the path that removes those.
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
  answer(res, 'POST /api/imports/:id/discard', { discarded: true, importId: req.params.id });
});

/**
 * Presence then shape, deliberately not q(): q() maps both '' and a repeated parameter
 * to undefined, and undefined here means every account. A caller writing
 * `?accountId=${account?.id ?? ''}` would then be answered with every import there
 * is and print it as one account's. Same test and same sentence as
 * summaryScope. An id that matches no account is not an error.
 */
app.get('/api/imports', async (req, res) => {
  if (req.query.accountId !== undefined) {
    const accountId = req.query.accountId;
    if (typeof accountId !== 'string' || accountId.length === 0) {
      res.status(400).json({ error: 'accountId must be sent once, as a single value' });
      return;
    }
    answer(res, 'GET /api/imports', await listImports({ accountId }));
    return;
  }
  answer(res, 'GET /api/imports', await listImports());
});

app.delete('/api/imports/:id', async (req, res) => {
  const result = await deleteImport(req.params.id);
  if (!result) {
    res.status(404).json({ error: 'import not found' });
    return;
  }
  logger.info(`import ${req.params.id} deleted: ${result.removed} transactions removed`);
  await reclassifyAll(); // transfer pairing changes when the other leg disappears
  answer(res, 'DELETE /api/imports/:id', { deleted: true, transactions: result.removed });
});

/** A whitelist, so a character nobody thought of is replaced rather than passed on. */
const asciiName = (name: string): string => name.replace(/[^A-Za-z0-9._-]/g, '_');

/** encodeURIComponent, plus the characters it leaves that are not attr-chars. */
const rfc5987 = (name: string): string =>
  encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/**
 * Runs BEFORE both encodings, so neither half can carry a path: percent-encoding stops
 * header injection but not a client that saves what it decodes.
 *
 * By code point rather than by UTF-16 unit, and unpaired surrogates go: the RFC 5987
 * half's encodeURIComponent THROWS on a lone one, which the global handler would answer
 * as a 500 on a download that worked. A cap that counts UTF-16 units rather than code
 * points makes one, and a restored row's name is a foreign JSON's string, where a lone
 * surrogate is legal.
 */
const cleanName = (name: string): string =>
  Array.from(name.replace(/[\u0000-\u001f\u007f\\/]/g, ''))
    .filter((c) => c.length > 1 || c < '\ud800' || c > '\udfff')
    .slice(0, 100)
    .join('')
    .replace(/^[.\s]+/, '')
    .trim();

/**
 * The whole value is built here rather than assembled from a guarded part: a CRLF in
 * the name splits the response, a `"` ends the quoted string early, and anything above
 * U+00FF makes setHeader throw on a route that otherwise worked.
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

/** Whatever the import's status: the status gates nothing on this route, on purpose. */
app.get('/api/imports/:id/document', async (req, res) => {
  const ref = await getImportDocumentRef(req.params.id);
  if (!ref) {
    // absent and "no readable document" are one answer and one code path. It says
    // READ and never "kept": the row's claim survives a restore, and the file it
    // names belongs to the disk it was uploaded to
    res.status(404).json({ error: DOCUMENT_NOT_READABLE });
    return;
  }
  let bytes: Buffer;
  try {
    bytes = await getDocument(ref);
  } catch (e) {
    // A row that claims a document whose file is not here is the ordinary state of a
    // restored backup, so it joins the 404 above rather than reporting a fault: the
    // machine holding the statements is the machine they were uploaded to. Every
    // other read failure is 500 and not 400 - the user's file is not at fault - and
    // the whole chain goes to the log. The client gets no path, no errno, no filename
    if (e instanceof DocumentMissing) {
      logImport.info(`import ${req.params.id} claims a document that is not on this disk`);
      res.status(404).json({ error: DOCUMENT_NOT_READABLE });
      return;
    }
    logImport.error(
      { err: e },
      `import ${req.params.id} document could not be read: ${causeChain(e)}`,
    );
    res.status(500).json({ error: DOCUMENT_READ_REFUSED });
    return;
  }
  const info = await getImportDocumentInfo(req.params.id);
  // attachment + nosniff + octet-stream, all three: these are user-uploaded bytes
  // served back from the app's own origin
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // res.send(Buffer) sets an ETag and no Cache-Control, which permits heuristic
  // caching of a decrypted bank statement
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Disposition', attachmentDisposition(req.params.id, info));
  logImport.info(`import ${req.params.id} document sent (${bytes.length} bytes)`);
  res.send(bytes);
});

app.delete('/api/imports/:id/document', async (req, res) => {
  // on the ROW, never on the pointer: a row whose pointer is cleared may still have
  // a file, and those are exactly the rows a retention policy has to reach. And it
  // runs before any disk access - checking afterwards would delete a file for an id
  // with no row, then answer "not found"
  const info = await getImportDocumentInfo(req.params.id);
  if (!info) {
    res.status(404).json({ error: 'import not found' });
    return;
  }
  let bytesRemoved: boolean;
  try {
    bytesRemoved = await deleteDocument(info);
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
  logImport.info(`import ${req.params.id} document deleted (bytes removed: ${bytesRemoved})`);
  answer(res, 'DELETE /api/imports/:id/document', { deleted: true, importId: req.params.id, bytesRemoved });
});

app.get('/api/backup', async (_req, res) => {
  const stamp = new Date().toISOString().slice(0, 10);
  const data = await exportBackup();
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="finto-backup-${stamp}.json"`);
  // as on the CSV export and the document download: this is every table in the
  // database, and nothing may hold a copy of it that the person did not ask for
  res.setHeader('Cache-Control', 'no-store');
  res.send(JSON.stringify(data));
});

app.post(
  '/api/restore',
  express.raw({ type: 'application/octet-stream', limit: MAX_BODY_BYTES }),
  async (req, res) => {
    // the file arrives either as a raw octet-stream (Buffer) or, when the client
    // sends application/json, already parsed by the global json middleware
    const raw: unknown = req.body;
    if (Buffer.isBuffer(raw) && raw.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) {
      res.status(400).json({
        error:
          'this is a SQLite database from an old version of Finto, not a backup - nothing in this version reads one, and what this route takes is the JSON backup from the Overview screen',
      });
      return;
    }
    let data: ReturnType<typeof parseBackup>;
    try {
      const input: unknown = Buffer.isBuffer(raw) ? JSON.parse(raw.toString('utf8')) : raw;
      data = parseBackup(input);
    } catch (e) {
      // The parser's own sentences describe the file the caller sent, so echoing them
      // tells them what to fix and gives away nothing they did not already have.
      res.status(400).json({ error: `backup could not be restored: ${(e as Error).message}` });
      return;
    }

    let tables: number;
    let rows: number;
    try {
      const done = await restoreBackup(data);
      tables = done.tables;
      rows = done.rows;
    } catch (e) {
      // Never the message here: drizzle wraps every driver error, so its message is the
      // whole failed statement and every bound value. The chain goes to the log, and
      // the body gets a sentence that names no column and no row.
      logger.error(`restore failed: ${reasonFirst(e)}`);
      res.status(400).json({
        error:
          'backup could not be restored: the file was read, but writing it to the database failed - the reason is in the log this server printed',
      });
      return;
    }

    // Outside the block above on purpose. By here the database is already replaced, so
    // a throw from re-tagging is not a failed restore and answering 400 for it would
    // send the person back to a restore that has in fact already happened.
    try {
      await reclassifyAll(); // the backup may predate the current tagging rules
    } catch (e) {
      logger.error(`restored, but re-tagging it failed: ${reasonFirst(e)}`);
    }
    logger.info(`restored from backup: tables ${tables}, rows ${rows}`);
    answer(res, 'POST /api/restore', { restored: true, tables, rows });
  },
);

/** The built client, when `npm run setup` has produced one. */
export const WEB_DIST = path.join(__dirname, '..', '..', 'web', 'dist');

export const CLIENT_NOT_BUILT =
  'the web client is not built - run `npm run setup` from the repository root, then start again';

/**
 * RELATIVE to the build, never the absolute path on disk. `filePath.includes('/assets/')`
 * reads the whole path, so a checkout under any directory called `assets` - and a home
 * directory is one somebody can have - served index.html with a year of immutable
 * caching, and the person's browser then never sees a new version of the app at all.
 * Only Vite puts a content hash in a name, and only under that one folder.
 */
export function cacheControlFor(dist: string, filePath: string): string {
  const relative = path.relative(dist, filePath);
  return relative.startsWith(`assets${path.sep}`)
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
}

/**
 * Whether a path that matched no file gets the app. Two conditions, and the first is
 * the one that was missing: a request for a FILE that is not there is a 404, never
 * 200 with a page in it. After a rebuild a stale index.html asks for a bundle whose
 * name no longer exists, and answering HTML makes the browser report a syntax error
 * inside a script - which sends the reader to the wrong file entirely.
 *
 * "File-shaped" is the last segment carrying an extension. It is the only signal
 * available: a <script src> is sent with `Accept: * / *`, which matches text/html, so
 * the Accept header alone cannot tell a bundle from a page. Accept is still checked,
 * because it is what keeps a JSON client from being handed a page.
 */
export const servesTheApp = (pathname: string, acceptsHtml: boolean): boolean =>
  acceptsHtml && !/\.[A-Za-z0-9]+$/.test(pathname.split('/').pop() ?? '');

/**
 * Below every /api route, so nothing here can shadow one, and for GET alone: a POST to
 * an unknown path is refused, never answered with a page. Only what Vite wrote under
 * assets/ carries a content hash in its name, so only that may be cached for good; the
 * page and the favicon are revalidated, or a rebuilt client never reaches the browser.
 */
export function serveClient(target: express.Express, dist: string): void {
  target.use(
    express.static(dist, {
      index: false,
      setHeaders: (res, filePath) => {
        res.setHeader('Cache-Control', cacheControlFor(dist, filePath));
      },
    }),
  );

  target.get(/^\/(?!api(?:\/|$)).*/, (req, res) => {
    const index = path.join(dist, 'index.html');
    if (!fs.existsSync(index)) {
      res.status(503).type('text/plain').send(CLIENT_NOT_BUILT);
      return;
    }
    if (!servesTheApp(req.path, Boolean(req.accepts('html')))) {
      res.status(404).type('text/plain').send('not found');
      return;
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile('index.html', { root: dist });
  });
}

serveClient(app, WEB_DIST);

const ECHO_MAX = 200;
const BODY_NOT_JSON_PREFIX = 'the request body could not be read as JSON: ';

const callerFault = (err: unknown): err is { status: number; expose: true; type?: unknown; message: string } => {
  if (typeof err !== 'object' || err === null) return false;
  const { status, expose, message } = err as { status?: unknown; expose?: unknown; message?: unknown };
  return (
    typeof status === 'number' &&
    Number.isInteger(status) &&
    status >= 400 &&
    status < 500 &&
    expose === true &&
    typeof message === 'string'
  );
};

// One handler, and no per-route wrapper: Express 5 catches an async route's rejection
// itself. A parser's refusal is the caller's and keeps the parser's status; on the 500
// arm the message goes to the log and not to the client - it tends to carry table
// names and SQL fragments.
export const errorHandler: express.ErrorRequestHandler = (err: unknown, req, res, next) => {
  if (res.headersSent) {
    logHttp.error(err);
    next(err);
    return;
  }
  if (callerFault(err)) {
    const said = err.message.slice(0, ECHO_MAX);
    const error =
      err.type === 'entity.too.large'
        ? BODY_TOO_LARGE
        : err.type === 'entity.parse.failed'
          ? `${BODY_NOT_JSON_PREFIX}${said}`
          : said;
    // fields only: a parse failure carries the whole request body as an own property
    logHttp.warn(`refused ${req.method} ${req.originalUrl}: ${String(err.type ?? 'error')} (${err.status})`);
    res.status(err.status).json({ error });
    return;
  }
  logHttp.error(err);
  res.status(500).json({ error: 'internal error' });
};

app.use(errorHandler);

type RouteLayer = {
  route?: { path: unknown; methods: Record<string, boolean> };
  handle?: { stack?: unknown; name?: string };
};

const DOOR_MIDDLEWARES = new Set<string>([
  ...[answerCheck, headersAndLog, originCheck, errorHandler].map((fn) => fn.name),
  'jsonParser',
  'serveStatic',
]);

export function registeredAnswerKeys(target: express.Express): string[] {
  const keys: string[] = [];
  for (const layer of target.router.stack as RouteLayer[]) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) {
        keys.push(`${method.toUpperCase()} ${String(layer.route.path)}`);
      }
    } else if (Array.isArray(layer.handle?.stack) || layer.handle?.name === 'mounted_app') {
      throw new Error(
        'a router is mounted on the app: routes are registered on app directly so the declaration walk can see them',
      );
    } else if (!DOOR_MIDDLEWARES.has(layer.handle?.name ?? '')) {
      throw new Error(
        `a middleware the door does not name is on the app: ${layer.handle?.name || 'anonymous'} - the app's non-route layers are the door's named middlewares and nothing else`,
      );
    }
  }
  return keys;
}

export function assertAnswersDeclared(target: express.Express): void {
  const [first] = target.router.stack as RouteLayer[];
  if (first?.handle !== answerCheck) {
    throw new Error(
      `the answer check is not the first layer on the app (${first?.handle?.name || 'anonymous'} is): every route and every refusing middleware sits behind it or its answer goes unparsed`,
    );
  }
  const registered = new Set(registeredAnswerKeys(target));
  const declared = new Set(Object.keys(ANSWERS));
  const undeclared = [...registered].filter((k) => !declared.has(k));
  const unregistered = [...declared].filter((k) => !registered.has(k));
  if (undeclared.length > 0 || unregistered.length > 0) {
    throw new Error(
      `every route declares its answer in src/wire: registered and not declared: ${undeclared.join(', ') || 'none'}; declared and not registered: ${unregistered.join(', ') || 'none'}`,
    );
  }
}

assertAnswersDeclared(app);
