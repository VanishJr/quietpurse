/**
 * The six boxes the "Check your Email!" frame draws (Figma design file
 * node 2011:652): one character each, 54x60 at a 12px radius — the one radius in
 * this design that is not the inputs' 15.
 *
 * Six boxes rather than one field because that is what the frame draws, and the
 * whole cost of that choice is in here. With one <input> the caret walks itself,
 * backspace walks back, and a code pasted out of a mail client lands whole; with
 * six, every one of those is code, and a version missing any of them is a screen
 * that fights the person reading a number off their phone.
 *
 * The value is an array and not a string because a string cannot say "box 1 and
 * box 3 are filled and box 2 is not", which is exactly what clicking into the
 * middle of an empty row and typing produces.
 */

import { KeyboardEvent, useRef } from 'react';

export function CodeInput({
  value,
  onChange,
  labelledBy,
  disabled,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  /** id of the element that names the group — the frame's "Enter Code". */
  labelledBy: string;
  disabled?: boolean;
}) {
  const boxes = useRef<(HTMLInputElement | null)[]>([]);

  /** Out-of-range is a no-op, so the ends of the row need no special case. */
  const focus = (i: number) => {
    if (i < 0 || i >= value.length) return;
    boxes.current[i]?.focus();
  };

  /** Writes digits rightwards from `start` and leaves the caret after the last. */
  const write = (start: number, digits: string) => {
    const next = [...value];
    let i = start;
    for (const digit of digits) {
      if (i >= next.length) break;
      next[i] = digit;
      i += 1;
    }
    onChange(next);
    // clamped rather than left to run off the end: a code pasted into the first box
    // fills all six, and the caret belongs on the last of them and not back where
    // the paste landed
    focus(Math.min(i, next.length - 1));
  };

  /**
   * Everything a box can receive arrives here: one character typed over the
   * selection that onFocus makes, or a whole code pasted into it. Both are the
   * same operation — write what came in, starting at this box — so paste needs no
   * handler of its own.
   *
   * Non-digits are dropped rather than refused: a code copied as "123 456" is the
   * right code, and so is one that arrives with a trailing newline.
   */
  const change = (i: number, raw: string) => {
    const digits = raw.replace(/\D/g, '');
    if (!digits) {
      // the box was emptied rather than typed into
      const next = [...value];
      next[i] = '';
      onChange(next);
      return;
    }
    write(i, digits);
  };

  const keyDown = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !value[i]) {
      // an empty box has nothing for the browser to delete, so backspace would do
      // nothing at all — it takes the digit before it, and the caret with it
      e.preventDefault();
      if (i === 0) return;
      const next = [...value];
      next[i - 1] = '';
      onChange(next);
      focus(i - 1);
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      focus(i - 1);
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      focus(i + 1);
    }
  };

  return (
    <div className="auth-code" role="group" aria-labelledby={labelledBy}>
      {value.map((char, i) => (
        <input
          key={i}
          ref={(el) => {
            boxes.current[i] = el;
          }}
          className="auth-code-box"
          type="text"
          value={char}
          onChange={(e) => change(i, e.target.value)}
          onKeyDown={(e) => keyDown(i, e)}
          // typing into a box that already holds a digit replaces it instead of
          // appending, which is also what keeps e.target.value one character long
          onFocus={(e) => e.target.select()}
          // not type="number": it accepts 'e' and '-', and draws spinners on a box
          // 54px wide
          inputMode="numeric"
          // the six are one code, and only the first can carry the hint that fills it
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          // six boxes with no names of their own are six unlabelled fields to
          // anyone who cannot see the row they are in
          aria-label={`Digit ${i + 1} of ${value.length}`}
          disabled={disabled}
        />
      ))}
    </div>
  );
}
