/**
 * App theme: light and dark. By default it follows the system
 * (prefers-color-scheme); the user can pin one, and the choice is remembered in
 * localStorage.
 *
 * The palette is published twice: as CSS custom properties on <html>, and as the `ink`
 * object for the few places that need a colour in JS. The CSS variables are the source
 * of truth for styling; `ink` exists because Recharts wants real colour strings.
 *
 * A category always gets the same colour; in dark mode it is a lightened variant of
 * the same hue, so the contrast against the dark background survives.
 */
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

export interface Ink {
  primary: string;
  secondary: string;
  muted: string;
  grid: string;
  border: string;
  surface: string;
  page: string;
  accent: string;
  good: string;
  bad: string;
  onAccent: string;
  /**
   * Text on a `bad` fill - the destructive button, which is the only one. White clears
   * light mode's red and does not clear dark mode's, so the two schemes need different
   * foregrounds and a borrowed `onAccent` would be right only by the coincidence that
   * both palettes put their saturated colours on the same side of the surface.
   */
  onBad: string;
  backdrop: string;
  /**
   * The navy the design is built on: the sidebar, the balance card, the selected tab, a
   * filled button, the expense bars. It is a FILL and not a text colour - `accent` is
   * what interactive text uses, and the two are the same hue in light mode and
   * deliberately different in dark, where a navy link would be unreadable.
   */
  brand: string;
  onBrand: string;
  /**
   * The Overview's one filled card - the ground the spending donut is drawn on. A navy
   * in both schemes the way `brand` is, and a different navy from it.
   *
   * It is a palette entry rather than a `styles.css` custom property because the donut's
   * sector separators have to be the card's own fill and Recharts is handed that as a
   * string. Published as `--ink-panel` like every other key here, so the card's own
   * `background` reads the same value rather than a second copy of it.
   */
  panel: string;
  /**
   * The third chart series.
   *
   * Income is `good` and expenses are `accent` on every screen in this app, and the
   * Analytics workspace draws a third measure beside them — Net, which is one minus
   * the other and therefore neither of those two colours. It cannot borrow one of
   * the pair without saying something false, it cannot be `brand` (in light mode
   * that is the same navy as `accent`, and two series would be one line), and it
   * cannot be `primary` for the same reason one step further: #010710 beside
   * #0a213f is a difference nobody reads off a 2px stroke.
   *
   * So: a hue neither of the other two uses, measured against both grounds a series
   * can be drawn on. Light is 6.5:1 on `surface` and 5.9:1 on `page`; dark is 7.4:1
   * and 8.1:1 — well past the 3:1 a graphical object needs, because the same value
   * also draws this series' name in the legend beside it.
   *
   * It overlaps the Health category's violet, and that is not a collision: a series
   * chart plots measures over time and a share chart plots categories, and no canvas
   * in the app draws both.
   */
  net: string;
}

export const lightInk: Ink = {
  primary: '#010710',
  secondary: '#595959',
  muted: '#6b6b6b',
  grid: '#e0e0e0',
  border: 'rgba(1,7,16,0.10)',
  surface: '#ffffff',
  page: '#f4f4f4',
  accent: '#0a213f',
  good: '#007e04',
  bad: '#a70000',
  onAccent: '#ffffff',
  onBad: '#ffffff',
  backdrop: 'rgba(1,7,16,0.40)',
  brand: '#0a213f',
  onBrand: '#ffffff',
  panel: '#030e20',
  net: '#6d4aad',
};

export const darkInk: Ink = {
  primary: '#e8ebf0',
  secondary: '#a9b3c1',
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
  onBad: '#0d1117',
  backdrop: 'rgba(0,0,0,0.6)',
  /* Lighter than the page here, where in light mode it is darker: a fill has to be
     distinguishable from the surface behind it, and which direction that is depends on
     the scheme. It has to clear `surface` and not just `page`, because the selected tab
     and the balance card both sit on a surface. */
  brand: '#25344c',
  onBrand: '#e8ebf0',
  /* the same fill as `brand` here, where in light mode it is a step darker: on this
     page the card has to clear the surface behind it rather than sink into it */
  panel: '#25344c',
  net: '#b59cf0',
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
   * The same category, as it has to be ON `panel` - always the dark palette, in both
   * schemes, because `panel` is a dark navy either way and the light palette is picked
   * against a near-white page.
   *
   * It is the FLOOR that this exists for and not the average: most of the light palette
   * clears the contrast a graphical object needs on this ground, and the one that does
   * not is enough to require the swap.
   */
  categoryColorOnPanel: (category: string) => string;
}

const ThemeContext = createContext<ThemeValue | null>(null);

const STORAGE_KEY = 'finto.theme';

function readStoredMode(): ThemeMode {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system';
}

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
