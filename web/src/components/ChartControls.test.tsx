import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderThemed } from '../test/harness';
import { ChartControls } from './ChartControls';
import { ScreenShown } from '../screen';
import { ThemeProvider } from '../theme';

const props = () => ({ id: 'c-a', label: 'A', onEdit: vi.fn(), onDuplicate: vi.fn(), onDelete: vi.fn(), fallbackFocus: () => document.querySelector<HTMLElement>('#survivor') });

describe('ChartControls', () => {
  it('uses measured menu bounds, then returns to the trigger on reflow and Escape', () => {
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('dock-menu')) return { x: 0, y: 0, left: 0, right: 288, top: 0, bottom: 180, width: 288, height: 180, toJSON: () => ({}) };
      if (this.tagName === 'BUTTON') return { x: 0, y: 0, left: 0, right: 40, top: 0, bottom: 40, width: 40, height: 40, toJSON: () => ({}) };
      return original.call(this);
    });
    renderThemed(<ChartControls {...props()} />);
    const trigger = screen.getByRole('button', { name: 'Actions for A' });
    fireEvent.click(trigger);
    const menu = screen.getByRole('group', { name: 'Actions for A' });
    expect(menu.style.left).toBe('8px');
    expect(menu.style.top).toBe('8px');
    expect(screen.getByRole('button', { name: 'Edit' })).toHaveFocus();
    fireEvent(window, new Event('resize'));
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
  });

  it('reveals safe confirmation focus inside a capped menu without scrolling its owner', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const isMenu = this.classList.contains('dock-menu');
      const y = this.closest('.dock-menu-row') ? 210 : 20;
      const top = isMenu ? 0 : y;
      const height = isMenu ? 100 : 44;
      return { x: 0, y: top, left: 0, right: 288, top, bottom: top + height, width: 288, height, toJSON: () => ({}) };
    });
    const { container } = renderThemed(<div className="screen"><ChartControls {...props()} contextual /></div>);
    fireEvent.click(screen.getByRole('button', { name: 'More actions for A' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByRole('button', { name: 'Keep' })).toHaveFocus();
    expect(screen.getByRole('group', { name: 'Actions for A' }).scrollTop).toBe(158);
    expect(container.querySelector('.screen')?.scrollTop).toBe(0);
  });

  it('ignores late opening scroll events but dismisses when the anchor actually moves', () => {
    let top = 20;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const y = this.tagName === 'BUTTON' ? top : 0;
      return { x: 0, y, left: 0, right: 40, top: y, bottom: y + 40, width: 40, height: 40, toJSON: () => ({}) };
    });
    renderThemed(<ChartControls {...props()} contextual />);
    const trigger = screen.getByRole('button', { name: 'More actions for A' });
    fireEvent.click(trigger);
    fireEvent.scroll(document);
    expect(screen.getByRole('group', { name: 'Actions for A' })).toBeInTheDocument();
    top = 40;
    fireEvent.scroll(document);
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('uses a stable fallback when contextual duplication replaces its action owner', () => {
    const callbacks = props();
    renderThemed(<><button id="survivor">Survivor</button><ChartControls {...callbacks} contextual /></>);
    fireEvent.click(screen.getByRole('button', { name: 'More actions for A' }));
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
    expect(callbacks.onDuplicate).toHaveBeenCalledExactlyOnceWith('c-a');
    expect(screen.getByRole('button', { name: 'Survivor' })).toHaveFocus();
  });

  it('releases the previous owner when the keyboard reaches another chart trigger', () => {
    renderThemed(<><ChartControls {...props()} /><ChartControls {...props()} id="c-b" label="B" /></>);
    const a = screen.getByRole('button', { name: 'Actions for A' });
    const b = screen.getByRole('button', { name: 'Actions for B' });
    fireEvent.click(a);
    expect(screen.getByRole('group', { name: 'Actions for A' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Tab' });
    act(() => b.focus());
    expect(a).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('group', { name: 'Actions for A' })).not.toBeInTheDocument();
    expect(fireEvent.keyDown(document, { key: 'Escape' })).toBe(true);
    expect(b).toHaveFocus();
    fireEvent.click(b);
    expect(screen.getAllByRole('group')).toHaveLength(1);
    expect(screen.getByRole('group', { name: 'Actions for B' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
    expect(b).toHaveFocus();
  });

  it.each([false, true])('keeps pointer actions usable after outside-ancestor focus (pointerup: %s)', (up) => {
    const callbacks = props();
    renderThemed(<><main tabIndex={-1}>Outside ancestor</main><ChartControls {...callbacks} /></>);
    fireEvent.click(screen.getByRole('button', { name: 'Actions for A' }));
    const duplicate = screen.getByRole('button', { name: 'Duplicate' });
    fireEvent.pointerDown(duplicate);
    act(() => screen.getByRole('main').focus());
    if (up) fireEvent.pointerUp(duplicate);
    expect(duplicate).toBeInTheDocument();
    fireEvent.click(duplicate);
    expect(callbacks.onDuplicate).toHaveBeenCalledExactlyOnceWith('c-a');
    expect(callbacks.onDelete).not.toHaveBeenCalled();
  });

  it.each(['screen', 'hidden', 'inert'] as const)('suspends open-menu effects and restoration in a %s branch', (kind) => {
    const callbacks = props();
    const view = (shown: boolean) => <>
      <button id="survivor">Survivor</button>
      <ScreenShown value={kind === 'screen' ? shown : true}>
        <div hidden={kind === 'hidden' && !shown} inert={kind === 'inert' && !shown}>
          <ChartControls {...callbacks} contextual />
        </div>
      </ScreenShown>
    </>;
    const { rerender } = renderThemed(view(true));
    fireEvent.click(screen.getByRole('button', { name: 'More actions for A' }));
    const menu = screen.getByRole('group', { name: 'Actions for A' });
    rerender(<ThemeProvider>{view(false)}</ThemeProvider>);
    const outside = screen.getByRole('button', { name: 'Survivor' });
    act(() => outside.focus());
    fireEvent(window, new Event('resize'));
    fireEvent.scroll(document);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(menu).toBeInTheDocument();
    expect(outside).toHaveFocus();
    rerender(<ThemeProvider>{view(true)}</ThemeProvider>);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
  });

  it('does not focus unavailable controls while opening or confirming a hidden menu', () => {
    const view = (shown: boolean) => <>
      <button>Outside</button>
      <ScreenShown value={shown}><ChartControls {...props()} contextual /></ScreenShown>
    </>;
    const { rerender } = renderThemed(view(true));
    fireEvent.click(screen.getByRole('button', { name: 'More actions for A' }));
    rerender(<ThemeProvider>{view(false)}</ThemeProvider>);
    const outside = screen.getByRole('button', { name: 'Outside' });
    act(() => outside.focus());
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(outside).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(outside).toHaveFocus();
  });

  it('does not delete on entry, cancellation or Escape and recovers focus on confirmation', () => {
    const callbacks = props();
    renderThemed(<><button id="survivor">Survivor</button><ChartControls {...callbacks} contextual /></>);
    const trigger = screen.getByRole('button', { name: 'More actions for A' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit chart' }));
    expect(callbacks.onEdit).toHaveBeenCalledWith('c-a');
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByRole('button', { name: 'Keep' })).toHaveFocus();
    expect(callbacks.onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(callbacks.onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(callbacks.onDelete).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(callbacks.onDelete).toHaveBeenCalledExactlyOnceWith('c-a');
    expect(screen.getByRole('button', { name: 'Survivor' })).toHaveFocus();
  });
});
