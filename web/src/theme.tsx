/**
 * App theme: light and dark.
 *
 * By default it follows the system (prefers-color-scheme), but the user can pin a
 * theme with the button in the navigation bar — where it is reachable from all five
 * screens rather than from the Overview alone; the choice is remembered in
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
  /** text on a `brand` fill */
  onBrand: string;
  /**
   * The Overview's one filled card — the ground the spending donut is drawn on. A
   * navy in both schemes the way `brand` is, and a different navy from it: the mock
   * draws this card a step darker than the band.
   *
   * It is a palette entry rather than a `styles.css` custom property because the
   * donut's sector separators have to be the card's own fill and Recharts is handed
   * that as a string. Published as `--ink-panel` like every other key here, so the
   * card's own `background` reads the same value rather than a second copy of it.
   */
  panel: string;
}

/**
 * Light mode is the Overview mock's own palette, which turned out to be the palette
 * `styles/tokens.css` already holds for the auth screens and the landing page.
 *
 * That was not the plan — `REDESIGN-BACK-DEBT.md` recorded the opposite, that the app
 * kept its own `--ink-*` scale and the auth screens kept theirs — and it stopped being
 * true the moment the frame could actually be read: every colour sampled off it is a
 * token that file already publishes. `#010710` is `--c-ground`, `#f4f4f4` is
 * `--c-paper`, `#009405` is `--c-good-paper`, `#a70000` is `--c-danger`, `#595959` is
 * `--c-ink-2`. They are written out as literals here rather than as `var()` because
 * this object is read by Recharts, which wants real colour strings — but they are the
 * same decisions, and a change to one belongs in both.
 *
 * Every ratio below is against BOTH backgrounds a light-mode text colour can land on —
 * `surface` (#ffffff) and `page` (#f4f4f4) — because the page is the darker of the two
 * and it is what a caption outside a card sits on. Measuring on white alone is how
 * `muted` came to be published as passing while every hint on `.screens` was at 4.11:1.
 */
export const lightInk: Ink = {
  /* the mock's near-black, which is --c-ground: 17.7:1 on the page */
  primary: '#010710',
  /* --c-ink-2, the mock's body grey: 7.0:1 on white, 6.2:1 on the page. Neutral, not
     the blue-grey this used to be — the mock's greys have no hue in them at all */
  secondary: '#595959',
  /* --c-line-strong: 5.3:1 on white, 4.7:1 on the page */
  muted: '#6b6b6b',
  grid: '#e0e0e0',
  border: 'rgba(1,7,16,0.10)',
  surface: '#ffffff',
  /* --c-paper */
  page: '#f4f4f4',
  accent: '#0a213f',
  /* The mock's green is --c-good-paper (#009405), which is 4.1:1 on the page — under
     the floor for the 12px it is set in there. This is the same hue two steps down:
     5.3:1 on white, 4.7:1 on the page. A pure green either way, where the #0f7a3d this
     replaces was visibly a sea-green beside it. */
  good: '#007e04',
  /* --c-danger, and it needs no adjustment: 8.0:1 on white, 7.1:1 on the page */
  bad: '#a70000',
  onAccent: '#ffffff',
  backdrop: 'rgba(1,7,16,0.40)',
  brand: '#0a213f',
  onBrand: '#ffffff',
  /* the mock's spending card, a step darker than the band it sits under */
  panel: '#030e20',
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
  onBrand: '#e8ebf0',
  /* the same fill as `brand` here, where in light mode it is a step darker: on this
     page the card has to clear the surface behind it, and #030e20 would be a hole */
  panel: '#25344c',
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
  /**
   * The same category, as it has to be ON `panel` — always the dark palette, in both
   * schemes, because `panel` is a dark navy either way and the light palette is picked
   * against a near-white page.
   *
   * Health is the one that decides it: light #4a3aa7 on light mode's #030e20 measures
   * 2.26:1, under the 3:1 a graphical object needs, where the dark #9d8df1 is 6.9:1
   * there and 4.5:1 on dark mode's #25344c. Most of the light palette clears 3:1 on
   * this ground — Housing is 3.3:1 — so it is the floor and not the average that this
   * exists for.
   */
  categoryColorOnPanel: (category: string) => string;
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
      categoryColorOnPanel: (category) =>
        DARK_CATEGORY_COLORS[category] || DARK_CATEGORY_COLORS['other'],
    };
  }, [scheme, mode, ink]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme used outside ThemeProvider');
  return value;
}
