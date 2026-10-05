import { fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Button, type ButtonSize, type ButtonVariant } from './Button';

const variants: ButtonVariant[] = [
  'primary', 'secondary', 'tertiary', 'destructive-primary', 'destructive-secondary',
];
const sizes: ButtonSize[] = ['compact', 'standard', 'touch'];

describe('Button', () => {
  it.each(variants)('uses an isolated %s variant on a native button', (variant) => {
    render(<Button type="button" variant={variant} size="standard">Continue</Button>);
    const button = screen.getByRole('button', { name: 'Continue' });
    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveClass(`action-button--${variant}`);
    expect(button).not.toHaveClass('btn');
  });

  it.each(sizes)('accepts the explicit %s size', (size) => {
    render(<Button type="button" variant="secondary" size={size}>Cancel</Button>);
    expect(screen.getByRole('button')).toHaveClass(`action-button--${size}`);
  });

  it('leaves submission to an explicit submit button', () => {
    const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
    const action = vi.fn();
    render(
      <form onSubmit={submit}>
        <Button type="button" variant="tertiary" size="standard" onClick={action}>Back</Button>
        <Button type="submit" variant="primary" size="standard">Save changes</Button>
      </form>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(action).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(submit).toHaveBeenCalledOnce();
  });

  it('preserves native reset behavior and ref access', () => {
    const reset = vi.fn();
    const ref = createRef<HTMLButtonElement>();
    render(
      <form onReset={reset}>
        <Button ref={ref} type="reset" variant="secondary" size="standard">Reset</Button>
      </form>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(reset).toHaveBeenCalledOnce();
    expect(ref.current).toBe(screen.getByRole('button'));
  });

  it('keeps pending identity and focus, refusing activation and form submission', () => {
    const click = vi.fn();
    const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
    const button = (pending: boolean) => (
      <form onSubmit={submit}>
        <Button type="submit" variant="primary" size="standard" pending={pending} onClick={click}>
          Save changes
        </Button>
      </form>
    );
    const { rerender } = render(button(false));
    const save = screen.getByRole('button', { name: 'Save changes' });
    save.focus();
    rerender(button(true));
    expect(save).toHaveFocus();
    expect(save).toBeEnabled();
    expect(save).toHaveAttribute('aria-disabled', 'true');
    expect(save).toHaveAttribute('aria-busy', 'true');
    expect(save).toHaveAttribute('data-pending', 'true');
    fireEvent.click(save);
    fireEvent.click(save, { detail: 0 });
    expect(click).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    rerender(button(false));
    fireEvent.click(save);
    expect(click).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledOnce();
  });

  it.each([true, 'true'] as const)('guards focus-retaining aria-disabled=%s', (locked) => {
    const click = vi.fn();
    const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(
      <form onSubmit={submit}>
        <Button type="submit" variant="primary" size="standard" aria-disabled={locked} onClick={click}>
          Confirm
        </Button>
      </form>,
    );
    const button = screen.getByRole('button');
    button.focus();
    expect(button).toHaveFocus();
    expect(fireEvent.click(button)).toBe(false);
    expect(click).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it('retains disabled semantics and refuses activation', () => {
    const click = vi.fn();
    render(<Button type="button" variant="secondary" size="standard" disabled onClick={click}>Cancel</Button>);
    const button = screen.getByRole('button');
    expect(button).toBeDisabled();
    button.click();
    expect(click).not.toHaveBeenCalled();
  });

  it('names icon-only actions without announcing their drawing', () => {
    render(
      <Button type="button" variant="tertiary" size="touch" iconOnly aria-label="Close editor">
        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 6l12 12M6 18L18 6" /></svg>
      </Button>,
    );
    expect(screen.getByRole('button', { name: 'Close editor' })).toHaveClass('action-button--icon');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});
