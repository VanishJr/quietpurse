/**
 * The Analytics workspace's model: what a chart IS, and what its numbers are.
 *
 * The screen used to be one analysis, wired straight into the two endpoints that
 * answer it — a period pager, two total cards, a donut and twelve bars, in that order,
 * for everybody. It is a workspace now: the reader builds the charts they want, each
 * one a `ChartSpec`, and the screen draws whatever specs exist. So the questions the
 * old screen answered by being shaped that way — which measure, over which window, for
 * which account — are values in an object here, and the arithmetic that answers them
 * is a pure function of data the caller already fetched.
 *
 * Pure on purpose. Nothing in this file fetches, reads the clock or touches React:
 * `today` is always an argument, so every series below can be asserted against a fixed
 * date, and `chartData.ts` is the one place that turns a spec into requests.
 *
 * ---------------------------------------------------------------------------
 * Two shapes, and the difference is not cosmetic
 *
 * A `series` chart plots measures ACROSS ticks — income over twelve months. A `share`
 * chart plots one period's parts AGAINST each other — where the money went. They take
 * different data, ask different endpoints and are configured by different questions,
 * and `CHART_KINDS` is what says which a kind is, so the wizard and the loader read one
 * answer rather than each keeping a list of names.
 *
 * ---------------------------------------------------------------------------
 * Cents, everywhere
 *
 * Every amount here came off `*_cents` on the server and was divided by a hundred on
 * the way out, so summing the doubles back up accumulates the residue — see `toCents`
 * in accounts.ts, which is imported rather than copied for exactly that reason. Every
 * sum below is accumulated as an integer and divided once at the end.
 */
import { monthOf, toCents } from './accounts';
import { categoryLabel } from './categories';
import { isoDay, MONTHS_SHORT } from './format';
import { CategorySummary, IncomeSourceTotal } from './types';

// ---------------------------------------------------------------------------
// the vocabulary
// ---------------------------------------------------------------------------

export type ChartKind = 'line' | 'column' | 'area' | 'donut' | 'ranking' | 'radar';

/** Measures across ticks, or the parts of one period. See the header. */
export type ChartShape = 'series' | 'share';

/** What a series chart plots. `net` is income minus expenses — the bottom line. */
export type Metric = 'income' | 'expense' | 'net';

/** What a share chart splits a period by. */
export type Breakdown = 'expense-categories' | 'income-categories' | 'income-sources';

export type RangeKey = '3m' | '6m' | '12m' | '24m' | '3y' | '5y';

/** A tick is a calendar month or a calendar year; nothing here plots days. */
export type Grain = 'month' | 'year';

export interface ChartKindDef {
  key: ChartKind;
  name: string;
  /** One line in the picker: what this shape is FOR, not what it looks like. */
  blurb: string;
  shape: ChartShape;
  /**
   * The kind draws the chosen period beside the one before it, so its loader has to
   * fetch both. Only the radar does, and it is the whole of why that kind exists —
   * a single polygon says no more than the ranking beside it in the picker does.
   */
  comparative?: true;
}

export const CHART_KINDS: ChartKindDef[] = [
  {
    key: 'line',
    name: 'Line',
    shape: 'series',
    blurb: 'A measure over time. The shape of the trend, read at a glance.',
  },
  {
    key: 'column',
    name: 'Column',
    shape: 'series',
    blurb: 'One bar per tick. For reading single months off against each other.',
  },
  {
    key: 'area',
    name: 'Area',
    shape: 'series',
    blurb: 'The line with the ground filled in — volume rather than direction.',
  },
  {
    key: 'donut',
    name: 'Donut',
    shape: 'share',
    blurb: 'What a period is made of, as shares of one total.',
  },
  {
    key: 'ranking',
    name: 'Ranking',
    shape: 'share',
    blurb: 'The same parts as bars, biggest first — the easiest to read exactly.',
  },
  {
    key: 'radar',
    name: 'Radar',
    shape: 'share',
    comparative: true,
    blurb: 'The shape of a period laid over the one before it. For what changed.',
  },
];

export const chartKind = (key: ChartKind): ChartKindDef =>
  CHART_KINDS.find((k) => k.key === key) ?? CHART_KINDS[0];

export interface MetricDef {
  key: Metric;
  label: string;
  /**
   * The palette key its stroke and its swatch both read. A key rather than a colour
   * because the two schemes have two palettes and a literal here would be right in
   * one of them.
   */
  ink: 'good' | 'accent' | 'net';
}

export const METRICS: MetricDef[] = [
  { key: 'income', label: 'Income', ink: 'good' },
  { key: 'expense', label: 'Expenses', ink: 'accent' },
  { key: 'net', label: 'Net', ink: 'net' },
];

export interface BreakdownDef {
  key: Breakdown;
  label: string;
  /**
   * Whether the wizard offers it for one account. Not a limit of the API: `/api/summary`
   * has taken an `accountId` since row 48 and answers that account's own income by
   * source, off the same `scopeSql` every other figure is filtered through. This is a
   * product decision left open — whether a split by the workspace's income sources is a
   * question worth asking of one account — and until it is answered the wizard drops
   * the choice when an account is picked rather than offering what nobody has ruled on.
   */
  workspaceOnly?: true;
}

export const BREAKDOWNS: BreakdownDef[] = [
  { key: 'expense-categories', label: 'Expenses by category' },
  { key: 'income-categories', label: 'Income by category' },
  { key: 'income-sources', label: 'Income by source', workspaceOnly: true },
];

export interface RangeDef {
  key: RangeKey;
  label: string;
  grain: Grain;
  /** How many ticks, ending at the one `today` is in. */
  count: number;
}

export const RANGES: RangeDef[] = [
  { key: '3m', label: '3 months', grain: 'month', count: 3 },
  { key: '6m', label: '6 months', grain: 'month', count: 6 },
  { key: '12m', label: '12 months', grain: 'month', count: 12 },
  { key: '24m', label: '24 months', grain: 'month', count: 24 },
  { key: '3y', label: '3 years', grain: 'year', count: 3 },
  { key: '5y', label: '5 years', grain: 'year', count: 5 },
];

export const rangeDef = (key: RangeKey): RangeDef =>
  RANGES.find((r) => r.key === key) ?? RANGES[2];

/**
 * One chart on the screen, and the whole of what is remembered about it.
 *
 * `metrics` and `breakdown` are both present whatever the kind is, and only one of
 * them is read. That is deliberate: switching a chart from a donut to a line in the
 * wizard keeps the measures it had, so a reader who picked the wrong shape does not
 * lose the rest of the answer on the way back.
 */
export interface ChartSpec {
  id: string;
  kind: ChartKind;
  /** What the tab says. The reader's, and never rewritten under them. */
  title: string;
  /** null — every account together, which is what the summary endpoints answer. */
  accountId: string | null;
  /**
   * Series charts. May be empty while the reader is between two choices in the wizard —
   * the chips enforce no minimum — and a spec in that state cannot be saved. Anything
   * that draws one says so; see `ChartPlot`.
   */
  metrics: Metric[];
  /** Share charts. */
  breakdown: Breakdown;
  range: RangeKey;
}

// ---------------------------------------------------------------------------
// ticks and bounds
// ---------------------------------------------------------------------------

/**
 * The ticks a range asks for, oldest first — `YYYY-MM` on a month grain, `YYYY` on a
 * year one.
 *
 * They end at the tick `today` is in and not at the newest tick with data in it,
 * which is the opposite of what `windowMonths` does on the Overview and is the right
 * answer here for the opposite reason: this axis is a window the reader chose, so a
 * month with nothing in it is part of the answer ("we spent nothing in June"), where
 * there the window is derived from the data and a leading empty bar would be a claim
 * about a month that predates the first statement.
 */
export function ticksOf(range: RangeDef, today: Date): string[] {
  const out: string[] = [];
  if (range.grain === 'year') {
    const last = today.getFullYear();
    for (let y = last - (range.count - 1); y <= last; y += 1) out.push(String(y));
    return out;
  }
  for (let i = range.count - 1; i >= 0; i -= 1) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

/**
 * Whether an axis of these ticks has to name the year — see `tickLabel`.
 *
 * A property of the WINDOW and not of any tick in it, which is why the whole list is
 * the argument. Year ticks carry their year already and answer true here harmlessly.
 */
const spansYears = (ticks: string[]): boolean =>
  new Set(ticks.map((t) => t.slice(0, 4))).size > 1;

/**
 * What a tick is called on the axis: "Aug" for a month, "2026" for a year — and
 * "Aug 25" for a month in a window that crosses one.
 *
 * 24 months is two Augusts, and so is nearly every 12-month window, the default among
 * them: only one ending in December does not cross a year. Labelled by the month name
 * alone they were the same word twice on the axis and again in the tooltip, which is
 * where recharts echoes whatever `XAxis dataKey` names — and there is nothing else on
 * the card to tell them apart, since the subtitle spelling the range out was taken off
 * it deliberately.
 *
 * Two digits of year and not four. It is the form that fits: at eleven pixels "Sep 2025"
 * is most of the width one of twelve ticks has, and recharts answers a label too wide to
 * place by dropping it. Read as a column of them in date order the suffix cannot be
 * anything but a year.
 *
 * The hidden table under the plot is unaffected either way — it prints `tick` itself,
 * which has always been the whole `YYYY-MM`.
 */
export const tickLabel = (tick: string, grain: Grain, withYear = false): string => {
  if (grain === 'year') return tick;
  const name = MONTHS_SHORT[Number(tick.slice(5, 7)) - 1];
  if (!name) return tick;
  return withYear ? `${name} ${tick.slice(2, 4)}` : name;
};

/** The tick a `YYYY-MM-DD` or `YYYY-MM` falls in. */
export const tickOf = (isoDate: string, grain: Grain): string =>
  grain === 'year' ? isoDate.slice(0, 4) : monthOf(isoDate);

export interface Bounds {
  from: string;
  to: string;
}

/** The calendar days the range covers, inclusive — what the endpoints take. */
export function boundsOf(range: RangeDef, today: Date): Bounds {
  if (range.grain === 'year') {
    const last = today.getFullYear();
    return {
      from: isoDay(new Date(last - (range.count - 1), 0, 1)),
      to: isoDay(new Date(last, 11, 31)),
    };
  }
  const first = new Date(today.getFullYear(), today.getMonth() - (range.count - 1), 1);
  return {
    from: isoDay(first),
    // day 0 of the next month is the last day of this one, leap years included
    to: isoDay(new Date(today.getFullYear(), today.getMonth() + 1, 0)),
  };
}

/**
 * The same length of window immediately before it — what a comparative kind is drawn
 * against. Built by moving `today` back a whole range and asking `boundsOf` again, so
 * the two windows are the same shape by construction rather than by two sums agreeing.
 */
export function priorBoundsOf(range: RangeDef, today: Date): Bounds {
  const shifted =
    range.grain === 'year'
      ? new Date(today.getFullYear() - range.count, today.getMonth(), 1)
      : new Date(today.getFullYear(), today.getMonth() - range.count, 1);
  return boundsOf(range, shifted);
}

// ---------------------------------------------------------------------------
// series: measures across ticks
// ---------------------------------------------------------------------------

export interface SeriesPoint {
  /** `YYYY-MM` or `YYYY` — the identity, which is what a key is taken from. */
  tick: string;
  /** What the axis prints. */
  label: string;
  income: number;
  expense: number;
  /**
   * Income minus expenses, and NOT the `net` the summary endpoints answer with. That
   * one sums every row including transfers, because it exists to be compared against a
   * balance; this is the bottom line of a period, and a transfer between two of your
   * own accounts must not move it.
   */
  net: number;
}

const point = (
  tick: string,
  grain: Grain,
  /** Whether the window this tick belongs to crosses a year — see `tickLabel`. */
  withYear: boolean,
  incomeCents: number,
  expenseCents: number,
): SeriesPoint => ({
  tick,
  label: tickLabel(tick, grain, withYear),
  income: incomeCents / 100,
  expense: expenseCents / 100,
  net: (incomeCents - expenseCents) / 100,
});

/**
 * What a series is built from: one month's income and its expenses, and nothing else.
 *
 * Deliberately not `MonthTotals`, and deliberately without `net`. Both summary
 * endpoints answer a month shape and only one of the two carries a `net` — the account
 * arm's, which is every row of the month summed, transfers included, so that the months
 * add up to the balance beside them. It is not this chart's net, and this type is what
 * stops it being read: the field is not in scope inside the function.
 */
export interface MonthFlows {
  /** YYYY-MM */
  month: string;
  income: number;
  expense: number;
}

/**
 * `/api/summary/months` folded onto the ticks, whichever arm answered it. A month the
 * endpoint did not answer is a tick at zero, which is the true statement here — see
 * `ticksOf`.
 */
export function seriesFromMonths(
  months: MonthFlows[],
  ticks: string[],
  grain: Grain,
): SeriesPoint[] {
  const income = new Map<string, number>();
  const expense = new Map<string, number>();
  for (const m of months) {
    const tick = tickOf(m.month, grain);
    income.set(tick, (income.get(tick) ?? 0) + toCents(m.income));
    expense.set(tick, (expense.get(tick) ?? 0) + toCents(m.expense));
  }
  const withYear = spansYears(ticks);
  return ticks.map((t) => point(t, grain, withYear, income.get(t) ?? 0, expense.get(t) ?? 0));
}

// ---------------------------------------------------------------------------
// share: the parts of one period
// ---------------------------------------------------------------------------

export interface SharePoint {
  /** The backend slug (or source id) — the colour and the React key are taken from it. */
  key: string;
  label: string;
  value: number;
}

/**
 * A refund can push a category negative — the purchase was in an earlier period, the
 * refund landed in this one — and that is the honest figure. It is kept out of the
 * shares a donut or a radar draws, because a negative sector is not a thing, and the
 * ranking prints it: a bar chart has a baseline and can show one.
 */
export const positiveShares = (shares: SharePoint[]): SharePoint[] =>
  shares.filter((s) => s.value > 0);

/**
 * The parts a kind actually draws.
 *
 * The rule above, read from the kind's side, and in one place because three different
 * files were answering "what is this chart of" and were free to disagree. They did: a
 * card summed every slice for its "Total" while the donut in the middle of it summed
 * only the positive ones, so one refunded category put two different totals on the same
 * card — and divided the largest part by the smaller of them, which printed 1000%.
 */
export const drawnShares = (kind: ChartKind, shares: SharePoint[]): SharePoint[] =>
  kind === 'ranking' ? shares : positiveShares(shares);

const fromCategories = (rows: { category: string; total: number }[]): SharePoint[] =>
  rows
    .map((c) => ({ key: c.category, label: categoryLabel(c.category), value: c.total }))
    .sort((a, b) => b.value - a.value);

/**
 * The three splits both summary bodies answer, and the only ones a share chart reads.
 *
 * A minimum both arms meet rather than either body's own type: `/api/summary` answers
 * the whole workspace in the base currency and one account in its own, and a share is
 * the same arithmetic over either.
 */
export interface SummarySplits {
  byCategory: CategorySummary[];
  incomeByCategory: CategorySummary[];
  incomeBySource: IncomeSourceTotal[];
}

export function shareFromSummary(summary: SummarySplits, breakdown: Breakdown): SharePoint[] {
  if (breakdown === 'income-sources') {
    return summary.incomeBySource
      .map((s) => ({ key: s.source, label: s.label, value: s.total }))
      .sort((a, b) => b.value - a.value);
  }
  return fromCategories(
    breakdown === 'income-categories' ? summary.incomeByCategory : summary.byCategory,
  );
}

/**
 * The two periods on one axis, for a comparative kind.
 *
 * Every slice either side gets a row — a category that exists only in the prior period
 * is exactly what the chart is being asked about — and the order is the CURRENT
 * period's, biggest first, so the polygon the reader came for is the one the axis is
 * arranged around.
 */
export interface ComparedPoint {
  key: string;
  label: string;
  now: number;
  before: number;
}

export function compareShares(now: SharePoint[], before: SharePoint[]): ComparedPoint[] {
  const priorByKey = new Map(before.map((s) => [s.key, s.value]));
  const rows: ComparedPoint[] = now.map((s) => ({
    key: s.key,
    label: s.label,
    now: s.value,
    before: priorByKey.get(s.key) ?? 0,
  }));
  const seen = new Set(now.map((s) => s.key));
  for (const s of before) {
    if (!seen.has(s.key)) rows.push({ key: s.key, label: s.label, now: 0, before: s.value });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// naming a chart
// ---------------------------------------------------------------------------

const metricLabel = (m: Metric): string => METRICS.find((d) => d.key === m)?.label ?? m;

const breakdownLabel = (b: Breakdown): string =>
  BREAKDOWNS.find((d) => d.key === b)?.label ?? b;

/**
 * What a ranking's bars are called when a reader points at one. A ranking has no
 * single `metric` — it is one breakdown's rows — so the word comes from the breakdown,
 * out of the same `METRICS` vocabulary every other series in this file is named from.
 * Without a name recharts prints the series' `dataKey` instead: `value : 1,082 EUR`.
 */
export const rankingSeriesName = (b: Breakdown): string =>
  metricLabel(b === 'expense-categories' ? 'expense' : 'income');

/** A list a person reads: "Income", "Income and Expenses", "Income, Expenses and Net". */
export function joinWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/**
 * What a chart is called when the reader has not named it.
 *
 * A suggestion and not a binding: the wizard puts it in the name box, the reader is
 * free to type over it, and nothing recomputes it afterwards. A title that rewrote
 * itself when the range changed would take away the one part of the tab strip the
 * reader owns.
 *
 * `accountName` is here because the card no longer carries a line spelling the spec out
 * underneath it — that was a sentence restating what the title, the figures and the
 * legend already showed. Which account a chart is about was the one fact none of those
 * three held, so it goes into the name instead: a chart of everything is
 * "Expenses · 12 months" and a chart of one account says so first.
 *
 * The name and not the id, so it is handed in: this module knows nothing about the
 * account list.
 */
export function suggestedTitle(
  spec: Omit<ChartSpec, 'id' | 'title'>,
  accountName?: string | null,
): string {
  const what =
    chartKind(spec.kind).shape === 'series'
      ? joinWords(spec.metrics.map(metricLabel))
      : breakdownLabel(spec.breakdown);
  const where = spec.accountId && accountName ? `${accountName} · ` : '';
  return `${where}${what} · ${rangeDef(spec.range).label}`;
}

// ---------------------------------------------------------------------------
// what is remembered
// ---------------------------------------------------------------------------

/**
 * The charts are the workspace's, kept on the server and read back through
 * `GET`/`PUT /api/analytics/charts`. They follow the reader to a second device, and
 * the tab strip is still the saved state — there is no save button, every change to
 * the list is a write.
 *
 * They lived in localStorage and nowhere else until row 052. The key is read once
 * more, by the migration in `AnalyticsScreen`, and written by nothing: after that
 * read it is removed, and the only copy of a chart is the one the server holds.
 *
 * What is here rather than in `api.ts` is what the route's door is made of — the
 * bounds it refuses past and the shape a stored object has to have — because both
 * are facts about a chart rather than about a request.
 */
const LEGACY_KEY = 'finto.analytics.charts';

/**
 * The four lengths the charts route refuses past.
 *
 * EQUAL to the server's own (`backend/src/db/index.ts`), never merely under them: a
 * client bound below the server's silently truncates what the server would have
 * taken, and one above it composes a list the server refuses whole — and the refusal
 * is of the WHOLE list, so one over-long title is a workspace that never saves again.
 * `backend/test/charts-door.test.ts` reads this file as source and holds the pair.
 */
export const CHARTS_MAX = 100;
export const CHART_TITLE_MAX = 120;
export const CHART_ID_MAX = 64;
export const CHART_ACCOUNT_ID_MAX = 64;

const KINDS = new Set<string>(CHART_KINDS.map((k) => k.key));
const METRIC_KEYS = new Set<string>(METRICS.map((m) => m.key));
const BREAKDOWN_KEYS = new Set<string>(BREAKDOWNS.map((b) => b.key));
const RANGE_KEYS = new Set<string>(RANGES.map((r) => r.key));

/**
 * One stored object, checked field by field, or null.
 *
 * Nothing that arrives here can be trusted into a `ChartSpec` on the strength of
 * having parsed: it was written by an older version of this file, by a hand-edited
 * backup, or by a version of the app whose vocabulary is wider than this one's. A
 * throw would take the whole screen down on first paint, so a shape this version does
 * not recognise answers null — and `chartEntry` below is what decides what happens to
 * it, which is no longer "it is dropped".
 */
function parseChart(raw: unknown): ChartSpec | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  /*
   * An empty id is READ rather than refused, unlike every other field here. `id` is
   * `notNull` text with no CHECK behind it, so `restoreBackup` lets `''` into the table
   * and the next GET carries it out — and it is the only shape a stored row can take
   * that this parser could refuse while the route still refuses to take it back. Refused
   * here it would be unreadable, therefore never re-minted, therefore sent back as it
   * came and refused with the WHOLE list: a workspace that never saves again. Read, it
   * fails `ID_SHAPE` in `normaliseForSave` exactly as `a b/c` does and is re-minted.
   */
  if (typeof o.id !== 'string') return null;
  if (typeof o.kind !== 'string' || !KINDS.has(o.kind)) return null;
  if (typeof o.range !== 'string' || !RANGE_KEYS.has(o.range)) return null;
  if (typeof o.title !== 'string') return null;
  if (o.accountId !== null && typeof o.accountId !== 'string') return null;
  const metrics = Array.isArray(o.metrics)
    ? o.metrics.filter((m): m is Metric => typeof m === 'string' && METRIC_KEYS.has(m))
    : [];
  const breakdown =
    typeof o.breakdown === 'string' && BREAKDOWN_KEYS.has(o.breakdown)
      ? (o.breakdown as Breakdown)
      : 'expense-categories';
  return {
    id: o.id,
    kind: o.kind as ChartKind,
    title: o.title,
    accountId: o.accountId as string | null,
    /*
     * An empty list is kept empty. It used to fall back to `['expense']`, which was a
     * silent substitution of one chart for another — and it stopped being defensible
     * the moment the wizard let a reader clear every measure: "no measure is picked" is
     * now a state the app has words for, on the plot and under the chips, and the
     * chart is not saveable until it is out of it. A stored row arrives at the same
     * sentence rather than at a chart nobody asked for.
     */
    metrics,
    breakdown,
    range: o.range as RangeKey,
  };
}

/**
 * One position on the saved list: a chart this client can draw, or one it cannot.
 *
 * The second arm is not a defensive nicety. `parseChart`'s "drop the row" policy was
 * right while the list was one browser's — the loss was that browser's. The list is
 * the workspace's now, so a row this version cannot read, dropped here, is carried
 * out of the next PUT and **deleted from every device**, by a client that never
 * showed it to anybody. It is kept where it was, sent back verbatim, and named on
 * screen instead.
 */
export type ChartEntry = { known: true; spec: ChartSpec } | { known: false; raw: unknown };

export const chartEntry = (raw: unknown): ChartEntry => {
  const spec = parseChart(raw);
  return spec === null ? { known: false, raw } : { known: true, spec };
};

/** What goes on the wire for one position — the spec, or the row as it arrived. */
export const entryWire = (entry: ChartEntry): unknown => (entry.known ? entry.spec : entry.raw);

/** The charts that can be drawn, in list order. The dock is built from these. */
export const entrySpecs = (entries: ChartEntry[]): ChartSpec[] =>
  entries.flatMap((e) => (e.known ? [e.spec] : []));

/** The id `chartSchema` accepts: the URL names a chart by it, unescaped. */
const ID_SHAPE = /^[A-Za-z0-9._~-]+$/;

/** What `normaliseForSave` had to change, so the screen can say so. */
export interface Normalised {
  entries: ChartEntry[];
  /** Past `CHARTS_MAX`, so not sent at all — the one place a chart is lost. */
  droppedOverCap: number;
  titlesShortened: number;
  idsReminted: number;
  accountIdsTruncated: number;
}

const rawId = (raw: unknown): string | null => {
  const id = (raw as { id?: unknown } | null)?.id;
  return typeof id === 'string' ? id : null;
};

/**
 * The list, cut to what the route will take.
 *
 * Every save goes through this and not only the migration, because the door is wider
 * on the way in than on the way out: `restoreBackup` type-checks a column and cannot
 * see a zod schema, so a 5 000-character title reaches the table, comes back on the
 * next GET, and — untouched — fails `CHART_TITLE_MAX` on the way back out. That
 * refuses the reader's WHOLE list, for ever, over a title they never typed. Cutting
 * it is an edit to their content and is the smaller harm, which is why the caller
 * says out loud what was cut.
 *
 * Nothing is dropped except past the cap. An id that is illegal, over-long or
 * repeated is re-minted rather than deleted: the id is opaque, only `?chart=` reads
 * it, and the URL already falls back when it names a chart that is not there. An
 * over-long `accountId` is truncated rather than nulled — over 64 characters it names
 * no account either way and the card says so, where nulling it would turn one
 * account's chart into the whole workspace's under its old title.
 *
 * The cut counts unreadable rows too. The server counts them, so a client that
 * trimmed only what it can read would compose a list of 101 and be refused whole.
 */
export function normaliseForSave(entries: ChartEntry[]): Normalised {
  const kept = entries.slice(0, CHARTS_MAX);
  // the unreadable rows' ids are claimed up front: they are not re-minted (nothing
  // here may rewrite a row it cannot read), so a readable row must give way to them
  const seen = new Set<string>();
  for (const entry of kept) {
    if (entry.known) continue;
    const id = rawId(entry.raw);
    if (id !== null) seen.add(id);
  }

  let titlesShortened = 0;
  let idsReminted = 0;
  let accountIdsTruncated = 0;

  const out = kept.map((entry): ChartEntry => {
    if (!entry.known) return entry;
    const spec = entry.spec;

    let id = spec.id;
    if (id.length > CHART_ID_MAX || !ID_SHAPE.test(id) || seen.has(id)) {
      id = newChartId();
      idsReminted++;
    }
    seen.add(id);

    let title = spec.title;
    if (title.length > CHART_TITLE_MAX) {
      title = title.slice(0, CHART_TITLE_MAX);
      titlesShortened++;
    }

    let accountId = spec.accountId;
    if (accountId !== null && accountId.length > CHART_ACCOUNT_ID_MAX) {
      accountId = accountId.slice(0, CHART_ACCOUNT_ID_MAX);
      accountIdsTruncated++;
    }

    /* Uncounted, unlike the three above: the vocabulary is closed and the chips are
       toggles, so a repeated measure is not something a reader composed and draws
       identically once it is gone. The route refuses it all the same. */
    const metrics = [...new Set(spec.metrics)];

    return { known: true, spec: { ...spec, id, title, accountId, metrics } };
  });

  return {
    entries: out,
    droppedOverCap: entries.length - kept.length,
    titlesShortened,
    idsReminted,
    accountIdsTruncated,
  };
}

/**
 * What this browser saved back when the charts were this browser's. Read once, by the
 * migration, and only for a workspace that has never saved — see `AnalyticsScreen`.
 */
export function readLegacyCharts(): ChartSpec[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LEGACY_KEY);
  } catch {
    // a browser with storage denied has nothing to migrate, and that is a whole answer
    return [];
  }
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(parseChart).filter((c): c is ChartSpec => c !== null);
  } catch {
    return [];
  }
}

/** Called only after the migration's PUT came back 200. */
export function clearLegacyCharts(): void {
  try {
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    // storage denied: there was nothing to read either, so there is nothing to clear
  }
}

/**
 * A fresh id. Not `crypto.randomUUID`, which is not everywhere this app runs, and not
 * an index — an index is reused the moment a chart is deleted, and the URL remembers
 * which tab was open.
 */
export const newChartId = (): string =>
  `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** The chart the wizard starts from once a shape has been picked. */
export function blankChart(kind: ChartKind): ChartSpec {
  const draft = {
    kind,
    accountId: null,
    metrics: ['expense'] as Metric[],
    breakdown: 'expense-categories' as Breakdown,
    range: '12m' as RangeKey,
  };
  return { id: newChartId(), title: suggestedTitle(draft), ...draft };
}
