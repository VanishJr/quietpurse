/**
 * A comparison with the period before, or nothing at all.
 *
 * `favourable` is the caller's, because the same arrow means opposite things on the
 * three cards that draw one: income rising is good news and spending rising is not,
 * and colouring both green because both went up is the thing the reference screenshot
 * does and the one thing here not copied from it.
 *
 * Its own module because the balance card and the income/expense pair are two
 * components now — they are two cards in the design and they sit in different cells of
 * the same grid — and a second copy of this would be a second answer to which
 * direction is good.
 */

interface Props {
  /** null when the question has no answer; see `percentChange`. Nothing is drawn then. */
  pct: number | null;
  favourable: boolean;
  /** What it is measured against, e.g. "vs Jul". Not coloured — only the direction is. */
  note: string;
}

export function Delta({ pct, favourable, note }: Props) {
  if (pct === null) return null;
  const up = pct >= 0;
  return (
    <p className={`fig-delta${favourable ? ' is-good' : ' is-bad'}`}>
      <span className="fig-arrow" aria-hidden="true">
        {up ? '↗' : '↘'}
      </span>
      {/*
        The direction is drawn twice and read once. The arrow is the whole of it for
        the eye — a shape, so it survives a reader who cannot tell the two colours
        apart — and it is `aria-hidden`, which left the sign nowhere: the figure is
        `Math.abs`, so a screen reader was given "100.0% vs Jul" and no way to tell a
        doubling from a halving. The word is inside the `<strong>` so the two arrive
        as one phrase rather than as a stray syllable before a number.
      */}
      <strong>
        <span className="visually-hidden">{up ? 'up ' : 'down '}</span>
        {Math.abs(pct).toFixed(1)}%
      </strong>
      <span className="fig-delta-note">{note}</span>
    </p>
  );
}
