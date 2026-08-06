/**
 * App theme: light and dark.
 *
 * By default it follows the system (prefers-color-scheme), but the user can pin a
 * theme with a button on the Overview screen; the choice is remembered in
 * localStorage.
 *
 * The palette is published twice: as CSS custom properties on <html> (so plain CSS
 * can use var(--ink-primary)) and as the `ink` object (for the few places that need
 * a color in JS — chart series, inline fills). The CSS variables are the source of
 * truth for styling; `ink` exists because Recharts wants real color strings.
 *
 * Category colors — a validated categorical palette (CVD-safe, see the dataviz guide).
 * A category always gets the same color; in dark mode it's a lightened variant of
 * the same hue, to keep contrast against the dark background.
 * "Other" is a neutral gray.
 */
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

export interface Ink {
  primary: string;
  secondary: string;
  muted: string;
  /** divider lines and chart grid */
  grid: string;
  border: string;
  /** background of cards, header, tab bar */
  surface: string;
  /** page background */
  page: string;
  accent: string;
  /** income */
  good: string;
  /** errors */
  bad: string;
  /** text on an accent fill */
  onAccent: string;
  /** modal backdrop */
  backdrop: string;
  /**
   * The navy the design is built on: the sidebar, the balance card, the selected
   * tab, a filled button, the expense bars. It is a FILL and not a text colour —
   * `accent` is what interactive text uses, and the two are the same hue in light
   * mode and deliberately different in dark, where a navy link would be unreadable.
   */
  brand: string;
  /** The second bar in the chart, and any fill that has to sit beside `brand`. */
  brandSoft: string;
  /** text on a `brand` fill */
  onBrand: string;
  /**
   * `good` and `bad` as they have to be ON a `brand` fill. The pair above is chosen
   * against the surface, and the balance card is the one place they are asked to sit
   * on the navy instead — where light mode's #0f7a3d measured 2.89:1 and #c02626
   * 2.65:1, against a 4.5:1 floor for the 12px they are set in. Same value in both
   * schemes, because `brand` is a dark navy in both.
   */
  goodOnBrand: string;
  badOnBrand: string;
}

/**
 * Cool neutrals rather than the warm greys this app started with: the reference
 * design is navy on near-white, and a warm grey beside a navy card reads as a
 * mistake in one of the two.
 */
/**
 * Every ratio below is against BOTH backgrounds a light-mode text colour can land on —
 * `surface` (#ffffff) and `page` (#f1f2f4) — because the page is the darker of the two
 * and it is what a caption outside a card sits on. Measuring on white alone is how
 * `muted` came to be published as passing while every hint on `.screens` was at 4.11:1.
 */
export const lightInk: Ink = {
  primary: '#0b1220',
  /* 7.5:1 on white, 6.7:1 on the page */
  secondary: '#4a5568',
  /* 5.2:1 on white, 4.7:1 on the page — the warm #898781 this started as was 3.2:1 on
     the page, and #6b7686, which replaced it for that, was 4.1:1 and so still under
     the floor for text where most of the muted text on this app actually sits */
  muted: '#626d7d',
  grid: '#e3e6ea',
  border: 'rgba(11,18,32,0.10)',
  surface: '#ffffff',
  page: '#f1f2f4',
  accent: '#12233f',
  good: '#0f7a3d',
  bad: '#c02626',
  onAccent: '#ffffff',
  backdrop: 'rgba(11,18,32,0.40)',
  brand: '#12233f',
  brandSoft: '#5b7290',
  onBrand: '#ffffff',
  /* on #12233f: 7.5:1 and 7.1:1 */
  goodOnBrand: '#4ec98a',
  badOnBrand: '#ff8f8b',
};

/* Measured on `surface` (#161c25) and `page` (#0d1117); the page is the lighter-
   contrast of the two here, which is the reverse of light mode. */
export const darkInk: Ink = {
  primary: '#e8ebf0',
  secondary: '#a9b3c1',
  /* 5.0:1 on the surface, 5.5:1 on the page */
  muted: '#818b9b',
  grid: '#262f3c',
  border: 'rgba(232,235,240,0.12)',
  surface: '#161c25',
  page: '#0d1117',
  /* not `brand`: navy text on a navy page is not text */
  accent: '#7aa7ea',
  good: '#4ec98a',
  bad: '#f2726f',
  onAccent: '#0d1117',
  backdrop: 'rgba(0,0,0,0.6)',
  /* Lighter than the page here, where in light mode it is darker: a fill has to be
     distinguishable from the surface behind it, and which direction that is depends
     on the scheme. It has to clear `surface` (#161c25) and not just `page`, because
     the selected tab and the balance card both sit on a surface — at #1c2738 the
     selected tab was a rectangle you had to look for. */
  brand: '#25344c',
  brandSoft: '#5b7290',
  onBrand: '#e8ebf0',
  /* on #25344c: 6.0:1 and 5.7:1 */
  goodOnBrand: '#4ec98a',
  badOnBrand: '#ff8f8b',
};

// Category palettes — keyed by backend slugs (labels live in categories.ts)
const LIGHT_CATEGORY_COLORS: Record<string, string> = {
  housing: '#8c5a2b',
  food: '#2a78d6',
  transport: '#1baf7a',
  subscriptions: '#eda100',
  entertainment: '#008300',
  health: '#4a3aa7',
  shopping: '#e34948',
  cash: '#e87ba4',
  transfers: '#eb6834',
  // income-side categories
  salary: '#0f7d6b',
  cashback: '#9c6ade',
  other: '#898781',
};

const DARK_CATEGORY_COLORS: Record<string, string> = {
  housing: '#c99367',
  food: '#6aa6ef',
  transport: '#3ecf9a',
  subscriptions: '#f0b429',
  entertainment: '#57c85a',
  health: '#9d8df1',
  shopping: '#f2726f',
  cash: '#f39ac0',
  transfers: '#f5915f',
  salary: '#35b8a2',
  cashback: '#c3a0ff',
  other: '#9a9891',
};

export type Scheme = 'light' | 'dark';
/** 'system' — follow the OS theme. */
export type ThemeMode = 'system' | 'light' | 'dark';

interface ThemeValue {
  ink: Ink;
  scheme: Scheme;
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
  categoryColor: (category: string) => string;
}

const ThemeContext = createContext<ThemeValue | null>(null);

const STORAGE_KEY = 'finto.theme';

function readStoredMode(): ThemeMode {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system';
}

/** Publish the palette as CSS variables so stylesheets can use var(--ink-*). */
function applyCssVariables(ink: Ink, scheme: Scheme) {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(ink)) {
    root.style.setProperty(`--ink-${key}`, value);
  }
  // Lets the browser theme form controls, scrollbars and the caret to match.
  root.style.colorScheme = scheme;
  root.dataset.theme = scheme;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(readStoredMode);
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );

  // Follow the OS theme while mode === 'system'. The listener stays attached in
  // every mode — it costs nothing and keeps the value correct on switching back.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const scheme: Scheme = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;
  const ink = scheme === 'dark' ? darkInk : lightInk;

  useEffect(() => {
    applyCssVariables(ink, scheme);
  }, [ink, scheme]);

  const setMode = (m: ThemeMode) => {
    localStorage.setItem(STORAGE_KEY, m);
    setModeState(m);
  };

  const value = useMemo<ThemeValue>(() => {
    const palette = scheme === 'dark' ? DARK_CATEGORY_COLORS : LIGHT_CATEGORY_COLORS;
    return {
      scheme,
      mode,
      setMode,
      ink,
      categoryColor: (category) => palette[category] || palette['other'],
    };
  }, [scheme, mode, ink]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme used outside ThemeProvider');
  return value;
}
