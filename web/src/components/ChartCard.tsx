/**
 * `ChartCard` carries no control, for the reason `web/src/SPEC.md` gives under *What a
 * chart is, and where its numbers come from*.
 *
 * **A refusal is printed, and no numbers are.** `useChartData` nulls the data before
 * every load, so there is never a figure on screen from the range the card is no
 * longer about.
 *
 * No footnote says how amounts are converted or what is counted, deliberately: the
 * screen is a strip of charts that do not share a unit — a per-account chart answers
 * in its own account's currency — so a rule stated once at the foot would be a rule
 * about whichever chart happened to be showing.
 */
import { drawnShares, METRICS, suggestedTitle } from '../analytics';
import { ChartData, useChartData } from '../chartData';
import { fmtMoney } from '../format';
import { Account, Chart } from '../types';
import { ChartPlot } from './ChartPlot';

const CHART_HEIGHT = 300;

interface Props {
  spec: Chart;
  /** null while the list is still being read — see `useChartData`. */
  accounts: Account[] | null;
  /** ...and why, when it is null because the read failed rather than not finished. */
  accountsError: string | null;
  dataRevision?: number;
}

export function ChartCard({ spec, accounts, accountsError, dataRevision = 0 }: Props) {
  const { data, error, loading } = useChartData(
    spec,
    accounts,
    accountsError,
    dataRevision,
  );

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

      {data && (
        <>
          <Figures spec={spec} data={data} />
          <ChartPlot spec={spec} data={data} height={CHART_HEIGHT} ground="surface" />
          <DataTable spec={spec} data={data} title={title} />
        </>
      )}
    </section>
  );
}

/**
 * A plot answers "what shape" and the figures answer "how much", and a card that
 * carries only the first sends the reader to hover over an SVG to find out what a bar
 * is worth.
 */
function Figures({ spec, data }: { spec: Chart; data: ChartData }) {

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
   * `drawnShares`. Sorted biggest-first at the source, and a filter keeps that.
   */
  const drawn = drawnShares(spec.kind, data.slices);
  const total = drawn.reduce((sum, s) => sum + s.value, 0);
  const biggest = drawn[0];
  /*
   * ...and the ranking is the part the filter does not reach. It KEEPS its negative
   * bars — a bar chart has a baseline and can draw one — so its total is a NET while
   * the largest part is a gross positive.
   *
   * A percentage needs a whole that the part is part of, and a net is not one. So the
   * ranking prints the two figures and says nothing about the share, rather than a
   * number that is arithmetic on two sums that do not belong together. The donut and
   * the radar reach this with the negatives already gone.
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

function DataTable({
  spec,
  data,
  title,
}: {
  spec: Chart;
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
