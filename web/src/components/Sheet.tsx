import { useContext, useEffect, useRef } from 'react';
import { ScreenShown } from '../screen';

interface Props {
  open: boolean;
  onClose: () => void;
  /** 'bottom' — on the bottom edge on a phone; 'center' — a dialog. */
  position?: 'bottom' | 'center';
  wide?: boolean;
  title?: string;
  children: React.ReactNode;
}

/**
 * What a caller relies on is stated in `web/src/SPEC.md`, under *What the shared
 * controls promise*.
 */
export function Sheet({ open, onClose, position = 'bottom', wide = false, title, children }: Props) {
  const cardRef = useRef<HTMLDivElement>(null);
  const shown = useContext(ScreenShown);
  const live = open && shown;

  useEffect(() => {
    if (!live) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key !== 'Tab') return;
      const card = cardRef.current;
      if (!card || card.closest('[hidden]')) return;
      const controls = Array.from(card.querySelectorAll<HTMLElement>(
        ':is(button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"])',
      )).filter((el) => !el.closest('[hidden]'));
      const first = controls[0];
      const last = controls[controls.length - 1];
      const fromPanel = document.activeElement instanceof HTMLElement &&
        card.contains(document.activeElement) && !controls.includes(document.activeElement);
      if (!first) {
        e.preventDefault();
        card.focus();
      } else if (e.shiftKey && (document.activeElement === first || fromPanel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || fromPanel)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [live, onClose]);

  /*
   * The opener is taken once per opening, not once per showing: a return to the screen
   * finds the navigation link that brought the reader back in focus, and that is not
   * where a close should send them.
   */
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement;
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [open]);

  /*
   * Moving the keyboard in is its own effect, keyed on nothing but `live`: a caller may
   * pass a fresh `onClose` arrow on each render, and in the first effect this would
   * re-run — and re-focus the card, taking the caret out of an input mid-word — every
   * time the parent rendered for any reason at all.
   */
  useEffect(() => {
    if (live) cardRef.current?.focus();
  }, [live]);

  if (!open) return null;

  return (
    <div
      className={`backdrop backdrop-${position}`}
      onClick={onClose}
      role="presentation"
    >
      {/* stop propagation so a click on the card itself doesn't close it */}
      <div
        ref={cardRef}
        className={wide ? 'sheet sheet-wide' : 'sheet'}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
