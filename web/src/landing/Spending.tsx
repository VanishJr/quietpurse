/**
 * Where the month actually went — the payoff of the two opinions above.
 *
 * The section exists because the hero asks "how much of the month do you cover?"
 * and the honest next question is "on what?". It is the same €1,000 month the
 * hero starts on and the same one Opinion 02 counts, so the three sections are
 * one worked example rather than three unrelated demos.
 *
 * ---------------------------------------------------------------------------
 * Why the ring is one hue
 *
 * Seven colours would say these categories are seven different KINDS of thing.
 * They are not — every slice is the same euro leaving the same account, and the
 * only thing that differs is how much. So the encoding is one hue at seven
 * lightnesses, ordered by size, which is what a parts-of-one-whole chart is
 * actually measuring. It also keeps the page's colour vocabulary intact: green
 * means "yours" and #ECEEA9 means "not yours" everywhere else here, and a pie
 * that spent those two on Rent and Groceries would quietly break both.
 *
 * The catch-all sits last and dimmest regardless of its size, because a bucket
 * called "everything else" should recede rather than compete.
 *
 * ---------------------------------------------------------------------------
 * Why hover is not the only way in
 *
 * Hover does not exist on a phone and does not exist on a keyboard. So the
 * legend rows are real buttons: hover and focus preview a slice, a click pins
 * it, and the readout in the middle of the ring is `aria-live`, so the thing a
 * sighted user reads on hover is the thing a screen reader announces on focus.
 * Nothing here is conveyed by colour alone — the active slice also gets width,
 * full opacity and the centre of the ring.
 *
 * `is-picking` rides on state rather than on a `:hover` rule for the same
 * reason: the paths are not focusable, so a CSS-only highlight would react to a
 * mouse and sit perfectly still for a keyboard.
 */
import { useState } from 'react';

interface Slice {
  name: string;
  amount: number;
  /** the ramp position, brightest for the largest — see the note above */
  tone: string;
  /** what it is, in the one line the middle of the ring has room for */
  say: string;
}

/**
 * A month that adds up to the hero's default, so the pages's numbers agree with
 * each other. Ordinary amounts rather than dramatic ones, for the same reason
 * the rate demo picks an ordinary drift.
 */
const SLICES: Slice[] = [
  { name: 'Rent', amount: 420, tone: 'rgba(255,255,255,0.95)', say: 'Paid abroad, converted on the day it left' },
  { name: 'Groceries', amount: 180, tone: 'rgba(255,255,255,0.80)', say: 'Matched by rule, 31 rows this month' },
  { name: 'Eating out', amount: 110, tone: 'rgba(255,255,255,0.66)', say: 'The category that moves most, month to month' },
  { name: 'Transport', amount: 95, tone: 'rgba(255,255,255,0.54)', say: 'Passes, fares and one flight amortised' },
  { name: 'Health', amount: 65, tone: 'rgba(255,255,255,0.44)', say: 'Insurance, and a dentist you would rather forget' },
  { name: 'Subscriptions', amount: 45, tone: 'rgba(255,255,255,0.34)', say: 'Small, recurring, and the easiest to lose track of' },
  { name: 'Everything else', amount: 85, tone: 'rgba(255,255,255,0.24)', say: 'Nothing frequent enough to earn its own rule yet' },
];

const TOTAL = SLICES.reduce((sum, s) => sum + s.amount, 0);

/** Ring geometry. The circle is drawn as a stroke, so `r` is the mid-line of it. */
const R = 76;
const CIRC = 2 * Math.PI * R;
/** A hair of unpainted path between slices, so seven of them read as seven. */
const GAP = 3;

const money = (n: number) => `€${n.toLocaleString('en-US')}`;
const share = (n: number) => Math.round((n / TOTAL) * 100);

export function Spending() {
  /** hover or keyboard focus — transient */
  const [hovered, setHovered] = useState<number | null>(null);
  /** a click, so touch has a way in and a slice can be held still to read */
  const [pinned, setPinned] = useState<number | null>(null);
  const shown = hovered ?? pinned;

  // running start position for each arc, as a fraction of the whole ring
  let run = 0;
  const starts = SLICES.map((s) => {
    const at = run;
    run += s.amount / TOTAL;
    return at;
  });

  const touch = (i: number) => ({
    onMouseEnter: () => setHovered(i),
    onMouseLeave: () => setHovered(null),
    onClick: () => setPinned((p) => (p === i ? null : i)),
  });

  return (
    <section className="spend" id="spending">
      <h2 className="section-h">And this is the month, once it is all one currency.</h2>
      <p className="section-sub">
        The same {money(TOTAL)}. Every row converted at the rate on its own date, the transfer
        between your own accounts left out of it, and what is left sorted by the rules you keep.
        Point at a slice — or tap one in the list — to see what it is.
      </p>

      <div className="spend-grid">
        <div className="donut">
          <svg
            viewBox="0 0 200 200"
            role="img"
            aria-label={`A month of ${money(TOTAL)}, split by category. ${SLICES.map(
              (s) => `${s.name}, ${money(s.amount)}, ${share(s.amount)} percent`,
            ).join('. ')}.`}
          >
            <g className={shown === null ? 'ring' : 'ring is-picking'}>
              <circle className="ring-track" cx="100" cy="100" r={R} />
              {SLICES.map((s, i) => {
                const len = Math.max((s.amount / TOTAL) * CIRC - GAP, 1);
                return (
                  <circle
                    key={s.name}
                    className={i === shown ? 'slice is-on' : 'slice'}
                    cx="100"
                    cy="100"
                    r={R}
                    stroke={s.tone}
                    strokeDasharray={`${len} ${CIRC - len}`}
                    strokeDashoffset={-starts[i] * CIRC}
                    {...touch(i)}
                  />
                );
              })}
            </g>
          </svg>

          {/* the readout lives in the hole rather than in a floating tooltip: no
              positioning to get wrong, and it is the one place the eye already is */}
          <div className={shown === null ? 'donut-mid' : 'donut-mid is-on'} aria-live="polite">
            {shown === null ? (
              <>
                <span className="donut-n">{money(TOTAL)}</span>
                <span className="donut-say">a month, all in</span>
              </>
            ) : (
              <>
                <span className="donut-cat">{SLICES[shown].name}</span>
                <span className="donut-n">{money(SLICES[shown].amount)}</span>
                <span className="donut-say">{share(SLICES[shown].amount)}% of the month</span>
              </>
            )}
          </div>
        </div>

        <ul className="slices">
          {SLICES.map((s, i) => (
            <li key={s.name}>
              <button
                type="button"
                className={i === shown ? 'slice-row is-on' : 'slice-row'}
                aria-pressed={pinned === i}
                onFocus={() => setHovered(i)}
                onBlur={() => setHovered(null)}
                {...touch(i)}
              >
                <i className="slice-key" style={{ background: s.tone }} aria-hidden="true" />
                <span className="slice-name">{s.name}</span>
                <span className="slice-amt">{money(s.amount)}</span>
                <span className="slice-pct">{share(s.amount)}%</span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      {/* Not a live region, though it changes with the ring: the readout in the
          hole already announces the slice, and this said the same name a second
          time — one focus move, two announcements, the second of them a longer
          version of the first. The sentence is still read where it is met. */}
      <p className="spend-say">
        {shown === null ? (
          <>
            Seven rules, and they were written once. The next statement you drop in lands in the
            same seven without you sorting anything.
          </>
        ) : (
          <>
            <strong>{SLICES[shown].name}</strong> — {SLICES[shown].say}.
          </>
        )}
      </p>

      <div className="spend-cta">
        <a className="cta cta-primary" href="/">
          Sign in
        </a>
      </div>
    </section>
  );
}
