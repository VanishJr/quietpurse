import { act, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useDismiss } from './dismiss';
import { Sheet } from './components/Sheet';
import { renderThemed } from './test/harness';
import { ScreenShown } from './screen';

function Popover({ onEscape, onPress, onDeparture, insideId = 'toggle', onClick }: {
  onEscape: () => void; onPress: () => void; onDeparture?: () => void;
  insideId?: string; onClick?: () => void;
}) {
  useDismiss(true, (target) => target.id === insideId, onEscape, onPress, onDeparture);
  return <><button id="toggle" onClick={onClick}>Toggle</button><button id="other">Other</button></>;
}

describe('useDismiss', () => {
  it('hears nothing while its screen is hidden, and hears again once it shows', () => {
    const onEscape = vi.fn();
    const onPress = vi.fn();
    const on = (shown: boolean) => (
      <ScreenShown value={shown}><Popover onEscape={onEscape} onPress={onPress} /></ScreenShown>
    );
    const { rerender } = render(on(false));

    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.pointerDown(document.body);
    expect(onEscape).not.toHaveBeenCalled();
    expect(onPress).not.toHaveBeenCalled();

    rerender(on(true));
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.pointerDown(document.body);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Toggle' }));
    expect(onEscape).toHaveBeenCalledOnce();
    expect(onPress).toHaveBeenCalledOnce();
  });

  it.each(['hidden', 'inert', 'display', 'visibility', 'details'] as const)(
    'does not claim Escape or outside presses from a %s branch', (kind) => {
      const onEscape = vi.fn();
      const onPress = vi.fn();
      const onDeparture = vi.fn();
      const popover = <Popover onEscape={onEscape} onPress={onPress} onDeparture={onDeparture} />;
      render(kind === 'details' ? <details>{popover}</details> : (
        <div
          hidden={kind === 'hidden'} inert={kind === 'inert'}
          style={{ display: kind === 'display' ? 'none' : undefined, visibility: kind === 'visibility' ? 'hidden' : undefined }}
        >{popover}</div>
      ));
      expect(fireEvent.keyDown(document, { key: 'Escape' })).toBe(true);
      fireEvent.pointerDown(document.body);
      fireEvent.focusIn(document.body);
      expect(onEscape).not.toHaveBeenCalled();
      expect(onPress).not.toHaveBeenCalled();
      expect(onDeparture).not.toHaveBeenCalled();
    },
  );

  it('reports keyboard and programmatic departure without restoring focus', () => {
    const onDeparture = vi.fn();
    render(<Popover onEscape={vi.fn()} onPress={vi.fn()} onDeparture={onDeparture} />);
    act(() => screen.getByRole('button', { name: 'Toggle' }).focus());
    fireEvent.keyDown(document, { key: 'Tab' });
    const other = screen.getByRole('button', { name: 'Other' });
    act(() => other.focus());
    expect(onDeparture).toHaveBeenCalledOnce();
    expect(other).toHaveFocus();
  });

  it.each([false, true])('protects an inside press until after its click (pointerup: %s)', async (up) => {
    vi.useFakeTimers();
    try {
      const onDeparture = vi.fn();
      const onClick = vi.fn();
      render(<Popover onEscape={vi.fn()} onPress={vi.fn()} onDeparture={onDeparture} onClick={onClick} />);
      const toggle = screen.getByRole('button', { name: 'Toggle' });
      act(() => toggle.focus());
      fireEvent.pointerDown(toggle);
      act(() => screen.getByRole('button', { name: 'Other' }).focus());
      if (up) fireEvent.pointerUp(toggle);
      // A microtask may precede the browser's click; settlement must not.
      await act(async () => { await Promise.resolve(); });
      expect(onDeparture).not.toHaveBeenCalled();
      fireEvent.click(toggle);
      expect(onClick).toHaveBeenCalledOnce();
      expect(onDeparture).not.toHaveBeenCalled();
      act(() => vi.runAllTimers());
      expect(onDeparture).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['pointerCancel', 'pointerUp'] as const)('settles %s without a click against current focus', (release) => {
    vi.useFakeTimers();
    try {
      const onDeparture = vi.fn();
      render(<Popover onEscape={vi.fn()} onPress={vi.fn()} onDeparture={onDeparture} />);
      const toggle = screen.getByRole('button', { name: 'Toggle' });
      const other = screen.getByRole('button', { name: 'Other' });
      fireEvent.pointerDown(toggle);
      act(() => other.focus());
      fireEvent[release](toggle);
      act(() => toggle.focus());
      act(() => vi.runAllTimers());
      expect(onDeparture).not.toHaveBeenCalled();
      fireEvent.pointerDown(toggle);
      act(() => other.focus());
      fireEvent[release](toggle);
      expect(onDeparture).not.toHaveBeenCalled();
      act(() => vi.runAllTimers());
      expect(onDeparture).toHaveBeenCalledOnce();
      expect(other).toHaveFocus();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([false, true])('releases an abandoned press on Tab (focus already outside: %s)', (left) => {
    const onDeparture = vi.fn();
    render(<Popover onEscape={vi.fn()} onPress={vi.fn()} onDeparture={onDeparture} />);
    const toggle = screen.getByRole('button', { name: 'Toggle' });
    const other = screen.getByRole('button', { name: 'Other' });
    act(() => toggle.focus());
    fireEvent.pointerDown(toggle);
    if (left) act(() => other.focus());
    expect(onDeparture).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Tab' });
    if (!left) act(() => other.focus());
    expect(onDeparture).toHaveBeenCalledOnce();
  });

  it('a new press invalidates stale protection and its scheduled settlement', () => {
    vi.useFakeTimers();
    try {
      const onPress = vi.fn();
      const onDeparture = vi.fn();
      render(<Popover onEscape={vi.fn()} onPress={onPress} onDeparture={onDeparture} />);
      const toggle = screen.getByRole('button', { name: 'Toggle' });
      const other = screen.getByRole('button', { name: 'Other' });
      fireEvent.pointerDown(toggle);
      act(() => other.focus());
      fireEvent.pointerUp(toggle);
      fireEvent.pointerDown(toggle);
      act(() => vi.runAllTimers());
      expect(onDeparture).not.toHaveBeenCalled();
      fireEvent.pointerDown(other);
      expect(onPress).toHaveBeenCalledOnce();
      fireEvent.focusIn(other);
      expect(onDeparture).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps callbacks and inside checks current without rerenders resetting a press', () => {
    vi.useFakeTimers();
    try {
      const old = { onEscape: vi.fn(), onPress: vi.fn(), onDeparture: vi.fn() };
      const next = { onEscape: vi.fn(), onPress: vi.fn(), onDeparture: vi.fn() };
      const settled = vi.fn();
      const { rerender } = render(<Popover {...old} />);
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Toggle' }));
      rerender(<Popover {...next} />);
      act(() => screen.getByRole('button', { name: 'Other' }).focus());
      expect(next.onDeparture).not.toHaveBeenCalled();
      fireEvent.pointerUp(document);
      rerender(<Popover {...next} onDeparture={settled} />);
      act(() => vi.runAllTimers());
      expect(settled).toHaveBeenCalledOnce();
      expect(next.onDeparture).not.toHaveBeenCalled();
      rerender(<Popover {...next} insideId="other" />);
      fireEvent.focusIn(screen.getByRole('button', { name: 'Other' }));
      expect(next.onDeparture).not.toHaveBeenCalled();
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Toggle' }));
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(next.onPress).toHaveBeenCalledOnce();
      expect(next.onEscape).toHaveBeenCalledOnce();
      for (const callback of Object.values(old)) expect(callback).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['hide', 'unmount'] as const)('cleans up pending press settlement and listeners on %s', (end) => {
    vi.useFakeTimers();
    const added = vi.spyOn(document, 'addEventListener');
    const removed = vi.spyOn(document, 'removeEventListener');
    try {
      const callbacks = { onEscape: vi.fn(), onPress: vi.fn(), onDeparture: vi.fn() };
      const view = (shown: boolean) => <ScreenShown value={shown}><Popover {...callbacks} /></ScreenShown>;
      const { rerender, unmount } = render(<StrictMode>{view(true)}</StrictMode>);
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Toggle' }));
      act(() => screen.getByRole('button', { name: 'Other' }).focus());
      act(() => vi.runAllTimers());
      fireEvent.pointerUp(document);
      if (end === 'hide') rerender(<StrictMode>{view(false)}</StrictMode>);
      else unmount();
      expect(vi.getTimerCount()).toBe(0);
      const events = ['keydown', 'pointerdown', 'focusin', 'pointerup', 'pointercancel', 'click'];
      for (const registration of added.mock.calls.filter(([type, , capture]) => events.includes(type) && capture === true)) {
        expect(removed.mock.calls).toContainEqual(registration);
      }
      act(() => vi.runAllTimers());
      fireEvent.keyDown(document, { key: 'Escape' });
      fireEvent.pointerDown(document.body);
      fireEvent.focusIn(document.body);
      for (const callback of Object.values(callbacks)) expect(callback).not.toHaveBeenCalled();
    } finally {
      added.mockRestore();
      removed.mockRestore();
      vi.useRealTimers();
    }
  });

  it('gives an available child Escape before its sheet, but not an inert background popover', () => {
    const childEscape = vi.fn();
    const backgroundEscape = vi.fn();
    const sheetEscape = vi.fn();
    function Child() {
      useDismiss(true, (target) => target.id === 'child', childEscape, vi.fn());
      return <button id="child">Child action</button>;
    }
    renderThemed(<>
      <Popover onEscape={backgroundEscape} onPress={vi.fn()} />
      <Sheet open onClose={sheetEscape} title="Owner"><Child /></Sheet>
    </>);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(childEscape).toHaveBeenCalledOnce();
    expect(backgroundEscape).not.toHaveBeenCalled();
    expect(sheetEscape).not.toHaveBeenCalled();
  });

  it('respects an already claimed Escape and cleans up under StrictMode', () => {
    const onEscape = vi.fn();
    const onPress = vi.fn();
    const { unmount } = render(<StrictMode><Popover onEscape={onEscape} onPress={onPress} /></StrictMode>);
    const claimed = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    claimed.preventDefault();
    document.dispatchEvent(claimed);
    expect(onEscape).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(document, { key: 'Escape' })).toBe(false);
    expect(onEscape).toHaveBeenCalledOnce();
    unmount();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.pointerDown(document.body);
    expect(onEscape).toHaveBeenCalledOnce();
    expect(onPress).not.toHaveBeenCalled();
  });
});
