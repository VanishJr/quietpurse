import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BUDGETS } from '../test/fixtures';
import { fail, mockFetch, ok, renderThemed, requests, Routes } from '../test/harness';
import { BudgetsResponse } from '../types';
import { BudgetsBlock } from './BudgetsBlock';

/**
 * Item 16's third site. Mounted on its own rather than through Analytics: reaching it
 * that way would couple its failure case to Analytics' success case.
 *
 * PUT /api/budgets is an upsert with no 409, so a budget added over a list that was
 * never read replaces a limit the user was never shown. That is what "+ Add is
 * disabled" is for, and it is the only item in this row that stops data being lost.
 */

const HINT = /A per-category limit and a forecast/;

const ONE: BudgetsResponse = {
  baseCurrency: 'EUR',
  budgets: [{ category: 'food', monthly: 200, spent: 50, forecast: 150 }],
};

const BUDGET_ROUTES: Routes = { 'GET /api/budgets': () => ok(BUDGETS) };

const mount = () => renderThemed(<BudgetsBlock />);
const addControl = () => screen.getByRole('button', { name: '+ Add' });

describe('the budgets block', () => {
  it('renders the budgets it was given', async () => {
    // the mirror: without it every absence asserted below passes for free
    mockFetch({ ...BUDGET_ROUTES, 'GET /api/budgets': () => ok(ONE) });
    mount();

    expect(await screen.findByText('Food')).toBeInTheDocument();
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Error:/)).not.toBeInTheDocument();
  });

  it('offers the hint and the picker when the workspace really has no budgets', async () => {
    // the mirror for the two below: without it they would both pass against a block
    // whose + Add is disabled forever and whose hint never renders
    mockFetch(BUDGET_ROUTES);
    mount();

    expect(await screen.findByText(HINT)).toBeInTheDocument();
    expect(screen.queryByText(/^Error:/)).not.toBeInTheDocument();

    expect(addControl()).toBeEnabled();
    fireEvent.click(addControl());
    expect(await screen.findByRole('heading', { name: 'Budget for a category' })).toBeInTheDocument();
  });

  it('refuses to add a budget over a list it never read', async () => {
    mockFetch({
      ...BUDGET_ROUTES,
      'GET /api/budgets': () => fail(500, { error: 'the budgets could not be read' }),
    });
    mount();

    // anchor: the refusal, which exists only once the request came back
    expect(await screen.findByText(/the budgets could not be read/)).toBeInTheDocument();

    expect(addControl()).toBeDisabled();
    fireEvent.click(addControl());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // the invariant rather than a second independent guard: with + Add disabled the
    // write is unreachable, so this can only fail if the control comes back
    expect(requests()).not.toContain('PUT /api/budgets');
  });

  it('does not call the workspace budget-free when the request for them failed', async () => {
    // a pin, not a defect test: the gate carried `&& !error` before this row, so the
    // unfixed block passes this too. It is what stops the hint reappearing once that
    // boolean — which any handler could clear mid-request — is removed
    mockFetch({
      ...BUDGET_ROUTES,
      'GET /api/budgets': () => fail(500, { error: 'the budgets could not be read' }),
    });
    mount();

    expect(await screen.findByText(/the budgets could not be read/)).toBeInTheDocument();
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
  });
});
