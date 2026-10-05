import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Chips } from './Chips';

const options = [{ key: 'month', label: 'Month' }, { key: 'year', label: 'Year' }];

function Choices() {
  const [selected, setSelected] = useState('month');
  return <Chips label="Period" options={options} selected={selected} onSelect={setSelected} />;
}

describe('Chips', () => {
  it('uses a named group of ordinary pressed buttons, not a composite widget', () => {
    render(<Choices />);
    expect(screen.getByRole('group', { name: 'Period' })).toHaveClass('choice-chips');
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((button) => button.getAttribute('type'))).toEqual(['button', 'button']);
    expect(buttons.map((button) => button.tabIndex)).toEqual([0, 0]);
    expect(buttons[0]).toHaveAttribute('aria-pressed', 'true');
    expect(buttons[1]).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  });

  it('changes pressed selection after pointer and keyboard-generated click activation', () => {
    render(<Choices />);
    const year = screen.getByRole('button', { name: 'Year' });
    const month = screen.getByRole('button', { name: 'Month' });
    fireEvent.click(year);
    expect(year).toHaveAttribute('aria-pressed', 'true');
    expect(month).toHaveAttribute('aria-pressed', 'false');
    month.focus();
    fireEvent.click(month, { detail: 0 });
    expect(month).toHaveAttribute('aria-pressed', 'true');
    expect(month).toHaveFocus();
    expect(year).toHaveAttribute('aria-pressed', 'false');
  });

  it('retains focus when locked and refuses pointer/touch/keyboard click activation', () => {
    const select = vi.fn();
    const choices = (locked: boolean) => (
      <Chips label="Period" options={options} selected="month" onSelect={select} locked={locked} />
    );
    const { rerender } = render(choices(false));
    const year = screen.getByRole('button', { name: 'Year' });
    year.focus();
    rerender(choices(true));
    expect(year).toHaveFocus();
    for (const button of screen.getAllByRole('button')) {
      expect(button).toHaveAttribute('aria-disabled', 'true');
      expect(button).toBeEnabled();
    }
    fireEvent.click(year);
    fireEvent.touchStart(year);
    fireEvent.touchEnd(year);
    fireEvent.click(year);
    fireEvent.click(year, { detail: 0 });
    expect(select).not.toHaveBeenCalled();
    expect(year).toHaveAttribute('aria-pressed', 'false');
    rerender(choices(false));
    fireEvent.click(year);
    expect(select).toHaveBeenCalledExactlyOnceWith('year');
    expect(year).not.toHaveAttribute('aria-disabled');
  });

  it('never submits its surrounding form', () => {
    const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(<form onSubmit={submit}><Choices /></form>);
    fireEvent.click(screen.getByRole('button', { name: 'Year' }));
    expect(submit).not.toHaveBeenCalled();
  });
});
