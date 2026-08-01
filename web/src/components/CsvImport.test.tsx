import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CONFIRMED, DUPLICATE, PRESETS, summaryResult } from '../test/fixtures';
import { mockFetch, ok, renderThemed, requests, Routes } from '../test/harness';
import { CsvImport } from './CsvImport';

/**
 * The import lifecycle, and with it the confirm/discard semantics of ROADMAP 5.3:
 * an upload writes nothing, Confirm is what makes the rows data, and Discard must
 * leave the caller's data alone.
 *
 * No rendered date is asserted anywhere here - the summary carries fmtDay(from) and
 * the duplicate card fmtDate(uploadedAt), and ROADMAP 6.5 changes one of those.
 */

const BASE: Routes = { 'GET /api/imports/presets': () => ok(PRESETS) };

const mount = (onImported = vi.fn()) => ({
  onImported,
  ...renderThemed(<CsvImport onBack={vi.fn()} onImported={onImported} />),
});

/** Pick a file and press Import. The file name is what fills in the account name. */
async function upload(container: HTMLElement): Promise<void> {
  // hidden and unlabelled, so no RTL query reaches it
  const input = container.querySelector('input[type=file]') as HTMLInputElement;
  const file = new File(['date;amount\n2026-06-01;-10'], 'statement.csv', { type: 'text/csv' });
  fireEvent.change(input, { target: { files: [file] } });
  // parks takeFile's async read inside act before the click
  await screen.findByText(/click to choose another/);
  fireEvent.click(screen.getByRole('button', { name: 'Import' }));
}

const countOf = (key: string): number => requests().filter((r) => r === key).length;

describe('the formats the screen offers', () => {
  /** Lets the preset load, and any read takeFile started, finish inside act. */
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

  const fileInput = (container: HTMLElement) =>
    container.querySelector('input[type=file]') as HTMLInputElement;

  it('puts every format the backend reads into the file dialog', async () => {
    mockFetch(BASE);
    const { container } = mount();
    await settle();

    const tokens = (fileInput(container).getAttribute('accept') ?? '').split(',');
    // literals, and split before matching: derived from ACCEPT_TOKENS this would
    // assert nothing, and against the whole attribute a prefix would pass for a token
    expect(tokens).toContain('.csv');
    expect(tokens).toContain('text/csv');
    expect(tokens).toContain('.xlsx');
    expect(tokens).toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(tokens).toContain('.pdf');
    expect(tokens).toContain('application/pdf');
  });

  it('names the PDF on the drop zone and in its accessible name', async () => {
    mockFetch(BASE);
    mount();
    await settle();

    // the format name and not the sentence: stage 8 rewrites this prose, and a
    // pinned sentence would then fail for a reason that is not this one
    const dropzone = await screen.findByRole('button', { name: /pdf/i });
    expect(dropzone).toHaveTextContent(/\.pdf/);
  });

  /**
   * The preview counts lines only for a file it decided is text. That decision
   * becomes routine with PDFs reachable by the button, and nothing pinned it: the
   * CSV half is what proves the read ran at all, so the PDF half cannot pass on a
   * read that never happened and left fileRows null.
   */
  it('shows a CSV its row count and a PDF its size, never a row count', async () => {
    mockFetch(BASE);
    const { container } = mount();
    const preview = () => screen.getByText(/click to choose another/);

    const csv = new File(['date;amount\n2026-06-01;-10'], 'statement.csv', { type: 'text/csv' });
    fireEvent.change(fileInput(container), { target: { files: [csv] } });
    await settle();
    expect(preview()).toHaveTextContent(/1 rows/);

    // several lines on purpose: a build that ignored the %PDF signature would count
    // them, so the assertion below has something to catch
    const pdf = new File(['%PDF-1.7\nobj\nstream\nendobj'], 'statement.pdf', {
      type: 'application/pdf',
    });
    fireEvent.change(fileInput(container), { target: { files: [pdf] } });
    await settle();
    expect(preview()).toHaveTextContent(/kB/);
    expect(preview()).not.toHaveTextContent(/rows/);
  });
});

describe('the summary panel', () => {
  it('reports the counts, says nothing is imported, and names the account', async () => {
    mockFetch({ ...BASE, 'POST /api/imports': () => ok(summaryResult()) });
    const { container } = mount();
    await upload(container);

    // anchor: the summary panel, which exists only once the upload came back
    expect(await screen.findByText(/Read 12 of 14 rows/)).toHaveTextContent(
      /nothing imported yet/,
    );
    expect(screen.getByText(/a new account "statement"/)).toBeInTheDocument();

    expect(screen.queryByText(/are already in the database/)).not.toBeInTheDocument();
    expect(screen.queryByText(/rows couldn't be read/)).not.toBeInTheDocument();
    expect(screen.queryByText(/An earlier upload of this same file/)).not.toBeInTheDocument();
  });

  it('adds the overlap, skipped and superseded sentences when those fields are set', async () => {
    mockFetch({
      ...BASE,
      'POST /api/imports': () =>
        ok(
          summaryResult({
            newRows: 7,
            alreadyPresent: 5,
            skipped: 2,
            supersededImportId: 'imp-0',
          }),
        ),
    });
    const { container } = mount();
    await upload(container);

    expect(await screen.findByText(/Read 12 of 14 rows/)).toBeInTheDocument();
    expect(screen.getByText(/are already in the database/)).toBeInTheDocument();
    expect(screen.getByText(/rows couldn't be read/)).toBeInTheDocument();
    expect(screen.getByText(/An earlier upload of this same file/)).toBeInTheDocument();
  });

  /**
   * The reconciliation line, and the half that matters more: CSV and Excel state no
   * balances at all, which is 100% of imports today. A "couldn't be reconciled"
   * sentence on that path would be a warning about nothing on the common path — the
   * summary fixture carries no `balances`, and the first case above is where its
   * absence is asserted.
   */
  it('names the balances it was checked against, and only when there are any', async () => {
    mockFetch({ ...BASE, 'POST /api/imports': () => ok(summaryResult()) });
    const { container, unmount } = mount();
    await upload(container);
    expect(await screen.findByText(/Read 12 of 14 rows/)).toBeInTheDocument();
    expect(screen.queryByText(/Checked against the statement/)).not.toBeInTheDocument();
    unmount();

    mockFetch({
      ...BASE,
      'POST /api/imports': () =>
        ok(summaryResult({ balances: { opening: 1200, closing: 59.76, currency: 'EUR' } })),
    });
    const second = mount();
    await upload(second.container);
    // the numbers, not the shape: the sentence names two of them and reads the same
    // either way round, so an assertion over its wording alone passes on a card that
    // tells the user their statement began at what it ended with
    expect(await screen.findByText(/Checked against the statement/)).toHaveTextContent(
      /1,200 EUR at the start, 59\.76 EUR at the end\. The rows add up\./,
    );
  });
});

describe('confirm', () => {
  it('requests the confirm once, replaces the summary, and tells the caller once', async () => {
    mockFetch({
      ...BASE,
      'POST /api/imports': () => ok(summaryResult()),
      'POST /api/imports/imp-1/confirm': () => ok(CONFIRMED),
    });
    const { container, onImported } = mount();
    await upload(container);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));

    // anchor: the confirmed panel, which exists only once the confirm came back
    expect(await screen.findByText(/Imported 12 of 12 rows/)).toBeInTheDocument();
    expect(screen.queryByText(/nothing imported yet/)).not.toBeInTheDocument();
    expect(countOf('POST /api/imports/imp-1/confirm')).toBe(1);
    expect(onImported).toHaveBeenCalledTimes(1);
  });
});

describe('discard', () => {
  it('drops the summary and neither confirms nor tells the caller anything landed', async () => {
    // the confirm route is deliberately absent from this table: a confirm request
    // would trip the afterEach guard as well as failing the assertion below
    mockFetch({
      ...BASE,
      'POST /api/imports': () => ok(summaryResult()),
      'POST /api/imports/imp-1/discard': () => ok({ discarded: true, importId: 'imp-1' }),
    });
    const { container, onImported } = mount();
    await upload(container);
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));

    // anchor: the discarded notice, which exists only once the discard came back
    expect(await screen.findByText(/Discarded — nothing was imported/)).toBeInTheDocument();
    expect(screen.queryByText(/nothing imported yet/)).not.toBeInTheDocument();
    expect(countOf('POST /api/imports/imp-1/discard')).toBe(1);
    expect(countOf('POST /api/imports/imp-1/confirm')).toBe(0);
    expect(onImported).not.toHaveBeenCalled();
  });
});

describe('a file that is already in', () => {
  it('says so and offers nothing to confirm or discard', async () => {
    mockFetch({ ...BASE, 'POST /api/imports': () => ok(DUPLICATE) });
    const { container } = mount();
    await upload(container);

    // anchor: the duplicate card, which exists only once the upload came back
    expect(await screen.findByText(/You've already imported this file/)).toBeInTheDocument();
    expect(screen.getByText(/Its 12 rows came in on/)).toBeInTheDocument();

    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Discard' })).not.toBeInTheDocument();
  });
});
