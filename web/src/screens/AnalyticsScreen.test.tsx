import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { render } from '@testing-library/react';
import { StrictMode } from 'react';
import { ThemeProvider } from '../theme';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHARTS_MAX } from '../analytics';
import { ACCOUNTS, accountMonths, accountSummary, SUMMARY } from '../test/fixtures';
import {
  askedFor,
  fail,
  mockFetch,
  ok,
  renderThemed,
  requests,
  requestUrls,
  Routes,
} from '../test/harness';
import { MonthlySummary, Summary } from '../types';
import { AnalyticsScreen } from './AnalyticsScreen';
import { ScreenShown } from '../screen';

/**
 * The workspace: it starts with nothing on it, the wizard is what puts something there,
 * and what it put there survives a remount — on the SERVER, which is
 * why `seed` below puts a list on a fake charts route rather than into localStorage.
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
  scope: 'all',
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

/**
 * The charts route as a workspace that actually remembers.
 *
 * The version moves on every accepted write and any other version is refused with the
 * current list, exactly as `replaceCharts` does. A fixture that answered 200 to
 * everything would make every case below about two devices vacuous — and this row's
 * worst defect is two of the reader's OWN clicks colliding, which needs a route that
 * can say no.
 */
let workspace: { version: number; charts: unknown[] } = { version: 0, charts: [] };

/** Every PUT body the screen composed, in order. The subject of most of the new cases. */
const puts: { version: number; charts: unknown[] }[] = [];

beforeEach(() => {
  workspace = { version: 0, charts: [] };
  puts.length = 0;
});

const sent = (init?: RequestInit): { version: number; charts: unknown[] } =>
  JSON.parse(String(init?.body)) as { version: number; charts: unknown[] };

const acceptPut = (init?: RequestInit): Response => {
  const body = sent(init);
  puts.push(body);
  if (body.version !== workspace.version)
    return fail(409, { error: 'changed elsewhere', ...workspace });
  workspace = { version: workspace.version + 1, charts: body.charts };
  return ok({ ...workspace });
};

const CHART_ROUTES: Routes = {
  'GET /api/analytics/charts': () => ok({ ...workspace }),
  'PUT /api/analytics/charts': acceptPut,
};

/**
 * The account arm of the same two endpoints, built around the id the request named.
 *
 * One route serves a workspace chart and a per-account one, because `keyOf` drops the
 * query string, and `askedFor` is what tells the two apart. A body about any OTHER
 * account is refused by api.ts, which is that check working rather than a hole here.
 *
 * The figures are not the workspace's, and `months` is not empty. Both matter: a card
 * drawing 4,000 and 1,200 would pass whichever arm answered it, and the fixture's
 * default of no months at all draws a full axis of zero ticks — which is exactly the
 * shape this row exists to remove.
 */
const accountMonthsBody = (url?: string) =>
  accountMonths(askedFor(url), {
    months: [{ month: thisMonth(), income: 2500, expense: 700, net: 1800 }],
  });

const accountSummaryBody = (url?: string) =>
  accountSummary(askedFor(url), {
    totals: { income: 2500, expense: 700 },
    byCategory: [{ category: 'food', total: 700 }],
    incomeByCategory: [{ category: 'salary', total: 2500 }],
  });

/** The screen reads the account list on mount, for every chart on it at once. */
const ROUTES: Routes = {
  'GET /api/accounts': () => ok(ACCOUNTS),
  'GET /api/summary/months': (_init, url) => ok(askedFor(url) ? accountMonthsBody(url) : MONTHS),
  'GET /api/summary': (_init, url) => ok(askedFor(url) ? accountSummaryBody(url) : SUMMARY),
  ...CHART_ROUTES,
};

const mount = () => renderThemed(<AnalyticsScreen />);

/**
 * The shape `main.tsx` really mounts: StrictMode at the ROOT, which is what makes React
 * double-invoke the effects under it. Nested inside another provider it does not, so a
 * case that wraps only the screen reports the condition it meant to arrange as absent.
 */
const mountStrict = () =>
  render(
    <StrictMode>
      <ThemeProvider>
        <AnalyticsScreen />
      </ThemeProvider>
    </StrictMode>,
  );

/**
 * A workspace the server already holds. The version is above zero because a real one
 * with charts on it has been written to — and because version 0 with an empty list is
 * the migration's trigger, which is a different fixture and has its own cases.
 */
const seed = (charts: unknown[], version = 3) => {
  workspace = { version, charts };
};

/** What this browser held back when the charts were this browser's. */
const seedLegacy = (charts: unknown[]) =>
  localStorage.setItem('finto.analytics.charts', JSON.stringify(charts));

const LEGACY_KEY = 'finto.analytics.charts';

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
  scope: 'all',
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

describe('shared data revisions', () => {
  it('reloads mounted chart data when income classification changes elsewhere', async () => {
    seed([COLUMN_CHART]);
    let reads = 0;
    mockFetch({
      ...ROUTES,
      'GET /api/summary/months': () => {
        reads++;
        return ok(MONTHS);
      },
    });
    const view = renderThemed(<AnalyticsScreen dataRevision={0} />);
    await waitFor(() => expect(reads).toBe(1));

    view.rerender(
      <ThemeProvider>
        <AnalyticsScreen dataRevision={1} />
      </ThemeProvider>,
    );
    await waitFor(() => expect(reads).toBe(2));
  });
});

describe('the empty workspace', () => {
  it('plots nothing and says so, rather than looking like a chart that failed', async () => {
    mockFetch(ROUTES);
    mount();

    expect(await screen.findByText('Nothing plotted yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Build your first chart' })).toBeInTheDocument();
    // the dock is there from the start: the way in is a control, not a blank screen
    expect(screen.getByRole('button', { name: /New chart/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Budgets' })).not.toBeInTheDocument();
    expect(screen.queryByText(/^Error:/)).not.toBeInTheDocument();
  });
});

describe('contextual workspace controls', () => {
  it('switches through the labeled selector while retaining foreign URL context', async () => {
    seed([chart('c-a', 'Groceries'), chart('c-b', 'Salary')]);
    window.history.replaceState({ foreign: true }, '', '/?screen=analytics&chart=c-a&foreign=keep#context');
    mockFetch(ROUTES);
    mount();
    await screen.findByRole('heading', { name: 'Groceries' });
    const selector = screen.getByRole('combobox', { name: 'Selected chart' });
    expect(selector).toHaveValue('c-a');
    fireEvent.change(selector, { target: { value: 'c-b' } });
    expect(await screen.findByRole('heading', { name: 'Salary' })).toBeInTheDocument();
    expect(selector).toHaveValue('c-b');
    expect(window.location.search).toContain('foreign=keep');
    expect(window.location.hash).toBe('#context');
    expect(puts).toHaveLength(0);
  });

  it('keeps account, period and response units beside a custom title', async () => {
    seed([{ ...COLUMN_CHART, accountId: 'acc-1', title: 'Custom question' }]);
    mockFetch({ ...ROUTES, 'GET /api/summary/months': (_init, url) => ok(accountMonths(askedFor(url), { currency: 'UAH' })) });
    mount();
    const card = await screen.findByRole('region', { name: 'Custom question' });
    expect(within(card).getByText('Scope: Sparkasse Giro')).toBeInTheDocument();
    expect(within(card).getByText(/^Period: 12 months/)).toHaveTextContent('Monthly totals');
    expect(await within(card).findByText('Units: UAH · Native account amounts')).toBeInTheDocument();
    expect(within(card).queryByText('Units: EUR')).not.toBeInTheDocument();
  });

  it('names a share breakdown even when the custom title hides the question', async () => {
    seed([{ ...COLUMN_CHART, kind: 'donut', breakdown: 'income-sources', title: 'My question' }]);
    mockFetch(ROUTES);
    mount();
    const card = await screen.findByRole('region', { name: 'My question' });
    expect(within(card).getByText(/^Period:/)).toHaveTextContent('Income by source');
    expect(await within(card).findByText('Units: EUR · Converted workspace amounts')).toBeVisible();
  });

  it.each(['column', 'radar'])('retains loaded request windows across rollover and a title-only %s edit', async (kind) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(2026, 0, 31, 12));
      seed([{ ...COLUMN_CHART, kind, range: '3m' }]);
      mockFetch(ROUTES);
      const { container } = mount();
      await screen.findByText(/^Units: EUR/);
      const oldPeriod = screen.getByText(/^Period:/).textContent;
      const oldComparison = screen.queryByText(/^Compared with:/)?.textContent;
      const oldTable = container.querySelector('.chart-card table')?.textContent;
      vi.setSystemTime(new Date(2026, 1, 1, 12));
      fireEvent.click(screen.getByRole('button', { name: 'Edit chart' }));
      fireEvent.change(screen.getByLabelText('Chart name'), { target: { value: 'Renamed after rollover' } });
      await waitFor(() => expect(within(screen.getByRole('dialog')).queryByText('Reading the numbers…')).not.toBeInTheDocument());
      const reads = requestUrls().length;
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await screen.findByRole('heading', { name: 'Renamed after rollover' });
      expect(screen.getByText(/^Period:/).textContent).toBe(oldPeriod);
      expect(screen.queryByText(/^Compared with:/)?.textContent).toBe(oldComparison);
      expect(container.querySelector('.chart-card table')?.textContent).toBe(oldTable?.replace('Spending, monthly', 'Renamed after rollover'));
      expect(requestUrls().length).toBe(reads + 1);
    } finally { vi.useRealTimers(); }
  });

  it('keeps optimistic editor closure visibly pending, then exposes recoverable refusal', async () => {
    seed([COLUMN_CHART]);
    let release!: (response: Response) => void;
    let refusing = true;
    const held = new Promise<Response>((resolve) => { release = resolve; });
    mockFetch({ ...ROUTES, 'PUT /api/analytics/charts': (init) => refusing ? held : acceptPut(init) });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit chart' }));
    fireEvent.change(screen.getByLabelText('Chart name'), { target: { value: 'My changed chart' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('Saving charts…')).toBeVisible();
    expect(screen.queryByText(/^Saved/)).not.toBeInTheDocument();
    await act(async () => release(fail(503, { error: 'temporary refusal' })));
    expect(await screen.findByText('Not saved: temporary refusal')).toBeVisible();
    expect(screen.queryByText('Saving charts…')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'My changed chart' })).toBeInTheDocument();
    refusing = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByText(/Not saved/)).not.toBeInTheDocument());
    expect(puts[0]).toMatchObject({ version: 3, charts: [expect.objectContaining({ title: 'My changed chart' })] });
  });

  it('confirms contextual deletion safely and restores a surviving action', async () => {
    seed([COLUMN_CHART]);
    mockFetch(ROUTES);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'More actions for Spending, monthly' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByRole('button', { name: 'Keep' })).toHaveFocus();
    expect(screen.getByText('Delete “Spending, monthly”?')).toBeVisible();
    expect(puts).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Nothing plotted yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New chart' })).toHaveFocus();
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

  it('restores direct-entry focus to the section when creating the first chart removes its opener', async () => {
    mockFetch(ROUTES);
    renderThemed(<div className="screen"><AnalyticsScreen /></div>);
    const heading = screen.getByRole('heading', { name: 'Analytics' });
    const opener = await screen.findByRole('button', { name: 'Build your first chart' });
    expect(heading).toHaveAttribute('tabindex', '-1');
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('button', { name: /^Line/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Create chart' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(opener).not.toBeInTheDocument();
    expect(heading).toHaveFocus();
    expect(puts).toHaveLength(1);
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
    expect(await screen.findByText('Expenses, total')).toBeInTheDocument();

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
    expect((await screen.findAllByText('1,200 EUR')).length).toBeGreaterThan(0);
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

  it('attaches selected-chart controls to its context without duplicating New chart', async () => {
    seed([COLUMN_CHART]);
    mockFetch(ROUTES);
    mount();
    const card = await screen.findByRole('region', { name: 'Spending, monthly' });
    expect(within(card).getByRole('button', { name: 'Edit chart' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'More actions for Spending, monthly' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'New chart' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
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

  /*
   * A row this version cannot draw — the shape a newer Quietpurse, or a hand-edited backup,
   * leaves on a list this one then opens. Dropping it was right while the list was one
   * browser's, and is a deletion from every device now that the list is the workspace's.
   */
  it('keeps a row it cannot read, says so, and carries it back out untouched', async () => {
    const NEWER = { id: 'c-two', kind: 'sunburst', range: '12m', title: 'Nope' };
    seed([COLUMN_CHART, NEWER]);
    mockFetch(ROUTES);
    mount();

    expect(await screen.findByRole('heading', { name: 'Spending, monthly' })).toBeInTheDocument();
    // it gets no tab, because there is nothing here that could draw it...
    expect(screen.queryByRole('button', { name: 'Nope' })).not.toBeInTheDocument();
    // ...and it is not silently absent either
    expect(screen.getByText(/newer version of Quietpurse/)).toBeInTheDocument();

    // the assertion the old policy could not make: the reader's next save takes it with
    // them, byte for byte and in the position it was in
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Spending, monthly' }));
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
    await waitFor(() => expect(puts).toHaveLength(1));

    expect(puts[0].charts[2]).toEqual(NEWER);
    expect(puts[0].charts).toHaveLength(3);
  });

  /*
   * The mirror of the case above, and the one row where "kept and named" is the wrong
   * answer. `analytics_charts.id` is notNull text with no CHECK, so a restored backup
   * puts an empty one in the table; the route then refuses it. Unreadable, it is sent
   * back exactly as it came and every save is refused with the whole list, for ever,
   * under a hint that is false on both halves. Readable, it is re-minted like any other
   * id the door would not take.
   */
  it('reads a chart whose id is empty, and re-mints it rather than bricking the list', async () => {
    seed([{ ...COLUMN_CHART, id: '' }]);
    mockFetch(ROUTES);
    mount();

    expect(await screen.findByRole('heading', { name: 'Spending, monthly' })).toBeInTheDocument();
    // not "made by a newer version of Quietpurse": this client can draw it, and saying it
    // cannot is the half of the old behaviour a reader would have seen
    expect(screen.queryByText(/newer version of Quietpurse/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Spending, monthly' }));
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
    await waitFor(() => expect(puts).toHaveLength(1));

    // what the route would have refused, and what it now gets instead
    expect(puts[0].charts[0]).toMatchObject({ title: 'Spending, monthly' });
    expect(String((puts[0].charts[0] as { id: unknown }).id)).toMatch(/^[A-Za-z0-9._~-]{1,64}$/);
    expect(await screen.findByText(/1 chart was given a new internal id/)).toBeInTheDocument();
  });
});

/**
 * A share chart in the one period that can make a card contradict itself: a refund
 * landing on a category whose purchase was in an earlier window leaves it below zero.
 *
 * A donut cannot draw that — a negative sector is not a thing — so the ring drops it,
 * and everything else on the card has to drop it too or the reader is given a total
 * that is a total of nothing on screen.
 *
 * Every case here and in the ranking describe below waits on a figure rather than on
 * the card's heading: the card prints its name while it is still reading, and it is
 * only mounted once the chart list has arrived from the server.
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
    ...CHART_ROUTES,
  };

  it('prints the total of what was drawn, and not of what was dropped', async () => {
    seed([DONUT]);
    mockFetch(SHARE_ROUTES);
    const { container } = mount();
    await screen.findByText('Total');

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
    await screen.findByText('Total');

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
    await screen.findByText('Total');

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
    mockFetch({
      'GET /api/accounts': () => ok(ACCOUNTS),
      'GET /api/summary': () => ok(REFUNDED),
      ...CHART_ROUTES,
    });
    const { container } = mount();
    await screen.findByText('Total');

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
    mockFetch({
      'GET /api/accounts': () => ok(ACCOUNTS),
      'GET /api/summary': () => ok(WHOLE),
      ...CHART_ROUTES,
    });
    mount();
    await screen.findByText('Total');

    // nothing is below zero, so every bar is part of the 800 and the figure means what
    // it says — a ranking is not silently a chart without percentages
    expect(figure('Total')).toBe('800 EUR');
    expect(figure('Largest, Food')).toBe('500 EUR · 63%');
  });
});

/**
 * The radar, which is the one kind that asks about two windows — and so the one that
 * has to ask twice, for one account exactly as for the workspace.
 *
 * `/api/summary` answers a split of the range it is given. Asked for both periods at
 * once it would add them together, and nothing on this side could take the earlier half
 * out again: every category's `before` would be its own `now`, and the polygon the
 * reader came for would be a period laid over itself.
 */
describe('a comparative chart of one account', () => {
  const RADAR = {
    ...COLUMN_CHART,
    id: 'c-radar',
    kind: 'radar',
    accountId: 'acc-1',
    title: 'This quarter against the last',
  };

  /** What the server answers for the window the chart is about, on either side of it. */
  const spent = (url: string | undefined, byCategory: { category: string; total: number }[]) =>
    accountSummary(askedFor(url), { byCategory });

  it('asks for a window at a time, so neither period is half of one answer', async () => {
    seed([RADAR]);
    mockFetch({
      'GET /api/accounts': () => ok(ACCOUNTS),
      'GET /api/summary': (_init, url) => ok(spent(url, [{ category: 'food', total: 500 }])),
      ...CHART_ROUTES,
    });
    mount();
    // the figures, and not the heading: a card prints its name while it is still
    // reading, so a heading is no evidence that anything was asked for
    await screen.findByText('Total');

    const windows = requestUrls()
      .filter((u) => u.includes('/api/summary?'))
      .map((u) => {
        const q = new URL(u.slice('GET '.length), 'http://x').searchParams;
        return { from: q.get('from') ?? '', to: q.get('to') ?? '' };
      })
      .sort((a, b) => a.from.localeCompare(b.from));

    expect(windows).toHaveLength(2);
    // and they do not overlap: the older one ends before the newer one starts, which is
    // what makes them two answers rather than one answer about both periods at once
    expect(windows[0].to < windows[1].from).toBe(true);
    expect(windows.every((w) => w.from !== '' && w.to !== '')).toBe(true);
  });

  it('keeps a refunded category off an axis built out of radii', async () => {
    seed([RADAR]);
    mockFetch({
      'GET /api/accounts': () => ok(ACCOUNTS),
      // food is spent; shopping is a refund with no purchase behind it in this window,
      // which the server answers as a category below zero
      'GET /api/summary': (_init, url) =>
        ok(
          spent(url, [
            { category: 'food', total: 500 },
            { category: 'shopping', total: -450 },
          ]),
        ),
      ...CHART_ROUTES,
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
 * A card about one account, which since this row reads the same two endpoints the
 * workspace arm does, with an `accountId` on them.
 *
 * What that changes is the UNIT and the SCOPE, and neither is something a reader can
 * check by looking: an account's own figures under the wrong currency code, and another
 * account's figures under this account's name, are both right-looking and wrong.
 */
describe('a chart about one account', () => {
  const PER_ACCOUNT = {
    ...COLUMN_CHART,
    id: 'c-one-account',
    accountId: 'acc-1',
    title: 'Sparkasse, monthly',
  };

  const DONUT = { ...PER_ACCOUNT, id: 'c-one-donut', kind: 'donut', title: 'Where it went' };

  it('prints the currency the body named, and not the one the accounts list holds', async () => {
    seed([PER_ACCOUNT]);
    mockFetch({
      ...ROUTES,
      // the account's code was corrected while this tab held the list it was read with:
      // the figures are the server's, and so is the unit they are in
      'GET /api/summary/months': (_init, url) =>
        ok(
          accountMonths(askedFor(url), {
            currency: 'USD',
            months: [{ month: thisMonth(), income: 2500, expense: 700, net: 1800 }],
          }),
        ),
    });
    mount();

    expect(await screen.findByText('Expenses, total')).toBeInTheDocument();
    expect(screen.getAllByText('700 USD').length).toBeGreaterThan(0);
    expect(screen.queryByText('700 EUR')).not.toBeInTheDocument();
  });

  it('prints the body’s currency on a share card too, and not the accounts list’s', async () => {
    seed([DONUT]);
    mockFetch({
      ...ROUTES,
      'GET /api/summary': (_init, url) =>
        ok(
          accountSummary(askedFor(url), {
            currency: 'USD',
            byCategory: [{ category: 'food', total: 700 }],
          }),
        ),
    });
    mount();

    await screen.findByText('Total');
    expect(screen.getAllByText('700 USD').length).toBeGreaterThan(0);
    expect(screen.queryByText('700 EUR')).not.toBeInTheDocument();
  });

  /*
   * A body of the right shape about the wrong account. `scoped` in api.ts throws on it,
   * which is the one thing between a query-builder edit that drops the `accountId` and
   * one account's card printing another account's money — and until this case nothing
   * anywhere looked at that throw.
   *
   * A donut and not the radar: one kind, one request, one message, so the assertion
   * cannot become order-dependent through `Promise.all`.
   */
  it('refuses a summary that came back about a different account', async () => {
    seed([DONUT]);
    mockFetch({
      ...ROUTES,
      'GET /api/summary': () =>
        ok(accountSummary('acc-2', { byCategory: [{ category: 'food', total: 700 }] })),
    });
    mount();

    expect(
      await screen.findByText(
        /the API answered a summary for account acc-2 where acc-1 was asked for/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('Total')).not.toBeInTheDocument();
    expect(screen.queryByText('700 EUR')).not.toBeInTheDocument();
  });

  /*
   * "By source" on one account used to fall through to income by category — one thing
   * drawn under a title naming another. The endpoint answers it per account,
   * filtered through `scopeSql` to that account's own rows. The wizard still
   * does not offer the choice (a product decision — see BREAKDOWNS), so a spec saved
   * before an account was picked is how the path is reached.
   */
  it('draws one account’s income by source, and not its income by category', async () => {
    seed([{ ...DONUT, id: 'c-by-source', breakdown: 'income-sources' }]);
    mockFetch({
      ...ROUTES,
      'GET /api/summary': (_init, url) =>
        ok(
          accountSummary(askedFor(url), {
            incomeByCategory: [{ category: 'salary', total: 2500 }],
            incomeBySource: [{ source: 'src-1', label: 'Acme GmbH', kind: 'own', total: 2500 }],
          }),
        ),
    });
    const { container } = mount();
    await screen.findByText('Total');

    const table = container.querySelector('table');
    expect(table?.textContent).toContain('Acme GmbH');
    expect(table?.textContent).not.toContain('Salary');
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
      'GET /api/summary/months': (_init, url) => ok(accountMonthsBody(url)),
      ...CHART_ROUTES,
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

    const menu = container.querySelector('.dock-menu') as HTMLElement;
    expect(menu.style.left).toBe('8px');
    expect(menu.style.top).toBe('8px');
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

  /*
   * Hidden is a workspace-level word. `VISIBLE_ACCOUNT()` keeps a hidden account out of
   * the workspace's totals and not out of its own, and `summaryScope` in `app.ts`
   * resolves one by id like any other — which is where that decision is written, and
   * where it is held: `backend/test/summary.test.ts`'s "a hidden account answers its
   * real numbers and contributes none of them to the workspace".
   *
   * In jsdom the server is a route table, so what this case can say is the client half
   * of it, and that is the half this row changed: the card asks about the account it was
   * pointed at, by id, and draws the answer instead of special-casing it into zeroes.
   */
  it('asks about it by id and draws what came back, hidden or not', async () => {
    seed([HIDDEN_ACCOUNT_CHART]);
    mockFetch(ROUTES);
    mount();

    expect(await screen.findByText('Expenses, total')).toBeInTheDocument();
    expect(screen.getAllByText('700 EUR').length).toBeGreaterThan(0);
    // the id rides in the query string, which is the one place a sent parameter shows:
    // `keyOf` drops it, so the route table cannot see it and `requestUrls` can
    expect(requestUrls().some((u) => u.includes('/api/summary/months?accountId=acc-2'))).toBe(
      true,
    );
    expect(screen.queryByText(/^Error:/)).not.toBeInTheDocument();
  });

  it('lights the chip for it anyway, and says why it is not one of the others', async () => {
    seed([HIDDEN_ACCOUNT_CHART]);
    mockFetch(ROUTES);
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
    // the chart list, not the account list: New chart is dead until the workspace has
    // been read, so a press before it lands would do nothing and prove nothing
    await screen.findByText('Nothing plotted yet');

    // opened while the ACCOUNT list is still in flight, which is ordinary: nothing
    // about the wizard waits for it
    fireEvent.click(screen.getByRole('button', { name: 'New chart' }));
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

/**
 * The three states a list that lives on a server has and a list in localStorage never
 * had: it has not arrived, it could not be read, and the last change was not saved.
 *
 * The first two are the Overview's old defect waiting to happen again — it gated
 * its empty state on `length === 0 && !loading` and told the reader their accounts did
 * not exist whenever the load failed. "Nothing plotted yet" is a claim about the
 * reader's workspace, and it may only be made about a list somebody actually read.
 */
describe('a workspace that has not been read yet', () => {
  it('claims nothing about it while the list is still in flight', async () => {
    let land = () => {};
    const landed = new Promise<void>((resolve) => {
      land = () => resolve();
    });
    mockFetch({
      ...ROUTES,
      'GET /api/analytics/charts': async () => {
        await landed;
        return ok({ version: 0, charts: [] });
      },
    });
    mount();

    expect(await screen.findByText('Reading your charts…')).toBeInTheDocument();
    expect(screen.queryByText('Nothing plotted yet')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Build your first chart' })).not.toBeInTheDocument();
    // and nothing may be added to a list nobody has read: a chart built here would be
    // saved at version 0 over whatever the workspace turns out to hold
    expect(screen.getByRole('button', { name: /New chart/ })).toBeDisabled();

    land();

    expect(await screen.findByText('Nothing plotted yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New chart/ })).toBeEnabled();
  });

  it('says the list could not be read, rather than that there is nothing on it', async () => {
    let calls = 0;
    mockFetch({
      ...ROUTES,
      'GET /api/analytics/charts': () =>
        calls++ === 0
          ? fail(500, { error: 'the charts could not be read' })
          : ok({ version: 2, charts: [chart('c-a', 'Groceries')] }),
    });
    mount();

    expect(await screen.findByText(/the charts could not be read/)).toBeInTheDocument();
    expect(screen.queryByText('Nothing plotted yet')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New chart/ })).toBeDisabled();

    // and never a fall back to what this browser happens to hold, which is a list the
    // reader would edit and then save at version 0 over the one they could not read
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('heading', { name: 'Groceries' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New chart/ })).toBeEnabled();
  });

  it('keeps the chart the reader arrived at, through a load that had not finished', async () => {
    seed([chart('c-a', 'Groceries'), chart('c-b', 'Salary'), chart('c-c', 'Rent')], 2);
    window.history.replaceState(null, '', '/?chart=c-b');
    mockFetch(ROUTES);
    mount();

    // the list is empty while the GET is out, so the fallback to charts[0] is READ and
    // never written: an arrival at a chart id must not be rewritten to the first chart
    expect(await screen.findByRole('heading', { name: 'Salary' })).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get('chart')).toBe('c-b');
  });
});

/**
 * The write path, which is the whole of what keeps two devices — or two of the reader's
 * own clicks — from overwriting each other.
 */
describe('what is sent, and when', () => {
  const numbered = (n: number) =>
    Array.from({ length: n }, (_, i) => chart(`c-${i}`, `Chart ${i}`));
  const FULL = `This workspace holds at most ${CHARTS_MAX} charts. Delete one to make room.`;

  it('sends nothing at all merely by being read', async () => {
    seed([chart('c-a', 'Groceries')], 4);
    mockFetch(ROUTES);
    mount();
    await screen.findByRole('heading', { name: 'Groceries' });
    await screen.findByText('Expenses, total');

    // the migration is a PUT fired by loading and it is not a contradiction of this:
    // it fires only for a workspace at version 0 with nothing on it, which this is not
    expect(callsTo('PUT /api/analytics/charts')).toBe(0);
    expect(puts).toEqual([]);
  });

  it('never has two writes out at once, so two of the reader’s own clicks cannot collide', async () => {
    seed([chart('c-a', 'Groceries'), chart('c-b', 'Salary')], 3);
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    let first = true;
    mockFetch({
      ...ROUTES,
      'PUT /api/analytics/charts': async (init) => {
        const wait = first;
        first = false;
        if (wait) await held;
        return acceptPut(init);
      },
    });
    mount();
    await screen.findByRole('heading', { name: 'Groceries' });

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Salary' }));
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
    await waitFor(() => expect(callsTo('PUT /api/analytics/charts')).toBe(1));

    // the second mutation is made WHILE the first write is out, which is the only
    // condition under which the version in the write path and the version in React
    // state differ — two mutations either side of a settled write prove nothing
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Groceries' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(callsTo('PUT /api/analytics/charts')).toBe(1);
    expect(screen.getByText('Saving charts…')).toBeVisible();
    expect(screen.queryByText(/^Saved/)).not.toBeInTheDocument();

    release();

    await waitFor(() => expect(puts).toHaveLength(2));
    // ascending and distinct: the second carries the version the FIRST one's answer
    // gave it, and not the one the screen was holding when the reader clicked
    expect(puts.map((p) => p.version)).toEqual([3, 4]);
    await waitFor(() => expect(screen.queryByText('Saving charts…')).not.toBeInTheDocument());
    expect(screen.queryByText(/changed somewhere else/)).not.toBeInTheDocument();
    // and the reader's second action survived, rather than being undone by a message
    // blaming another device
    expect(screen.queryByRole('button', { name: 'Groceries' })).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Salary (copy)' })).toBeInTheDocument();
  });

  it('settles optimistic writes while the owning screen is hidden', async () => {
    seed([COLUMN_CHART]);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    mockFetch({ ...ROUTES, 'PUT /api/analytics/charts': async (init) => { await held; return acceptPut(init); } });
    const content = (shown: boolean) => <ScreenShown.Provider value={shown}><div className="screen" hidden={!shown}><AnalyticsScreen /></div></ScreenShown.Provider>;
    const view = renderThemed(content(true));
    fireEvent.click(await screen.findByRole('button', { name: 'More actions for Spending, monthly' }));
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
    expect(screen.getByText('Saving charts…')).toBeVisible();
    view.rerender(<ThemeProvider>{content(false)}</ThemeProvider>);
    await act(async () => release());
    await waitFor(() => expect(puts).toHaveLength(1));
    view.rerender(<ThemeProvider>{content(true)}</ThemeProvider>);
    expect(screen.getByRole('heading', { name: 'Spending, monthly (copy)' })).toBeVisible();
    expect(screen.queryByText('Saving charts…')).not.toBeInTheDocument();
    expect(workspace.version).toBe(4);
  });

  it('drops queued intents on a stale refusal and never replays them as a retry', async () => {
    seed([chart('c-a', 'Groceries'), chart('c-b', 'Salary')], 3);
    let release!: (response: Response) => void;
    const held = new Promise<Response>((resolve) => { release = resolve; });
    mockFetch({ ...ROUTES, 'PUT /api/analytics/charts': () => held });
    mount();
    await screen.findByRole('heading', { name: 'Groceries' });
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Salary' }));
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Groceries' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    workspace = { version: 4, charts: [chart('c-server', 'Current server chart')] };
    await act(async () => release(fail(409, { error: 'changed elsewhere', ...workspace })));
    expect(await screen.findByText(/changed somewhere else/)).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Current server chart' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.queryByText('Saving charts…')).not.toBeInTheDocument();
    expect(callsTo('PUT /api/analytics/charts')).toBe(1);
  });

  it('goes on saving after a write failed in a way nothing planned for', async () => {
    seed([chart('c-a', 'Groceries'), chart('c-b', 'Salary')], 3);
    mockFetch({
      ...ROUTES,
      // 200, and a body that is not a chart list. The throw lands past every arm
      // written for a refusal, which is the arm that matters: a screen that leaves its
      // one-write-at-a-time latch set here shows the reader every later change and
      // sends none of them, with nothing on screen saying anything failed
      'PUT /api/analytics/charts': (init) => {
        puts.push(sent(init));
        return ok({ nothing: 'like a chart list' });
      },
    });
    mount();
    await screen.findByRole('heading', { name: 'Groceries' });

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Salary' }));
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
    await waitFor(() => expect(puts).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Groceries' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(puts).toHaveLength(2));
  });

  it('keeps the work on screen when a save did not land, and sends it again', async () => {
    seed([chart('c-a', 'Groceries')], 3);
    let down = true;
    mockFetch({
      ...ROUTES,
      'PUT /api/analytics/charts': (init) => {
        if (!down) return acceptPut(init);
        puts.push(sent(init));
        return fail(500, { error: 'the charts could not be saved' });
      },
    });
    mount();
    await screen.findByRole('heading', { name: 'Groceries' });

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Groceries' }));
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));

    expect(await screen.findByText(/Not saved: the charts could not be saved/)).toBeInTheDocument();
    // reverting would throw away work the reader can see and did not undo
    expect(screen.getByRole('button', { name: 'Groceries (copy)' })).toBeInTheDocument();

    down = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1].charts).toHaveLength(2);
    await waitFor(() => expect(screen.queryByText(/Not saved/)).not.toBeInTheDocument());
  });

  it('refuses to copy the first chart at the cap, rather than saving the copy in place of the list’s last chart', async () => {
    seed(
      Array.from({ length: 100 }, (_, i) => ({ ...COLUMN_CHART, id: `c-${i}`, title: `Chart ${i}` })),
      5,
    );
    mockFetch(ROUTES);
    mount();
    await screen.findByRole('heading', { name: 'Chart 0' });

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Chart 0' }));
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));

    // the copy goes in after its source and `normaliseForSave` keeps the head of the
    // list, so at the cap the save drops the list's last chart and keeps the copy: a
    // chart the reader did not ask to lose goes from the server, under a notice that
    // names no chart. Only when the source is last is it the copy that goes
    expect(await screen.findByText(/holds at most 100 charts/)).toBeInTheDocument();
    expect(puts).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Chart 0 (copy)' })).not.toBeInTheDocument();
  });

  it('refuses to build a chart past the cap: nothing is sent, and the reader stays where they were', async () => {
    seed(numbered(CHARTS_MAX));
    window.history.replaceState(null, '', '/?chart=c-7');
    mockFetch(ROUTES);
    mount();
    await screen.findByRole('heading', { name: 'Chart 7' });

    fireEvent.click(screen.getByRole('button', { name: 'New chart' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Column/ }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Create chart' }),
    );

    expect(await screen.findByText(FULL)).toBeInTheDocument();
    expect(callsTo('PUT /api/analytics/charts')).toBe(0);
    expect(new URLSearchParams(window.location.search).get('chart')).toBe('c-7');
    expect(screen.getByRole('heading', { name: 'Chart 7' })).toBeInTheDocument();
    expect(screen.queryByText(/could not be saved/)).not.toBeInTheDocument();
  });

  it('still saves an edit in a full workspace, since an edit adds nothing to the list', async () => {
    seed(numbered(CHARTS_MAX));
    mockFetch(ROUTES);
    mount();
    await screen.findByRole('heading', { name: 'Chart 0' });

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Chart 0' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Chart name'), { target: { value: 'Renamed' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('button', { name: 'Renamed' })).toBeInTheDocument();
    expect(callsTo('PUT /api/analytics/charts')).toBe(1);
    expect(puts[0].charts).toHaveLength(CHARTS_MAX);
    expect(puts[0].charts[0]).toMatchObject({ id: 'c-0', title: 'Renamed' });
    expect(screen.queryByText(FULL)).not.toBeInTheDocument();
  });

  it('builds the chart that fills the list to the cap', async () => {
    seed(numbered(CHARTS_MAX - 1));
    window.history.replaceState(null, '', '/?chart=c-7');
    mockFetch(ROUTES);
    mount();
    await screen.findByRole('heading', { name: 'Chart 7' });

    fireEvent.click(screen.getByRole('button', { name: 'New chart' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Column/ }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Create chart' }),
    );

    expect(
      await screen.findByRole('heading', { name: 'Expenses · 12 months' }),
    ).toBeInTheDocument();
    expect(callsTo('PUT /api/analytics/charts')).toBe(1);
    expect(puts[0].charts).toHaveLength(CHARTS_MAX);
    const built = puts[0].charts[CHARTS_MAX - 1] as { id: string; title: string };
    expect(built.title).toBe('Expenses · 12 months');
    expect(new URLSearchParams(window.location.search).get('chart')).toBe(built.id);
    expect(screen.queryByText(FULL)).not.toBeInTheDocument();
    expect(screen.queryByText(/could not be saved/)).not.toBeInTheDocument();
  });

  it('counts a row it cannot draw toward the cap', async () => {
    seed([
      ...numbered(CHARTS_MAX - 1),
      { id: 'c-newer', kind: 'sunburst', range: '12m', title: 'Nope' },
    ]);
    mockFetch(ROUTES);
    mount();
    await screen.findByRole('heading', { name: 'Chart 0' });

    fireEvent.click(screen.getByRole('button', { name: 'New chart' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Column/ }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Create chart' }),
    );

    expect(await screen.findByText(FULL)).toBeInTheDocument();
    expect(callsTo('PUT /api/analytics/charts')).toBe(0);
  });

  it('refuses to build a chart on a list already over the cap', async () => {
    seed(numbered(CHARTS_MAX + 1));
    window.history.replaceState(null, '', '/?chart=c-7');
    mockFetch(ROUTES);
    mount();
    await screen.findByRole('heading', { name: 'Chart 7' });

    fireEvent.click(screen.getByRole('button', { name: 'New chart' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Column/ }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Create chart' }),
    );

    expect(await screen.findByText(FULL)).toBeInTheDocument();
    expect(callsTo('PUT /api/analytics/charts')).toBe(0);
    expect(new URLSearchParams(window.location.search).get('chart')).toBe('c-7');
    expect(screen.queryByText(/could not be saved/)).not.toBeInTheDocument();
  });
});

/**
 * A refusal for staleness, which is the one failure where what is on screen is replaced
 * rather than kept. Re-applying the reader's change at the new version would resurrect
 * a chart another device deleted — the exact silent wrongness the version exists for.
 */
describe('a list changed on another device', () => {
  it('shows the workspace’s own list and says the change was not saved', async () => {
    seed([chart('c-a', 'Groceries')], 3);
    mockFetch({
      ...ROUTES,
      'PUT /api/analytics/charts': (init) => {
        puts.push(sent(init));
        // the other device got there first, and the route answers with what it holds
        return fail(409, { error: 'stale', version: 9, charts: [chart('c-z', 'Rent')] });
      },
    });
    mount();
    await screen.findByRole('heading', { name: 'Groceries' });

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Groceries' }));
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));

    expect(
      await screen.findByText(/changed somewhere else while you were working/),
    ).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Rent' })).toBeInTheDocument();
    // no merge, no re-apply — and no second attempt at the version the refusal carried
    expect(screen.queryByRole('button', { name: 'Groceries (copy)' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Groceries' })).not.toBeInTheDocument();
    await waitFor(() => expect(puts).toHaveLength(1));
  });
});

/**
 * The one-time move of what this browser was holding into the workspace, and the only
 * remaining read of `finto.analytics.charts` anywhere in the client.
 */
describe('the browser copy this workspace has never seen', () => {
  it('moves it to the server, then forgets it here', async () => {
    seedLegacy([COLUMN_CHART]);
    mockFetch(ROUTES);
    mount();

    expect(await screen.findByRole('heading', { name: 'Spending, monthly' })).toBeInTheDocument();
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ version: 0, charts: [COLUMN_CHART] });
    await waitFor(() => expect(localStorage.getItem(LEGACY_KEY)).toBeNull());
  });

  it('leaves the browser copy where it is when the write did not land', async () => {
    seedLegacy([COLUMN_CHART]);
    mockFetch({
      ...ROUTES,
      'PUT /api/analytics/charts': (init) => {
        puts.push(sent(init));
        return fail(500, { error: 'the charts could not be saved' });
      },
    });
    const first = mount();

    expect(await screen.findByText(/the charts could not be saved/)).toBeInTheDocument();
    expect(localStorage.getItem(LEGACY_KEY)).not.toBeNull();

    // ...so the next mount tries again, and this time it lands
    first.unmount();
    mockFetch(ROUTES);
    mount();

    await waitFor(() => expect(puts).toHaveLength(2));
    await waitFor(() => expect(localStorage.getItem(LEGACY_KEY)).toBeNull());
  });

  it('does not upload over a workspace somebody deliberately emptied', async () => {
    seedLegacy([COLUMN_CHART]);
    // no charts, but a version above zero: every chart was deleted, possibly on another
    // device, and uploading this browser's stale copy resurrects them
    seed([], 4);
    mockFetch(ROUTES);
    mount();

    expect(await screen.findByText('Nothing plotted yet')).toBeInTheDocument();
    expect(puts).toEqual([]);
    expect(localStorage.getItem(LEGACY_KEY)).not.toBeNull();
  });

  /*
   * The refusal is the one failure that ends the migration instead of deferring it: the
   * workspace has a version above zero now, so it cannot be the trigger again. What must
   * not happen is the browser's copy being thrown away later by a write that never
   * carried a byte of it — the reader would lose charts that reached no server at all.
   */
  it('keeps the browser copy after a refusal, and a later write does not take it', async () => {
    seedLegacy([{ ...COLUMN_CHART, title: 'x'.repeat(200) }]);
    let refused = false;
    mockFetch({
      ...ROUTES,
      'PUT /api/analytics/charts': (init) => {
        puts.push(sent(init));
        if (refused) return ok({ version: 10, charts: sent(init).charts });
        refused = true;
        // another device wrote while the migration was out
        return fail(409, { error: 'stale', version: 9, charts: [chart('c-z', 'Rent')] });
      },
    });
    mount();

    await screen.findByText(/changed somewhere else while you were working/);
    expect(localStorage.getItem(LEGACY_KEY)).not.toBeNull();
    // the shortening it announced was of the list that has just been thrown away
    expect(screen.queryByText(/shortened to the 120 characters/)).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Rent' }));
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));

    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1].version).toBe(9);
    expect(await screen.findByRole('button', { name: 'Rent (copy)' })).toBeInTheDocument();
    // the write that landed carried the other device's list, not this browser's
    expect(localStorage.getItem(LEGACY_KEY)).not.toBeNull();
  });
});

/**
 * What the browser copy can hold and the route will not take.
 *
 * `parseChart` accepts an unbounded title, a repeated measure, an id containing any
 * character and a list of any length; the route refuses all four, and it refuses the
 * WHOLE list. A migration answered 400 leaves the reader looking at a workspace that
 * will never save, for ever, over a chart they cannot see and did not create.
 *
 * Two assertions per bound and not one: a case AT the bound that goes through
 * untouched, beside the case above it that is cut. One of them alone pins a
 * relationship rather than a number.
 */
describe('a browser copy the route would refuse', () => {
  const migrated = async (stored: unknown[]): Promise<Record<string, unknown>[]> => {
    seedLegacy(stored);
    mockFetch(ROUTES);
    mount();
    await waitFor(() => expect(puts).toHaveLength(1));
    return puts[0].charts as Record<string, unknown>[];
  };

  it('sends a title at the bound whole and one above it cut to the bound', async () => {
    const at = 'a'.repeat(120);
    const charts = await migrated([
      { ...COLUMN_CHART, id: 'c-at', title: at },
      { ...COLUMN_CHART, id: 'c-over', title: 'b'.repeat(121) },
    ]);

    expect(charts[0].title).toBe(at);
    expect(charts[1].title).toBe('b'.repeat(120));
    // an edit this client makes to the reader's content is an edit they are told about
    expect(await screen.findByText(/shortened to the 120 characters/)).toBeInTheDocument();
  });

  it('sends an id at the bound whole and re-mints one above it', async () => {
    const at = 'c'.repeat(64);
    const charts = await migrated([
      { ...COLUMN_CHART, id: at },
      { ...COLUMN_CHART, id: 'd'.repeat(65) },
    ]);

    expect(charts[0].id).toBe(at);
    expect(charts[1].id).not.toBe('d'.repeat(65));
    expect(String(charts[1].id)).toMatch(/^[A-Za-z0-9._~-]{1,64}$/);
    // re-minted, never dropped: the id is opaque and only ?chart= reads it
    expect(charts[1].title).toBe('Spending, monthly');
  });

  it('re-mints an id the URL could not carry unescaped', async () => {
    const charts = await migrated([{ ...COLUMN_CHART, id: 'c one/two?three' }]);

    expect(charts).toHaveLength(1);
    expect(String(charts[0].id)).toMatch(/^[A-Za-z0-9._~-]+$/);
  });

  it('re-mints a repeated id, which the route refuses a whole list over', async () => {
    const charts = await migrated([chart('c-same', 'One'), chart('c-same', 'Two')]);

    expect(charts[0].id).toBe('c-same');
    expect(charts[1].id).not.toBe('c-same');
    expect(charts[1].title).toBe('Two');
  });

  it('drops a repeated measure and keeps the order of the rest', async () => {
    const charts = await migrated([
      { ...COLUMN_CHART, metrics: ['expense', 'expense', 'income'] },
    ]);

    expect(charts[0].metrics).toEqual(['expense', 'income']);
  });

  it('truncates an over-long accountId rather than nulling it', async () => {
    const charts = await migrated([{ ...COLUMN_CHART, accountId: 'e'.repeat(70) }]);

    // null is "every account together": one account's chart would become the whole
    // workspace's, under its old title
    expect(charts[0].accountId).toBe('e'.repeat(64));
  });

  it('sends a list at the cap whole', async () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      ...COLUMN_CHART,
      id: `c-${i}`,
      title: `Chart ${i}`,
    }));
    const charts = await migrated(many);

    expect(charts).toHaveLength(100);
    expect(screen.queryByText(/could not be saved/)).not.toBeInTheDocument();
  });

  it('sends the first hundred of a longer one and says how many it could not', async () => {
    const many = Array.from({ length: 101 }, (_, i) => ({
      ...COLUMN_CHART,
      id: `c-${i}`,
      title: `Chart ${i}`,
    }));
    const charts = await migrated(many);

    // the cap is the one place a chart is lost, and the reader is told
    expect(charts).toHaveLength(100);
    expect((charts[99] as { id: string }).id).toBe('c-99');
    expect(await screen.findByText(/1 chart could not be saved/)).toBeInTheDocument();
  });
});

/**
 * Two reads of the same list in flight at once, which is not hypothetical: `main.tsx`
 * wraps the app in `React.StrictMode`, and StrictMode double-invokes every effect in
 * development. Measured in a real browser on a check stack before it was held
 * here — the migration ran twice and the workspace took two writes for one move.
 *
 * The cost of the second one is not the extra request. It is that a later answer to an
 * EARLIER read carries the older version: committed, it lowers the version the write
 * path is holding, and the reader's next save is refused for staleness against a list
 * nobody else touched.
 */
describe('a second read of the same list', () => {
  it('migrates once and writes once, however many times the effect runs', async () => {
    seedLegacy([COLUMN_CHART]);
    mockFetch(ROUTES);
    mountStrict();

    expect(await screen.findByRole('heading', { name: 'Spending, monthly' })).toBeInTheDocument();
    await waitFor(() => expect(localStorage.getItem(LEGACY_KEY)).toBeNull());
    // the condition, asserted rather than assumed: the effect really did run twice
    await waitFor(() => expect(callsTo('GET /api/analytics/charts')).toBe(2));

    expect(puts).toHaveLength(1);
    expect(workspace.version).toBe(1);
  });

  /*
   * Two reads answering the same version prove nothing about this — the version cannot
   * be lowered to itself. The condition is a read ISSUED before a write and ANSWERED
   * after it, which is what the second effect run plus the migration compose all by
   * themselves, and it is arranged here rather than hoped for.
   */
  it('does not lower the version a write has already moved on', async () => {
    seedLegacy([COLUMN_CHART]);
    let release = () => {};
    const late = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    let reads = 0;
    mockFetch({
      ...ROUTES,
      'GET /api/analytics/charts': async () => {
        // what this read saw at the moment it was made, which is the whole point
        const answer = { ...workspace };
        if ((reads += 1) === 2) await late;
        return ok(answer);
      },
    });
    mountStrict();

    await waitFor(() => expect(puts).toHaveLength(1));
    expect(workspace.version).toBe(1);

    release();
    await screen.findByRole('heading', { name: 'Spending, monthly' });
    await waitFor(() => expect(reads).toBe(2));

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Spending, monthly' }));
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));

    await waitFor(() => expect(puts).toHaveLength(2));
    // 1, not the 0 the late answer was carrying: a refusal here would name another
    // device for a version this screen lowered itself
    expect(puts[1].version).toBe(1);
    expect(screen.queryByText(/changed somewhere else/)).not.toBeInTheDocument();
  });
});
