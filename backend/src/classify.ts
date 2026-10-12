import { getAppSettings } from './appsettings';
import { RULES_VERSION, categorize, isRefund, recurringKey } from './categorizer';
import { currencyKey, sameCurrency } from './currency';
import {
  Classification,
  allTransactions,
  applyClassification,
  getClassifyOwed,
  getClassifyStamp,
  listCategoryRules,
  listIncomeSources,
  listTransferRules,
  setClassifyStamp,
} from './db';
import { backfillBaseAmounts } from './fxrates';
import { getRatesToUAH } from './rates';
import { IncomeSourceDef, Transaction, TransferRule } from './types';
import { categoryPatternMatches, makeTransferRuleMatcher } from './transaction-description';
import type { CategoryRule } from './wire';

/**
 * Window for a same-currency pair. The amounts have to match to the cent, so there is
 * no need to hurry. A statement's date also often carries a calendar day and no time,
 * so two legs booked a minute apart can sit 24 hours apart in the data. Hence a floor
 * above a day. 36 hours rather than 4 days: on round amounts (20/50/100 EUR) a wide
 * window kept gluing unrelated transactions together.
 */
const SAME_CURRENCY_WINDOW_MS = 36 * 3600_000;

/**
 * An expense identified as a merchant purchase or a cash withdrawal cannot be the
 * other leg of a transfer. That is what stops a -20 EUR merchant payment being glued
 * to a +20 EUR incoming card transfer. Income categorized as salary/cashback is
 * excluded symmetrically.
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

interface TaggingRules {
  ownerNames: string[];
  incomeSources: IncomeSourceDef[];
  transferRules: TransferRule[];
  categoryRules: CategoryRule[];
}

async function loadTaggingRules(): Promise<TaggingRules> {
  const { ownerNames } = await getAppSettings();
  const incomeSources = await listIncomeSources();
  const transferRules = await listTransferRules();
  const categoryRules = await listCategoryRules();
  return { ownerNames, incomeSources, transferRules, categoryRules };
}

interface RunLoad {
  rules: TaggingRules;
  owed: string | undefined;
}

async function loadRun(): Promise<RunLoad> {
  // before the rows, which reclassifyWith reads itself: read after them, it can name a
  // write the rows never received
  const owed = await getClassifyOwed();
  return { rules: await loadTaggingRules(), owed };
}

/**
 * Matched word by word rather than as a substring: statements write a name in any
 * order. Names below two words are dropped, because one word hits a random merchant.
 */
function makeOwnerMatcher(ownerNames: string[]): (description: string) => boolean {
  const names = ownerNames
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

/** Patterns are matched like owner names, and the first matching source by sort wins. */
function makeSourceMatcher(incomeSources: IncomeSourceDef[]): (description: string) => string | undefined {
  const sources = incomeSources
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

/** Stronger than the dictionary: the dictionary is a default, a rule is the owner's decision. */
function makeCategoryRuleMatcher(rules: CategoryRule[]): (description: string) => string | undefined {
  if (rules.length === 0) return () => undefined;
  return (description: string) => rules.find((r) => categoryPatternMatches(description, r.pattern))?.category;
}

const RECURRING_MIN_MONTHS = 3;
/** A fraction of the group's median, not an absolute amount. */
const RECURRING_AMOUNT_TOLERANCE = 0.2;

/**
 * The same description in enough distinct months at a similar amount. The spread of
 * amounts is what keeps a supermarket out: it is in the description every month and
 * never for the same amount.
 */
function detectRecurring(
  txs: Transaction[],
  result: Map<string, Classification>,
): Set<string> {
  const groups = new Map<string, Transaction[]>();
  for (const t of txs) {
    if (t.amount >= 0 || !t.description) continue;
    if (result.get(t.id)!.transfer) continue;
    const key = `${currencyKey(t.currency)}\0${recurringKey(t.description)}`;
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

/** Amount in hryvnia, the common denominator for checking a cross-currency pair. */
function toUAH(amount: number, currency: string, rates: Record<string, number>): number | null {
  const rate = rates[currencyKey(currency)];
  return rate ? Math.abs(amount) * rate : null;
}

function fxPlausible(
  expense: Transaction,
  income: Transaction,
  rates: Record<string, number>,
): boolean {
  const a = toUAH(expense.amount, expense.currency, rates);
  const b = toUAH(income.amount, income.currency, rates);
  // with no rate available, trust the time match: it is narrow anyway
  if (a === null || b === null || a === 0 || b === 0) return true;
  return Math.abs(a - b) / Math.max(a, b) <= FX_TOLERANCE;
}

/**
 * The gap canPair's windows are held against. A time that does not read counts as midnight
 * of its day: a restore keeps the 25:99 an earlier version stored, and the day is still the
 * one the bank wrote. That places the row on its day and no closer, which the same-currency
 * window can use and the ten-minute cross-currency one cannot, so across currencies the gap
 * is unknown.
 */
export function pairingGap(expense: Transaction, income: Transaction): number {
  const expenseAt = Date.parse(expense.date);
  const incomeAt = Date.parse(income.date);
  if (!Number.isNaN(expenseAt) && !Number.isNaN(incomeAt)) return Math.abs(incomeAt - expenseAt);
  if (!sameCurrency(expense.currency, income.currency)) return NaN;
  const dayOrTime = (at: number, date: string) => (Number.isNaN(at) ? Date.parse(date.slice(0, 10)) : at);
  return Math.abs(dayOrTime(incomeAt, income.date) - dayOrTime(expenseAt, expense.date));
}

/** Exported so the pair rules can be exercised without a database. */
export function canPair(
  expense: Transaction,
  income: Transaction,
  gapMs: number,
  rates: Record<string, number>,
): boolean {
  if (expense.accountId === income.accountId) return false;
  // a date whose day does not read either; NaN would pass each window below as not too far
  if (Number.isNaN(gapMs)) return false;
  if (sameCurrency(expense.currency, income.currency)) {
    if (gapMs > SAME_CURRENCY_WINDOW_MS) return false;
    return Math.abs(Math.abs(expense.amount) - income.amount) <= AMOUNTS_EQUAL_EPS;
  }
  if (gapMs > CROSS_CURRENCY_WINDOW_MS) return false;
  return fxPlausible(expense, income, rates);
}

/**
 * Rates are only needed for cross-currency pairs, and those are still bounded by the
 * narrow time window. So an unreachable provider classifies without them.
 */
async function ratesOrEmpty(): Promise<Record<string, number>> {
  try {
    return await getRatesToUAH();
  } catch {
    return {};
  }
}

async function reclassifyWith({ rules, owed }: RunLoad): Promise<number> {
  const isOwner = makeOwnerMatcher(rules.ownerNames);
  const sourceFor = makeSourceMatcher(rules.incomeSources);
  const matchesRule = makeTransferRuleMatcher(rules.transferRules);
  const userCategory = makeCategoryRuleMatcher(rules.categoryRules);
  const txs = await allTransactions();
  const rates = await ratesOrEmpty();

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
          incomeSource: income
            ? (sourceFor(t.description) ?? (category === 'salary' ? 'salary' : 'other'))
            : null,
          recurring: false, // detector runs below, once transfers are known
        },
      ];
    }),
  );

  // A transaction already explained is not a candidate: an incoming "Від: Yurii
  // Kalvenko" +20 EUR would otherwise be glued to a -20 EUR ATM withdrawal on the same
  // day, and the real cash expense would disappear from the analytics. A refund is a
  // cancelled purchase rather than money coming in, so it cannot be a leg either.
  const expenses = txs.filter(
    (t) =>
      t.amount < 0 &&
      !result.get(t.id)!.transfer &&
      PAIRABLE_CATEGORIES.has(result.get(t.id)!.category),
  );
  // income explained by a source pattern cannot be a leg either: a family transfer
  // would otherwise be glued to an unrelated expense of the same size
  const incomes = txs.filter(
    (t) =>
      t.amount > 0 &&
      !result.get(t.id)!.refund &&
      !result.get(t.id)!.transfer &&
      sourceFor(t.description) === undefined &&
      !(t.categoryManual && t.category === 'support') &&
      PAIRABLE_CATEGORIES.has(result.get(t.id)!.category),
  );

  // Every allowed pair first, then handed out by increasing gap, so the closest pair
  // wins and the result does not depend on iteration order: processing expenses in
  // date order let an earlier one take an income that arrived in the same minute as
  // its real counterpart.
  const candidates: { expense: Transaction; income: Transaction; gapMs: number }[] = [];
  for (const expense of expenses) {
    for (const income of incomes) {
      const gapMs = pairingGap(expense, income);
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
  await applyClassification(rows);
  await setClassifyStamp(rulesSignature(rules), owed);

  await backfillBaseAmounts();

  return rows.filter((r) => r.transfer).length;
}

/**
 * A source's kind is deliberately outside it: kind moves summaries, not tags. It reads
 * nothing on purpose, because a read taken after the writes can name a rule the rows
 * never got.
 */
function rulesSignature(rules: TaggingRules): string {
  const transferRules = rules.transferRules
    .map((r) => JSON.stringify([r.accountId, r.matchMode, r.description]))
    .sort();
  const categoryRules = rules.categoryRules
    .map((r) => `${r.pattern}>${r.category}`)
    .sort()
    .join(';');
  const sourcePatterns = rules.incomeSources
    .map((s) => `${s.id}:${s.patterns.join('+')}`)
    .sort()
    .join(';');
  return `${RULES_VERSION}|${rules.ownerNames.join(',')}|${sourcePatterns}|${categoryRules}|[${transferRules.join(',')}]`;
}

let tail: Promise<unknown> = Promise.resolve();

function serialised<T>(job: () => Promise<T>): Promise<T> {
  const run = tail.then(() => job());
  // only the queue drops the rejection: each caller's own promise still carries it
  tail = run.catch(() => undefined);
  return run;
}

let queued: Promise<number> | undefined;

/** @returns how many transactions were recognized as transfers */
export async function reclassifyAll(): Promise<number> {
  queued ??= serialised(async () => {
    // cleared as the run starts, not as it ends: a caller arriving after this point may
    // have written after this run's load, so it has to get the next run, not this one
    queued = undefined;
    return reclassifyWith(await loadRun());
  });
  return queued;
}

export type Stale = 'rules' | 'rows';

export async function reclassifyIfStale(): Promise<Stale | false> {
  return serialised(async () => {
    const load = await loadRun();
    const stamp = await getClassifyStamp();
    const stale: Stale | false =
      stamp.signature !== rulesSignature(load.rules)
        ? 'rules'
        : load.owed !== undefined && load.owed !== stamp.paid
          ? 'rows'
          : false;
    if (!stale) return false;
    // the body and not reclassifyAll: this job already holds the queue, and the wrapper
    // would wait on it forever
    await reclassifyWith(load);
    return stale;
  });
}

export async function reclassifyIdle(): Promise<void> {
  for (let seen = tail; ; seen = tail) {
    await seen;
    if (seen === tail) return;
  }
}
