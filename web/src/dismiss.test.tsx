import { fireEvent, render, screen } from '@testing-library/react';
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
});
