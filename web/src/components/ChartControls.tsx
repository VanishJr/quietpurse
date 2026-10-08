import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useDismiss } from '../dismiss';
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
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const anchor = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const close = (restore = true) => {
    setOpen(false);
    setConfirming(false);
    if (restore) anchor.current?.focus();
  };

  useDismiss(open,
    (target) => !!(anchor.current?.contains(target) || menu.current?.contains(target)),
    () => close(), () => close(false));

  useLayoutEffect(() => {
    if (!open || !anchor.current || !menu.current) return;
    const box = anchor.current.getBoundingClientRect();
    const popup = menu.current.getBoundingClientRect();
    const above = box.top - popup.height - 6;
    const wantedTop = contextual ? box.bottom + 6 : above;
    setPosition({
      left: Math.max(8, Math.min(box.right - popup.width, window.innerWidth - popup.width - 8)),
      top: Math.max(8, Math.min(wantedTop, window.innerHeight - popup.height - 8)),
    });
    menu.current.querySelector<HTMLButtonElement>('button')?.focus();
  }, [open, confirming, contextual]);

  useEffect(() => {
    if (!open) return;
    const moved = (event: Event) => {
      if (event.target instanceof Node && menu.current?.contains(event.target)) return;
      close();
    };
    window.addEventListener('resize', moved);
    document.addEventListener('scroll', moved, true);
    return () => {
      window.removeEventListener('resize', moved);
      document.removeEventListener('scroll', moved, true);
    };
  }, [open]);

  const act = (action: (id: string) => void, deleting = false) => {
    close(!deleting);
    if (deleting) fallbackFocus()?.focus();
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
              <p className="dock-menu-ask">Only this saved chart is removed. Accounts and transactions stay.</p>
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
