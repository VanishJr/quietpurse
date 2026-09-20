import { FormEvent, useEffect, useState } from 'react';
import { ApiError, api } from '../api';
import { CATEGORIES, categoryLabel } from '../categories';
import {
  GOAL_BASIS_DEFS,
  GOAL_INCOME_SCOPE_DEFS,
  GOAL_TYPE_DEFS,
  GOAL_TYPE_ORDER,
} from '../goals';
import type { Account, GoalCreate, GoalDetail, GoalType } from '../types';
import { Sheet } from './Sheet';

interface Props {
  goalId: string | null;
  onClose: () => void;
  onMissing?: () => void;
  onSaved: (goal: GoalDetail) => void;
}

interface CostDraft {
  key: number;
  label: string;
  monthly: string;
}

interface Draft {
  type: GoalType | null;
  name: string;
  targetDate: string;
  basis: 'essential-costs' | 'current-spending';
  bufferPct: string;
  windowMonths: string;
  hourlyRate: string;
  hoursPerWeek: string;
  costs: CostDraft[];
  coverageMonths: string;
  monthlyEssentials: string;
  accountIds: string[];
  accountId: string;
  target: string;
  targetDebt: string;
  targetPercent: string;
  incomeScope: 'own' | 'all';
  category: string;
  monthlyLimit: string;
  savedCurrency: string | null;
}

let nextCostKey = 1;
const cost = (label = '', monthly = ''): CostDraft => ({ key: nextCostKey++, label, monthly });

const emptyDraft = (): Draft => ({
  type: null,
  name: '',
  targetDate: '',
  basis: 'essential-costs',
  bufferPct: '10',
  windowMonths: '6',
  hourlyRate: '',
  hoursPerWeek: '',
  costs: [cost()],
  coverageMonths: '6',
  monthlyEssentials: '',
  accountIds: [],
  accountId: '',
  target: '',
  targetDebt: '0',
  targetPercent: '20',
  incomeScope: 'own',
  category: 'food',
  monthlyLimit: '',
  savedCurrency: null,
});

const draftOf = (goal: GoalDetail): Draft => {
  const draft = {
    ...emptyDraft(),
    type: goal.type,
    name: goal.name,
    targetDate: goal.targetDate ?? '',
    savedCurrency: goal.currency,
  };
  switch (goal.type) {
    case 'financial-independence':
      return {
        ...draft,
        basis: goal.basis,
        bufferPct: String(goal.bufferPct),
        windowMonths: String(goal.windowMonths),
        hourlyRate: goal.hourlyRate === null ? '' : String(goal.hourlyRate),
        hoursPerWeek: goal.hoursPerWeek === null ? '' : String(goal.hoursPerWeek),
        costs:
          goal.essentialCosts.length === 0
            ? [cost()]
            : goal.essentialCosts.map((item) => cost(item.label, String(item.monthly))),
      };
    case 'emergency-fund':
      return {
        ...draft,
        coverageMonths: String(goal.coverageMonths),
        monthlyEssentials: String(goal.monthlyEssentials),
        accountIds: goal.accountIds,
      };
    case 'savings-balance':
      return { ...draft, target: String(goal.target), accountIds: goal.accountIds };
    case 'debt-payoff':
      return { ...draft, accountId: goal.accountId, targetDebt: String(goal.targetDebt) };
    case 'monthly-income':
      return {
        ...draft,
        target: String(goal.target),
        incomeScope: goal.incomeScope,
        windowMonths: String(goal.windowMonths),
      };
    case 'savings-rate':
      return {
        ...draft,
        targetPercent: String(goal.targetPercent),
        incomeScope: goal.incomeScope,
        windowMonths: String(goal.windowMonths),
      };
    case 'category-spending-limit':
      return { ...draft, category: goal.category, monthlyLimit: String(goal.monthlyLimit) };
  }
};

const positive = (raw: string, label: string): { value?: number; error?: string } => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0
    ? { value }
    : { error: `${label} must be a positive number.` };
};

const whole = (
  raw: string,
  label: string,
  min: number,
  max: number,
): { value?: number; error?: string } => {
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max
    ? { value }
    : { error: `${label} must be a whole number from ${min} to ${max}.` };
};

const writeOf = (draft: Draft): { goal?: GoalCreate; error?: string } => {
  const name = draft.name.trim();
  if (!draft.type) return { error: 'Choose a goal type.' };
  if (!name) return { error: 'Name is required.' };
  const targetDate = draft.targetDate || null;
  switch (draft.type) {
    case 'financial-independence': {
      const buffer = Number(draft.bufferPct);
      if (!Number.isFinite(buffer) || buffer < 0 || buffer > 100) {
        return { error: 'Safety buffer must be from 0 to 100.' };
      }
      const window = whole(draft.windowMonths, 'Averaging period', 1, 24);
      if (window.error) return window;
      const items = draft.costs
        .map((item) => ({ ...item, label: item.label.trim() }))
        .filter((item) => item.label || item.monthly);
      const labels = items.map((item) => item.label.toLocaleLowerCase());
      if (labels.some((label) => !label)) return { error: 'Every cost needs a name.' };
      if (new Set(labels).size !== labels.length) return { error: 'Cost names must be unique.' };
      const essentialCosts: { label: string; monthly: number }[] = [];
      for (const item of items) {
        const amount = positive(item.monthly, `Monthly cost for ${item.label}`);
        if (amount.error) return amount;
        essentialCosts.push({ label: item.label, monthly: amount.value! });
      }
      if (draft.basis === 'essential-costs' && essentialCosts.length === 0) {
        return { error: 'Add at least one essential monthly cost.' };
      }
      const hourly: { value: number | null; error?: string } = draft.hourlyRate
        ? positive(draft.hourlyRate, 'Net hourly rate') as { value: number; error?: string }
        : { value: null };
      if (hourly.error) return { error: hourly.error };
      const hours: { value: number | null; error?: string } = draft.hoursPerWeek
        ? positive(draft.hoursPerWeek, 'Hours available per week') as { value: number; error?: string }
        : { value: null };
      if (hours.error) return { error: hours.error };
      return {
        goal: {
          type: draft.type,
          name,
          basis: draft.basis,
          bufferPct: buffer,
          windowMonths: window.value!,
          hourlyRate: hourly.value ?? null,
          hoursPerWeek: hours.value ?? null,
          essentialCosts,
        },
      };
    }
    case 'emergency-fund': {
      const coverage = whole(draft.coverageMonths, 'Coverage months', 1, 120);
      if (coverage.error) return coverage;
      const essentials = positive(draft.monthlyEssentials, 'Essential monthly amount');
      if (essentials.error) return essentials;
      if (draft.accountIds.length === 0) return { error: 'Choose at least one funding account.' };
      return {
        goal: {
          type: draft.type,
          name,
          targetDate,
          coverageMonths: coverage.value!,
          monthlyEssentials: essentials.value!,
          accountIds: draft.accountIds,
        },
      };
    }
    case 'savings-balance': {
      const target = positive(draft.target, 'Target amount');
      if (target.error) return target;
      if (draft.accountIds.length === 0) return { error: 'Choose at least one account.' };
      return { goal: { type: draft.type, name, targetDate, target: target.value!, accountIds: draft.accountIds } };
    }
    case 'debt-payoff': {
      const target = Number(draft.targetDebt);
      if (!Number.isFinite(target) || target < 0) return { error: 'Target remaining debt must be zero or more.' };
      if (!draft.accountId) return { error: 'Choose a debt account.' };
      return { goal: { type: draft.type, name, targetDate, accountId: draft.accountId, targetDebt: target } };
    }
    case 'monthly-income': {
      const target = positive(draft.target, 'Monthly target');
      if (target.error) return target;
      const window = whole(draft.windowMonths, 'Averaging period', 1, 24);
      if (window.error) return window;
      return { goal: { type: draft.type, name, target: target.value!, incomeScope: draft.incomeScope, windowMonths: window.value! } };
    }
    case 'savings-rate': {
      const target = positive(draft.targetPercent, 'Target percentage');
      if (target.error || target.value! > 100) return { error: 'Target percentage must be greater than 0 and at most 100.' };
      const window = whole(draft.windowMonths, 'Averaging period', 1, 24);
      if (window.error) return window;
      return { goal: { type: draft.type, name, targetPercent: target.value!, incomeScope: draft.incomeScope, windowMonths: window.value! } };
    }
    case 'category-spending-limit': {
      const limit = positive(draft.monthlyLimit, 'Monthly limit');
      if (limit.error) return limit;
      return { goal: { type: draft.type, name, category: draft.category, monthlyLimit: limit.value! } };
    }
  }
};

const WindowField = ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
  <label className="field">
    <span>Averaging period</span>
    <select className="input" value={value} onChange={(event) => onChange(event.target.value)}>
      {!['3', '6', '12'].includes(value) && <option value={value}>{value} months</option>}
      <option value="3">3 months</option>
      <option value="6">6 months</option>
      <option value="12">12 months</option>
    </select>
  </label>
);

export function GoalEditor({ goalId, onClose, onMissing = onClose, onSaved }: Props) {
  const open = goalId !== null;
  const editing = goalId !== null && goalId !== 'new';
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [baseCurrency, setBaseCurrency] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setSaving(false);
    setError(null);
    setLoadError(null);
    setAccounts([]);
    setBaseCurrency(null);
    setDraft(emptyDraft());
    void Promise.all([
      api.accounts(),
      api.appSettings(),
      editing ? api.goal(goalId) : Promise.resolve(null),
    ])
      .then(([loadedAccounts, settings, goal]) => {
        if (cancelled) return;
        setAccounts(loadedAccounts);
        setBaseCurrency(settings.baseCurrency);
        setDraft(goal ? draftOf(goal) : emptyDraft());
      })
      .catch((caught) => {
        if (cancelled) return;
        if (editing && caught instanceof ApiError && caught.status === 404) {
          onMissing();
          return;
        }
        setLoadError(`Couldn’t load goal: ${(caught as Error).message}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [editing, goalId, loadAttempt, onMissing, open]);

  const update = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const selectType = (type: GoalType) => {
    setError(null);
    update('type', type);
  };

  const returnToTypes = () => {
    setError(null);
    update('type', null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = writeOf(draft);
    if (!parsed.goal) {
      setError(parsed.error ?? 'Check the goal fields.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = editing
        ? await api.updateGoal(goalId, parsed.goal)
        : await api.createGoal(parsed.goal);
      onSaved(saved);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const selectedAvailableAccount = accounts.find((account) =>
    draft.accountIds.includes(account.id),
  );
  const hasUnavailableSelection = draft.accountIds.some(
    (id) => !accounts.some((account) => account.id === id),
  );
  const savingsCurrencyLock =
    draft.type === 'savings-balance'
      ? selectedAvailableAccount?.currency ??
        (hasUnavailableSelection ? draft.savedCurrency : null)
      : null;
  const selectedCurrency =
    draft.type === 'debt-payoff'
      ? accounts.find((account) => account.id === draft.accountId)?.currency ??
        draft.savedCurrency ??
        baseCurrency ??
        ''
      : draft.type === 'savings-balance' || draft.type === 'emergency-fund'
        ? selectedAvailableAccount?.currency ?? draft.savedCurrency ?? baseCurrency ?? ''
        : baseCurrency ?? '';

  const toggleAccount = (id: string) => {
    const selected = draft.accountIds.includes(id);
    const account = accounts.find((candidate) => candidate.id === id);
    if (
      !selected &&
      draft.type === 'savings-balance' &&
      savingsCurrencyLock !== null &&
      account?.currency !== savingsCurrencyLock
    ) {
      return;
    }
    update(
      'accountIds',
      selected
        ? draft.accountIds.filter((accountId) => accountId !== id)
        : [...draft.accountIds, id],
    );
  };

  const money = (label: string, key: 'monthlyEssentials' | 'target' | 'targetDebt' | 'monthlyLimit') => (
    <label className="field">
      <span>{label} ({selectedCurrency})</span>
      <input className="input" inputMode="decimal" value={draft[key]} onChange={(event) => update(key, event.target.value)} />
    </label>
  );

  const accountChecks = (eligible: Account[], currencyLock: string | null = null) => (
    <fieldset className="goal-account-list">
      <legend>Accounts</legend>
      {draft.accountIds
        .filter((id) => !eligible.some((account) => account.id === id))
        .map((id) => {
          const account = accounts.find((candidate) => candidate.id === id);
          return (
            <label key={id}>
              <input type="checkbox" checked onChange={() => toggleAccount(id)} />{' '}
              {account ? `${account.name} · ${account.currency} (not eligible)` : 'Unavailable account'}
            </label>
          );
        })}
      {eligible.map((account) => {
        const selected = draft.accountIds.includes(account.id);
        return (
          <label key={account.id}>
            <input
              type="checkbox"
              checked={selected}
              disabled={!selected && currencyLock !== null && account.currency !== currencyLock}
              onChange={() => toggleAccount(account.id)}
            />{' '}
            {account.name} · {account.currency}
          </label>
        );
      })}
      <p>Progress will be recalculated from the selected accounts.</p>
    </fieldset>
  );

  const fields = () => {
    switch (draft.type) {
      case 'financial-independence':
        return (
          <>
            <label className="field">
              <span>Target basis</span>
              <select className="input" value={draft.basis} onChange={(event) => update('basis', event.target.value as Draft['basis'])}>
                {Object.entries(GOAL_BASIS_DEFS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            {draft.basis === 'essential-costs' && (
              <fieldset className="goal-costs">
                <legend>Essential monthly costs</legend>
                {draft.costs.map((item, index) => {
                  const rowName = item.label.trim() || `cost ${index + 1}`;
                  return (
                    <div className="goal-cost-row" key={item.key}>
                      <input
                        className="input"
                        aria-label={`Cost ${index + 1} name`}
                        placeholder="Cost name"
                        value={item.label}
                        onChange={(event) => update('costs', draft.costs.map((costItem) => costItem.key === item.key ? { ...costItem, label: event.target.value } : costItem))}
                      />
                      <input
                        className="input"
                        aria-label={`Monthly cost for ${rowName}`}
                        inputMode="decimal"
                        placeholder={baseCurrency ?? ''}
                        value={item.monthly}
                        onChange={(event) => update('costs', draft.costs.map((costItem) => costItem.key === item.key ? { ...costItem, monthly: event.target.value } : costItem))}
                      />
                      <button
                        type="button"
                        className="btn btn-small btn-ghost"
                        aria-label={`Delete ${rowName}`}
                        onClick={() => update('costs', draft.costs.filter((costItem) => costItem.key !== item.key))}
                      >
                        Delete
                      </button>
                    </div>
                  );
                })}
                <button type="button" className="btn btn-small" onClick={() => update('costs', [...draft.costs, cost()])}>
                  Add cost
                </button>
              </fieldset>
            )}
            <label className="field"><span>Safety buffer, %</span><input className="input" inputMode="decimal" value={draft.bufferPct} onChange={(event) => update('bufferPct', event.target.value)} /></label>
            <WindowField value={draft.windowMonths} onChange={(value) => update('windowMonths', value)} />
            <label className="field"><span>Net hourly rate ({baseCurrency}, optional)</span><input className="input" inputMode="decimal" value={draft.hourlyRate} onChange={(event) => update('hourlyRate', event.target.value)} /></label>
            <label className="field"><span>Hours available per week (optional)</span><input className="input" inputMode="decimal" value={draft.hoursPerWeek} onChange={(event) => update('hoursPerWeek', event.target.value)} /></label>
          </>
        );
      case 'emergency-fund':
        return (
          <>
            <label className="field"><span>Coverage months</span><input className="input" inputMode="numeric" value={draft.coverageMonths} onChange={(event) => update('coverageMonths', event.target.value)} /></label>
            {money('Essential monthly amount', 'monthlyEssentials')}
            {accountChecks(accounts.filter((account) => account.currency === baseCurrency))}
            <DateField value={draft.targetDate} onChange={(value) => update('targetDate', value)} />
          </>
        );
      case 'savings-balance':
        return <>{money('Target amount', 'target')}{accountChecks(accounts, savingsCurrencyLock)}<DateField value={draft.targetDate} onChange={(value) => update('targetDate', value)} /></>;
      case 'debt-payoff': {
        const unavailable = draft.accountId && !accounts.some((account) => account.id === draft.accountId);
        return (
          <>
            <label className="field">
              <span>Debt account</span>
              <select className="input" value={draft.accountId} disabled={editing} onChange={(event) => update('accountId', event.target.value)}>
                <option value="">Choose an account</option>
                {unavailable && <option value={draft.accountId}>Unavailable account</option>}
                {accounts.filter((account) => account.balance < 0).map((account) => <option key={account.id} value={account.id}>{account.name} · {account.currency}</option>)}
              </select>
            </label>
            {money('Target remaining debt', 'targetDebt')}
            <DateField value={draft.targetDate} onChange={(value) => update('targetDate', value)} />
          </>
        );
      }
      case 'monthly-income':
        return <>{money('Monthly target', 'target')}<ScopeField value={draft.incomeScope} onChange={(value) => update('incomeScope', value)} /><WindowField value={draft.windowMonths} onChange={(value) => update('windowMonths', value)} /></>;
      case 'savings-rate':
        return <><label className="field"><span>Target percentage</span><input className="input" inputMode="decimal" value={draft.targetPercent} onChange={(event) => update('targetPercent', event.target.value)} /></label><ScopeField value={draft.incomeScope} onChange={(value) => update('incomeScope', value)} /><WindowField value={draft.windowMonths} onChange={(value) => update('windowMonths', value)} /></>;
      case 'category-spending-limit':
        return <><label className="field"><span>Category</span><select className="input" value={draft.category} onChange={(event) => update('category', event.target.value)}>{CATEGORIES.map((category) => <option key={category} value={category}>{categoryLabel(category)}</option>)}</select></label>{money('Monthly limit', 'monthlyLimit')}</>;
      case null:
        return null;
    }
  };

  return (
    <Sheet open={open} onClose={() => { if (!saving) onClose(); }} position="center" wide title={editing ? 'Edit goal' : 'New goal'}>
      <div className="goal-editor">
        <h2>{editing ? 'Edit goal' : draft.type ? GOAL_TYPE_DEFS[draft.type].label : 'Choose a goal type'}</h2>
        {loading && <p className="state-note">Loading goal…</p>}
        {!loading && loadError && (
          <div className="error-row" role="alert">
            <span>{loadError}</span>
            <button className="btn btn-small" onClick={() => setLoadAttempt((value) => value + 1)}>
              Retry
            </button>
            <button className="btn btn-small" onClick={onClose}>
              Cancel
            </button>
          </div>
        )}
        {!loading && !loadError && baseCurrency !== null && !draft.type && (
          <>
            <div className="goal-type-grid">
              {GOAL_TYPE_ORDER.map((type) => (
                <button key={type} type="button" className="goal-type-tile" onClick={() => selectType(type)}>
                  <strong>{GOAL_TYPE_DEFS[type].label}</strong>
                  <span>{GOAL_TYPE_DEFS[type].fact}</span>
                </button>
              ))}
            </div>
            <div className="sheet-actions">
              <button type="button" className="btn" onClick={onClose}>Cancel</button>
            </div>
          </>
        )}
        {!loading && !loadError && baseCurrency !== null && draft.type && (
          <form onSubmit={(event) => void submit(event)}>
            <p className="goal-currency">Currency: {draft.type === 'savings-rate' ? 'percentage' : selectedCurrency}</p>
            <label className="field"><span>Name</span><input className="input" value={draft.name} onChange={(event) => update('name', event.target.value)} /></label>
            {fields()}
            {error && <p className="error-text" role="alert">{error}</p>}
            <div className="sheet-actions">
              {!editing && <button type="button" className="btn" disabled={saving} onClick={returnToTypes}>Back</button>}
              <button type="button" className="btn" disabled={saving} onClick={onClose}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : editing ? 'Save' : 'Create goal'}</button>
            </div>
          </form>
        )}
        {!loading && !loadError && error && !draft.type && <p className="error-text" role="alert">{error}</p>}
      </div>
    </Sheet>
  );
}

const DateField = ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
  <label className="field"><span>Target date (optional)</span><input className="input" type="date" value={value} onChange={(event) => onChange(event.target.value)} /></label>
);

const ScopeField = ({ value, onChange }: { value: 'own' | 'all'; onChange: (value: 'own' | 'all') => void }) => (
  <label className="field"><span>Income</span><select className="input" value={value} onChange={(event) => onChange(event.target.value as 'own' | 'all')}>{Object.entries(GOAL_INCOME_SCOPE_DEFS).map(([scope, label]) => <option key={scope} value={scope}>{label}</option>)}</select></label>
);
