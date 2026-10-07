import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Sheet } from './components/Sheet';
import { useEditorSession } from './editor';
import { setUrl, useUrl } from './url';
import { ScreenShown } from './screen';

function Editor({ busy = false, onClosed = () => {}, onDiscarded }: { busy?: boolean; onClosed?: () => void; onDiscarded?: () => void }) {
  const [open, setOpen] = useState(true);
  const [name, setName] = useState('Salary');
  const url = useUrl();
  const session = useEditorSession({
    open, dirty: name !== 'Salary', busy, onClose: () => { onClosed(); setOpen(false); },
    onNavigationDiscard: () => { setName('Salary'); onDiscarded?.(); },
  });
  return <><p data-testid="place">{url.screen ?? 'overview'}</p>
    <Sheet open={open} pattern="short-editor" title="Edit source" onClose={session.requestClose} busy={busy} guard={session.guard}>
      <h2>Edit source</h2>
      <label>Name<input value={name} readOnly={busy} onChange={(event) => setName(event.target.value)} /></label>
      <button onClick={session.requestClose}>Cancel</button>
      <button onClick={() => session.finish(() => setOpen(false))}>Confirmed success</button>
    </Sheet></>;
}

const change = (value: string) => fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value } });

describe('meaningful editor dismissal', () => {
  it('closes pristine and reverted drafts without confirmation', () => {
    const closed = vi.fn();
    render(<Editor onClosed={closed} />);
    change('Grant');
    change('Salary');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(closed).toHaveBeenCalledOnce();
    expect(screen.queryByText('Discard unsaved changes?')).not.toBeInTheDocument();
  });

  it('retains the actual input through guard, Keep editing and guard Escape', () => {
    render(<Editor />);
    const input = screen.getByRole('textbox', { name: 'Name' });
    input.focus();
    change('Grant');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('textbox')).toBe(input);
    expect(input).toHaveValue('Grant');
    expect(input).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(input).toHaveValue('Grant');
    expect(input).toHaveFocus();
  });

  it('explains untracked history until the browser returns to the original entry', async () => {
    render(<Editor />);
    change('Grant');
    act(() => {
      window.history.pushState('foreign-state', '', '/?screen=settings');
      window.dispatchEvent(new PopStateEvent('popstate', { state: 'foreign-state' }));
    });
    expect(screen.getByTestId('place')).toHaveTextContent('overview');
    expect(screen.getByText(/cannot restore the untracked history address automatically/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByRole('textbox')).toHaveValue('Grant');
    expect(window.location.search).toBe('?screen=settings');
    act(() => window.history.back());
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(screen.getByRole('textbox')).toHaveValue('Grant');
    expect(screen.queryByText(/browser history position is unverified/)).not.toBeInTheDocument();
  });

  it('protects full-document traversal or reload only while an active session has unsaved work', () => {
    const { rerender } = render(<ScreenShown value={true}><Editor /></ScreenShown>);
    const pristine = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(pristine);
    expect(pristine.defaultPrevented).toBe(false);
    change('Grant');
    const dirty = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
    rerender(<ScreenShown value={false}><Editor /></ScreenShown>);
    const hidden = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(hidden);
    expect(hidden.defaultPrevented).toBe(false);
  });

  it('discards only after the explicit secondary destructive action', () => {
    const closed = vi.fn();
    render(<Editor onClosed={closed} />);
    change('Grant');
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    const discard = screen.getByRole('button', { name: 'Discard changes' });
    expect(discard).toHaveClass('action-button--destructive-secondary');
    expect(closed).not.toHaveBeenCalled();
    fireEvent.click(discard);
    expect(closed).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('stages URL publication until Discard, and cancels without writing on Keep editing', () => {
    render(<Editor />);
    change('Grant');
    const before = window.location.href;
    act(() => setUrl({ screen: 'settings' }));
    expect(window.location.href).toBe(before);
    expect(screen.getByTestId('place')).toHaveTextContent('overview');
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(window.location.href).toBe(before);
    expect(screen.getByRole('textbox')).toHaveValue('Grant');
    act(() => setUrl({ screen: 'settings' }));
    act(() => setUrl({ screen: 'analytics' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.getByTestId('place')).toHaveTextContent('analytics');
  });

  it('resets an abandoned navigation draft only on explicit Discard, not Keep or confirmed success', () => {
    const discarded = vi.fn();
    render(<Editor onDiscarded={discarded} />);
    change('Grant');
    act(() => setUrl({ screen: 'settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(discarded).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox')).toHaveValue('Grant');
    act(() => setUrl({ screen: 'settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(discarded).toHaveBeenCalledOnce();
    expect(screen.getByRole('textbox')).toHaveValue('Salary');
    change('New grant');
    fireEvent.click(screen.getByRole('button', { name: 'Confirmed success' }));
    expect(discarded).toHaveBeenCalledOnce();
  });

  it('locks pending dismissal and navigation without implying cancellation', () => {
    const closed = vi.fn();
    const { rerender } = render(<Editor onClosed={closed} />);
    change('Grant');
    rerender(<Editor busy onClosed={closed} />);
    const before = window.location.href;
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    act(() => setUrl({ screen: 'settings' }));
    expect(window.location.href).toBe(before);
    expect(closed).not.toHaveBeenCalled();
    expect(screen.queryByText('Discard unsaved changes?')).not.toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).getByRole('textbox')).toHaveValue('Grant');
    rerender(<Editor onClosed={closed} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus();
  });

  it('lets confirmed success close without a discard prompt and hidden sessions do not block navigation', () => {
    const { rerender } = render(<ScreenShown value={true}><Editor /></ScreenShown>);
    change('Grant');
    fireEvent.click(screen.getByRole('button', { name: 'Confirmed success' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    rerender(<ScreenShown value={false}><Editor key="hidden-draft" /></ScreenShown>);
    change('Uncommitted background draft');
    act(() => setUrl({ screen: 'analytics' }));
    expect(window.location.search).toContain('screen=analytics');
  });
});
