import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode, useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useDismiss } from '../dismiss';
import { ScreenShown } from '../screen';
import { Sheet } from './Sheet';
import { notifyResizeObservers } from '../test/resize';

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
  it('leaves native scroll-region Tab progression to the browser without an explicit tabindex', () => {
    render(<Sheet open onClose={() => {}} title="Native scrolling">
      <div data-testid="native-scroll-region">A signed amount with its currency</div>
      <button>Continue</button>
    </Sheet>);
    const scroller = screen.getByTestId('native-scroll-region');
    expect(scroller).not.toHaveAttribute('tabindex');
    const active = vi.spyOn(document, 'activeElement', 'get').mockReturnValue(scroller);
    try {
      expect(fireEvent.keyDown(scroller, { key: 'Tab' })).toBe(true);
      expect(fireEvent.keyDown(scroller, { key: 'Tab', shiftKey: true })).toBe(true);
    } finally {
      active.mockRestore();
    }
  });

  it('reveals header and footer controls when keyboard wrapping or recovery moves focus', () => {
    render(<Sheet open onClose={() => {}} title="Consequences" pattern="confirmation"
      header={<h2>Account consequences</h2>} footer={<button>Last action</button>}>
      <p>Account data and deletion consequences</p>
      <input aria-label="Confirmation" />
    </Sheet>);
    const first = screen.getByRole('button', { name: 'Close dialog' });
    const last = screen.getByRole('button', { name: 'Last action' });
    first.scrollIntoView = vi.fn();
    last.scrollIntoView = vi.fn();
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(first).toHaveFocus();
    expect(first.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
    expect(last.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    vi.mocked(first.scrollIntoView).mockClear();
    last.blur();
    fireEvent.focusIn(document.body);
    expect(first).toHaveFocus();
    expect(first.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });

  it('includes description disclosures and keeps focus inside after a preview heading is focused', () => {
    render(
      <Sheet open onClose={() => {}} title="Transaction">
        <h2 tabIndex={-1}>Similar transactions</h2>
        <details><summary>Original description</summary><p>Bank text</p></details>
        <button>Apply</button>
      </Sheet>,
    );
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'Close dialog' })).toHaveFocus();
    screen.getByText('Original description').focus();
    expect(fireEvent.keyDown(document.activeElement!, { key: 'Tab' })).toBe(true);
    screen.getByRole('button', { name: 'Close dialog' }).focus();
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
    expect(screen.getByRole('button', { name: 'Close dialog' })).toHaveFocus();
    screen.getByRole('button', { name: 'Rename' }).focus();
    expect(fireEvent.keyDown(document.activeElement!, { key: 'Tab' })).toBe(true);
    screen.getByRole('button', { name: 'Close dialog' }).focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'Close dialog' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
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

function AutofocusEditor({ strict = false }: { strict?: boolean }) {
  const [open, setOpen] = useState(false);
  const editor = (
    <>
      <button onClick={() => setOpen(true)}>New account</button>
      {open && <Sheet open onClose={() => setOpen(false)} title="New account" pattern="short-editor">
        <h2>Account details</h2>
        <input autoFocus aria-label="Account name" />
      </Sheet>}
    </>
  );
  return strict ? <StrictMode>{editor}</StrictMode> : editor;
}

function ChildPopover({ onEscape }: { onEscape: () => void }) {
  useDismiss(true, (target) => target.id === 'child-popover', onEscape, () => {});
  return <button id="child-popover">Popover action</button>;
}

describe('sheet focus lifecycle', () => {
  it.each([false, true])('captures the opener before child autofocus (StrictMode: %s)', (strict) => {
    render(<AutofocusEditor strict={strict} />);
    const opener = screen.getByRole('button', { name: 'New account' });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole('heading', { name: 'Account details' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Close dialog' }).querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(opener).toHaveFocus();
    expect(document.body.style.overflow).toBe('');
    expect(opener).not.toHaveAttribute('inert');
  });

  it('enters each step heading without resetting an input caret on ordinary renders', () => {
    const onClose = vi.fn();
    const view = (stepKey: string, text: string) => (
      <Sheet open onClose={() => onClose()} pattern="builder" stepKey={stepKey} title="Chart">
        <h3>{stepKey}</h3>
        <input aria-label="Chart name" defaultValue="Monthly spending" />
        <p>{text}</p>
      </Sheet>
    );
    const { rerender } = render(view('Shape', 'First render'));
    expect(screen.getByRole('heading')).toHaveFocus();
    const input = screen.getByRole('textbox') as HTMLInputElement;
    input.focus();
    input.setSelectionRange(3, 5);
    rerender(view('Shape', 'Draft changed'));
    expect(input).toHaveFocus();
    expect([input.selectionStart, input.selectionEnd]).toEqual([3, 5]);
    rerender(view('Details', 'Next step'));
    expect(screen.getByRole('heading', { name: 'Details' })).toHaveFocus();
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(input).toHaveFocus();
  });

  it('honors an explicit initial target and otherwise falls back to the card', () => {
    function Targeted({ target }: { target: boolean }) {
      const ref = useRef<HTMLInputElement>(null);
      return (
        <Sheet open onClose={() => {}} pattern="confirmation" initialFocus={() => target ? ref.current : null}>
          <input ref={ref} aria-label="Confirmation" />
        </Sheet>
      );
    }
    const { unmount } = render(<Targeted target />);
    expect(screen.getByRole('textbox')).toHaveFocus();
    unmount();
    render(<Targeted target={false} />);
    expect(screen.getByRole('dialog')).toHaveFocus();
  });

  it('recovers BODY, outside focus, and removed controls', async () => {
    const view = (control: boolean) => (
      <>
        <button>Background</button>
        <Sheet open onClose={() => {}} pattern="builder" title="Builder">
          <h2>Details</h2>
          {control && <input aria-label="Removed control" />}
        </Sheet>
      </>
    );
    const { rerender } = render(view(true));
    const close = screen.getByRole('button', { name: 'Close dialog' });
    screen.getByRole('heading').blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('textbox')).toHaveFocus();
    screen.getByRole('button', { name: 'Background' }).focus();
    expect(close).toHaveFocus();
    fireEvent.focusIn(document.body);
    expect(close).toHaveFocus();
    screen.getByRole('textbox').focus();
    rerender(view(false));
    await waitFor(() => expect(close).toHaveFocus());
    fireEvent.keyDown(document.body, { key: 'Tab', shiftKey: true });
    expect(close).toHaveFocus();
  });

  it('recomputes dynamic controls and skips hidden, inert, disabled and closed-detail content', async () => {
    const view = (extra: boolean) => (
      <Sheet open onClose={() => {}} pattern="long-editor" title="Controls">
        <h2>Editor</h2>
        <button aria-disabled="true">Locked but focusable</button>
        {extra && <button>Added later</button>}
        <button disabled>Disabled</button>
        <input type="hidden" aria-label="Hidden input" />
        <div hidden><button>Hidden</button></div>
        <div inert><button>Inert</button></div>
        <div style={{ display: 'none' }}><button>Display hidden</button></div>
        <div style={{ visibility: 'hidden' }}><button>Visibility hidden</button></div>
        <details><summary tabIndex={-1}>Disclosure</summary><button>Closed detail</button></details>
      </Sheet>
    );
    const { rerender } = render(view(false));
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('button', { name: 'Locked but focusable' })).toHaveFocus();
    rerender(view(true));
    expect(screen.getByRole('button', { name: 'Locked but focusable' })).toHaveFocus();
    screen.getByRole('heading').focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('button', { name: 'Added later' })).toHaveFocus();
    screen.getByText('Disclosure').parentElement!.setAttribute('open', '');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Closed detail' })).toBeVisible());
    screen.getByRole('heading').focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('button', { name: 'Closed detail' })).toHaveFocus();
    expect(fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true })).toBe(true);
    screen.getByRole('heading').focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'Close dialog' })).toHaveFocus();
  });

  it.each(['removed', 'disabled', 'hidden', 'inert', 'css-hidden'] as const)(
    'uses the restoration fallback when the opener is %s', (state) => {
      function Fallback({ unavailable = false }: { unavailable?: boolean }) {
        const [open, setOpen] = useState(false);
        const fallback = useRef<HTMLButtonElement>(null);
        return (
          <>
            <div><div inert={unavailable && state === 'inert'}>
              {!(unavailable && state === 'removed') && (
                <button
                  onClick={() => setOpen(true)}
                  disabled={unavailable && state === 'disabled'}
                  hidden={unavailable && state === 'hidden'}
                  style={unavailable && state === 'css-hidden' ? { display: 'none' } : undefined}
                >Open editor</button>
              )}
            </div></div>
            <button ref={fallback}>Section fallback</button>
            <Sheet open={open} onClose={() => setOpen(false)} restoreFocus={() => fallback.current}>
              <h2>Editor</h2>
            </Sheet>
          </>
        );
      }
      const { rerender } = render(<Fallback />);
      const opener = screen.getByRole('button', { name: 'Open editor' });
      opener.focus();
      fireEvent.click(opener);
      rerender(<Fallback unavailable />);
      fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
      expect(screen.getByRole('button', { name: 'Section fallback' })).toHaveFocus();
      expect(screen.getByRole('button', { name: 'Section fallback' })).not.toHaveAttribute('tabindex');
    },
  );

  it('makes a noninteractive section fallback focusable without adding it to the Tab sequence', () => {
    function Section() {
      const [open, setOpen] = useState(true);
      const heading = useRef<HTMLHeadingElement>(null);
      return <>
        <h1 ref={heading}>Section</h1>
        <Sheet open={open} onClose={() => setOpen(false)} restoreFocus={() => heading.current}>
          <h2>Editor</h2>
        </Sheet>
      </>;
    }
    render(<Section />);
    const heading = screen.getByRole('heading', { name: 'Section' });
    expect(heading).not.toHaveAttribute('tabindex');
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(heading).toHaveFocus();
    expect(heading).toHaveAttribute('tabindex', '-1');
  });

  it('hides, rather than unmounts, body/footer during a guard and focuses Keep editing once', () => {
    const view = (guarded: boolean, text: string) => (
      <Sheet
        open onClose={() => {}} pattern="short-editor" title="Editor"
        header={<h2>Edit name</h2>}
        footer={<button>Save</button>}
        guard={guarded ? <><h3>Discard changes?</h3><button data-sheet-focus>Keep editing</button><button>Discard</button><p>{text}</p></> : undefined}
      >
        <input aria-label="Name" defaultValue="Original" />
      </Sheet>
    );
    const { rerender } = render(view(false, ''));
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'Edited' } });
    rerender(view(true, 'First guard'));
    expect(input).toBeInTheDocument();
    expect(input).not.toBeVisible();
    expect(screen.getByRole('button', { name: 'Save', hidden: true })).not.toBeVisible();
    expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus();
    screen.getByRole('button', { name: 'Discard' }).focus();
    rerender(view(true, 'Guard rerender'));
    expect(screen.getByRole('button', { name: 'Discard' })).toHaveFocus();
    rerender(view(false, ''));
    expect(screen.getByRole('textbox')).toBe(input);
    expect(input).toHaveValue('Edited');
    rerender(view(true, 'Guard again'));
    expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus();
  });
});

describe('adaptive sheet framing', () => {
  it.each(['fieldset', 'semantic'] as const)('measures the complete %s group when each individual option fits', (kind) => {
    const options = <>
      <label><input type="checkbox" />Cash</label>
      <label><input type="checkbox" />Savings</label>
      <label><input type="checkbox" />Emergency fund</label>
    </>;
    render(<Sheet open pattern="long-editor" onClose={() => {}}
      header={<h2>Editor</h2>} footer={<button>Save</button>}>
      {kind === 'fieldset' ? <fieldset data-testid="accounts"><legend>Funding accounts</legend>{options}</fieldset>
        : <div role="group" aria-labelledby="funding-title" data-testid="accounts"><h3 id="funding-title">Funding accounts</h3>{options}</div>}
    </Sheet>);
    const card = screen.getByRole('dialog');
    card.style.padding = '20px';
    card.style.rowGap = '16px';
    Object.defineProperty(card, 'clientHeight', { get: () => 415 });
    card.querySelector<HTMLElement>('.sheet-header')!.getBoundingClientRect = () => new DOMRect(0, 0, 300, 100);
    card.querySelector<HTMLElement>('.sheet-footer')!.getBoundingClientRect = () => new DOMRect(0, 0, 300, 70);
    const group = screen.getByTestId('accounts');
    group.getBoundingClientRect = () => new DOMRect(0, 0, 300, 260);
    const controls = screen.getAllByRole('checkbox');
    controls.forEach((control, index) => {
      control.getBoundingClientRect = () => new DOMRect(0, 80 * index + 18, 24, 24);
      control.closest('label')!.getBoundingClientRect = () => new DOMRect(0, 80 * index, 300, 60);
    });
    controls[1].focus();
    act(() => notifyResizeObservers());
    expect(card).toHaveClass('sheet-flow');
    expect(controls[1]).toHaveFocus();
  });

  it('measures a later wrapped field even when the first labeled input fits', () => {
    const { unmount } = render(<Sheet open pattern="long-editor" onClose={() => {}}
      header={<h2>Editor</h2>} footer={<button>Save</button>}>
      <label>Name<input defaultValue="Draft" /></label>
      <label>Net hourly rate (EUR, optional)<input /></label>
    </Sheet>);
    try {
      const card = screen.getByRole('dialog');
      const body = card.querySelector<HTMLElement>('.sheet-body')!;
      card.style.padding = '20px';
      card.style.rowGap = '16px';
      body.style.fontSize = '16px';
      body.style.lineHeight = '24px';
      Object.defineProperty(card, 'clientHeight', { get: () => 415 });
      card.querySelector<HTMLElement>('.sheet-header')!.getBoundingClientRect = () => new DOMRect(0, 0, 300, 100);
      card.querySelector<HTMLElement>('.sheet-footer')!.getBoundingClientRect = () => new DOMRect(0, 0, 300, 70);
      const inputs = screen.getAllByRole('textbox');
      inputs[0].getBoundingClientRect = () => new DOMRect(0, 36, 300, 44);
      inputs[0].closest('label')!.getBoundingClientRect = () => new DOMRect(0, 0, 300, 80);
      inputs[1].getBoundingClientRect = () => new DOMRect(0, 290, 300, 88);
      inputs[1].closest('label')!.getBoundingClientRect = () => new DOMRect(0, 200, 300, 178);
      inputs[1].focus();
      act(() => notifyResizeObservers());
      expect(card).toHaveClass('sheet-flow');
      expect(inputs[1]).toHaveFocus();
      expect(inputs[0]).toHaveValue('Draft');
    } finally {
      unmount();
    }
  });

  it('keeps the focused action visible after a resize that does not change scroll framing', async () => {
    const { unmount } = render(<Sheet open pattern="confirmation" onClose={() => {}}
      header={<h2>Delete import?</h2>} footer={<button>Cancel</button>}>
      <label>Name<input defaultValue="Draft" /></label>
    </Sheet>);
    try {
      const card = screen.getByRole('dialog');
      const body = card.querySelector<HTMLElement>('.sheet-body')!;
      const cancel = screen.getByRole('button', { name: 'Cancel' });
      const input = screen.getByRole('textbox') as HTMLInputElement;
      Object.defineProperty(card, 'clientHeight', { get: () => 300 });
      card.style.padding = '20px';
      card.style.rowGap = '16px';
      card.style.overflowY = 'auto';
      card.getBoundingClientRect = () => new DOMRect(0, 100, 300, 300);
      card.querySelector<HTMLElement>('.sheet-header')!.getBoundingClientRect = () => new DOMRect(0, 100, 300, 100);
      card.querySelector<HTMLElement>('.sheet-footer')!.getBoundingClientRect = () => new DOMRect(0, 600, 300, 70);
      input.getBoundingClientRect = () => new DOMRect(0, 200, 300, 44);
      input.closest('label')!.getBoundingClientRect = () => new DOMRect(0, 180, 300, 100);
      body.getBoundingClientRect = () => new DOMRect(0, 200, 300, 100);
      cancel.getBoundingClientRect = () => new DOMRect(0, 600, 100, 44);
      cancel.scrollIntoView = vi.fn();
      cancel.focus();
      act(() => notifyResizeObservers());
      expect(card).toHaveClass('sheet-flow');
      await waitFor(() => expect(cancel.scrollIntoView).toHaveBeenCalled());
      vi.mocked(cancel.scrollIntoView).mockClear();
      act(() => notifyResizeObservers());
      await waitFor(() => expect(cancel.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' }));
      expect(cancel).toHaveFocus();

      vi.mocked(cancel.scrollIntoView).mockClear();
      input.scrollIntoView = vi.fn();
      act(() => notifyResizeObservers());
      input.focus();
      input.setSelectionRange(1, 3);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      expect(cancel.scrollIntoView).not.toHaveBeenCalled();
      expect(input.scrollIntoView).not.toHaveBeenCalled();
      expect(input).toHaveFocus();
      expect([input.selectionStart, input.selectionEnd]).toEqual([1, 3]);
    } finally {
      unmount();
    }
  });

  it('returns framing to one scrolling flow when a labeled control cannot fit, without replacing focus', () => {
    const { unmount } = render(<Sheet open pattern="long-editor" onClose={() => {}}
      header={<h2>Editor</h2>} footer={<button>Save</button>}>
      <label>Name<input defaultValue="Draft" /></label>
    </Sheet>);
    try {
      const card = screen.getByRole('dialog');
      const body = card.querySelector<HTMLElement>('.sheet-body')!;
      const header = card.querySelector<HTMLElement>('.sheet-header')!;
      const footer = card.querySelector<HTMLElement>('.sheet-footer')!;
      const input = screen.getByRole('textbox') as HTMLInputElement;
      let height = 300;
      Object.defineProperty(card, 'clientHeight', { get: () => height });
      card.style.padding = '20px';
      card.style.rowGap = '16px';
      body.style.fontSize = '16px';
      body.style.lineHeight = '24px';
      header.getBoundingClientRect = () => new DOMRect(0, 0, 300, 100);
      footer.getBoundingClientRect = () => new DOMRect(0, 0, 300, 70);
      input.getBoundingClientRect = () => new DOMRect(0, 56, 300, 44);
      input.closest('label')!.getBoundingClientRect = () => new DOMRect(0, 0, 300, 100);
      input.scrollIntoView = vi.fn();
      input.focus();
      act(() => notifyResizeObservers());
      expect(card).toHaveClass('sheet-flow');
      expect(input).toHaveFocus();
      expect(input).toHaveValue('Draft');
      height = 700;
      act(() => notifyResizeObservers());
      expect(card).not.toHaveClass('sheet-flow');
      expect(screen.getByRole('textbox')).toBe(input);
      expect(input).toHaveFocus();
      expect(input.scrollIntoView).toHaveBeenCalled();
    } finally {
      unmount();
    }
  });
});

describe('sheet modality and dismissal', () => {
  it('reversibly inerts sibling branches and locks the actual screen, including StrictMode and suspension', () => {
    const view = (open: boolean, shown: boolean) => (
      <StrictMode>
        <nav><button>Navigation</button></nav>
        <aside inert />
        <div className="screen" hidden={!shown} style={{ overflowY: 'scroll' }}>
          <ScreenShown value={shown}>
            <section>
              <div data-testid="background">Background content</div>
              <Sheet open={open} onClose={() => {}} position="center" wide title="Modal">
                <h2>Modal heading</h2>
              </Sheet>
            </section>
          </ScreenShown>
        </div>
      </StrictMode>
    );
    document.body.style.overflow = 'auto';
    const { rerender, unmount } = render(view(true, true));
    const screenElement = document.querySelector<HTMLElement>('.screen')!;
    expect(document.querySelector('nav')).toHaveAttribute('inert');
    expect(screen.getByTestId('background')).toHaveAttribute('inert');
    expect(screen.getByRole('dialog').closest('.backdrop')).not.toHaveAttribute('inert');
    expect(screen.getByRole('dialog')).toHaveClass('sheet-wide');
    expect(screen.getByRole('dialog').parentElement).toHaveClass('backdrop-center');
    expect(document.body.style.overflow).toBe('hidden');
    expect(screenElement.style.overflow).toBe('hidden');
    rerender(view(true, false));
    expect(document.querySelector('nav')).not.toHaveAttribute('inert');
    expect(screen.getByTestId('background')).not.toHaveAttribute('inert');
    expect(document.querySelector('aside')).toHaveAttribute('inert', '');
    expect(document.body.style.overflow).toBe('auto');
    expect(screenElement.style.overflowY).toBe('scroll');
    rerender(view(true, true));
    expect(document.body.style.overflow).toBe('hidden');
    rerender(view(false, true));
    expect(document.body.style.overflow).toBe('auto');
    expect(document.querySelector('nav')).not.toHaveAttribute('inert');
    rerender(view(true, true));
    unmount();
    expect(document.body.style.overflow).toBe('auto');
    document.body.style.overflow = '';
  });

  it('suspends on a hidden ancestor even without ScreenShown, and resumes when revealed', async () => {
    const onClose = vi.fn();
    const { container } = render(<div><Sheet open onClose={onClose}><button>Action</button></Sheet></div>);
    const ancestor = container.firstElementChild as HTMLElement;
    ancestor.hidden = true;
    await waitFor(() => expect(document.body.style.overflow).toBe(''));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(document, { key: 'Tab' })).toBe(true);
    ancestor.hidden = false;
    await waitFor(() => expect(document.body.style.overflow).toBe('hidden'));
    expect(screen.getByRole('dialog')).toHaveFocus();
  });

  it.each(['confirmation', 'short-editor', 'long-editor', 'builder'] as const)(
    'uses the %s backdrop policy and rejects drag-out/click-only dismissal', (pattern) => {
      const onClose = vi.fn();
      render(<Sheet open onClose={onClose} pattern={pattern}><h2>Dialog</h2></Sheet>);
      const card = screen.getByRole('dialog');
      const backdrop = card.parentElement!;
      fireEvent.click(backdrop);
      fireEvent.pointerDown(card);
      fireEvent.pointerUp(backdrop);
      fireEvent.click(backdrop);
      expect(onClose).not.toHaveBeenCalled();
      fireEvent.pointerDown(backdrop);
      fireEvent.pointerCancel(backdrop);
      fireEvent.click(backdrop);
      expect(onClose).not.toHaveBeenCalled();
      fireEvent.pointerDown(backdrop);
      fireEvent.pointerUp(backdrop);
      fireEvent.click(backdrop);
      expect(onClose).toHaveBeenCalledTimes(pattern === 'confirmation' || pattern === 'short-editor' ? 1 : 0);
    },
  );

  it('blocks every dismissal while busy without dropping the focused close control', () => {
    const onClose = vi.fn();
    const view = (busy: boolean) => <Sheet open onClose={onClose} busy={busy}><h2>Editor</h2></Sheet>;
    const { rerender } = render(view(false));
    const close = screen.getByRole('button', { name: 'Close dialog' });
    close.focus();
    rerender(view(true));
    expect(close).toHaveFocus();
    expect(close).not.toBeDisabled();
    expect(close).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Working. Please wait before closing.')).toBeVisible();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    fireEvent.click(close);
    fireEvent.keyDown(close, { key: 'Escape' });
    const backdrop = screen.getByRole('dialog').parentElement!;
    fireEvent.pointerDown(backdrop);
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
    rerender(view(false));
    fireEvent.keyDown(close, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each([false, true])('gives child Escape priority regardless of registration order (late child: %s)', (late) => {
    const onClose = vi.fn();
    const onChildEscape = vi.fn();
    const view = (child: boolean) => (
      <Sheet open onClose={onClose} title="Editor">
        {child && <ChildPopover onEscape={onChildEscape} />}
      </Sheet>
    );
    const { rerender } = render(view(!late));
    if (late) rerender(view(true));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Popover action' }), { key: 'Escape' });
    expect(onChildEscape).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    rerender(view(false));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not let an inert background popover claim the modal Escape', () => {
    const onClose = vi.fn();
    const onChildEscape = vi.fn();
    render(<><ChildPopover onEscape={onChildEscape} /><Sheet open onClose={onClose}><h2>Modal</h2></Sheet></>);
    expect(screen.getByRole('button', { name: 'Popover action' })).toHaveAttribute('inert');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onChildEscape).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('honors a child control preventing Escape in its own key handler', () => {
    const onClose = vi.fn();
    render(<Sheet open onClose={onClose}><input aria-label="Child" onKeyDown={(event) => event.preventDefault()} /></Sheet>);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
