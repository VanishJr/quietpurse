import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { CATEGORIES, categoryLabel, categoryRuleCaption } from '../categories';
import { fmtDate, fmtMoney } from '../format';
import type { Account, CategoryRulePreview, Transaction } from '../types';

interface Props {
  transaction: Transaction;
  accounts: Account[];
  onBack: () => void;
  onBusyChange: (busy: boolean) => void;
  onDraftChange: (dirty: boolean) => void;
  onApplied: (transaction: Transaction, notice: string) => Promise<void>;
}

export function CategoryRuleEditor({ transaction, accounts, onBack, onBusyChange, onDraftChange, onApplied }: Props) {
  const [pattern, setPattern] = useState(transaction.displayDescription ?? transaction.description);
  const openingPattern = useRef(pattern.trim());
  const [query, setQuery] = useState(pattern.trim());
  const category = CATEGORIES.find((value) => value === transaction.category);
  const [preview, setPreview] = useState<CategoryRulePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const dirty = pattern.trim() !== query;

  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => { onDraftChange(pattern.trim() !== openingPattern.current); }, [pattern, onDraftChange]);
  useEffect(() => () => onDraftChange(false), [onDraftChange]);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    setPreview(null);
    api.categoryRulePreview(query).then((result) => {
      if (!current) return;
      setPreview(result);
      setNeedsRefresh(false);
    }).catch((e: Error) => {
      if (current) setError(e.message);
    }).finally(() => {
      if (current) setLoading(false);
    });
    return () => { current = false; };
  }, [query, refresh]);

  const refreshPreview = () => {
    if (saving || !pattern.trim()) return;
    setQuery(pattern.trim());
    setRefresh((value) => value + 1);
  };

  const apply = async (remove: boolean) => {
    if (!preview || saving || dirty || needsRefresh || (!remove && !category)) return;
    setSaving(true);
    onBusyChange(true);
    setError(null);
    let notice: string | undefined;
    try {
      if (remove) {
        if (!preview.activeRule) return;
        await api.deleteCategoryRule(preview.activeRule.id);
        notice = 'Category rule removed. Automatic detection and individual settings still apply.';
      } else if (category) {
        const result = await api.addCategoryRule({ pattern: preview.pattern }, category, preview.previewToken);
        notice = categoryRuleCaption(result.rule.pattern, result.rule.category, result);
      }
      if (!notice) return;
      openingPattern.current = pattern.trim();
      onDraftChange(false);
      const updated = await api.transaction(transaction.id);
      await onApplied(updated, notice);
    } catch (e) {
      setNeedsRefresh(true);
      setError(`${notice ? `${notice} Could not refresh the transaction: ` : ''}${(e as Error).message}`);
    } finally {
      setSaving(false);
      onBusyChange(false);
    }
  };

  return (
    <div className="rule-preview">
      <h2 className="sheet-title" tabIndex={-1} ref={heading}>Apply category</h2>
      <p>Category: <strong>{categoryLabel(transaction.category)}</strong></p>
      <p className="sheet-meta">All accounts · All dates</p>
      <p className="hint">The rule also applies to future matching transactions, including on hidden accounts.</p>
      <form className="rule-preview-form" onSubmit={(event) => { event.preventDefault(); refreshPreview(); }}>
        <label className="setting-label" htmlFor="category-rule-pattern">Description contains</label>
        <input id="category-rule-pattern" className="input" value={pattern} readOnly={saving}
          onChange={(event) => { if (!saving) setPattern(event.target.value); }} />
        <button className="btn-ghost" type="submit" disabled={saving || loading || !pattern.trim()}>
          {dirty ? 'Preview matches' : 'Refresh preview'}
        </button>
      </form>
      {loading && <p role="status">Loading matching transactions…</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {dirty && <p role="status" className="hint">Preview the edited text before applying the rule.</p>}
      {preview && !dirty && (
        <>
          <p>{preview.matches} {preview.matches === 1 ? 'transaction matches' : 'transactions match'}</p>
          {preview.overridden > 0 && (
            <p className="hint">{preview.overridden} {preview.overridden === 1 ? 'transaction keeps its' : 'transactions keep their'} manually assigned category.</p>
          )}
          {preview.activeRule && <p className="hint">Active rule: {categoryLabel(preview.activeRule.category)}.</p>}
          {preview.otherRules.length > 0 && (
            <div className="rule-preview-rules">
              <p className="hint">Other rules also match. The newest rule takes priority; select a rule to view or remove it.</p>
              {preview.otherRules.map((rule) => (
                <button key={rule.id} className="btn-ghost" disabled={saving || needsRefresh} onClick={() => {
                  setPattern(rule.pattern);
                  setQuery(rule.pattern);
                  setRefresh((value) => value + 1);
                  heading.current?.focus();
                }}>
                  View rule: {rule.pattern} → {categoryLabel(rule.category)}
                </button>
              ))}
            </div>
          )}
          <ul className="rule-preview-list" aria-label="Matching transactions">
            {preview.transactions.map((tx) => (
              <li key={tx.id}>
                <div className="rule-preview-row">
                  <span>{tx.displayDescription ?? (tx.description || '(no description)')}</span>
                  <strong>{fmtMoney(tx.amount, tx.currency)}</strong>
                </div>
                <div className="sheet-meta">
                  {fmtDate(tx.date)} · {accounts.find((account) => account.id === tx.accountId)?.name ?? 'Account'} · {categoryLabel(tx.category)}
                  {accounts.find((account) => account.id === tx.accountId)?.hidden && ' · Hidden account'}
                  {tx.categoryManual && ' · Manually assigned category kept'}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      <button className="btn" disabled={saving || loading || dirty || needsRefresh || !preview || !category}
        onClick={() => apply(false)}>{saving ? 'Saving…' : `Apply ${categoryLabel(transaction.category)}`}</button>
      {preview?.activeRule && !dirty && (
        <button className="btn-ghost rule-remove-button" disabled={saving || loading || needsRefresh}
          onClick={() => apply(true)}>Remove category rule</button>
      )}
      <button className="btn-ghost" disabled={saving} onClick={onBack}>Back to transaction</button>
    </div>
  );
}
