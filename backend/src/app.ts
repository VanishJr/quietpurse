/**
 * The Express application: middleware chain + every route. Deliberately separate
 * from the process entry point (index.ts, which connects the database and calls
 * listen) so that tests can mount this app against an embedded PGlite and drive
 * the real middleware chain over HTTP - the session check and the workspace
 * scoping are the parts most worth testing, and they only exist here.
 */
import express from 'express';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import { ensureWorkspace, getAuth } from './auth';
import { CATEGORIES } from './categorizer';
import { reclassifyAll } from './classify';
import { config } from './config';
import {
  addCategoryRule,
  addTransferRule,
  clearManualForRule,
  countCategoryRuleMatches,
  countRuleMatches,
  currentBaseCurrency,
  currentWorkspaceId,
  dbInstance,
  listUserWorkspaceIds,
  listWorkspaceIds,
  runWithWorkspace,
  deleteCategoryRule,
  exportBackup,
  parseBackup,
  restoreBackup,
  deleteIncomeSource,
  deleteTransferRule,
  getIncomeSource,
  getTransaction,
  listIncomeSources,
  resetBaseAmounts,
  upsertIncomeSource,
  listAccounts,
  baselineTotal,
  deleteBaselineItem,
  lastSuccessfulSync,
  listBaselineItems,
  listBudgets,
  listCategoryRules,
  listEbSessions,
  listRecurringGroups,
  listSyncJournal,
  listTransactions,
  listTransferRules,
  setAccountHidden,
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
  upsertBaselineItem,
} from './db';
import { backfillBaseAmounts } from './fxrates';
import { computeIndependence } from './independence';
import { logCsv, logHttp, logger } from './logger';
import { CSV_PRESETS, CsvImportRequest, importCsv } from './providers/csv';
import { completeAuth, ebConfigured, listAspsps, startAuth } from './providers/enablebanking';
import { getAppSettings, updateAppSettings } from './appsettings';
import { getSettings, updateSettings } from './settings';
import { getSyncStatus, scheduleAutoSync, startSync } from './sync';
import { Summary } from './types';

/** Escaping for HTML output (the Enable Banking callback - reflected XSS). */
const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
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
  runWithWorkspace(workspaceId, () => next());
});

// Body parsing sits AFTER the session check on purpose: with a 25 MB limit,
// parsing before authenticating would let anyone who can reach the port make the
// server chew through 25 MB of JSON per request for free.
// (The limit itself is for CSV statements covering years - 100 kb is not enough.)
app.use(express.json({ limit: '25mb' }));

const q = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

// Open endpoint: also tells the web client whether registration needs an invite
// code, so the sign-up form can ask for one (see AuthScreen).
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, signup: config.signupInviteCode ? 'invite' : 'open' });
});

// ?all=1 - including hidden ones (the Accounts screen shows them so they can be restored)
app.get('/api/accounts', async (req, res) => {
  res.json(await listAccounts(q(req.query.all) === '1'));
});

/** Remove an account from the app or bring it back. */
app.patch('/api/accounts/:id', async (req, res) => {
  const hidden = (req.body as { hidden?: unknown }).hidden;
  if (typeof hidden !== 'boolean') {
    res.status(400).json({ error: 'hidden field required: true | false' });
    return;
  }
  const account = await setAccountHidden(req.params.id, hidden);
  if (!account) {
    res.status(404).json({ error: 'account not found' });
    return;
  }
  res.json(account);
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

/**
 * The current calendar month by default, or an explicit ?from=&to=. All amounts
 * are in the base currency: transfers between your own accounts are excluded from
 * every figure, refunds are subtracted from spending in their own category
 * (see classify.ts).
 */
app.get('/api/summary', async (req, res) => {
  const now = new Date();
  let from = q(req.query.from);
  let to = q(req.query.to);
  if (!from || !to) {
    from = `${now.toISOString().slice(0, 7)}-01`;
    to = now.toISOString().slice(0, 10);
  }
  const fromIso = `${from}T00:00:00.000Z`;
  const toIso = `${to}T23:59:59.999Z`;
  const summary: Summary = {
    from,
    to,
    baseCurrency: await currentBaseCurrency(),
    totals: await summaryTotals(fromIso, toIso),
    byCategory: await summaryByCategory(fromIso, toIso),
    incomeByCategory: await summaryIncomeByCategory(fromIso, toIso),
    incomeBySource: await summaryIncomeBySource(fromIso, toIso),
  };
  res.json(summary);
});

/** Spending/income by month in the base currency - the "over the year" chart. */
app.get('/api/summary/months', async (req, res) => {
  const now = new Date();
  const from = q(req.query.from) ?? `${now.getUTCFullYear()}-01-01`;
  const to = q(req.query.to) ?? `${now.getUTCFullYear()}-12-31`;
  res.json({
    from,
    to,
    baseCurrency: await currentBaseCurrency(),
    months: await summaryMonthlyTotals(`${from}T00:00:00.000Z`, `${to}T23:59:59.999Z`),
  });
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
 * changing the owner names re-tags transfers immediately; the sync interval is
 * rearmed without a restart.
 */
app.patch('/api/app-settings', async (req, res) => {
  const { settings, baseCurrencyChanged, ownerNamesChanged } = await updateAppSettings(
    req.body as Record<string, unknown>,
  );
  // auto-sync is a single server-wide timer serving the owner workspace (see
  // sync.ts) - only that workspace's interval setting re-arms it
  if (currentWorkspaceId() === (await listWorkspaceIds())[0]) {
    scheduleAutoSync(settings.syncIntervalMin);
  }
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

// ---------- onboarding ----------

/** What is already configured: the wizard shows while there is not a single account. */
app.get('/api/onboarding/status', async (_req, res) => {
  const accounts = await listAccounts(true);
  res.json({
    needed: accounts.length === 0,
    accounts: accounts.length,
    settings: await getAppSettings(),
    providers: {
      monobank: { configured: Boolean(config.monobankToken) },
      enablebanking: { configured: ebConfigured(), sessions: (await listEbSessions()).length },
      csv: { configured: true },
    },
  });
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
  const spent = new Map((await summaryByCategory(from, to)).map((c) => [c.category, c.total]));
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

// ---------- CSV import ----------

/** Mapping presets + generic with column auto-detection. */
app.get('/api/csv/presets', (_req, res) => {
  res.json({
    presets: [
      { key: 'generic', title: 'Any CSV (auto-detect date/amount/description columns)' },
      ...Object.entries(CSV_PRESETS).map(([key, p]) => ({ key, title: p.title })),
    ],
  });
});

/**
 * A statement from any bank. The rows go through the common pipeline: insert ->
 * reclassify -> convert to the base currency. Duplicates on a repeated upload are
 * filtered out by a hash of the row's contents.
 */
app.post('/api/csv/import', async (req, res) => {
  const body = req.body as Partial<CsvImportRequest>;
  if (typeof body.accountName !== 'string' || !body.accountName.trim()) {
    res.status(400).json({ error: 'accountName field required' });
    return;
  }
  if (typeof body.currency !== 'string' || !/^[A-Za-z]{3}$/.test(body.currency.trim())) {
    res.status(400).json({ error: 'currency field required (3-letter ISO code)' });
    return;
  }
  if (typeof body.csv !== 'string' || !body.csv.trim()) {
    res.status(400).json({ error: 'csv field required with the file contents' });
    return;
  }
  try {
    const result = await importCsv({
      accountName: body.accountName.trim(),
      currency: body.currency.trim(),
      preset: typeof body.preset === 'string' ? body.preset : undefined,
      mapping: typeof body.mapping === 'object' && body.mapping ? body.mapping : undefined,
      csv: body.csv,
    });
    logCsv.info(
      `import into ${result.accountId}: new ${result.inserted}, skipped ${result.skipped} of ${result.total}`,
    );
    await reclassifyAll(); // categories, transfers, sources, base_amount
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
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
  express.raw({ type: 'application/octet-stream', limit: '500mb' }),
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

app.post('/api/sync', async (_req, res) => {
  const started = startSync();
  res.json({ started, status: await syncStatusPayload() });
});

/**
 * Problems the user should see on screen (rather than in stdout): expired Enable
 * Banking sessions + non-fatal errors from the last run (a dead Monobank token
 * shows up exactly there).
 */
async function syncProblems(): Promise<string[]> {
  const problems: string[] = [];
  const now = Date.now();
  for (const s of await listEbSessions()) {
    if (Date.parse(s.validUntil) <= now) {
      problems.push(
        `${s.aspspName} session expired on ${s.validUntil.slice(0, 10)} - reconnect the bank`,
      );
    }
  }
  const last = (await listSyncJournal(1))[0];
  if (last && last.ok !== null) problems.push(...last.errors);
  return problems;
}

async function syncStatusPayload() {
  const lastOk = await lastSuccessfulSync();
  // "data current as of ...": the end of the last successful run; for older
  // databases without a journal - the most recent account sync
  const freshAsOf =
    lastOk?.finishedAt ??
    (await listAccounts())
      .map((a) => a.lastSyncedAt)
      .filter((v): v is string => Boolean(v))
      .sort()
      .pop() ??
    null;
  return { ...getSyncStatus(), freshAsOf, problems: await syncProblems() };
}

app.get('/api/sync/status', async (_req, res) => {
  res.json(await syncStatusPayload());
});

app.get('/api/sync/journal', async (req, res) => {
  const limit = q(req.query.limit) ? parseInt(q(req.query.limit)!, 10) : 20;
  res.json({ runs: await listSyncJournal(Number.isFinite(limit) ? limit : 20) });
});

// ---------- Enable Banking: connecting a bank ----------

// Open in a browser: /api/enablebanking/connect?bank=Revolut&country=LT
app.get('/api/enablebanking/connect', async (req, res) => {
  if (!ebConfigured()) {
    res.status(400).json({ error: 'EB_APP_ID / EB_PRIVATE_KEY_PATH are not set in .env' });
    return;
  }
  const bank = q(req.query.bank);
  const country = q(req.query.country);
  if (!bank || !country) {
    res.status(400).json({ error: 'bank and country query parameters required, e.g. ?bank=Revolut&country=LT' });
    return;
  }
  const url = await startAuth(bank, country.toUpperCase());
  res.redirect(url);
});

app.get('/api/enablebanking/callback', async (req, res) => {
  const code = q(req.query.code);
  const state = q(req.query.state);
  const error = q(req.query.error);
  if (error || !code || !state) {
    res
      .status(400)
      .send(
        `<h3>Could not connect the bank</h3><pre>${escapeHtml(error || 'no code/state in the callback')}</pre>`,
      );
    return;
  }
  const result = await completeAuth(code, state);
  startSync(); // pull the new bank's data straight away
  res.send(
    `<h3>${escapeHtml(result.bank)} connected</h3>
     <p>Accounts: ${escapeHtml(result.accounts.join(', ') || '(none found)')}</p>
     <p>Sync started - you can close this tab.</p>`,
  );
});

// Helper: exact ASPSP names for startAuth (e.g. ?country=DE)
app.get('/api/enablebanking/aspsps', async (req, res) => {
  const country = q(req.query.country);
  if (!country) {
    res.status(400).json({ error: 'country query parameter required, e.g. ?country=LT' });
    return;
  }
  res.json(await listAspsps(country.toUpperCase()));
});

// single error handler (Express 5 catches rejections from async routes itself)
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logHttp.error(err);
  res.status(500).json({ error: err.message });
});
