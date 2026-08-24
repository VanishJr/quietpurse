import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fail, mockFetch, ok, renderThemed, requests, Routes } from '../test/harness';
import { IncomeSourceDef } from '../types';
import { IncomeSourcesBlock } from './IncomeSourcesBlock';

/**
 * The control that decides which money is earned and which is support — the one input
 * every figure on the Goal screen is computed from.
 *
 * Every string asserted is a literal typed out here. Interpolating the component's own
 * expression would pass whatever that expression became.
 *
 * The catalog is built in this file and not in web/src/test/fixtures.ts: INCOME_SOURCES
 * there is `[]` and is served to every dom test through FIRST_PAINT_ROUTES, so a change
 * to it changes what App.test.tsx and TransactionsScreen.test.tsx render.
 */

const source = (over: Partial<IncomeSourceDef> = {}): IncomeSourceDef => ({
  id: 'stipend',
  label: 'Stipend',
  kind: 'external',
  patterns: [],
  sort: 3,
  builtin: false,
  ...over,
});

/**
 * Builtins AND one the user made. A catalog of one kind cannot tell the two apart, and
 * telling them apart is what the delete control is about.
 */
const CATALOG: IncomeSourceDef[] = [
  source({ id: 'salary', label: 'Salary', kind: 'own', sort: 0, builtin: true }),
  source({
    id: 'family',
    label: 'Support',
    kind: 'external',
    // two patterns, and the second is one word: the matcher's floor drops it, so a row
    // summary phrased as what the patterns tag is false for it
    patterns: ['Anna Becker', 'Stipendium'],
    sort: 1,
    builtin: true,
  }),
  source({ id: 'other', label: 'Other', kind: 'own', sort: 2, builtin: true }),
  source(),
];

const mount = async (list: IncomeSourceDef[] = CATALOG, extra: Routes = {}) => {
  const changed = vi.fn();
  mockFetch({ 'GET /api/income-sources': () => ok(list), ...extra });
  renderThemed(<IncomeSourcesBlock onChanged={changed} />);
  await screen.findByRole('heading', { name: 'Where your income comes from' });
  return changed;
};

/** What each write actually put on the wire, so a save can be asserted on its body. */
let sent: { method: string; body: unknown }[] = [];

const body = (method: string): unknown =>
  JSON.parse(String(sent.find((s) => s.method === method)!.body));

const record =
  (method: string, answer: () => Response) =>
  (init?: RequestInit): Response => {
    sent.push({ method, body: init?.body });
    return answer();
  };

describe('the income sources block', () => {
  beforeEach(() => {
    sent = [];
  });

  it('says of each source what it does to the figures', async () => {
    await mount();
    await screen.findByText('Stipend');

    // scoped to the row, because two of the four say the same thing and a bare
    // getByText over the block cannot tell which row it found
    const rowOf = (label: string): HTMLElement =>
      screen.getByText(label).closest('.row') as HTMLElement;

    expect(within(rowOf('Salary')).getByText('Your own earnings · tagged by hand')).toBeInTheDocument();
    expect(
      within(rowOf('Support')).getByText(
        'Support from outside · patterns: Anna Becker, Stipendium',
      ),
    ).toBeInTheDocument();
    expect(
      within(rowOf('Stipend')).getByText('Support from outside · tagged by hand'),
    ).toBeInTheDocument();
  });

  /**
   * A builtin is editable — renaming the seeded external source is how a workspace
   * reaches its own word for support — and it is not deletable, because there would be
   * no bucket left for a deleted source's income to fall back to. The route refuses one
   * too; that half is backend/test/http-income-sources.test.ts.
   */
  it('offers no delete on a builtin and one on a source the user made', async () => {
    await mount();

    expect(await screen.findByRole('button', { name: 'Delete Stipend' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete Support' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit Support' })).toBeInTheDocument();
  });

  /**
   * The repoint is inside deleteIncomeSource's transaction and is not reimplemented
   * here; what the client owes is saying so first. The manual half of it is what makes
   * the sentence load-bearing: income_source_manual is overwritten with `other` too,
   * and no re-creation and no reclassify brings those marks back.
   *
   * This is the first of the four arms of (deleted kind, destination kind): support
   * deleted into an `other` that counts as own earnings. The other three are below,
   * one case each - a catalog carrying all four states at once could not say which
   * arm rendered.
   */
  it('says where the money goes, and fires no delete until the user confirms', async () => {
    await mount(CATALOG, {
      'DELETE /api/income-sources/stipend': record('DELETE', () => ok({ deleted: true })),
      'GET /api/income-sources': () => ok(CATALOG),
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Delete Stipend' }));

    expect(
      screen.getByText(
        'Delete "Stipend"? The income tagged with it moves to Other, which counts as your own ' +
          'earnings — your own income on this screen goes up and the shortfall goes down. ' +
          'Transactions you tagged with it by hand are moved too, and creating this source again ' +
          'does not bring them back.',
      ),
    ).toBeInTheDocument();
    expect(requests().filter((r) => r.startsWith('DELETE'))).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(requests()).toContain('DELETE /api/income-sources/stipend'),
    );
  });

  /** A builtin's label is editable, so the destination is read off the list, not written out. */
  it('names the destination by the label the user gave it', async () => {
    await mount([
      source({ id: 'other', label: 'Everything else', kind: 'own', sort: 2, builtin: true }),
      source(),
    ]);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete Stipend' }));

    expect(screen.getByText(/moves to Everything else, which counts as your own earnings/))
      .toBeInTheDocument();
  });

  /**
   * The second arm, and the one the sentence used to get backwards: `other` is
   * editable through this very block, and a workspace that made it support turns a
   * delete into the opposite move. Own income falls and the shortfall rises.
   */
  it('says the income leaves your own earnings when the destination is support', async () => {
    await mount([
      source({ id: 'other', label: 'Other', kind: 'external', sort: 2, builtin: true }),
      source({ id: 'freelance', label: 'Freelance', kind: 'own' }),
    ]);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete Freelance' }));

    expect(
      screen.getByText(
        'Delete "Freelance"? The income tagged with it moves to Other, which counts as support ' +
          '— your own income on this screen goes down and the shortfall goes up. Transactions ' +
          'you tagged with it by hand are moved too, and creating this source again does not ' +
          'bring them back.',
      ),
    ).toBeInTheDocument();
  });

  /**
   * The two arms where the kinds agree. Nothing crosses the split, so promising a
   * figure would be promising a move that does not happen - and the delete is still
   * irreversible, which is why the confirmation stays.
   */
  it('promises no figure moves when both count as your own earnings', async () => {
    await mount([
      source({ id: 'other', label: 'Other', kind: 'own', sort: 2, builtin: true }),
      source({ id: 'freelance', label: 'Freelance', kind: 'own' }),
    ]);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete Freelance' }));

    expect(
      screen.getByText(
        'Delete "Freelance"? The income tagged with it moves to Other, which counts as your own ' +
          'earnings too — the income is only re-labelled and no figure on this screen changes. ' +
          'Transactions you tagged with it by hand are moved too, and creating this source again ' +
          'does not bring them back.',
      ),
    ).toBeInTheDocument();
  });

  it('promises no figure moves when both count as support', async () => {
    await mount([
      source({ id: 'other', label: 'Other', kind: 'external', sort: 2, builtin: true }),
      source(),
    ]);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete Stipend' }));

    expect(
      screen.getByText(
        'Delete "Stipend"? The income tagged with it moves to Other, which counts as support ' +
          'too — the income is only re-labelled and no figure on this screen changes. ' +
          'Transactions you tagged with it by hand are moved too, and creating this source again ' +
          'does not bring them back.',
      ),
    ).toBeInTheDocument();
  });

  it('creates a source, re-reads the list, and reloads the figures it changed', async () => {
    const changed = await mount(CATALOG, {
      'POST /api/income-sources': record('POST', () => ok(source())),
    });

    fireEvent.click(await screen.findByRole('button', { name: '+ Add income source' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Stipend' } });
    fireEvent.change(screen.getByLabelText('Names in your statements'), {
      target: { value: ' Musterstiftung ,  , Leistungsstipendium ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    // the second submit is refused by `disabled={busy}`, set before the POST is
    // issued: without it this click creates a second source, `stipend-2`
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(body('POST')).toEqual({
      label: 'Stipend',
      kind: 'external',
      patterns: ['Musterstiftung', 'Leistungsstipendium'],
    });
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(requests().filter((r) => r === 'GET /api/income-sources')).toHaveLength(2);
    // the save closed the form: the button and the form are the two arms of one
    // ternary, so the button being back is the close. Asserting the Name input
    // absent instead would be green on a render that never happened at all
    expect(screen.getByRole('button', { name: '+ Add income source' })).toBeInTheDocument();
  });

  /**
   * A case of its own and not a change to the one above: that one's `kind: 'external'`
   * is what openAdd opens on, so it holds the default and cannot tell a chip that was
   * clicked from a constant. Hard-coding 'external' in `add` is green against it.
   */
  it('sends the kind the user chose and not the one the form opened on', async () => {
    await mount(CATALOG, {
      'POST /api/income-sources': record('POST', () => ok(source({ kind: 'own' }))),
    });

    fireEvent.click(await screen.findByRole('button', { name: '+ Add income source' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Freelance' } });
    fireEvent.click(screen.getByRole('button', { name: 'Your own earnings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(body('POST')).toEqual({ label: 'Freelance', kind: 'own', patterns: [] });
  });

  /**
   * The placeholder is the only example this form gives, and the matcher drops a
   * pattern unless two of its words are three letters or more - so an example that
   * cannot match teaches the input the hint two lines below it forbids. Read off the
   * rendered input and measured against the floor rather than compared to a string:
   * shortening either example to one word reds this.
   */
  it('offers pattern examples that clear the floor its own hint states', async () => {
    await mount();

    fireEvent.click(await screen.findByRole('button', { name: '+ Add income source' }));
    const examples = screen
      .getByLabelText('Names in your statements')
      .getAttribute('placeholder')!
      .split(',')
      .map((p) => p.trim());

    expect(examples.length).toBeGreaterThan(1);
    for (const example of examples) {
      expect(
        example.split(/\s+/).filter((w) => w.length >= 3).length,
        example,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it('edits the label, the kind and the patterns of one that exists', async () => {
    const changed = await mount(CATALOG, {
      'PUT /api/income-sources/stipend': record('PUT', () => ok(source({ kind: 'own' }))),
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Edit Stipend' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Freelance' } });
    fireEvent.click(screen.getByRole('button', { name: 'Your own earnings' }));
    fireEvent.change(screen.getByLabelText('Names in your statements'), {
      target: { value: 'Acme GmbH' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(body('PUT')).toEqual({
      label: 'Freelance',
      kind: 'own',
      patterns: ['Acme GmbH'],
    });
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  });

  /**
   * The bound is the route's and the sentence is the route's: the input carries no
   * maxLength, so what the user typed is never silently cut and what refused it is
   * quoted whole.
   */
  it('keeps the work on screen and quotes the route when a save is refused', async () => {
    const changed = await mount(CATALOG, {
      'POST /api/income-sources': () =>
        fail(400, { error: 'income source label must be at most 60 characters' }),
    });

    fireEvent.click(await screen.findByRole('button', { name: '+ Add income source' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Stipend' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText('Error: income source label must be at most 60 characters'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Stipend');
    expect(changed).not.toHaveBeenCalled();
  });

  /**
   * Its own error and never a swallow: TransactionsScreen catches this same failure
   * with `.catch(() => {})` and renders an empty chip list, which reads exactly like a
   * workspace that has no sources.
   */
  it('shows its own failure to read the list, and offers the way back to it', async () => {
    let answered = false;
    mockFetch({
      'GET /api/income-sources': () => {
        const res = answered ? ok(CATALOG) : fail(500, { error: 'the list could not be read' });
        answered = true;
        return res;
      },
    });
    renderThemed(<IncomeSourcesBlock onChanged={vi.fn()} />);

    expect(await screen.findByText(/Error: the list could not be read/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ Add income source' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Stipend')).toBeInTheDocument();
  });
});
