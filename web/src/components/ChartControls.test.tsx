import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderThemed } from '../test/harness';
import { ChartControls } from './ChartControls';

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
