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
}

export const lightInk: Ink = {
  primary: '#0b0b0b',
  secondary: '#52514e',
  muted: '#898781',
  grid: '#e1e0d9',
  border: 'rgba(11,11,11,0.10)',
  surface: '#fcfcfb',
  page: '#f9f9f7',
  accent: '#2a78d6',
  good: '#006300',
  bad: '#d03b3b',
  onAccent: '#ffffff',
  backdrop: 'rgba(11,11,11,0.35)',
};

export const darkInk: Ink = {
  primary: '#f2f1ec',
  secondary: '#b6b4ad',
  muted: '#84827b',
  grid: '#2e2e2b',
  border: 'rgba(242,241,236,0.12)',
  surface: '#1a1a19',
  page: '#111110',
  accent: '#6aa6ef',
  good: '#4cc38a',
  bad: '#f2726f',
  onAccent: '#0b0b0b',
  backdrop: 'rgba(0,0,0,0.6)',
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
