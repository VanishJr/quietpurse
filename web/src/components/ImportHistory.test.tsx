import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { importRecord, importsResponse, IMPORTS } from '../test/fixtures';
import {
  fail,
  mockFetch,
  ok,
  renderThemed,
  requests,
  requestUrls,
  Routes,
} from '../test/harness';
import { ScreenShown } from '../screen';
import { ThemeProvider } from '../theme';
import { Account, ImportStatus } from '../types';
import { ImportHistory } from './ImportHistory';

/**
 * The screen someone opens to check whether their data is still there, which is why
 * a failed read may not render as an empty history, and why neither delete may fire
 * from a single click.
 *
 * No layout is asserted: jsdom applies nothing from styles.css, so whether the
 * downloaded statement lands on disk under its original name stays a manual check.
 */

const BASE: Routes = { 'GET /api/imports': () => ok(IMPORTS) };

const mount = (onChanged = vi.fn(), backLabel = 'Back to accounts') => {
  const onBack = vi.fn();
  return {
    onBack,
    onChanged,
    ...renderThemed(<ImportHistory onBack={onBack} backLabel={backLabel} onChanged={onChanged} />),
  };
};

const deferredResponse = () => {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((finish) => { resolve = finish; });
  return { promise, resolve };
};

const openActions = async (filename = 'statement.csv') => {
  const trigger = await screen.findByRole('button', { name: `Actions for ${filename}` });
  trigger.focus();
  fireEvent.click(trigger);
  const group = screen.getByRole('group', { name: `Actions for ${filename}` });
  return { trigger, group };
};

const openConfirmation = async (kind: 'import' | 'document', filename = 'statement.csv') => {
  const { trigger, group } = await openActions(filename);
  const entry = within(group).getByRole('button', {
    name: kind === 'document' ? `Delete the file for ${filename}` : `Delete import ${filename}`,
  });
  entry.focus();
  fireEvent.click(entry);
  const dialog = screen.getByRole('dialog', {
    name: kind === 'document' ? 'Delete stored file?' : 'Delete import?',
  });
  return { trigger, dialog };
};

const countOf = (key: string): number => requests().filter((r) => r === key).length;

const deletes = (): string[] => requests().filter((r) => r.startsWith('DELETE'));

describe('the list', () => {
  it('shows loading rather than empty until the history read finishes', async () => {
    const read = deferredResponse();
    mockFetch({ 'GET /api/imports': () => read.promise });
    mount();

    expect(screen.getByRole('status')).toHaveTextContent('Loading import history…');
    const page = screen.getByRole('heading', { name: 'Import history' }).closest('section');
    expect(page).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText(/Nothing has been imported yet/)).not.toBeInTheDocument();
    expect(requests()).toEqual(['GET /api/imports']);

    await act(async () => { read.resolve(ok(importsResponse([]))); });

    expect(screen.getByText(/Nothing has been imported yet/)).toBeInTheDocument();
    expect(screen.queryByText('Loading import history…')).not.toBeInTheDocument();
    expect(page).not.toHaveAttribute('aria-busy');
    expect(deletes()).toEqual([]);
  });

  it('renders a row per import, with the counts each field carries', async () => {
    mockFetch({
      'GET /api/imports': () =>
        ok(
          importsResponse([
            importRecord(),
            importRecord({
              id: 'imp-2',
              originalFilename: null,
              sourceType: 'xlsx',
              accountName: null,
              rowsAccepted: 10,
              rowsRejected: 2,
              transactions: 10,
            }),
          ]),
        ),
    });
    mount();

    // anchor: a filename, which exists only once the list came back
    expect(await screen.findByText('statement.csv')).toBeInTheDocument();
    expect(screen.getByText(/Imported · Sparkasse Giro · 15\.06\.2026/)).toBeInTheDocument();
    expect(
      screen.getByText('12 rows accepted · 12 transactions belong to this import'),
    ).toBeInTheDocument();

    // the second row: no name and no account recorded are both legal
    expect(screen.getByText('import-imp-2.xlsx')).toBeInTheDocument();
    expect(screen.getByText(/Imported · no account recorded · 15\.06\.2026/)).toBeInTheDocument();
    expect(
      screen.getByText(
        '10 rows accepted · 2 not imported · 10 transactions belong to this import',
      ),
    ).toBeInTheDocument();
  });

  /**
   * The plural at the call site rather than at the helper: `rowCount` having a singular
   * arm and this line not calling it renders "1 rows accepted", which is the defect
   * itself.
   */
  it('says one row rather than 1 rows in the counts line', async () => {
    mockFetch({
      'GET /api/imports': () =>
        ok(importsResponse([importRecord({ rowsAccepted: 1, rowsRejected: 1, transactions: 1 })])),
    });
    mount();

    expect(
      await screen.findByText(
        '1 row accepted · 1 not imported · 1 transaction belongs to this import',
      ),
    ).toBeInTheDocument();
  });

  it('does not claim the history is empty when the request for it failed, and retries', async () => {
    let reads = 0;
    mockFetch({
      'GET /api/imports': () => {
        reads += 1;
        return reads === 1
          ? fail(500, { error: 'the import log is unreachable' })
          : ok(importsResponse());
      },
    });
    mount();

    expect(await screen.findByText(/the import log is unreachable/)).toBeInTheDocument();
    // this screen is where someone checks whether their data is still there
    expect(screen.queryByText(/Nothing has been imported yet/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('statement.csv')).toBeInTheDocument();
    expect(screen.queryByText(/^Error:/)).not.toBeInTheDocument();
  });

  it('renders the empty state for a history that loaded and is empty', async () => {
    mockFetch({ 'GET /api/imports': () => ok(importsResponse([])) });
    mount();

    expect(await screen.findByText(/Nothing has been imported yet/)).toBeInTheDocument();
    expect(screen.queryByText(/^Error:/)).not.toBeInTheDocument();
  });

  it('renders an unknown status slug as-is', async () => {
    mockFetch({
      'GET /api/imports': () =>
        ok(importsResponse([importRecord({ status: 'reparsing' as ImportStatus })])),
    });
    mount();

    expect(await screen.findByText(/reparsing · Sparkasse Giro/)).toBeInTheDocument();
  });

  it('renders the whole of errorDetail', async () => {
    // the backend composes to exactly this budget and orders the clauses of a long
    // one on the premise that all of it is read
    const detail = 'the file could not be read: '.padEnd(500, 'diagnosis ');
    expect(detail).toHaveLength(500);
    mockFetch({
      'GET /api/imports': () =>
        ok(importsResponse([importRecord({ status: 'failed', errorDetail: detail, transactions: 0 })])),
    });
    mount();

    // the exact string, not a prefix: a cut here drops the clause the backend put last
    expect(await screen.findByText(detail)).toBeInTheDocument();
  });

  it('tells an awaiting_confirmation row how to get its summary back, and offers no Confirm', async () => {
    mockFetch({
      'GET /api/imports': () =>
        ok(
          importsResponse([
            importRecord({ status: 'awaiting_confirmation', rowsAccepted: 12, transactions: 0 }),
          ]),
        ),
    });
    mount();

    expect(await screen.findByText(/Upload the same file again/)).toBeInTheDocument();
    // there is no route to read the staged summary back, so there is nothing
    // to confirm here that the user would have read first
    expect(screen.queryByRole('button', { name: /confirm/i })).not.toBeInTheDocument();
  });

  it('reports a committed import that owns nothing as deduplication, not as a failure', async () => {
    mockFetch({
      'GET /api/imports': () =>
        ok(importsResponse([importRecord({ rowsAccepted: 12, transactions: 0 })])),
    });
    mount();

    // about the file as it was read: deleting the import that owns those rows does
    // not make this sentence false, which "already in your data" would have been
    expect(
      await screen.findByText(/Every row in this file had already been imported when it was read/),
    ).toBeInTheDocument();
    expect(
      screen.getByText('12 rows accepted · no transactions belong to this import'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Error:/)).not.toBeInTheDocument();
  });

  it('says a document cannot be read, offers no Download, and still offers Delete file', async () => {
    mockFetch({
      'GET /api/imports': () => ok(importsResponse([importRecord({ documentAvailable: false })])),
    });
    mount();

    expect(await screen.findByText('No stored file this server can read.')).toBeInTheDocument();
    // nothing to fetch without a readable pointer
    expect(
      screen.queryByRole('button', { name: /Download the file/ }),
    ).not.toBeInTheDocument();
    // these are the rows likeliest to still have bytes, and the route was
    // built to reach them. Hidden, the only way left is Delete import — which takes
    // the transactions too, and no purge exists behind it.
    const { group } = await openActions();
    expect(
      within(group).getByRole('button', { name: 'Delete the file for statement.csv' }),
    ).toBeInTheDocument();
  });
});

describe('downloading the stored statement', () => {
  it('asks for the document and saves the bytes it got', async () => {
    const bytes = 'date;amount\n2026-06-01;-10';
    mockFetch({
      ...BASE,
      'GET /api/imports/imp-1/document': () => new Response(bytes),
    });
    mount();
    const download = await screen.findByRole('button', {
      name: 'Download the file for statement.csv',
    });
    fireEvent.click(download);

    // the object URL is the subject, and it is built two awaits after the click:
    // waiting on it is the assertion, not a delay before one
    await vi.waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1));
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
    expect(await blob.text()).toBe(bytes);
    expect(countOf('GET /api/imports/imp-1/document')).toBe(1);
  });

  it('renders the refusal and writes no file when the document cannot be read', async () => {
    // the backend's own 404 sentence, copied from documents.ts: absent, restored from
    // elsewhere and unreadable are one answer, and it says READ rather than "kept"
    const refusal = 'this import has no file this app can read';
    mockFetch({
      ...BASE,
      'GET /api/imports/imp-1/document': () => fail(404, { error: refusal }),
    });
    mount();
    const download = await screen.findByRole('button', {
      name: 'Download the file for statement.csv',
    });
    fireEvent.click(download);

    // anchor first: not.toHaveBeenCalled() passes for free on a screen that never
    // rendered, never clicked, or crashed
    expect(await screen.findByText(new RegExp(refusal))).toBeInTheDocument();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('renders the refusal in the row whose button produced it', async () => {
    const refusal = 'this import has no document this server can read';
    mockFetch({
      'GET /api/imports': () =>
        ok(
          importsResponse([
            importRecord(),
            importRecord({ id: 'imp-2', originalFilename: 'second.csv' }),
          ]),
        ),
      'GET /api/imports/imp-2/document': () => fail(404, { error: refusal }),
    });
    mount();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Download the file for second.csv' }),
    );

    // the panel lists up to a hundred rows: a refusal about the thirty-eighth row
    // rendered above the first
    // is a refusal the reader does not see, and from their seat the button did nothing
    const message = await screen.findByText(new RegExp(refusal));
    expect(screen.getByText('second.csv').closest('.history-record')).toContainElement(message);
    expect(screen.getByText('statement.csv').closest('.history-record')).not.toContainElement(message);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });
});

describe('deleting an import', () => {
  it('issues no DELETE when opening the confirmation, and names the count the row owns', async () => {
    mockFetch(BASE);
    const { onChanged } = mount();
    const { dialog } = await openConfirmation('import');

    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(within(dialog).getByRole('button', { name: 'Delete import' }))
      .toHaveClass('action-button--destructive-primary');
    expect(
      await screen.findByText(/Delete this import and the 12 transactions that belong to it\?/),
    ).toBeInTheDocument();
    expect(screen.getByText(/The account stays too/)).toBeInTheDocument();
    expect(deletes()).toEqual([]);
    expect(requests()).toEqual(['GET /api/imports']);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('deletes once when confirmed, re-reads the list and tells the caller', async () => {
    let reads = 0;
    mockFetch({
      'GET /api/imports': () => {
        reads += 1;
        return reads === 1 ? ok(importsResponse()) : ok(importsResponse([]));
      },
      'DELETE /api/imports/imp-1': () => ok({ deleted: true, transactions: 12 }),
    });
    const { onChanged } = mount();
    await openConfirmation('import');
    fireEvent.click(await screen.findByRole('button', { name: 'Delete import' }));

    // anchor: the notice, which is written only once the re-read came back
    expect(
      await screen.findByText('Import deleted — 12 transactions removed.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Nothing has been imported yet/)).toBeInTheDocument();
    expect(countOf('DELETE /api/imports/imp-1')).toBe(1);
    expect(countOf('GET /api/imports')).toBe(2);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('promises nothing will leave when the row owns nothing, and says so afterwards', async () => {
    let reads = 0;
    mockFetch({
      'GET /api/imports': () => {
        reads += 1;
        return reads === 1
          ? ok(importsResponse([importRecord({ rowsAccepted: 12, transactions: 0 })]))
          : ok(importsResponse([]));
      },
      'DELETE /api/imports/imp-1': () => ok({ deleted: true, transactions: 0 }),
    });
    mount();
    await openConfirmation('import');

    // anchored on this branch's own sentence and never on /Delete this import/, which
    // matches the other branch too and would pass with the two swapped
    expect(
      await screen.findByText(/No transactions belong to it, so nothing leaves your data/),
    ).toBeInTheDocument();
    expect(deletes()).toEqual([]);

    expect(screen.getByRole('button', { name: 'Delete import' })).toHaveClass('action-button--destructive-primary');
    fireEvent.click(screen.getByRole('button', { name: 'Delete import' }));

    expect(
      await screen.findByText('Import deleted — no transactions were removed.'),
    ).toBeInTheDocument();
    expect(countOf('DELETE /api/imports/imp-1')).toBe(1);
  });

  it('deletes nothing when the confirmation is cancelled', async () => {
    // the DELETE route is deliberately absent: a request would trip the afterEach
    // guard as well as failing the assertion below
    mockFetch(BASE);
    const { onChanged } = mount();
    const { trigger, dialog } = await openConfirmation('import');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.getByRole('button', { name: 'Actions for statement.csv' })).toBe(trigger);
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText(/Delete this import and the/)).not.toBeInTheDocument();
    expect(deletes()).toEqual([]);
    expect(requests()).toEqual(['GET /api/imports']);
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe('deleting the stored statement', () => {
  const table = (bytesRemoved: boolean): Routes => ({
    ...BASE,
    'DELETE /api/imports/imp-1/document': () =>
      ok({ deleted: true, importId: 'imp-1', bytesRemoved }),
  });

  it('reports the bytes that went, without touching the import', async () => {
    mockFetch(table(true));
    const { onChanged } = mount();
    await openConfirmation('document');
    expect(await screen.findByText(/only the file goes/)).toBeInTheDocument();
    expect(deletes()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Delete file' }));

    expect(await screen.findByText('The stored statement was deleted.')).toBeInTheDocument();
    expect(screen.queryByText(/^Error:/)).not.toBeInTheDocument();
    expect(countOf('DELETE /api/imports/imp-1/document')).toBe(1);
    // the server is the truth about documentAvailable
    expect(countOf('GET /api/imports')).toBe(2);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('says what happened when there were no bytes, and does not call it a failure', async () => {
    mockFetch(table(false));
    const { onChanged } = mount();
    await openConfirmation('document');
    fireEvent.click(await screen.findByRole('button', { name: 'Delete file' }));

    // false is not a failure, and it is not "your file was deleted" either
    expect(
      await screen.findByText(
        'This import no longer claims a stored file, and there were no bytes to remove.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Error:/)).not.toBeInTheDocument();
    expect(countOf('GET /api/imports')).toBe(2);
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe('record actions and confirmations', () => {
  it('closes on Tab departure without letting the next Escape jump back to the old record', async () => {
    mockFetch(BASE);
    mount();
    const { trigger, group } = await openActions();
    const back = screen.getByRole('button', { name: /Back to accounts/ });
    fireEvent.keyDown(document, { key: 'Tab' });
    act(() => back.focus());
    expect(group).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(fireEvent.keyDown(document, { key: 'Escape' })).toBe(true);
    expect(back).toHaveFocus();
    expect(deletes()).toEqual([]);
  });

  it.each([false, true])('keeps confirmation entry usable after outside-ancestor focus (pointerup: %s)', async (up) => {
    mockFetch(BASE);
    const { container, onChanged } = mount();
    const { group } = await openActions();
    const entry = within(group).getByRole('button', { name: 'Delete import statement.csv' });
    const ancestor = container.querySelector<HTMLElement>('.history-page')!;
    ancestor.tabIndex = -1;
    fireEvent.pointerDown(entry);
    act(() => ancestor.focus());
    if (up) fireEvent.pointerUp(entry);
    expect(entry).toBeInTheDocument();
    fireEvent.click(entry);
    const dialog = screen.getByRole('dialog', { name: 'Delete import?' });
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(deletes()).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(deletes()).toEqual([]);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('uses the explicit Back to Settings label and callback without writing', async () => {
    mockFetch(BASE);
    const { onBack, onChanged } = mount(vi.fn(), 'Back to Settings');
    await screen.findByText('statement.csv');

    expect(screen.queryByRole('button', { name: /Back to accounts/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Back to Settings/ }));

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onChanged).not.toHaveBeenCalled();
    expect(requests()).toEqual(['GET /api/imports']);
  });

  it('opens a named ordinary-button group, not an ARIA menu, and Escape restores its trigger', async () => {
    mockFetch(BASE);
    const { onChanged } = mount();
    const trigger = await screen.findByRole('button', { name: 'Actions for statement.csv' });
    expect(screen.getByRole('button', { name: /Back to accounts/ })).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'Delete import statement.csv' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete the file for statement.csv' })).not.toBeInTheDocument();

    const { group } = await openActions();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveAttribute('aria-controls', group.id);
    expect(trigger).not.toHaveAttribute('aria-haspopup');
    expect(within(group).getAllByRole('button')).toHaveLength(2);
    const file = within(group).getByRole('button', { name: 'Delete the file for statement.csv' });
    expect(file).toHaveAttribute('type', 'button');
    expect(file).toHaveFocus();
    expect(within(group).getByRole('button', { name: 'Delete import statement.csv' }))
      .toHaveAttribute('type', 'button');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
    expect(requests()).toEqual(['GET /api/imports']);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('group', { name: 'Actions for statement.csv' })).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
    expect(deletes()).toEqual([]);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it.each([
    ['import', 'Cancel'],
    ['import', 'Escape'],
    ['document', 'Cancel'],
    ['document', 'Escape'],
  ] as const)('restores the same record after %s confirmation %s', async (kind, dismissal) => {
    mockFetch({
      'GET /api/imports': () => ok(importsResponse([
        importRecord(),
        importRecord({ id: 'imp-2', originalFilename: 'second.csv' }),
      ])),
    });
    const { onChanged } = mount();
    const { trigger, dialog } = await openConfirmation(kind, 'second.csv');
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    expect(cancel).toHaveFocus();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByRole('button', { name: kind === 'document' ? 'Delete file' : 'Delete import' }))
      .toHaveClass('action-button--destructive-primary');
    expect(screen.queryByRole('group', { name: 'Actions for second.csv' })).not.toBeInTheDocument();
    expect(deletes()).toEqual([]);

    if (dismissal === 'Cancel') fireEvent.click(cancel);
    else fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Actions for second.csv' })).toBe(trigger);
    expect(trigger).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Actions for statement.csv' })).not.toHaveFocus();
    expect(requests()).toEqual(['GET /api/imports']);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('releases modality while its screen is hidden and resumes the same confirmation', async () => {
    mockFetch(BASE);
    const onChanged = vi.fn();
    const onBack = vi.fn();
    const view = (shown: boolean) => (
      <ThemeProvider>
        <button type="button">Outside history</button>
        <div className="screen" hidden={!shown}>
          <ScreenShown value={shown}>
            <ImportHistory onBack={onBack} backLabel="Back to accounts" onChanged={onChanged} />
          </ScreenShown>
        </div>
      </ThemeProvider>
    );
    const overflow = document.body.style.overflow;
    const { rerender } = render(view(true));
    const { trigger, dialog } = await openConfirmation('import');
    const outside = screen.getByRole('button', { name: 'Outside history' });
    expect(outside).toHaveAttribute('inert');
    expect(document.body.style.overflow).toBe('hidden');

    rerender(view(false));

    expect(dialog).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(outside).not.toHaveAttribute('inert');
    expect(document.body.style.overflow).toBe(overflow);
    outside.focus();
    expect(outside).toHaveFocus();
    expect(fireEvent.keyDown(document, { key: 'Escape' })).toBe(true);
    expect(fireEvent.keyDown(document, { key: 'Tab' })).toBe(true);

    rerender(view(true));

    expect(screen.getByRole('dialog', { name: 'Delete import?' })).toBe(dialog);
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(outside).toHaveAttribute('inert');
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(trigger).toHaveFocus();
    expect(outside).not.toHaveAttribute('inert');
    expect(document.body.style.overflow).toBe(overflow);
    expect(requests()).toEqual(['GET /api/imports']);
    expect(onBack).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe('mutation recovery', () => {
  it('does not override another record confirmation after a failed removal reload, but Retry can recover', async () => {
    const survivor = importRecord({ id: 'imp-2', originalFilename: 'second.csv' });
    let reads = 0;
    mockFetch({
      'GET /api/imports': () => ++reads === 1 ? ok(importsResponse([importRecord(), survivor]))
        : reads === 2 ? fail(500, { error: 'refresh refused' }) : ok(importsResponse([survivor])),
      'DELETE /api/imports/imp-1': () => ok({ deleted: true, transactions: 12 }),
    });
    mount();
    const first = await openConfirmation('import');
    fireEvent.click(within(first.dialog).getByRole('button', { name: 'Delete import' }));
    await screen.findByText('Import deleted — 12 transactions removed.');
    expect(screen.getByRole('heading', { name: 'Import history' })).toHaveFocus();
    const second = await openConfirmation('import', 'second.csv');
    fireEvent.click(within(second.dialog).getByRole('button', { name: 'Cancel' }));
    expect(second.trigger).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await vi.waitFor(() => expect(screen.queryByRole('article', { name: 'statement.csv' })).not.toBeInTheDocument());
    expect(second.trigger).toHaveFocus();
    expect(deletes()).toEqual(['DELETE /api/imports/imp-1']);
  });

  it('does not steal focus from a surviving record while a removal reload is delayed', async () => {
    const refresh = deferredResponse();
    const survivor = importRecord({ id: 'imp-2', originalFilename: 'second.csv' });
    let reads = 0;
    mockFetch({
      'GET /api/imports': () => ++reads === 1 ? ok(importsResponse([importRecord(), survivor])) : refresh.promise,
      'DELETE /api/imports/imp-1': () => ok({ deleted: true, transactions: 12 }),
    });
    mount();
    const { dialog } = await openConfirmation('import');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete import' }));
    await screen.findByText('Updating import history…');
    const chosen = screen.getByRole('button', { name: 'Download the file for second.csv' });
    chosen.focus();
    await act(async () => refresh.resolve(ok(importsResponse([survivor]))));
    expect(chosen).toHaveFocus();
    expect(deletes()).toEqual(['DELETE /api/imports/imp-1']);
  });
  it.each(['survivor', 'heading'] as const)(
    'waits for the deletion reload before focusing the %s and uses the server removal count', async (target) => {
      const refresh = deferredResponse();
      const survivor = importRecord({ id: 'imp-2', originalFilename: 'second.csv' });
      let reads = 0;
      mockFetch({
        'GET /api/imports': () => ++reads === 1
          ? ok(importsResponse([importRecord(), survivor])) : refresh.promise,
        'DELETE /api/imports/imp-1': () => ok({ deleted: true, transactions: 1 }),
      });
      const { onChanged } = mount();
      const { dialog } = await openConfirmation('import');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete import' }));

      expect(await screen.findByText('Updating import history…')).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.queryByText('Import deleted — 1 transaction removed.')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Actions for second.csv' })).not.toHaveFocus();
      expect(screen.getByRole('heading', { name: 'Import history' })).not.toHaveFocus();
      expect(onChanged).not.toHaveBeenCalled();
      expect(countOf('DELETE /api/imports/imp-1')).toBe(1);
      expect(countOf('GET /api/imports')).toBe(2);

      await act(async () => {
        refresh.resolve(ok(importsResponse(target === 'survivor' ? [survivor] : [])));
      });

      expect(screen.getByText('Import deleted — 1 transaction removed.')).toBeInTheDocument();
      expect(screen.queryByRole('article', { name: 'statement.csv' })).not.toBeInTheDocument();
      expect(screen.queryByText('Updating import history…')).not.toBeInTheDocument();
      const focusTarget = target === 'survivor'
        ? screen.getByRole('button', { name: 'Actions for second.csv' })
        : screen.getByRole('heading', { name: 'Import history' });
      expect(focusTarget).toHaveFocus();
      if (target === 'heading') {
        expect(focusTarget).toHaveAttribute('tabindex', '-1');
        expect(screen.getByText(/Nothing has been imported yet/)).toBeInTheDocument();
      }
      expect(onChanged).toHaveBeenCalledTimes(1);
      expect(countOf('GET /api/imports')).toBe(2);
      expect(deletes()).toEqual(['DELETE /api/imports/imp-1']);
    },
  );

  it('keeps the record identity and trigger after a delayed document deletion reload', async () => {
    const refresh = deferredResponse();
    const record = importRecord({ id: 'imp-2', originalFilename: 'second.csv' });
    let reads = 0;
    mockFetch({
      'GET /api/imports': () => ++reads === 1 ? ok(importsResponse([importRecord(), record])) : refresh.promise,
      'DELETE /api/imports/imp-2/document': () =>
        ok({ deleted: true, importId: 'imp-2', bytesRemoved: true }),
    });
    const { onChanged } = mount();
    await screen.findByText('second.csv');
    const article = screen.getByRole('article', { name: 'second.csv' });
    const identity = within(article).getByRole('heading', { name: 'second.csv' });
    const { trigger, dialog } = await openConfirmation('document', 'second.csv');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete file' }));

    expect(await screen.findByText('Updating import history…')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('The stored statement was deleted.')).not.toBeInTheDocument();
    expect(within(article).getByRole('button', { name: 'Download the file for second.csv' }))
      .toHaveAttribute('aria-disabled', 'true');

    await act(async () => {
      refresh.resolve(ok(importsResponse([importRecord(), { ...record, documentAvailable: false }])));
    });

    expect(screen.getByText('The stored statement was deleted.')).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'second.csv' })).toBe(article);
    expect(within(article).getByRole('heading', { name: 'second.csv' })).toBe(identity);
    expect(screen.getByRole('button', { name: 'Actions for second.csv' })).toBe(trigger);
    expect(trigger).toHaveFocus();
    expect(within(article).getByText('12 rows accepted · 12 transactions belong to this import'))
      .toBeInTheDocument();
    expect(within(article).getByText('No stored file this server can read.')).toBeInTheDocument();
    expect(within(article).queryByRole('button', { name: 'Download the file for second.csv' }))
      .not.toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'statement.csv' })).toBeInTheDocument();
    expect(deletes()).toEqual(['DELETE /api/imports/imp-2/document']);
    expect(countOf('GET /api/imports')).toBe(2);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('retains the list, Retry and the deletion notice when refreshing fails', async () => {
    const survivor = importRecord({ id: 'imp-2', originalFilename: 'second.csv' });
    let reads = 0;
    mockFetch({
      'GET /api/imports': () => {
        reads += 1;
        if (reads === 1) return ok(importsResponse([importRecord(), survivor]));
        if (reads === 2) return fail(500, { error: 'refresh refused' });
        return ok(importsResponse([survivor]));
      },
      'DELETE /api/imports/imp-1': () => ok({ deleted: true, transactions: 3 }),
    });
    const { onChanged } = mount();
    const { dialog } = await openConfirmation('import');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete import' }));

    expect(await screen.findByText('Import deleted — 3 transactions removed.')).toBeInTheDocument();
    const error = screen.getByRole('alert');
    expect(error).toHaveTextContent('History could not be loaded');
    expect(error).toHaveTextContent('refresh refused');
    expect(error).toHaveTextContent('The previously loaded records remain below; this list has not been refreshed.');
    expect(screen.getByRole('article', { name: 'statement.csv' })).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'second.csv' })).toBeInTheDocument();
    expect(screen.queryByText(/Nothing has been imported yet/)).not.toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(countOf('GET /api/imports')).toBe(2);
    const retry = within(error).getByRole('button', { name: 'Retry' });
    expect(retry).toHaveAttribute('aria-disabled', 'false');

    fireEvent.click(retry);

    await vi.waitFor(() => expect(screen.queryByRole('article', { name: 'statement.csv' })).not.toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'second.csv' })).toBeInTheDocument();
    expect(screen.queryByText('Import deleted — 3 transactions removed.')).not.toBeInTheDocument();
    expect(countOf('GET /api/imports')).toBe(3);
    expect(deletes()).toEqual(['DELETE /api/imports/imp-1']);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it.each(['import', 'document'] as const)(
    'keeps a failed %s deletion in its dialog, then only in its record', async (kind) => {
      const route = `DELETE /api/imports/imp-2${kind === 'document' ? '/document' : ''}`;
      mockFetch({
        'GET /api/imports': () => ok(importsResponse([
          importRecord(),
          importRecord({ id: 'imp-2', originalFilename: 'second.csv' }),
        ])),
        [route]: () => fail(500, { error: 'deletion refused' }),
      });
      const { onChanged } = mount();
      const { trigger, dialog } = await openConfirmation(kind, 'second.csv');
      fireEvent.click(within(dialog).getByRole('button', {
        name: kind === 'document' ? 'Delete file' : 'Delete import',
      }));

      expect(await within(dialog).findByRole('alert')).toHaveTextContent('deletion refused');
      const first = screen.getByRole('article', { name: 'statement.csv' });
      const second = screen.getByRole('article', { name: 'second.csv' });
      expect(within(first).queryByRole('alert')).not.toBeInTheDocument();
      expect(within(second).queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getAllByRole('alert')).toHaveLength(1);
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveAttribute('aria-disabled', 'false');

      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(within(second).getByRole('alert')).toHaveTextContent('deletion refused');
      expect(within(first).queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getAllByRole('alert')).toHaveLength(1);
      expect(trigger).toHaveFocus();
      expect(deletes()).toEqual([route]);
      expect(countOf('GET /api/imports')).toBe(1);
      expect(onChanged).not.toHaveBeenCalled();
    },
  );

  it.each(['import', 'document'] as const)(
    'locks dismissal, Back and repeated DELETE while a %s deletion is pending', async (kind) => {
      const write = deferredResponse();
      const route = `DELETE /api/imports/imp-1${kind === 'document' ? '/document' : ''}`;
      let reads = 0;
      mockFetch({
        'GET /api/imports': () => ++reads === 1 ? ok(IMPORTS) : ok(importsResponse(
          kind === 'document' ? [importRecord({ documentAvailable: false })] : [],
        )),
        [route]: () => write.promise,
      });
      const { onBack, onChanged } = mount();
      const { trigger, dialog } = await openConfirmation(kind);
      const label = kind === 'document' ? 'Delete file' : 'Delete import';
      const completion = within(dialog).getByRole('button', { name: label });
      completion.focus();
      fireEvent.click(completion);

      expect(dialog).toHaveAttribute('aria-busy', 'true');
      expect(completion).toHaveClass('action-button--destructive-primary');
      expect(completion).toHaveAttribute('aria-busy', 'true');
      expect(completion).toHaveAttribute('aria-disabled', 'true');
      expect(completion).not.toBeDisabled();
      expect(completion).toHaveFocus();
      expect(completion).toHaveTextContent(label);
      expect(within(dialog).getByRole('button', { name: label })).toBe(completion);
      const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
      const close = within(dialog).getByRole('button', { name: 'Close dialog' });
      const back = screen.getByRole('button', { name: /Back to accounts/ });
      for (const control of [cancel, close, back]) {
        expect(control).toHaveAttribute('aria-disabled', 'true');
        expect(control).not.toBeDisabled();
        fireEvent.click(control);
      }
      fireEvent.keyDown(document, { key: 'Escape' });
      fireEvent.pointerDown(dialog.parentElement!);
      fireEvent.click(dialog.parentElement!);
      fireEvent.click(completion);
      fireEvent.click(completion);

      expect(screen.getByRole('dialog')).toBe(dialog);
      expect(completion).toHaveFocus();
      expect(deletes()).toEqual([route]);
      expect(countOf('GET /api/imports')).toBe(1);
      expect(onBack).not.toHaveBeenCalled();
      expect(onChanged).not.toHaveBeenCalled();

      await act(async () => {
        write.resolve(ok(kind === 'document'
          ? { deleted: true, importId: 'imp-1', bytesRemoved: true }
          : { deleted: true, transactions: 12 }));
      });

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.getByText(kind === 'document'
        ? 'The stored statement was deleted.' : 'Import deleted — 12 transactions removed.'))
        .toBeInTheDocument();
      expect(kind === 'document' ? trigger : screen.getByRole('heading', { name: 'Import history' }))
        .toHaveFocus();
      expect(countOf('GET /api/imports')).toBe(2);
      expect(deletes()).toEqual([route]);
      expect(onBack).not.toHaveBeenCalled();
      expect(onChanged).toHaveBeenCalledTimes(kind === 'document' ? 0 : 1);
      expect(back).toHaveAttribute('aria-disabled', 'false');
    },
  );
});

/**
 * The server filters and totals, and this screen prints what it was
 * sent. Two of the three cases below are about code that is NOT here any more — the
 * client-side filter, and a caveat that used to be unconditional — and both would
 * pass silently if they were written after the change rather than before it.
 */
describe('one account, filtered by the server', () => {
  const ACCOUNT: Account = {
    id: 'acc-1',
    provider: 'upload',
    name: 'Sparkasse Giro',
    currency: 'EUR',
    balance: 1234.5,
    hidden: false,
  };

  const mountFor = (account?: Account) =>
    renderThemed(<ImportHistory onBack={vi.fn()} backLabel="Back to accounts" onChanged={vi.fn()} account={account} />);

  it('asks the server for one account, and for the workspace when there is none', async () => {
    mockFetch(BASE);
    mountFor(ACCOUNT);
    await screen.findByText('statement.csv');

    expect(requestUrls()).toContain('GET /api/imports?accountId=acc-1');
  });

  it('sends no accountId at all for the workspace-wide history', async () => {
    mockFetch(BASE);
    mountFor();
    await screen.findByText('statement.csv');

    // not `?accountId=undefined`, which the server would refuse to match and this
    // screen would render as an empty history for a workspace full of imports
    expect(requestUrls()).toContain('GET /api/imports');
  });

  /**
   * The server is the filter. A row for another account rendering unchanged is what
   * says the client kept none of its own: a second filter here would hide a server
   * that ignored the parameter, leaving the totals as the only symptom.
   */
  it('renders what the server sent, including a row for another account', async () => {
    mockFetch({
      'GET /api/imports': () =>
        ok(
          importsResponse([
            importRecord(),
            importRecord({ id: 'imp-2', accountId: 'acc-2', originalFilename: 'other.csv' }),
          ]),
        ),
    });
    mountFor(ACCOUNT);

    expect(await screen.findByText('statement.csv')).toBeInTheDocument();
    expect(screen.getByText('other.csv')).toBeInTheDocument();
  });

  it('says how many are not listed when the page is short of the total', async () => {
    mockFetch({
      'GET /api/imports': () =>
        ok(
          importsResponse([importRecord(), importRecord({ id: 'imp-2' })], {
            imports: 137,
            documents: 90,
            transactions: 4021,
          }),
        ),
    });
    mountFor(ACCOUNT);

    expect(
      await screen.findByText(
        'Newest first — the most recent 2 of 137. 135 older imports are not listed.',
      ),
    ).toBeInTheDocument();
    // and the page it was sent is still the page it renders
    expect(screen.getAllByText('statement.csv')).toHaveLength(2);
  });

  it('states the order and withholds nothing when the page is the whole of it', async () => {
    // importsResponse derives its totals from the records, so this is the whole page
    mockFetch(BASE);
    mountFor(ACCOUNT);
    await screen.findByText('statement.csv');

    // on the clause and not on the paragraph: the line prints on both arms, so
    // asserting the paragraph is absent would pass on any wording at all
    expect(screen.getByText('Newest first.')).toBeInTheDocument();
    // the withheld count is what this arm may not carry, and the sentence this
    // one replaced said it unconditionally
    expect(screen.queryByText(/not listed/)).toBeNull();
    expect(screen.queryByText(/older ones may not be listed/)).toBeNull();
  });
});
