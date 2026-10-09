import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button';
import { FormActions } from './FormActions';

const back = <Button type="button" variant="tertiary" size="standard">Back</Button>;
const cancel = <Button type="button" variant="secondary" size="standard">Cancel</Button>;
const completion = <Button type="submit" variant="primary" size="standard">Create goal</Button>;

describe('FormActions', () => {
  it('keeps supporting actions before completion in DOM/keyboard reading order', () => {
    render(<FormActions back={back} cancel={cancel} completion={completion} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual(['Back', 'Cancel', 'Create goal']);
    expect(buttons.map((button) => button.tabIndex)).toEqual([0, 0, 0]);
    expect(buttons[0]).toHaveClass('action-button--tertiary');
    expect(buttons[1]).toHaveClass('action-button--secondary');
    expect(buttons[2]).toHaveClass('action-button--primary');
    expect(buttons[0].parentElement).toHaveClass('form-actions__back');
    expect(buttons[1].parentElement).toHaveClass('form-actions__cancel');
    expect(buttons[2].parentElement).toHaveClass('form-actions__completion');
  });

  it('does not wrap actions in another form or change submission', () => {
    const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
    const { container } = render(
      <form onSubmit={submit}><FormActions cancel={cancel} completion={completion} /></form>,
    );
    expect(container.querySelectorAll('form')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Create goal' }));
    expect(submit).toHaveBeenCalledOnce();
  });

  it('supports completion-only decisions without empty supporting wrappers', () => {
    const { container } = render(<FormActions completion={completion} />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(container.querySelector('.form-actions__back')).toBeNull();
    expect(container.querySelector('.form-actions__cancel')).toBeNull();
  });
});
