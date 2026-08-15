/**
 * The strip of chart names along the bottom of the Analytics screen, and the ⋮ that
 * acts on each of them.
 *
 * The workspace shows one chart at a time and this is what chooses it — a row of
 * rectangles, one per chart, the way a spreadsheet names its sheets. At the bottom
 * because that is where a strip of things you switch BETWEEN belongs when the thing
 * above it is the subject: the screen reads top-down as "here is the chart", and the
 * dock is the index under it rather than a filter over it.
 *
 * ---------------------------------------------------------------------------
 * Why the actions are here and not on the card
 *
 * Edit, Duplicate and Delete were three pills across the top of the chart, which put
 * the loudest row on the screen above the quietest thing on it — a reader arrives at
 * Analytics to look at a plot, not to maintain a list. They belong on the tab, which is
 * the handle for the chart as an OBJECT, where the card is the chart as a PICTURE.
 *
 * A popover under the ⋮ and not a `Sheet`. `AccountDialog` gives the reason it chose
 * the other way and it is a reason about that menu: two of its steps are a paragraph
 * apiece and a four-line popover has nowhere to put a paragraph. These three are one
 * word each, and a sheet for them would black out the chart the reader is acting on.
 *
 * The popover is `position: fixed`, measured off the button. The names scroll sideways
 * inside `overflow-x: auto`, which clips an absolutely positioned child — and `fixed`
 * is what escapes that without giving up the scroll. It is closed by anything that
 * would move it out from under its own anchor: Escape, a pointer outside it, a scroll
 * anywhere, a resize.
 *
 * ---------------------------------------------------------------------------
 * The arrows
 *
 * The names scroll, and past four or five charts they scroll off the end of the row.
 * That was reachable by touch and by a trackpad and by nothing else: the strip hides
 * its scrollbar, and a mouse with one wheel has no way to move a horizontal one. So a
 * ‹ and a › appear once there is anything to move to, and disable at each end — the
 * same shape `AccountTabs` draws over the account rail.
 *
 * They scroll rather than page. A tab is as wide as the name on it, so "three per page"
 * is a rule that has no width to be true at: pages would break mid-tab at one set of
 * names and leave a gap at another. A nudge of most of the visible width keeps a
 * partly-seen tab on screen as the anchor for where the row just came from.
 *
 * A keyboard needs none of this — every tab stays in the tab order wherever the strip
 * is scrolled to, and the browser brings a focused one into view by itself. The arrows
 * are for the pointer, which is why they carry no `aria-live` announcement: nothing
 * about what is REACHABLE changes when they are pressed.
 *
 * ---------------------------------------------------------------------------
 * "New chart" is outside the scrolling names deliberately. It is not one of them, and a
 * reader with eight charts should not have to scroll to the end of their own list to
 * add a ninth. The arrows sit outside it for the same reason.
 *
 * Not a `role="tablist"`, for the reason `AccountTabs` gives: the app already has one
 * idiom for "which of these is the current one", and it is `aria-current` on a plain
 * button. A real tablist would also make the strip a composite widget with a roving
 * tabindex, which is a keyboard model nobody asked for on a row that is at most a
 * handful of names — and the same argument keeps the popover a labelled group of
 * buttons rather than a `role="menu"` promising arrow keys it does not implement.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChartGlyph, GlyphName } from './ChartGlyphs';

export interface DockTab {
  id: string;
  label: string;
  /** Its shape, drawn small — or absent for a tab that is not a chart. */
  glyph?: GlyphName;
  /**
   * A built-in view rather than one the reader made. It sits after the charts, is
   * marked, and carries no ⋮: there is nothing to edit, duplicate or delete about it.
   */
  pinned?: true;
}

/** Which tab's popover is up, and where the anchor put it. */
interface Popover {
  id: string;
  /** Distances from the viewport's edges, so the menu's corner meets the button's. */
  right: number;
  bottom: number;
  /** The delete has been asked for and is waiting to be confirmed. */
  confirming: boolean;
}

interface Props {
  tabs: DockTab[];
  /** null — nothing is showing, which is the empty workspace. */
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onEdit: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
}

/** The gap between the ⋮ and the popover above it. */
const ANCHOR_GAP = 6;

/** ...and the gap it keeps from either edge of the window. */
const EDGE_GAP = 8;

/**
 * `.dock-menu`'s `min-width`, which is what the popover is at the three one-word
 * actions it is usually showing.
 *
 * Here because the menu is placed before it has been rendered — `right` is measured off
 * the button in the click handler — so there is no box to ask. A number that has to
 * agree with a stylesheet is a number that can drift; it is the narrowest the menu ever
 * gets, so a clamp built on it errs towards keeping too much on screen rather than too
 * little.
 */
const MENU_WIDTH = 176;

/**
 * How much of the visible row an arrow moves.
 *
 * Not all of it: a whole screenful leaves nothing on either side of the jump for the
 * reader to recognise, and a strip of names has no other landmark. The floor is for a
 * narrow window, where 80% of a small row is a step too small to be worth a click.
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

/** How far the strip can be scrolled, and how much of that has been used. */
interface Reach {
  /** There is anything at all off the end: both arrows appear or neither does. */
  overflows: boolean;
  before: boolean;
  after: boolean;
}

const NO_REACH: Reach = { overflows: false, before: false, after: false };

export function ChartDock({ tabs, activeId, onSelect, onNew, onEdit, onDuplicate, onDelete }: Props) {
  const [popover, setPopover] = useState<Popover | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** The ⋮ the popover came from, so closing it puts the keyboard back where it was. */
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const currentRef = useRef<HTMLDivElement>(null);
  /** Where the keyboard goes when the ⋮ it was on is deleted out from under it. */
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
     * The menu hangs from its RIGHT edge, under the ⋮ it came from, clamped at both
     * ends of the window.
     *
     * The floor is the easy half and was the only half: it keeps the menu off the right
     * edge. The ceiling is the one the comment here used to claim and the arithmetic did
     * not do — a tab at the LEFT edge of a narrow window. The first ⋮ on a 360px phone
     * sits around x=130, which put the menu's left edge at −46 and Edit, Duplicate and
     * Delete off the side of the screen with no way to scroll to them.
     *
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

  /**
   * Everything that has to shut it. The pointer listener is in the CAPTURE phase and
   * lets a press on a ⋮ through, which is what makes the button a toggle: without the
   * exemption, the press closes the popover and the click that follows opens it again.
   */
  useEffect(() => {
    if (!popover) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    const onPointer = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('.dock-menu') || target?.closest('.dock-more')) return;
      close(false);
    };
    // a menu measured off a button that has since moved is a menu pointing at nothing
    const onMoved = () => close(false);

    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('resize', onMoved);
    // capture, because the strip scrolls sideways and the screen scrolls under it, and
    // neither of those scrolls bubbles to the window
    document.addEventListener('scroll', onMoved, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('resize', onMoved);
      document.removeEventListener('scroll', onMoved, true);
    };
  }, [popover]);

  /*
   * Opened by a click or by Enter on the ⋮ either way, so the keyboard has to be moved
   * into it — otherwise Tab from the ⋮ walks into the rest of the strip and past the
   * three controls that just appeared.
   *
   * The confirmation is the same move and not an exception to it. It used to be skipped,
   * on the reading that focus was already inside the menu — but the Delete that was
   * holding it is unmounted by the very state change that asks the question, so focus
   * went to `<body>` and the reader who pressed Delete was answered by silence and a Tab
   * from the top of the document. The first button either way: Edit when the menu is the
   * three actions, Keep when it is the question, which is the safe half of the answer.
   */
  useEffect(() => {
    if (popover) menuRef.current?.querySelector('button')?.focus();
  }, [popover?.id, popover?.confirming]);

  /*
   * The ids and the names of what is on the strip, as one string.
   *
   * The array itself is rebuilt by the screen on every render, so anything keyed on its
   * identity re-runs whenever the parent does — which was true of the popover check
   * below and of the re-measure further down, and is the reason this string exists at
   * all. The names are in it because a rename changes the width of the row.
   */
  const shape = tabs.map((t) => `${t.id}:${t.label}`).join('|');

  /* A tab deleted elsewhere, or a chart list that changed under the popover, leaves it
     pointing at something that is no longer on the strip. */
  useEffect(() => {
    if (popover && !tabs.some((t) => t.id === popover.id)) setPopover(null);
    // `shape` and not `tabs` — see above; the effect reads the current array either way
  }, [shape, popover]);

  /* ------------------------------------------------------------------ the arrows */

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
   * Two effects and not one. The listeners are attached once — rebuilding a
   * ResizeObserver whenever the chart list changes would be a new observer per keystroke
   * in the wizard's name box — and the re-measure is keyed on the row's own contents,
   * because that is the half a ResizeObserver cannot see: `.dock-tabs` is `flex: 1` and
   * keeps its box exactly while a tenth name grows the scroll width underneath it.
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
   * The tab that is showing is brought into view when it changes — which is what makes
   * the ninth chart visible the moment it is created, and what puts the strip back on
   * the right tab after Back. `scrollIntoView` is optional-called and `block: 'nearest'`
   * so the page behind the dock is not dragged about: jsdom implements neither this nor
   * `scrollBy` below, and neither is worth a shim in `setup.ts` for behaviour it has no
   * layout to have.
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
   * Runs the action and leaves the keyboard somewhere real.
   *
   * It used to close without returning focus at all, which put it on `<body>` — the top
   * of the document — after every Edit, Duplicate and Delete alike. Edit and Duplicate
   * both leave the ⋮ they came from on the strip, so that is where focus belongs; the
   * wizard Edit opens moves it in from there by itself.
   *
   * A delete takes the anchor away with it, and focusing something about to unmount is
   * the same as focusing nothing. "New chart" is the one control in the dock that is
   * always present, it is a step from the strip, and it is the likely next thing to
   * press on a workspace one chart lighter.
   */
  const act = (fn: (id: string) => void, id: string, keepsAnchor = true) => {
    close(keepsAnchor);
    if (!keepsAnchor) newRef.current?.focus();
    fn(id);
  };

  return (
    <div className="chart-dock">
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

      <div className="dock-tabs" ref={stripRef} role="group" aria-label="Charts">
        {tabs.map((t) => {
          const current = t.id === activeId;
          return (
            <div
              key={t.id}
              ref={current ? currentRef : undefined}
              className={`dock-tab${current ? ' is-current' : ''}${t.pinned ? ' is-pinned' : ''}`}
            >
              <button
                className="dock-open"
                aria-current={current ? 'true' : undefined}
                onClick={() => onSelect(t.id)}
                // the label is cut by CSS when the strip is tight; the whole of it stays
                // reachable as the tooltip and as the accessible name
                title={t.label}
              >
                {t.glyph && (
                  <span className="dock-glyph">
                    <ChartGlyph kind={t.glyph} />
                  </span>
                )}
                <span className="dock-name">{t.label}</span>
              </button>

              {!t.pinned && (
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

      <button className="dock-new" ref={newRef} onClick={onNew}>
        <span aria-hidden="true">＋</span> New chart
      </button>

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
              {/* asks before it acts, in the popover rather than in a sheet over it:
                  the question is four words and the answer is two buttons */}
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
