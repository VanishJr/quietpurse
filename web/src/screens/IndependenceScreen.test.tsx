import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { INDEPENDENCE } from '../test/fixtures';
import { fail, mockFetch, ok, renderThemed, requests, Routes } from '../test/harness';
import { BaselineItem, Independence, IncomeSourceDef, IndependenceMonth, Settings } from '../types';
import { IndependenceScreen } from './IndependenceScreen';

/**
 * The Goal screen's first test file.
 *
 * The arithmetic is the backend's and the month bars are
 * `web/src/independence.ts`' — recharts measures a 0x0 box in jsdom, so nothing here
 * asserts anything about the chart.
 *
 * Every string asserted is a literal typed out here. Interpolating the component's own
 * expression would pass whatever that expression became, which is the shape the charts
 * route's length bounds are filed under.
 */

const month = (over: Partial<IndependenceMonth> = {}): IndependenceMonth => ({
  month: '2026-06',
  spend: 1000,
  ownIncome: 900,
  external: 0,
  ...over,
});

/**
 * A typed `Independence`, never an inline literal: the row this file arrives with adds
 * a required field, and a value of the declared type keeps that narrowing a no-op here
 * instead of an excess-property error whose cheapest fix is loosening the shipped type.
 */
const body = (patch: Partial<Independence> = {}, settings: Partial<Settings> = {}): Independence => ({
  ...INDEPENDENCE,
  ...patch,
  settings: { ...INDEPENDENCE.settings, ...settings },
});

/** Baseline asked for, no line items entered: the state every new workspace is in. */
const FELL_BACK = body(
  {
    baselineSum: 0,
    baselineItems: [],
    baselineThreshold: 0,
    effectiveMode: 'lifestyle',
    threshold: 1100,
    months: [month()],
  },
  { goalMode: 'baseline' },
);

/**
 * A catalog of this file's own: the shared fixture is `[]` and is served to every dom
 * test through FIRST_PAINT_ROUTES, so changing it changes what App.test.tsx and
 * TransactionsScreen.test.tsx render for no gain here.
 */
const SOURCES: IncomeSourceDef[] = [
  { id: 'salary', label: 'Salary', kind: 'own', patterns: [], sort: 0, builtin: true },
  { id: 'family', label: 'Support', kind: 'external', patterns: [], sort: 1, builtin: true },
  { id: 'other', label: 'Other', kind: 'own', patterns: [], sort: 2, builtin: true },
];

const goalRoutes = (data: Independence, extra: Routes = {}): Routes => ({
  'GET /api/independence': () => ok(data),
  // the income sources block mounts with the screen and asks for its own list -
  // without this every case in this file reds on setup.ts's unmatched-request guard
  'GET /api/income-sources': () => ok(SOURCES),
  ...extra,
});

const mount = async (data: Independence, extra: Routes = {}) => {
  mockFetch(goalRoutes(data, extra));
  renderThemed(<IndependenceScreen />);
  await screen.findByRole('heading', { name: 'Goal', level: 1 });
};

describe('the Goal screen', () => {
  it('asks for the goal body and the income sources and nothing else', async () => {
    await mount(INDEPENDENCE);
    await screen.findByText(/self-sufficiency/);
    // an exact list and not a toContain: the claim is `nothing else`, and a
    // membership check would delete it
    expect(requests()).toEqual(['GET /api/independence', 'GET /api/income-sources']);
  });

  it('reads the mode off the body rather than working it out from the numbers', async () => {
    await mount(
      body(
        {
          baselineSum: 0,
          baselineItems: [],
          effectiveMode: 'baseline',
          months: [month()],
        },
        { goalMode: 'baseline' },
      ),
    );

    expect(await screen.findByText('To cover your minimum, you need to earn')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'What if you trim the minimum?' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('To live without support the way you do now, you need to earn')).toBeNull();
  });

  it('puts the minimum on the mode that was asked for, not the one that answered', async () => {
    await mount(FELL_BACK);

    expect(
      await screen.findByRole('heading', { name: 'What the minimum is made of (per month)' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('To live without support the way you do now, you need to earn'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Nothing here yet\. Add what it takes to live on your own/),
    ).toBeInTheDocument();
    expect(screen.queryByText('Total')).toBeNull();
    // the fallback is the only state that renders both legends, so this one assertion
    // separates "which mode answered" from "which mode was asked for"
    expect(
      screen.getByRole('heading', { name: 'What the threshold is made of (per month)' }),
    ).toBeInTheDocument();
  });

  it('creates the first line item from an empty minimum', async () => {
    const puts: unknown[] = [];
    await mount(FELL_BACK, {
      'PUT /api/baseline': (init) => {
        puts.push(JSON.parse(String(init?.body)));
        return ok({ baseCurrency: 'EUR', items: [], total: 0 });
      },
    });

    fireEvent.click(await screen.findByRole('button', { name: '+ Add line item' }));
    fireEvent.change(screen.getByLabelText('Line item name'), { target: { value: 'housing' } });
    const amount = screen.getByLabelText('Amount per month');
    fireEvent.change(amount, { target: { value: '650' } });
    const addRow = amount.closest('.inline-row') as HTMLElement;
    fireEvent.click(within(addRow).getByRole('button', { name: 'OK' }));

    await waitFor(() => expect(puts).toEqual([{ label: 'housing', monthly: 650 }]));
  });

  it('does not print a minimum nobody entered', async () => {
    await mount(FELL_BACK);

    expect(
      await screen.findByText(
        /You have not entered any minimum line items yet, so these are your current-lifestyle figures\./,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/the bare minimum is only/)).toBeNull();
  });

  it('still says what the minimum costs when one has been entered', async () => {
    await mount(
      body(
        {
          baselineSum: 800,
          baselineThreshold: 880,
          effectiveMode: 'lifestyle',
          threshold: 1100,
          months: [month()],
        },
        { goalMode: 'lifestyle' },
      ),
    );

    expect(await screen.findByText(/the bare minimum is only/)).toBeInTheDocument();
  });

  it('says nothing about a minimum when lifestyle was asked for and none was entered', async () => {
    await mount(
      body(
        {
          baselineSum: 0,
          baselineItems: [],
          baselineThreshold: 0,
          effectiveMode: 'lifestyle',
          threshold: 1100,
          months: [month()],
        },
        { goalMode: 'lifestyle' },
      ),
    );

    // the presence anchor is not decoration: an absence assertion on its own is green
    // on a screen that rendered nothing at all
    expect(
      await screen.findByText('To live without support the way you do now, you need to earn'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/the bare minimum is only/)).toBeNull();
  });

  it('does not price a lifestyle nothing was averaged over', async () => {
    await mount(
      body(
        {
          baselineSum: 1010,
          baselineThreshold: 1111,
          effectiveMode: 'baseline',
          threshold: 1111,
          avgSpend: 0,
          lifestyleThreshold: 0,
          months: [],
        },
        { goalMode: 'baseline' },
      ),
    );

    expect(await screen.findByText('To cover your minimum, you need to earn')).toBeInTheDocument();
    expect(screen.queryByText(/your current lifestyle costs/)).toBeNull();
    expect(screen.queryByText(/the bare minimum is only/)).toBeNull();
  });

  it('says a lifestyle above the minimum costs more', async () => {
    await mount(
      body(
        {
          baselineSum: 800,
          baselineThreshold: 880,
          lifestyleThreshold: 2000,
          effectiveMode: 'baseline',
          threshold: 880,
          months: [month()],
        },
        { goalMode: 'baseline' },
      ),
    );

    expect(
      await screen.findByText(
        'your current lifestyle costs 2,000 EUR — 1,120 EUR more than the minimum',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/less than the minimum/)).toBeNull();
  });

  it('says a lifestyle below the minimum costs less, and unsigned', async () => {
    await mount(
      body(
        {
          baselineSum: 3000,
          baselineThreshold: 3300,
          lifestyleThreshold: 1987.3,
          effectiveMode: 'baseline',
          threshold: 3300,
          months: [month()],
        },
        { goalMode: 'baseline' },
      ),
    );

    expect(
      await screen.findByText(
        'your current lifestyle costs 1,987.30 EUR — 1,313 EUR less than the minimum',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/more than the minimum/)).toBeNull();
  });

  it('prices nothing on a workspace with neither line items nor transactions', async () => {
    await mount(
      body(
        {
          avgSpend: 0,
          ownIncomeAvg: 0,
          baselineSum: 0,
          baselineItems: [],
          baselineThreshold: 0,
          lifestyleThreshold: 0,
          effectiveMode: 'lifestyle',
          threshold: 0,
          selfSufficiency: 0,
          months: [],
        },
        { goalMode: 'baseline' },
      ),
    );

    expect(await screen.findByText(/Nothing to work this out from yet/)).toBeInTheDocument();
    expect(screen.queryByText('≈ 0 EUR per month')).toBeNull();
    expect(screen.queryByText(/your own income now/)).toBeNull();
    expect(screen.queryByText(/self-sufficiency/)).toBeNull();
  });

  it('names the mode the work-hours figure came from — lifestyle', async () => {
    await mount(
      body(
        {
          effectiveMode: 'lifestyle',
          threshold: 1100,
          months: [month()],
        },
        { goalMode: 'lifestyle', hourlyRate: 2 },
      ),
    );

    expect(await screen.findByText(/that's \d+% of your current lifestyle\./)).toBeInTheDocument();
    expect(screen.queryByText(/that's \d+% of the minimum\./)).toBeNull();
    expect(screen.queryByText(/To cover the minimum at/)).toBeNull();
    expect(screen.getByText(/To cover your current lifestyle at/)).toBeInTheDocument();
  });

  it('names the mode the work-hours figure came from — the minimum', async () => {
    await mount(
      body(
        {
          effectiveMode: 'baseline',
          threshold: 880,
          months: [month()],
        },
        { goalMode: 'baseline', hourlyRate: 2 },
      ),
    );

    expect(await screen.findByText(/that's \d+% of the minimum\./)).toBeInTheDocument();
    expect(screen.getByText(/To cover the minimum at/)).toBeInTheDocument();
    expect(screen.queryByText(/your current lifestyle\./)).toBeNull();
  });

  it('names the mode the work hours cover — lifestyle', async () => {
    await mount(
      body(
        {
          effectiveMode: 'lifestyle',
          threshold: 1100,
          months: [month()],
        },
        { goalMode: 'lifestyle', hourlyRate: 20 },
      ),
    );

    expect(await screen.findByText('That covers your current lifestyle 🎉')).toBeInTheDocument();
    expect(screen.queryByText(/That covers the minimum/)).toBeNull();
  });

  it('names the mode the work hours cover — the minimum', async () => {
    await mount(
      body(
        {
          effectiveMode: 'baseline',
          threshold: 880,
          months: [month()],
        },
        { goalMode: 'baseline', hourlyRate: 20 },
      ),
    );

    expect(await screen.findByText('That covers the minimum 🎉')).toBeInTheDocument();
    expect(screen.queryByText(/That covers your current lifestyle/)).toBeNull();
  });

  it('names the mode before a rate has been entered — lifestyle', async () => {
    await mount(
      body(
        {
          effectiveMode: 'lifestyle',
          threshold: 1100,
          months: [month()],
        },
        { goalMode: 'lifestyle' },
      ),
    );

    expect(
      await screen.findByText(/how much falls short of your current lifestyle\./),
    ).toBeInTheDocument();
    expect(screen.queryByText(/how much falls short of the minimum\./)).toBeNull();
  });

  it('names the mode before a rate has been entered — the minimum', async () => {
    await mount(
      body(
        {
          effectiveMode: 'baseline',
          threshold: 880,
          months: [month()],
        },
        { goalMode: 'baseline' },
      ),
    );

    expect(await screen.findByText(/how much falls short of the minimum\./)).toBeInTheDocument();
    expect(screen.queryByText(/how much falls short of your current lifestyle\./)).toBeNull();
  });

  it('names the months it averaged and not the window that was asked for', async () => {
    await mount(
      body(
        {
          effectiveMode: 'lifestyle',
          threshold: 1100,
          months: [month()],
        },
        { goalMode: 'lifestyle', windowMonths: 6 },
      ),
    );

    expect(await screen.findByText(/median spending over 1 month with data/)).toBeInTheDocument();
    expect(screen.queryByText(/median spending over 6 mo\./)).toBeNull();
  });

  // the minimum's hint composes its own sentence around the same phrase, so it is held
  // by its own case and not by the lifestyle one above; one regex over both is what let
  // `{windowMonths} mo.` survive here
  it("names the months it averaged in the minimum's hint too", async () => {
    await mount(
      body(
        {
          baselineSum: 800,
          baselineThreshold: 880,
          effectiveMode: 'baseline',
          threshold: 880,
          months: [month()],
        },
        { goalMode: 'baseline', windowMonths: 6 },
      ),
    );

    expect(
      await screen.findByText(/Income is the average over 1 month with data/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Income is the average over 6 mo\./)).toBeNull();
  });

  it('says no months with data when nothing was averaged', async () => {
    await mount(
      body(
        {
          avgSpend: 0,
          ownIncomeAvg: 0,
          baselineSum: 800,
          baselineThreshold: 880,
          lifestyleThreshold: 0,
          effectiveMode: 'lifestyle',
          threshold: 0,
          months: [],
        },
        { goalMode: 'lifestyle' },
      ),
    );

    expect(
      await screen.findByText(/median spending over no months with data/),
    ).toBeInTheDocument();
  });

  it('counts the months in the plural, which is what every real workspace reads', async () => {
    await mount(
      body(
        {
          effectiveMode: 'lifestyle',
          threshold: 1100,
          months: [month(), month({ month: '2026-07' })],
        },
        { goalMode: 'lifestyle' },
      ),
    );

    expect(await screen.findByText(/median spending over 2 months with data/)).toBeInTheDocument();
  });

  it('sends the mode the chip was clicked on and reloads', async () => {
    const patches: unknown[] = [];
    await mount(INDEPENDENCE, {
      'PATCH /api/settings': (init) => {
        patches.push(JSON.parse(String(init?.body)));
        return ok(INDEPENDENCE.settings);
      },
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Current lifestyle' }));

    await waitFor(() => expect(patches).toEqual([{ goalMode: 'lifestyle' }]));
    expect(requests().filter((r) => r === 'GET /api/independence')).toHaveLength(2);
  });

  /**
   * The mutation is the block's and the figures are the screen's: which money counts
   * as the reader's own is the one input every number above is computed from, so a
   * save that does not re-read them leaves the screen showing pre-mutation figures —
   * which looks exactly like the save not working.
   */
  it('re-reads the figures after a source is added through the block', async () => {
    const posts: unknown[] = [];
    await mount(INDEPENDENCE, {
      'POST /api/income-sources': (init) => {
        posts.push(JSON.parse(String(init?.body)));
        return ok({
          id: 'stipend',
          label: 'Stipend',
          kind: 'external',
          patterns: [],
          sort: 3,
          builtin: false,
        });
      },
    });

    fireEvent.click(await screen.findByRole('button', { name: '+ Add income source' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Stipend' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(posts).toHaveLength(1));
    // the request, never a spinner: a spinner is painted by a screen that reloads
    // nothing too
    await waitFor(() =>
      expect(requests().filter((r) => r === 'GET /api/independence')).toHaveLength(2),
    );
  });

  /**
   * A threshold of zero covers itself. The state is NOT `noGround`'s: these months are
   * recorded and every one of them is empty, so `noGround` is false and a fix gated on
   * it would have left this live.
   */
  it('does not congratulate a reader whose threshold is zero', async () => {
    await mount(
      body(
        {
          avgSpend: 0,
          ownIncomeAvg: 0,
          baselineSum: 0,
          baselineItems: [],
          baselineThreshold: 0,
          lifestyleThreshold: 0,
          effectiveMode: 'lifestyle',
          threshold: 0,
          selfSufficiency: 0,
          months: [month({ spend: 0, ownIncome: 0 })],
        },
        { goalMode: 'baseline', hourlyRate: 20 },
      ),
    );

    // the presence anchor: absence alone is green on a screen that rendered nothing
    expect(
      await screen.findByText(
        /your current lifestyle works out to zero, so nothing is covered and nothing is short/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/That covers/)).toBeNull();
    expect(screen.queryByText(/that's 0% of/)).toBeNull();
  });
});

/**
 * The write path (ROADMAP row 75). Everything the screen shows arrives in one body,
 * GET /api/independence, so the presence anchor for every save is that body answering
 * differently on the second read: the handler serves what the PATCH and PUT handlers
 * last wrote. A handler answering the fixture twice would make each reload assertion
 * below vacuous.
 *
 * Garbage typed into a line item's amount is deliberately not pinned in either
 * direction; DEBT.md carries what the code does with it today.
 */
interface ItemWrite {
  label: string;
  monthly: number | null;
}

const HOUSING: BaselineItem = { id: 1, label: 'housing', monthly: 650, sort: 0 };
const FOOD: BaselineItem = { id: 2, label: 'food', monthly: 250, sort: 1 };

const sumOf = (items: BaselineItem[]): number => items.reduce((n, i) => n + i.monthly, 0);

const goalServer = (settings: Partial<Settings> = {}, items: BaselineItem[] = []) => {
  let current: Settings = { ...INDEPENDENCE.settings, goalMode: 'baseline', ...settings };
  let lines = items;
  const patches: Partial<Settings>[] = [];
  const puts: ItemWrite[] = [];
  const routes: Routes = {
    'GET /api/independence': () =>
      ok(
        body(
          {
            baselineItems: lines,
            baselineSum: sumOf(lines),
            effectiveMode: 'baseline',
            months: [month()],
          },
          current,
        ),
      ),
    'GET /api/income-sources': () => ok(SOURCES),
    'PATCH /api/settings': (init) => {
      const patch = JSON.parse(String(init?.body)) as Partial<Settings>;
      patches.push(patch);
      current = { ...current, ...patch };
      return ok(current);
    },
    'PUT /api/baseline': (init) => {
      const sent = JSON.parse(String(init?.body)) as ItemWrite;
      puts.push(sent);
      const rest = lines.filter((i) => i.label !== sent.label);
      lines =
        sent.monthly === null
          ? rest
          : [...rest, { id: 100 + puts.length, label: sent.label, monthly: sent.monthly, sort: 9 }];
      return ok({ baseCurrency: 'EUR', items: lines, total: sumOf(lines) });
    },
  };
  return { routes, patches, puts };
};

const mountServer = async (settings: Partial<Settings> = {}, items: BaselineItem[] = [], extra: Routes = {}) => {
  const server = goalServer(settings, items);
  mockFetch({ ...server.routes, ...extra });
  renderThemed(<IndependenceScreen />);
  await screen.findByRole('heading', { name: 'Goal', level: 1 });
  return server;
};

const reads = () => requests().filter((r) => r === 'GET /api/independence').length;

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

const rateInput = () => screen.getByLabelText('Hourly rate, net');
const hoursInput = () => screen.getByLabelText('Work hours per week');
/** The OK beside an input, and not the other one. */
const okBeside = (input: HTMLElement) =>
  within(input.closest('.inline-row, .legend-row') as HTMLElement).getByRole('button', { name: 'OK' });

describe('the hourly rate', () => {
  it('saves what was typed, with a comma decimal, and shows the figure the server now holds', async () => {
    const { patches } = await mountServer();
    expect(screen.getByText(/Enter your rate and weekly hours/)).toBeInTheDocument();

    fireEvent.change(rateInput(), { target: { value: '25,5' } });
    fireEvent.click(okBeside(rateInput()));

    expect(await screen.findByText(/25\.50 EUR\/hr × 40 hr\/wk/)).toBeInTheDocument();
    expect(patches).toEqual([{ hourlyRate: 25.5 }]);
    expect(reads()).toBe(2);
  });

  it('saves on Enter too', async () => {
    const { patches } = await mountServer();

    fireEvent.change(rateInput(), { target: { value: '25,5' } });
    fireEvent.keyDown(rateInput(), { key: 'Enter' });

    expect(await screen.findByText(/25\.50 EUR\/hr × 40 hr\/wk/)).toBeInTheDocument();
    expect(patches).toEqual([{ hourlyRate: 25.5 }]);
  });

  /**
   * A pin and not a defect test: a rate that is not a number is sent as null, which
   * is the code's rule today and means "no rate" on this field.
   */
  it('sends null for a rate that is not a number, and the hint comes back', async () => {
    const { patches } = await mountServer({ hourlyRate: 20 });
    expect(await screen.findByText(/20 EUR\/hr × 40 hr\/wk/)).toBeInTheDocument();

    fireEvent.change(rateInput(), { target: { value: 'abc' } });
    fireEvent.click(okBeside(rateInput()));

    expect(await screen.findByText(/Enter your rate and weekly hours/)).toBeInTheDocument();
    expect(patches).toEqual([{ hourlyRate: null }]);
    expect(screen.queryByText(/20 EUR\/hr/)).toBeNull();
  });

  it('disables its OK while the save is in flight', async () => {
    let release: (r: Response) => void = () => {};
    await mountServer({}, [], {
      'PATCH /api/settings': () => new Promise<Response>((resolve) => (release = resolve)),
    });

    fireEvent.change(rateInput(), { target: { value: '25,5' } });
    fireEvent.click(okBeside(rateInput()));
    expect(okBeside(rateInput())).toBeDisabled();
    // the other save is its own flag
    expect(okBeside(hoursInput())).toBeEnabled();

    release(ok({ ...INDEPENDENCE.settings, hourlyRate: 25.5 }));
    await waitFor(() => expect(okBeside(rateInput())).toBeEnabled());
  });

  // the hours share this handler, so one refusal holds both saves' error path
  it('keeps the figure, the typed rate and an enabled OK when the save is refused', async () => {
    await mountServer({ hourlyRate: 20 }, [], {
      'PATCH /api/settings': () => fail(500, { error: 'the settings could not be saved' }),
    });
    expect(await screen.findByText(/20 EUR\/hr × 40 hr\/wk/)).toBeInTheDocument();

    fireEvent.change(rateInput(), { target: { value: '25,5' } });
    fireEvent.click(okBeside(rateInput()));

    expect(await screen.findByText(/Error: the settings could not be saved/)).toBeInTheDocument();
    expect(screen.getByText(/20 EUR\/hr × 40 hr\/wk/)).toBeInTheDocument();
    expect(screen.queryByText(/25\.50 EUR\/hr/)).toBeNull();
    expect(rateInput()).toHaveValue('25,5');
    await waitFor(() => expect(okBeside(rateInput())).toBeEnabled());
    expect(reads()).toBe(1);
  });
});

describe('the weekly hours', () => {
  it('saves what was typed, with a comma decimal', async () => {
    const { patches } = await mountServer({ hourlyRate: 20 });
    expect(await screen.findByText(/× 40 hr\/wk/)).toBeInTheDocument();

    fireEvent.change(hoursInput(), { target: { value: '37,5' } });
    fireEvent.click(okBeside(hoursInput()));

    expect(await screen.findByText(/20 EUR\/hr × 37\.5 hr\/wk/)).toBeInTheDocument();
    expect(patches).toEqual([{ hoursCapPerWeek: 37.5 }]);
    expect(reads()).toBe(2);
  });

  it('keeps the previous hours when the input is not a number', async () => {
    const { patches } = await mountServer({ hourlyRate: 20 });
    expect(await screen.findByText(/× 40 hr\/wk/)).toBeInTheDocument();

    fireEvent.change(hoursInput(), { target: { value: 'abc' } });
    fireEvent.click(okBeside(hoursInput()));

    await waitFor(() => expect(patches).toHaveLength(1));
    // the key's absence, not `{}`: an absent key means "leave it alone" at the door
    expect(Object.keys(patches[0])).not.toContain('hoursCapPerWeek');
    await waitFor(() => expect(reads()).toBe(2));
    expect(screen.getByText(/× 40 hr\/wk/)).toBeInTheDocument();
  });

  it('disables its OK while the save is in flight', async () => {
    let release: (r: Response) => void = () => {};
    await mountServer({}, [], {
      'PATCH /api/settings': () => new Promise<Response>((resolve) => (release = resolve)),
    });

    fireEvent.change(hoursInput(), { target: { value: '37,5' } });
    fireEvent.click(okBeside(hoursInput()));
    expect(okBeside(hoursInput())).toBeDisabled();
    expect(okBeside(rateInput())).toBeEnabled();

    release(ok({ ...INDEPENDENCE.settings, hoursCapPerWeek: 37.5 }));
    await waitFor(() => expect(okBeside(hoursInput())).toBeEnabled());
  });
});

describe('a minimum line item', () => {
  const openHousing = async () => {
    fireEvent.click(await screen.findByText('Housing'));
    const input = screen.getByLabelText('Amount for Housing');
    expect(input).toHaveValue('650');
    return input;
  };

  it('opens with its figure, saves the new one, and the row shows what the server now holds', async () => {
    const { puts } = await mountServer({}, [HOUSING, FOOD]);
    const input = await openHousing();

    fireEvent.change(input, { target: { value: '700' } });
    fireEvent.click(okBeside(input));

    await waitFor(() => expect(puts).toEqual([{ label: 'housing', monthly: 700 }]));
    expect(await screen.findByText('700')).toBeInTheDocument();
    // the row being back is the close
    expect(screen.getByText('Housing')).toBeInTheDocument();
    expect(screen.queryByLabelText('Amount for Housing')).toBeNull();
    expect(screen.getByText('Food')).toBeInTheDocument();
  });

  it('saves on Enter too', async () => {
    const { puts } = await mountServer({}, [HOUSING, FOOD]);
    const input = await openHousing();

    fireEvent.change(input, { target: { value: '700' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(puts).toEqual([{ label: 'housing', monthly: 700 }]));
    expect(await screen.findByText('700')).toBeInTheDocument();
  });

  it('deletes it with null, and the other row stays', async () => {
    const { puts } = await mountServer({}, [HOUSING, FOOD]);
    const input = await openHousing();

    fireEvent.click(within(input.closest('.legend-row') as HTMLElement).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(puts).toEqual([{ label: 'housing', monthly: null }]));
    await waitFor(() => expect(screen.queryByText('Housing')).toBeNull());
    expect(screen.getByText('Food')).toBeInTheDocument();
    expect(screen.queryByLabelText('Amount for Housing')).toBeNull();
  });

  it('cancels without a request, and the row is back', async () => {
    await mountServer({}, [HOUSING, FOOD]);
    const input = await openHousing();

    fireEvent.change(input, { target: { value: '700' } });
    fireEvent.click(within(input.closest('.legend-row') as HTMLElement).getByRole('button', { name: 'Cancel' }));

    expect(screen.getByText('Housing')).toBeInTheDocument();
    expect(screen.queryByLabelText('Amount for Housing')).toBeNull();
    expect(screen.getByText('650')).toBeInTheDocument();
    expect(requests()).not.toContain('PUT /api/baseline');
  });

  it('keeps the input open, with what was typed, when the save is refused', async () => {
    await mountServer({}, [HOUSING, FOOD], {
      'PUT /api/baseline': () => fail(500, { error: 'the line item could not be saved' }),
    });
    const input = await openHousing();

    fireEvent.change(input, { target: { value: '700' } });
    fireEvent.click(okBeside(input));

    expect(await screen.findByText(/the line item could not be saved/)).toBeInTheDocument();
    expect(screen.getByLabelText('Amount for Housing')).toHaveValue('700');
    expect(screen.queryByText('700')).toBeNull();
  });

  it('keeps the row, still open for editing, when the delete is refused', async () => {
    await mountServer({}, [HOUSING, FOOD], {
      'PUT /api/baseline': () => fail(500, { error: 'the line item could not be removed' }),
    });
    const input = await openHousing();

    fireEvent.click(within(input.closest('.legend-row') as HTMLElement).getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText(/Error: the line item could not be removed/)).toBeInTheDocument();
    expect(screen.getByLabelText('Amount for Housing')).toHaveValue('650');
    expect(screen.getByText('Food')).toBeInTheDocument();
    // Cancel shows the row the screen still holds: nothing was removed
    fireEvent.click(within(input.closest('.legend-row') as HTMLElement).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Housing')).toBeInTheDocument();
    expect(screen.getByText('650')).toBeInTheDocument();
  });
});

describe('adding a line item', () => {
  const addControl = () => screen.getByRole('button', { name: '+ Add line item' });
  const nameInput = () => screen.getByLabelText('Line item name');
  const amountInput = () => screen.getByLabelText('Amount per month');

  it('sends the name and the amount, closes, and reopens empty', async () => {
    const { puts } = await mountServer({}, [HOUSING]);

    fireEvent.click(await screen.findByRole('button', { name: '+ Add line item' }));
    fireEvent.change(nameInput(), { target: { value: 'transport' } });
    fireEvent.change(amountInput(), { target: { value: '80' } });
    fireEvent.click(okBeside(amountInput()));

    // the new row is the re-read, and the button being back is the close
    expect(await screen.findByText('Transport')).toBeInTheDocument();
    expect(puts).toEqual([{ label: 'transport', monthly: 80 }]);
    expect(addControl()).toBeInTheDocument();
    expect(screen.queryByLabelText('Line item name')).toBeNull();

    fireEvent.click(addControl());
    expect(nameInput()).toHaveValue('');
    expect(amountInput()).toHaveValue('');
  });

  it.each([
    ['a blank name', '   ', '80'],
    ['a zero amount', 'transport', '0'],
  ])('sends nothing for %s, and the form stays', async (_what, name, amount) => {
    await mountServer({}, [HOUSING]);

    fireEvent.click(await screen.findByRole('button', { name: '+ Add line item' }));
    fireEvent.change(nameInput(), { target: { value: name } });
    fireEvent.change(amountInput(), { target: { value: amount } });
    fireEvent.click(okBeside(amountInput()));
    await settle();

    expect(requests()).not.toContain('PUT /api/baseline');
    expect(nameInput()).toHaveValue(name);
    expect(amountInput()).toHaveValue(amount);
  });

  it('keeps the form, with the typed name and amount, when the save is refused', async () => {
    await mountServer({}, [HOUSING], {
      'PUT /api/baseline': () => fail(500, { error: 'the line item could not be added' }),
    });

    fireEvent.click(await screen.findByRole('button', { name: '+ Add line item' }));
    fireEvent.change(nameInput(), { target: { value: 'transport' } });
    fireEvent.change(amountInput(), { target: { value: '80' } });
    fireEvent.click(okBeside(amountInput()));

    expect(await screen.findByText(/Error: the line item could not be added/)).toBeInTheDocument();
    expect(nameInput()).toHaveValue('transport');
    expect(amountInput()).toHaveValue('80');
    expect(screen.queryByRole('button', { name: '+ Add line item' })).toBeNull();
    expect(screen.queryByText('Transport')).toBeNull();
    expect(screen.getByText('Housing')).toBeInTheDocument();
  });
});
