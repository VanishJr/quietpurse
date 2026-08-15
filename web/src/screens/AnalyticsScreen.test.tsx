import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNTS, BUDGETS } from '../test/fixtures';
import { fail, mockFetch, ok, renderThemed, requests, requestUrls, Routes } from '../test/harness';
import { MonthlySummary, Summary, Transaction } from '../types';
import { AnalyticsScreen } from './AnalyticsScreen';

/**
 * The workspace: it starts with nothing on it, the wizard is what puts something there,
 * and what it put there survives a remount.
 *
 * Nothing below asserts anything about a plot — not a sector, not a bar, not an axis.
 * recharts measures a 0x0 box in jsdom, so every assertion here is on the card's own
 * text: the title, the figures above the plot, and the table underneath it that carries
 * the same numbers for a reader who gets no SVG.
 *
 * The months payload is built from the clock rather than pinned, because the window a
 * chart asks for ends at the month the reader is in. A fixture dated 2026-08 would fall
 * outside the range the moment the calendar moved past it and every figure here would
 * quietly become 0 — passing, and about nothing.
 */

const thisMonth = (): string => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
};

const MONTHS: MonthlySummary = {
  from: '2026-01-01',
  to: '2026-12-31',
  baseCurrency: 'EUR',
  months: [
    {
      month: thisMonth(),
      expense: 1200,
      expenseOneOff: 0,
      income: 4000,
      incomeOwn: 4000,
      incomeExternal: 0,
    },
  ],
};

/** The screen reads the account list on mount, for every chart on it at once. */
const ROUTES: Routes = {
  'GET /api/accounts': () => ok(ACCOUNTS),
  'GET /api/summary/months': () => ok(MONTHS),
};

const mount = () => renderThemed(<AnalyticsScreen />);

/** A stored workspace, as `readCharts` will find it. */
const seed = (charts: unknown[]) =>
  localStorage.setItem('finto.analytics.charts', JSON.stringify(charts));

const COLUMN_CHART = {
  id: 'c-one',
  kind: 'column',
  title: 'Spending, monthly',
  accountId: null,
  metrics: ['expense'],
  breakdown: 'expense-categories',
  range: '12m',
};

/** The same chart under another id and name, for the tests that need a strip of them. */
const chart = (id: string, title: string) => ({ ...COLUMN_CHART, id, title });

/**
 * A period one refund has pushed a category below zero — the state the donut, the
 * figures above it and the table under it all have to agree about. Shopping is negative
 * because the purchase was in an earlier window and only the refund landed in this one.
 */
const REFUNDED: Summary = {
  from: '2026-01-01',
  to: '2026-12-31',
  baseCurrency: 'EUR',
  totals: { expense: 50, income: 0 },
  byCategory: [
    { category: 'food', total: 500 },
    { category: 'shopping', total: -450 },
  ],
  incomeByCategory: [],
  incomeBySource: [],
};

/** One `.chart-fig`, read as the reader sees it: its label, then what is under it. */
const figure = (label: string): string =>
  screen.getByText(label).parentElement?.querySelector('.chart-fig-value')?.textContent ?? '';

const callsTo = (route: string): number => requests().filter((r) => r === route).length;

describe('the empty workspace', () => {
  it('plots nothing and says so, rather than looking like a chart that failed', async () => {
    mockFetch(ROUTES);
    mount();

    expect(await screen.findByText('Nothing plotted yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Build your first chart' })).toBeInTheDocument();
    // the dock is there from the start: the way in is a control, not a blank screen
    expect(screen.getByRole('button', { name: /New chart/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Budgets' })).toBeInTheDocument();
    expect(screen.queryByText(/^Error:/)).not.toBeInTheDocument();
  });

  it('reaches the budgets block, which is a tab and not a chart', async () => {
    mockFetch({ ...ROUTES, 'GET /api/budgets': () => ok(BUDGETS) });
    mount();

    fireEvent.click(await screen.findByRole('button', { name: 'Budgets' }));

    expect(await screen.findByRole('heading', { name: 'Monthly budgets' })).toBeInTheDocument();
    expect(screen.queryByText('Nothing plotted yet')).not.toBeInTheDocument();
  });
});

describe('building a chart', () => {
  it('asks for the shape first and the subject second, and leaves a card behind', async () => {
    mockFetch(ROUTES);
    mount();

    fireEvent.click(await screen.findByRole('button', { name: 'Build your first chart' }));

    // step one: the shapes, and nothing about data yet
    expect(await screen.findByText('What shape?')).toBeInTheDocument();
    expect(screen.queryByText('What should it compare?')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Column/ }));

    // step two, with every default already answered — so "Create chart" is reachable
    expect(await screen.findByText('What should it compare?')).toBeInTheDocument();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Chart name')).toHaveValue('Expenses · 12 months');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Create chart' }));

    expect(
      await screen.findByRole('heading', { name: 'Expenses · 12 months' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Expenses, total')).toBeInTheDocument();
    // the figure above the plot and the row in the hidden table are the same number
    expect(screen.getAllByText('1,200 EUR').length).toBeGreaterThan(0);
    expect(screen.queryByText('Nothing plotted yet')).not.toBeInTheDocument();
  });

  it('lets every measure be turned off, and refuses to save what that leaves', async () => {
    mockFetch(ROUTES);
    mount();

    fireEvent.click(await screen.findByRole('button', { name: 'Build your first chart' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Line/ }));
    const dialog = await screen.findByRole('dialog');

    // the chips have no minimum: the last one off is an ordinary step on the way to a
    // different one, and a control that refuses to switch off has to be fought
    const expenses = within(dialog).getByRole('button', { name: 'Expenses' });
    expect(expenses).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(expenses);
    expect(expenses).toHaveAttribute('aria-pressed', 'false');

    // what IS refused is saving it, and the reason is under the chips it is about
    expect(within(dialog).getByText('Pick at least one.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Create chart' })).toBeDisabled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Income' }));

    expect(within(dialog).queryByText('Pick at least one.')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Create chart' })).toBeEnabled();
  });

  it('redraws the card in its new shape from the numbers already in hand', async () => {
    seed([COLUMN_CHART]);
    mockFetch(ROUTES);
    mount();
    await screen.findByRole('heading', { name: 'Spending, monthly' });
    expect(screen.getByText('Expenses, total')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Spending, monthly' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Change shape' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: /^Area/ }));
    await within(dialog).findByText('What should it compare?');

    // taken with the wizard still up, so what follows counts the card and nothing else
    const settled = callsTo('GET /api/summary/months');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    // a line, an area and a column are one payload under three names: the card is
    // redrawn from what it had rather than emptied to ask the same question again
    expect(screen.queryByText('Reading the numbers…')).not.toBeInTheDocument();
    expect(screen.getByText('Expenses, total')).toBeInTheDocument();
    expect(callsTo('GET /api/summary/months')).toBe(settled);
  });

  it('remembers it, so the workspace is not rebuilt on every visit', async () => {
    mockFetch(ROUTES);
    const first = mount();

    fireEvent.click(await screen.findByRole('button', { name: 'Build your first chart' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Line/ }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Create chart' }),
    );
    await screen.findByRole('heading', { name: 'Expenses · 12 months' });

    first.unmount();
    mount();

    expect(
      await screen.findByRole('heading', { name: 'Expenses · 12 months' }),
    ).toBeInTheDocument();
  });
});

describe('a chart that was already there', () => {
  it('draws what was stored, under the name it was given', async () => {
    seed([COLUMN_CHART]);
    mockFetch(ROUTES);
    mount();

    expect(await screen.findByRole('heading', { name: 'Spending, monthly' })).toBeInTheDocument();
    expect(screen.getAllByText('1,200 EUR').length).toBeGreaterThan(0);
    expect(screen.queryByText(/^Error:/)).not.toBeInTheDocument();
  });

  it('prints the refusal and no figures at all when the numbers could not be read', async () => {
    seed([COLUMN_CHART]);
    mockFetch({
      ...ROUTES,
      'GET /api/summary/months': () => fail(500, { error: 'the monthly breakdown is unavailable' }),
    });
    mount();

    // anchor: the refusal, which exists only once the request came back
    expect(await screen.findByText(/the monthly breakdown is unavailable/)).toBeInTheDocument();
    // the mirror of the test above — a total from a load that never landed is the
    // failure this card exists to avoid
    expect(screen.queryByText('Expenses, total')).not.toBeInTheDocument();
    expect(screen.queryByText('1,200 EUR')).not.toBeInTheDocument();
  });

  it('carries no controls of its own: they are on the tab, and there is one way in', async () => {
    seed([COLUMN_CHART]);
    mockFetch(ROUTES);
    mount();
    await screen.findByRole('heading', { name: 'Spending, monthly' });

    // the three pills that used to sit over the plot are behind the tab's ⋮
    for (const name of ['Edit', 'Duplicate', 'Delete']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    // ...and "New chart" is the dock's alone, not a second one beside the heading
    expect(screen.getAllByRole('button', { name: 'New chart' })).toHaveLength(1);
    // nothing to edit, duplicate or delete about the built-in view
    expect(screen.queryByRole('button', { name: 'Actions for Budgets' })).not.toBeInTheDocument();
  });

  it('edits the chart its own ⋮ belongs to', async () => {
    seed([COLUMN_CHART]);
    mockFetch(ROUTES);
    mount();

    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Spending, monthly' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    // straight to step two, on this chart rather than on a blank one
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('What should it compare?')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Chart name')).toHaveValue('Spending, monthly');
  });

  it('duplicates it under a name that says so, and shows the copy', async () => {
    seed([COLUMN_CHART]);
    mockFetch(ROUTES);
    mount();

    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Spending, monthly' }));
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));

    expect(
      await screen.findByRole('heading', { name: 'Spending, monthly (copy)' }),
    ).toBeInTheDocument();
    // the original is still on the strip beside it
    expect(screen.getByRole('button', { name: 'Spending, monthly' })).toBeInTheDocument();
  });

  it('deletes it only after asking, and empties the workspace when it was the last', async () => {
    seed([COLUMN_CHART]);
    mockFetch(ROUTES);
    mount();

    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Spending, monthly' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    // the first Delete asks; the chart is still there behind the question
    expect(screen.getByRole('button', { name: 'Keep' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Spending, monthly' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText('Nothing plotted yet')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Spending, monthly' })).not.toBeInTheDocument();
  });

  it('leaves the reader where they are when what was deleted is not what was showing', async () => {
    seed([chart('c-a', 'Groceries'), chart('c-b', 'Salary'), chart('c-c', 'Rent')]);
    // the URL is what says where the reader is, and here it says the last of the three
    window.history.replaceState(null, '', '/?chart=c-c');
    mockFetch(ROUTES);
    mount();
    await screen.findByRole('heading', { name: 'Rent' });

    // the ⋮ is on every tab, not only on the one being read: this is an edit to the
    // LIST, and the chart on screen has nothing to do with it. Deleting the FIRST is
    // what tells the two apart — its neighbour is a chart the reader was never on.
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Groceries' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(await screen.findByRole('heading', { name: 'Rent' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Salary' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Groceries' })).not.toBeInTheDocument();
  });

  it('moves to the neighbour when what was deleted IS what was showing', async () => {
    seed([chart('c-a', 'Groceries'), chart('c-b', 'Salary'), chart('c-c', 'Rent')]);
    window.history.replaceState(null, '', '/?chart=c-b');
    mockFetch(ROUTES);
    mount();
    await screen.findByRole('heading', { name: 'Salary' });

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Salary' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    // the one that took its place on the strip, and not back to the first chart
    expect(await screen.findByRole('heading', { name: 'Rent' })).toBeInTheDocument();
  });

  /* The mirror of the delete two cases up: an edit reaches the list through the same ⋮,
     from a tab the reader is as likely as not to be standing somewhere else from. */
  it('leaves the reader where they are when what was EDITED is not what was showing', async () => {
    seed([chart('c-a', 'Groceries'), chart('c-b', 'Salary'), chart('c-c', 'Rent')]);
    window.history.replaceState(null, '', '/?chart=c-c');
    mockFetch(ROUTES);
    mount();
    await screen.findByRole('heading', { name: 'Rent' });

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Groceries' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Chart name'), { target: { value: 'Food' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    // the rename landed on the strip, and the card is still the one being read
    expect(await screen.findByRole('button', { name: 'Food' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Rent' })).toBeInTheDocument();
  });

  it('keeps the stored charts it can read and drops only the row it cannot', async () => {
    // the shape a hand-edited store, or an older version of this app, can leave behind
    seed([COLUMN_CHART, { id: 'c-two', kind: 'sunburst', range: '12m', title: 'Nope' }]);
    mockFetch(ROUTES);
    mount();

    expect(await screen.findByRole('heading', { name: 'Spending, monthly' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nope' })).not.toBeInTheDocument();
  });
});

/**
 * A share chart in the one period that can make a card contradict itself: a refund
 * landing on a category whose purchase was in an earlier window leaves it below zero.
 *
 * A donut cannot draw that — a negative sector is not a thing — so the ring drops it,
 * and everything else on the card has to drop it too or the reader is given a total
 * that is a total of nothing on screen.
 */
describe('a period one category has gone negative in', () => {
  const DONUT = {
    ...COLUMN_CHART,
    id: 'c-donut',
    kind: 'donut',
    title: 'Where it went',
  };

  const SHARE_ROUTES: Routes = {
    'GET /api/accounts': () => ok(ACCOUNTS),
    'GET /api/summary': () => ok(REFUNDED),
  };

  it('prints the total of what was drawn, and not of what was dropped', async () => {
    seed([DONUT]);
    mockFetch(SHARE_ROUTES);
    const { container } = mount();
    await screen.findByRole('heading', { name: 'Where it went' });

    // 500, not 500 + (−450): the figure above the plot and the figure in the middle of
    // the ring are the same number, because they are the same sum over the same slices
    expect(figure('Total')).toBe('500 EUR');
    expect(container.querySelector('.donut-value')?.textContent).toBe('500');
    // ...which is what keeps a part from being larger than the whole it is part of
    expect(figure('Largest, Food')).toBe('500 EUR · 100%');
    expect(screen.queryByText(/1000%/)).not.toBeInTheDocument();
  });

  it('stands the same rows in for the ring rather than a set only one reader gets', async () => {
    seed([DONUT]);
    mockFetch(SHARE_ROUTES);
    const { container } = mount();
    await screen.findByRole('heading', { name: 'Where it went' });

    // the ring and the total painted over it are one drawing, hidden as one piece: the
    // table below is what stands in for both, and announcing them reads it out twice
    expect(container.querySelector('.chart-wrap')).toHaveAttribute('aria-hidden', 'true');

    const table = container.querySelector('table');
    expect(table?.textContent).toContain('Food');
    expect(table?.textContent).not.toContain('Shopping');
  });

  it('names the sectors on screen, where the ring is only colours', async () => {
    seed([DONUT]);
    mockFetch(SHARE_ROUTES);
    const { container } = mount();
    await screen.findByRole('heading', { name: 'Where it went' });

    // the hidden table is for the reader who gets no plot; a reader looking straight at
    // the ring needs the same names, and on a phone there is no hover to reach the
    // tooltip with
    const legend = container.querySelector('.chart-legend');
    expect(legend).toBeInTheDocument();
    expect(legend).toHaveTextContent('Food');
    // and it is a key to what was DRAWN: the dropped category has no wedge to point at
    expect(legend).not.toHaveTextContent('Shopping');
  });
});

/**
 * The ranking, which is the one kind that KEEPS what the donut drops — it has a baseline
 * and can draw a bar below it.
 *
 * Which makes its total a different kind of number: a net rather than a whole. The card
 * above it prints "Largest" as a share of that total, and a gross positive over a net is
 * where 1000% comes from — the same failure the donut was fixed for, on the one path the
 * fix did not reach.
 */
describe('the ranking, which draws the bars a donut cannot', () => {
  const RANKING = {
    ...COLUMN_CHART,
    id: 'c-rank',
    kind: 'ranking',
    title: 'Biggest first',
  };

  /** The same period, with nothing refunded: every part is a part of the total. */
  const WHOLE: Summary = {
    ...REFUNDED,
    byCategory: [
      { category: 'food', total: 500 },
      { category: 'shopping', total: 300 },
    ],
  };

  it('says nothing about the share when the total it would divide by is a net', async () => {
    seed([RANKING]);
    mockFetch({ 'GET /api/accounts': () => ok(ACCOUNTS), 'GET /api/summary': () => ok(REFUNDED) });
    const { container } = mount();
    await screen.findByRole('heading', { name: 'Biggest first' });

    // the refunded bar is drawn here, which is what makes 50 the honest total...
    expect(container.querySelector('table')?.textContent).toContain('Shopping');
    expect(figure('Total')).toBe('50 EUR');
    // ...and what makes 500 not a share of it. Both figures, and no percentage at all
    expect(figure('Largest, Food')).toBe('500 EUR');
    expect(container.querySelector('.chart-fig-pct')).toBeNull();
    expect(screen.queryByText(/1000%/)).not.toBeInTheDocument();
  });

  it('still divides by the total when the total really is the whole', async () => {
    seed([RANKING]);
    mockFetch({ 'GET /api/accounts': () => ok(ACCOUNTS), 'GET /api/summary': () => ok(WHOLE) });
    mount();
    await screen.findByRole('heading', { name: 'Biggest first' });

    // nothing is below zero, so every bar is part of the 800 and the figure means what
    // it says — a ranking is not silently a chart without percentages
    expect(figure('Total')).toBe('800 EUR');
    expect(figure('Largest, Food')).toBe('500 EUR · 63%');
  });
});

/**
 * The radar, which is the one kind that asks about two windows — and, on one account,
 * the one that has to ask twice.
 *
 * A single fetch across both is twice the window under one row cap: whichever half the
 * server's limit cut, the two periods still came back looking complete, and a prior
 * window emptied by truncation draws as "everything doubled".
 */
describe('a comparative chart of one account', () => {
  const RADAR = {
    ...COLUMN_CHART,
    id: 'c-radar',
    kind: 'radar',
    accountId: 'acc-1',
    title: 'This quarter against the last',
  };

  /** Spent in the window the chart is about — dated today, so it lands in it. */
  const tx = (id: string, category: string, amount: number, refund = false): Transaction => ({
    id,
    accountId: 'acc-1',
    provider: 'upload',
    amount,
    currency: 'EUR',
    date: new Date().toISOString().slice(0, 10),
    description: id,
    category,
    transfer: false,
    transferManual: null,
    refund,
  });

  it('asks for a window at a time, so one cap cannot empty the other', async () => {
    seed([RADAR]);
    mockFetch({
      'GET /api/accounts': () => ok(ACCOUNTS),
      'GET /api/transactions': () => ok([tx('t1', 'food', -500)]),
    });
    mount();
    // the figures, and not the heading: a card prints its name while it is still
    // reading, so a heading is no evidence that anything was asked for
    await screen.findByText('Total');

    const windows = requestUrls()
      .filter((u) => u.includes('/api/transactions'))
      .map((u) => {
        const q = new URL(u.slice('GET '.length), 'http://x').searchParams;
        return { from: q.get('from') ?? '', to: q.get('to') ?? '' };
      })
      .sort((a, b) => a.from.localeCompare(b.from));

    expect(windows).toHaveLength(2);
    // and they do not overlap: the older one ends before the newer one starts, which is
    // what makes two caps two answers rather than one answer cut in an unknown place
    expect(windows[0].to < windows[1].from).toBe(true);
    expect(windows.every((w) => w.from !== '' && w.to !== '')).toBe(true);
  });

  it('keeps a refunded category off an axis built out of radii', async () => {
    seed([RADAR]);
    mockFetch({
      'GET /api/accounts': () => ok(ACCOUNTS),
      // food is spent, shopping is a refund with no purchase behind it in this window
      'GET /api/transactions': () =>
        ok([tx('t1', 'food', -500), tx('t2', 'shopping', 450, true)]),
    });
    const { container } = mount();
    await screen.findByText('Total');

    // a negative radius is drawn mirrored through the centre — a self-crossing polygon
    // reading as a larger value pointing the wrong way. The table stands in for the
    // plot, so what the plot cannot draw is not in it either.
    const table = container.querySelector('table');
    expect(table?.textContent).toContain('Food');
    expect(table?.textContent).not.toContain('Shopping');
  });
});

/**
 * The account list is read once for the whole screen, so a failure there is not one
 * card's problem — it is every per-account card's, at once and for as long as the
 * screen is mounted.
 */
describe('when the account list cannot be read', () => {
  const PER_ACCOUNT = {
    ...COLUMN_CHART,
    id: 'c-acct',
    accountId: 'acc-1',
    title: 'Sparkasse, monthly',
  };

  it('says so on the card instead of leaving it reading the numbers forever', async () => {
    seed([PER_ACCOUNT]);
    let calls = 0;
    mockFetch({
      'GET /api/accounts': () =>
        calls++ === 0 ? fail(500, { error: 'the account list is unavailable' }) : ok(ACCOUNTS),
      'GET /api/transactions': () => ok([]),
    });
    mount();

    // the card's own words, and not the refusal next door to them: "that account is no
    // longer here" would name a cause that is not this one
    expect(await screen.findByText(/The account list could not be read/)).toBeInTheDocument();
    expect(screen.queryByText('Reading the numbers…')).not.toBeInTheDocument();
    expect(screen.queryByText(/no longer here/)).not.toBeInTheDocument();

    // and a way out that is a step rather than a reload of the whole workspace
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Expenses, total')).toBeInTheDocument();
    expect(screen.queryByText(/could not be read/)).not.toBeInTheDocument();
  });
});

/**
 * Where the keyboard is left, which is a question a pointer never asks: the popover
 * unmounts on every action, and an unmounted anchor drops focus on `<body>` — the top of
 * the document, a whole screen away from the strip that was just used.
 */
describe('the keyboard, after the popover has acted', () => {
  it('goes back to the ⋮ it came from when that ⋮ is still there', async () => {
    seed([chart('c-a', 'Groceries'), chart('c-b', 'Salary')]);
    mockFetch(ROUTES);
    mount();
    await screen.findByRole('heading', { name: 'Groceries' });

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Salary' }));
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));

    await screen.findByRole('heading', { name: 'Salary (copy)' });
    expect(screen.getByRole('button', { name: 'Actions for Salary' })).toHaveFocus();
  });

  it('goes to the one control a delete cannot take with it', async () => {
    seed([chart('c-a', 'Groceries'), chart('c-b', 'Salary')]);
    mockFetch(ROUTES);
    mount();
    await screen.findByRole('heading', { name: 'Groceries' });

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Salary' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Salary' })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'New chart' })).toHaveFocus();
  });

  /* The confirmation replaces the menu it was asked from, so the Delete that was holding
     the keyboard is unmounted by the very press that asks the question. */
  it('moves onto the question rather than off the end of the document', async () => {
    seed([chart('c-a', 'Groceries')]);
    mockFetch(ROUTES);
    mount();
    await screen.findByRole('heading', { name: 'Groceries' });

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Groceries' }));
    // opening puts the keyboard on the menu's first item
    expect(screen.getByRole('button', { name: 'Edit' })).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    // Keep is the first control of what replaced it, and the safe half of the answer
    expect(screen.getByRole('button', { name: 'Keep' })).toHaveFocus();
  });
});

/**
 * Where the popover is PUT, which jsdom can be asked about even though it applies no
 * layout: every box it measures is at 0 by 0, which is exactly the geometry the clamp
 * exists for — a ⋮ hard against the left edge of a narrow window.
 */
describe('a popover under a tab at the edge of the screen', () => {
  const WIDE = window.innerWidth;
  afterEach(() => {
    window.innerWidth = WIDE;
  });

  it('is held on screen rather than hung off the left of it', async () => {
    seed([chart('c-a', 'A')]);
    mockFetch(ROUTES);
    const { container } = mount();
    await screen.findByRole('heading', { name: 'A' });

    window.innerWidth = 360;
    fireEvent.click(screen.getByRole('button', { name: 'Actions for A' }));

    // hung from the button's own edge it would be 360px in from the right, which puts
    // the left edge of a 176px menu at −176 with no way to scroll to it
    const menu = container.querySelector('.dock-menu') as HTMLElement;
    expect(menu.style.right).toBe('176px');
  });
});

/**
 * The wizard's "Account" question, which is answered from a list a hidden account is
 * deliberately not in — and which one chart is nonetheless about.
 */
describe('a chart pointed at an account that has since been hidden', () => {
  const HIDDEN_ACCOUNT_CHART = {
    ...COLUMN_CHART,
    id: 'c-hidden',
    accountId: 'acc-2',
    title: 'Old DKB, monthly',
  };

  it('lights the chip for it anyway, and says why it is not one of the others', async () => {
    seed([HIDDEN_ACCOUNT_CHART]);
    mockFetch({ ...ROUTES, 'GET /api/transactions': () => ok([]) });
    mount();

    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Old DKB, monthly' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');

    // filtered out of the choices AND out of its own chart's editor, the question was
    // left with nothing lit at all — under a name box still reading the account's name
    expect(within(dialog).getByRole('button', { name: 'Old DKB (hidden)' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(dialog).getByRole('button', { name: 'All accounts' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('still keeps it out of the choices for a chart that is not about it', async () => {
    mockFetch(ROUTES);
    mount();

    fireEvent.click(await screen.findByRole('button', { name: 'Build your first chart' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Column/ }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByRole('button', { name: 'Sparkasse Giro' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /Old DKB/ })).not.toBeInTheDocument();
  });
});

/**
 * The sheet moves the keyboard onto its card when it opens, which is right once and
 * wrong every time after: the wizard is the first sheet in this app with a text box in
 * it, and the screen behind it goes on rendering while the reader types.
 */
describe('typing a name while the screen behind the dialog is still loading', () => {
  it('keeps the caret in the box when the account list lands', async () => {
    let land = () => {};
    const landed = new Promise<void>((resolve) => {
      land = () => resolve();
    });
    mockFetch({
      ...ROUTES,
      'GET /api/accounts': async () => {
        await landed;
        return ok(ACCOUNTS);
      },
    });
    mount();

    // opened while the list is still in flight, which is ordinary: nothing about the
    // wizard waits for it
    fireEvent.click(await screen.findByRole('button', { name: 'New chart' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Column/ }));
    const name = within(await screen.findByRole('dialog')).getByLabelText('Chart name');
    name.focus();
    fireEvent.change(name, { target: { value: 'Groc' } });
    expect(name).toHaveFocus();

    land();
    // the chips filling in are the proof the screen re-rendered underneath the sheet
    await screen.findByRole('button', { name: 'Sparkasse Giro' });

    expect(name).toHaveFocus();
    expect(name).toHaveValue('Groc');
  });
});

/**
 * The arrows, which are about a measurement jsdom does not have: it applies no layout,
 * so `.dock-tabs` reports 0 by 0 whatever is inside it and would never overflow.
 *
 * So the measurement is faked and only the DECISIONS made from it are asserted — which
 * arrows appear, which are dead at which end, and what a press asks the strip to do.
 * Whether five real tabs actually run off a real row is not a question this project can
 * answer; that one was checked in a browser.
 */
describe('moving along a strip too long for the row', () => {
  const scrollBy = vi.fn();

  /** A row `across` px of names wide, seen through a window `window` px wide. */
  const layout = (across: number, window: number) => {
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(across);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(window);
    // jsdom implements neither of these, which is why the component optional-calls them
    HTMLElement.prototype.scrollBy = scrollBy;
    HTMLElement.prototype.scrollIntoView = vi.fn();
  };

  afterEach(() => {
    vi.restoreAllMocks();
    scrollBy.mockReset();
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollBy;
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  });

  const SIX = Array.from({ length: 6 }, (_, i) => ({
    ...COLUMN_CHART,
    id: `c-${i}`,
    title: `Chart number ${i + 1}`,
  }));

  it('has none at all while every tab fits', async () => {
    seed(SIX);
    layout(300, 300);
    mockFetch(ROUTES);
    mount();
    await screen.findByRole('heading', { name: 'Chart number 1' });

    expect(screen.queryByRole('button', { name: 'Next charts' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Previous charts' })).not.toBeInTheDocument();
  });

  it('offers both once it does not, with the one that cannot move dead', async () => {
    seed(SIX);
    layout(900, 300);
    mockFetch(ROUTES);
    mount();

    const next = await screen.findByRole('button', { name: 'Next charts' });
    // the strip starts at the left, so there is nothing behind it yet
    expect(screen.getByRole('button', { name: 'Previous charts' })).toBeDisabled();
    expect(next).toBeEnabled();

    fireEvent.click(next);

    // most of the visible row, not all of it — see NUDGE_FRACTION
    expect(scrollBy).toHaveBeenCalledWith({ left: 240 });
  });
});
