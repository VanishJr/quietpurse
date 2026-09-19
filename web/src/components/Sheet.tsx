import { useEffect, useRef } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
  /** 'bottom' — slides up from the bottom edge on a phone; 'center' — a dialog. */
  position?: 'bottom' | 'center';
  /**
   * A wider card. Every sheet in the app is a question and a couple of controls and
   * fits the default 420px; the chart wizard is a grid of shapes and a form beside a
   * live plot, and at that measure the grid is one tile per row.
   */
  wide?: boolean;
  title?: string;
  children: React.ReactNode;
}

/**
 * A modal panel. Replaces React Native's <Modal>: closes on Escape and on a click
 * outside the card, and moves focus into the panel on open so keyboard users don't
 * stay behind on the page underneath.
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
   * that reason: every caller passes a fresh `onClose` arrow on each render, so while
   * this sat in the effect above it re-ran — and re-focused the card — every time the
   * parent rendered for any reason at all.
   *
   * Nothing noticed while every sheet in the app was a question and two buttons. The
   * chart wizard has a name box: open it before the account list has landed, start
   * typing, and the render that list arrives on took the caret out of the input
   * mid-word.
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
