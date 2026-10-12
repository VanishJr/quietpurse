import type { ReactNode } from 'react';
import { BREAKDOWN_DEFS, type Bounds, chartKind, drawnShares, METRICS, rangeDef, suggestedTitle } from '../analytics';
import { ChartData, useChartData } from '../chartData';
import { fmtDay, fmtMoney } from '../format';
import { Notice } from './Notice';
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
  actions?: ReactNode;
}

export function ChartCard({ spec, accounts, accountsError, dataRevision = 0, actions }: Props) {
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
  const range = rangeDef(spec.range);
  const period = data?.period;
  const prior = data?.priorPeriod;
  const dates = ({ from, to }: Bounds) => `${fmtDay(from)} – ${fmtDay(to)}`;

  return (
    <section className="chart-card" aria-label={title}>
      <header className="chart-header">
        <div className="chart-identity">
          <h2 className="block-title chart-title">{title}</h2>
          <div className="chart-context">
            <p>Scope: {spec.accountId === null ? 'All accounts' : account ? `${account.name}${account.hidden ? ' (hidden)' : ''}` : `Account ${spec.accountId}`}</p>
            <p>Period: {range.label}{period ? ` · ${dates(period)}` : ''}{chartKind(spec.kind).shape === 'series' ? ` · ${range.grain === 'month' ? 'Monthly' : 'Yearly'} totals` : ` · ${BREAKDOWN_DEFS[spec.breakdown].label}`}</p>
            {prior && <p>Compared with: {dates(prior)}</p>}
            <p>Units: {data ? `${data.currency} · ${spec.accountId === null ? 'Converted workspace amounts' : 'Native account amounts'}` : loading ? 'Reading currency…' : 'Unavailable'}</p>
          </div>
        </div>
        {actions && <div className="chart-context-actions">{actions}</div>}
      </header>

      {error && <Notice tone="error" role="alert">Error: {error}</Notice>}
      {loading && <Notice role="status" className="chart-loading">Reading the numbers…</Notice>}

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
              <div className={`chart-fig-value financial-value${m.key === 'income' ? ' chart-fig-value--income' : ''}`}><span className="financial-value-text">{fmtMoney(total, data.currency)}</span></div>
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
        <div className={`chart-fig-value financial-value${spec.breakdown !== 'expense-categories' ? ' chart-fig-value--income' : ''}`}><span className="financial-value-text">{fmtMoney(total, data.currency)}</span></div>
      </div>
      {biggest && (
        <div className="chart-fig">
          <div className="chart-fig-label">Largest, {biggest.label}</div>
          <div className="chart-fig-value financial-value"><span className="financial-value-text">
            {fmtMoney(biggest.value, data.currency)}
            {isWhole && (
              <span className="chart-fig-pct"> · {Math.round((biggest.value / total) * 100)}%</span>
            )}
          </span></div>
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
      <div className="visually-hidden"><table>
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
      </table></div>
    );
  }

  // a comparative kind's table carries both windows; the others carry the one they drew
  const rows = data.compared;
  if (rows) {
    return (
      <div className="visually-hidden"><table>
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
      </table></div>
    );
  }

  // the parts that were drawn and not every part there is: this table stands IN for the
  // plot, so a donut that dropped a refunded category has to drop it here too or the
  // two readers of this card are given different rows and a total that fits neither
  return (
    <div className="visually-hidden"><table>
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
    </table></div>
  );
}
