import { fireEvent, screen } from '@testing-library/react';
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

const mount = (onChanged = vi.fn()) => ({
  onChanged,
  ...renderThemed(<ImportHistory onBack={vi.fn()} onChanged={onChanged} />),
});

const countOf = (key: string): number => requests().filter((r) => r === key).length;

const deletes = (): string[] => requests().filter((r) => r.startsWith('DELETE'));

describe('the list', () => {
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
   * I4 at the call site rather than at the helper: `rowCount` having a singular arm and
   * this line not calling it renders "1 rows accepted", which is the defect itself.
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
    // 007 D5: there is no route to read the staged summary back, so there is nothing
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
    // 010 D15: these are the rows likeliest to still have bytes, and the route was
    // built to reach them. Hidden, the only way left is Delete import — which takes
    // the transactions too, and no purge exists behind it.
    expect(
      screen.getByRole('button', { name: 'Delete the file for statement.csv' }),
    ).toBeInTheDocument();
  });
});

describe('downloading the stored statement', () => {
  it('asks for the document and saves the bytes it got', async () => {
    mockFetch({
      ...BASE,
      'GET /api/imports/imp-1/document': () => new Response('date;amount\n2026-06-01;-10'),
    });
    mount();
    const download = await screen.findByRole('button', {
      name: 'Download the file for statement.csv',
    });
    fireEvent.click(download);

    // the object URL is the subject, and it is built two awaits after the click:
    // waiting on it is the assertion, not a delay before one
    await vi.waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1));
    expect(countOf('GET /api/imports/imp-1/document')).toBe(1);
  });

  it('renders the refusal and writes no file when the document cannot be read', async () => {
    // the backend's own 404 sentence: absent, another workspace's and unreadable are
    // one answer, and it says READ rather than "kept"
    const refusal = 'this import has no document this server can read';
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

    // the panel lists up to a hundred rows: a refusal about row 38 rendered above row 1
    // is a refusal the reader does not see, and from their seat the button did nothing
    const message = await screen.findByText(new RegExp(refusal));
    expect(screen.getByText('second.csv').closest('.row')).toContainElement(message);
  });
});

describe('deleting an import', () => {
  it('issues no DELETE on the first click, and names the count the row owns', async () => {
    mockFetch(BASE);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete import statement.csv' }));

    expect(
      await screen.findByText(/Delete this import and the 12 transactions that belong to it\?/),
    ).toBeInTheDocument();
    expect(screen.getByText(/The account stays too/)).toBeInTheDocument();
    expect(deletes()).toEqual([]);
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
    fireEvent.click(await screen.findByRole('button', { name: 'Delete import statement.csv' }));
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
    fireEvent.click(await screen.findByRole('button', { name: 'Delete import statement.csv' }));

    // anchored on this branch's own sentence and never on /Delete this import/, which
    // matches the other branch too and would pass with the two swapped
    expect(
      await screen.findByText(/No transactions belong to it, so nothing leaves your data/),
    ).toBeInTheDocument();
    expect(deletes()).toEqual([]);

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
    fireEvent.click(await screen.findByRole('button', { name: 'Delete import statement.csv' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    // anchor: the actions are back, which only happens once the confirm closed
    expect(
      await screen.findByRole('button', { name: 'Delete import statement.csv' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Delete this import and the/)).not.toBeInTheDocument();
    expect(deletes()).toEqual([]);
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
    fireEvent.click(await screen.findByRole('button', { name: 'Delete the file for statement.csv' }));
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
    fireEvent.click(await screen.findByRole('button', { name: 'Delete the file for statement.csv' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete file' }));

    // 010 D5: false is not a failure, and it is not "your file was deleted" either
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

/**
 * ROADMAP row 66: the server filters and totals, and this screen prints what it was
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
  };

  const mountFor = (account?: Account) =>
    renderThemed(<ImportHistory onBack={vi.fn()} onChanged={vi.fn()} account={account} />);

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
    // the withheld count is what this arm may not carry, and the sentence row 66
    // replaced said it unconditionally
    expect(screen.queryByText(/not listed/)).toBeNull();
    expect(screen.queryByText(/older ones may not be listed/)).toBeNull();
  });
});
