import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { ScreenShown } from '../screen';
import { Sheet } from './Sheet';

function Menu() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open menu</button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Account menu">
        <button>Rename</button>
        <button disabled>Delete</button>
        <button onClick={() => setOpen(false)}>Close</button>
      </Sheet>
      <button>Outside</button>
    </>
  );
}

/** A sheet on a screen the reader can leave and come back to, as the Shell arranges it. */
function Screened() {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(true);
  return (
    <>
      <button onClick={() => setShown((value) => !value)}>Switch screen</button>
      <div hidden={!shown}>
        <ScreenShown value={shown}>
          <button onClick={() => setOpen(true)}>Open</button>
          <Sheet open={open} onClose={() => setOpen(false)} title="Transaction">
            <button onClick={() => setOpen(false)}>Close</button>
          </Sheet>
        </ScreenShown>
      </div>
    </>
  );
}

describe('a sheet on a hidden screen', () => {
  it('holds nothing of the page while hidden, and takes it back with the screen', () => {
    render(<Screened />);
    const opener = screen.getByRole('button', { name: 'Open' });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole('dialog')).toHaveFocus();
    expect(document.body.style.overflow).toBe('hidden');

    const switcher = screen.getByRole('button', { name: 'Switch screen' });
    switcher.focus();
    fireEvent.click(switcher);
    expect(document.body.style.overflow).toBe('');
    fireEvent.keyDown(switcher, { key: 'Escape' });
    expect(fireEvent.keyDown(switcher, { key: 'Tab' })).toBe(true);
    expect(screen.getByRole('dialog', { hidden: true })).toBeInTheDocument();

    fireEvent.click(switcher);
    expect(screen.getByRole('dialog')).toHaveFocus();
    expect(document.body.style.overflow).toBe('hidden');

    // back to what opened it, not to the control that brought the reader back
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(document.body.style.overflow).toBe('');
  });
});

describe('account menu keyboard navigation', () => {
  it('includes description disclosures and keeps focus inside after a preview heading is focused', () => {
    render(
      <Sheet open onClose={() => {}} title="Transaction">
        <h2 tabIndex={-1}>Similar transactions</h2>
        <details><summary>Original description</summary><p>Bank text</p></details>
        <button>Apply</button>
      </Sheet>,
    );
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(screen.getByText('Original description')).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('button', { name: 'Apply' })).toHaveFocus();
    screen.getByRole('heading').focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('button', { name: 'Apply' })).toHaveFocus();
  });

  it('leaves Tab to the browser while the sheet sits in a hidden screen', () => {
    // every screen stays mounted under `hidden`, so Back can leave a sheet open behind
    // the one that is showing; the trap must not take that screen's Tab with it
    render(
      <>
        <div hidden>
          <Sheet open onClose={() => {}} title="Transaction">
            <button>Apply</button>
          </Sheet>
        </div>
        <button>Outside</button>
      </>,
    );
    const outside = screen.getByRole('button', { name: 'Outside' });
    outside.focus();
    expect(fireEvent.keyDown(outside, { key: 'Tab' })).toBe(true);
    expect(outside).toHaveFocus();
  });

  it('keeps Tab and Shift+Tab inside the dialog and returns focus after Escape', () => {
    render(<Menu />);
    const opener = screen.getByRole('button', { name: 'Open menu' });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole('dialog')).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'Rename' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'Rename' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('returns focus when a dialog action closes it', () => {
    render(<Menu />);
    const opener = screen.getByRole('button', { name: 'Open menu' });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(opener).toHaveFocus();
  });
});
