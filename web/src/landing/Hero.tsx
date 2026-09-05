/**
 * The hero is the answer, not a picture of the app.
 *
 * Finto exists to compute one number, so the page computes it for you before you
 * have an account — with the Goal screen's own arithmetic (see threshold.ts),
 * running on three numbers you set with your thumb. The headline is the result and
 * it moves while you drag.
 *
 * This is deliberate positioning as much as design. Ten products in this category
 * were read while this was written and not one of them puts a computed number in
 * the hero: every hero is an adjective and a screenshot of a phone. The number is
 * also the honest thing to lead with — it is what the product is for, and an
 * adjective is not checkable.
 *
 * And the calculator is client-side because that is the product's actual promise,
 * demonstrated rather than claimed: nothing typed here leaves the tab, exactly as
 * nothing in the app leaves the Postgres you run it against.
 */
import { useState } from 'react';
import { computeThreshold, BUFFER_PCT } from './threshold';

/**
 * Only the symbol changes, and that is the truthful behaviour: these are numbers
 * the visitor is thinking of in their own currency, not amounts to convert. The
 * app converts — at the rate on each transaction's own date — but it converts
 * transactions it has read, and this page has read nothing.
 */
const CURRENCIES = ['€', '$', '£', '₸'] as const;

/** Slider ceilings. High enough not to feel like a cage, round enough to read. */
const MAX_MONTH = 6000;
const MAX_RATE = 120;

export function Hero() {
  const [symbol, setSymbol] = useState<string>(CURRENCIES[0]);
  const [spend, setSpend] = useState(1000);
  const [ownIncome, setOwnIncome] = useState(600);
  const [external, setExternal] = useState(300);
  const [hourlyRate, setHourlyRate] = useState(13.5);

  const result = computeThreshold({ spend, ownIncome, external, hourlyRate });
  const { threshold, deficit, selfSufficiency, covered } = result;

  const money = (n: number) =>
    `${symbol}${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  /** the rate is the one amount here with a meaningful half, so it keeps it */
  const rate = (n: number) =>
    `${symbol}${n.toLocaleString('en-US', {
      minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
      maximumFractionDigits: 2,
    })}`;
  const pct = Math.round(selfSufficiency * 100);
  /** Percent of the bar, guarded so an empty month does not divide by zero. */
  const share = (part: number) => (spend > 0 ? (part / spend) * 100 : 0);

  const covers = selfSufficiency >= 1;

  return (
    <section className="hero">
      {/* what the thing IS, before the thing it does. A visitor who has to infer
          the category from the demo has already been asked to work */}
      <p className="hero-what">
        Finto is a personal finance tracker for money that lives in more than one currency.
      </p>
      <p className="hero-eyebrow">It asks one question. This is it.</p>

      {/* The headline IS the output — it is rewritten on every drag.
          It is phrased as a measurement and never as a verdict: "you cover 60%"
          is a position on a road, "you pay for 60% of your own life" was a score
          out of a hundred on being a person. Same arithmetic, and only one of the
          two is a number anybody comes back to look at twice. */}
      <h1 className="hero-verdict">
        {covers ? (
          <>
            You cover <em>all</em> of your month yourself.
          </>
        ) : (
          <>
            You cover <em>{pct}%</em> of your month yourself.
          </>
        )}
      </h1>

      <p className="hero-line" aria-live="polite">
        {covers ? (
          <>
            A month costs {money(spend)}, and you earn {money(ownIncome)} of your own. Finto would
            stop asking you for a number and start telling you how long it stays true.
          </>
        ) : (
          <>
            A month costs {money(spend)}. With a {BUFFER_PCT}% buffer that is{' '}
            {money(threshold)} to bring in — {money(deficit)} of it still ahead of you.
          </>
        )}
      </p>

      {/* Three segments that add up to a month, filled in the order the money is
          actually yours. The legend is under it because the colours mean something
          this page has not said yet. */}
      <div
        className="hero-bar"
        role="img"
        aria-label={`Of ${money(spend)} a month, you earn ${money(covered.own)}, ${money(
          covered.external,
        )} is covered by support, and ${money(covered.uncovered)} is still to cover.`}
      >
        <span className="seg seg-own" style={{ width: `${share(covered.own)}%` }} />
        <span className="seg seg-external" style={{ width: `${share(covered.external)}%` }} />
        <span className="seg seg-gap" style={{ width: `${share(covered.uncovered)}%` }} />
      </div>

      {/* The three labels name where money came from and stop there. "Someone
          else paid" and "nothing covered it" described the same two segments as
          a failing — and the segment a reader is most sensitive about is not the
          place to editorialise. */}
      <ul className="hero-legend">
        <li>
          <i className="key key-own" /> You earned it
        </li>
        <li>
          <i className="key key-external" /> Covered by support
        </li>
        <li>
          <i className="key key-gap" /> Still to cover
        </li>
      </ul>

      <div className="hero-dials">
        <Dial
          label="A month costs"
          value={spend}
          onChange={setSpend}
          max={MAX_MONTH}
          step={50}
          display={money(spend)}
        />
        <Dial
          label="You earn"
          value={ownIncome}
          onChange={setOwnIncome}
          max={MAX_MONTH}
          step={50}
          display={money(ownIncome)}
        />
        <Dial
          label="Support you receive"
          value={external}
          onChange={setExternal}
          max={MAX_MONTH}
          step={50}
          display={money(external)}
          hint="family, a stipend, a scholarship"
        />
      </div>

      {/* The shortfall in hours. Kept out of the dial row because it is a
          consequence rather than an input, and because the sentence it makes is
          the point of it. */}
      <p className="hero-hours">
        {covers ? (
          <>
            At {rate(hourlyRate)} an hour, the month you live costs{' '}
            <strong>{Math.round(result.totalHoursPerMonth)} hours</strong> — and you are already
            earning them.
          </>
        ) : result.capExceeded ? (
          <>
            At {rate(hourlyRate)} an hour that shortfall is{' '}
            <strong>{Math.round(result.extraHoursPerMonth)} hours</strong> a month on top of
            everything else, and the whole month would take{' '}
            {Math.round(result.totalHoursPerMonth)} — past the{' '}
            {Math.round(result.capPerMonth)} there are. <em>This one does not close by working
            more.</em>
          </>
        ) : (
          <>
            At {rate(hourlyRate)} an hour that shortfall is{' '}
            <strong>{Math.round(result.extraHoursPerMonth)} hours</strong> a month. Finto is the
            only tracker here that will tell you that.
          </>
        )}
      </p>

      <div className="hero-rate">
        <label htmlFor="hero-rate-input">An hour of your work is worth</label>
        <input
          id="hero-rate-input"
          type="range"
          min={1}
          max={MAX_RATE}
          step={0.5}
          value={hourlyRate}
          onChange={(e) => setHourlyRate(Number(e.target.value))}
        />
        <output htmlFor="hero-rate-input">{rate(hourlyRate)}</output>

        <fieldset className="hero-currency">
          <legend>Currency</legend>
          {CURRENCIES.map((c) => (
            <label key={c} className={c === symbol ? 'is-on' : undefined}>
              <input
                type="radio"
                name="hero-currency"
                checked={c === symbol}
                onChange={() => setSymbol(c)}
              />
              {c}
            </label>
          ))}
        </fieldset>
      </div>

      <div className="hero-cta">
        <a className="cta cta-primary" href="/">
          Open the app
        </a>
      </div>
    </section>
  );
}

function Dial({
  label,
  value,
  onChange,
  max,
  step,
  display,
  hint,
}: {
  label: string;
  value: number;
  onChange: (next: number) => void;
  max: number;
  step: number;
  display: string;
  hint?: string;
}) {
  const id = `dial-${label.replace(/\s+/g, '-').toLowerCase()}`;
  return (
    <div className="dial">
      <label className="dial-label" htmlFor={id}>
        {label}
      </label>
      <output className="dial-value" htmlFor={id}>
        {display}
      </output>
      <input
        id={id}
        type="range"
        min={0}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint && <p className="dial-hint">{hint}</p>}
    </div>
  );
}
