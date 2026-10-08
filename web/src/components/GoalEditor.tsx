import { FormEvent, useEffect, useId, useRef, useState } from 'react';
import { ApiError, api } from '../api';
import { CATEGORIES, categoryLabel } from '../categories';
import { useEditorSession } from '../editor';
import {
  GOAL_BASIS_DEFS,
  GOAL_INCOME_SCOPE_DEFS,
  GOAL_TYPE_DEFS,
  GOAL_TYPE_ORDER,
} from '../goals';
import type { Account, GoalCreate, GoalDetail, GoalType } from '../types';
import { Sheet } from './Sheet';
import { Button } from './Button';
import { FormActions } from './FormActions';
import { Notice } from './Notice';
import { Field } from './Field';

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
  savedAccountIds: string[];
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
  savedAccountIds: [],
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
      return {
        ...draft,
        target: String(goal.target),
        accountIds: goal.accountIds,
        savedAccountIds: goal.accountIds,
      };
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

const meaningOf = ({ type: _type, savedCurrency: _currency, savedAccountIds: _saved, costs, accountIds, ...values }: Draft) =>
  JSON.stringify({
    ...values,
    accountIds: [...accountIds].sort(),
    costs: costs.filter((item) => item.label || item.monthly).map(({ label, monthly }) => ({ label, monthly })),
  });

type FieldName = 'name' | 'basis' | 'bufferPct' | 'windowMonths' | 'hourlyRate' | 'hoursPerWeek' |
  'coverageMonths' | 'monthlyEssentials' | 'accountIds' | 'accountId' | 'target' | 'targetDebt' | 'targetPercent' |
  'incomeScope' | 'category' | 'monthlyLimit' | 'targetDate';
type IssueTarget = { kind: 'field'; field: FieldName } | { kind: 'cost'; key: number; field: 'label' | 'monthly' } | { kind: 'add-cost' };
interface Issue { target: IssueTarget; message: string }
interface Validation { goal?: GoalCreate; issues: Issue[] }

const writeOf = (draft: Draft, mismatchedCurrency: string | null = null): Validation => {
  const issues: Issue[] = [];
  const issue = (target: IssueTarget, message: string) => issues.push({ target, message });
  const fieldIssue = (field: FieldName, message: string) => issue({ kind: 'field', field }, message);
  const positive = (raw: string, label: string, target: IssueTarget): number => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) issue(target, `${label} must be a positive number.`);
    return value;
  };
  const whole = (raw: string, label: string, field: FieldName, min: number, max: number): number => {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      fieldIssue(field, `${label} must be a whole number from ${min} to ${max}.`);
    }
    return value;
  };
  const result = (goal: GoalCreate): Validation => {
    if (issues.length === 0 && mismatchedCurrency !== null) {
      fieldIssue('accountIds', `Remove accounts that no longer use this goal’s ${mismatchedCurrency} currency.`);
    }
    return issues.length ? { issues } : { goal, issues };
  };
  const name = draft.name.trim();
  if (!draft.type) return { issues: [{ target: { kind: 'field', field: 'name' }, message: 'Choose a goal type.' }] };
  if (!name) fieldIssue('name', 'Name is required.');
  const targetDate = draft.targetDate || null;
  switch (draft.type) {
    case 'financial-independence': {
      const buffer = Number(draft.bufferPct);
      if (!Number.isFinite(buffer) || buffer < 0 || buffer > 100) {
        fieldIssue('bufferPct', 'Safety buffer must be from 0 to 100.');
      }
      const window = whole(draft.windowMonths, 'Averaging period', 'windowMonths', 1, 24);
      const items = draft.costs
        .map((item) => ({ ...item, label: item.label.trim() }))
        .filter((item) => item.label || item.monthly);
      for (const item of items) {
        if (!item.label) issue({ kind: 'cost', key: item.key, field: 'label' }, 'Every cost needs a name.');
      }
      const labels = new Set<string>();
      for (const item of items) {
        const label = item.label.toLocaleLowerCase();
        if (labels.has(label)) issue({ kind: 'cost', key: item.key, field: 'label' }, 'Cost names must be unique.');
        labels.add(label);
      }
      const essentialCosts = items.map((item) => ({
        label: item.label,
        monthly: positive(item.monthly, `Monthly cost for ${item.label}`, { kind: 'cost', key: item.key, field: 'monthly' }),
      }));
      if (draft.basis === 'essential-costs' && essentialCosts.length === 0) {
        if (draft.costs.length) issue({ kind: 'cost', key: draft.costs[0].key, field: 'label' }, 'Add at least one essential monthly cost.');
        else issue({ kind: 'add-cost' }, 'Add at least one essential monthly cost.');
      }
      const hourly = draft.hourlyRate
        ? positive(draft.hourlyRate, 'Net hourly rate', { kind: 'field', field: 'hourlyRate' })
        : null;
      const hours = draft.hoursPerWeek
        ? positive(draft.hoursPerWeek, 'Hours available per week', { kind: 'field', field: 'hoursPerWeek' })
        : null;
      return result({
        type: draft.type, name, basis: draft.basis, bufferPct: buffer, windowMonths: window,
        hourlyRate: hourly, hoursPerWeek: hours, essentialCosts,
      });
    }
    case 'emergency-fund': {
      const coverage = whole(draft.coverageMonths, 'Coverage months', 'coverageMonths', 1, 120);
      const essentials = positive(draft.monthlyEssentials, 'Essential monthly amount', { kind: 'field', field: 'monthlyEssentials' });
      if (draft.accountIds.length === 0) fieldIssue('accountIds', 'Choose at least one funding account.');
      return result({ type: draft.type, name, targetDate, coverageMonths: coverage, monthlyEssentials: essentials, accountIds: draft.accountIds });
    }
    case 'savings-balance': {
      const target = positive(draft.target, 'Target amount', { kind: 'field', field: 'target' });
      if (draft.accountIds.length === 0) fieldIssue('accountIds', 'Choose at least one account.');
      return result({ type: draft.type, name, targetDate, target, accountIds: draft.accountIds });
    }
    case 'debt-payoff': {
      const target = Number(draft.targetDebt);
      if (!Number.isFinite(target) || target < 0) fieldIssue('targetDebt', 'Target remaining debt must be zero or more.');
      if (!draft.accountId) fieldIssue('accountId', 'Choose a debt account.');
      return result({ type: draft.type, name, targetDate, accountId: draft.accountId, targetDebt: target });
    }
    case 'monthly-income': {
      const target = positive(draft.target, 'Monthly target', { kind: 'field', field: 'target' });
      const window = whole(draft.windowMonths, 'Averaging period', 'windowMonths', 1, 24);
      return result({ type: draft.type, name, target, incomeScope: draft.incomeScope, windowMonths: window });
    }
    case 'savings-rate': {
      const target = Number(draft.targetPercent);
      if (!Number.isFinite(target) || target <= 0 || target > 100) {
        fieldIssue('targetPercent', 'Target percentage must be greater than 0 and at most 100.');
      }
      const window = whole(draft.windowMonths, 'Averaging period', 'windowMonths', 1, 24);
      return result({ type: draft.type, name, targetPercent: target, incomeScope: draft.incomeScope, windowMonths: window });
    }
    case 'category-spending-limit': {
      const limit = positive(draft.monthlyLimit, 'Monthly limit', { kind: 'field', field: 'monthlyLimit' });
      return result({ type: draft.type, name, category: draft.category, monthlyLimit: limit });
    }
  }
};

interface HelperFieldProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  locked: boolean;
  error?: string;
}

const WindowField = ({ id, value, onChange, locked, error }: HelperFieldProps) => (
  <Field id={id} label="Averaging period" help="Complete months used for the average (1–24)." error={error}
    control="select" controlProps={{
      value, 'aria-disabled': locked,
      onChange: (event) => { if (locked) event.currentTarget.value = value; else onChange(event.target.value); },
      children: <>
        {!['3', '6', '12'].includes(value) && <option value={value}>{value} months</option>}
        <option value="3">3 months</option><option value="6">6 months</option><option value="12">12 months</option>
      </>,
    }} />
);

export function GoalEditor({ goalId, onClose, onMissing = onClose, onSaved }: Props) {
  const formId = useId();
  const fieldId = (field: FieldName) => `${formId}-${field}`;
  const costId = (key: number, field: 'label' | 'monthly') => `${formId}-cost-${key}-${field}`;
  const summaryId = `${formId}-errors`;
  const addCostId = `${formId}-add-cost`;
  const [showValidation, setShowValidation] = useState(false);
  const [validationAttempt, setValidationAttempt] = useState(0);
  const rowFocus = useRef<string | null>(null);
  const open = goalId !== null;
  const editing = goalId !== null && goalId !== 'new';
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [baseline, setBaseline] = useState<Draft | null>(null);
  const [choosingType, setChoosingType] = useState(true);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [baseCurrency, setBaseCurrency] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [completed, setCompleted] = useState<GoalDetail | null>(null);
  const completedRef = useRef<GoalDetail | null>(null);
  const opening = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const { requestClose, request, finish, guard } = useEditorSession({
    open, dirty: completed === null && baseline !== null && meaningOf(draft) !== meaningOf(baseline), busy: saving, onClose,
    onNavigationDiscard: () => {
      if (baseline) setDraft(baseline);
      setChoosingType(!editing);
      setError(null);
      setShowValidation(false);
    },
  });

  useEffect(() => {
    opening.current++;
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setSaving(false);
    savingRef.current = false;
    completedRef.current = null;
    setCompleted(null);
    setBaseline(null);
    setChoosingType(!editing);
    setError(null);
    setLoadError(null);
    setShowValidation(false);
    rowFocus.current = null;
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
        const opening = goal ? draftOf(goal) : emptyDraft();
        setDraft(opening);
        setBaseline(opening);
      })
      .catch((caught) => {
        if (cancelled) return;
        if (editing && caught instanceof ApiError && caught.status === 404) {
          finish(onMissing);
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

  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    if (!savingRef.current) setDraft((current) => ({ ...current, [key]: value }));
  };

  const selectType = (type: GoalType) => {
    const select = () => {
      setError(null);
      setShowValidation(false);
      if (draft.type !== null && draft.type !== type) setDraft({ ...emptyDraft(), type });
      else update('type', type);
      setChoosingType(false);
    };
    if (draft.type !== null && draft.type !== type) request(select);
    else select();
  };

  const returnToTypes = () => {
    if (savingRef.current) return;
    setError(null);
    setShowValidation(false);
    setChoosingType(true);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (savingRef.current) return;
    setError(null);
    if (!validation.goal) {
      setShowValidation(true);
      setValidationAttempt((attempt) => attempt + 1);
      return;
    }
    setShowValidation(false);
    const owner = opening.current;
    savingRef.current = true;
    setSaving(true);
    try {
      const saved = editing
        ? await api.updateGoal(goalId, validation.goal)
        : await api.createGoal(validation.goal);
      if (owner === opening.current) {
        completedRef.current = saved;
        setCompleted(saved);
        setBaseline(draft);
        finish(() => onSaved(saved));
      } else onSaved(saved);
    } catch (caught) {
      if (owner !== opening.current) return;
      if (editing && caught instanceof ApiError && caught.status === 404) {
        finish(onMissing);
        return;
      }
      setError((caught as Error).message);
    } finally {
      if (owner === opening.current) {
        savingRef.current = completedRef.current !== null;
        setSaving(false);
      }
    }
  };

  const isMismatchedSavedSavingsAccount = (account: Account) =>
    draft.type === 'savings-balance' &&
    draft.savedCurrency !== null &&
    draft.savedAccountIds.includes(account.id) &&
    account.currency !== draft.savedCurrency;
  const hasMismatchedSavingsSelection = draft.accountIds.some((id) => {
    const account = accounts.find((candidate) => candidate.id === id);
    return account !== undefined && isMismatchedSavedSavingsAccount(account);
  });
  const selectedAvailableAccount = accounts.find(
    (account) =>
      draft.accountIds.includes(account.id) && !isMismatchedSavedSavingsAccount(account),
  );
  const hasUnavailableSelection = draft.accountIds.some((id) => {
    const account = accounts.find((candidate) => candidate.id === id);
    return account === undefined || isMismatchedSavedSavingsAccount(account);
  });
  const selectableSavingsAccounts = accounts.filter(
    (account) =>
      !draft.accountIds.includes(account.id) || !isMismatchedSavedSavingsAccount(account),
  );
  const savingsCurrencyLock =
    draft.type === 'savings-balance'
      ? selectedAvailableAccount?.currency ??
        (hasUnavailableSelection ? draft.savedCurrency : null)
      : null;
  const selectedCurrency =
    draft.type === 'debt-payoff'
      ? draft.savedCurrency ??
        accounts.find((account) => account.id === draft.accountId)?.currency ??
        baseCurrency ??
        ''
      : draft.type === 'savings-balance' || draft.type === 'emergency-fund'
        ? selectedAvailableAccount?.currency ?? draft.savedCurrency ?? baseCurrency ?? ''
        : baseCurrency ?? '';

  const toggleAccount = (id: string) => {
    if (savingRef.current) return;
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
    setDraft((current) => ({
      ...current,
      accountIds: selected
        ? current.accountIds.filter((accountId) => accountId !== id)
        : [...current.accountIds, id],
      savedAccountIds: selected
        ? current.savedAccountIds.filter((accountId) => accountId !== id)
        : current.savedAccountIds,
    }));
  };

  const validation = writeOf(draft, hasMismatchedSavingsSelection ? draft.savedCurrency : null);
  const visibleIssues = showValidation ? validation.issues : [];
  const addCostError = visibleIssues.find((item) => item.target.kind === 'add-cost')?.message;
  const hiddenCostIssue = (item: Issue) => item.target.kind === 'cost' && draft.basis === 'current-spending';
  const issueId = (item: Issue) => item.target.kind === 'cost'
    ? hiddenCostIssue(item) ? fieldId('basis') : costId(item.target.key, item.target.field)
    : item.target.kind === 'add-cost' ? addCostId : fieldId(item.target.field);
  const issueMessage = (item: Issue) => hiddenCostIssue(item)
    ? `${item.message} Switch Target basis to Essential costs to correct the retained costs.`
    : item.message;
  const fieldError = (field: FieldName) => {
    const messages = visibleIssues.filter((item) => issueId(item) === fieldId(field)).map(issueMessage);
    return messages.length ? [...new Set(messages)].join(' ') : undefined;
  };
  const costError = (key: number, field: 'label' | 'monthly') => {
    const messages = visibleIssues.filter((item) => issueId(item) === costId(key, field)).map(issueMessage);
    return messages.length ? [...new Set(messages)].join(' ') : undefined;
  };
  const focusId = (id: string) => {
    const element = document.getElementById(id);
    const target = id === fieldId('accountIds')
      ? element?.querySelector<HTMLElement>('input:not(:disabled)') ?? element
      : element;
    target?.focus({ preventScroll: true });
    target?.scrollIntoView?.({ block: 'nearest' });
  };

  useEffect(() => {
    if (!validationAttempt) return;
    if (draft.type === 'financial-independence') focusId(summaryId);
    else if (validation.issues[0]) focusId(issueId(validation.issues[0]));
  }, [validationAttempt]);

  useEffect(() => {
    if (!rowFocus.current) return;
    focusId(rowFocus.current);
    rowFocus.current = null;
  }, [draft.costs]);

  const addCost = () => {
    if (savingRef.current) return;
    const item = cost();
    rowFocus.current = costId(item.key, 'label');
    update('costs', [...draft.costs, item]);
  };
  const removeCost = (index: number) => {
    if (savingRef.current) return;
    const remaining = draft.costs.filter((_, ordinal) => ordinal !== index);
    const next = remaining[index] ?? remaining[index - 1];
    rowFocus.current = next ? costId(next.key, 'label') : addCostId;
    update('costs', remaining);
  };

  const money = (label: string, key: 'monthlyEssentials' | 'target' | 'targetDebt' | 'monthlyLimit') => (
    <Field id={fieldId(key)} label={`${label} (${selectedCurrency})`} error={fieldError(key)}
      control="input" controlProps={{
        readOnly: saving, inputMode: 'decimal', value: draft[key], onChange: (event) => update(key, event.target.value),
      }} />
  );

  const accountChecks = (eligible: Account[], currencyLock: string | null = null) => {
    const id = fieldId('accountIds');
    const error = fieldError('accountIds');
    const descriptions = `${id}-help${error ? ` ${id}-error` : ''}`;
    const accountCheck = (accountId: string, label: string, disabled = false) => {
      const controlId = `${id}-${accountId}`;
      return (
        <label key={accountId} htmlFor={controlId}>
          <input id={controlId} type="checkbox" checked={draft.accountIds.includes(accountId)}
            aria-disabled={saving} disabled={disabled} aria-invalid={error ? true : undefined}
            aria-describedby={descriptions} onChange={() => toggleAccount(accountId)} />
          {label}
        </label>
      );
    };
    return (
      <fieldset id={id} className="goal-account-list" tabIndex={-1} aria-invalid={error ? true : undefined} aria-describedby={descriptions}>
        <legend>Accounts</legend>
        {draft.accountIds.filter((accountId) => !eligible.some((account) => account.id === accountId)).map((accountId) => {
          const account = accounts.find((candidate) => candidate.id === accountId);
          return accountCheck(accountId, account ? `${account.name} · ${account.currency} (not eligible)` : 'Unavailable account');
        })}
        {eligible.map((account) => accountCheck(account.id, `${account.name} · ${account.currency}`,
          !draft.accountIds.includes(account.id) && currencyLock !== null && account.currency !== currencyLock))}
        <div id={`${id}-help`} className="native-field__help">
          <p>Progress will be recalculated from the selected accounts.</p>
          <p>{draft.type === 'emergency-fund'
            ? `Choose funding accounts in ${baseCurrency}. Unavailable saved accounts can be removed.`
            : 'Choose accounts in one currency. Clear the selection to change currency. Unavailable or ineligible saved accounts can be removed.'}</p>
        </div>
        {error && <p id={`${id}-error`} className="native-field__error">{error}</p>}
      </fieldset>
    );
  };

  const windowField = () => <WindowField id={fieldId('windowMonths')} error={fieldError('windowMonths')}
    locked={saving} value={draft.windowMonths} onChange={(value) => update('windowMonths', value)} />;
  const dateField = () => <DateField id={fieldId('targetDate')} locked={saving}
    value={draft.targetDate} onChange={(value) => update('targetDate', value)} />;
  const scopeField = () => <ScopeField id={fieldId('incomeScope')} locked={saving}
    value={draft.incomeScope} onChange={(value) => update('incomeScope', value as Draft['incomeScope'])} />;

  const fields = () => {
    switch (draft.type) {
      case 'financial-independence':
        return (
          <>
            <Field id={fieldId('basis')} label="Target basis" error={fieldError('basis')}
              help="Essential costs are retained when using current spending and must still be valid to save."
              control="select" controlProps={{
                value: draft.basis, 'aria-disabled': saving,
                onChange: (event) => { if (savingRef.current) event.currentTarget.value = draft.basis; else update('basis', event.target.value as Draft['basis']); },
                children: Object.entries(GOAL_BASIS_DEFS).map(([value, label]) => <option key={value} value={value}>{label}</option>),
              }} />
            {draft.basis === 'essential-costs' && (
              <fieldset className="goal-costs" aria-describedby={`${formId}-costs-help`}>
                <legend>Essential monthly costs</legend>
                <p id={`${formId}-costs-help`} className="native-field__help">Enter a unique name and monthly amount in {baseCurrency}. Empty rows are ignored.</p>
                {draft.costs.map((item, index) => {
                  const rowName = item.label.trim();
                  const rowContext = rowName ? `${rowName}, row ${index + 1}` : `row ${index + 1}`;
                  return (
                    <div className="goal-cost-row" key={item.key}>
                      <Field id={costId(item.key, 'label')} label={`Cost ${index + 1} name`} error={costError(item.key, 'label')}
                        control="input" controlProps={{
                          readOnly: saving, placeholder: 'Cost name', value: item.label,
                          onChange: (event) => update('costs', draft.costs.map((costItem) => costItem.key === item.key ? { ...costItem, label: event.target.value } : costItem)),
                        }} />
                      <Field id={costId(item.key, 'monthly')} label={`Monthly cost for ${rowContext}`} help={`Amount in ${baseCurrency}.`}
                        error={costError(item.key, 'monthly')} control="input" controlProps={{
                          readOnly: saving, inputMode: 'decimal', value: item.monthly,
                          onChange: (event) => update('costs', draft.costs.map((costItem) => costItem.key === item.key ? { ...costItem, monthly: event.target.value } : costItem)),
                        }} />
                      <Button type="button" variant="destructive-secondary" size="standard" aria-label={`Delete ${rowContext}`}
                        aria-disabled={saving} onClick={() => removeCost(index)}>Delete</Button>
                    </div>
                  );
                })}
                {addCostError && <p id={`${addCostId}-error`} className="native-field__error">{addCostError}</p>}
                <Button id={addCostId} type="button" variant="secondary" size="standard" aria-disabled={saving}
                  aria-describedby={addCostError ? `${addCostId}-error` : undefined}
                  onClick={addCost}>Add cost</Button>
              </fieldset>
            )}
            <Field id={fieldId('bufferPct')} label="Safety buffer, %" help="From 0 to 100%." error={fieldError('bufferPct')}
              control="input" controlProps={{ readOnly: saving, inputMode: 'decimal', value: draft.bufferPct, onChange: (event) => update('bufferPct', event.target.value) }} />
            {windowField()}
            <Field id={fieldId('hourlyRate')} label={`Net hourly rate (${baseCurrency}, optional)`} error={fieldError('hourlyRate')}
              help="Leave blank if you do not want a work-hours estimate." control="input" controlProps={{
                readOnly: saving, inputMode: 'decimal', value: draft.hourlyRate, onChange: (event) => update('hourlyRate', event.target.value),
              }} />
            <Field id={fieldId('hoursPerWeek')} label="Hours available per week (optional)" error={fieldError('hoursPerWeek')}
              help="Leave blank if you do not want to set work capacity." control="input" controlProps={{
                readOnly: saving, inputMode: 'decimal', value: draft.hoursPerWeek, onChange: (event) => update('hoursPerWeek', event.target.value),
              }} />
          </>
        );
      case 'emergency-fund':
        return (
          <>
            <Field id={fieldId('coverageMonths')} label="Coverage months" help="Whole months, from 1 to 120." error={fieldError('coverageMonths')}
              control="input" controlProps={{ readOnly: saving, inputMode: 'numeric', value: draft.coverageMonths, onChange: (event) => update('coverageMonths', event.target.value) }} />
            {money('Essential monthly amount', 'monthlyEssentials')}
            {accountChecks(accounts.filter((account) => account.currency === baseCurrency))}
            {dateField()}
          </>
        );
      case 'savings-balance':
        return <>{money('Target amount', 'target')}{accountChecks(selectableSavingsAccounts, savingsCurrencyLock)}{dateField()}</>;
      case 'debt-payoff': {
        const unavailable = draft.accountId && !accounts.some((account) => account.id === draft.accountId);
        const debtAccounts = accounts.filter((account) => account.balance < 0 || (editing && account.id === draft.accountId));
        return (
          <>
            <Field id={fieldId('accountId')} label="Debt account" error={fieldError('accountId')}
              help={editing ? 'The saved debt account cannot be changed.' : 'Choose an account with a negative balance.'}
              control="select" controlProps={{
                value: draft.accountId, disabled: editing, 'aria-disabled': saving,
                onChange: (event) => { if (savingRef.current) event.currentTarget.value = draft.accountId; else update('accountId', event.target.value); },
                children: <>
                  <option value="">Choose an account</option>
                  {unavailable && <option value={draft.accountId}>Unavailable account</option>}
                  {debtAccounts.map((account) => <option key={account.id} value={account.id}>{account.name} · {account.currency}</option>)}
                </>,
              }} />
            {money('Target remaining debt', 'targetDebt')}
            {dateField()}
          </>
        );
      }
      case 'monthly-income':
        return <>{money('Monthly target', 'target')}{scopeField()}{windowField()}</>;
      case 'savings-rate':
        return <><Field id={fieldId('targetPercent')} label="Target percentage" help="Greater than 0 and at most 100%." error={fieldError('targetPercent')}
          control="input" controlProps={{ readOnly: saving, inputMode: 'decimal', value: draft.targetPercent, onChange: (event) => update('targetPercent', event.target.value) }} />{scopeField()}{windowField()}</>;
      case 'category-spending-limit':
        return <><Field id={fieldId('category')} label="Category" control="select" controlProps={{
          value: draft.category, 'aria-disabled': saving,
          onChange: (event) => { if (savingRef.current) event.currentTarget.value = draft.category; else update('category', event.target.value); },
          children: CATEGORIES.map((category) => <option key={category} value={category}>{categoryLabel(category)}</option>),
        }} />{money('Monthly limit', 'monthlyLimit')}</>;
      case null:
        return null;
    }
  };

  return (
    <Sheet open={open} onClose={requestClose} guard={guard} position="center" wide
      title={editing ? 'Edit goal' : 'New goal'} pattern="builder"
      stepKey={completed ? 'saved' : loading ? 'loading' : loadError ? 'load-error' : choosingType ? 'types' : draft.type ?? 'types'} busy={saving}
      header={<h2>{completed ? 'Goal saved' : editing ? 'Edit goal' : !choosingType && draft.type ? GOAL_TYPE_DEFS[draft.type].label : 'Choose a goal type'}</h2>}
      restoreFocus={() => document.querySelector<HTMLElement>('.screen:not([hidden]) h1')}
      footer={!loading && !loadError && baseCurrency !== null ? (
        <div className="goal-editor-footer">
          {error && <Notice tone="error" role="alert">{error}</Notice>}
          {showValidation && draft.type !== 'financial-independence' && visibleIssues[0] && (
            <Notice tone="error" role="alert">{visibleIssues[0].message}</Notice>
          )}
          {saving && <p className="state-note" role="status">Saving goal…</p>}
          <FormActions
            back={!editing && !completed && !choosingType ? <Button type="button" variant="tertiary" size="standard" aria-disabled={saving} onClick={returnToTypes}>Back</Button> : undefined}
            cancel={<Button type="button" variant="secondary" size="standard" aria-disabled={saving} onClick={requestClose}>{completed ? 'Close' : 'Cancel'}</Button>}
            completion={!completed && !choosingType && draft.type ? <Button type="submit" form={formId} variant="primary" size="standard" pending={saving}>{editing ? 'Save' : 'Create goal'}</Button> : null}
          />
        </div>
      ) : undefined}
    >
      <div className="goal-editor">
        {loading && <Notice placement="content" role="status">Loading goal…</Notice>}
        {!loading && loadError && (
          <Notice tone="error" placement="content" role="alert" remedy={
            <FormActions
              cancel={<Button type="button" variant="secondary" size="standard" onClick={requestClose}>Cancel</Button>}
              completion={<Button type="button" variant="primary" size="standard" onClick={() => setLoadAttempt((value) => value + 1)}>Retry</Button>}
            />
          }>{loadError}</Notice>
        )}
        {!loading && !loadError && baseCurrency !== null && choosingType && (
          <>
            <div className="goal-type-grid">
              {GOAL_TYPE_ORDER.map((type) => (
                <button key={type} type="button" className="goal-type-tile" onClick={() => selectType(type)}>
                  <strong>{GOAL_TYPE_DEFS[type].label}</strong>
                  <span>{GOAL_TYPE_DEFS[type].fact}</span>
                </button>
              ))}
            </div>
          </>
        )}
        {completed && <Notice tone="success" role="status">“{completed.name}” was saved. This goal is no longer an unsaved draft.</Notice>}
        {!completed && !loading && !loadError && baseCurrency !== null && !choosingType && draft.type && (
          <form id={formId} onSubmit={(event) => void submit(event)}>
            {draft.type === 'financial-independence' && visibleIssues.length > 0 && (
              <section id={summaryId} className="goal-error-summary" role="alert" tabIndex={-1} aria-labelledby={`${summaryId}-title`}>
                <h3 id={`${summaryId}-title`}>Check the goal fields</h3>
                <ul>
                  {visibleIssues.map((item, index) => (
                    <li key={`${issueId(item)}-${index}`}>
                      <a href={`#${issueId(item)}`} onClick={(event) => { event.preventDefault(); focusId(issueId(item)); }}>{issueMessage(item)}</a>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <p className="goal-currency">Currency: {draft.type === 'savings-rate' ? 'percentage' : selectedCurrency}</p>
            <Field id={fieldId('name')} label="Name" error={fieldError('name')} control="input" controlProps={{
              readOnly: saving, value: draft.name, onChange: (event) => update('name', event.target.value),
            }} />
            {fields()}
          </form>
        )}
        {!loading && !loadError && error && choosingType && <p className="error-text" role="alert">{error}</p>}
      </div>
    </Sheet>
  );
}

const DateField = ({ id, value, onChange, locked }: HelperFieldProps) => (
  <Field id={id} label="Target date (optional)" control="input" controlProps={{
    readOnly: locked, type: 'date', value, onChange: (event) => onChange(event.target.value),
  }} />
);

const ScopeField = ({ id, value, onChange, locked }: HelperFieldProps) => (
  <Field id={id} label="Income" control="select" controlProps={{
    value, 'aria-disabled': locked,
    onChange: (event) => { if (locked) event.currentTarget.value = value; else onChange(event.target.value); },
    children: Object.entries(GOAL_INCOME_SCOPE_DEFS).map(([scope, label]) => <option key={scope} value={scope}>{label}</option>),
  }} />
);
