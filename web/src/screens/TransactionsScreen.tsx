import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { CATEGORIES, Category, categoryLabel, categoryRuleCaption } from '../categories';
import { Chips } from '../components/Chips';
import { Sheet } from '../components/Sheet';
import { fmtDate, fmtMoney, isoDay } from '../format';
import { useTheme } from '../theme';
import {
  Account,
  IncomeSource,
  IncomeSourceDef,
  Transaction,
  TransferRuleWithMatches,
  TxFocus,
} from '../types';

/**
 * The window each chip names, carried on the entry rather than derived from the key a
 * second time — a label and the window under it cannot then drift apart. `days: null`
 * is unbounded, which is what keeps the Overview's "All transactions" link honest.
 */
const PERIODS = [
  { key: '7d', label: '7 days', days: 7 },
  { key: '30d', label: '30 days', days: 30 },
  { key: '90d', label: '90 days', days: 90 },
  { key: 'all', label: 'All', days: null },
] as const;

type PeriodKey = (typeof PERIODS)[number]['key'];

function periodBounds(p: PeriodKey): { from?: string; to: string } {
  const now = new Date();
  const to = isoDay(now);
  const { days } = PERIODS.find((x) => x.key === p)!;
  if (days === null) return { to };
  return { from: isoDay(new Date(now.getTime() - days * 86_400_000)), to };
}

export function TransactionsScreen({ focus }: { focus?: TxFocus | null }) {
  const { categoryColor } = useTheme();

  const [period, setPeriod] = useState<PeriodKey>('30d');
  const [accountId, setAccountId] = useState('all');
  const [category, setCategory] = useState('all');
  const [accounts, setAccounts] = useState<Account[]>([]);
  /** A failed request used to render as "No transactions in the selected period". */
  const [txs, setTxs] = useState<Transaction[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** What a category rule just did — read after the sheet that started it has closed. */
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<Transaction | null>(null);
  const [saving, setSaving] = useState(false);
  const [rules, setRules] = useState<TransferRuleWithMatches[]>([]);
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

  /**
   * Arrived from an account's "All transactions". The link says all of them, so the
   * other two filters are cleared as well and the period opens at the widest this
   * screen offers — landing on "this account, this calendar month" would be a link
   * that hides most of what it promised.
   */
  useEffect(() => {
    if (!focus) return;
    setAccountId(focus.accountId);
    setCategory('all');
    setPeriod(PERIODS[PERIODS.length - 1].key);
  }, [focus]);

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
          // an unbounded window can exceed the backend's default limit (1000), and it
          // truncates with nothing on the wire saying so. Tied to the missing lower
          // bound rather than to a key, so a later arm cannot inherit that silently.
          limit: from === undefined ? 5000 : undefined,
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
  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name;

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

  /**
   * The category filter as of the last render. A decision taken when a PATCH settles
   * cannot read the chip the handler was created under: by then it may not be the chip
   * the list in state answers.
   */
  const currentCategory = useRef(category);
  currentCategory.current = category;

  /**
   * The caption sits above the list, and the row a rule is built from is often one the
   * reader scrolled down to reach — so the sentence this screen keeps alive past the
   * sheet renders a screenful or more above the viewport unless it is brought back.
   */
  const noticeRef = useRef<HTMLDivElement>(null);

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
   * This row's category and no other's; null hands it back to auto-detection. Clicking
   * the category the row already has is not a no-op — it pins the row against any rule.
   *
   * A row that no longer answers the category chip leaves the list, and the sheet goes
   * with it: the alternative is a sheet open on a row the list does not contain, where
   * a second pick lands on nothing and the row is gone until a chip is touched.
   */
  const applyCategory = async (tx: Transaction, next: Category | null) => {
    setSaving(true);
    try {
      setError(null);
      setNotice(null);
      const updated = await api.setCategory(tx.id, next);
      const chip = currentCategory.current;
      const stays = chip === 'all' || updated.category === chip;
      setTxs((list) =>
        list === null
          ? null
          : stays
            ? list.map((t) => (t.id === updated.id ? updated : t))
            : list.filter((t) => t.id !== updated.id),
      );
      setSelected(stays ? updated : null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  /**
   * The group: a rule "description contains <pattern> -> category" + a full base
   * recompute on the backend, so the list is reloaded in full.
   *
   * The caption is the reason the answer is kept. A rule cannot move a row whose
   * category was set by hand, so a user who corrected three rows and then re-tagged
   * the group watches three refuse to move; `overridden` is the only explanation there
   * is, and it goes on the screen because this function closes the sheet.
   */
  const applyCategoryRule = async (next: Category) => {
    const pattern = catPattern.trim();
    if (!pattern) return;
    setSaving(true);
    try {
      setError(null);
      setNotice(null);
      const res = await api.addCategoryRule({ pattern }, next);
      await load();
      setNotice(categoryRuleCaption(res.rule.pattern, next, res));
      setSelected(null);
      setCatPicker(false);
      // the wrapper is unconditional, so it is in the DOM before the sentence paints
      // and this needs no ordering against the commit
      noticeRef.current?.scrollIntoView({ block: 'nearest' });
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

      <div aria-live="polite" ref={noticeRef}>
        {error && <p className="error">Error: {error}</p>}
        {notice && <p className="hint">{notice}</p>}
      </div>

      {txs?.map((item) => {
        // hidden while the Account chip already states the answer; undefined while the
        // accounts load is outstanding or was refused, and the separator sits inside
        // the conditional so neither leaves a dangling middot
        const account = accountId === 'all' ? accountName(item.accountId) : undefined;
        return (
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
                  {account ? ` · ${account}` : ''}
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
        );
      })}

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

            {/* this row alone. Outside the description gate below it: a rule needs a
                pattern to hang on and an empty description is exactly the row no rule
                can ever reach */}
            <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--ink-grid)' }}>
              <div className="switch-label">Category</div>
              <div className="switch-hint">
                This transaction only
                {selected.categoryManual ? ' · set manually' : ' · auto-detected'}
              </div>
              <div className="chip-wrap">
                {CATEGORIES.map((c) => (
                  <button
                    key={c}
                    className="chip-cat"
                    aria-label={`${categoryLabel(c)}, this transaction only`}
                    aria-pressed={c === selected.category}
                    disabled={saving}
                    onClick={() => applyCategory(selected, c)}
                  >
                    <span className="dot" style={{ background: categoryColor(c) }} />
                    {categoryLabel(c)}
                  </button>
                ))}
              </div>
              {selected.categoryManual && (
                <button
                  className="btn-link"
                  disabled={saving}
                  onClick={() => applyCategory(selected, null)}
                >
                  Category: back to auto-detection
                </button>
              )}
            </div>

            {/* the group: a rule by description substring + base recompute */}
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
                          aria-label={`${categoryLabel(c)}, every transaction whose description contains this text`}
                          disabled={saving || !catPattern.trim()}
                          onClick={() => applyCategoryRule(c)}
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
                  checked={selected.oneOff}
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
                  Support isn't counted as your own earnings on the Goal screen, where these
                  sources are added and renamed
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
