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
  onBad: string;
  backdrop: string;

  brand: string;
  onBrand: string;
  panel: string;
  net: string;
  raised: string;
  lavender: string;
  sand: string;
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
  brand: '#365323',
  onBrand: '#ffffff',
  panel: '#ffffff',
  net: '#936921',
  raised: '#e8eee2',
  lavender: '#7955ab',
  sand: '#936921',
};

export const darkInk: Ink = {
  primary: '#f1f3ed',
  secondary: '#a6ada4',
  muted: '#969f93',
  grid: '#30362f',
  border: '#30362f',
  surface: '#191c19',
  page: '#101211',
  accent: '#c7e89a',
  good: '#c7e89a',
  bad: '#eea49b',
  onAccent: '#182111',
  onBad: '#101211',
  backdrop: 'rgba(0,0,0,0.65)',
  brand: '#c7e89a',
  onBrand: '#182111',
  panel: '#191c19',
  net: '#d9c6a0',
  raised: '#20251f',
  lavender: '#b69ae3',
  sand: '#d9c6a0',
};

// keyed by the backend's slugs; the dark palette is the same hue per category, lightened
// so its contrast against the dark ground survives
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
  support: '#9b5b89',
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
  support: '#d39cc5',
  cashback: '#c3a0ff',
  other: '#9a9891',
};

export type Scheme = 'light' | 'dark';
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
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'dark';
}

function applyCssVariables(ink: Ink, scheme: Scheme) {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(ink)) {
    root.style.setProperty(`--ink-${key}`, value);
  }
  // Lets the browser theme form controls, scrollbars and the caret to match.
  root.style.colorScheme = scheme;
  root.dataset.theme = scheme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', ink.page);
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
