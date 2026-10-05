import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
import { Button } from './Button';
import { PageHeader } from './PageHeader';

describe('PageHeader', () => {
  it('keeps the actual return destination before title, context and action', () => {
    const { container } = render(
      <PageHeader title="Import history" context="Everyday · EUR"
        returnAction={<a href="?screen=settings">Back to Settings</a>}
        action={<Button type="button" variant="primary" size="standard">Import a statement</Button>} />,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Import history' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to Settings' })).toHaveAttribute('href', '?screen=settings');
    expect(screen.getByText('Everyday · EUR')).toBeVisible();
    const header = container.querySelector('header')!;
    expect(Array.from(header.children).map((child) => child.className)).toEqual([
      'page-header__return', 'page-header__identity', 'page-header__action',
    ]);
    expect(container.querySelector('.screen-inner')).toBeNull();
  });

  it('exposes a heading focus target without adding it to sequential tab order', () => {
    const ref = createRef<HTMLHeadingElement>();
    render(<PageHeader title="Goals" titleId="goals-title" titleRef={ref} />);
    const heading = screen.getByRole('heading', { name: 'Goals' });
    expect(ref.current).toBe(heading);
    expect(heading).toHaveAttribute('id', 'goals-title');
    expect(heading).toHaveAttribute('tabindex', '-1');
    ref.current!.focus();
    expect(heading).toHaveFocus();
  });

  it('does not manufacture return links or actions when omitted', () => {
    render(<PageHeader title="Settings" />);
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeVisible();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
