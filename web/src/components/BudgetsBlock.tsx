import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { CATEGORIES, categoryLabel } from '../categories';
import { fmtMoney } from '../format';
import { useTheme } from '../theme';
import { Budget } from '../types';
import { Sheet } from './Sheet';

/**
 * Per-category budgets: a monthly limit, actual spending, and a linear forecast
 * to the end of the month. The forecast turns red when the current pace would
 * blow past the limit. Shown on Analytics only for the current month — the
 * backend computes the actuals for that month.
 */
export function BudgetsBlock() {
  const { ink, categoryColor } = useTheme();

  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** category the editor is open for; '' = picking a category for a new budget */
  const [editing, setEditing] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    api
      .budgets()
      .then((r) => {
        setBudgets(r.budgets);
        setError(null);
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  useEffect(load, [load]);

  const save = async (category: string, monthly: number | null) => {
    setSaving(true);
    try {
      setError(null);
      await api.setBudget(category, monthly);
      setEditing(null);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const withBudget = new Set(budgets.map((b) => b.category));
  const addable = CATEGORIES.filter((c) => !withBudget.has(c));
  const parsed = parseFloat(amount.replace(',', '.'));

  return (
    <section style={{ marginTop: 8, marginBottom: 24 }}>
      <div className="header">
        <h2 className="block-title">Monthly budgets</h2>
        <button className="btn-link" onClick={() => setEditing('')}>
          + Add
        </button>
      </div>
      {error && <p className="error">Error: {error}</p>}
      {budgets.length === 0 && !error && (
        <p className="hint">
          A per-category limit and a forecast of "will you go over it at the current pace".
        </p>
      )}

      {budgets.map((b) => {
        const ratio = b.monthly > 0 ? Math.min(1, b.spent / b.monthly) : 0;
        const overForecast = b.forecast > b.monthly;
        return (
          <button
            key={b.category}
            style={{ display: 'block', width: '100%', textAlign: 'left', marginTop: 12 }}
            onClick={() => {
              setEditing(b.category);
              setAmount(String(b.monthly));
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="dot" style={{ background: categoryColor(b.category) }} />
              <span className="legend-name">{categoryLabel(b.category)}</span>
              <span
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: overForecast ? ink.bad : ink.primary,
                }}
              >
                {fmtMoney(b.spent)} / {fmtMoney(b.monthly)}
              </span>
            </div>
            <div className="track track-sm">
              <div
                className="track-fill"
                style={{
                  width: `${ratio * 100}%`,
                  background: b.spent > b.monthly ? ink.bad : categoryColor(b.category),
                }}
              />
            </div>
            <div
              style={{
                fontSize: 11,
                marginTop: 4,
                color: overForecast ? ink.bad : ink.muted,
              }}
            >
              forecast by end of month: {fmtMoney(b.forecast)}
              {overForecast ? ' — limit will be exceeded' : ''}
            </div>
          </button>
        );
      })}

      <Sheet
        open={editing !== null}
        onClose={() => setEditing(null)}
        position="center"
        title="Budget"
      >
        {editing === '' ? (
          <>
            <h3 className="sheet-title">Budget for a category</h3>
            <div className="chip-wrap">
              {addable.map((c) => (
                <button
                  key={c}
                  className="chip-cat"
                  onClick={() => {
                    setEditing(c);
                    setAmount('');
                  }}
                >
                  <span className="dot" style={{ background: categoryColor(c) }} />
                  {categoryLabel(c)}
                </button>
              ))}
            </div>
          </>
        ) : editing !== null ? (
          <>
            <h3 className="sheet-title">Budget: {categoryLabel(editing)}</h3>
            <input
              className="input"
              style={{ marginTop: 12 }}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              placeholder="Monthly limit, EUR"
              autoFocus
            />
            <div className="btn-row">
              <button className="btn-danger" disabled={saving} onClick={() => save(editing, null)}>
                Remove
              </button>
              <button
                className="btn"
                disabled={saving || !(parsed > 0)}
                onClick={() => save(editing, parsed)}
              >
                Save
              </button>
            </div>
          </>
        ) : null}
      </Sheet>
    </section>
  );
}
