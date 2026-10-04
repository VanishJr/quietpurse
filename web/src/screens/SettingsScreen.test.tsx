import { act, fireEvent, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { APP_SETTINGS, importsResponse, INCOME_SOURCES, RECURRING } from '../test/fixtures';
import { fail, mockFetch, ok, renderThemed, requests, Routes } from '../test/harness';
import { setUrl } from '../url';
import { REFILL_POLL_MS } from '../components/AppSettingsBlock';
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
  // asked only after a save that changed the currency, so never on first paint
  'GET /api/conversion': () => ok({ baseCurrency: 'EUR', converting: false, unconverted: 0 }),
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

  it('keeps the local REST API address behind an Advanced heading that stays a heading', () => {
    mockFetch(BASE);
    mount();

    const heading = screen.getByRole('heading', { name: 'Advanced · API connection', level: 2 });
    const card = cardFor('Advanced · API connection');
    expect(card).toHaveAttribute('aria-labelledby', heading.id);
    const toggle = within(heading).getByRole('button', { name: 'Advanced · API connection' });
    const origin = within(card).getByText(window.location.origin, { selector: 'code' });

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle.querySelector('.settings-advanced-chevron svg')).toHaveAttribute('aria-hidden', 'true');
    expect(origin).not.toBeVisible();
    expect(within(card).getByText(/local REST API/)).not.toBeVisible();
    toggle.focus();
    expect(toggle).toHaveFocus();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById(toggle.getAttribute('aria-controls') as string)).toContainElement(origin);
    expect(origin).toBeVisible();
    expect(origin).toHaveTextContent(window.location.origin);
    expect(within(card).getByText(/local REST API/)).toBeVisible();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(origin).not.toBeVisible();
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

  const recurringReads = () => requests().filter((request) => request === 'GET /api/recurring').length;
  const mountTelling = (changed: () => void) => {
    const Host = () => {
      const [revision, setRevision] = useState(0);
      return <SettingsScreen onOpenImport={vi.fn()} dataRevision={revision}
        onDataChanged={() => { changed(); setRevision((value) => value + 1); }} />;
    };
    renderThemed(<Host />);
  };

  it('tells every other reader once the server reclassified, and not after a refusal', async () => {
    let refuse = true;
    mockFetch({
      ...BASE,
      'PATCH /api/app-settings': () => refuse
        ? fail(400, { error: 'refused' })
        : ok({ baseCurrency: 'EUR', ownerNames: ['Yurii Kalvenko', 'Ana Lee'] }),
    });
    const changed = vi.fn();
    mountTelling(changed);
    await settled();
    expect(recurringReads()).toBe(1);

    fireEvent.change(owners(), { target: { value: 'Ana Lee' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/refused/)).toBeInTheDocument();
    expect(changed).not.toHaveBeenCalled();

    refuse = false;
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('All changes saved')).toBeInTheDocument();
    expect(changed).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(recurringReads()).toBe(2));
  });

  /*
   * Real timers, and one real poll interval of waiting: find* drains through a
   * setTimeout of its own, which a faked clock never fires.
   */
  it('tells every other reader once, when the refill a new currency started has stopped', async () => {
    let asks = 0;
    mockFetch({
      ...BASE,
      'PATCH /api/app-settings': () => ok({ baseCurrency: 'USD', ownerNames: ['Yurii Kalvenko', 'Ana Lee'] }),
      'GET /api/conversion': () => ok({ baseCurrency: 'USD', converting: ++asks < 2, unconverted: 0 }),
    });
    const changed = vi.fn();
    mountTelling(changed);
    await settled();

    fireEvent.change(currency(), { target: { value: 'USD' } });
    fireEvent.change(owners(), { target: { value: 'Ana Lee' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/Converting every amount into USD/)).toBeInTheDocument();
    expect(screen.getByText('All changes saved')).toBeInTheDocument();
    expect(asks).toBe(1);
    expect(changed).not.toHaveBeenCalled();
    expect(recurringReads()).toBe(1);

    // one wait for both: the call and the render that follows it are not one step
    await vi.waitFor(() => {
      expect(changed).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(/Converting every amount/)).not.toBeInTheDocument();
    }, { timeout: 3000 });
    expect(asks).toBe(2);
    expect(within(cardFor('Financial setup')).queryByRole('alert')).not.toBeInTheDocument();
    await vi.waitFor(() => expect(recurringReads()).toBe(2));
  });

  it('says how many rows the refill left without a rate, and still tells the readers', async () => {
    mockFetch({
      ...BASE,
      'PATCH /api/app-settings': () => ok({ ...APP_SETTINGS, baseCurrency: 'USD' }),
      'GET /api/conversion': () => ok({ baseCurrency: 'USD', converting: false, unconverted: 2 }),
    });
    const changed = vi.fn();
    mountTelling(changed);
    await settled();

    fireEvent.change(currency(), { target: { value: 'USD' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await within(cardFor('Financial setup')).findByRole('alert')).toHaveTextContent(
      '2 transactions have no amount in USD yet: no exchange rate could be fetched for them. Finto tries again later.',
    );
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('refuses to guess when the refill cannot be asked about, and asks again on Retry', async () => {
    let asks = 0;
    mockFetch({
      ...BASE,
      'PATCH /api/app-settings': () => ok({ ...APP_SETTINGS, baseCurrency: 'USD' }),
      'GET /api/conversion': () => ++asks === 1
        ? fail(500, { error: 'status unavailable' })
        : ok({ baseCurrency: 'USD', converting: false, unconverted: 0 }),
    });
    const changed = vi.fn();
    mountTelling(changed);
    await settled();

    fireEvent.change(currency(), { target: { value: 'USD' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    const card = cardFor('Financial setup');
    expect(await within(card).findByRole('alert')).toHaveTextContent(
      'could not tell whether the amounts are in USD yet: status unavailable',
    );
    expect(changed).not.toHaveBeenCalled();

    fireEvent.click(within(card).getByRole('button', { name: 'Retry' }));
    await vi.waitFor(() => {
      expect(changed).toHaveBeenCalledTimes(1);
      expect(within(card).queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  // test/harness.tsx's request guard relies on a timer dying with its component
  it('stops asking about the refill once it is unmounted', async () => {
    let asks = 0;
    mockFetch({
      ...BASE,
      'PATCH /api/app-settings': () => ok({ ...APP_SETTINGS, baseCurrency: 'USD' }),
      'GET /api/conversion': () => { asks += 1; return ok({ baseCurrency: 'USD', converting: true, unconverted: 0 }); },
    });
    const view = mount();
    await settled();
    fireEvent.change(currency(), { target: { value: 'USD' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/Converting every amount into USD/)).toBeInTheDocument();
    expect(asks).toBe(1);

    view.unmount();
    await new Promise((resolve) => setTimeout(resolve, REFILL_POLL_MS * 1.5));
    expect(asks).toBe(1);
  });

  it('leaves a names-only save to a refill already being watched', async () => {
    let converting = true;
    mockFetch({
      ...BASE,
      'PATCH /api/app-settings': (init) => ok({ ...APP_SETTINGS, ...JSON.parse(String(init?.body)) }),
      'GET /api/conversion': () => ok({ baseCurrency: 'USD', converting, unconverted: 0 }),
    });
    const changed = vi.fn();
    mountTelling(changed);
    await settled();

    fireEvent.change(currency(), { target: { value: 'USD' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/Converting every amount into USD/)).toBeInTheDocument();

    fireEvent.change(owners(), { target: { value: 'Ana Lee' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await vi.waitFor(() => expect(requests().filter((r) => r === 'PATCH /api/app-settings')).toHaveLength(2));
    expect(await screen.findByText('All changes saved')).toBeInTheDocument();
    expect(changed).not.toHaveBeenCalled();

    converting = false;
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1), { timeout: 3000 });
  });

  it('tells no reader after a 200 that changed nothing, and names what the server kept', async () => {
    mockFetch({ ...BASE, 'PATCH /api/app-settings': () => ok(APP_SETTINGS) });
    const changed = vi.fn();
    mountTelling(changed);
    await settled();

    fireEvent.change(owners(), { target: { value: 'Ana Lee' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('server stored something else (owner names Yurii Kalvenko)');
    expect(screen.getByRole('button', { name: 'Remove owner name Ana Lee' })).toBeInTheDocument();
    expect(changed).not.toHaveBeenCalled();
    expect(recurringReads()).toBe(1);
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

    // the field still shows the edit, so the sentence is the one place the stored value is
    expect(await screen.findByText(/^Error:/)).toHaveTextContent('(base currency EUR)');
    expect(screen.queryByText('All changes saved')).not.toBeInTheDocument();
    expect(currency().value).toBe('USD');
    expect(screen.getByRole('button', { name: 'Save changes' })).toHaveAttribute('aria-disabled', 'false');
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
    expect(save()).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('No changes to save');

    fireEvent.change(owners(), { target: { value: '   ' } });
    fireEvent.keyDown(owners(), { key: 'Enter' });
    expect(save()).toHaveAttribute('aria-disabled', 'true');
    fireEvent.change(owners(), { target: { value: 'Yurii Kalvenko' } });
    fireEvent.keyDown(owners(), { key: 'Enter' });
    expect(screen.getAllByRole('button', { name: 'Remove owner name Yurii Kalvenko' })).toHaveLength(1);
    expect(save()).toHaveAttribute('aria-disabled', 'true');

    fireEvent.change(owners(), { target: { value: ' Yuriy Kalvenko ' } });
    fireEvent.keyDown(owners(), { key: 'Enter' });
    expect(screen.getByRole('button', { name: 'Remove owner name Yuriy Kalvenko' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove owner name Yurii Kalvenko' }));
    expect(screen.queryByRole('button', { name: 'Remove owner name Yurii Kalvenko' })).not.toBeInTheDocument();
    expect(save()).toHaveAttribute('aria-disabled', 'false');
    expect(screen.getByRole('status')).toHaveTextContent('Unsaved changes');
    expect(sent).toEqual([]);

    fireEvent.click(save());
    expect(await screen.findByText('All changes saved')).toBeInTheDocument();
    expect(sent).toEqual([{ baseCurrency: 'EUR', ownerNames: ['Yuriy Kalvenko'] }]);
    expect(save()).toHaveAttribute('aria-disabled', 'true');
  });

  it('saves an uncommitted name draft, one name per comma, rather than silently omitting it', async () => {
    const sent: unknown[] = [];
    mockFetch({
      ...BASE,
      'PATCH /api/app-settings': (init) => {
        sent.push(JSON.parse(String(init?.body)));
        return ok({ ...APP_SETTINGS, ownerNames: ['Yurii Kalvenko', 'Ana Lee', 'Lee Ana'] });
      },
    });
    mount();
    await settled();
    // the server wants every word of a name in one description, so "Ana Lee, Lee Ana"
    // sent as one name would match neither spelling
    fireEvent.change(owners(), { target: { value: ' Ana Lee, Lee Ana ,' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('All changes saved')).toBeInTheDocument();
    expect(sent).toEqual([{ baseCurrency: 'EUR', ownerNames: ['Yurii Kalvenko', 'Ana Lee', 'Lee Ana'] }]);
    expect(screen.getByRole('button', { name: 'Remove owner name Ana Lee' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove owner name Lee Ana' })).toBeInTheDocument();
  });

  it('adds each comma-separated spelling as its own tag, once', async () => {
    mockFetch(BASE);
    mount();
    await settled();
    fireEvent.change(owners(), { target: { value: 'Ana Lee, Yurii Kalvenko, Ana Lee' } });
    fireEvent.keyDown(owners(), { key: 'Enter' });
    expect(screen.getAllByRole('button', { name: /^Remove owner name/ }).map((button) => button.getAttribute('aria-label')))
      .toEqual(['Remove owner name Yurii Kalvenko', 'Remove owner name Ana Lee']);
    expect(owners()).toHaveValue('');
    expect(requests().filter((request) => request === 'PATCH /api/app-settings')).toHaveLength(0);
  });

  it('hands focus on from a removed spelling, and leaves the other tags mounted', async () => {
    mockFetch({
      ...BASE,
      'GET /api/app-settings': () => ok({ ...APP_SETTINGS, ownerNames: ['Ana Lee', 'Bo Chen', 'Cy Dunn'] }),
    });
    mount();
    await settled();
    const remove = (name: string) => screen.getByRole('button', { name: `Remove owner name ${name}` });
    const last = remove('Cy Dunn');

    fireEvent.click(remove('Ana Lee'));
    expect(remove('Bo Chen')).toHaveFocus();
    expect(remove('Cy Dunn')).toBe(last);
    fireEvent.click(remove('Cy Dunn'));
    expect(remove('Bo Chen')).toHaveFocus();
    fireEvent.click(remove('Bo Chen'));
    expect(owners()).toHaveFocus();
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
    expect(screen.getByRole('button', { name: 'Save changes' })).toHaveAttribute('aria-disabled', 'false');
    expect(screen.queryByText('All changes saved')).not.toBeInTheDocument();
  });

  it('supports Add name without submitting, and returns to pristine when edits are undone', async () => {
    mockFetch(BASE);
    mount();
    await settled();
    fireEvent.change(owners(), { target: { value: 'Alex' } });
    const add = screen.getByRole('button', { name: 'Add name' });
    add.focus();
    fireEvent.click(add);
    expect(screen.getByRole('button', { name: 'Remove owner name Alex' })).toBeInTheDocument();
    // nothing left to add, and the button that was pressed keeps focus rather than being
    // disabled under it, which a browser answers by dropping focus to the page
    expect(add).not.toBeDisabled();
    expect(add).toHaveAttribute('aria-disabled', 'true');
    expect(add).toHaveFocus();
    fireEvent.click(add);
    expect(screen.getAllByRole('button', { name: 'Remove owner name Alex' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Save changes' })).toHaveAttribute('aria-disabled', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Remove owner name Alex' }));
    expect(screen.getByRole('button', { name: 'Save changes' })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.change(currency(), { target: { value: 'eur' } });
    expect(screen.getByRole('button', { name: 'Save changes' })).toHaveAttribute('aria-disabled', 'true');
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
    expect(screen.getByRole('button', { name: 'Save changes' })).toHaveAttribute('aria-disabled', 'false');
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
    expect(screen.getByRole('button', { name: 'Save changes' })).toHaveAttribute('aria-disabled', 'false');
    expect(screen.queryByText('All changes saved')).not.toBeInTheDocument();
  });

  it('keeps focus on Save through the save and after it, when nothing is left to save', async () => {
    let release: (response: Response) => void = () => {};
    mockFetch({
      ...BASE,
      'PATCH /api/app-settings': () => new Promise<Response>((resolve) => { release = resolve; }),
    });
    mount();
    await settled();
    fireEvent.change(currency(), { target: { value: 'USD' } });
    const save = screen.getByRole('button', { name: 'Save changes' });
    save.focus();
    fireEvent.click(save);

    // a browser takes focus off a control disabled under it and jsdom does not, so what
    // is held here is that nothing the reader can be on turns disabled
    expect(save).toHaveAccessibleName('Saving…');
    expect(save).not.toBeDisabled();
    expect(currency()).not.toBeDisabled();
    expect(owners()).not.toBeDisabled();
    expect(save).toHaveFocus();

    await act(async () => release(ok({ ...APP_SETTINGS, baseCurrency: 'USD' })));
    expect(screen.getByText('All changes saved')).toBeInTheDocument();
    expect(save).not.toBeDisabled();
    expect(save).toHaveAttribute('aria-disabled', 'true');
    expect(save).toHaveFocus();
    fireEvent.click(save);
    expect(requests().filter((request) => request === 'PATCH /api/app-settings')).toHaveLength(1);
  });

  it('hands focus to the other copy of a spelling the server holds twice', async () => {
    mockFetch({
      ...BASE,
      'GET /api/app-settings': () => ok({ ...APP_SETTINGS, ownerNames: ['Yurii Kalvenko', 'Yurii Kalvenko', 'Bo Chen'] }),
    });
    mount();
    await settled();
    const copies = screen.getAllByRole('button', { name: 'Remove owner name Yurii Kalvenko' });

    fireEvent.click(copies[0]);
    expect(screen.getAllByRole('button', { name: 'Remove owner name Yurii Kalvenko' })).toEqual([copies[1]]);
    expect(copies[1]).toHaveFocus();
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
    expect(screen.getByRole('button', { name: 'Saving…' })).toHaveAttribute('aria-disabled', 'true');
    expect(currency()).toHaveAttribute('readonly');
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

  it('keeps a backup refusal beside Export when recurring payments recover', async () => {
    let recurringReads = 0;
    mockFetch({
      ...BASE,
      'GET /api/recurring': () => ++recurringReads === 1
        ? fail(500, { error: 'recurring unavailable' }) : ok(RECURRING),
      'GET /api/backup': () => fail(500, { error: 'backup unavailable' }),
    });
    mount();
    const recurringCard = cardFor('Recurring payments');
    expect(await within(recurringCard).findByRole('alert')).toHaveTextContent('recurring unavailable');
    fireEvent.click(exportControl());
    expect(await within(cardFor('Data & backup')).findByRole('alert')).toHaveTextContent('backup unavailable');

    fireEvent.click(within(recurringCard).getByRole('button', { name: 'Retry' }));
    await vi.waitFor(() => expect(within(recurringCard).queryByRole('alert')).not.toBeInTheDocument());
    expect(within(cardFor('Data & backup')).getByRole('alert')).toHaveTextContent('backup unavailable');
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
  const payment = (description: string, ignored = false, key = description.toLowerCase()) => ({
    key, description, category: 'subscriptions', months: 6, count: 6,
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
    expect(await screen.findByText(/A payment has to appear in several months/)).toBeInTheDocument();
    expect(within(cardFor('Recurring payments')).queryByText('Estimated per month')).not.toBeInTheDocument();
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
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    expect(screen.queryByRole('button', { name: 'Exclude from recurring: Gym' })).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps the menu open when a press moves focus out of it, as Safari does on a click', async () => {
    const writes: unknown[] = [];
    mockFetch({
      ...BASE,
      'GET /api/recurring': () => ok(answer(payment('Gym'))),
      'POST /api/recurring/ignore': (init) => {
        writes.push(JSON.parse(String(init?.body)));
        return ok(answer(payment('Gym', true)));
      },
    });
    const { container } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Gym' }));
    const action = screen.getByRole('button', { name: 'Exclude from recurring: Gym' });

    // a click does not focus a button there, so the press hands focus to the nearest
    // focusable ancestor outside the menu before the click lands
    const outside = container.ownerDocument.createElement('main');
    outside.tabIndex = -1;
    container.ownerDocument.body.append(outside);
    fireEvent.pointerDown(action);
    fireEvent.blur(action, { relatedTarget: outside });
    fireEvent.focusOut(action, { relatedTarget: outside });
    outside.focus();
    expect(action).toBeInTheDocument();
    fireEvent.click(action);

    expect(await screen.findByText('Excluded payments (1)')).toBeInTheDocument();
    expect(writes).toEqual([{ description: 'Gym', ignored: true }]);
    outside.remove();
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
    expect(row.querySelector('.settings-recurring-amount')).toHaveTextContent('123,456,789,012 EUR/mo');
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
    expect(within(card).getByRole('button', { name: 'Actions for Spotify' })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(within(card).getByRole('button', { name: 'Actions for Spotify' }));
    expect(within(card).queryByRole('button', { name: 'Exclude from recurring: Spotify' })).not.toBeInTheDocument();
    expect(requests().filter((request) => request === 'POST /api/recurring/ignore')).toHaveLength(1);
    await act(async () => { finish(fail(500, { error: 'cannot exclude' })); });
    expect(within(card).getByRole('alert')).toHaveTextContent('cannot exclude');
    expect(within(card).getByRole('button', { name: 'Actions for Gym' })).toHaveAttribute('aria-disabled', 'false');
    expect(within(card).queryByText(/Excluded payments/)).not.toBeInTheDocument();
  });

  it('keeps a refused action apart from the read: loading still shows, and Retry is the read’s', async () => {
    let finishRead: (response: Response) => void = () => {};
    let reads = 0;
    mockFetch({
      ...BASE,
      'GET /api/recurring': () => ++reads === 1
        ? ok(answer(payment('Gym'))) : new Promise<Response>((resolve) => { finishRead = resolve; }),
      'POST /api/recurring/ignore': () => fail(500, { error: 'cannot exclude' }),
    });
    const Host = () => {
      const [revision, setRevision] = useState(0);
      return <><button onClick={() => setRevision((value) => value + 1)}>Reclassify</button>
        <SettingsScreen onOpenImport={vi.fn()} dataRevision={revision} /></>;
    };
    renderThemed(<Host />);
    const card = cardFor('Recurring payments');

    fireEvent.click(await within(card).findByRole('button', { name: 'Actions for Gym' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Exclude from recurring: Gym' }));
    expect(await within(card).findByRole('alert')).toHaveTextContent('cannot exclude');

    fireEvent.click(screen.getByRole('button', { name: 'Reclassify' }));
    await vi.waitFor(() => expect(reads).toBe(2));
    expect(within(card).getByRole('status')).toHaveTextContent('Loading recurring payments');
    expect(within(card).getByRole('alert')).toHaveTextContent('cannot exclude');
    expect(within(card).queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();

    await act(async () => { finishRead(fail(500, { error: 'read failed' })); });
    const alerts = within(card).getAllByRole('alert').map((alert) => alert.textContent);
    expect(alerts).toEqual([expect.stringContaining('read failed'), expect.stringContaining('cannot exclude')]);
    expect(within(card).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('keeps focus on the pressed control while a write is out, and there after a refusal', async () => {
    let finish: (response: Response) => void = () => {};
    mockFetch({
      ...BASE,
      'GET /api/recurring': () => ok(answer(payment('Gym'), payment('Spotify', true))),
      'POST /api/recurring/ignore': () => new Promise<Response>((resolve) => { finish = resolve; }),
    });
    mount();
    const card = cardFor('Recurring payments');
    const trigger = await within(card).findByRole('button', { name: 'Actions for Gym' });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(within(card).getByRole('button', { name: 'Exclude from recurring: Gym' }));

    // a browser takes focus off a control that turns disabled under it, and jsdom does
    // not, so what is held here is that the control never turns disabled
    expect(trigger).not.toBeDisabled();
    expect(trigger).toHaveAttribute('aria-disabled', 'true');
    expect(trigger).toHaveFocus();
    await act(async () => { finish(fail(500, { error: 'cannot exclude' })); });
    expect(within(card).getByRole('alert')).toHaveTextContent('cannot exclude');
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-disabled', 'false');

    fireEvent.click(within(card).getByText('Excluded payments (1)'));
    const restore = within(card).getByRole('button', { name: 'Restore payment Spotify' });
    restore.focus();
    fireEvent.click(restore);
    expect(restore).not.toBeDisabled();
    expect(restore).toHaveAttribute('aria-disabled', 'true');
    expect(restore).toHaveFocus();
    await act(async () => { finish(fail(500, { error: 'cannot restore' })); });
    expect(within(card).getAllByRole('alert').map((alert) => alert.textContent))
      .toEqual([expect.stringContaining('cannot exclude'), expect.stringContaining('cannot restore')]);
    expect(restore).toHaveFocus();
  });

  it('keeps a refusal for a payment that a newer read shows under its next spelling', async () => {
    let reads = 0;
    mockFetch({
      ...BASE,
      'GET /api/recurring': () => ok(answer(++reads === 1
        ? payment('Spotify P0701', false, 'spotify p#')
        : payment('Spotify P0801', false, 'spotify p#'))),
      'POST /api/recurring/ignore': () => fail(500, { error: 'cannot exclude' }),
    });
    const Host = () => {
      const [revision, setRevision] = useState(0);
      return <><button onClick={() => setRevision((value) => value + 1)}>Reclassify</button>
        <SettingsScreen onOpenImport={vi.fn()} dataRevision={revision} /></>;
    };
    renderThemed(<Host />);
    const card = cardFor('Recurring payments');

    fireEvent.click(await within(card).findByRole('button', { name: 'Actions for Spotify P0701' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Exclude from recurring: Spotify P0701' }));
    expect(await within(card).findByRole('alert')).toHaveTextContent('cannot exclude');

    fireEvent.click(screen.getByRole('button', { name: 'Reclassify' }));
    expect(await within(card).findByRole('button', { name: 'Actions for Spotify P0801' })).toBeInTheDocument();
    expect(within(card).getByRole('alert')).toHaveTextContent(/Spotify P0701.*cannot exclude/);
  });

  it('keeps one payment’s refusal when an action on another payment succeeds', async () => {
    mockFetch({
      ...BASE,
      'GET /api/recurring': () => ok(answer(payment('Gym'), payment('Spotify'))),
      'POST /api/recurring/ignore': (init) => JSON.parse(String(init?.body)).description === 'Gym'
        ? fail(500, { error: 'cannot exclude' })
        : ok(answer(payment('Gym'), payment('Spotify', true))),
    });
    mount();
    const card = cardFor('Recurring payments');

    fireEvent.click(await within(card).findByRole('button', { name: 'Actions for Gym' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Exclude from recurring: Gym' }));
    expect(await within(card).findByRole('alert')).toHaveTextContent(/Gym.*cannot exclude/);

    fireEvent.click(within(card).getByRole('button', { name: 'Actions for Spotify' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Exclude from recurring: Spotify' }));
    expect(await within(card).findByText('Excluded payments (1)')).toBeInTheDocument();
    expect(within(card).getByRole('alert')).toHaveTextContent(/Gym.*cannot exclude/);
  });

  it('does not take focus back to the heading once the reader has moved on', async () => {
    let finish: (response: Response) => void = () => {};
    mockFetch({
      ...BASE,
      'GET /api/recurring': () => ok(answer(payment('Gym'))),
      'POST /api/recurring/ignore': () => new Promise<Response>((resolve) => { finish = resolve; }),
    });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Gym' }));
    fireEvent.click(screen.getByRole('button', { name: 'Exclude from recurring: Gym' }));
    const elsewhere = await screen.findByLabelText('Owner names');
    elsewhere.focus();

    await act(async () => { finish(ok(answer(payment('Gym', true)))); });
    expect(await screen.findByText('Excluded payments (1)')).toBeInTheDocument();
    expect(elsewhere).toHaveFocus();
  });

  it('moves focus to the heading when the control that was pressed has gone', async () => {
    mockFetch({
      ...BASE,
      'GET /api/recurring': () => ok(answer(payment('Gym'))),
      'POST /api/recurring/ignore': () => ok(answer(payment('Gym', true))),
    });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Gym' }));
    fireEvent.click(screen.getByRole('button', { name: 'Exclude from recurring: Gym' }));
    expect(await screen.findByText('Excluded payments (1)')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Recurring payments' })).toHaveFocus();
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
    expect(within(card).getByRole('button', { name: 'Actions for Fresh' })).toHaveAttribute('aria-disabled', 'false');
    expect(within(card).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(card).queryByText(/old mutation refused/)).not.toBeInTheDocument();
  });

  it('ignores a late exclude refusal when a newer read already shows the payment excluded', async () => {
    const before = answer(payment('Gym'));
    const after = answer(payment('Gym', true));
    let finishWrite: (response: Response) => void = () => {};
    let reads = 0;
    mockFetch({
      ...BASE,
      'GET /api/recurring': () => ok(++reads === 1 ? before : after),
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
    expect(await within(card).findByText('Excluded payments (1)')).toBeInTheDocument();
    expect(reads).toBe(2);

    await act(async () => { finishWrite(fail(500, { error: 'old exclude refused' })); });
    expect(within(card).queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(within(card).getByText('Excluded payments (1)'));
    expect(within(card).getByRole('button', { name: 'Restore payment Gym' })).toHaveAttribute('aria-disabled', 'false');
    expect(reads).toBe(2);
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
    expect(within(card).getByRole('button', { name: 'Actions for Gym' })).toHaveAttribute('aria-disabled', 'false');
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
    expect(within(card).getByRole('button', { name: 'Restore payment Gym' })).toHaveAttribute('aria-disabled', 'false');
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
    expect(within(card).getByRole('button', { name: 'Actions for Gym' })).toHaveAttribute('aria-disabled', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'Reclassify' }));
    await vi.waitFor(() => expect(reads).toBe(3));
    await act(async () => { finishRead(ok(after)); });
    expect(within(card).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(card).getByText('Excluded payments (1)')).toBeInTheDocument();
  });

  it('hides a group and takes the list the server answers with', async () => {
    const writes: unknown[] = [];
    const group = {
      key: 'spotify',
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

  it('round-trips a payment through the action menu and excluded disclosure', async () => {
    let ignored = false;
    const writes: unknown[] = [];
    mockFetch({
      ...BASE,
      'GET /api/recurring': () => ok(answer(payment('Spotify', ignored))),
      'POST /api/recurring/ignore': (init) => {
        const body = JSON.parse(String(init?.body));
        writes.push(body);
        if (body.description !== 'Spotify' || body.ignored === ignored) {
          return fail(400, { error: 'incorrect recurring action' });
        }
        ignored = body.ignored;
        return ok(answer(payment('Spotify', ignored)));
      },
    });
    mount();
    const card = cardFor('Recurring payments');
    fireEvent.click(await within(card).findByRole('button', { name: 'Actions for Spotify' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Exclude from recurring: Spotify' }));
    const disclosure = await within(card).findByText('Excluded payments (1)');
    expect(within(card).queryByRole('button', { name: 'Actions for Spotify' })).not.toBeInTheDocument();
    fireEvent.click(disclosure);
    fireEvent.click(within(card).getByRole('button', { name: 'Restore payment Spotify' }));

    expect(await within(card).findByRole('button', { name: 'Actions for Spotify' })).toBeInTheDocument();
    expect(within(card).queryByText('Excluded payments (1)')).not.toBeInTheDocument();
    expect(writes).toEqual([
      { description: 'Spotify', ignored: true },
      { description: 'Spotify', ignored: false },
    ]);
  });

  it('does not re-read after an overtaken write when the newer answer already shows it done', async () => {
    const before = answer(payment('Spotify'));
    const after = answer(payment('Spotify', true));
    let finishWrite: (response: Response) => void = () => {};
    let reads = 0;
    mockFetch({
      ...BASE,
      'GET /api/recurring': () => ok(++reads === 1 ? before : after),
      'POST /api/recurring/ignore': () => new Promise<Response>((resolve) => { finishWrite = resolve; }),
    });
    const Host = () => {
      const [revision, setRevision] = useState(0);
      return <><button onClick={() => setRevision((value) => value + 1)}>Reclassify</button>
        <SettingsScreen onOpenImport={vi.fn()} dataRevision={revision} /></>;
    };
    renderThemed(<Host />);

    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Spotify' }));
    fireEvent.click(screen.getByRole('button', { name: 'Exclude from recurring: Spotify' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reclassify' }));
    expect(await screen.findByText('Excluded payments (1)')).toBeInTheDocument();
    expect(reads).toBe(2);

    await act(async () => { finishWrite(ok(after)); });
    expect(reads).toBe(2);
    expect(screen.getByText('Excluded payments (1)')).toBeInTheDocument();
  });

  it('re-reads after a mutation whose answer was overtaken by a pre-write revision read', async () => {
    const group = (ignored: boolean) => ({
      key: 'spotify', description: 'Spotify', category: 'subscriptions', months: 6, count: 6,
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
      key: 'spotify', description: 'Spotify', category: 'subscriptions', months: 6, count: 6,
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

  it('keeps a committed restore when a pre-write revision read finishes afterward', async () => {
    const before = answer(payment('Spotify', true));
    const after = answer(payment('Spotify'));
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
      'POST /api/recurring/ignore': (init) => {
        expect(JSON.parse(String(init?.body))).toEqual({ description: 'Spotify', ignored: false });
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
    fireEvent.click(screen.getByRole('button', { name: 'Restore payment Spotify' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reclassify' }));
    await vi.waitFor(() => expect(reads).toBe(2));

    await act(async () => { finishWrite(ok(after)); });
    expect(reads).toBe(3);
    expect(await screen.findByRole('button', { name: 'Actions for Spotify' })).toBeInTheDocument();
    expect(screen.queryByText('Excluded payments (1)')).not.toBeInTheDocument();

    await act(async () => { finishOldRead(ok(before)); });
    expect(screen.getByRole('button', { name: 'Actions for Spotify' })).toBeInTheDocument();
    expect(screen.queryByText('Excluded payments (1)')).not.toBeInTheDocument();
  });

  it('keeps the newest recurring answer when a revision overtakes an older read', async () => {
    const group = (description: string) => ({
      key: description.toLowerCase(),
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
