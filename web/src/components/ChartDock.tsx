/**
 * Why a chart's actions live here and not on its card is in `web/src/SPEC.md`, under
 * *What a chart is, and where its numbers come from*.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDismiss } from '../dismiss';
import { ChartGlyph, GlyphName } from './ChartGlyphs';

export interface DockTab {
  id: string;
  label: string;
  glyph: GlyphName;
}

interface Popover {
  id: string;
  /** Distances from the viewport's edges, so the menu's corner meets the button's. */
  right: number;
  bottom: number;
  confirming: boolean;
}

interface Props {
  tabs: DockTab[];
  /** null — nothing is showing. */
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onEdit: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  /** The chart list has not arrived or could not be read, so no mutation may start. */
  actionsDisabled?: boolean;
}

const ANCHOR_GAP = 6;

const EDGE_GAP = 8;

/**
 * `.dock-menu`'s `min-width`. Here because the menu is placed before it has been
 * rendered — `right` is measured off the button in the click handler — so there is no
 * box to ask. A number that has to agree with a stylesheet is a number that can drift;
 * it is the narrowest the menu ever gets, so a clamp built on it errs towards keeping
 * too much on screen rather than too little.
 */
const MENU_WIDTH = 176;

/**
 * How much of the visible row an arrow moves: it scrolls rather than pages, because a
 * tab is as wide as the name on it, so a page of tabs has no width to be true at —
 * pages would break mid-tab at one set of names and leave a gap at another.
 *
 * Not all of it: a whole screenful leaves nothing on either side of the jump for the
 * reader to recognise, and a strip of names has no other landmark. The floor is for a
 * narrow window, where a fraction of a small row is a step too small to be worth a
 * click.
 */
const NUDGE_FRACTION = 0.8;
const NUDGE_MIN = 120;

/**
 * Slack, in pixels, on both ends of the scroll.
 *
 * `scrollLeft` is fractional and `scrollWidth - clientWidth` is rounded, so at the far
 * end the two are a fraction of a pixel apart rather than equal — and an arrow that
 * compares them exactly never disables, which is a control that looks live and does
 * nothing.
 */
const SCROLL_SLACK = 1;

interface Reach {
  /** There is anything at all off the end: both arrows appear or neither does. */
  overflows: boolean;
  before: boolean;
  after: boolean;
}

const NO_REACH: Reach = { overflows: false, before: false, after: false };

export function ChartDock({
  tabs,
  activeId,
  onSelect,
  onNew,
  onEdit,
  onDuplicate,
  onDelete,
  actionsDisabled = false,
}: Props) {
  const [popover, setPopover] = useState<Popover | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const currentRef = useRef<HTMLDivElement>(null);
  const newRef = useRef<HTMLButtonElement>(null);
  const [reach, setReach] = useState<Reach>(NO_REACH);

  const close = (returnFocus = true) => {
    setPopover(null);
    if (returnFocus) anchorRef.current?.focus();
    anchorRef.current = null;
  };

  const toggle = (id: string, button: HTMLButtonElement) => {
    if (popover?.id === id) {
      close();
      return;
    }
    const box = button.getBoundingClientRect();
    anchorRef.current = button;
    /*
     * The menu is `position: fixed`, measured off the ⋮: the names scroll sideways inside
     * `overflow-x: auto`, which clips an absolutely positioned child, and `fixed` escapes
     * that without giving up the scroll.
     *
     * It hangs from its RIGHT edge, above the ⋮ it came from, clamped at both ends of the
     * window: the floor keeps it off the right edge, and the ceiling keeps a ⋮ near the
     * left edge of a narrow window from putting the menu's own left edge off the screen.
     * Below `MENU_WIDTH + 2 * EDGE_GAP` of window there is no placement that leaves both
     * gaps, and the floor wins: the menu sits against the right edge, which on a window
     * that narrow is where the ⋮ it belongs to is anyway.
     */
    const flush = Math.max(EDGE_GAP, window.innerWidth - MENU_WIDTH - EDGE_GAP);
    setPopover({
      id,
      right: Math.min(Math.max(EDGE_GAP, window.innerWidth - box.right), flush),
      bottom: window.innerHeight - box.top + ANCHOR_GAP,
      confirming: false,
    });
  };

  useDismiss(
    popover,
    (target) => !!target.closest('.dock-menu, .dock-more'),
    () => close(),
    () => close(false),
  );

  useEffect(() => {
    if (!popover) return;
    // a menu measured off a button that has since moved is a menu pointing at nothing
    const onMoved = () => close(false);
    window.addEventListener('resize', onMoved);
    // capture, because the strip scrolls sideways and the screen scrolls under it, and
    // neither of those scrolls bubbles to the window
    document.addEventListener('scroll', onMoved, true);
    return () => {
      window.removeEventListener('resize', onMoved);
      document.removeEventListener('scroll', onMoved, true);
    };
  }, [popover]);

  /*
   * Opened by a click or by Enter on the ⋮ either way, so the keyboard has to be moved
   * into it — otherwise Tab from the ⋮ walks into the rest of the strip and past the
   * controls that just appeared.
   *
   * Keyed on `confirming` too, and not as an exception: the Delete that holds focus is
   * unmounted by the very state change that asks the question, and focus left on nothing
   * goes to `<body>`. The first button either way: Edit when the menu is the actions,
   * Keep when it is the question, which is the safe half of the answer.
   */
  useEffect(() => {
    if (popover) menuRef.current?.querySelector('button')?.focus();
  }, [popover?.id, popover?.confirming]);

  /*
   * The ids and the names of what is on the strip, as one string for the effects below
   * to key on: the array itself is rebuilt by the screen on every render, so anything
   * keyed on its identity re-runs whenever the parent does. The names are in it because
   * a rename changes the width of the row.
   */
  const shape = tabs.map((t) => `${t.id}:${t.label}`).join('|');

  /* A tab deleted elsewhere, or a chart list that changed under the popover, leaves it
     pointing at something that is no longer on the strip. */
  useEffect(() => {
    if (popover && !tabs.some((t) => t.id === popover.id)) setPopover(null);
    // `shape` and not `tabs`, for `shape`'s reason; the effect reads the current array either way
  }, [shape, popover]);

  const measure = useCallback(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const furthest = strip.scrollWidth - strip.clientWidth;
    setReach({
      overflows: furthest > SCROLL_SLACK,
      before: strip.scrollLeft > SCROLL_SLACK,
      after: strip.scrollLeft < furthest - SCROLL_SLACK,
    });
  }, []);

  /*
   * Two effects and not one. The listeners are attached once, and the re-measure is
   * keyed on the row's own contents, because that is the half a ResizeObserver cannot
   * see: `.dock-tabs` is `flex: 1` and keeps its box exactly while a new name grows the
   * scroll width underneath it.
   */
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    strip.addEventListener('scroll', measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    return () => {
      strip.removeEventListener('scroll', measure);
      observer.disconnect();
    };
  }, [measure]);

  useEffect(measure, [measure, shape]);

  /*
   * The tab that is showing is brought into view when it changes — which is what makes a
   * new chart visible the moment it is created, and what puts the strip back on the
   * right tab after Back. `block: 'nearest'` so the page behind the dock is not dragged
   * about, and optional-called, like `scrollBy` below, because jsdom implements neither.
   */
  useEffect(() => {
    currentRef.current?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
  }, [activeId]);

  const nudge = (direction: -1 | 1) => {
    const strip = stripRef.current;
    if (!strip) return;
    const step = Math.max(NUDGE_MIN, strip.clientWidth * NUDGE_FRACTION);
    // no `behavior` here: `.dock-tabs` sets `scroll-behavior` in CSS, which is where
    // the reduced-motion rule that turns it off again already lives
    strip.scrollBy?.({ left: direction * step });
  };

  const open = tabs.find((t) => t.id === popover?.id) ?? null;

  /**
   * Runs the action and leaves the keyboard somewhere real. Edit and Duplicate both
   * leave the ⋮ they came from on the strip, so that is where focus belongs; the wizard
   * Edit opens moves it in from there by itself.
   *
   * A delete takes the anchor away with it, and focusing something about to unmount is
   * the same as focusing nothing. "New chart" is always rendered, it is a step from the
   * strip, and it is the likely next thing to press once a chart has gone.
   */
  const act = (fn: (id: string) => void, id: string, keepsAnchor = true) => {
    close(keepsAnchor);
    if (!keepsAnchor) newRef.current?.focus();
    fn(id);
  };

  return (
    <div className="chart-dock">
      {/* the strip hides its scrollbar, so without these a pointer has no bar to drag and a
          plain wheel does not move the row. They are for the pointer, which is why they
          carry no `aria-live`: every tab stays in the tab order wherever the strip is
          scrolled, the browser brings a focused one into view by itself, and nothing about
          what is reachable changes when they are pressed */}
      {reach.overflows && (
        <button
          className="dock-arrow"
          onClick={() => nudge(-1)}
          disabled={!reach.before}
          aria-label="Previous charts"
        >
          ‹
        </button>
      )}

      {/* a group and not a `role="tablist"`: `aria-current` on a plain button is the app's
          idiom for the current one, and a tablist would make the strip a composite widget
          with a roving tabindex */}
      <div className="dock-tabs" ref={stripRef} role="group" aria-label="Charts">
        {tabs.map((t) => {
          const current = t.id === activeId;
          return (
            <div
              key={t.id}
              ref={current ? currentRef : undefined}
              className={`dock-tab${current ? ' is-current' : ''}`}
            >
              <button
                className="dock-open"
                aria-current={current ? 'true' : undefined}
                onClick={() => onSelect(t.id)}
                // the label is cut by CSS when the strip is tight; the whole of it stays
                // reachable as the tooltip and as the accessible name
                title={t.label}
              >
                <span className="dock-glyph">
                  <ChartGlyph kind={t.glyph} />
                </span>
                <span className="dock-name">{t.label}</span>
              </button>

              {!actionsDisabled && (
                <button
                  className="dock-more"
                  aria-expanded={popover?.id === t.id}
                  aria-label={`Actions for ${t.label}`}
                  onClick={(e) => toggle(t.id, e.currentTarget)}
                >
                  <span aria-hidden="true">⋮</span>
                </button>
              )}
            </div>
          );
        })}
      </div>

      {reach.overflows && (
        <button
          className="dock-arrow"
          onClick={() => nudge(1)}
          disabled={!reach.after}
          aria-label="Next charts"
        >
          ›
        </button>
      )}

      {/* outside the scrolling names, like the arrows: it is not one of them, and a reader
          should not have to scroll to the end of their own list to add to it */}
      <button className="dock-new" ref={newRef} onClick={onNew} disabled={actionsDisabled}>
        <span aria-hidden="true">＋</span> New chart
      </button>

      {/* a popover above the ⋮ and not a `Sheet`: the actions are a word each, and a sheet
          would black out the chart the reader is acting on. A labelled group of buttons
          rather than a `role="menu"`, which would promise arrow keys it does not implement */}
      {popover && open && (
        <div
          ref={menuRef}
          className="dock-menu"
          style={{ right: popover.right, bottom: popover.bottom }}
          role="group"
          aria-label={`Actions for ${open.label}`}
        >
          {popover.confirming ? (
            <>
              <p className="dock-menu-ask">Delete “{open.label}”?</p>
              <div className="dock-menu-row">
                <button
                  className="btn-ghost btn-sm"
                  onClick={() => setPopover({ ...popover, confirming: false })}
                >
                  Keep
                </button>
                <button
                  className="btn btn-sm btn-destroy"
                  onClick={() => act(onDelete, open.id, false)}
                >
                  Delete
                </button>
              </div>
            </>
          ) : (
            <>
              <button className="dock-menu-item" onClick={() => act(onEdit, open.id)}>
                Edit
              </button>
              <button className="dock-menu-item" onClick={() => act(onDuplicate, open.id)}>
                Duplicate
              </button>
              {/* asks before it acts, in the popover rather than in a sheet over it: the
                  question and its answer both fit in the popover */}
              <button
                className="dock-menu-item is-danger"
                onClick={() => setPopover({ ...popover, confirming: true })}
              >
                Delete
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
