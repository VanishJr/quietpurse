import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Hero } from './Hero';
import { Landing } from './Landing';
import { Opinions } from './Opinions';
import { Spending } from './Spending';

/**
 * The landing page, which until now had `threshold.ts` covered and nothing else —
 * the arithmetic was pinned and every control that drives it was not.
 *
 * These are shallow on purpose. The page is four demos and a footer, and what can
 * go wrong in it is a control that stops changing the thing it names, a readout
 * that stops agreeing with the switch above it, or a heading level that drifts.
 * jsdom cannot see any of the rest of it (no layout, no scroll-driven animation),
 * so nothing below pretends to.
 *
 * No fetch stub and no ThemeProvider: this page has neither, which is the point
 * of it — it stays up when the app does not.
 */

describe('the page', () => {
  it('has one h1, and the sections under it are h2', () => {
    render(<Landing />);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    // the h1 is the computed answer, not a slogan
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/You cover/);
    expect(screen.getAllByRole('heading', { level: 2 }).length).toBeGreaterThanOrEqual(3);
  });

  it('offers a way in from the top, the hero and the foot', () => {
    render(<Landing />);

    const open = screen.getAllByRole('link', { name: 'Open the app' });
    expect(open.length).toBeGreaterThanOrEqual(3);
    for (const link of open) expect(link).toHaveAttribute('href', '/');
  });

  it('names its landmarks', () => {
    render(<Landing />);

    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
  });
});

describe('the hero, which computes rather than claims', () => {
  const rate = () => screen.getByLabelText('An hour of your work is worth') as HTMLInputElement;

  it('rewrites the headline when the month changes', () => {
    render(<Hero />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('You cover 60%');

    // earn the whole month and the sentence changes kind, not just number
    fireEvent.change(screen.getByLabelText('You earn'), { target: { value: '2000' } });

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'You cover all of your month yourself.',
    );
  });

  it('states the shortfall in hours, and the hours follow the rate', () => {
    render(<Hero />);

    const atThirteen = screen.getByText(/hours/).textContent;
    fireEvent.change(rate(), { target: { value: '60' } });

    // the same shortfall over a bigger rate is fewer hours
    expect(screen.getByText(/hours/).textContent).not.toEqual(atThirteen);
  });

  it('changes the symbol and nothing else when the currency changes', () => {
    render(<Hero />);

    expect(screen.getByText(/A month costs €1,000/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: '$' }));

    // the amounts are the visitor's own numbers, so they are re-labelled and not
    // converted - a page that has read nothing has nothing to convert
    expect(screen.getByText(/A month costs \$1,000/)).toBeInTheDocument();
  });
});

describe('the two opinions', () => {
  it('flattens the rent chart when it is told to convert at today’s rate', () => {
    render(<Opinions />);

    expect(screen.getByText(/Six different amounts/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: "At today's rate" }));

    expect(screen.getByText(/Six identical amounts/)).toBeInTheDocument();
    expect(screen.queryByText(/Six different amounts/)).not.toBeInTheDocument();
  });

  it('moves the percentage when support is counted as income', () => {
    render(<Opinions />);

    const readout = () => screen.getByText('covered by what you earn').parentElement;
    expect(readout()).toHaveTextContent('60%');

    fireEvent.click(
      screen.getByRole('checkbox', { name: /Count help as income/ }),
    );

    expect(readout()).toHaveTextContent('90%');
  });
});

describe('the month, and the way into it that is not hover', () => {
  it('reads out a category when its legend row is focused', () => {
    render(<Spending />);

    const rent = screen.getByRole('button', { name: /Rent/ });
    fireEvent.focus(rent);

    // the readout in the hole is the announcement, so it is what has to change
    const ring = screen.getByText('42% of the month').parentElement;
    expect(within(ring as HTMLElement).getByText('Rent')).toBeInTheDocument();
  });

  it('pins a slice on click and lets go on a second one', () => {
    render(<Spending />);

    const rent = screen.getByRole('button', { name: /Rent/ });
    fireEvent.click(rent);
    expect(rent).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(rent);
    expect(rent).toHaveAttribute('aria-pressed', 'false');
  });
});
