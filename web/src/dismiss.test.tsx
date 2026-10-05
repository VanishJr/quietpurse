import { fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useDismiss } from './dismiss';
import { ScreenShown } from './screen';

function Popover({ onEscape, onPress }: { onEscape: () => void; onPress: () => void }) {
  useDismiss(true, (target) => target.id === 'toggle', onEscape, onPress);
  return <button id="toggle">Toggle</button>;
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
      const popover = <Popover onEscape={onEscape} onPress={onPress} />;
      render(kind === 'details' ? <details>{popover}</details> : (
        <div
          hidden={kind === 'hidden'} inert={kind === 'inert'}
          style={{ display: kind === 'display' ? 'none' : undefined, visibility: kind === 'visibility' ? 'hidden' : undefined }}
        >{popover}</div>
      ));
      expect(fireEvent.keyDown(document, { key: 'Escape' })).toBe(true);
      fireEvent.pointerDown(document.body);
      expect(onEscape).not.toHaveBeenCalled();
      expect(onPress).not.toHaveBeenCalled();
    },
  );

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
