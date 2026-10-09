import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ACCOUNTS, accountMonths, accountSummary, SUMMARY } from '../test/fixtures';
import { askedFor, fail, mockFetch, ok, renderThemed, requests } from '../test/harness';
import { ThemeProvider } from '../theme';
import type { Chart } from '../types';
import { ChartWizard } from './ChartWizard';

const CHART: Chart = {
  id: 'chart-existing',
  title: 'My spending',
  kind: 'line',
  accountId: null,
  metrics: ['expense'],
  breakdown: 'expense-categories',
  range: '12m',
};

const MONTHS = { scope: 'all', baseCurrency: 'EUR', from: '', to: '', months: [] };
const previewRoutes = {
  'GET /api/summary': (_init?: RequestInit, url?: string) => {
    const accountId = askedFor(url);
    return ok(accountId ? accountSummary(accountId) : SUMMARY);
  },
  'GET /api/summary/months': (_init?: RequestInit, url?: string) => {
    const accountId = askedFor(url);
    return ok(accountId ? accountMonths(accountId) : MONTHS);
  },
};

const wizard = (editing: Chart | null, close = vi.fn(), save = vi.fn()) => (
  <ChartWizard open editing={editing} accounts={ACCOUNTS} accountsError={null} onClose={close} onSave={save} />
);

const chooseLine = () => fireEvent.click(screen.getByRole('button', { name: 'Line' }));
const back = () => fireEvent.click(screen.getByRole('button', { name: 'Change shape' }));
const cancel = () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

describe('ChartWizard field and preview context', () => {
  it('names Period without changing range serialization and associates incomplete fields', () => {
    const save = vi.fn();
    mockFetch(previewRoutes);
    renderThemed(wizard(null, vi.fn(), save));
    chooseLine();
    expect(screen.getByRole('group', { name: 'Period' })).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByText('Ticks')).not.toBeInTheDocument();
    const name = screen.getByRole('textbox', { name: 'Chart name' });
    expect(name).not.toHaveAttribute('aria-describedby');
    fireEvent.change(name, { target: { value: '' } });
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(name).toHaveAccessibleDescription('Enter a chart name.');
    fireEvent.click(screen.getByRole('button', { name: 'Expenses' }));
    const measures = screen.getByRole('group', { name: 'Measures' });
    expect(measures).toHaveAttribute('aria-invalid', 'true');
    expect(measures).toHaveAccessibleDescription('Pick at least one.');
    expect(save).not.toHaveBeenCalled();
    fireEvent.change(name, { target: { value: 'Named chart' } });
    fireEvent.click(screen.getByRole('button', { name: 'Income' }));
    fireEvent.click(screen.getByRole('button', { name: '3 years' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create chart' }));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ title: 'Named chart', range: '3y', metrics: ['income'] }));
  });

  it('distinguishes delayed account choices from a missing saved account without retargeting it', async () => {
    mockFetch(previewRoutes);
    const view = renderThemed(<ChartWizard open editing={{ ...CHART, accountId: 'gone' }} accounts={null} accountsError={null} onClose={vi.fn()} onSave={vi.fn()} />);
    expect(screen.getByText('Reading account choices…')).toBeVisible();
    expect(screen.queryByText(/Saved account gone is unavailable/)).not.toBeInTheDocument();
    view.rerender(<ThemeProvider>{wizard({ ...CHART, accountId: 'gone' })}</ThemeProvider>);
    expect(await screen.findByText(/Saved account gone is unavailable/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'All accounts' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('button', { name: 'Retry preview' })).not.toBeInTheDocument();
    expect(requests()).toHaveLength(0);
  });

  it('retries a refused preview without resetting draft values or losing orientation', async () => {
    let down = true;
    mockFetch({ ...previewRoutes, 'GET /api/summary/months': () => down ? fail(503, { error: 'preview unavailable' }) : ok(MONTHS) });
    renderThemed(wizard(CHART));
    fireEvent.change(screen.getByLabelText('Chart name'), { target: { value: 'My draft remains' } });
    const retry = await screen.findByRole('button', { name: 'Retry preview' });
    down = false;
    fireEvent.click(retry);
    expect(screen.getByRole('heading', { name: 'Preview' })).toHaveFocus();
    await waitFor(() => expect(screen.queryByText('Reading the numbers…')).not.toBeInTheDocument());
    expect(screen.queryByText('preview unavailable')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Chart name')).toHaveValue('My draft remains');
    expect(requests()).toEqual(['GET /api/summary/months', 'GET /api/summary/months']);
  });
});

describe('ChartWizard drafts', () => {
  it.each(['Cancel', 'Close dialog', 'Escape'])(
    'closes a pristine new draft via %s without guarding generated id or name',
    async (dismissal) => {
      const close = vi.fn();
      mockFetch(previewRoutes);
      renderThemed(wizard(null, close));
      chooseLine();
      await waitFor(() => expect(requests()).toContain('GET /api/summary/months'));
      expect(screen.getByRole('textbox', { name: 'Chart name' })).toHaveValue('Expenses · 12 months');
      if (dismissal === 'Escape') fireEvent.keyDown(document, { key: 'Escape' });
      else fireEvent.click(screen.getByRole('button', { name: dismissal }));
      expect(close).toHaveBeenCalledOnce();
      expect(screen.queryByRole('button', { name: 'Keep editing' })).not.toBeInTheDocument();
      expect(requests().every((request) => request.startsWith('GET '))).toBe(true);
    },
  );

  it.each(['Cancel', 'Close dialog', 'Escape'])(
    'guards reader-owned names via %s and keeps values mounted on guard Escape',
    (dismissal) => {
      const close = vi.fn();
      mockFetch(previewRoutes);
      renderThemed(wizard(null, close));
      chooseLine();
      const name = screen.getByRole('textbox', { name: 'Chart name' });
      name.focus();
      fireEvent.change(name, { target: { value: 'My chart' } });
      if (dismissal === 'Escape') fireEvent.keyDown(document, { key: 'Escape' });
      else fireEvent.click(screen.getByRole('button', { name: dismissal }));
      expect(close).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus();
      expect(name).not.toBeVisible();
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(name).toBeVisible();
      expect(name).toHaveFocus();
      expect(name).toHaveValue('My chart');
      cancel();
      fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
      expect(close).toHaveBeenCalledOnce();
      expect(requests().every((request) => request.startsWith('GET '))).toBe(true);
    },
  );

  it('makes reverted detail and name edits pristine without counting generated suggestions', () => {
    const close = vi.fn();
    mockFetch(previewRoutes);
    renderThemed(wizard(null, close));
    chooseLine();
    const name = screen.getByRole('textbox', { name: 'Chart name' });
    fireEvent.click(screen.getByRole('button', { name: '3 months' }));
    expect(name).toHaveValue('Expenses · 3 months');
    fireEvent.click(screen.getByRole('button', { name: '12 months' }));
    expect(name).toHaveValue('Expenses · 12 months');
    fireEvent.click(screen.getByRole('button', { name: 'Income' }));
    fireEvent.click(screen.getByRole('button', { name: 'Income' }));
    fireEvent.change(name, { target: { value: 'My chart' } });
    fireEvent.change(name, { target: { value: 'Expenses · 12 months' } });
    back();
    fireEvent.click(screen.getByRole('button', { name: 'Donut' }));
    back();
    chooseLine();
    cancel();
    expect(close).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Keep editing' })).not.toBeInTheDocument();
  });

  it('preserves reader-owned names and both series and share fields across Back and shape changes', () => {
    const save = vi.fn();
    mockFetch(previewRoutes);
    renderThemed(wizard(null, vi.fn(), save));
    chooseLine();
    fireEvent.click(screen.getByRole('button', { name: 'Income' }));
    fireEvent.click(screen.getByRole('button', { name: '6 months' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Chart name' }), { target: { value: 'Mine' } });
    back();
    expect(screen.queryByRole('button', { name: 'Keep editing' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Donut' }));
    expect(screen.getByRole('textbox', { name: 'Chart name' })).toHaveValue('Mine');
    fireEvent.click(screen.getByRole('button', { name: 'Income by category' }));
    back();
    chooseLine();
    expect(screen.getByRole('button', { name: 'Income' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Expenses' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '6 months' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('textbox', { name: 'Chart name' })).toHaveValue('Mine');
    back();
    fireEvent.click(screen.getByRole('button', { name: 'Donut' }));
    expect(screen.getByRole('button', { name: 'Income by category' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Create chart' }));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'donut', title: 'Mine', metrics: ['income', 'expense'], breakdown: 'income-categories', range: '6m',
    }));
    expect(screen.queryByRole('button', { name: 'Keep editing' })).not.toBeInTheDocument();
  });

  it.each(['kind', 'account', 'metrics', 'breakdown', 'range', 'title'])(
    'guards meaningful existing-chart %s edits against stored values',
    (field) => {
      const close = vi.fn();
      mockFetch(previewRoutes);
      renderThemed(wizard(field === 'breakdown' ? { ...CHART, kind: 'donut' } : CHART, close));
      if (field === 'kind') { back(); fireEvent.click(screen.getByRole('button', { name: 'Area' })); }
      if (field === 'account') fireEvent.click(screen.getByRole('button', { name: 'Sparkasse Giro' }));
      if (field === 'metrics') fireEvent.click(screen.getByRole('button', { name: 'Income' }));
      if (field === 'breakdown') fireEvent.click(screen.getByRole('button', { name: 'Income by category' }));
      if (field === 'range') fireEvent.click(screen.getByRole('button', { name: '6 months' }));
      if (field === 'title') fireEvent.change(screen.getByRole('textbox', { name: 'Chart name' }), { target: { value: 'New name' } });
      cancel();
      expect(close).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus();
    },
  );

  it('compares existing values rather than suggestions and returns to pristine on undo', () => {
    const close = vi.fn();
    mockFetch(previewRoutes);
    renderThemed(wizard({ ...CHART, metrics: ['expense', 'income'] }, close));
    const name = screen.getByRole('textbox', { name: 'Chart name' });
    fireEvent.change(name, { target: { value: 'Changed' } });
    fireEvent.change(name, { target: { value: CHART.title } });
    fireEvent.click(screen.getByRole('button', { name: 'Income' }));
    fireEvent.click(screen.getByRole('button', { name: 'Income' }));
    back();
    fireEvent.click(screen.getByRole('button', { name: 'Column' }));
    back();
    chooseLine();
    cancel();
    expect(close).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Keep editing' })).not.toBeInTheDocument();
  });

  it('retains draft and opening baseline through parent-object changes and preview refreshes', async () => {
    const close = vi.fn();
    mockFetch(previewRoutes);
    const view = renderThemed(wizard(CHART, close));
    const name = screen.getByRole('textbox', { name: 'Chart name' });
    name.focus();
    fireEvent.change(name, { target: { value: 'My unsaved name' } });
    view.rerender(<ThemeProvider>{wizard({ ...CHART, title: 'Background update' }, close)}</ThemeProvider>);
    expect(name).toHaveValue('My unsaved name');
    expect(name).toHaveFocus();
    cancel();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    fireEvent.change(name, { target: { value: CHART.title } });
    await waitFor(() => expect(requests().filter((request) => request === 'GET /api/summary/months')).toHaveLength(1));
    cancel();
    expect(close).toHaveBeenCalledOnce();
  });

  it('retains incomplete measure choices, refuses completion, and allows reverting to pristine', () => {
    const close = vi.fn();
    const save = vi.fn();
    mockFetch(previewRoutes);
    renderThemed(wizard(null, close, save));
    chooseLine();
    fireEvent.click(screen.getByRole('button', { name: 'Expenses' }));
    expect(screen.getByText('Pick at least one.')).toBeVisible();
    const completion = screen.getByRole('button', { name: 'Create chart' });
    expect(completion).toBeDisabled();
    fireEvent.click(completion);
    expect(save).not.toHaveBeenCalled();
    cancel();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByRole('button', { name: 'Expenses' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Expenses' }));
    expect(screen.queryByText('Pick at least one.')).not.toBeInTheDocument();
    cancel();
    expect(close).toHaveBeenCalledOnce();
  });

  it('keeps a pristine draft pristine through pending and refused preview reads', async () => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>((done) => { resolve = done; });
    const close = vi.fn();
    mockFetch({ ...previewRoutes, 'GET /api/summary/months': () => pending });
    renderThemed(wizard(null, close));
    chooseLine();
    expect(screen.getByText('Reading the numbers…')).toBeVisible();
    await act(async () => resolve(fail(500, { error: 'preview unavailable' })));
    expect(await screen.findByText(/preview unavailable/)).toBeVisible();
    cancel();
    expect(close).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Keep editing' })).not.toBeInTheDocument();
    expect(requests()).toEqual(['GET /api/summary/months']);
  });

  it('keeps optimistic saving with the owning screen and bypasses its own dirty blocker', () => {
    const save = vi.fn();
    const close = vi.fn();
    mockFetch(previewRoutes);
    function Host() {
      const [open, setOpen] = useState(true);
      return <ChartWizard open={open} editing={null} accounts={ACCOUNTS} accountsError={null}
        onClose={close} onSave={(draft) => { save(draft); setOpen(false); }} />;
    }
    renderThemed(<Host />);
    chooseLine();
    fireEvent.change(screen.getByRole('textbox', { name: 'Chart name' }), { target: { value: 'My chart' } });
    const completion = screen.getByRole('button', { name: 'Create chart' });
    expect(completion).toHaveClass('action-button--primary');
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveClass('action-button--secondary');
    expect(screen.getByRole('button', { name: 'Change shape' })).toHaveClass('action-button--tertiary');
    expect(completion.closest('.sheet-footer')).not.toBeNull();
    fireEvent.click(completion);
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ ...CHART, id: expect.any(String), title: 'My chart' }));
    expect(close).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(requests().every((request) => request.startsWith('GET '))).toBe(true);
  });
});
