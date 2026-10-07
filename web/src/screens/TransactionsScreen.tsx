import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { useEditorSession } from '../editor';
import { CATEGORIES, Category, categoryLabel } from '../categories';
import { Sheet } from '../components/Sheet';
import { Button } from '../components/Button';
import { Field } from '../components/Field';
import { FormActions } from '../components/FormActions';
import { Notice } from '../components/Notice';
import { PageHeader } from '../components/PageHeader';
import { TransferRuleEditor } from '../components/TransferRuleEditor';
import { CategoryRuleEditor } from '../components/CategoryRuleEditor';
import { fmtDate, fmtMoney, isoDay } from '../format';
import { useTheme } from '../theme';
import {
  Account,
  IncomeSource,
  IncomeSourceDef,
  Transaction,
  TxFocus,
} from '../types';

/**
 * The window each option names, carried on the entry rather than derived from the key a
 * second time — a label and the window under it cannot then drift apart. `days: null`
 * is unbounded, which is what an arrival with a `focus` opens on.
 */
const PERIODS = [
  { key: '7d', label: '7 days', days: 7 },
  { key: '30d', label: '30 days', days: 30 },
  { key: '90d', label: '90 days', days: 90 },
  { key: 'all', label: 'All', days: null },
] as const;

type PeriodKey = (typeof PERIODS)[number]['key'];
type MutationOwner = 'category' | 'transfer' | 'one-off' | 'income source';

interface FilterOption {
  key: string;
  label: string;
}

function TransactionFilter({
  label,
  options,
  selected,
  onSelect,
}: {
  label: string;
  options: FilterOption[];
  selected: string;
  onSelect: (key: string) => void;
}) {
  const id = useId();
  return (
    <Field id={id} label={label} control="select" className="transaction-filter" controlProps={{
      value: selected,
      onChange: (event) => onSelect(event.target.value),
      children: options.map((option) => <option key={option.key} value={option.key}>{option.label}</option>),
    }} />
  );
}

function periodBounds(p: PeriodKey): { from?: string; to: string } {
  const now = new Date();
  const to = isoDay(now);
  const { days } = PERIODS.find((x) => x.key === p)!;
  if (days === null) return { to };
  return { from: isoDay(new Date(now.getTime() - days * 86_400_000)), to };
}

export function TransactionsScreen({
  focus,
  dataRevision = 0,
}: {
  focus?: TxFocus | null;
  dataRevision?: number;
}) {
  const { categoryColor } = useTheme();

  const [period, setPeriod] = useState<PeriodKey>('30d');
  const [accountId, setAccountId] = useState('all');
  const [category, setCategory] = useState('all');
  const [accounts, setAccounts] = useState<Account[]>([]);
  /**
   * null while loading and after a refusal, and never `[]` for either: an empty list
   * reads "No transactions in the selected period".
   */
  const [txs, setTxs] = useState<Transaction[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<Transaction | null>(null);
  const [saving, setSaving] = useState(false);
  const [savingOwner, setSavingOwner] = useState<MutationOwner | null>(null);
  const [mutationError, setMutationError] = useState<{ owner: MutationOwner; message: string } | null>(null);
  const [actionHost, setActionHost] = useState<HTMLDivElement | null>(null);
  const [refreshingSelected, setRefreshingSelected] = useState(false);
  const [ruleEditor, setRuleEditor] = useState<'transfer' | 'category' | null>(null);
  const [ruleDirty, setRuleDirty] = useState(false);
  const transferButton = useRef<HTMLButtonElement>(null);
  const categoryButton = useRef<HTMLButtonElement>(null);
  const selectedRef = useRef<Transaction | null>(null);
  selectedRef.current = selected;
  const selectedRevision = useRef(dataRevision);
  const [sources, setSources] = useState<IncomeSourceDef[] | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [sourceLoadAttempt, setSourceLoadAttempt] = useState(0);
  const loadGeneration = useRef(0);
  useEffect(() => {
    api.accounts(true).then(setAccounts).catch(() => {});
  }, []);
  useEffect(() => {
    let live = true;
    setSources(null);
    setSourceError(null);
    api.incomeSources().then((next) => {
      if (live) setSources(next);
    }).catch((caught) => {
      if (live) setSourceError((caught as Error).message);
    });
    return () => {
      live = false;
    };
  }, [dataRevision, sourceLoadAttempt]);

  useEffect(() => {
    if (selectedRevision.current === dataRevision) return;
    selectedRevision.current = dataRevision;
    const current = selectedRef.current;
    if (!current) return;
    let live = true;
    setRuleEditor(null);
    setRefreshingSelected(true);
    setError(null);
    api.transaction(current.id).then((next) => {
      if (live && selectedRef.current?.id === current.id) setSelected(next);
    }).catch((caught) => {
      if (!live || selectedRef.current?.id !== current.id) return;
      setSelected(null);
      setRuleEditor(null);
      setError(`Couldn’t refresh the open transaction: ${(caught as Error).message}`);
    }).finally(() => {
      if (live) setRefreshingSelected(false);
    });
    return () => {
      live = false;
    };
  }, [dataRevision]);

  const busy = saving || refreshingSelected;
  const editor = useEditorSession({
    open: selected !== null, dirty: ruleEditor === 'category' && ruleDirty, busy, busyHoldsNavigation: false,
    onClose: () => setSelected(null), onNavigationDiscard: () => setRuleEditor(null),
  });

  /**
   * An arrival with a `focus` asks for all of one account's rows, so the category filter
   * goes back to every category and the period opens at the widest this screen offers —
   * landing on whatever period was set would hide most of what the arrival asked for.
   */
  useEffect(() => {
    if (!focus) return;
    setAccountId(focus.accountId);
    setCategory('all');
    setPeriod(PERIODS[PERIODS.length - 1].key);
  }, [focus]);

  const sourceById = (id?: IncomeSource) => sources?.find((s) => s.id === id);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    try {
      setError(null);
      setTxs(null);
      const { from, to } = periodBounds(period);
      const next = await api.transactions({
        from,
        to,
        accountId: accountId === 'all' ? undefined : accountId,
        category: category === 'all' ? undefined : category,
        // an unbounded window can exceed the endpoint's default limit, and a cut answer
        // says nothing about the cut, as `web/src/SPEC.md` says under *Accounts and
        // statements, as the client handles them*. Tied to the missing lower bound
        // rather than to a key, so a later arm cannot inherit that silently.
        limit: from === undefined ? 5000 : undefined,
      });
      if (generation === loadGeneration.current) setTxs(next);
    } catch (e) {
      if (generation !== loadGeneration.current) return;
      // this list is filtered: rows kept from before a refused reload would sit
      // under a filter they were never an answer to.
      setTxs(null);
      setError((e as Error).message);
    }
  }, [period, accountId, category, dataRevision]);

  useEffect(() => {
    load();
  }, [load]);

  const accountOptions = useMemo(
    () => {
      const visible = accounts.filter((a) => !a.hidden);
      const selectedAccount = accounts.find((a) => a.id === accountId);
      return [
        { key: 'all', label: 'All accounts' },
        ...visible.map((a) => ({ key: a.id, label: a.name })),
        ...(accountId !== 'all' && !visible.some((a) => a.id === accountId)
          ? [{ key: accountId, label: selectedAccount?.name ?? 'Selected account' }]
          : []),
      ];
    },
    [accounts, accountId],
  );
  const categoryOptions = useMemo(
    () => [
      { key: 'all', label: 'All categories' },
      ...CATEGORIES.map((c) => ({ key: c, label: categoryLabel(c) })),
    ],
    [],
  );
  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name;

  /**
   * A decision taken when a PATCH settles cannot read the filters the handler was
   * created under: by then they may not be the filters the list in state answers.
   */
  const currentCategory = useRef(category);
  currentCategory.current = category;
  const currentLoad = useRef(load);
  currentLoad.current = load;

  /** Transfer flag: null hands the decision back to the backend's auto-detection. */
  const applyTransfer = async (tx: Transaction, value: boolean | null) => {
    if (busy) return;
    setSaving(true);
    setSavingOwner('transfer');
    setMutationError(null);
    try {
      const updated = await api.setTransfer(tx.id, value);
      setTxs((list) => list?.map((t) => (t.id === updated.id ? updated : t)) ?? null);
      setSelected(updated);
    } catch (e) {
      setMutationError({ owner: 'transfer', message: (e as Error).message });
    } finally {
      setSaving(false);
      setSavingOwner(null);
    }
  };

  /** Manual income source: null hands the decision back to auto-detection. */
  const applySource = async (tx: Transaction, source: IncomeSource | null) => {
    if (busy) return;
    setSaving(true);
    setSavingOwner('income source');
    setMutationError(null);
    try {
      const updated = await api.setIncomeSource(tx.id, source);
      setTxs((list) => list?.map((t) => (t.id === updated.id ? updated : t)) ?? null);
      setSelected(updated);
    } catch (e) {
      setMutationError({ owner: 'income source', message: (e as Error).message });
    } finally {
      setSaving(false);
      setSavingOwner(null);
    }
  };

  const applyOneOff = async (tx: Transaction, value: boolean) => {
    if (busy) return;
    setSaving(true);
    setSavingOwner('one-off');
    setMutationError(null);
    try {
      const updated = await api.setOneOff(tx.id, value);
      setTxs((list) => list?.map((t) => (t.id === updated.id ? updated : t)) ?? null);
      setSelected(updated);
    } catch (e) {
      setMutationError({ owner: 'one-off', message: (e as Error).message });
    } finally {
      setSaving(false);
      setSavingOwner(null);
    }
  };

  /**
   * null hands it back to auto-detection. Clicking the category the row already has is
   * not a no-op — it pins the row against any rule.
   */
  const applyCategory = async (tx: Transaction, next: Category | null) => {
    if (busy) return;
    setSaving(true);
    setSavingOwner('category');
    setMutationError(null);
    try {
      setNotice(null);
      const updated = await api.setCategory(tx.id, next);
      if (tx.category === 'support' || updated.category === 'support') {
        await currentLoad.current();
      } else {
        const selectedCategory = currentCategory.current;
        const stays = selectedCategory === 'all' || updated.category === selectedCategory;
        setTxs((list) => {
          if (list === null) return null;
          if (!stays) return list.filter((t) => t.id !== updated.id);
          if (list.some((t) => t.id === updated.id)) return list.map((t) => t.id === updated.id ? updated : t);
          return [...list, updated].sort((a, b) => b.date.localeCompare(a.date));
        });
      }
      setSelected(updated);
    } catch (e) {
      setMutationError({ owner: 'category', message: (e as Error).message });
    } finally {
      setSaving(false);
      setSavingOwner(null);
    }
  };

  const returnToTransaction = () => {
    const button = ruleEditor === 'category' ? categoryButton : transferButton;
    setRuleEditor(null);
    requestAnimationFrame(() => button.current?.focus());
  };

  const ruleApplied = async (updated: Transaction, message: string) => {
    await currentLoad.current();
    setSelected(updated);
    setNotice(message);
    editor.finish(returnToTransaction);
  };

  const mutationFeedback = (owner: MutationOwner) => (
    <>
      {savingOwner === owner && <Notice role="status">Saving {owner}…</Notice>}
      {mutationError?.owner === owner && <Notice tone="error" role="alert">Error: {mutationError.message}</Notice>}
    </>
  );
  const previewActions = (actions: ReactNode) => actionHost ? createPortal(actions, actionHost) : null;

  return (
    <div className="screen-inner page-wide transactions-screen">
      <PageHeader title="Transactions" />
      <div className="transaction-filters">
        <TransactionFilter
          label="Period"
          options={PERIODS.map((p) => ({ key: p.key, label: p.label }))}
          selected={period}
          onSelect={(key) => setPeriod(key as PeriodKey)}
        />
        <TransactionFilter label="Account" options={accountOptions} selected={accountId} onSelect={setAccountId} />
        <TransactionFilter label="Category" options={categoryOptions} selected={category} onSelect={setCategory} />
      </div>

      <div>
        {!selected && error && <Notice tone="error" role="alert" remedy={
          <Button type="button" variant="secondary" size="compact" onClick={load}>Retry transactions</Button>
        }>Error: {error}</Notice>}
        {!selected && mutationError && <Notice tone="error" role="alert">Couldn’t save {mutationError.owner}: {mutationError.message}</Notice>}
        {!selected && sourceError && <Notice tone="error" role="alert" remedy={
          <Button type="button" variant="secondary" size="compact" onClick={() => setSourceLoadAttempt((value) => value + 1)}>Retry income sources</Button>
        }>Couldn’t load income sources: {sourceError}</Notice>}
        {!selected && notice && <Notice role="status">{notice}</Notice>}
      </div>
      {txs === null && !error && <Notice placement="content" role="status">Loading transactions…</Notice>}

      {txs?.map((item) => {
        // hidden while the Account filter already states the answer; undefined while the
        // accounts load is outstanding or was refused, and the separator sits inside
        // the conditional so neither leaves a dangling middot
        const account = accountId === 'all' ? accountName(item.accountId) : undefined;
        const source = sourceById(item.incomeSource);
        return (
          <button
            key={item.id}
            type="button"
            className="row transaction-record"
            onClick={() => {
              setRuleEditor(null);
              setNotice(null);
              setError(null);
              setMutationError(null);
              setSelected(item);
            }}
          >
            <span className="dot" style={{ background: categoryColor(item.category) }} />
            <span className="row-main">
              <span className={`row-title${item.transfer ? ' muted-strike' : ''}`}>
                {item.displayDescription ?? (item.description || '(no description)')}
              </span>
              <span className="row-sub transaction-record__context">
                <span>
                  {fmtDate(item.date)} · {categoryLabel(item.category)}
                  {account ? ` · ${account}` : ''}
                </span>
                {item.transfer && <span className="badge">transfer</span>}
                {item.refund && <span className="badge">refund</span>}
                {item.oneOff && <span className="badge">one-off</span>}
                {!item.transfer && source?.kind === 'external' && (
                  <span className="badge">{source.label}</span>
                )}
              </span>
            </span>
            <span
              className={`row-value${item.transfer ? ' muted-strike' : ''}${item.amount > 0 && !item.refund && !item.transfer ? ' transaction-value--income' : ''}`}
            >
              {item.amount > 0 ? '+' : ''}
              {fmtMoney(item.amount, item.currency)}
            </span>
          </button>
        );
      })}

      {txs !== null && txs.length === 0 && (
        <Notice placement="content">No transactions in the selected period.</Notice>
      )}

      <Sheet
        open={selected !== null}
        onClose={editor.requestClose}
        guard={editor.guard}
        position="bottom"
        pattern={ruleEditor ? 'long-editor' : 'short-editor'}
        stepKey={ruleEditor ?? 'transaction'}
        busy={busy}
        restoreFocus={() => document.querySelector<HTMLElement>('.screen:not([hidden]) h1')}
        title={ruleEditor === 'transfer' ? 'Transfer rules' : ruleEditor === 'category' ? 'Apply category' : 'Transaction'}
        header={!ruleEditor && selected ? <h2 className="sheet-title">{selected.displayDescription ?? (selected.description || '(no description)')}</h2> : undefined}
        footer={ruleEditor ? <div ref={setActionHost} /> : <FormActions completion={
          <Button type="button" variant="secondary" size="touch" aria-disabled={busy} onClick={editor.requestClose}>Close</Button>
        } />}
      >
        {selected && ruleEditor === 'category' ? (
          <CategoryRuleEditor
            transaction={selected}
            accounts={accounts}
            onBack={() => editor.request(returnToTransaction)}
            onBusyChange={setSaving}
            onDraftChange={setRuleDirty}
            onApplied={ruleApplied}
            renderActions={previewActions}
          />
        ) : selected && ruleEditor === 'transfer' ? (
          <TransferRuleEditor
            transaction={selected}
            accountName={accountName(selected.accountId) ?? 'This account'}
            onBack={returnToTransaction}
            onBusyChange={setSaving}
            onApplied={ruleApplied}
            renderActions={previewActions}
          />
        ) : selected && (
          <>
            <div className={`sheet-amount transaction-detail__amount${selected.amount > 0 && !selected.refund && !selected.transfer ? ' transaction-value--income' : ''}`}>
              {selected.amount > 0 ? '+' : ''}
              {fmtMoney(selected.amount, selected.currency)}
            </div>
            <div className="sheet-meta">
              {fmtDate(selected.date)} · {categoryLabel(selected.category)}
              {selected.recurring ? ' · recurring' : ''}
            </div>
            <div className="sheet-meta">{accountName(selected.accountId)}</div>
            {selected.valueDate && selected.valueDate !== selected.date.slice(0, 10) && (
              <div className="sheet-meta">Value date: {fmtDate(selected.valueDate)}</div>
            )}
            {selected.displayDescription && (
              <details className="transaction-original">
                <summary>Original description</summary>
                <p>{selected.description}</p>
              </details>
            )}
            <div className="transaction-detail__flags">
              {selected.transfer && <span className="badge">transfer</span>}
              {selected.refund && <span className="badge">refund</span>}
              {selected.oneOff && <span className="badge">one-off</span>}
            </div>
            {refreshingSelected && <Notice role="status">Refreshing transaction…</Notice>}
            {error && <Notice tone="error" role="alert">Error: {error}</Notice>}
            {sourceError && <Notice tone="error" role="alert" remedy={
              <Button type="button" variant="secondary" size="compact" onClick={() => setSourceLoadAttempt((value) => value + 1)}>Retry income sources</Button>
            }>Couldn’t load income sources: {sourceError}</Notice>}
            {notice && <Notice role="status">{notice}</Notice>}

            {/* outside the description gate below it: a rule needs a pattern to hang on
                and an empty description is exactly the row no rule can ever reach */}
            <section className="transaction-detail__section" aria-labelledby="tx-category-label">
              <h3 id="tx-category-label" className="transaction-detail__label">Category</h3>
              <p className="transaction-detail__help">
                This transaction only
                {selected.categoryManual ? ' · set manually' : ' · auto-detected'}
              </p>
              {selected.amount > 0 && !selected.refund && !selected.transfer && selected.category === 'support' && (
                <Notice role="status">Support counts as income, but not as earnings for income-based goals.</Notice>
              )}
              <div className="chip-wrap">
                {CATEGORIES.map((c) => (
                  <Button
                    type="button" variant="secondary" size="compact"
                    key={c}
                    className="transaction-choice"
                    aria-label={`${categoryLabel(c)}, this transaction only`}
                    aria-pressed={c === selected.category}
                    aria-disabled={busy}
                    onClick={() => applyCategory(selected, c)}
                  >
                    <span className="dot" style={{ background: categoryColor(c) }} />
                    {categoryLabel(c)}
                  </Button>
                ))}
              </div>
              {selected.categoryManual && (
                <Button type="button" variant="tertiary" size="compact" className="transaction-secondary-button"
                  aria-disabled={busy} onClick={() => applyCategory(selected, null)}>
                  Category: back to auto-detection
                </Button>
              )}
              {mutationFeedback('category')}
            </section>

            {selected.description.trim() !== '' && (
              <Button
                type="button" variant="secondary" size="touch"
                ref={categoryButton}
                className="transaction-rule-button"
                aria-disabled={busy || !CATEGORIES.includes(selected.category as Category)}
                onClick={() => setRuleEditor('category')}
              >
                Apply to similar transactions <span aria-hidden="true">›</span>
              </Button>
            )}

            <div className="switch-row">
              <label className="row-main" htmlFor="tx-transfer">
                <div className="transaction-detail__label">Transfer between own accounts</div>
              </label>
              <input
                id="tx-transfer"
                type="checkbox"
                className="switch"
                checked={selected.transfer}
                aria-disabled={busy}
                onChange={(e) => { if (!busy) applyTransfer(selected, e.target.checked); }}
              />
            </div>

            {selected.description.trim() !== '' && (
              <Button
                type="button" variant="secondary" size="touch"
                ref={transferButton}
                className="transaction-rule-button"
                aria-disabled={busy}
                onClick={() => setRuleEditor('transfer')}
              >
                Manage transfer rules <span aria-hidden="true">›</span>
              </Button>
            )}

            {selected.transferManual !== null && (
              <Button type="button" variant="tertiary" size="compact" className="transaction-secondary-button"
                aria-disabled={busy} onClick={() => applyTransfer(selected, null)}>Back to auto-detection</Button>
            )}
            {mutationFeedback('transfer')}

            {selected.amount < 0 && !selected.transfer && (
              <>
                <div className="switch-row">
                  <label className="row-main" htmlFor="tx-oneoff">
                    <div className="transaction-detail__label">One-off large purchase</div>
                  </label>
                  <input
                    id="tx-oneoff"
                    type="checkbox"
                    className="switch"
                    checked={selected.oneOff}
                    aria-disabled={busy}
                    onChange={(e) => { if (!busy) applyOneOff(selected, e.target.checked); }}
                  />
                </div>
                {mutationFeedback('one-off')}
              </>
            )}

            {selected.amount > 0 && !selected.refund && !selected.transfer && selected.category !== 'support' && (
              <section className="transaction-detail__section" aria-labelledby="tx-source-label">
                <h3 id="tx-source-label" className="transaction-detail__label">Income source</h3>
                <p className="transaction-detail__help">
                  Support does not count toward earnings goals. Manage income sources in Settings.
                  {selected.incomeSourceManual ? ' Set manually.' : ' Auto-detected.'}
                </p>
                {sources === null && !sourceError && <Notice role="status">Loading income sources…</Notice>}
                <div className="chip-wrap">
                  {(sources ?? []).map((o) => (
                    <Button
                      type="button" variant="secondary" size="compact"
                      key={o.id}
                      className="transaction-choice"
                      aria-pressed={selected.incomeSource === o.id}
                      aria-disabled={busy}
                      onClick={() => applySource(selected, o.id)}
                    >
                      {o.label}
                    </Button>
                  ))}
                </div>
                {selected.incomeSourceManual && (
                  <Button type="button" variant="tertiary" size="compact" className="transaction-secondary-button"
                    aria-disabled={busy} onClick={() => applySource(selected, null)}>Source: back to auto-detection</Button>
                )}
                {mutationFeedback('income source')}
              </section>
            )}
          </>
        )}
      </Sheet>
    </div>
  );
}
