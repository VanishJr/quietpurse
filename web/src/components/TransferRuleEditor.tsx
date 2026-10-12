import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import { fmtDay, fmtMoney } from '../format';
import type { Transaction, TransferRulePreview } from '../types';
import { Button } from './Button';
import { FormActions } from './FormActions';
import { Notice } from './Notice';

interface Props {
  transaction: Transaction;
  accountName: string;
  onBack: () => void;
  onBusyChange: (busy: boolean) => void;
  onApplied: (transaction: Transaction, notice: string) => Promise<void>;
  renderActions?: (actions: ReactNode) => ReactNode;
}

export function TransferRuleEditor({ transaction, accountName, onBack, onBusyChange, onApplied, renderActions }: Props) {
  const [preview, setPreview] = useState<TransferRulePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => { heading.current?.focus(); }, []);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    setPreview(null);
    api.transferRulePreview(transaction.id).then((result) => {
      if (!current) return;
      setPreview(result);
      setNeedsRefresh(false);
    }).catch((e: Error) => {
      if (current) setError(e.message);
    }).finally(() => {
      if (current) setLoading(false);
    });
    return () => { current = false; };
  }, [transaction.id, refresh]);

  const apply = async (remove: boolean) => {
    if (!preview || saving || loading || needsRefresh || (!remove && preview.matches === 0)) return;
    setSaving(true);
    onBusyChange(true);
    setError(null);
    let notice: string | undefined;
    try {
      if (remove) {
        if (!preview.activeRule) return;
        await api.deleteTransferRule(preview.activeRule.id);
        notice = 'Transfer rule removed. Automatic detection and individual settings still apply.';
      } else {
        const result = await api.addTransferRule(transaction.id, preview.previewToken);
        notice = result.matches === 1
          ? '1 transaction marked as a transfer.'
          : `${result.matches} transactions marked as transfers.`;
      }
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

  const actions = (
    <FormActions
      className="rule-preview__actions"
      back={
        <Button type="button" variant="tertiary" size="touch" aria-disabled={saving} onClick={onBack}>
          Back to transaction
        </Button>
      }
      cancel={
        <>
          <Button type="button" variant="secondary" size="touch" pending={loading} aria-disabled={saving || loading}
            onClick={() => { if (!saving && !loading) setRefresh((value) => value + 1); }}>Refresh preview</Button>
          {preview?.activeRule && (
            <Button type="button" variant="destructive-secondary" size="touch" aria-disabled={saving || loading || needsRefresh}
              onClick={() => apply(true)}>Remove transfer rule</Button>
          )}
        </>
      }
      completion={preview && (
        <Button type="button" variant="primary" size="touch" pending={saving}
          aria-disabled={saving || loading || needsRefresh || preview.matches === 0}
          onClick={() => apply(false)}>Apply transfer rule</Button>
      )}
    />
  );

  return (
    <div className="rule-preview">
      <div className="rule-preview__scope">
        <h2 className="sheet-title" tabIndex={-1} ref={heading}>Transfer rules</h2>
        <p className="sheet-meta">{accountName} · All dates</p>
        <p className="hint">The rule also applies to future matching transactions on this account.</p>
      </div>
      <div className="rule-preview__evidence">
        {loading && <Notice role="status">Loading matching transactions…</Notice>}
        {preview && (
          <>
            <p className="rule-preview-count">
              {preview.matches} {preview.matches === 1 ? 'transaction matches' : 'transactions match'}
            </p>
            {preview.manualOverrides > 0 && (
              <p className="hint">
                {preview.manualOverrides} manual transfer {preview.manualOverrides === 1 ? 'setting will' : 'settings will'} be replaced.
              </p>
            )}
            <ul className="rule-preview-list" aria-label="Matching transactions">
              {preview.transactions.map((tx) => (
                <li key={tx.id}>
                  <div className="rule-preview-row">
                    <span>{tx.displayDescription ?? (tx.description || '(no description)')}</span>
                    <strong>{fmtMoney(tx.amount, tx.currency)}</strong>
                  </div>
                  <div className="sheet-meta">
                    {fmtDay(tx.date)}
                    {tx.transferManual !== null && (
                      <span> · {tx.transferManual ? 'Manually marked as transfer' : 'Manually marked as not a transfer'}</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      <div className="rule-preview__warnings">
        {preview?.activeRule && (
          <p className="hint">
            {preview.activeRule.matchMode === 'exact'
              ? 'An existing rule applies only to identical descriptions.'
              : 'A transfer rule is active for these similar descriptions.'}
          </p>
        )}
        {error && <Notice tone="error" role="alert" remedy={needsRefresh ? 'Refresh the preview before applying or removing a rule.' : undefined}>{error}</Notice>}
        {saving && <Notice role="status">Saving transfer rule…</Notice>}
      </div>
      {renderActions ? renderActions(actions) : actions}
    </div>
  );
}
