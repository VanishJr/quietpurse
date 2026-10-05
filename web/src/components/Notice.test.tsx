import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button';
import { Notice } from './Notice';

describe('Notice', () => {
  it('renders caller-owned facts without inferring success or announcing static content', () => {
    const { container } = render(
      <Notice tone="warning" placement="content" title="Some rows were omitted">
        <p>12 rows are available. 3 rows need review.</p>
      </Notice>,
    );
    expect(screen.getByText('Some rows were omitted')).toBeVisible();
    expect(screen.getByText('12 rows are available. 3 rows need review.')).toBeVisible();
    expect(container.firstElementChild).toHaveClass('notice--warning', 'notice--content');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('announces a caller-selected polite status', () => {
    render(<Notice role="status">Loading goals…</Notice>);
    expect(screen.getByRole('status')).toHaveTextContent('Loading goals…');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('allows selective alerts, full diagnostics and caller-owned remedies', () => {
    const retry = vi.fn();
    const diagnostic = 'Statement could not be read. '.repeat(200) + 'Correct the final row and try again.';
    render(
      <Notice tone="error" role="alert" title="Couldn’t load the statement" remedy={
        <Button type="button" variant="secondary" size="standard" onClick={retry}>Retry</Button>
      }>
        {diagnostic}
      </Notice>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(diagnostic);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('does not turn error-colored static context into an alert', () => {
    render(<Notice tone="error">Previously refused: unknown date format.</Notice>);
    expect(screen.getByText('Previously refused: unknown date format.')).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
