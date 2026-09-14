import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BUDGETS } from '../test/fixtures';
import { fail, mockFetch, ok, renderThemed, requests, Routes } from '../test/harness';
import { Budget, BudgetsResponse } from '../types';
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

/**
 * The write path (ROADMAP row 75). The GET handler answers whatever the PUT handler
 * last wrote, so the row that appears after a save is the re-read being used and
 * not the fixture being served again; a handler that always answered the same body
 * would make every reload assertion below vacuous.
 */
interface Written {
  category: string;
  monthly: number | null;
}

const budgetServer = (initial: Budget[]) => {
  let list = initial;
  const puts: Written[] = [];
  const routes: Routes = {
    'GET /api/budgets': () => ok({ baseCurrency: 'EUR', budgets: list }),
    'PUT /api/budgets': (init) => {
      const sent = JSON.parse(String(init?.body)) as Written;
      puts.push(sent);
      const rest = list.filter((b) => b.category !== sent.category);
      list =
        sent.monthly === null
          ? rest
          : [...rest, { category: sent.category, monthly: sent.monthly, spent: 0, forecast: 0 }];
      return ok({ budgets: list.map(({ category, monthly }) => ({ category, monthly })) });
    },
  };
  return { routes, puts };
};

const amountInput = () => screen.getByPlaceholderText('Monthly limit, EUR');
const saveControl = () => screen.getByRole('button', { name: 'Save' });
const removeControl = () => screen.getByRole('button', { name: 'Remove' });
const formHeading = () => screen.queryByRole('heading', { name: 'Budget: Food' });

/** From the empty state to the amount form for Food, the way a person gets there. */
const openFoodForm = async () => {
  fireEvent.click(await screen.findByRole('button', { name: '+ Add' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Food' }));
  expect(formHeading()).toBeInTheDocument();
};

describe('saving a budget', () => {
  it('adds one from the empty state, and the list shows what the server now holds', async () => {
    const { routes, puts } = budgetServer([]);
    mockFetch(routes);
    mount();
    await openFoodForm();
    expect(saveControl()).toBeDisabled();

    fireEvent.change(amountInput(), { target: { value: '12,5' } });
    expect(saveControl()).toBeEnabled();
    fireEvent.click(saveControl());

    // the row is the re-read: the GET answers the list the PUT wrote
    expect(await screen.findByText('Food')).toBeInTheDocument();
    expect(puts).toEqual([{ category: 'food', monthly: 12.5 }]);
    // the button being back is the close; the heading gone alone is green on a
    // block that never rendered the form
    expect(formHeading()).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ Add' })).toBeEnabled();
  });

  it('opens an existing budget with its figure, and Remove sends null', async () => {
    const { routes, puts } = budgetServer(ONE.budgets);
    mockFetch(routes);
    mount();

    fireEvent.click(await screen.findByText('Food'));
    expect(formHeading()).toBeInTheDocument();
    expect(amountInput()).toHaveValue('200');
    fireEvent.click(removeControl());

    await waitFor(() => expect(puts).toEqual([{ category: 'food', monthly: null }]));
    // the hint is the re-read: it renders only over a list the server now answers empty
    expect(await screen.findByText(HINT)).toBeInTheDocument();
    expect(screen.queryByText('Food')).not.toBeInTheDocument();
  });

  it.each([['an empty amount', ''], ['zero', '0'], ['letters', 'abc']])(
    'cannot save %s',
    async (_what, typed) => {
      mockFetch(budgetServer([]).routes);
      mount();
      await openFoodForm();

      fireEvent.change(amountInput(), { target: { value: typed } });
      expect(saveControl()).toBeDisabled();
      expect(requests()).not.toContain('PUT /api/budgets');
    },
  );

  it('keeps the form and the typed amount when the save is refused', async () => {
    mockFetch({
      ...budgetServer([]).routes,
      'PUT /api/budgets': () => fail(500, { error: 'the budget could not be saved' }),
    });
    mount();
    await openFoodForm();
    fireEvent.change(amountInput(), { target: { value: '12,5' } });
    fireEvent.click(saveControl());

    expect(await screen.findByText(/the budget could not be saved/)).toBeInTheDocument();
    expect(formHeading()).toBeInTheDocument();
    expect(amountInput()).toHaveValue('12,5');
    expect(saveControl()).toBeEnabled();
    expect(removeControl()).toBeEnabled();
  });

  it('disables Save and Remove while the write is in flight', async () => {
    let release: (r: Response) => void = () => {};
    const { routes } = budgetServer([]);
    mockFetch({
      ...routes,
      'PUT /api/budgets': () => new Promise<Response>((resolve) => (release = resolve)),
    });
    mount();
    await openFoodForm();
    fireEvent.change(amountInput(), { target: { value: '12,5' } });
    fireEvent.click(saveControl());

    expect(saveControl()).toBeDisabled();
    expect(removeControl()).toBeDisabled();

    release(fail(500, { error: 'the budget could not be saved' }));
    await waitFor(() => expect(saveControl()).toBeEnabled());
    expect(removeControl()).toBeEnabled();
  });
});
