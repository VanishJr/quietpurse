import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { CodeInput } from './CodeInput';

/**
 * Six boxes instead of one field is the frame's decision (Figma 2011:652), and
 * everything an <input> would have done for free is what is asserted here: the
 * caret walking itself, backspace walking back, and a code arriving whole from a
 * mail client rather than one digit at a time.
 *
 * None of it is visible in a screenshot, which is why it is pinned rather than
 * looked at.
 */

/** The component is controlled; the harness is the state it is controlled by. */
function Harness({ initial }: { initial?: string[] }) {
  const [value, setValue] = useState<string[]>(initial ?? ['', '', '', '', '', '']);
  return (
    <>
      <span id="code-label">Enter Code</span>
      <CodeInput value={value} onChange={setValue} labelledBy="code-label" />
      <output data-testid="joined">{value.map((c) => c || '·').join('')}</output>
    </>
  );
}

const box = (n: number) => screen.getByLabelText(`Digit ${n} of 6`) as HTMLInputElement;
const joined = () => screen.getByTestId('joined').textContent;

describe('typing a code', () => {
  it('walks the caret on as each digit lands', () => {
    render(<Harness />);

    fireEvent.change(box(1), { target: { value: '4' } });

    expect(joined()).toBe('4·····');
    expect(box(2)).toHaveFocus();
  });

  it('stops at the last box rather than losing the caret off the end', () => {
    render(<Harness initial={['1', '2', '3', '4', '5', '']} />);

    fireEvent.change(box(6), { target: { value: '6' } });

    expect(joined()).toBe('123456');
    expect(box(6)).toHaveFocus();
  });

  it('drops anything that is not a digit', () => {
    // a box that accepted 'e' would hold a character no code contains, and the
    // submit check counts filled boxes rather than reading them
    render(<Harness />);

    fireEvent.change(box(1), { target: { value: 'e' } });

    expect(joined()).toBe('······');
  });

  it('replaces the digit in a box that already has one', () => {
    // onFocus selects the content, so what arrives is the typed character and not
    // the old one with the new one stuck to it
    render(<Harness initial={['1', '', '', '', '', '']} />);

    box(1).focus();
    fireEvent.change(box(1), { target: { value: '9' } });

    expect(joined()).toBe('9·····');
  });
});

describe('a code that arrives all at once', () => {
  it('fills every box from one paste and needs no paste handler to do it', () => {
    render(<Harness />);

    fireEvent.change(box(1), { target: { value: '123456' } });

    expect(joined()).toBe('123456');
    expect(box(6)).toHaveFocus();
  });

  it('takes a code copied with spaces in it', () => {
    // "123 456" is the same code, and a mail client is where this is copied from
    render(<Harness />);

    fireEvent.change(box(1), { target: { value: '123 456\n' } });

    expect(joined()).toBe('123456');
  });

  it('fills rightwards from the box it was pasted into, and stops at the end', () => {
    render(<Harness />);

    fireEvent.change(box(5), { target: { value: '123456' } });

    expect(joined()).toBe('····12');
  });
});

describe('taking it back', () => {
  it('clears the box it is in, without moving, while there is something in it', () => {
    render(<Harness initial={['1', '2', '', '', '', '']} />);

    box(2).focus();
    fireEvent.change(box(2), { target: { value: '' } });

    expect(joined()).toBe('1·····');
    expect(box(2)).toHaveFocus();
  });

  it('takes the digit before it, and the caret, when the box is already empty', () => {
    render(<Harness initial={['1', '2', '', '', '', '']} />);

    box(3).focus();
    fireEvent.keyDown(box(3), { key: 'Backspace' });

    expect(joined()).toBe('1·····');
    expect(box(2)).toHaveFocus();
  });

  it('does nothing at the first box, rather than writing before the row', () => {
    render(<Harness />);

    box(1).focus();
    fireEvent.keyDown(box(1), { key: 'Backspace' });

    expect(joined()).toBe('······');
    expect(box(1)).toHaveFocus();
  });
});

describe('walking the row', () => {
  it('moves left and right without changing anything', () => {
    render(<Harness initial={['1', '2', '3', '', '', '']} />);

    box(2).focus();
    fireEvent.keyDown(box(2), { key: 'ArrowRight' });
    expect(box(3)).toHaveFocus();

    fireEvent.keyDown(box(3), { key: 'ArrowLeft' });
    expect(box(2)).toHaveFocus();

    expect(joined()).toBe('123···');
  });

  it('stays put at either end', () => {
    render(<Harness />);

    box(1).focus();
    fireEvent.keyDown(box(1), { key: 'ArrowLeft' });
    expect(box(1)).toHaveFocus();

    box(6).focus();
    fireEvent.keyDown(box(6), { key: 'ArrowRight' });
    expect(box(6)).toHaveFocus();
  });
});

describe('what the row says about itself', () => {
  it('is one named group of six named boxes', () => {
    // six boxes with no names are six unlabelled fields to anyone who cannot see
    // the row they are in
    render(<Harness />);

    expect(screen.getByRole('group', { name: 'Enter Code' })).toBeInTheDocument();
    expect(screen.getAllByRole('textbox')).toHaveLength(6);
    expect(box(1)).toHaveAttribute('autocomplete', 'one-time-code');
    expect(box(1)).toHaveAttribute('inputmode', 'numeric');
  });
});
