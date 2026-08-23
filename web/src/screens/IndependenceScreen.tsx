import { useCallback, useEffect, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '../api';
import { categoryLabel } from '../categories';
import { NO_FIGURE, tooltipPercent, tooltipProps } from '../chartTooltip';
import { Chips } from '../components/Chips';
import { fmtMoney } from '../format';
import { SelfSufficiencyBar, selfSufficiencyBars } from '../independence';
import { useTheme } from '../theme';
import { GoalMode, Independence } from '../types';

/**
 * Goal screen — answers "how much do I need to earn so my family no longer has
 * to help?". All numbers are computed by the backend (/api/independence); this
 * screen only handles display, settings, and "what if" scenarios (the same
 * formula recomputed on the client).
 *
 * Two modes (goalMode):
 *   "Bare minimum"      — threshold built from line items: housing, food,
 *                         subscriptions, gym... What it takes to live on your own.
 *   "Current lifestyle" — the older formula: median of all spending. Shows what
 *                         life as-is costs, vacations and gadgets included.
 */

const BUFFER_OPTIONS = [0, 5, 10, 15, 20];
const WINDOW_OPTIONS = [3, 6, 12];
/** "what if" scenarios: how many EUR/mo to trim from the threshold base */
const WHATIF_OPTIONS = [0, 100, 200, 300, 500];

const GOAL_MODES: { key: GoalMode; label: string }[] = [
  { key: 'baseline', label: 'Bare minimum' },
  { key: 'lifestyle', label: 'Current lifestyle' },
];

export function IndependenceScreen() {
  const { ink, categoryColor } = useTheme();

  const [data, setData] = useState<Independence | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [whatIf, setWhatIf] = useState(0);
  const [rateInput, setRateInput] = useState('');
  const [savingRate, setSavingRate] = useState(false);
  const [hoursInput, setHoursInput] = useState('');
  const [savingHours, setSavingHours] = useState(false);
  /** label of the minimum line item currently being edited */
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  /** form for adding a new minimum line item */
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newValue, setNewValue] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setError(null);
      const d = await api.independence();
      setData(d);
      setRateInput(d.settings.hourlyRate !== null ? String(d.settings.hourlyRate) : '');
      setHoursInput(String(d.settings.hoursCapPerWeek));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const patchSettings = async (patch: Parameters<typeof api.updateSettings>[0]) => {
    try {
      setError(null);
      await api.updateSettings(patch);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const saveRate = async () => {
    const v = parseFloat(rateInput.replace(',', '.'));
    setSavingRate(true);
    await patchSettings({ hourlyRate: Number.isFinite(v) && v > 0 ? v : null });
    setSavingRate(false);
  };

  const saveHours = async () => {
    const v = parseFloat(hoursInput.replace(',', '.'));
    setSavingHours(true);
    // hoursCapPerWeek is never empty; on garbage input keep the previous value
    await patchSettings(Number.isFinite(v) && v > 0 ? { hoursCapPerWeek: v } : {});
    setSavingHours(false);
  };

  /** Edit the amount of a minimum line item. */
  const saveBaselineItem = async (label: string) => {
    const v = parseFloat(editValue.replace(',', '.'));
    try {
      setError(null);
      await api.setBaselineItem(label, Number.isFinite(v) && v > 0 ? v : null);
      setEditing(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const removeBaselineItem = async (label: string) => {
    try {
      setError(null);
      await api.setBaselineItem(label, null);
      setEditing(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const addBaselineItem = async () => {
    const label = newLabel.trim();
    const v = parseFloat(newValue.replace(',', '.'));
    if (!label || !(Number.isFinite(v) && v > 0)) return;
    try {
      setError(null);
      await api.setBaselineItem(label, v);
      setAdding(false);
      setNewLabel('');
      setNewValue('');
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!data) {
    return (
      <div className="screen-inner">
        <h1 className="title">Goal</h1>
        {error ? (
          <p className="error">Error: {error}</p>
        ) : (
          <p className="empty">{loading ? 'Crunching numbers…' : 'No data.'}</p>
        )}
      </div>
    );
  }

  const cur = data.baseCurrency;
  const pct = Math.round(data.selfSufficiency * 100);
  const isBaseline = data.effectiveMode === 'baseline';
  /** the mode that was ASKED for - the chip's own value, and what the minimum block renders on */
  const wantsBaseline = data.settings.goalMode === 'baseline';
  const fellBack = wantsBaseline && !isBaseline;
  const noGround = data.months.length === 0 && data.baselineSum === 0;
  const lifestyleGap = Math.round(data.lifestyleThreshold - data.baselineThreshold);
  const thresholdNoun = isBaseline ? 'the minimum' : 'your current lifestyle';
  const monthsAveraged =
    data.months.length === 0
      ? 'no months with data'
      : data.months.length === 1
        ? '1 month with data'
        : `${data.months.length} months with data`;

  // active mode's base: minimum or median spending — the threshold is derived from it
  const base = isBaseline ? data.baselineSum : data.avgSpend;

  // "what if" scenario: the same formula with a trimmed base
  const adjBase = Math.max(0, base - whatIf);
  const adjThreshold = adjBase * (1 + data.settings.bufferPct / 100);
  const adjDeficit = Math.max(0, adjThreshold - data.ownIncomeAvg);

  // anchor for comparison: rent — a minimum line item or a spending category
  const rentPerMonth = isBaseline
    ? (data.baselineItems.find((i) => i.label === 'housing')?.monthly ?? 0)
    : (data.byCategory.find((c) => c.category === 'housing')?.total ?? 0);

  // calculator from the entered rate and hours/week: what monthly pay that is,
  // how much falls short of the threshold, and what rate would close it at these hours
  const workHoursPerMonth = (data.settings.hoursCapPerWeek * 52) / 12;
  const workMonthly = data.settings.hourlyRate
    ? Math.round(data.settings.hourlyRate * workHoursPerMonth)
    : 0;
  const workPct = data.threshold > 0 ? Math.round((workMonthly / data.threshold) * 100) : 0;
  const workMissing = Math.max(0, Math.round(data.threshold - workMonthly));
  const requiredRate = workHoursPerMonth > 0 ? data.threshold / workHoursPerMonth : 0;

  // sparkline: self-sufficiency by month, %
  const bars = selfSufficiencyBars(data.months, isBaseline, data.baselineSum);

  const axisTick = { fill: ink.muted, fontSize: 10 };

  return (
    <div className="screen-inner">
      <h1 className="title">Goal</h1>
      {error && <p className="error">Error: {error}</p>}

      <Chips
        label="Goal mode"
        options={GOAL_MODES.map((m) => ({ key: m.key, label: m.label }))}
        selected={data.settings.goalMode}
        onSelect={(k) => patchSettings({ goalMode: k as GoalMode })}
      />

      <div className="goal-split">
        <div className="card" style={{ marginBottom: 10 }}>
          <div className="hero-label">
            {isBaseline
              ? 'To cover your minimum, you need to earn'
              : 'To live without help the way you do now, you need to earn'}
          </div>
          {noGround ? (
            <div className="hero-sub">
              Nothing to work this out from yet — no minimum line items, and no transactions between{' '}
              {data.from} and {data.to}.
            </div>
          ) : (
            <>
              <div className="hero-value">
                ≈ {fmtMoney(data.threshold, cur)} <span className="hero-permonth">per month</span>
              </div>
              <div className="hero-sub">
                your own income now ≈ {fmtMoney(data.ownIncomeAvg, cur)}
                {data.deficit > 0
                  ? ` · short by ${fmtMoney(data.deficit, cur)}`
                  : ' · that covers the threshold'}
              </div>
              {data.externalAvg > 0 && (
                <div className="hero-sub">
                  outside help now ≈ {fmtMoney(data.externalAvg, cur)} per month
                </div>
              )}
            </>
          )}
          {isBaseline ? (
            // the comparison is to a lifestyle figure, and there is none to compare
            // against until a month has been averaged
            data.months.length > 0 ? (
              <div className="hero-compare">
                {`your current lifestyle costs ${fmtMoney(data.lifestyleThreshold, cur)} — ${fmtMoney(
                  Math.abs(lifestyleGap),
                  cur,
                )} ${lifestyleGap < 0 ? 'less' : 'more'} than the minimum`}
              </div>
            ) : null
          ) : fellBack ? (
            <div className="hero-compare">
              You have not entered any minimum line items yet, so these are your current-lifestyle
              figures. Add the first one below to see your minimum.
            </div>
          ) : data.baselineSum > 0 ? (
            <div className="hero-compare">
              {`the bare minimum is only ${fmtMoney(data.baselineThreshold, cur)} per month`}
            </div>
          ) : null}

          {/* self-sufficiency progress */}
          {!noGround && (
            <>
              <div className="track">
                <div
                  className="track-fill"
                  style={{
                    width: `${Math.min(100, pct)}%`,
                    background: pct >= 100 ? ink.good : ink.accent,
                  }}
                />
              </div>
              <div className="progress-label">
                self-sufficiency {pct}% {pct >= 100 ? '— goal reached 🎉' : ''}
              </div>
            </>
          )}
        </div>

        <div>
          {bars.length > 0 && (
            <>
              <h2 className="block-title" style={{ marginTop: 0 }}>
                Self-sufficiency by month, %
              </h2>
              <div style={{ height: 140 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={bars} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke={ink.grid} strokeDasharray="3 4" vertical={false} />
                    <XAxis
                      dataKey="label"
                      tick={axisTick}
                      axisLine={{ stroke: ink.grid }}
                      tickLine={false}
                    />
                    <YAxis
                      domain={[0, Math.max(110, ...bars.map((b) => b.drawn))]}
                      tickCount={3}
                      tick={axisTick}
                      axisLine={false}
                      tickLine={false}
                      width={36}
                    />
                    {/* the 100% line: at or above it the month paid for itself */}
                    <ReferenceLine y={100} stroke={ink.good} strokeDasharray="4 4" />
                    {/* `actual` and never the value the bar was drawn at: the height is
                        capped at 150 so one big month does not flatten the rest, and a
                        tooltip reading 150% off a month that was 340% is a figure the
                        reader takes away and is wrong */}
                    <Tooltip
                      {...tooltipProps<SelfSufficiencyBar>(ink, 'page', (_value, m) =>
                        m ? tooltipPercent(m.actual) : NO_FIGURE,
                      )}
                    />
                    {/* animation off — see the note in AnalyticsScreen */}
                    <Bar
                      // recharts names a series in the tooltip by its `dataKey` unless
                      // it is given a `name`, and `drawn` is a field of this file's own
                      name="Self-sufficiency"
                      dataKey="drawn"
                      radius={[3, 3, 0, 0]}
                      isAnimationActive={false}
                      maxBarSize={28}
                    >
                      {bars.map((b) => (
                        <Cell key={b.label} fill={b.reached ? ink.good : ink.accent} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </>
          )}
        </div>
      </div>

      <p className="hint">
        {isBaseline ? (
          <>
            Threshold = sum of minimum line items ({fmtMoney(data.baselineSum, cur)}) + a{' '}
            {data.settings.bufferPct}% buffer. Income is the average over {monthsAveraged} ({data.from}{' '}
            — {data.to}).
          </>
        ) : (
          <>
            Threshold = median spending over {monthsAveraged} ({fmtMoney(data.avgSpend, cur)}) + a{' '}
            {data.settings.bufferPct}% buffer. One-off
            purchases are spread across the year
            {data.oneOffMonthly > 0 ? ` (+${fmtMoney(data.oneOffMonthly, cur)}/mo)` : ''}. Window:{' '}
            {data.from} — {data.to}.
          </>
        )}
      </p>

      {wantsBaseline && (
        <>
          <h2 className="block-title">What the minimum is made of (per month)</h2>
          <p className="hint">Click a line item to edit it.</p>
          <div className="legend">
            {data.baselineItems.map((it) =>
              editing === it.label ? (
                <div key={it.id} className="legend-row">
                  <input
                    className="input"
                    style={{ flex: 1, borderColor: ink.accent }}
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && saveBaselineItem(it.label)}
                    inputMode="decimal"
                    autoFocus
                    placeholder={`${cur}/mo`}
                    aria-label={`Amount for ${categoryLabel(it.label)}`}
                  />
                  <button className="btn" onClick={() => saveBaselineItem(it.label)}>
                    OK
                  </button>
                  <button className="btn-danger" onClick={() => removeBaselineItem(it.label)}>
                    Delete
                  </button>
                  <button
                    style={{ color: ink.muted, fontSize: 13, padding: '6px 10px' }}
                    onClick={() => setEditing(null)}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  key={it.id}
                  className="legend-row"
                  onClick={() => {
                    setEditing(it.label);
                    setEditValue(String(it.monthly));
                  }}
                >
                  <span className="dot" style={{ background: categoryColor(it.label) }} />
                  <span className="legend-name">{categoryLabel(it.label)}</span>
                  <span className="legend-pct">
                    {data.baselineSum > 0 ? Math.round((it.monthly / data.baselineSum) * 100) : 0}%
                  </span>
                  <span className="legend-value">{fmtMoney(it.monthly)}</span>
                </button>
              ),
            )}
            {data.baselineItems.length === 0 ? (
              <div className="total-row">
                <span className="legend-name">
                  Nothing here yet. Add what it takes to live on your own: rent, food, transport.
                </span>
              </div>
            ) : (
              <div className="total-row">
                <span className="legend-name">Total</span>
                <span className="legend-value">{fmtMoney(data.baselineSum, cur)}</span>
              </div>
            )}
          </div>
          {adding ? (
            <div className="inline-row" style={{ paddingTop: 10 }}>
              <input
                className="input"
                style={{ borderColor: ink.accent }}
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                autoFocus
                placeholder="Name"
                aria-label="Line item name"
              />
              <input
                className="input input-narrow"
                style={{ borderColor: ink.accent }}
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addBaselineItem()}
                inputMode="decimal"
                placeholder={`${cur}/mo`}
                aria-label="Amount per month"
              />
              <button className="btn" onClick={addBaselineItem}>
                OK
              </button>
              <button
                style={{ color: ink.muted, fontSize: 13, padding: '6px 10px' }}
                onClick={() => {
                  setAdding(false);
                  setNewLabel('');
                  setNewValue('');
                }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              className="btn-link"
              style={{ fontWeight: 600, padding: '12px 0' }}
              onClick={() => setAdding(true)}
            >
              + Add line item
            </button>
          )}
        </>
      )}

      {!isBaseline && (
        <>
          <h2 className="block-title">What the threshold is made of (per month)</h2>
          <div className="legend">
            {data.byCategory.map((c) => (
              <div key={c.category} className="legend-row">
                <span className="dot" style={{ background: categoryColor(c.category) }} />
                <span className="legend-name">{categoryLabel(c.category)}</span>
                <span className="legend-pct">
                  {data.avgSpend > 0 ? Math.round((c.total / data.avgSpend) * 100) : 0}%
                </span>
                <span className="legend-value">{fmtMoney(c.total)}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* in work hours */}
      <h2 className="block-title">In work hours</h2>
      <label className="setting-label" htmlFor="goal-rate">
        Hourly rate, net
      </label>
      <div className="inline-row">
        <input
          id="goal-rate"
          className="input"
          value={rateInput}
          onChange={(e) => setRateInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && saveRate()}
          inputMode="decimal"
          placeholder={`${cur}/hr`}
        />
        <button className="btn" disabled={savingRate} onClick={saveRate}>
          OK
        </button>
      </div>
      <label className="setting-label" htmlFor="goal-hours">
        Work hours per week
      </label>
      <div className="inline-row">
        <input
          id="goal-hours"
          className="input"
          value={hoursInput}
          onChange={(e) => setHoursInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && saveHours()}
          inputMode="decimal"
          placeholder="hours per week"
        />
        <button className="btn" disabled={savingHours} onClick={saveHours}>
          OK
        </button>
      </div>
      {data.settings.hourlyRate ? (
        <div>
          <p className="body-text">
            {fmtMoney(data.settings.hourlyRate, cur)}/hr × {data.settings.hoursCapPerWeek} hr/wk ≈{' '}
            {fmtMoney(workMonthly, cur)}/mo — that's {workPct}% of {thresholdNoun}.
          </p>
          {workMissing > 0 ? (
            <p className="body-text">
              Short by ≈ {fmtMoney(workMissing, cur)}/mo. To cover {thresholdNoun} at{' '}
              {data.settings.hoursCapPerWeek} hr/wk, the rate would need to be ≈{' '}
              {fmtMoney(Math.round(requiredRate), cur)}/hr.
            </p>
          ) : (
            <p className="body-text">That covers {thresholdNoun} 🎉</p>
          )}
        </div>
      ) : (
        <p className="hint">
          Enter your rate and weekly hours — I'll work out your monthly pay and how much falls
          short of {thresholdNoun}.
        </p>
      )}

      {/* what if */}
      <h2 className="block-title">
        {isBaseline ? 'What if you trim the minimum?' : 'What if you cut spending?'}
      </h2>
      <Chips
        label="Scenario"
        options={WHATIF_OPTIONS.map((v) => ({
          key: String(v),
          label: v === 0 ? 'As-is' : `−${v} ${cur}/mo`,
        }))}
        selected={String(whatIf)}
        onSelect={(k) => setWhatIf(parseInt(k, 10))}
      />
      {whatIf > 0 && (
        <p className="body-text">
          {isBaseline ? 'Minimum' : 'Spending'} {fmtMoney(adjBase, cur)} → threshold{' '}
          {fmtMoney(Math.round(adjThreshold), cur)}, shortfall {fmtMoney(Math.round(adjDeficit), cur)}
          {data.hours ? ` (≈ ${Math.ceil(adjDeficit / data.hours.hourlyRate)} hr/mo)` : ''}
          {rentPerMonth > 0 ? `. For comparison: rent is ${fmtMoney(rentPerMonth)} per month.` : '.'}
        </p>
      )}

      {/* formula settings */}
      <h2 className="block-title">Settings</h2>
      <div className="setting-label">Buffer on top of spending, %</div>
      <Chips
        label="Buffer"
        options={BUFFER_OPTIONS.map((v) => ({ key: String(v), label: `${v}%` }))}
        selected={String(data.settings.bufferPct)}
        onSelect={(k) => patchSettings({ bufferPct: parseInt(k, 10) })}
      />
      <div className="setting-label">How many months to average income and spending over</div>
      <Chips
        label="Window"
        options={WINDOW_OPTIONS.map((v) => ({ key: String(v), label: String(v) }))}
        selected={String(data.settings.windowMonths)}
        onSelect={(k) => patchSettings({ windowMonths: parseInt(k, 10) })}
      />
      <div className="bottom-pad" />
    </div>
  );
}
