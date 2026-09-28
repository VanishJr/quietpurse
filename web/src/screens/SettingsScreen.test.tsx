import { act, fireEvent, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { APP_SETTINGS, importsResponse, INCOME_SOURCES, RECURRING } from '../test/fixtures';
import { fail, mockFetch, ok, renderThemed, requests, Routes } from '../test/harness';
import { setUrl } from '../url';
import { SettingsScreen } from './SettingsScreen';

/**
 * The screen that holds everything about the whole of the data rather than one
 * account. What jsdom cannot answer stays manual: the screen at two widths.
 */

/**
 * The two reads that came here with the settings blocks. They were the Overview's
 * before, and both were already on the app's first paint - what moved is which screen
 * asks, not how many requests the app makes when it starts.
 */
const BASE: Routes = {
  'GET /api/recurring': () => ok(RECURRING),
  'GET /api/app-settings': () => ok(APP_SETTINGS),
  'GET /api/income-sources': () => ok(INCOME_SOURCES),
};

const mount = () => renderThemed(<SettingsScreen onOpenImport={vi.fn()} />);
const cardFor = (name: string) =>
  screen.getByRole('heading', { name }).closest('section.settings-card') as HTMLElement;

describe('the screen itself', () => {
  it('asks for the global settings reads and nothing else', async () => {
    // It is always mounted behind `hidden`, so a load here is a load on the app's first
    // paint. Both of these already were one - they were the Overview's - so what moved
    // is which screen asks, not how many requests the app makes when it starts. The
    // assertion is the whole set, because a third read added here is a third read on
    // every visit to the app, whatever screen it lands on.
    mockFetch(BASE);
    mount();

    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect([...new Set(requests())].sort()).toEqual([
      'GET /api/app-settings',
      'GET /api/income-sources',
      'GET /api/recurring',
    ]);
    expect(screen.getByRole('heading', { name: 'Income sources' })).toBeInTheDocument();
  });

  it('heads the page and keeps each block in its own ordered card', async () => {
    mockFetch(BASE);
    const { container } = mount();

    expect(screen.getByRole('heading', { name: 'Settings', level: 1 })).toBeInTheDocument();
    expect(screen.getByText(/Set how Finto counts your money/)).toBeInTheDocument();
    expect(Array.from(container.querySelectorAll('.settings-card h2'), (heading) => heading.textContent))
      .toEqual([
        'Financial setup',
        'Income sources',
        'Recurring payments',
        'Data & backup',
        'Advanced · API connection',
      ]);
    const top = container.querySelector('.settings-top');
    expect(top?.children).toHaveLength(2);
    expect(top).toContainElement(cardFor('Financial setup'));
    expect(top).toContainElement(cardFor('Income sources'));
    expect(within(cardFor('Financial setup')).getByText(/totals and income-based goals/))
      .toBeInTheDocument();
    expect(within(cardFor('Data & backup')).getByRole('button', { name: /^Export backup/ }))
      .toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Stored on this device/i })).not.toBeInTheDocument();
  });

  it('keeps unresolved reads and refusals inside their respective cards', async () => {
    let finishRecurring: (response: Response) => void = () => {};
    mockFetch({
      ...BASE,
      'GET /api/app-settings': () => fail(500, { error: 'settings unavailable' }),
      'GET /api/income-sources': () => fail(500, { error: 'catalog unavailable' }),
      'GET /api/recurring': () => new Promise<Response>((resolve) => { finishRecurring = resolve; }),
    });
    mount();

    expect(within(cardFor('Recurring payments')).getByRole('status')).toHaveTextContent('Loading recurring payments');
    expect(within(cardFor('Recurring payments')).queryByText(/Nothing yet/)).not.toBeInTheDocument();
    expect(within(cardFor('Financial setup')).getByRole('status')).toHaveTextContent('Loading financial setup');
    expect(within(cardFor('Income sources')).getByRole('status')).toHaveTextContent('Loading income sources');
    expect(await within(cardFor('Financial setup')).findByText(/settings unavailable/)).toBeInTheDocument();
    expect(await within(cardFor('Income sources')).findByText(/catalog unavailable/)).toBeInTheDocument();
    expect(within(cardFor('Financial setup')).queryByLabelText('Base currency')).not.toBeInTheDocument();
    expect(within(cardFor('Income sources')).queryByRole('button', { name: 'Add source' })).not.toBeInTheDocument();
    await act(async () => { finishRecurring(fail(500, { error: 'recurring unavailable' })); });
    expect(within(cardFor('Recurring payments')).getByText(/recurring unavailable/)).toBeInTheDocument();
    expect(within(cardFor('Recurring payments')).queryByText(/Nothing yet/)).not.toBeInTheDocument();
  });

  it('carries no password, no address and no sign-out, since there is no account', async () => {
    mockFetch(BASE);
    mount();

    await screen.findByRole('heading', { name: 'Settings' });
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign out/i })).not.toBeInTheDocument();
  });
});

describe('financial setup', () => {
  const currency = () => screen.getByLabelText('Base currency') as HTMLInputElement;
  const owners = () => screen.getByLabelText('Owner names') as HTMLInputElement;

  /** The anchor: no field exists until GET /api/app-settings came back. */
  const settled = () => screen.findByLabelText('Base currency');

  it('shows the stored values', async () => {
    mockFetch(BASE);
    mount();
    await settled();

    expect(currency().value).toBe('EUR');
    expect(owners().value).toBe('');
    expect(screen.getByRole('button', { name: 'Remove owner name Yurii Kalvenko' })).toBeInTheDocument();
  });

  it('offers a retry when the settings could not be read, and takes it', async () => {
    let reads = 0;
    mockFetch({
      ...BASE,
      'GET /api/app-settings': () => {
        reads += 1;
        return reads === 1 ? fail(500, { error: 'settings unavailable' }) : ok(APP_SETTINGS);
      },
    });
    mount();

    expect(await screen.findByText(/settings unavailable/)).toBeInTheDocument();
    // no fields: a form prefilled with values nobody stored is the lie this block avoids
    expect(screen.queryByLabelText('Base currency')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await settled();
    expect(currency().value).toBe('EUR');
  });

  it("shows the server's refusal instead of a success mark when the save is rejected", async () => {
    mockFetch({
      ...BASE,
      'PATCH /api/app-settings': () =>
        fail(400, { error: 'baseCurrency: a three-letter ISO code, e.g. EUR' }),
    });
    mount();
    await settled();

    fireEvent.change(currency(), { target: { value: 'EURO' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText(/three-letter ISO code/)).toBeInTheDocument();
    expect(currency()).toHaveValue('EURO');
    expect(screen.queryByText('All changes saved')).not.toBeInTheDocument();
  });

  it('marks the save done when the response echoes what was asked for', async () => {
    mockFetch({
      ...BASE,
      'PATCH /api/app-settings': () => ok({ baseCurrency: 'USD', ownerNames: ['Yurii Kalvenko'] }),
    });
    mount();
    await settled();

    fireEvent.change(currency(), { target: { value: 'usd' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('All changes saved')).toBeInTheDocument();
    // re-rendered from the echoed body, not from what was typed
    expect(currency().value).toBe('USD');
  });

  it('refuses to call a 200 a save when the body came back with something else', async () => {
    mockFetch({
      ...BASE,
      'PATCH /api/app-settings': () => ok({ baseCurrency: 'EUR', ownerNames: ['Yurii Kalvenko'] }),
    });
    mount();
    await settled();

    fireEvent.change(currency(), { target: { value: 'USD' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText(/^Error:/)).toBeInTheDocument();
    expect(screen.queryByText('All changes saved')).not.toBeInTheDocument();
    expect(currency().value).toBe('USD');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  });

  it('offers named suggestions but sends only a freely entered code', async () => {
    const sent: unknown[] = [];
    mockFetch({
      ...BASE,
      'PATCH /api/app-settings': (init) => {
        sent.push(JSON.parse(String(init?.body)));
        return ok({ ...APP_SETTINGS, baseCurrency: 'QZX' });
      },
    });
    mount();
    await settled();

    expect(screen.getByRole('combobox', { name: 'Base currency' })).toHaveAttribute('list', 'settings-currencies');
    expect(screen.getByText('EUR · Euro')).toBeInTheDocument();
    expect(document.querySelector('option[value="USD"]')).toHaveAttribute('label', 'US Dollar');
    fireEvent.change(currency(), { target: { value: 'qzx' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('All changes saved')).toBeInTheDocument();
    expect(sent).toEqual([{ baseCurrency: 'QZX', ownerNames: ['Yurii Kalvenko'] }]);
    expect(currency()).toHaveValue('QZX');
    expect(screen.queryByText(/QZX ·/)).not.toBeInTheDocument();
  });

  it('keeps owner tags local until Save, rejects empty and exact duplicate drafts, and handles Enter', async () => {
    const sent: unknown[] = [];
    mockFetch({
      ...BASE,
      'PATCH /api/app-settings': (init) => {
        sent.push(JSON.parse(String(init?.body)));
        return ok({ ...APP_SETTINGS, ownerNames: ['Yuriy Kalvenko'] });
      },
    });
    mount();
    await settled();
    const save = () => screen.getByRole('button', { name: 'Save changes' });
    expect(save()).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('No changes to save');

    fireEvent.change(owners(), { target: { value: '   ' } });
    fireEvent.keyDown(owners(), { key: 'Enter' });
    expect(save()).toBeDisabled();
    fireEvent.change(owners(), { target: { value: 'Yurii Kalvenko' } });
    fireEvent.keyDown(owners(), { key: 'Enter' });
    expect(screen.getAllByRole('button', { name: 'Remove owner name Yurii Kalvenko' })).toHaveLength(1);
    expect(save()).toBeDisabled();

    fireEvent.change(owners(), { target: { value: ' Yuriy Kalvenko ' } });
    fireEvent.keyDown(owners(), { key: 'Enter' });
    expect(screen.getByRole('button', { name: 'Remove owner name Yuriy Kalvenko' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove owner name Yurii Kalvenko' }));
    expect(screen.queryByRole('button', { name: 'Remove owner name Yurii Kalvenko' })).not.toBeInTheDocument();
    expect(save()).toBeEnabled();
    expect(screen.getByRole('status')).toHaveTextContent('Unsaved changes');
    expect(sent).toEqual([]);

    fireEvent.click(save());
    expect(await screen.findByText('All changes saved')).toBeInTheDocument();
    expect(sent).toEqual([{ baseCurrency: 'EUR', ownerNames: ['Yuriy Kalvenko'] }]);
    expect(save()).toBeDisabled();
  });

  it('saves an uncommitted name draft rather than silently omitting it', async () => {
    const sent: unknown[] = [];
    mockFetch({
      ...BASE,
      'PATCH /api/app-settings': (init) => {
        sent.push(JSON.parse(String(init?.body)));
        return ok({ ...APP_SETTINGS, ownerNames: ['Yurii Kalvenko', 'Ana, Lee'] });
      },
    });
    mount();
    await settled();
    fireEvent.change(owners(), { target: { value: ' Ana, Lee ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('All changes saved')).toBeInTheDocument();
    expect(sent).toEqual([{ baseCurrency: 'EUR', ownerNames: ['Yurii Kalvenko', 'Ana, Lee'] }]);
    expect(screen.getByRole('button', { name: 'Remove owner name Ana, Lee' })).toBeInTheDocument();
  });

  it('keeps failed edits beside their refusal, including a pending name', async () => {
    mockFetch({ ...BASE, 'PATCH /api/app-settings': () => fail(400, { error: 'ownerNames refused' }) });
    mount();
    await settled();
    fireEvent.change(currency(), { target: { value: 'USD' } });
    fireEvent.change(owners(), { target: { value: 'Ana' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await within(cardFor('Financial setup')).findByRole('alert')).toHaveTextContent('ownerNames refused');
    expect(currency()).toHaveValue('USD');
    expect(screen.getByRole('button', { name: 'Remove owner name Ana' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
    expect(screen.queryByText('All changes saved')).not.toBeInTheDocument();
  });

  it('supports Add name without submitting, and returns to pristine when edits are undone', async () => {
    mockFetch(BASE);
    mount();
    await settled();
    fireEvent.change(owners(), { target: { value: 'Alex' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add name' }));
    expect(screen.getByRole('button', { name: 'Remove owner name Alex' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove owner name Alex' }));
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    fireEvent.change(currency(), { target: { value: 'eur' } });
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(requests().filter((request) => request === 'PATCH /api/app-settings')).toHaveLength(0);
  });

  it('does not affirm a partial echo of the owner list or discard the unsaved tag', async () => {
    mockFetch({
      ...BASE,
      'PATCH /api/app-settings': () => ok({ ...APP_SETTINGS, ownerNames: ['Yurii Kalvenko'] }),
    });
    mount();
    await settled();
    fireEvent.change(owners(), { target: { value: 'Ana' } });
    fireEvent.keyDown(owners(), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('server stored something else');
    expect(screen.getByRole('button', { name: 'Remove owner name Ana' })).toBeInTheDocument();
    expect(screen.queryByText('All changes saved')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  });

  it('keeps pending names editable when a 200 reorders the saved owner list', async () => {
    const sent: unknown[] = [];
    mockFetch({
      ...BASE,
      'PATCH /api/app-settings': (init) => {
        sent.push(JSON.parse(String(init?.body)));
        return ok({ ...APP_SETTINGS, ownerNames: ['Bo', 'Yurii Kalvenko', 'Ana'] });
      },
    });
    mount();
    await settled();

    fireEvent.change(owners(), { target: { value: 'Ana' } });
    fireEvent.keyDown(owners(), { key: 'Enter' });
    fireEvent.change(owners(), { target: { value: 'Bo' } });
    expect(requests().filter((request) => request === 'PATCH /api/app-settings')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(sent).toEqual([{ baseCurrency: 'EUR', ownerNames: ['Yurii Kalvenko', 'Ana', 'Bo'] }]);
    expect(await screen.findByRole('alert')).toHaveTextContent('server stored something else');
    expect(screen.getByRole('button', { name: 'Remove owner name Ana' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove owner name Bo' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
    expect(screen.queryByText('All changes saved')).not.toBeInTheDocument();
  });

  it('locks the saving form against duplicate submissions until the server answers', async () => {
    let release: (response: Response) => void = () => {};
    mockFetch({
      ...BASE,
      'PATCH /api/app-settings': () => new Promise<Response>((resolve) => { release = resolve; }),
    });
    mount();
    await settled();
    fireEvent.change(currency(), { target: { value: 'USD' } });
    const save = screen.getByRole('button', { name: 'Save changes' });
    const form = save.closest('form')!;
    fireEvent.submit(form);
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(currency()).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Saving…');
    fireEvent.submit(form);
    expect(requests().filter((request) => request === 'PATCH /api/app-settings')).toHaveLength(1);
    await act(async () => release(ok({ ...APP_SETTINGS, baseCurrency: 'USD' })));
    expect(screen.getByText('All changes saved')).toBeInTheDocument();
  });
});

describe('data and backup actions', () => {
  it('offers three distinct full-row controls with decorative native icons and their safety copy', () => {
    mockFetch(BASE);
    const { container } = mount();
    const card = cardFor('Data & backup');
    const actions = within(card).getAllByRole('button');
    expect(actions).toHaveLength(3);
    expect(actions.map((button) => button.querySelector('.settings-data-label')?.textContent)).toEqual([
      'Import a statement', 'Import history', 'Export backup',
    ]);
    expect(actions[0]).toHaveAccessibleName('Import a statement');
    expect(actions[0]).toHaveAccessibleDescription('Upload a CSV, XLSX, or PDF statement.');
    expect(actions[1]).toHaveAccessibleName('Import history');
    expect(actions[1]).toHaveAccessibleDescription(
      'Review uploads from every account and download original statement files.',
    );
    expect(actions[2]).toHaveAccessibleName('Export backup');
    expect(actions[2]).toHaveAccessibleDescription(
      'Download readable, unencrypted JSON. Original statement files are not included.',
    );
    expect(actions[0]).toHaveTextContent('CSV, XLSX, or PDF');
    expect(actions[1]).toHaveTextContent('every account');
    expect(actions[1]).toHaveTextContent('download original statement files');
    expect(actions[2]).toHaveTextContent('readable, unencrypted JSON');
    expect(actions[2]).toHaveTextContent('Original statement files are not included');
    for (const action of actions) {
      expect(action).toHaveClass('settings-data-action');
      expect(action.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(2);
    }
    expect(container.querySelectorAll('.settings-data-trailing svg')).toHaveLength(3);
    expect(requests()).not.toContain('GET /api/backup');
  });

  it('hands Import to the same Shell callback without making a second request', () => {
    mockFetch(BASE);
    const onOpenImport = vi.fn();
    renderThemed(<SettingsScreen onOpenImport={onOpenImport} />);

    fireEvent.click(within(cardFor('Data & backup')).getByRole('button', { name: /^Import a statement/ }));

    expect(onOpenImport).toHaveBeenCalledOnce();
    expect(requests()).not.toContain('GET /api/backup');
  });
});

describe('the data export', () => {
  const exportControl = () => screen.getByRole('button', { name: /^Export backup/ });

  it('fetches the backup and saves what came back', async () => {
    mockFetch({ ...BASE, 'GET /api/backup': () => ok({ transactions: [] }) });
    mount();
    await screen.findByRole('heading', { name: 'Data & backup' });

    fireEvent.click(exportControl());

    // the object URL is the subject: it exists only once a checked 200 came back
    await vi.waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1));
  });

  it('shows the refusal beside the control and writes no file', async () => {
    // as a link this landed in Downloads as finto-backup-<date>.json, and the user
    // believed they held every transaction they own
    mockFetch({
      ...BASE,
      'GET /api/backup': () => fail(500, { error: 'the export could not be assembled' }),
    });
    mount();
    await screen.findByRole('heading', { name: 'Data & backup' });

    fireEvent.click(exportControl());

    const error = await within(cardFor('Data & backup')).findByRole('alert');
    expect(error).toHaveTextContent('the export could not be assembled');
    expect(error.closest('.settings-data-item')).toContainElement(exportControl());
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('starts one backup per click, not one per impatient click', async () => {
    let release: (res: Response) => void = () => {};
    mockFetch({
      ...BASE,
      // held open on purpose: /api/backup serialises every table, and nothing on the
      // screen moves while it does
      'GET /api/backup': () => new Promise<Response>((resolve) => (release = resolve)),
    });
    mount();
    await screen.findByRole('heading', { name: 'Data & backup' });

    fireEvent.click(exportControl());
    const preparing = screen.getByRole('button', { name: /^Preparing backup…/ });
    expect(preparing).toBeDisabled();
    expect(preparing).toHaveAccessibleName('Preparing backup…');
    expect(preparing).toHaveAccessibleDescription(
      'Download readable, unencrypted JSON. Original statement files are not included.',
    );
    expect(preparing).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(preparing);
    release(ok({ transactions: [] }));

    await vi.waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1));
    expect(requests().filter((r) => r === 'GET /api/backup')).toHaveLength(1);
    expect(exportControl()).toBeEnabled();
    expect(exportControl()).toHaveAttribute('aria-busy', 'false');
  });
});

describe('the import history across every account', () => {
  it('opens every account, and comes back', async () => {
    mockFetch({ ...BASE, 'GET /api/imports': () => ok(importsResponse([])) });
    mount();
    await screen.findByRole('heading', { name: 'Data & backup' });

    fireEvent.click(screen.getByRole('button', { name: /^Import history/ }));

    expect(await screen.findByRole('heading', { name: 'Import history' })).toBeInTheDocument();
    expect(window.location.search).toBe('?screen=settings&panel=history');
    fireEvent.click(screen.getByRole('button', { name: '← Back to accounts' }));

    expect(await screen.findByRole('heading', { name: 'Data & backup' })).toBeInTheDocument();
  });

  /**
   * The takeover is a place the reader can BE, so it lives in the URL like every other
   * one. It was a useState, and Shell keeps every screen mounted under `hidden` - so
   * the state outlived the screen, and leaving Settings and coming back answered with
   * the history instead of the settings that were asked for.
   *
   * The second half is the defect and is asserted WITHOUT a click: `{ screen:
   * 'settings', panel: null }` is exactly what Shell writes on every move between
   * screens, and against a useState it changes nothing at all.
   */
  it('puts the takeover in the URL, so a move between screens closes it', async () => {
    mockFetch({ ...BASE, 'GET /api/imports': () => ok(importsResponse([])) });
    mount();
    await screen.findByRole('heading', { name: 'Data & backup' });

    fireEvent.click(screen.getByRole('button', { name: /^Import history/ }));
    expect(await screen.findByRole('heading', { name: 'Import history' })).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get('panel')).toBe('history');

    act(() => setUrl({ screen: 'settings', panel: null }));

    expect(await screen.findByRole('heading', { name: 'Data & backup' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Import history' })).not.toBeInTheDocument();
  });
});

describe('recurring payments', () => {
  const payment = (description: string, ignored = false) => ({
    description, category: 'subscriptions', months: 6, count: 6,
    avgAmount: -10, monthlyAvg: -10, lastDate: '2026-07-01', ignored,
  });
  const answer = (...groups: ReturnType<typeof payment>[]) => ({
    baseCurrency: 'EUR', monthlyTotal: -10, groups,
  });

  it('lists what was found, and says so when nothing was', async () => {
    mockFetch(BASE);
    mount();

    expect(await screen.findByRole('heading', { name: 'Recurring payments' })).toBeInTheDocument();
    // the fixture is empty, and an empty list has to read as "not yet" rather than as
    // a block that failed to load
    expect(screen.getByText(/A payment has to appear in several months/)).toBeInTheDocument();
  });

  it('shows the period, monthly estimate and category marker without merchant identity', async () => {
    mockFetch({ ...BASE, 'GET /api/recurring': () => ok(answer(payment('Long gym payment'))) });
    const { container } = mount();

    const card = cardFor('Recurring payments');
    expect(await within(card).findByText('Long gym payment')).toBeInTheDocument();
    expect(within(card).getByText(/last twelve months/)).toBeInTheDocument();
    expect(within(card).getByText('Estimated per month')).toBeInTheDocument();
    expect(within(card).getByText(/Subscriptions · 6 months detected/)).toBeInTheDocument();
    expect(within(card).getByText('−10 EUR/mo')).toBeInTheDocument();
    expect(container.querySelector('.settings-recurring-marker')).toHaveAttribute('aria-hidden', 'true');
    const trigger = within(card).getByRole('button', { name: 'Actions for Long gym payment' });
    expect(trigger.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(within(card).queryByText(/Excluded payments/)).not.toBeInTheDocument();
  });

  it('retries a failed read rather than inventing an empty list', async () => {
    let reads = 0;
    mockFetch({
      ...BASE,
      'GET /api/recurring': () => ++reads === 1
        ? fail(500, { error: 'unavailable' }) : ok(answer(payment('Gym'))),
    });
    mount();
    const card = cardFor('Recurring payments');
    expect(await within(card).findByRole('alert')).toHaveTextContent('unavailable');
    expect(within(card).queryByText(/Nothing yet/)).not.toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: 'Retry' }));
    expect(await within(card).findByRole('button', { name: 'Actions for Gym' })).toBeInTheDocument();
    expect(reads).toBe(2);
  });

  it('opens a named action, closes on Escape or outside press, and returns focus on Escape', async () => {
    mockFetch({ ...BASE, 'GET /api/recurring': () => ok(answer(payment('Gym'))) });
    mount();
    const trigger = await screen.findByRole('button', { name: 'Actions for Gym' });
    trigger.focus();
    fireEvent.click(trigger);
    const action = screen.getByRole('button', { name: 'Exclude from recurring: Gym' });
    expect(action).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(action).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(trigger);
    fireEvent.pointerDown(cardFor('Financial setup'));
    expect(screen.queryByRole('button', { name: 'Exclude from recurring: Gym' })).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(screen.getByRole('button', { name: 'Exclude from recurring: Gym' })).toHaveFocus();
    const next = screen.getByRole('button', { name: /^Import a statement/ });
    fireEvent.blur(screen.getByRole('button', { name: 'Exclude from recurring: Gym' }), { relatedTarget: next });
    next.focus();
    expect(screen.queryByRole('button', { name: 'Exclude from recurring: Gym' })).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps excluded groups collapsed and restores them from the complete server answer', async () => {
    const excluded = payment('Spotify', true);
    const writes: unknown[] = [];
    mockFetch({
      ...BASE,
      'GET /api/recurring': () => ok(answer(payment('Gym'), excluded)),
      'POST /api/recurring/ignore': (init) => {
        const body = JSON.parse(String(init?.body));
        writes.push(body);
        return body.description === 'Spotify' && body.ignored === false
          ? ok(answer(payment('Gym'), payment('Spotify')))
          : fail(400, { error: 'restore refused' });
      },
    });
    mount();
    const card = cardFor('Recurring payments');
    const summary = await within(card).findByText('Excluded payments (1)');
    const disclosure = summary.closest('details') as HTMLDetailsElement;
    expect(disclosure.open).toBe(false);
    fireEvent.click(summary);
    expect(disclosure.open).toBe(true);
    fireEvent.click(within(card).getByRole('button', { name: 'Restore payment Spotify' }));
    expect(await within(card).findByRole('button', { name: 'Actions for Spotify' })).toBeInTheDocument();
    expect(within(card).queryByText(/Excluded payments/)).not.toBeInTheDocument();
    expect(writes).toEqual([{ description: 'Spotify', ignored: false }]);
  });

  it('restores the chosen excluded payment without retargeting another one', async () => {
    const writes: unknown[] = [];
    mockFetch({
      ...BASE,
      'GET /api/recurring': () => ok(answer(payment('Gym'), payment('Spotify', true), payment('YouTube', true))),
      'POST /api/recurring/ignore': (init) => {
        const body = JSON.parse(String(init?.body));
        writes.push(body);
        return body.description === 'YouTube' && body.ignored === false
          ? ok(answer(payment('Gym'), payment('Spotify', true), payment('YouTube')))
          : fail(400, { error: 'wrong payment restored' });
      },
    });
    mount();
    const card = cardFor('Recurring payments');
    fireEvent.click(await within(card).findByText('Excluded payments (2)'));
    fireEvent.click(within(card).getByRole('button', { name: 'Restore payment YouTube' }));

    expect(await within(card).findByRole('button', { name: 'Actions for YouTube' })).toBeInTheDocument();
    expect(within(card).getByText('Excluded payments (1)')).toBeInTheDocument();
    fireEvent.click(within(card).getByText('Excluded payments (1)'));
    expect(within(card).getByRole('button', { name: 'Restore payment Spotify' })).toBeInTheDocument();
    expect(writes).toEqual([{ description: 'YouTube', ignored: false }]);
  });

  it('keeps long payment descriptions and amounts in separate row cells with a named action', async () => {
    const description = 'LongPaymentNameWithoutBreaks'.repeat(12);
    mockFetch({
      ...BASE,
      'GET /api/recurring': () => ok({
        baseCurrency: 'EUR', monthlyTotal: 123456789012,
        groups: [{ ...payment(description), monthlyAvg: 123456789012 }],
      }),
    });
    mount();
    const trigger = await screen.findByRole('button', { name: `Actions for ${description}` });
    const row = trigger.closest('.settings-recurring-row') as HTMLElement;
    expect(within(row).getByText(description)).toHaveClass('settings-recurring-name');
    expect(row.querySelector('.settings-recurring-amount')).toHaveTextContent('/mo');
    expect(trigger.querySelector('svg[aria-hidden="true"]')).toBeInTheDocument();
  });

  it('reveals all active payments through Show more without hiding the excluded disclosure', async () => {
    const active = Array.from({ length: 10 }, (_, index) => payment(`Gym ${index}`));
    mockFetch({ ...BASE, 'GET /api/recurring': () => ok(answer(...active, payment('Old', true))) });
    mount();
    const card = cardFor('Recurring payments');
    expect(await within(card).findByRole('button', { name: 'Show 2 more' })).toBeInTheDocument();
    expect(within(card).queryByText('Gym 9')).not.toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: 'Show 2 more' }));
    expect(within(card).getByText('Gym 9')).toBeInTheDocument();
    expect(within(card).getByText('Excluded payments (1)')).toBeInTheDocument();
  });

  it('prevents repeated writes and keeps the row on refusal with its error inside the card', async () => {
    let finish: (response: Response) => void = () => {};
    mockFetch({
      ...BASE,
      'GET /api/recurring': () => ok(answer(payment('Gym'), payment('Spotify'))),
      'POST /api/recurring/ignore': () => new Promise<Response>((resolve) => { finish = resolve; }),
    });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Gym' }));
    fireEvent.click(screen.getByRole('button', { name: 'Exclude from recurring: Gym' }));
    const card = cardFor('Recurring payments');
    expect(within(card).getByRole('status')).toHaveTextContent('Updating recurring payments');
    expect(within(card).getByRole('button', { name: 'Actions for Spotify' })).toBeDisabled();
    expect(requests().filter((request) => request === 'POST /api/recurring/ignore')).toHaveLength(1);
    await act(async () => { finish(fail(500, { error: 'cannot exclude' })); });
    expect(within(card).getByRole('alert')).toHaveTextContent('cannot exclude');
    expect(within(card).getByRole('button', { name: 'Actions for Gym' })).toBeEnabled();
    expect(within(card).queryByText(/Excluded payments/)).not.toBeInTheDocument();
  });

  it('does not show a superseded mutation refusal beside a newer recurring read', async () => {
    const before = answer(payment('Old'));
    const after = answer(payment('Fresh'));
    let finishWrite: (response: Response) => void = () => {};
    let reads = 0;
    mockFetch({
      ...BASE,
      'GET /api/recurring': () => ok(++reads === 1 ? before : after),
      'POST /api/recurring/ignore': () => new Promise<Response>((resolve) => { finishWrite = resolve; }),
    });
    const Host = () => {
      const [revision, setRevision] = useState(0);
      return (
        <>
          <button onClick={() => setRevision((value) => value + 1)}>Reclassify</button>
          <SettingsScreen onOpenImport={vi.fn()} dataRevision={revision} />
        </>
      );
    };
    renderThemed(<Host />);

    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Old' }));
    fireEvent.click(screen.getByRole('button', { name: 'Exclude from recurring: Old' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reclassify' }));
    const card = cardFor('Recurring payments');
    expect(await within(card).findByRole('button', { name: 'Actions for Fresh' })).toBeInTheDocument();
    expect(reads).toBe(2);

    await act(async () => { finishWrite(fail(500, { error: 'old mutation refused' })); });
    expect(within(card).getByRole('button', { name: 'Actions for Fresh' })).toBeEnabled();
    expect(within(card).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(card).queryByText(/old mutation refused/)).not.toBeInTheDocument();
  });

  it('shows a failed exclude when a newer read still leaves that payment actionable', async () => {
    const current = answer(payment('Gym'));
    let finishWrite: (response: Response) => void = () => {};
    let reads = 0;
    mockFetch({
      ...BASE,
      'GET /api/recurring': () => { reads += 1; return ok(current); },
      'POST /api/recurring/ignore': (init) => {
        expect(JSON.parse(String(init?.body))).toEqual({ description: 'Gym', ignored: true });
        return new Promise<Response>((resolve) => { finishWrite = resolve; });
      },
    });
    const Host = () => {
      const [revision, setRevision] = useState(0);
      return <><button onClick={() => setRevision((value) => value + 1)}>Reclassify</button>
        <SettingsScreen onOpenImport={vi.fn()} dataRevision={revision} /></>;
    };
    renderThemed(<Host />);

    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Gym' }));
    fireEvent.click(screen.getByRole('button', { name: 'Exclude from recurring: Gym' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reclassify' }));
    const card = cardFor('Recurring payments');
    expect(await within(card).findByRole('button', { name: 'Actions for Gym' })).toBeInTheDocument();
    expect(reads).toBe(2);

    await act(async () => { finishWrite(fail(500, { error: 'exclude refused' })); });
    expect(within(card).getByRole('alert')).toHaveTextContent('exclude refused');
    expect(within(card).getByRole('button', { name: 'Actions for Gym' })).toBeEnabled();
  });

  it('shows a failed restore when a newer read still leaves the payment excluded', async () => {
    const current = answer(payment('Gym', true));
    let finishWrite: (response: Response) => void = () => {};
    let reads = 0;
    mockFetch({
      ...BASE,
      'GET /api/recurring': () => { reads += 1; return ok(current); },
      'POST /api/recurring/ignore': (init) => {
        expect(JSON.parse(String(init?.body))).toEqual({ description: 'Gym', ignored: false });
        return new Promise<Response>((resolve) => { finishWrite = resolve; });
      },
    });
    const Host = () => {
      const [revision, setRevision] = useState(0);
      return <><button onClick={() => setRevision((value) => value + 1)}>Reclassify</button>
        <SettingsScreen onOpenImport={vi.fn()} dataRevision={revision} /></>;
    };
    renderThemed(<Host />);

    fireEvent.click(await screen.findByText('Excluded payments (1)'));
    fireEvent.click(screen.getByRole('button', { name: 'Restore payment Gym' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reclassify' }));
    const card = cardFor('Recurring payments');
    expect(await within(card).findByText('Excluded payments (1)')).toBeInTheDocument();
    expect(reads).toBe(2);

    await act(async () => { finishWrite(fail(500, { error: 'restore refused' })); });
    expect(within(card).getByRole('alert')).toHaveTextContent('restore refused');
    fireEvent.click(within(card).getByText('Excluded payments (1)'));
    expect(within(card).getByRole('button', { name: 'Restore payment Gym' })).toBeEnabled();
  });

  it('keeps a failed exclude visible until a pending newer read establishes the action is obsolete', async () => {
    const before = answer(payment('Gym'));
    const after = answer(payment('Gym', true));
    let finishWrite: (response: Response) => void = () => {};
    let finishRead: (response: Response) => void = () => {};
    let reads = 0;
    mockFetch({
      ...BASE,
      'GET /api/recurring': () => ++reads === 1
        ? ok(before) : new Promise<Response>((resolve) => { finishRead = resolve; }),
      'POST /api/recurring/ignore': (init) => {
        expect(JSON.parse(String(init?.body))).toEqual({ description: 'Gym', ignored: true });
        return new Promise<Response>((resolve) => { finishWrite = resolve; });
      },
    });
    const Host = () => {
      const [revision, setRevision] = useState(0);
      return <><button onClick={() => setRevision((value) => value + 1)}>Reclassify</button>
        <SettingsScreen onOpenImport={vi.fn()} dataRevision={revision} /></>;
    };
    renderThemed(<Host />);

    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Gym' }));
    fireEvent.click(screen.getByRole('button', { name: 'Exclude from recurring: Gym' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reclassify' }));
    await vi.waitFor(() => expect(reads).toBe(2));
    await act(async () => { finishWrite(fail(500, { error: 'exclude refused' })); });
    const card = cardFor('Recurring payments');
    expect(within(card).getByRole('alert')).toHaveTextContent('exclude refused');

    await act(async () => { finishRead(ok(before)); });
    expect(within(card).getByRole('alert')).toHaveTextContent('exclude refused');
    expect(within(card).getByRole('button', { name: 'Actions for Gym' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Reclassify' }));
    await vi.waitFor(() => expect(reads).toBe(3));
    await act(async () => { finishRead(ok(after)); });
    expect(within(card).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(card).getByText('Excluded payments (1)')).toBeInTheDocument();
  });

  it('hides a group and takes the list the server answers with', async () => {
    const writes: unknown[] = [];
    const group = {
      description: 'Spotify',
      category: 'subscriptions',
      months: 6,
      count: 6,
      avgAmount: -10,
      monthlyAvg: -10,
      lastDate: '2026-07-01',
      ignored: false,
    };
    mockFetch({
      ...BASE,
      'GET /api/recurring': () =>
        ok({ baseCurrency: 'EUR', monthlyTotal: 10, groups: [group] }),
      'POST /api/recurring/ignore': (init) => {
        writes.push(JSON.parse(String(init?.body)));
        return ok({ baseCurrency: 'EUR', monthlyTotal: 0, groups: [{ ...group, ignored: true }] });
      },
    });
    mount();

    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Spotify' }));
    fireEvent.click(screen.getByRole('button', { name: 'Exclude from recurring: Spotify' }));

    const excluded = await screen.findByText('Excluded payments (1)');
    expect(screen.queryByRole('button', { name: 'Actions for Spotify' })).not.toBeInTheDocument();
    fireEvent.click(excluded);
    expect(screen.getByRole('button', { name: 'Restore payment Spotify' })).toBeInTheDocument();
    expect(writes).toEqual([{ description: 'Spotify', ignored: true }]);
  });

  it('re-reads after a mutation whose answer was overtaken by a pre-write revision read', async () => {
    const group = (ignored: boolean) => ({
      description: 'Spotify', category: 'subscriptions', months: 6, count: 6,
      avgAmount: -10, monthlyAvg: -10, lastDate: '2026-07-01', ignored,
    });
    const before = { baseCurrency: 'EUR', monthlyTotal: -10, groups: [group(false)] };
    const after = { baseCurrency: 'EUR', monthlyTotal: 0, groups: [group(true)] };
    let finishWrite: (response: Response) => void = () => {};
    let reads = 0;
    mockFetch({
      ...BASE,
      'GET /api/recurring': () => ok(++reads === 3 ? after : before),
      'POST /api/recurring/ignore': () => new Promise<Response>((resolve) => { finishWrite = resolve; }),
    });
    const Host = () => {
      const [revision, setRevision] = useState(0);
      return (
        <>
          <button onClick={() => setRevision((value) => value + 1)}>Reclassify</button>
          <SettingsScreen onOpenImport={vi.fn()} dataRevision={revision} />
        </>
      );
    };
    renderThemed(<Host />);

    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Spotify' }));
    fireEvent.click(screen.getByRole('button', { name: 'Exclude from recurring: Spotify' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reclassify' }));
    expect(await screen.findByRole('button', { name: 'Actions for Spotify' })).toBeVisible();
    expect(reads).toBe(2);

    await act(async () => { finishWrite(ok(after)); });
    expect(reads).toBe(3);
    expect(await screen.findByText('Excluded payments (1)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Actions for Spotify' })).not.toBeInTheDocument();
  });

  it('keeps the post-write refresh when an older revision read finishes afterward', async () => {
    const group = (ignored: boolean) => ({
      description: 'Spotify', category: 'subscriptions', months: 6, count: 6,
      avgAmount: -10, monthlyAvg: -10, lastDate: '2026-07-01', ignored,
    });
    const before = { baseCurrency: 'EUR', monthlyTotal: -10, groups: [group(false)] };
    const after = { baseCurrency: 'EUR', monthlyTotal: 0, groups: [group(true)] };
    let finishWrite: (response: Response) => void = () => {};
    let finishOldRead: (response: Response) => void = () => {};
    let reads = 0;
    mockFetch({
      ...BASE,
      'GET /api/recurring': () => {
        reads += 1;
        if (reads === 2) return new Promise<Response>((resolve) => { finishOldRead = resolve; });
        return ok(reads === 1 ? before : after);
      },
      'POST /api/recurring/ignore': () => new Promise<Response>((resolve) => { finishWrite = resolve; }),
    });
    const Host = () => {
      const [revision, setRevision] = useState(0);
      return (
        <>
          <button onClick={() => setRevision((value) => value + 1)}>Reclassify</button>
          <SettingsScreen onOpenImport={vi.fn()} dataRevision={revision} />
        </>
      );
    };
    renderThemed(<Host />);

    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Spotify' }));
    fireEvent.click(screen.getByRole('button', { name: 'Exclude from recurring: Spotify' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reclassify' }));
    await vi.waitFor(() => expect(reads).toBe(2));

    await act(async () => { finishWrite(ok(after)); });
    expect(reads).toBe(3);
    expect(await screen.findByText('Excluded payments (1)')).toBeInTheDocument();

    await act(async () => { finishOldRead(ok(before)); });
    expect(screen.getByText('Excluded payments (1)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Actions for Spotify' })).not.toBeInTheDocument();
  });

  it('keeps the newest recurring answer when a revision overtakes an older read', async () => {
    const group = (description: string) => ({
      description,
      category: 'subscriptions',
      months: 3,
      count: 3,
      avgAmount: -10,
      monthlyAvg: -10,
      lastDate: '2026-07-01',
      ignored: false,
    });
    let releaseOld: (response: Response) => void = () => {};
    let reads = 0;
    mockFetch({
      ...BASE,
      'GET /api/recurring': () => {
        reads += 1;
        if (reads === 1) {
          return new Promise<Response>((resolve) => {
            releaseOld = resolve;
          });
        }
        return ok({ baseCurrency: 'EUR', monthlyTotal: 10, groups: [group('Fresh')] });
      },
    });
    const Host = () => {
      const [revision, setRevision] = useState(0);
      return (
        <>
          <button onClick={() => setRevision((value) => value + 1)}>Reclassify</button>
          <SettingsScreen
            onOpenImport={vi.fn()}
            dataRevision={revision}
          />
        </>
      );
    };
    renderThemed(<Host />);

    await vi.waitFor(() => expect(reads).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: 'Reclassify' }));
    expect(await screen.findByRole('button', { name: 'Actions for Fresh' })).toBeVisible();

    await act(async () => {
      releaseOld(ok({ baseCurrency: 'EUR', monthlyTotal: 10, groups: [group('Stale')] }));
    });
    expect(screen.getByRole('button', { name: 'Actions for Fresh' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Actions for Stale' })).not.toBeInTheDocument();
  });
});
