import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { APP_SETTINGS, ACCOUNTS, SUMMARY } from '../test/fixtures';
import { mockFetch, ok, renderThemed } from '../test/harness';
import { AccountDialog } from './AccountDialog';
import { ChartWizard } from './ChartWizard';
import { GoalEditor } from './GoalEditor';

describe('modal callers supply deliberate focus transitions', () => {
  it('returns New account to its actual initiating action without autofocus stealing the opener', () => {
    function AccountFlow() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>Add account</button>{open && <AccountDialog
        kind="add" origin="add" account={null} baseCurrency="EUR" onStep={vi.fn()}
        onClose={() => setOpen(false)} onOpenHistory={vi.fn()} onCreated={vi.fn()}
        onUpdated={vi.fn()} onDeleted={vi.fn()}
      />}</>;
    }
    renderThemed(<AccountFlow />);
    const opener = screen.getByRole('button', { name: 'Add account' });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole('heading', { name: 'New account' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(opener).toHaveFocus();
    expect(document.body.style.overflow).toBe('');
  });

  it('focuses the actual goal details heading and keeps Shift+Tab inside after its type tile disappears', async () => {
    mockFetch({ 'GET /api/accounts': () => ok(ACCOUNTS), 'GET /api/app-settings': () => ok(APP_SETTINGS) });
    renderThemed(<GoalEditor goalId="new" onClose={vi.fn()} onSaved={vi.fn()} />);
    const tile = await screen.findByRole('button', { name: /^Financial independence/ });
    tile.focus();
    fireEvent.click(tile);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Financial independence' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    const name = within(dialog).getByRole('textbox', { name: 'Name' });
    name.focus();
    fireEvent.change(name, { target: { value: 'Independent' } });
    expect(name).toHaveFocus();
    expect(name).toHaveValue('Independent');
  });

  it('focuses the chart details step and retains typing focus across preview refreshes', async () => {
    mockFetch({
      'GET /api/summary': () => ok(SUMMARY),
      'GET /api/summary/months': () => ok({ scope: 'all', baseCurrency: 'EUR', from: '', to: '', months: [] }),
    });
    renderThemed(<ChartWizard open editing={null} accounts={ACCOUNTS} accountsError={null}
      onClose={vi.fn()} onSave={vi.fn()} />);
    const line = screen.getByRole('button', { name: 'Line' });
    line.focus();
    fireEvent.click(line);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'What should it compare?' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    const name = screen.getByRole('textbox', { name: 'Chart name' });
    name.focus();
    fireEvent.change(name, { target: { value: 'My chart' } });
    await waitFor(() => expect(name).toHaveValue('My chart'));
    expect(name).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Change shape' }));
    expect(screen.getByRole('heading', { name: 'What shape?' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Line' }));
    expect(screen.getByRole('textbox', { name: 'Chart name' })).toHaveValue('My chart');
  });
});
