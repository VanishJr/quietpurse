/**
 * `favourable` is the caller's, because the same arrow means opposite things to
 * different callers: income rising is good news and spending rising is not, and
 * colouring both green because both went up is the thing to avoid.
 *
 * Its own module because more than one component draws it, and a second copy of this
 * would be a second answer to which direction is good.
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
        apart — and it is `aria-hidden`, and the figure is `Math.abs`, so without the
        hidden word a screen reader could not tell a rise from a fall. The word is
        inside the `<strong>` so the two arrive as one phrase rather than as a stray
        syllable before a number.
      */}
      <strong>
        <span className="visually-hidden">{up ? 'up ' : 'down '}</span>
        {Math.abs(pct).toFixed(1)}%
      </strong>
      <span className="fig-delta-note">{note}</span>
    </p>
  );
}
