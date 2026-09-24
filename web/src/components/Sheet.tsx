import { useEffect, useRef } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
  /** 'bottom' — on the bottom edge on a phone; 'center' — a dialog. */
  position?: 'bottom' | 'center';
  /** A wider card, for a sheet that carries a grid, or a form beside a live plot. */
  wide?: boolean;
  title?: string;
  children: React.ReactNode;
}

/**
 * What it does for every caller is stated in `web/src/SPEC.md`, under *What the shared
 * controls promise*.
 */
export function Sheet({ open, onClose, position = 'bottom', wide = false, title, children }: Props) {
  const cardRef = useRef<HTMLDivElement>(null);

  /* Escape closes it, and the page behind must not scroll while it is up. Keyed on
     `onClose` as well: it is a closure over the caller's state, and re-attaching a
     listener costs nothing. */
  useEffect(() => {
    if (!open) return;
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
  }, [open, onClose]);

  /*
   * Moving the keyboard in happens once, on opening, and is its own effect for exactly
   * that reason: a caller may pass a fresh `onClose` arrow on each render, and in the
   * effect above this would re-run — and re-focus the card, taking the caret out of an
   * input mid-word — every time the parent rendered for any reason at all.
   */
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement;
    cardRef.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [open]);

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
