import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { CATEGORIES, categoryLabel } from '../categories';
import { Chips } from '../components/Chips';
import { Sheet } from '../components/Sheet';
import { fmtDate, fmtMoney, isoDay } from '../format';
import { useTheme } from '../theme';
import { Account, IncomeSource, IncomeSourceDef, Transaction, TransferRule } from '../types';

type PeriodKey = 'month' | '30d' | '90d' | 'year';

const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: 'month', label: 'This month' },
  { key: '30d', label: '30 days' },
  { key: '90d', label: '90 days' },
  { key: 'year', label: 'Year' },
];

function periodBounds(p: PeriodKey): { from: string; to: string } {
  const now = new Date();
  const to = isoDay(now);
  if (p === 'month') {
    return { from: isoDay(new Date(now.getFullYear(), now.getMonth(), 1)), to };
  }
  if (p === 'year') {
    return { from: isoDay(new Date(now.getFullYear() - 1, now.getMonth(), now.getDate())), to };
  }
  const days = p === '30d' ? 30 : 90;
  return { from: isoDay(new Date(now.getTime() - days * 86_400_000)), to };
}

export function TransactionsScreen() {
  const { categoryColor } = useTheme();

  const [period, setPeriod] = useState<PeriodKey>('month');
  const [accountId, setAccountId] = useState('all');
  const [category, setCategory] = useState('all');
  const [accounts, setAccounts] = useState<Account[]>([]);
  /** A failed request used to render as "No transactions in the selected period". */
  const [txs, setTxs] = useState<Transaction[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Transaction | null>(null);
  const [saving, setSaving] = useState(false);
  const [rules, setRules] = useState<TransferRule[]>([]);
  /** income source catalog — chips in the sheet and badges in the list */
  const [sources, setSources] = useState<IncomeSourceDef[]>([]);
  /** category picker open in the sheet */
  const [catPicker, setCatPicker] = useState(false);
  /**
   * The rule's pattern, editable. Prefilled with the full description, but banks
   * append a changing part to many lines — a month in a rent reference, a contract
   * number — and a rule built from the whole string would then match that one
   * transaction only. Trimming it down to the stable part is the entire point.
   */
  const [catPattern, setCatPattern] = useState('');

  const loadRules = useCallback(() => {
    api.transferRules().then(setRules).catch(() => {});
  }, []);

  useEffect(() => {
    api.accounts().then(setAccounts).catch(() => {});
    api.incomeSources().then(setSources).catch(() => {});
    loadRules();
  }, [loadRules]);

  const sourceById = (id?: IncomeSource) => sources.find((s) => s.id === id);

  const load = useCallback(async () => {
    try {
      setError(null);
      const { from, to } = periodBounds(period);
      setTxs(
        await api.transactions({
          from,
          to,
          accountId: accountId === 'all' ? undefined : accountId,
          category: category === 'all' ? undefined : category,
          // a year can easily exceed the backend's default limit (1000)
          limit: period === 'year' ? 5000 : undefined,
        }),
      );
    } catch (e) {
      // Overview's load takes no arguments, so its stale list still answers the same
      // question. This one is filtered: rows kept from before a refused reload sit
      // under a chip they were never an answer to.
      setTxs(null);
      setError((e as Error).message);
    }
  }, [period, accountId, category]);

  useEffect(() => {
    load();
  }, [load]);

  const accountOptions = useMemo(
    () => [
      { key: 'all', label: 'All accounts' },
      ...accounts.map((a) => ({ key: a.id, label: a.name })),
    ],
    [accounts],
  );
  const categoryOptions = useMemo(
    () => [
      { key: 'all', label: 'All categories' },
      ...CATEGORIES.map((c) => ({ key: c, label: categoryLabel(c) })),
    ],
    [],
  );
  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? id;

  /**
   * How many of the loaded transactions the pattern covers. Counted on the client and
   * over the selected period only — it isn't the rule's true reach, just immediate
   * feedback that trimming the pattern widened the match from one row to the group.
   */
  const patternMatches = useMemo(() => {
    const p = catPattern.trim().toLowerCase();
    if (!p) return 0;
    return (txs ?? []).filter((t) => t.description.toLowerCase().includes(p)).length;
  }, [catPattern, txs]);

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

  /** "One-off large purchase" flag — amortized in the goal calculation. */
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
   * Changing the category = a rule "description contains <pattern> -> category" + a
   * full base recompute on the backend, so the list is reloaded in full.
   */
  const applyCategory = async (next: string) => {
    const pattern = catPattern.trim();
    if (!pattern) return;
    setSaving(true);
    try {
      setError(null);
      await api.addCategoryRule({ pattern }, next);
      await load();
      setSelected(null);
      setCatPicker(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  /** The rule for the selected transaction, if one already exists. */
  const ruleFor = (tx: Transaction) =>
    rules.find((r) => r.description === tx.description && r.accountId === tx.accountId);

  /**
   * "All like this on this account": the rule re-tags the whole history on the
   * backend, so we reload the list in full rather than editing a single row.
   */
  const applyRule = async (tx: Transaction, enabled: boolean) => {
    setSaving(true);
    try {
      setError(null);
      const existing = ruleFor(tx);
      if (enabled) {
        await api.addTransferRule(tx.id);
      } else if (existing) {
        await api.deleteTransferRule(existing.id);
      }
      loadRules();
      await load();
      setSelected(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="screen-inner">
      <h1 className="title">Transactions</h1>
      <Chips
        label="Period"
        options={PERIODS.map((p) => ({ key: p.key, label: p.label }))}
        selected={period}
        onSelect={(k) => setPeriod(k as PeriodKey)}
      />
      <Chips label="Account" options={accountOptions} selected={accountId} onSelect={setAccountId} />
      <Chips label="Category" options={categoryOptions} selected={category} onSelect={setCategory} />

      {error && <p className="error">Error: {error}</p>}

      {txs?.map((item) => (
        <button
          key={item.id}
          className="row"
          style={{ gap: 10 }}
          onClick={() => {
            setCatPicker(false);
            setCatPattern(item.description);
            setSelected(item);
          }}
        >
          <span className="dot" style={{ background: categoryColor(item.category) }} />
          <span className="row-main">
            <span className={`row-title${item.transfer ? ' muted-strike' : ''}`}>
              {item.description || '(no description)'}
            </span>
            <span
              className="row-sub"
              style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}
            >
              <span>
                {fmtDate(item.date)} · {categoryLabel(item.category)}
              </span>
              {item.transfer && <span className="badge">transfer</span>}
              {item.refund && <span className="badge">refund</span>}
              {item.oneOff && <span className="badge">one-off</span>}
              {/* outside help (family, stipend...) — a badge with the source name */}
              {!item.transfer && sourceById(item.incomeSource)?.kind === 'external' && (
                <span className="badge">{sourceById(item.incomeSource)!.label}</span>
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
      ))}

      {txs !== null && txs.length === 0 && (
        <p className="empty">No transactions in the selected period.</p>
      )}

      <Sheet
        open={selected !== null}
        onClose={() => setSelected(null)}
        position="bottom"
        title="Transaction"
      >
        {selected && (
          <>
            <h2 className="sheet-title">{selected.description || '(no description)'}</h2>
            <div className="sheet-amount">
              {selected.amount > 0 ? '+' : ''}
              {fmtMoney(selected.amount, selected.currency)}
            </div>
            <div className="sheet-meta">
              {fmtDate(selected.date)} · {categoryLabel(selected.category)}
              {selected.recurring ? ' · recurring' : ''}
            </div>
            <div className="sheet-meta">{accountName(selected.accountId)}</div>

            {/* change category: a rule by description substring + base recompute */}
            {selected.description !== '' && (
              <div style={{ marginTop: 12 }}>
                <button
                  className="btn-link"
                  onClick={() => {
                    setCatPattern(selected.description);
                    setCatPicker((v) => !v);
                  }}
                >
                  {catPicker
                    ? 'Hide category picker'
                    : 'Change the category of transactions like this…'}
                </button>
                {catPicker && (
                  <>
                    <label className="setting-label" htmlFor="cat-pattern">
                      Apply to transactions whose description contains
                    </label>
                    <input
                      id="cat-pattern"
                      className="input"
                      value={catPattern}
                      onChange={(e) => setCatPattern(e.target.value)}
                      placeholder="part of the description"
                    />
                    <p className="hint" style={{ marginTop: 6 }}>
                      {catPattern.trim()
                        ? `Matches ${patternMatches} of the ${txs?.length ?? 0} loaded transactions.`
                        : 'Enter the part of the description that stays the same.'}
                      {' '}Banks often append a month or a contract number — trim it off and the
                      rule covers the whole group, this month and every one after.
                    </p>
                    <div className="chip-wrap">
                      {CATEGORIES.map((c) => (
                        <button
                          key={c}
                          className="chip-cat"
                          aria-pressed={c === selected.category}
                          disabled={saving || !catPattern.trim()}
                          onClick={() => applyCategory(c)}
                        >
                          <span className="dot" style={{ background: categoryColor(c) }} />
                          {categoryLabel(c)}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}

            <div className="switch-row">
              <label className="row-main" htmlFor="tx-transfer">
                <div className="switch-label">Transfer between own accounts</div>
                <div className="switch-hint">
                  Counted as neither income nor expense
                  {selected.transferManual === null ? ' · auto-detected' : ' · set manually'}
                </div>
              </label>
              <input
                id="tx-transfer"
                type="checkbox"
                className="switch"
                checked={selected.transfer}
                disabled={saving}
                onChange={(e) => applyTransfer(selected, e.target.checked)}
              />
            </div>

            {selected.description !== '' && (
              <div className="switch-row">
                <label className="row-main" htmlFor="tx-rule">
                  <div className="switch-label">
                    …and every "{selected.description}" on this account
                  </div>
                  <div className="switch-hint">
                    {ruleFor(selected)
                      ? `Rule on · transactions tagged: ${ruleFor(selected)!.matches}`
                      : 'The rule marks the whole history of such transactions, and every new one, as a transfer'}
                  </div>
                </label>
                <input
                  id="tx-rule"
                  type="checkbox"
                  className="switch"
                  checked={ruleFor(selected) !== undefined}
                  disabled={saving}
                  onChange={(e) => applyRule(selected, e.target.checked)}
                />
              </div>
            )}

            {/* expense: "one-off" flag — keeps it from inflating average spending */}
            {selected.amount < 0 && !selected.transfer && (
              <div className="switch-row">
                <label className="row-main" htmlFor="tx-oneoff">
                  <div className="switch-label">One-off large purchase</div>
                  <div className="switch-hint">
                    In the goal calculation it's spread over 12 months instead of landing in one
                  </div>
                </label>
                <input
                  id="tx-oneoff"
                  type="checkbox"
                  className="switch"
                  checked={selected.oneOff ?? false}
                  disabled={saving}
                  onChange={(e) => applyOneOff(selected, e.target.checked)}
                />
              </div>
            )}

            {/* income: the source — the Goal screen depends on it */}
            {selected.amount > 0 && !selected.refund && !selected.transfer && (
              <div
                style={{
                  marginTop: 20,
                  paddingTop: 16,
                  borderTop: '1px solid var(--ink-grid)',
                }}
              >
                <div className="switch-label">Income source</div>
                <div className="switch-hint">
                  Outside help isn't counted as your own earnings on the Goal screen
                  {selected.incomeSourceManual ? ' · set manually' : ' · auto-detected'}
                </div>
                <div className="chip-wrap">
                  {sources.map((o) => (
                    <button
                      key={o.id}
                      className="chip"
                      aria-pressed={selected.incomeSource === o.id}
                      disabled={saving}
                      onClick={() => applySource(selected, o.id)}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
                {selected.incomeSourceManual && (
                  <button
                    className="btn-link"
                    disabled={saving}
                    onClick={() => applySource(selected, null)}
                  >
                    Source: back to auto-detection
                  </button>
                )}
              </div>
            )}

            {selected.transferManual !== null && (
              <button
                className="btn-link"
                disabled={saving}
                onClick={() => applyTransfer(selected, null)}
              >
                Back to auto-detection
              </button>
            )}

            <button
              style={{
                display: 'block',
                width: '100%',
                marginTop: 12,
                padding: '12px 0',
                fontSize: 15,
                fontWeight: 600,
                color: 'var(--ink-secondary)',
              }}
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
