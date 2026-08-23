import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { INDEPENDENCE } from '../test/fixtures';
import { mockFetch, ok, renderThemed, requests, Routes } from '../test/harness';
import { Independence, IndependenceMonth, Settings } from '../types';
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

const goalRoutes = (data: Independence, extra: Routes = {}): Routes => ({
  'GET /api/independence': () => ok(data),
  ...extra,
});

const mount = async (data: Independence, extra: Routes = {}) => {
  mockFetch(goalRoutes(data, extra));
  renderThemed(<IndependenceScreen />);
  await screen.findByRole('heading', { name: 'Goal', level: 1 });
};

describe('the Goal screen', () => {
  it('asks for the goal body and nothing else', async () => {
    await mount(INDEPENDENCE);
    await screen.findByText(/self-sufficiency/);
    expect(requests()).toEqual(['GET /api/independence']);
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
    expect(screen.queryByText('To live without help the way you do now, you need to earn')).toBeNull();
  });

  it('puts the minimum on the mode that was asked for, not the one that answered', async () => {
    await mount(FELL_BACK);

    expect(
      await screen.findByRole('heading', { name: 'What the minimum is made of (per month)' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('To live without help the way you do now, you need to earn'),
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
      await screen.findByText('To live without help the way you do now, you need to earn'),
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
});
