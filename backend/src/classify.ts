/**
 * Detecting transfers between your own accounts. Such transactions are neither
 * income nor spending — the money just moved from one of your pockets to another,
 * and counting them in analytics inflates both sides.
 *
 * Four rules:
 *
 * 1. Pair matching. A card-to-card transfer shows up in the database twice: an
 *    expense on one of your accounts and income on another. An example from a
 *    statement, both in the same second:
 *      Mono UAH  -2000.00 UAH  "Переказ на картку"
 *      Mono EUR    +44.10 EUR  "З Чорної картки"
 *    Both rows get flagged as a transfer. Different currencies are fine: the
 *    amounts are checked against the exchange rate.
 *
 * 2. The owner's name in the description ("Від: Yurii Kalvenko") — your own money
 *    moved from a bank that isn't connected to the app. Names come from OWNER_NAMES.
 *
 * 3. A "description + account" rule from the transfer_rules table — the user tagged
 *    a transaction and asked to apply that to all like it (see db.ts). Needed where
 *    pair matching can't help: an outgoing "Sent from N26" has nothing to pair with,
 *    because the matching Revolut income is already explained by rule 2 and never
 *    becomes a candidate (see below).
 *
 * 4. A manual flag on a single transaction — the strongest signal; it lives in a
 *    separate transfer_manual column that this module never touches.
 *
 * A transaction recognized by rule 2 or 3 is not offered for pairing: it is already
 * fully explained. The false match that guards against is spelled out at the
 * candidate filter in reclassifyAll below.
 *
 * The recompute runs at backend startup and after every sync.
 */
import { getAppSettings } from './appsettings';
import { RULES_VERSION, categorize, isRefund, recurringKey } from './categorizer';
import {
  Classification,
  allTransactions,
  applyClassification,
  getMeta,
  listCategoryRules,
  listIncomeSources,
  listTransferRules,
  setMeta,
} from './db';
import { backfillBaseAmounts } from './fxrates';
import { getRatesToUAH } from './rates';
import { Transaction } from './types';

/**
 * Window for a same-currency pair: the amounts have to match to the cent, so there
 * is no need to hurry — Enable Banking only gives transactions a date, no time.
 * 36 hours rather than 4 days: on round amounts (20/50/100 EUR) a wide window kept
 * gluing unrelated transactions together (a -20 EUR merchant payment and an
 * unrelated +77 EUR incoming transfer were the confirmed victims).
 */
const SAME_CURRENCY_WINDOW_MS = 36 * 3600_000;

/**
 * Only transactions that look like a transfer are offered for pairing: category
 * "transfers" (a p2p MCC or transfer wording in the description) or an
 * unrecognized "other". An expense identified as a merchant purchase or a cash
 * withdrawal cannot be the other leg of a transfer — that is exactly what stops a
 * -20 EUR merchant payment being glued to a +20 EUR incoming card transfer. Income
 * categorized as salary/cashback is excluded symmetrically.
 */
const PAIRABLE_CATEGORIES = new Set(['transfers', 'other']);

/**
 * Window for a cross-currency pair: the amounts don't match, so time is the only
 * protection against a false positive. Banks move money between your own cards
 * instantly, so the window is deliberately narrow.
 */
const CROSS_CURRENCY_WINDOW_MS = 10 * 60_000;

/** Tolerance when checking a cross-currency pair: bank spread + rate drift. */
const FX_TOLERANCE = 0.15;

/** Amounts equal within one currency (floats, hence not ===). */
const AMOUNTS_EQUAL_EPS = 0.005;

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * The owner's name in the description. Matched word by word rather than as a
 * substring: statements use any order ("Yurii Kalvenko", "Калвенко Юрій"). Single-word
 * names are ignored — far too easy to hit a random merchant.
 */
function makeOwnerMatcher(): (description: string) => boolean {
  const names = [...getAppSettings().ownerNames, getMeta('monobank_client_name') ?? '']
    .map((n) => normalizeName(n).split(' ').filter((w) => w.length >= 3))
    .filter((words) => words.length >= 2);

  if (names.length === 0) return () => false;

  return (description: string) => {
    const d = normalizeName(description);
    if (!d) return false;
    const words = new Set(d.split(' '));
    return names.some((name) => name.every((w) => words.has(w)));
  };
}

/**
 * "Description + account" rules from the database. The description is matched
 * exactly (as the bank sent it) — a rule is created by tapping a specific
 * transaction, so the string is guaranteed to match what the bank sends for that
 * group.
 */
function makeRuleMatcher(): (t: Transaction) => boolean {
  const rules = new Set(listTransferRules().map((r) => `${r.accountId}\0${r.description}`));
  if (rules.size === 0) return () => false;
  return (t: Transaction) => rules.has(`${t.accountId}\0${t.description}`);
}

/**
 * Auto-tagging the income source from the patterns in income_sources: income whose
 * description contains all the words of one of a source's patterns ("ANNA BECKER",
 * "Від: Becker Anna" -> family) gets that source's id. Matched the same way as
 * owner names: by words, at least two words of 3+ letters. The first matching
 * source (by sort) wins.
 */
function makeSourceMatcher(): (description: string) => string | undefined {
  const sources = listIncomeSources()
    .map((s) => ({
      id: s.id,
      names: s.patterns
        .map((n) => normalizeName(n).split(' ').filter((w) => w.length >= 3))
        .filter((words) => words.length >= 2),
    }))
    .filter((s) => s.names.length > 0);
  if (sources.length === 0) return () => undefined;
  return (description: string) => {
    const d = normalizeName(description);
    if (!d) return undefined;
    const words = new Set(d.split(' '));
    return sources.find((s) => s.names.some((name) => name.every((w) => words.has(w))))?.id;
  };
}

/**
 * User rules "description contains X -> category Y" (created in the app).
 * Stronger than the dictionary: the dictionary is a default, a rule is the owner's
 * explicit decision.
 */
function makeCategoryRuleMatcher(): (description: string) => string | undefined {
  const rules = listCategoryRules().map((r) => [r.pattern.toLowerCase(), r.category] as const);
  if (rules.length === 0) return () => undefined;
  return (description: string) => {
    const d = (description || '').toLowerCase();
    if (!d) return undefined;
    for (const [pattern, category] of rules) {
      if (pattern && d.includes(pattern)) return category;
    }
    return undefined;
  };
}

// ---------- recurring payments ----------

/** Minimum number of distinct calendar months for a group to count as recurring. */
const RECURRING_MIN_MONTHS = 3;
/** Allowed deviation from the group's median (rent 1000 -> 1020 still passes). */
const RECURRING_AMOUNT_TOLERANCE = 0.2;

/**
 * Recurring payments: the same description in >= 3 different months with a similar
 * amount (±20% of the median). Catches rent, subscriptions and memberships;
 * groceries ("Rewe", anywhere from 5 to 100 EUR) are filtered out by the spread of
 * amounts.
 */
function detectRecurring(
  txs: Transaction[],
  result: Map<string, Classification>,
): Set<string> {
  const groups = new Map<string, Transaction[]>();
  for (const t of txs) {
    if (t.amount >= 0 || !t.description) continue;
    if (result.get(t.id)!.transfer) continue;
    const key = `${t.currency}\0${recurringKey(t.description)}`;
    const list = groups.get(key);
    if (list) list.push(t);
    else groups.set(key, [t]);
  }

  const recurring = new Set<string>();
  for (const group of groups.values()) {
    if (group.length < RECURRING_MIN_MONTHS) continue;
    const amounts = group.map((t) => -t.amount).sort((a, b) => a - b);
    const median = amounts[Math.floor(amounts.length / 2)];
    const stable = group.filter(
      (t) => Math.abs(-t.amount - median) <= median * RECURRING_AMOUNT_TOLERANCE,
    );
    const months = new Set(stable.map((t) => t.date.slice(0, 7)));
    if (months.size >= RECURRING_MIN_MONTHS) {
      for (const t of stable) recurring.add(t.id);
    }
  }
  return recurring;
}

/** Amount in hryvnia — the common denominator for checking a cross-currency pair. */
function toUAH(amount: number, currency: string, rates: Record<string, number>): number | null {
  const rate = rates[currency];
  return rate ? Math.abs(amount) * rate : null;
}

function fxPlausible(
  expense: Transaction,
  income: Transaction,
  rates: Record<string, number>,
): boolean {
  const a = toUAH(expense.amount, expense.currency, rates);
  const b = toUAH(income.amount, income.currency, rates);
  // no rate available — trust the time match, which is narrow anyway
  if (a === null || b === null || a === 0 || b === 0) return true;
  return Math.abs(a - b) / Math.max(a, b) <= FX_TOLERANCE;
}

/** Exported for tests: the pair-matching rules without touching the database. */
export function canPair(
  expense: Transaction,
  income: Transaction,
  gapMs: number,
  rates: Record<string, number>,
): boolean {
  if (expense.accountId === income.accountId) return false;
  if (expense.currency === income.currency) {
    if (gapMs > SAME_CURRENCY_WINDOW_MS) return false;
    return Math.abs(Math.abs(expense.amount) - income.amount) <= AMOUNTS_EQUAL_EPS;
  }
  if (gapMs > CROSS_CURRENCY_WINDOW_MS) return false;
  return fxPlausible(expense, income, rates);
}

/**
 * Rates are only needed to check cross-currency pairs. If Monobank is unreachable,
 * classify without them: those pairs are still caught by the narrow time window.
 */
async function ratesOrEmpty(): Promise<Record<string, number>> {
  try {
    return await getRatesToUAH();
  } catch {
    return {};
  }
}

/**
 * Recategorizes and re-tags the whole database. Idempotent: a full recompute from
 * the transaction's source fields, no state accumulates.
 * @returns how many transactions were recognized as transfers
 */
export async function reclassifyAll(): Promise<number> {
  const rates = await ratesOrEmpty();
  const isOwner = makeOwnerMatcher();
  const sourceFor = makeSourceMatcher();
  const matchesRule = makeRuleMatcher();
  const userCategory = makeCategoryRuleMatcher();
  const txs = allTransactions();

  const result = new Map<string, Classification>(
    txs.map((t) => {
      const refund = isRefund(t.amount, t.description);
      const category =
        userCategory(t.description) ?? categorize(t.mcc, t.description, t.amount);
      const income = t.amount > 0 && !refund;
      return [
        t.id,
        {
          id: t.id,
          category,
          refund,
          // transfer already recognized by owner name or by a rule; pairing is below
          transfer: isOwner(t.description) || matchesRule(t),
          // income source: a source's patterns -> its id,
          // otherwise the salary category -> salary, otherwise other
          incomeSource: income
            ? (sourceFor(t.description) ?? (category === 'salary' ? 'salary' : 'other'))
            : null,
          recurring: false, // detector runs below, once transfers are known
        },
      ];
    }),
  );

  // Pairing candidates. Filtered out:
  //  - refunds on the income side: a refund is a cancelled purchase, not money
  //    coming in, so it can't be the other half of a transfer;
  //  - anything already recognized as a transfer. Such a transaction is fully
  //    explained, and offering it for pairing is dangerous: an incoming
  //    "Від: Yurii Kalvenko" +20 EUR (moved from a bank that isn't connected) would
  //    otherwise be glued to a -20 EUR ATM withdrawal on the same day, and the real
  //    cash expense would disappear from the analytics;
  //  - anything categorized as a purchase/cash/salary (see PAIRABLE_CATEGORIES).
  const expenses = txs.filter(
    (t) =>
      t.amount < 0 &&
      !result.get(t.id)!.transfer &&
      PAIRABLE_CATEGORIES.has(result.get(t.id)!.category),
  );
  // income recognized by a source pattern (family support, a stipend) is explained
  // income and can't be the other leg of a transfer: otherwise a +20000 UAH family
  // transfer would be glued to an unrelated expense of the same size
  const incomes = txs.filter(
    (t) =>
      t.amount > 0 &&
      !result.get(t.id)!.refund &&
      !result.get(t.id)!.transfer &&
      sourceFor(t.description) === undefined &&
      PAIRABLE_CATEGORIES.has(result.get(t.id)!.category),
  );

  // First collect every allowed pair, then hand them out in order of increasing time
  // gap: the closest pair wins. Expenses used to be processed chronologically, and
  // an earlier expense could steal someone else's income — a -20 EUR withdrawal on
  // the 9th took the +20 EUR incoming card transfer from the 12th, even though that
  // one arrived in the same minute as its real counterpart. The result no longer
  // depends on iteration order.
  const candidates: { expense: Transaction; income: Transaction; gapMs: number }[] = [];
  for (const expense of expenses) {
    const expenseAt = Date.parse(expense.date);
    for (const income of incomes) {
      const gapMs = Math.abs(Date.parse(income.date) - expenseAt);
      if (!canPair(expense, income, gapMs, rates)) continue;
      candidates.push({ expense, income, gapMs });
    }
  }
  candidates.sort((a, b) => a.gapMs - b.gapMs);

  const paired = new Set<string>();
  for (const { expense, income } of candidates) {
    if (paired.has(expense.id) || paired.has(income.id)) continue;
    paired.add(expense.id);
    paired.add(income.id);
    result.get(expense.id)!.transfer = true;
    result.get(income.id)!.transfer = true;
  }

  // recurring payments are detected after transfers: a transfer leg isn't a payment
  for (const id of detectRecurring(txs, result)) {
    result.get(id)!.recurring = true;
  }

  const rows = [...result.values()];
  applyClassification(rows);
  setMeta('classify_version', rulesSignature());

  // base_amount for new transactions: rates on their dates (cached in fx_rates)
  await backfillBaseAmounts();

  return rows.filter((r) => r.transfer).length;
}

/**
 * Signature of the tagging rules: code version + OWNER_NAMES + income source
 * patterns + user category rules. Changing any of them, in .env or in the database,
 * requires a recompute — otherwise new rules would only apply at the next sync and
 * the old tags would stay wrong.
 * (A source's kind is not part of the signature: it affects summaries, not tagging.)
 */
function rulesSignature(): string {
  const categoryRules = listCategoryRules()
    .map((r) => `${r.pattern}>${r.category}`)
    .sort()
    .join(';');
  const sourcePatterns = listIncomeSources()
    .map((s) => `${s.id}:${s.patterns.join('+')}`)
    .sort()
    .join(';');
  return `${RULES_VERSION}|${getAppSettings().ownerNames.join(',')}|${sourcePatterns}|${categoryRules}`;
}

/** Recompute at startup if the tagging rules changed since the last run. */
export async function reclassifyIfRulesChanged(): Promise<boolean> {
  if (getMeta('classify_version') === rulesSignature()) return false;
  await reclassifyAll();
  return true;
}
