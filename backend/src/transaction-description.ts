import type { Transaction, TransferRule } from './wire';

export function transactionDescription(description: string): {
  displayDescription?: string;
  valueDate?: string;
} {
  const suffix = /\s+Wertstellung\s+(\d{2})\.(\d{2})\.(\d{4})\s*$/i.exec(description);
  if (!suffix) return {};
  const displayDescription = description.slice(0, suffix.index).trim();
  const valueDate = `${suffix[3]}-${suffix[2]}-${suffix[1]}`;
  const date = new Date(`${valueDate}T00:00:00.000Z`);
  if (!displayDescription || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== valueDate) {
    return {};
  }
  return { displayDescription, valueDate };
}

export function similarDescriptionKey(description: string): string {
  return (transactionDescription(description).displayDescription ?? description)
    .normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function matchesTransferRule(
  rule: Pick<TransferRule, 'accountId' | 'description' | 'matchMode'>,
  tx: Pick<Transaction, 'accountId' | 'description'>,
): boolean {
  if (rule.accountId !== tx.accountId) return false;
  if (rule.matchMode === 'exact') return rule.description === tx.description;
  const key = similarDescriptionKey(rule.description);
  return key !== '' && key === similarDescriptionKey(tx.description);
}
