import { useContext, useEffect } from 'react';
import { ScreenShown } from './screen';

/**
 * Escape anywhere, and a press on anything `inside` does not claim, dismiss what is open.
 *
 * The press is heard in the CAPTURE phase and a claimed press is let through, which is
 * what makes a popover's own toggle a toggle: without the exemption, the press closes the
 * popover and the click that follows opens it again. So the toggle is one of the things
 * `inside` claims.
 *
 * Bound when `open` or the screen's showing changes, not on every render: the handlers
 * are the ones from the render that bound them. While the Shell hides the screen it sits
 * on, nothing is heard: an Escape or a press there belongs to the screen that is showing.
 */
export function useDismiss(
  open: unknown,
  inside: (target: Element) => boolean,
  onEscape: () => void,
  onOutsidePress: () => void,
): void {
  const shown = useContext(ScreenShown);
  useEffect(() => {
    if (!open || !shown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onEscape();
    };
    const onPointer = (e: Event) => {
      if (!(e.target instanceof Element && inside(e.target))) onOutsidePress();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer, true);
    };
  }, [open, shown]);
}
