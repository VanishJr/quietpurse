/**
 * One chart on the workspace: its name, what it is about, the plot, and the numbers a
 * plot cannot be read off exactly.
 *
 * The card is the chart as a PICTURE and carries no controls at all. Editing,
 * duplicating and deleting it are things you do to the chart as an OBJECT, and they
 * live on its tab in the dock — see the header of `ChartDock`. What is left here is the
 * name, the numbers and the plot.
 *
 * Everything that is true of every chart lives here and `ChartPlot` is left drawing.
 * That includes the two things a chart is not allowed to do quietly:
 *
 *  - **A refusal is printed, and no numbers are.** `useChartData` nulls the data
 *    before every load, so there is never a figure on screen from the range the card
 *    is no longer about.
 *  - **A per-account fetch that came back at its cap is said out loud.** The shape
 *    would be a plausible chart of part of the window, which is worse than no chart.
 *
 * ---------------------------------------------------------------------------
 * Nothing else is written on it
 *
 * A subtitle spelling out the spec in words ("All accounts · Income and Expenses · 12
 * monthly ticks") and a footnote about NBU rates and transfers both used to sit here,
 * and both were paragraphs restating what the card already shows. The title names the
 * chart, the figures carry the currency code, the legend names the series, and the
 * account — the one fact none of those held — is in the suggested title instead.
 *
 * What stays is what a reader cannot see: the two refusals above, and the table below.
 * The table is the same idiom `AccountFlows` uses and is there for the same reason: the
 * SVG is not readable, and in jsdom it is not even measurable — recharts sizes itself
 * against a 0x0 box. It is what a screen reader gets, and what a test asserts on.
 */
import { ChartSpec, drawnShares, METRICS, suggestedTitle } from '../analytics';
import { ChartData, useChartData } from '../chartData';
import { fmtMoney } from '../format';
import { Account } from '../types';
import { ChartPlot } from './ChartPlot';

const CHART_HEIGHT = 300;

interface Props {
  spec: ChartSpec;
  /** null while the list is still being read — see `useChartData`. */
  accounts: Account[] | null;
  /** ...and why, when it is null because the read failed rather than not finished. */
  accountsError: string | null;
}

export function ChartCard({ spec, accounts, accountsError }: Props) {
  const { data, error, loading } = useChartData(spec, accounts, accountsError);

  /*
   * The id and not "some account": a chart whose account has been deleted is a state
   * `useChartData` refuses in words, and a name invented here would sit above that
   * refusal contradicting it.
   */
  const account = spec.accountId ? accounts?.find((a) => a.id === spec.accountId) : undefined;
  const title = spec.title || suggestedTitle(spec, account?.name ?? null);

  return (
    <section className="chart-card" aria-label={title}>
      <h2 className="block-title chart-title">{title}</h2>

      {error && <p className="error">Error: {error}</p>}
      {loading && <p className="hint chart-loading">Reading the numbers…</p>}

      {data?.truncated && (
        <p className="error">
          More transactions here than one request returns — this is part of the window, not
          all of it.
        </p>
      )}

      {data && (
        <>
          <Figures spec={spec} data={data} />
          <ChartPlot spec={spec} data={data} height={CHART_HEIGHT} />
          <DataTable spec={spec} data={data} title={title} />
        </>
      )}
    </section>
  );
}

/**
 * The two or three figures the chart is about, above it.
 *
 * A plot answers "what shape" and these answer "how much", and a card that carries
 * only the first sends the reader to hover over an SVG to find out what a bar is
 * worth. For a series that is each measure's total across the window; for a share it
 * is the total and the largest part of it, which is the sentence somebody reads a
 * donut to arrive at anyway.
 */
function Figures({ spec, data }: { spec: ChartSpec; data: ChartData }) {

  if (data.shape === 'series') {
    const drawn = METRICS.filter((m) => spec.metrics.includes(m.key));
    // no measures picked: the plot says so, and a row of nought boxes above it would
    // be a gap the reader has to work out the meaning of
    if (drawn.length === 0) return null;
    return (
      <div className="chart-figs">
        {drawn.map((m) => {
          const total = data.points.reduce((sum, p) => sum + p[m.key], 0);
          return (
            <div key={m.key} className="chart-fig">
              <div className="chart-fig-label">{m.label}, total</div>
              <div className="chart-fig-value">{fmtMoney(total, data.currency)}</div>
            </div>
          );
        })}
      </div>
    );
  }

  /*
   * The parts the PLOT drew, which on a donut or a radar is not all of them — see
   * `drawnShares`. Summing every slice here put a total on the card that the figure in
   * the donut's own hole disagreed with, and then divided the largest part by it: food
   * 500 against a refunded shopping of −450 read "Total 50" over "Largest, Food —
   * 500 · 1000%". Sorted biggest-first at the source, and a filter keeps that.
   */
  const drawn = drawnShares(spec.kind, data.slices);
  const total = drawn.reduce((sum, s) => sum + s.value, 0);
  const biggest = drawn[0];
  /*
   * ...and the ranking is the half of that sentence the filter does not reach. It KEEPS
   * its negative bars — a bar chart has a baseline and can draw one — so its total is a
   * NET while the largest part is a gross positive, and the same 500 against −450 went
   * on printing "Total 50" over "Largest, Food — 500 · 1000%" here long after the donut
   * had stopped.
   *
   * A percentage needs a whole that the part is part of, and a net is not one. So the
   * ranking prints the two figures and says nothing about the share, rather than a
   * number that is arithmetic on two sums that do not belong together. The donut and
   * the radar reach this with the negatives already gone and are unchanged.
   */
  const isWhole = total > 0 && drawn.every((s) => s.value >= 0);
  return (
    <div className="chart-figs">
      <div className="chart-fig">
        <div className="chart-fig-label">Total</div>
        <div className="chart-fig-value">{fmtMoney(total, data.currency)}</div>
      </div>
      {biggest && (
        <div className="chart-fig">
          <div className="chart-fig-label">Largest, {biggest.label}</div>
          <div className="chart-fig-value">
            {fmtMoney(biggest.value, data.currency)}
            {isWhole && (
              <span className="chart-fig-pct"> · {Math.round((biggest.value / total) * 100)}%</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** The plot's numbers, for a reader who gets no plot. Never on screen. */
function DataTable({
  spec,
  data,
  title,
}: {
  spec: ChartSpec;
  data: ChartData;
  /** The card's own, so the caption and the heading above it cannot disagree. */
  title: string;
}) {
  if (data.shape === 'series') {
    const drawn = METRICS.filter((m) => spec.metrics.includes(m.key));
    return (
      <table className="visually-hidden">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">Period</th>
            {drawn.map((m) => (
              <th key={m.key} scope="col">
                {m.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.points.map((p) => (
            <tr key={p.tick}>
              <th scope="row">{p.tick}</th>
              {drawn.map((m) => (
                <td key={m.key}>{fmtMoney(p[m.key], data.currency)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  // a comparative kind's table carries both windows; the others carry the one they drew
  const rows = data.compared;
  if (rows) {
    return (
      <table className="visually-hidden">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">Part</th>
            <th scope="col">This period</th>
            <th scope="col">The one before</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th scope="row">{r.label}</th>
              <td>{fmtMoney(r.now, data.currency)}</td>
              <td>{fmtMoney(r.before, data.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  // the parts that were drawn and not every part there is: this table stands IN for the
  // plot, so a donut that dropped a refunded category has to drop it here too or the
  // two readers of this card are given different rows and a total that fits neither
  return (
    <table className="visually-hidden">
      <caption>{title}</caption>
      <thead>
        <tr>
          <th scope="col">Part</th>
          <th scope="col">Amount</th>
        </tr>
      </thead>
      <tbody>
        {drawnShares(spec.kind, data.slices).map((s) => (
          <tr key={s.key}>
            <th scope="row">{s.label}</th>
            <td>{fmtMoney(s.value, data.currency)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
