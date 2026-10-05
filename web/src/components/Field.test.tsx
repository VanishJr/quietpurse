import { fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Field } from './Field';

describe('Field', () => {
  it('associates a visible persistent label, help, external description and error', () => {
    render(
      <>
        <p id="currency">Amounts use EUR.</p>
        <Field
          id="target"
          label="Target amount (EUR)"
          help="Enter the total you want to save."
          error="Enter an amount greater than zero."
          control="input"
          controlProps={{ type: 'number', name: 'target', defaultValue: '-2', 'aria-describedby': 'currency' }}
        />
      </>,
    );
    const input = screen.getByRole('spinbutton', { name: 'Target amount (EUR)' });
    expect(screen.getByText('Target amount (EUR)')).toBeVisible();
    expect(input).toHaveAttribute('id', 'target');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', 'currency target-help target-error');
    expect(input).toHaveAccessibleDescription(
      'Amounts use EUR. Enter the total you want to save. Enter an amount greater than zero.',
    );
    expect(input).toHaveValue(-2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('passes native input props, events and ref without inventing validation', () => {
    const change = vi.fn();
    const ref = createRef<HTMLInputElement>();
    render(
      <Field id="name" label="Goal name" control="input" controlProps={{
        type: 'text', name: 'name', required: true, placeholder: 'Emergency fund', onChange: change, ref,
      }} />,
    );
    const input = screen.getByRole('textbox', { name: 'Goal name' });
    expect(ref.current).toBe(input);
    expect(input).toHaveAttribute('required');
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(input).not.toHaveAttribute('aria-describedby');
    fireEvent.change(input, { target: { value: 'Reserve' } });
    expect(change).toHaveBeenCalledOnce();
    expect(input).toHaveValue('Reserve');
  });

  it('removes stale error associations while retaining the entered value and focus', () => {
    const field = (error?: string) => (
      <Field id="amount" label="Amount" help="Use account units." error={error} control="input"
        controlProps={{ type: 'text', defaultValue: '42' }} />
    );
    const { rerender } = render(field('Check this amount.'));
    const input = screen.getByRole('textbox');
    input.focus();
    rerender(field());
    expect(input).toHaveFocus();
    expect(input).toHaveValue('42');
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(input).toHaveAttribute('aria-describedby', 'amount-help');
    expect(screen.queryByText('Check this amount.')).not.toBeInTheDocument();
  });

  it('renders a native select with explicit options and props', () => {
    const change = vi.fn();
    render(
      <Field id="account" label="Destination account" control="select" controlProps={{
        defaultValue: 'two', onChange: change,
        children: <><option value="one">Everyday</option><option value="two">Savings</option></>,
      }} />,
    );
    const select = screen.getByRole('combobox', { name: 'Destination account' });
    expect(select.tagName).toBe('SELECT');
    expect(select).toHaveValue('two');
    fireEvent.change(select, { target: { value: 'one' } });
    expect(change).toHaveBeenCalledOnce();
    expect(select).toHaveValue('one');
  });

  it('renders a native textarea and distinguishes read-only from disabled', () => {
    render(
      <>
        <Field id="notes" label="Notes" control="textarea" controlProps={{ readOnly: true, defaultValue: 'Saved note', rows: 4 }} />
        <Field id="locked" label="Locked name" help="Saving changes." control="input" controlProps={{ disabled: true, defaultValue: 'Reserve' }} />
      </>,
    );
    const notes = screen.getByRole('textbox', { name: 'Notes' });
    expect(notes.tagName).toBe('TEXTAREA');
    expect(notes).toHaveAttribute('readonly');
    expect(notes).toHaveAttribute('rows', '4');
    expect(notes).toBeEnabled();
    notes.focus();
    expect(notes).toHaveFocus();
    expect(screen.getByRole('textbox', { name: 'Locked name' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Locked name' })).toHaveAccessibleDescription('Saving changes.');
  });
});
