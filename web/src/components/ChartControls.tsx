import { useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { isAvailable, useDismiss } from '../dismiss';
import { ScreenShown } from '../screen';
import { Button } from './Button';

interface Props {
  id: string;
  label: string;
  contextual?: boolean;
  onEdit: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  fallbackFocus: () => HTMLElement | null;
}

export function ChartControls({ id, label, contextual = false, onEdit, onDuplicate, onDelete, fallbackFocus }: Props) {
  const shown = useContext(ScreenShown);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const anchor = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const anchorBox = useRef<DOMRect | null>(null);
  const entered = useRef<boolean | null>(null);
  const menuId = useId();

  const close = (restore = true) => {
    setOpen(false);
    setConfirming(false);
    if (restore && shown && anchor.current && isAvailable(anchor.current)) anchor.current.focus();
  };

  useDismiss(open,
    (target) => !!(anchor.current?.contains(target) || menu.current?.contains(target)),
    () => close(), () => close(false), () => close(false));

  useLayoutEffect(() => {
    const step = open ? confirming : null;
    const entering = step !== entered.current;
    entered.current = step;
    if (!open || !shown || !anchor.current || !menu.current
      || !isAvailable(anchor.current) || !isAvailable(menu.current)) return;
    const box = anchor.current.getBoundingClientRect();
    anchorBox.current = box;
    const popup = menu.current.getBoundingClientRect();
    const above = box.top - popup.height - 6;
    const wantedTop = contextual ? box.bottom + 6 : above;
    setPosition({
      left: Math.max(8, Math.min(box.right - popup.width, window.innerWidth - popup.width - 8)),
      top: Math.max(8, Math.min(wantedTop, window.innerHeight - popup.height - 8)),
    });
    // Entry focus belongs to opening or confirming; a returning screen's focus is the Shell's.
    if (!entering) return;
    const first = menu.current.querySelector<HTMLButtonElement>('button');
    if (first && isAvailable(first)) {
      first.focus({ preventScroll: true });
      const frame = menu.current.getBoundingClientRect();
      const control = first.getBoundingClientRect();
      // Reveal the safe action within its group without scrolling the owning chart.
      if (control.bottom > frame.bottom - 4) menu.current.scrollTop += control.bottom - frame.bottom + 4;
      else if (control.top < frame.top + 4) menu.current.scrollTop -= frame.top - control.top + 4;
    }
  }, [open, confirming, contextual, shown]);

  useEffect(() => {
    if (!open || !shown) return;
    const moved = (event: Event) => {
      if (event.target instanceof Node && menu.current?.contains(event.target)) return;
      if (!anchor.current || !isAvailable(anchor.current)) {
        // A scroll under an inert or hidden branch suspends the group; a resize can undraw the
        // anchor for good, and closing later would hand it focus out of nowhere.
        if (event.type === 'resize') close(false);
        return;
      }
      if (event.type === 'scroll' && anchorBox.current) {
        const now = anchor.current.getBoundingClientRect();
        const at = anchorBox.current;
        // A delayed opening scroll notification is not a moved anchor.
        if (now.top === at.top && now.right === at.right && now.bottom === at.bottom) return;
      }
      close();
    };
    window.addEventListener('resize', moved);
    document.addEventListener('scroll', moved, true);
    return () => {
      window.removeEventListener('resize', moved);
      document.removeEventListener('scroll', moved, true);
    };
  }, [open, shown]);

  const act = (action: (id: string) => void, deleting = false) => {
    const losesAnchor = deleting || (contextual && action === onDuplicate);
    close(!losesAnchor);
    if (losesAnchor && shown) {
      const fallback = fallbackFocus();
      if (fallback && isAvailable(fallback)) fallback.focus();
    }
    action(id);
  };

  const toggle = () => {
    if (open) close();
    else { setConfirming(false); setOpen(true); }
  };
  const name = `${contextual ? 'More actions' : 'Actions'} for ${label}`;

  return (
    <>
      {contextual && <Button type="button" variant="secondary" size="compact" onClick={() => onEdit(id)}>Edit chart</Button>}
      {contextual ? (
        <Button type="button" variant="tertiary" size="compact" ref={anchor} aria-label={name} aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={toggle}>More actions</Button>
      ) : (
        <button type="button" className="dock-more" ref={anchor} aria-label={name} aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={toggle}><span aria-hidden="true">⋮</span></button>
      )}
      {open && (
        <div id={menuId} ref={menu} className="dock-menu" style={position} role="group" aria-label={`Actions for ${label}`}>
          {confirming ? (
            <>
              <p className="dock-menu-ask">Delete “{label}”?</p>
              <div className="dock-menu-row">
                <Button type="button" variant="secondary" size="compact" onClick={() => setConfirming(false)}>Keep</Button>
                <Button type="button" variant="destructive-primary" size="compact" onClick={() => act(onDelete, true)}>Delete</Button>
              </div>
            </>
          ) : (
            <>
              {!contextual && <Button type="button" variant="tertiary" size="compact" className="dock-menu-item" onClick={() => act(onEdit)}>Edit</Button>}
              <Button type="button" variant="tertiary" size="compact" className="dock-menu-item" onClick={() => act(onDuplicate)}>Duplicate</Button>
              <Button type="button" variant="destructive-secondary" size="compact" className="dock-menu-item" onClick={() => setConfirming(true)}>Delete</Button>
            </>
          )}
        </div>
      )}
    </>
  );
}
