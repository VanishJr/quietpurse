import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChartData } from '../chartData';
import { METRICS } from '../analytics';
import { renderThemed } from '../test/harness';
import { darkInk, lightInk, ThemeProvider } from '../theme';
import type { Chart } from '../types';
import { ChartPlot } from './ChartPlot';
import { AccountFlows } from './AccountFlows';
import { SpendingByCategory } from './SpendingByCategory';
import { ACCOUNTS } from '../test/fixtures';

const spec: Chart = { id: 'c-color', title: 'Colors', kind: 'donut', accountId: null, range: '3m', metrics: ['income', 'expense'], breakdown: 'expense-categories' };
const data: ChartData = { shape: 'share', currency: 'EUR', period: { from: '2026-01-01', to: '2026-03-31' }, priorPeriod: null, compared: null,
  slices: [{ key: 'food', label: 'Food', value: 30 }, { key: 'future-category', label: 'Unknown category', value: 20 }, { key: 'other', label: 'Other', value: 10 }] };
const marker = (label: string) => screen.getByText(label).querySelector('.dot') as HTMLElement;

const series: ChartData = { shape: 'series', currency: 'EUR', period: data.period, priorPeriod: null,
  points: [{ tick: '2026-01', label: 'Jan 26', income: 100, expense: 50, net: 50 }, { tick: '2026-02', label: 'Feb 26', income: 200, expense: 75, net: 125 }] };

describe('hidden chart keyboard contract', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 300, width: 800, height: 300, toJSON: () => ({}) });
  });
  afterEach(() => vi.restoreAllMocks());

  const expectNoHiddenStops = (container: HTMLElement) => {
    const plots = container.querySelectorAll('[aria-hidden="true"] svg.recharts-surface');
    expect(plots.length).toBeGreaterThan(0);
    expect(Array.from(container.querySelectorAll('[aria-hidden="true"] [tabindex]')).filter((node) => Number(node.getAttribute('tabindex')) >= 0)).toEqual([]);
  };

  it.each(['line', 'column', 'area', 'donut', 'ranking', 'radar'] as const)('keeps a sized %s plot out of keyboard order', (kind) => {
    const chartData: ChartData = ['line', 'column', 'area'].includes(kind) ? series : {
      ...data, compared: data.slices.map((slice) => ({ key: slice.key, label: slice.label, now: slice.value, before: slice.value / 2 })),
    };
    const { container } = renderThemed(<ChartPlot spec={{ ...spec, kind }} data={chartData} height={300} ground="surface" />);
    expectNoHiddenStops(container);
  });

  it('keeps Overview flow data accessible without hidden SVG keyboard stops', () => {
    const months = [{ month: '2026-01', income: 100, expense: 50, net: 50 }];
    const { container } = renderThemed(<AccountFlows account={ACCOUNTS[0]} months={months} month={months[0]} prior={null} window={3} onWindow={() => {}} otherCurrencies={[]} deltas={{ income: null, expense: null }} />);
    expectNoHiddenStops(container);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '100 EUR' })).toBeInTheDocument();
  });

  it('keeps Overview category data accessible without hidden SVG keyboard stops', () => {
    const { container } = renderThemed(<SpendingByCategory spend={[{ category: 'food', total: 30 }]} total={30} month="2026-01" currency="EUR" onSeeAll={() => {}} />);
    expectNoHiddenStops(container);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getAllByRole('cell', { name: '30 EUR' })).toHaveLength(2);
  });
});

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
