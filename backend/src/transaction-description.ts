import { type CalendarDay, calendarDay, type Transaction, type TransferRule } from './wire';

export function transactionDescription(description: string): {
  displayDescription?: string;
  valueDate?: CalendarDay;
} {
  // (?<=\S): only the first space after a word can start the suffix, so a run of
  // whitespace is scanned once and not once per position
  const suffix = /(?<=\S)\s+Wertstellung\s+(\d{2})\.(\d{2})\.(\d{4})\s*$/i.exec(description);
  if (!suffix) return {};
  const displayDescription = description.slice(0, suffix.index).trim();
  const valueDate = calendarDay(`${suffix[3]}-${suffix[2]}-${suffix[1]}`);
  if (!displayDescription || valueDate === null) return {};
  return { displayDescription, valueDate };
}

export function similarDescriptionKey(description: string): string {
  return (transactionDescription(description).displayDescription ?? description)
    .normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function categoryPatternMatches(description: string, pattern: string): boolean {
  const needle = pattern.toLowerCase();
  return needle !== '' && description.toLowerCase().includes(needle);
}

type Rule = Pick<TransferRule, 'accountId' | 'description' | 'matchMode'>;
type Row = Pick<Transaction, 'accountId' | 'description'>;

export function matchesTransferRule(rule: Rule, tx: Row): boolean {
  if (rule.accountId !== tx.accountId) return false;
  if (rule.matchMode === 'exact') return rule.description === tx.description;
  const key = similarDescriptionKey(rule.description);
  return key !== '' && key === similarDescriptionKey(tx.description);
}

/** Empty for a similar rule with nothing left to match on, which matches no row. */
function ruleKey(rule: Rule): string {
  return rule.matchMode === 'exact' ? rule.description : similarDescriptionKey(rule.description);
}

const byAccount = <T>(index: Map<string, T>, accountId: string, empty: () => T): T => {
  let entry = index.get(accountId);
  if (entry === undefined) index.set(accountId, (entry = empty()));
  return entry;
};

export function makeTransferRuleMatcher(rules: Rule[]): (tx: Row) => boolean {
  const exact = new Map<string, Set<string>>();
  const similar = new Map<string, Set<string>>();
  for (const rule of rules) {
    const key = ruleKey(rule);
    if (rule.matchMode !== 'exact' && key === '') continue;
    byAccount(rule.matchMode === 'exact' ? exact : similar, rule.accountId, () => new Set<string>()).add(key);
  }
  return (tx) =>
    (exact.get(tx.accountId)?.has(tx.description) ?? false) ||
    (similar.get(tx.accountId)?.has(similarDescriptionKey(tx.description)) ?? false);
}

export function tallyTransferRuleMatches(rows: Iterable<Row>): (rule: Rule) => number {
  const exact = new Map<string, Map<string, number>>();
  const similar = new Map<string, Map<string, number>>();
  const bump = (index: Map<string, Map<string, number>>, accountId: string, key: string): void => {
    const counts = byAccount(index, accountId, () => new Map<string, number>());
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  for (const row of rows) {
    bump(exact, row.accountId, row.description);
    bump(similar, row.accountId, similarDescriptionKey(row.description));
  }
  return (rule) => {
    const key = ruleKey(rule);
    if (rule.matchMode !== 'exact' && key === '') return 0;
    return (rule.matchMode === 'exact' ? exact : similar).get(rule.accountId)?.get(key) ?? 0;
  };
}
