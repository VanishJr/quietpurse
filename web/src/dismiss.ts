import { useContext, useEffect } from 'react';
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
): void {
  const shown = useContext(ScreenShown);
  useEffect(() => {
    if (!open || !shown) return;
    const available = () => Array.from(document.querySelectorAll<HTMLElement>('*'))
      .some((element) => inside(element) && isAvailable(element));
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !available()) return;
      event.preventDefault();
      onEscape();
    };
    const onPointer = (event: Event) => {
      if (!available()) return;
      if (!(event.target instanceof Element && inside(event.target))) onOutsidePress();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer, true);
    };
  }, [open, shown]);
}
