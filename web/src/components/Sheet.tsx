import { useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { isAvailable } from '../dismiss';
import { ScreenShown } from '../screen';
import { Button } from './Button';
import { CloseIcon } from './SettingsActionIcons';
import { NavigationNotice } from './NavigationNotice';

interface Props {
  open: boolean;
  onClose: () => void;
  position?: 'bottom' | 'center';
  wide?: boolean;
  title?: string;
  pattern?: 'confirmation' | 'short-editor' | 'long-editor' | 'builder';
  stepKey?: string;
  busy?: boolean;
  initialFocus?: () => HTMLElement | null;
  restoreFocus?: () => HTMLElement | null;
  header?: ReactNode;
  footer?: ReactNode;
  guard?: ReactNode;
  children: ReactNode;
}

function controlsIn(card: HTMLElement): HTMLElement[] {
  return Array.from(card.querySelectorAll<HTMLElement>(
    'button, a[href], input, select, textarea, summary, [tabindex], [contenteditable="true"]',
  )).filter((element) => element.tabIndex >= 0 && isAvailable(element));
}

function focus(element: HTMLElement): boolean {
  if (!isAvailable(element)) return false;
  element.focus({ preventScroll: true });
  return document.activeElement === element;
}

function lockScroll(element: HTMLElement): () => void {
  const properties = ['overflow', 'overflow-x', 'overflow-y'];
  const previous = properties.map((property) => [
    property, element.style.getPropertyValue(property), element.style.getPropertyPriority(property),
  ]);
  const top = element.scrollTop;
  const left = element.scrollLeft;
  element.style.overflow = 'hidden';
  return () => {
    for (const property of properties) element.style.removeProperty(property);
    for (const [property, value, priority] of previous) {
      if (value) element.style.setProperty(property, value, priority);
    }
    if (!element.closest('[hidden]')) {
      element.scrollTop = top;
      element.scrollLeft = left;
    }
  };
}

export function Sheet({
  open, onClose, position = 'bottom', wide = false, title, pattern, stepKey,
  busy = false, initialFocus, restoreFocus, header, footer, guard, children,
}: Props) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [flow, setFlow] = useState(false);
  const backdropRef = useRef<HTMLDivElement>(null);
  const guardRef = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const active = useRef(false);
  const backdropPress = useRef(false);
  const phase = useRef({ stepKey, guarded: false });
  const shown = useContext(ScreenShown);
  const live = open && shown;
  const guarded = guard != null && guard !== false;
  const current = useRef({ onClose, busy, pattern, initialFocus, restoreFocus, stepKey, guarded, shown });
  current.current = { onClose, busy, pattern, initialFocus, restoreFocus, stepKey, guarded, shown };

  // Render precedes child autoFocus; a commit effect would capture the child instead.
  if (open && !wasOpen.current) {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  wasOpen.current = open;

  const enter = () => {
    const card = cardRef.current;
    if (!card || !isAvailable(card)) return;
    const options = current.current;
    const target = options.guarded
      ? guardRef.current?.querySelector<HTMLElement>('[data-sheet-focus]')
      : options.initialFocus?.();
    if (target && card.contains(target) && focus(target)) {
      target.scrollIntoView?.({ block: 'nearest' });
      return;
    }
    if (options.pattern || options.guarded) {
      const region = options.guarded ? guardRef.current : card;
      const heading = Array.from(region?.querySelectorAll<HTMLElement>('h2, h3') ?? []).find(isAvailable);
      if (heading) {
        if (!heading.hasAttribute('tabindex')) heading.tabIndex = -1;
        if (focus(heading)) {
          heading.scrollIntoView?.({ block: 'start' });
          return;
        }
      }
    }
    focus(card);
  };
  const enterRef = useRef(enter);
  enterRef.current = enter;

  useLayoutEffect(() => {
    if (!live) return;
    const card = cardRef.current;
    const backdrop = backdropRef.current;
    if (!card || !backdrop) return;
    const inert = new Map<HTMLElement, string | null>();
    let unlock: (() => void)[] = [];

    const restoreInert = (element: HTMLElement, value: string | null) => {
      if (value === null) element.removeAttribute('inert');
      else element.setAttribute('inert', value);
    };
    const syncInert = () => {
      const siblings = new Set<HTMLElement>();
      for (let branch: HTMLElement | null = backdrop; branch?.parentElement; branch = branch.parentElement) {
        for (const sibling of branch.parentElement.children) {
          if (sibling !== branch && sibling instanceof HTMLElement) siblings.add(sibling);
        }
      }
      for (const [element, value] of inert) {
        if (!siblings.has(element)) {
          restoreInert(element, value);
          inert.delete(element);
        }
      }
      for (const sibling of siblings) {
        if (!inert.has(sibling)) {
          inert.set(sibling, sibling.getAttribute('inert'));
          sibling.setAttribute('inert', '');
        }
      }
    };
    const recover = () => {
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && card.contains(focused) && isAvailable(focused)) return;
      focus(controlsIn(card)[0] ?? card);
    };
    const onFocus = () => {
      if (active.current && isAvailable(card)) recover();
    };
    const onKey = (event: KeyboardEvent) => {
      if (!active.current || !isAvailable(card) || event.defaultPrevented) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!current.current.busy) current.current.onClose();
      }
      if (event.key !== 'Tab') return;
      const controls = controlsIn(card);
      const first = controls[0];
      const last = controls[controls.length - 1];
      const focused = document.activeElement;
      const fromPanel = !controls.includes(focused as HTMLElement);
      if (!first) {
        event.preventDefault();
        focus(card);
      } else if (fromPanel || (event.shiftKey ? focused === first : focused === last)) {
        event.preventDefault();
        focus(event.shiftKey ? last : first);
      }
    };
    const suspend = () => {
      active.current = false;
      backdropPress.current = false;
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('focusin', onFocus);
      for (const [element, value] of inert) restoreInert(element, value);
      inert.clear();
      for (const release of unlock) release();
      unlock = [];
    };
    const reconcile = () => {
      if (!isAvailable(card)) {
        if (active.current) suspend();
        return;
      }
      if (!active.current) {
        active.current = true;
        const scrollAreas = new Set<HTMLElement>([document.body]);
        for (let node = backdrop.parentElement; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (node.matches('.screen') || /auto|scroll/.test(`${style.overflow} ${style.overflowY}`)) {
            scrollAreas.add(node);
          }
        }
        unlock = Array.from(scrollAreas, lockScroll);
        syncInert();
        document.addEventListener('keydown', onKey);
        document.addEventListener('focusin', onFocus);
        phase.current = { stepKey: current.current.stepKey, guarded: current.current.guarded };
        enterRef.current();
      } else {
        syncInert();
        recover();
      }
    };
    reconcile();
    const observer = new MutationObserver(reconcile);
    observer.observe(card, {
      subtree: true, childList: true, attributes: true,
      attributeFilter: ['hidden', 'inert', 'style', 'class', 'disabled', 'open', 'tabindex'],
    });
    for (let node = backdrop.parentElement; node; node = node.parentElement) {
      observer.observe(node, {
        childList: true, attributes: true, attributeFilter: ['hidden', 'inert', 'style', 'class'],
      });
    }
    return () => {
      observer.disconnect();
      suspend();
    };
  }, [live]);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!live || !card || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      if (!isAvailable(card)) return;
      const body = card.querySelector<HTMLElement>('.sheet-body');
      if (!body) return;
      const style = getComputedStyle(card);
      const gap = Number.parseFloat(style.rowGap) || 0;
      const regions = Array.from(card.children).filter((element): element is HTMLElement =>
        element instanceof HTMLElement && !element.hidden && getComputedStyle(element).display !== 'none');
      const framing = regions.filter((element) => element !== body)
        .reduce((height, element) => height + element.getBoundingClientRect().height, 0);
      const available = card.clientHeight - framing - gap * (regions.length - 1) -
        (Number.parseFloat(style.paddingTop) || 0) - (Number.parseFloat(style.paddingBottom) || 0);
      const controls = Array.from(body.querySelectorAll<HTMLElement>('input:not([type="hidden"]), select, textarea, button'))
        .filter((element) => isAvailable(element) || (element.matches(':disabled') &&
          element.parentElement !== null && isAvailable(element.parentElement)));
      const heights = controls.map((control) => {
        const nodes = new Set<HTMLElement>([control]);
        for (let field = control.parentElement; field && field !== body; field = field.parentElement) {
          if (field.matches('.native-field, .field, .wiz-field, .goal-cost-row, label, fieldset, [role="group"]') && isAvailable(field)) {
            nodes.add(field);
          }
        }
        if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement ||
          control instanceof HTMLTextAreaElement || control instanceof HTMLButtonElement) {
          for (const label of control.labels ?? []) if (isAvailable(label)) nodes.add(label);
        }
        const boxes = Array.from(nodes, (element) => element.getBoundingClientRect()).filter((box) => box.height > 0);
        return boxes.length ? Math.max(...boxes.map((box) => box.bottom)) - Math.min(...boxes.map((box) => box.top)) : 0;
      });
      const bodyStyle = getComputedStyle(body);
      const content = body.querySelector<HTMLElement>(guarded ? '.sheet-guard' : '.sheet-content');
      const required = Math.max(0, ...heights, controls.length ? 0 : content?.getBoundingClientRect().height ?? 0) +
        (Number.parseFloat(bodyStyle.paddingTop) || 0) + (Number.parseFloat(bodyStyle.paddingBottom) || 0);
      setFlow((current) => available < required + (current ? gap : 0));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(card);
    for (const region of card.querySelectorAll<HTMLElement>('.sheet-header, .sheet-footer, .sheet-content, .sheet-guard, .sheet-status')) {
      observer.observe(region);
    }
    return () => observer.disconnect();
  }, [live, header, footer, busy, guarded]);

  useLayoutEffect(() => {
    const target = document.activeElement;
    if (live && target instanceof HTMLElement && cardRef.current?.contains(target)) {
      target.scrollIntoView?.({ block: 'nearest' });
    }
  }, [flow, live]);

  useLayoutEffect(() => {
    if (!open) return;
    return () => {
      if (!current.current.shown) return;
      const target = opener.current;
      if (target && target !== document.body && focus(target)) return;
      const fallback = current.current.restoreFocus?.();
      if (fallback && isAvailable(fallback)) {
        if (fallback.tabIndex < 0 && !fallback.hasAttribute('tabindex')) fallback.tabIndex = -1;
        focus(fallback);
      }
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!active.current) return;
    if (phase.current.stepKey !== stepKey || (guarded && !phase.current.guarded)) enterRef.current();
    phase.current = { stepKey, guarded };
  });

  if (!open) return null;

  return (
    <div
      ref={backdropRef}
      className={`backdrop backdrop-${position}`}
      role="presentation"
      onPointerDown={(event) => {
        backdropPress.current = active.current && event.target === event.currentTarget;
      }}
      onPointerCancel={() => { backdropPress.current = false; }}
      onClick={(event) => {
        const dismiss = backdropPress.current && event.target === event.currentTarget;
        backdropPress.current = false;
        if (dismiss && active.current && !busy && pattern !== 'long-editor' && pattern !== 'builder') onClose();
      }}
    >
      <div
        ref={cardRef}
        className={['sheet', wide && 'sheet-wide', flow && 'sheet-flow'].filter(Boolean).join(' ')}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-busy={busy || undefined}
        tabIndex={-1}
      >
        <div className="sheet-header">
          {header != null && <div className="sheet-heading">{header}</div>}
          <Button
            type="button" variant="tertiary" size="touch" iconOnly aria-label="Close dialog"
            aria-disabled={busy} className="sheet-close" onClick={onClose}
          >
            <CloseIcon />
          </Button>
        </div>
        <div className="sheet-body">
          <div className="sheet-content" hidden={guarded}>
            {live && <NavigationNotice />}
            {children}
          </div>
          {guarded && <div ref={guardRef} className="sheet-guard">{guard}</div>}
        </div>
        {busy && <p className="sheet-status">Working. Please wait before closing.</p>}
        {footer != null && <div className="sheet-footer" hidden={guarded}>{footer}</div>}
      </div>
    </div>
  );
}
