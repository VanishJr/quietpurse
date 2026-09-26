import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { CATEGORIES, Category, categoryLabel } from '../categories';
import { Sheet } from '../components/Sheet';
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
  return (
    <label className="transaction-filter">
      <span>{label}</span>
      <select value={selected} onChange={(event) => onSelect(event.target.value)}>
        {options.map((option) => (
          <option key={option.key} value={option.key}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
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
  const [refreshingSelected, setRefreshingSelected] = useState(false);
  const [ruleEditor, setRuleEditor] = useState<'transfer' | 'category' | null>(null);
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

  /**
   * An arrival with a `focus` asks for all of one account's rows, so the other two
   * filters are cleared as well and the period opens at the widest this screen offers —
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
   * A decision taken when a PATCH settles cannot read the selection the handler was
   * created under: by then it may not be the selection the list in state answers.
   */
  const currentCategory = useRef(category);
  currentCategory.current = category;
  const currentLoad = useRef(load);
  currentLoad.current = load;

  /** Transfer flag: null hands the decision back to the backend's auto-detection. */
  const applyTransfer = async (tx: Transaction, value: boolean | null) => {
    setSaving(true);
    try {
      setError(null);
      const updated = await api.setTransfer(tx.id, value);
      setTxs((list) => list?.map((t) => (t.id === updated.id ? updated : t)) ?? null);
      setSelected(updated);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  /** Manual income source: null hands the decision back to auto-detection. */
  const applySource = async (tx: Transaction, source: IncomeSource | null) => {
    setSaving(true);
    try {
      setError(null);
      const updated = await api.setIncomeSource(tx.id, source);
      setTxs((list) => list?.map((t) => (t.id === updated.id ? updated : t)) ?? null);
      setSelected(updated);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const applyOneOff = async (tx: Transaction, value: boolean) => {
    setSaving(true);
    try {
      setError(null);
      const updated = await api.setOneOff(tx.id, value);
      setTxs((list) => list?.map((t) => (t.id === updated.id ? updated : t)) ?? null);
      setSelected(updated);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  /**
   * null hands it back to auto-detection. Clicking the category the row already has is
   * not a no-op — it pins the row against any rule.
   */
  const applyCategory = async (tx: Transaction, next: Category | null) => {
    setSaving(true);
    try {
      setError(null);
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
      setError((e as Error).message);
    } finally {
      setSaving(false);
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
    returnToTransaction();
  };

  return (
    <div className="screen-inner">
      <h1 className="title">Transactions</h1>
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

      <div aria-live="polite">
        {!selected && error && <p className="error">Error: {error}</p>}
        {!selected && sourceError && (
          <p className="error" role="alert">
            Couldn’t load income sources: {sourceError}{' '}
            <button
              type="button"
              className="btn-link"
              onClick={() => setSourceLoadAttempt((value) => value + 1)}
            >
              Retry income sources
            </button>
          </p>
        )}
        {!selected && notice && <p className="hint">{notice}</p>}
      </div>

      {txs?.map((item) => {
        // hidden while the Account filter already states the answer; undefined while the
        // accounts load is outstanding or was refused, and the separator sits inside
        // the conditional so neither leaves a dangling middot
        const account = accountId === 'all' ? accountName(item.accountId) : undefined;
        const source = sourceById(item.incomeSource);
        return (
          <button
            key={item.id}
            className="row"
            style={{ gap: 10 }}
            onClick={() => {
              setRuleEditor(null);
              setNotice(null);
              setError(null);
              setSelected(item);
            }}
          >
            <span className="dot" style={{ background: categoryColor(item.category) }} />
            <span className="row-main">
              <span className={`row-title${item.transfer ? ' muted-strike' : ''}`}>
                {item.displayDescription ?? (item.description || '(no description)')}
              </span>
              <span
                className="row-sub"
                style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}
              >
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
              className={`row-value${item.transfer ? ' muted-strike' : ''}`}
              style={{ fontSize: 14, color: item.amount > 0 ? 'var(--ink-good)' : undefined }}
            >
              {item.amount > 0 ? '+' : ''}
              {fmtMoney(item.amount, item.currency)}
            </span>
          </button>
        );
      })}

      {txs !== null && txs.length === 0 && (
        <p className="empty">No transactions in the selected period.</p>
      )}

      <Sheet
        open={selected !== null}
        onClose={() => { if (!busy) setSelected(null); }}
        position="bottom"
        title={ruleEditor === 'transfer' ? 'Transfer rules' : ruleEditor === 'category' ? 'Apply category' : 'Transaction'}
      >
        {selected && ruleEditor === 'category' ? (
          <CategoryRuleEditor
            transaction={selected}
            accounts={accounts}
            onBack={returnToTransaction}
            onBusyChange={setSaving}
            onApplied={ruleApplied}
          />
        ) : selected && ruleEditor === 'transfer' ? (
          <TransferRuleEditor
            transaction={selected}
            accountName={accountName(selected.accountId) ?? 'This account'}
            onBack={returnToTransaction}
            onBusyChange={setSaving}
            onApplied={ruleApplied}
          />
        ) : selected && (
          <>
            <h2 className="sheet-title">{selected.displayDescription ?? (selected.description || '(no description)')}</h2>
            <div className="sheet-amount">
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
            {refreshingSelected && <p className="state-note" role="status">Refreshing transaction…</p>}
            {error && <p className="error" role="alert">Error: {error}</p>}
            {sourceError && (
              <p className="error" role="alert">
                Couldn’t load income sources: {sourceError}{' '}
                <button
                  type="button"
                  className="btn-link"
                  onClick={() => setSourceLoadAttempt((value) => value + 1)}
                >
                  Retry income sources
                </button>
              </p>
            )}
            {notice && <p className="hint" role="status">{notice}</p>}

            {/* outside the description gate below it: a rule needs a pattern to hang on
                and an empty description is exactly the row no rule can ever reach */}
            <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--ink-grid)' }}>
              <div className="switch-label">Category</div>
              <div className="switch-hint">
                This transaction only
                {selected.categoryManual ? ' · set manually' : ' · auto-detected'}
              </div>
              {selected.amount > 0 && !selected.refund && !selected.transfer && selected.category === 'support' && (
                <p className="hint" role="status" style={{ marginTop: 6 }}>
                  Support counts as income, but not as earnings for income-based goals.
                </p>
              )}
              <div className="chip-wrap">
                {CATEGORIES.map((c) => (
                  <button
                    key={c}
                    className="chip-cat"
                    aria-label={`${categoryLabel(c)}, this transaction only`}
                    aria-pressed={c === selected.category}
                    disabled={busy}
                    onClick={() => applyCategory(selected, c)}
                  >
                    <span className="dot" style={{ background: categoryColor(c) }} />
                    {categoryLabel(c)}
                  </button>
                ))}
              </div>
              {selected.categoryManual && (
                <button
                  className="btn-ghost transaction-secondary-button"
                  disabled={busy}
                  onClick={() => applyCategory(selected, null)}
                >
                  Category: back to auto-detection
                </button>
              )}
            </div>

            {selected.description.trim() !== '' && (
              <button
                ref={categoryButton}
                className="btn-ghost transaction-rule-button"
                disabled={busy || !CATEGORIES.includes(selected.category as Category)}
                onClick={() => setRuleEditor('category')}
              >
                Apply to similar transactions <span aria-hidden="true">›</span>
              </button>
            )}

            <div className="switch-row">
              <label className="row-main" htmlFor="tx-transfer">
                <div className="switch-label">Transfer between own accounts</div>
              </label>
              <input
                id="tx-transfer"
                type="checkbox"
                className="switch"
                checked={selected.transfer}
                disabled={busy}
                onChange={(e) => applyTransfer(selected, e.target.checked)}
              />
            </div>

            {selected.description.trim() !== '' && (
              <button
                ref={transferButton}
                className="btn-ghost transaction-rule-button"
                disabled={busy}
                onClick={() => setRuleEditor('transfer')}
              >
                Manage transfer rules <span aria-hidden="true">›</span>
              </button>
            )}

            {selected.amount < 0 && !selected.transfer && (
              <div className="switch-row">
                <label className="row-main" htmlFor="tx-oneoff">
                  <div className="switch-label">One-off large purchase</div>
                </label>
                <input
                  id="tx-oneoff"
                  type="checkbox"
                  className="switch"
                  checked={selected.oneOff}
                  disabled={busy}
                  onChange={(e) => applyOneOff(selected, e.target.checked)}
                />
              </div>
            )}

            {selected.amount > 0 && !selected.refund && !selected.transfer && selected.category !== 'support' && (
              <div
                style={{
                  marginTop: 20,
                  paddingTop: 16,
                  borderTop: '1px solid var(--ink-grid)',
                }}
              >
                <div className="switch-label">Income source</div>
                <div className="switch-hint">
                  Support does not count toward earnings goals. Manage income sources in Settings.
                  {selected.incomeSourceManual ? ' Set manually.' : ' Auto-detected.'}
                </div>
                <div className="chip-wrap">
                  {(sources ?? []).map((o) => (
                    <button
                      key={o.id}
                      className="chip"
                      aria-pressed={selected.incomeSource === o.id}
                      disabled={busy}
                      onClick={() => applySource(selected, o.id)}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
                {selected.incomeSourceManual && (
                  <button
                    className="btn-ghost transaction-secondary-button"
                    disabled={busy}
                    onClick={() => applySource(selected, null)}
                  >
                    Source: back to auto-detection
                  </button>
                )}
              </div>
            )}

            {selected.transferManual !== null && (
              <button
                className="btn-ghost transaction-secondary-button"
                disabled={busy}
                onClick={() => applyTransfer(selected, null)}
              >
                Back to auto-detection
              </button>
            )}

            <button
              disabled={busy}
              className="btn-ghost transaction-close-button"
              onClick={() => setSelected(null)}
            >
              Close
            </button>
          </>
        )}
      </Sheet>
    </div>
  );
}
