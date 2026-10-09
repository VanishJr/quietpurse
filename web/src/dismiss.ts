import { useContext, useEffect, useLayoutEffect, useRef } from 'react';
import { ScreenShown } from './screen';

export function isAvailable(element: HTMLElement): boolean {
  if (!element.isConnected || element.matches(':disabled')) return false;
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (node.hidden || node.hasAttribute('inert')) return false;
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (node instanceof HTMLDetailsElement && !node.open) {
      const summary = Array.from(node.children).find((child) => child.tagName === 'SUMMARY');
      if (!summary?.contains(element)) return false;
    }
  }
  return true;
}

export function useDismiss(
  open: unknown,
  inside: (target: Element) => boolean,
  onEscape: () => void,
  onOutsidePress: () => void,
  onFocusDeparture?: () => void,
): void {
  const shown = useContext(ScreenShown);
  const latest = { inside, onEscape, onOutsidePress, onFocusDeparture, live: !!open && shown };
  const current = useRef(latest);
  // Committed renders only: one React discards or suspends must not silence the group still on screen.
  useLayoutEffect(() => {
    current.current = latest;
  });
  useEffect(() => {
    if (!open || !shown) return;
    let insidePress = false;
    let pressed: Element | null = null;
    let settlement: ReturnType<typeof setTimeout> | undefined;
    const release = () => {
      insidePress = false;
      clearTimeout(settlement);
      settlement = undefined;
    };
    const available = () => current.current.live && Array.from(document.querySelectorAll<HTMLElement>('*'))
      .some((element) => current.current.inside(element) && isAvailable(element));
    const departed = (target: EventTarget | null) => {
      if (current.current.onFocusDeparture && !(target instanceof Element && current.current.inside(target))
        && available()) current.current.onFocusDeparture();
    };
    // Focus on the document, or on an ancestor of what was pressed, is where the browser puts a
    // press on something it does not focus — the group's own text — and not a place the reader went.
    const departedFromCurrent = () => {
      const focused = document.activeElement;
      if (!focused || focused === document.body || (pressed && focused.contains(pressed))) return;
      departed(focused);
    };
    const settle = () => {
      if (!insidePress) return;
      clearTimeout(settlement);
      // A microtask can run before click; retain the pressed action until that dispatch finishes.
      settlement = setTimeout(() => {
        release();
        departedFromCurrent();
      }, 0);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Tab') {
        release();
        departedFromCurrent();
      }
      if (event.key !== 'Escape' || event.defaultPrevented || !available()) return;
      event.preventDefault();
      current.current.onEscape();
    };
    const onPointer = (event: Event) => {
      release();
      pressed = null;
      if (!available()) return;
      if (event.target instanceof Element && current.current.inside(event.target)) {
        insidePress = !!current.current.onFocusDeparture;
        pressed = event.target;
      } else current.current.onOutsidePress();
    };
    const onFocus = (event: FocusEvent) => {
      if (!insidePress) departed(event.target);
    };
    // Capture phase, with a press `inside` claims let through: that is what keeps a popover's
    // own toggle a toggle, since otherwise the press closes it and the following click reopens it.
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('focusin', onFocus, true);
    document.addEventListener('pointerup', settle, true);
    document.addEventListener('pointercancel', settle, true);
    document.addEventListener('click', settle, true);
    return () => {
      release();
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('focusin', onFocus, true);
      document.removeEventListener('pointerup', settle, true);
      document.removeEventListener('pointercancel', settle, true);
      document.removeEventListener('click', settle, true);
    };
  }, [open, shown]);
}
