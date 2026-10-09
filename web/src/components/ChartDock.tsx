import { useCallback, useEffect, useRef, useState } from 'react';
import { ChartGlyph, GlyphName } from './ChartGlyphs';
import { ChartControls } from './ChartControls';

export interface DockTab {
  id: string;
  label: string;
  glyph: GlyphName;
}

interface Props {
  tabs: DockTab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onEdit: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  actionsDisabled?: boolean;
}

const NUDGE_FRACTION = 0.8;
const NUDGE_MIN = 120;
// Fractional scroll positions need slack at the rounded scroll-width boundary.
const SCROLL_SLACK = 1;
interface Reach { overflows: boolean; before: boolean; after: boolean }
const NO_REACH: Reach = { overflows: false, before: false, after: false };

export function ChartDock({ tabs, activeId, onSelect, onEdit, onDuplicate, onDelete, actionsDisabled = false }: Props) {
  const stripRef = useRef<HTMLDivElement>(null);
  const currentRef = useRef<HTMLDivElement>(null);
  const [reach, setReach] = useState<Reach>(NO_REACH);
  const shape = tabs.map((t) => `${t.id}:${t.label}`).join('|');

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

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    strip.addEventListener('scroll', measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    return () => { strip.removeEventListener('scroll', measure); observer.disconnect(); };
  }, [measure]);
  useEffect(measure, [measure, shape]);
  useEffect(() => {
    currentRef.current?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
  }, [activeId]);

  const nudge = (direction: -1 | 1) => {
    const strip = stripRef.current;
    if (strip) strip.scrollBy?.({ left: direction * Math.max(NUDGE_MIN, strip.clientWidth * NUDGE_FRACTION) });
  };

  return (
    <div className="chart-dock">
      {reach.overflows && <button type="button" className="dock-arrow" onClick={() => nudge(-1)} disabled={!reach.before} aria-label="Previous charts">‹</button>}
      <div className="dock-tabs" ref={stripRef} role="group" aria-label="Charts">
        {tabs.map((t) => {
          const current = t.id === activeId;
          return (
            <div key={t.id} ref={current ? currentRef : undefined} className={`dock-tab${current ? ' is-current' : ''}`}>
              <button type="button" className="dock-open" aria-current={current ? 'true' : undefined} onClick={() => onSelect(t.id)} title={t.label}>
                <span className="dock-glyph"><ChartGlyph kind={t.glyph} /></span>
                <span className="dock-name">{t.label}</span>
              </button>
              {!actionsDisabled && <ChartControls id={t.id} label={t.label} onEdit={onEdit} onDuplicate={onDuplicate} onDelete={onDelete} fallbackFocus={() => document.querySelector<HTMLElement>('.analytics-new')} />}
            </div>
          );
        })}
      </div>
      {reach.overflows && <button type="button" className="dock-arrow" onClick={() => nudge(1)} disabled={!reach.after} aria-label="Next charts">›</button>}
    </div>
  );
}
