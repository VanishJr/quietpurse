import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { darkInk, lightInk, type Ink } from './theme';
import { METRIC_DEFS } from './analytics';

const palettes = [['light', lightInk], ['dark', darkInk]] as const;

function luminance(hex: string): number {
  if (!/^#[\da-f]{6}$/i.test(hex)) throw new Error(`Expected an opaque hex color: ${hex}`);
  const [r, g, b] = [1, 3, 5].map((offset) => {
    const channel = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

const textPairs: [keyof Ink, keyof Ink][] = [
  ['onAction', 'action'], ['onAction', 'actionHover'], ['onAction', 'actionPressed'],
  ['onDanger', 'danger'], ['onDanger', 'dangerHover'], ['onDanger', 'dangerPressed'],
  ['onSelected', 'selected'], ['onBrand', 'brand'], ['onAccent', 'accent'], ['onBad', 'bad'],
];
const texts: (keyof Ink)[] = [
  'primary', 'secondary', 'muted', 'success', 'error', 'warning', 'income', 'favorable', 'unfavorable',
];
const grounds = ['page', 'surface', 'raised'] as const;
const source = (file: string) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), file), 'utf8');

it('uses the reference contrast calculation', () => {
  expect(contrast('#000000', '#ffffff')).toBe(21);
  expect(contrast('#ffffff', '#ffffff')).toBe(1);
});

describe.each(palettes)('%s semantic foundations', (_scheme, ink) => {
  it.each(textPairs)('%s is readable on %s', (foreground, background) => {
    expect(contrast(ink[foreground], ink[background])).toBeGreaterThanOrEqual(4.5);
  });

  it.each(grounds)('keeps body, status and financial text readable on %s', (ground) => {
    for (const text of texts) {
      expect(contrast(ink[text], ink[ground]), `${text} on ${ground}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(grounds)('identifies controls and focus against %s', (ground) => {
    for (const role of ['controlBorder', 'focus', 'categoryRemainder'] as const) {
      expect(contrast(ink[role], ink[ground]), `${role} on ${ground}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps action, success, income and favorable outcomes independent', () => {
    expect(new Set([ink.action, ink.success, ink.income, ink.favorable]).size).toBe(4);
  });
});

it('uses income for income plots without repurposing legacy financial ink', () => {
  expect(METRIC_DEFS.income.ink).toBe('income');
  const flows = source('components/AccountFlows.tsx');
  expect(flows).toContain('stroke={ink.income}');
  expect(flows).toContain('fill: ink.income');
  expect(flows).not.toContain('ink.good');
  expect(lightInk.good).toBe('#007e04');
  expect(darkInk.good).toBe('#c7e89a');
});

it('gives native and focus-retaining disabled actions a readable neutral pair and visible boundary', () => {
  const css = source('styles.css');
  const disabled = css.match(/\.action-button\.action-button:disabled,\s*\.action-button\.action-button\[aria-disabled='true'\]\s*\{([^}]*)\}/)?.[1];
  expect(disabled).toBeDefined();
  expect(disabled).toContain('background: var(--ink-page)');
  expect(disabled).toContain('color: var(--ink-secondary)');
  expect(disabled).toContain('border-color: var(--ink-controlBorder)');
  expect(disabled).toContain('border-style: dashed');
  expect(disabled).toContain('opacity: 1');
  for (const [, ink] of palettes) {
    expect(contrast(ink.secondary, ink.page)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(ink.controlBorder, ink.page)).toBeGreaterThanOrEqual(3);
  }
});

it('gives each added palette role a live stylesheet reader', () => {
  const css = source('styles.css');
  const roles = [
    'action', 'actionHover', 'actionPressed', 'onAction', 'selected', 'onSelected',
    'danger', 'dangerHover', 'dangerPressed', 'onDanger', 'controlBorder', 'focus',
    'success', 'error', 'warning', 'income', 'favorable', 'unfavorable', 'categoryRemainder',
  ] as const satisfies readonly (keyof Ink)[];
  for (const role of roles) expect(css, role).toContain(`var(--ink-${role})`);
});
