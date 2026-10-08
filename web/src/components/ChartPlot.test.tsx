import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ChartData } from '../chartData';
import { METRICS } from '../analytics';
import { renderThemed } from '../test/harness';
import { darkInk, lightInk, ThemeProvider } from '../theme';
import type { Chart } from '../types';
import { ChartPlot } from './ChartPlot';

const spec: Chart = { id: 'c-color', title: 'Colors', kind: 'donut', accountId: null, range: '3m', metrics: ['income', 'expense'], breakdown: 'expense-categories' };
const data: ChartData = { shape: 'share', currency: 'EUR', period: { from: '2026-01-01', to: '2026-03-31' }, priorPeriod: null, compared: null,
  slices: [{ key: 'food', label: 'Food', value: 30 }, { key: 'future-category', label: 'Unknown category', value: 20 }, { key: 'other', label: 'Other', value: 10 }] };
const marker = (label: string) => screen.getByText(label).querySelector('.dot') as HTMLElement;

describe('chart legend encoding', () => {
  it.each(['light', 'dark'] as const)('keeps %s category identity independent of rank and unknown keys neutral', (scheme) => {
    localStorage.setItem('finto.theme', scheme);
    const view = renderThemed(<ChartPlot spec={spec} data={data} height={300} ground="surface" />);
    const food = marker('Food').style.background;
    const unknown = marker('Unknown category').style.background;
    expect(marker('Food')).toHaveStyle({ background: scheme === 'light' ? '#2a78d6' : '#6aa6ef' });
    expect(unknown).toBe(marker('Other').style.background);
    view.rerender(<ThemeProvider><ChartPlot spec={spec} data={{ ...data, slices: [...data.slices].reverse() }} height={300} ground="surface" /></ThemeProvider>);
    expect(marker('Food').style.background).toBe(food);
    expect(marker('Unknown category').style.background).toBe(unknown);
  });

  it.each(['light', 'dark'] as const)('uses a local source palette for colliding %s income-source ids', (scheme) => {
    localStorage.setItem('finto.theme', scheme);
    const ink = scheme === 'light' ? lightInk : darkInk;
    renderThemed(<ChartPlot spec={{ ...spec, breakdown: 'income-sources' }} data={data} height={300} ground="surface" />);
    expect(marker('Food')).toHaveStyle({ background: ink.income });
    expect(marker('Unknown category')).toHaveStyle({ background: ink.lavender });
    expect(marker('Other')).toHaveStyle({ background: ink.net });
  });

  it('keeps income independent and expense series neutral without judging Net as favorable', () => {
    expect(METRICS.map(({ key, ink }) => [key, ink])).toEqual([['income', 'income'], ['expense', 'secondary'], ['net', 'net']]);
  });
});
