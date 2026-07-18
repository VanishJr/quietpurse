import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '../api';
import { categoryLabel } from '../categories';
import { BudgetsBlock } from '../components/BudgetsBlock';
import { Chips } from '../components/Chips';
import { fmtMoney, fmtMonth, fmtShort, isoDay, MONTHS_SHORT } from '../format';
import { useTheme } from '../theme';
import { CategorySummary, MonthTotals, Summary } from '../types';

/** What the chart shows. Toggled by clicking the "Expenses"/"Income" cards. */
type Mode = 'expense' | 'income';
/** Analysis window: a calendar month or a calendar year. */
type Range = 'month' | 'year';

const RANGES: { key: Range; label: string }[] = [
  { key: 'month', label: 'Month' },
  { key: 'year', label: 'Year' },
];

function bounds(range: Range, d: Date): { from: string; to: string } {
  if (range === 'year') {
    return {
      from: isoDay(new Date(d.getFullYear(), 0, 1)),
      to: isoDay(new Date(d.getFullYear(), 11, 31)),
    };
  }
  return {
    from: isoDay(new Date(d.getFullYear(), d.getMonth(), 1)),
    to: isoDay(new Date(d.getFullYear(), d.getMonth() + 1, 0)),
  };
}

/** Y-axis upper bound: a round number no smaller than the maximum. */
function niceMax(max: number): number {
  if (max <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(max)));
  return Math.ceil(max / (pow / 2)) * (pow / 2);
}

export function AnalyticsScreen() {
  const { ink, categoryColor } = useTheme();

  const [range, setRange] = useState<Range>('month');
  const [anchor, setAnchor] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [mode, setMode] = useState<Mode>('expense');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [months, setMonths] = useState<MonthTotals[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const { from, to } = bounds(range, anchor);
      const s = await api.summary(from, to);
      setSummary(s);
      setMonths(range === 'year' ? (await api.months(from, to)).months : []);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [range, anchor]);

  useEffect(() => {
    load();
  }, [load]);

  const shift = (delta: number) =>
    setAnchor((d) =>
      range === 'year'
        ? new Date(d.getFullYear() + delta, d.getMonth(), 1)
        : new Date(d.getFullYear(), d.getMonth() + delta, 1),
    );

  const now = new Date();
  // nothing to page forward to: there are no future transactions
  const atPresent =
    range === 'year'
      ? anchor.getFullYear() === now.getFullYear()
      : anchor.getFullYear() === now.getFullYear() && anchor.getMonth() === now.getMonth();
  const isCurrentMonth =
    range === 'month' &&
    anchor.getFullYear() === now.getFullYear() &&
    anchor.getMonth() === now.getMonth();

  const baseCurrency = summary?.baseCurrency ?? 'EUR';
  const expenseTotal = summary?.totals.expense ?? 0;
  const incomeTotal = summary?.totals.income ?? 0;

  /** Categories of the selected side (expenses/income) — already in the base currency. */
  const byCategory: CategorySummary[] = useMemo(() => {
    if (!summary) return [];
    return mode === 'expense' ? summary.byCategory : summary.incomeByCategory;
  }, [summary, mode]);

  /** By month of the year: the total of the selected side (12 values). */
  const monthlyValues = useMemo(() => {
    if (range !== 'year') return [];
    const values = new Array(12).fill(0);
    for (const m of months) {
      const idx = parseInt(m.month.slice(5, 7), 10) - 1;
      values[idx] += mode === 'expense' ? m.expense : m.income;
    }
    return values;
  }, [range, months, mode]);

  /** Months with money movement — so the average isn't divided by empty months. */
  const activeMonths = monthlyValues.filter((v) => v > 0).length;
  const total = mode === 'expense' ? expenseTotal : incomeTotal;

  const barMax = niceMax(Math.max(...monthlyValues, 0));
  const barColor = mode === 'expense' ? ink.accent : ink.good;
  const bars = monthlyValues.map((value, i) => ({ value, label: MONTHS_SHORT[i] }));

  // A refund can push a category negative (the purchase was last month, the refund
  // came this month) — the legend shows such a row honestly, but you can't put a
  // negative sector into the chart.
  const pieData = byCategory
    .filter((c) => c.total > 0)
    .map((c) => ({ name: categoryLabel(c.category), value: c.total, slug: c.category }));

  const incomeBySource = summary?.incomeBySource ?? [];

  const emptyText =
    mode === 'expense'
      ? `No expenses this ${range === 'year' ? 'year' : 'month'}.`
      : `No income this ${range === 'year' ? 'year' : 'month'}.`;

  const axisTick = { fill: ink.muted, fontSize: 10 };

  return (
    <div className="screen-inner">
      <h1 className="title">Analytics</h1>

      <Chips
        label="Range"
        options={RANGES.map((r) => ({ key: r.key, label: r.label }))}
        selected={range}
        onSelect={(k) => setRange(k as Range)}
      />

      <div className="period-row">
        <button className="period-btn" onClick={() => shift(-1)} aria-label="Previous period">
          ‹
        </button>
        <span className="period-label">
          {range === 'year' ? anchor.getFullYear() : fmtMonth(anchor)}
        </span>
        <button
          className="period-btn"
          onClick={() => shift(1)}
          disabled={atPresent}
          aria-label="Next period"
        >
          ›
        </button>
      </div>

      {error && <p className="error">Error: {error}</p>}

      {/* the cards double as the chart toggle: the active side is highlighted */}
      <div className="totals-row" role="tablist">
        <button
          className="total-box"
          role="tab"
          aria-selected={mode === 'expense'}
          onClick={() => setMode('expense')}
        >
          <div className="total-label">Expenses</div>
          <div className="total-value">{fmtMoney(expenseTotal, baseCurrency)}</div>
        </button>
        <button
          className="total-box"
          role="tab"
          aria-selected={mode === 'income'}
          onClick={() => setMode('income')}
        >
          <div className="total-label">Income</div>
          <div className="total-value" style={{ color: ink.good }}>
            {fmtMoney(incomeTotal, baseCurrency)}
          </div>
        </button>
      </div>

      {range === 'year' && activeMonths > 0 && (
        <p className="average">
          On average {fmtMoney(total / activeMonths, baseCurrency)} per month
          {activeMonths < 12 ? ` (over ${activeMonths} mo. with activity)` : ''}
        </p>
      )}

      <p className="hint">
        All amounts in {baseCurrency} at the NBU rate on the transaction date. Transfers between
        your own accounts aren't counted, refunds are subtracted from expenses.
      </p>

      {range === 'year' && total > 0 && (
        <div style={{ height: 180, marginBottom: 8 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={bars} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <XAxis
                dataKey="label"
                tick={axisTick}
                axisLine={{ stroke: ink.grid }}
                tickLine={false}
              />
              <YAxis
                domain={[0, barMax]}
                tickCount={4}
                tick={axisTick}
                axisLine={false}
                tickLine={false}
                width={52}
                tickFormatter={fmtShort}
              />
              {/*
                Animation off: every screen stays mounted, so this chart first renders
                inside a hidden container. An animation started there freezes at an
                arbitrary frame and the bars keep that wrong height once the screen is
                shown — the axis, which isn't animated, would stay correct and hide it.
              */}
              <Bar
                dataKey="value"
                fill={barColor}
                radius={[3, 3, 0, 0]}
                isAnimationActive={false}
                maxBarSize={40}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {byCategory.length === 0 ? (
        <p className="empty">{emptyText}</p>
      ) : (
        <div className="analytics-split">
          {pieData.length > 0 && (
            <div className="chart-wrap" style={{ height: 240 }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={pieData}
                    dataKey="value"
                    nameKey="name"
                    innerRadius="62%"
                    outerRadius="100%"
                    stroke={ink.page}
                    strokeWidth={2}
                    isAnimationActive={false}
                  >
                    {pieData.map((d) => (
                      <Cell key={d.slug} fill={categoryColor(d.slug)} />
                    ))}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <div className="donut-center">
                <div className="donut-value">{fmtMoney(total)}</div>
                <div className="donut-currency">{baseCurrency}</div>
              </div>
            </div>
          )}

          {/* legend with values — category identity isn't carried by color alone */}
          <div className="legend">
            {byCategory.map((c) => (
              <div key={c.category} className="legend-row">
                <span className="dot" style={{ background: categoryColor(c.category) }} />
                <span className="legend-name">{categoryLabel(c.category)}</span>
                <span className="legend-pct">
                  {total > 0 ? Math.round((c.total / total) * 100) : 0}%
                </span>
                <span className="legend-value">{fmtMoney(c.total)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* income by source: your own earnings apart from family help */}
      {mode === 'income' && incomeBySource.length > 0 && (
        <div className="legend">
          <h2 className="block-title">By source</h2>
          {incomeBySource.map((s) => (
            <div key={s.source} className="legend-row">
              <span className="legend-name">{s.label}</span>
              <span className="legend-value">{fmtMoney(s.total)}</span>
            </div>
          ))}
        </div>
      )}

      {isCurrentMonth && <BudgetsBlock />}
      <div className="bottom-pad" />
    </div>
  );
}
