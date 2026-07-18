import { useEffect, useRef } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
  /** 'bottom' — slides up from the bottom edge on a phone; 'center' — a dialog. */
  position?: 'bottom' | 'center';
  title?: string;
  children: React.ReactNode;
}

/**
 * A modal panel. Replaces React Native's <Modal>: closes on Escape and on a click
 * outside the card, and moves focus into the panel on open so keyboard users don't
 * stay behind on the page underneath.
 */
export function Sheet({ open, onClose, position = 'bottom', title, children }: Props) {
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    cardRef.current?.focus();
    // the page behind must not scroll while the sheet is up
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

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
        className="sheet"
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
