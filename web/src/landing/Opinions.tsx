/**
 * The two things Finto does that other trackers do not, each shown rather than
 * asserted. Both are live DOM — real elements with real numbers in them, not
 * screenshots — so they animate, they respond, and they stay sharp at any density.
 *
 * The numbers in the rate demo are illustrative and the page says so on screen. A
 * marketing page inventing exchange rates and presenting them as measurements
 * would be doing the exact thing the product exists to stop.
 */
import { useState } from 'react';

/**
 * Six months of the same foreign rent, and a rate that drifted under it.
 *
 * The shape is the point and it is the ordinary case, not a dramatic one: 2,000 a
 * month in the currency the landlord bills, against a base currency that slowly
 * lost ground. Converted on each month's own date the rent quietly got more
 * expensive; converted at today's rate every month is identical and the drift
 * never happened.
 */
const RENT_FOREIGN = 2000;
const MONTHS = [
  { month: 'Jan', rate: 4.7 },
  { month: 'Feb', rate: 4.62 },
  { month: 'Mar', rate: 4.55 },
  { month: 'Apr', rate: 4.46 },
  { month: 'May', rate: 4.38 },
  { month: 'Jun', rate: 4.3 },
];
const TODAY_RATE = MONTHS[MONTHS.length - 1].rate;

const onItsOwnDate = MONTHS.map((m) => Math.round(RENT_FOREIGN / m.rate));
const atTodaysRate = MONTHS.map(() => Math.round(RENT_FOREIGN / TODAY_RATE));

/**
 * The axis floor, and it is disclosed on screen rather than hidden.
 *
 * Drawn from zero, a 9% drift over six months is about twenty pixels and the
 * chart says "six identical bars" — which is the lie the section is about. A
 * truncated axis is only dishonest when it is silent about being truncated, so
 * this one is labelled, and the reason it is needed is itself the argument: this
 * effect is invisible at full scale, which is exactly why nobody notices it
 * happening to them.
 */
const FLOOR = 400;

export function Opinions() {
  return (
    <section className="opinions" id="how">
      <h2 className="section-h">Two opinions, and they are the whole product.</h2>
      <p className="section-sub">
        Everything else here is bookkeeping. These two are the reason the number at the top of this
        page is different from the one any other tracker would give you.
      </p>

      <RateOpinion />
      <IncomeOpinion />
    </section>
  );
}

function RateOpinion() {
  const [honest, setHonest] = useState(true);
  const values = honest ? onItsOwnDate : atTodaysRate;
  const peak = Math.max(...onItsOwnDate);
  const spread = Math.max(...values) - Math.min(...values);

  return (
    <article className="opinion">
      <div className="opinion-words">
        <p className="opinion-n">01</p>
        <h3>Money has a date on it.</h3>
        <p>
          Rent of {RENT_FOREIGN.toLocaleString('en-US')} a month abroad, unchanged for six months.
          Your bank statement says you paid the same thing every time. Converted at the rate on the
          day each one actually left your account, it went up{' '}
          <strong>
            {Math.round(((onItsOwnDate.at(-1)! - onItsOwnDate[0]) / onItsOwnDate[0]) * 100)}%
          </strong>
          .
        </p>
        <p>
          Convert at today's rate instead — which is what a spreadsheet does, and what most tools do
          — and all six months are identical. That is a year that never happened, and every
          month-to-month comparison built on it is a comparison of nothing.
        </p>

        <div className="toggle" role="group" aria-label="Which rate to convert at">
          <button
            type="button"
            className={honest ? 'is-on' : undefined}
            aria-pressed={honest}
            onClick={() => setHonest(true)}
          >
            At the rate on the day
          </button>
          <button
            type="button"
            className={!honest ? 'is-on' : undefined}
            aria-pressed={!honest}
            onClick={() => setHonest(false)}
          >
            At today's rate
          </button>
        </div>
        <p className="opinion-caveat">
          Illustrative rates, chosen to be ordinary rather than dramatic. Finto uses the real one
          for each transaction's own date.
        </p>
      </div>

      <div className="opinion-demo">
        <div className="chart" data-flat={!honest}>
          {MONTHS.map((m, i) => (
            <div className="chart-col" key={m.month}>
              <div className="chart-plot">
                <div
                  className="chart-bar"
                  style={{ height: `${((values[i] - FLOOR) / (peak - FLOOR)) * 100}%` }}
                >
                  <span className="chart-value">{values[i]}</span>
                </div>
              </div>
              <span className="chart-label">{m.month}</span>
            </div>
          ))}
        </div>
        <p className="chart-caption" aria-live="polite">
          {honest ? (
            <>
              Six different amounts. Spread: <strong>{spread}</strong> — the rent you did not know
              you were paying.
            </>
          ) : (
            <>
              Six identical amounts. Spread: <strong>0</strong>. Nothing to notice, and nothing that
              was true.
            </>
          )}
        </p>
        {/* the disclosure goes last and looks like a footnote, because that is what
            it is — but it is on the page, which is the part that matters */}
        <p className="chart-floor">
          Axis starts at {FLOOR}. Drawn from zero the whole effect is about twenty pixels tall —
          which is rather the reason nobody notices it happening to them.
        </p>
      </div>
    </article>
  );
}

/** The month behind the second demo: what it costs, what you earned, what arrived. */
const SPEND = 1000;
const OWN = 600;
const HELP = 300;

function IncomeOpinion() {
  const [countHelp, setCountHelp] = useState(false);
  const counted = countHelp ? OWN + HELP : OWN;
  const pct = Math.round((counted / SPEND) * 100);

  return (
    <article className="opinion opinion-reverse">
      <div className="opinion-words">
        <p className="opinion-n">02</p>
        <h3>Support and earnings are different numbers.</h3>
        <p>
          A stipend, a scholarship, family. Real money — it pays real rent — and it is support
          rather than something you earned. Every other tracker adds it to the income column,
          because to a bank a deposit is a deposit.
        </p>
        <p>
          Getting some is the ordinary case and not the exception; it is simply the one number
          nobody's dashboard says out loud, which is why everyone who has it assumes they are the
          only one.
        </p>
        <p>
          Count it and you are nearly there. Keep it separate and you can see the actual distance.
          Only one of those two numbers can tell you how far there is left to go.
        </p>

        <label className="switch">
          <input
            type="checkbox"
            checked={countHelp}
            onChange={(e) => setCountHelp(e.target.checked)}
          />
          <span className="switch-track" aria-hidden="true">
            <span className="switch-knob" />
          </span>
          Count help as income, the way everything else does
        </label>
      </div>

      {/* The live region is the whole readout and not the number alone: on the
          number, flipping the switch announced "60" and stopped — the one word that
          does not say what changed or what it now measures. */}
      <div className="opinion-demo opinion-demo-center" aria-live="polite">
        <p className="big-pct">
          <span className="big-pct-n">{pct}</span>
          <span className="big-pct-sign">%</span>
        </p>
        <p className="big-pct-label">covered by what you earn</p>
        <p className="chart-caption">
          {countHelp ? (
            <>
              {SPEND} a month covered, {HELP} of it by support. A tracker that says {pct}% here is
              not wrong about the arithmetic — it is answering a different question than the one you
              asked.
            </>
          ) : (
            <>
              The same month, counting only what you earned. The gap between {pct}% and{' '}
              {Math.round(((OWN + HELP) / SPEND) * 100)}% is what support is covering — the distance
              stated plainly, rather than folded into a total where it cannot be seen.
            </>
          )}
        </p>
      </div>
    </article>
  );
}
