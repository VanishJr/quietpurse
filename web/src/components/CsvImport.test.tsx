import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MAX_ERROR_CHARS } from '../api';
import { fmtDate } from '../format';
import { CONFIRMED, DUPLICATE, PRESETS, summaryResult } from '../test/fixtures';
import { fail, mockFetch, ok, renderThemed, requests, Routes } from '../test/harness';
import { Account, BalancesNotShown } from '../types';
import { CsvImport } from './CsvImport';

/**
 * The import lifecycle, and with it the confirm/discard semantics:
 * an upload writes nothing, Confirm is what makes the rows data, and Discard must
 * leave the caller's data alone.
 *
 * No rendered date is asserted anywhere here but the duplicate card's, which is computed with
 * fmtDate and never written - the summary carries fmtDay(from) and the duplicate card
 * fmtDate(uploadedAt), and how a date is rendered is the copy's to change.
 */

/**
 * The account this screen creates before it uploads. It echoes the name it was sent,
 * because the picker and the summary card both render that name back and a fixed one
 * would have every test asserting against a string it did not type.
 */
const createdAccount = (init?: RequestInit): Response => {
  const { name } = JSON.parse(String(init?.body ?? '{}')) as { name: string };
  return ok({ id: 'acc-9', provider: 'upload', name, currency: 'EUR', balance: 0 }, 201);
};

/**
 * The account list is EMPTY here, and that costs something worth writing down: with
 * no accounts the picker does not render at all and every test mounting through
 * `BASE` runs the *create* arm. So none of them covers the picker — its coverage is
 * the last two describes in this file, both of which serve a populated list in part
 * (four of the seven cases in the last one), plus the confirm case that lands rows
 * in an account this screen did not create.
 *
 * Which is also why the create route is here and not in the tests that are about it:
 * since the upload stopped taking a name the create arm WRITES - it makes the account
 * over `POST /api/accounts` and uploads into it - so every one of these makes two
 * requests where it used to make one, and `acc-9` is the id the summary fixture already
 * names.
 */
const BASE: Routes = {
  'GET /api/imports/presets': () => ok(PRESETS),
  'GET /api/accounts': () => ok([]),
  'POST /api/accounts': createdAccount,
};

/**
 * What GET /api/accounts answers the import screen: visible accounts only, because
 * the server left the hidden ones out and not because this client filtered them.
 * ACCOUNTS itself carries a hidden row, so it is not what this endpoint returns.
 */
const PICKABLE: Account[] = [
  {
    id: 'acc-1',
    provider: 'upload',
    name: 'Sparkasse Giro',
    currency: 'EUR',
    balance: 1234.5,
    hidden: false,
  },
  { id: 'acc-3', provider: 'upload', name: 'N26', currency: 'EUR', balance: 40, hidden: false },
];

const ACCOUNT_ROUTES: Routes = { ...BASE, 'GET /api/accounts': () => ok(PICKABLE) };

const mount = (
  onImported = vi.fn(),
  { onAccountCreated = vi.fn(), onBack = vi.fn(), baseCurrency = 'EUR' as string | null } = {},
) => ({
  onImported,
  onAccountCreated,
  onBack,
  ...renderThemed(
    <CsvImport
      onBack={onBack}
      onImported={onImported}
      onAccountCreated={onAccountCreated}
      baseCurrency={baseCurrency}
    />,
  ),
});

const chooseFile = (container: HTMLElement, name = 'statement.csv'): void => {
  // hidden and unlabelled, so no RTL query reaches it
  const input = container.querySelector('input[type=file]') as HTMLInputElement;
  const file = new File(['date;amount\n2026-06-01;-10'], name, { type: 'text/csv' });
  fireEvent.change(input, { target: { files: [file] } });
};

/**
 * Pick a file, name the account, press Import. The name is typed rather than left to
 * the file: the prefill that used to fill it in is gone (it is how a database
 * acquired an account called "account-statement_2026-07-01…_ru_a1b2c3 — копия").
 *
 * On `BASE` this creates the account as well as uploading — one press, two requests.
 */
async function upload(container: HTMLElement): Promise<void> {
  chooseFile(container);
  // awaits the accounts load as well as parking takeFile's read: with `accounts`
  // still null neither the picker nor the create arm has rendered
  const name = await screen.findByPlaceholderText('Sparkasse Giro');
  fireEvent.change(name, { target: { value: 'statement' } });
  await screen.findByRole('button', { name: 'Choose another CSV, Excel or PDF statement file' });
  fireEvent.click(screen.getByRole('button', { name: 'Import' }));
}

/**
 * Choose "+ New account", type a name, choose a file. Import is not pressed. Needs a
 * populated list, since it is the picker that offers the way into the create arm.
 */
const fillCreateArm = async (container: HTMLElement, name: string): Promise<void> => {
  fireEvent.click(await screen.findByRole('button', { name: '+ New account' }));
  fireEvent.change(screen.getByPlaceholderText('Sparkasse Giro'), { target: { value: name } });
  chooseFile(container);
  await screen.findByRole('button', { name: 'Choose another CSV, Excel or PDF statement file' });
};

const openPresets = (): void => {
  fireEvent.click(screen.getByText('Statement preset (optional)'));
};

const returnToSetup = async (name = 'Start another import'): Promise<void> => {
  const button = await screen.findByRole('button', { name });
  await vi.waitFor(() => expect(button).not.toHaveAttribute('aria-disabled', 'true'));
  fireEvent.click(button);
  expect(screen.getByRole('heading', { name: 'Set up your import' })).toHaveFocus();
};

const countOf = (key: string): number => requests().filter((r) => r === key).length;

describe('the Import page foundation', () => {
  it('opens with a short device-local introduction and three separate guidance items', () => {
    mockFetch(BASE);
    mount();

    expect(screen.getByRole('heading', { level: 1, name: 'Import a statement' })).toBeInTheDocument();
    expect(screen.getByText('Bring in a CSV, Excel or PDF statement. Finto reads it on this device.'))
      .toBeInTheDocument();

    const setup = screen.getByRole('region', { name: 'Set up your import' });
    expect(within(setup).getByRole('button', { name: /choose a CSV, Excel or PDF/i })).toBeInTheDocument();
    expect(within(setup).getByRole('button', { name: 'Import' })).toBeInTheDocument();

    const guide = screen.getByRole('complementary', { name: 'Before you import' });
    expect(within(guide).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Getting the file', 'Your file stays here', 'Re-imports are safe',
    ]);
    expect(guide).toHaveTextContent(/Export or Download.*PDF.*CSV or Excel export/s);
    expect(guide).toHaveTextContent(/read on this device.*file and its rows stay in your Finto folder/s);
    expect(guide).toHaveTextContent(/matched by content.*wider date range/s);
    expect(within(guide).getAllByRole('paragraph').map((p) => p.textContent?.trim())).toEqual([
      "In your bank's transaction list, choose Export or Download. Finto can read a PDF only if it recognises the layout; otherwise, use the CSV or Excel export.",
      'Statements are read on this device. The file and its rows stay in your Finto folder.',
      "Rows are matched by content, so re-importing won't duplicate them. You can safely export a wider date range than you need.",
    ]);
  });

  it('makes review the only decision after reading, with immutable source context', async () => {
    mockFetch({ ...BASE, 'POST /api/imports': () => ok(summaryResult()) });
    const { container } = mount();
    await upload(container);

    const result = await screen.findByRole('region', { name: 'Import review or result' });
    expect(within(result).getByText(/nothing imported yet/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Set up your import' })).not.toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Before you import' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Import' })).not.toBeInTheDocument();
    expect(container.querySelector('input[type=file]')).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Statement contents', hidden: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Account for this import', hidden: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Statement preset', hidden: true })).not.toBeInTheDocument();
    const context = result.querySelector('.import-source-context')!;
    expect(context).toHaveTextContent('Filestatement.csvDestinationstatement');
    expect(screen.getByRole('button', { name: 'Confirm import' })).toHaveClass('action-button--primary');
    expect(screen.getByRole('button', { name: 'Discard' })).toHaveClass('action-button--secondary');
    expect(screen.getByRole('button', { name: /Back to accounts/ })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByRole('button', { name: 'Start another import' })).not.toBeInTheDocument();
    expect(screen.getByText('To change the source or destination, discard this review first.')).toBeInTheDocument();
  });
});

describe('the setup steps', () => {
  it('keeps destination explicit and moves presets into an optional disclosure', async () => {
    mockFetch(ACCOUNT_ROUTES);
    mount();
    await screen.findByRole('button', { name: 'N26' });

    const setup = screen.getByRole('region', { name: 'Set up your import' });
    expect(within(setup).getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent))
      .toEqual(['Choose a file', 'Account']);
    const steps = [...setup.querySelectorAll<HTMLElement>('.import-step')];
    expect(within(steps[0]).getByText('…or paste the contents instead')).toBeInTheDocument();
    expect(within(steps[1]).getByRole('group', { name: 'Account for this import' })).toBeInTheDocument();
    expect(within(steps[1]).getByText("Choose where this statement's transactions belong.")).toBeInTheDocument();
    expect(within(steps[1]).getByText("Hidden accounts aren't listed here — unhide one first."))
      .toBeInTheDocument();
    expect(screen.getByText('No transactions are added until you review and confirm.')).toBeInTheDocument();
    const disclosure = screen.getByText('Statement preset (optional)').closest('details')!;
    expect(disclosure).not.toHaveAttribute('open');
    expect(disclosure.querySelector('[aria-label="Statement preset"]')).toBeInTheDocument();
    openPresets();
    expect(within(disclosure).getByRole('group', { name: 'Statement preset' })).toBeInTheDocument();
    expect(within(disclosure).getByText(
      'Pick your bank if it\'s listed. "Any statement" reads the header and finds the date, amount and description columns on its own — try it first.',
    )).toBeInTheDocument();
  });

  it('shows every server preset with Any statement initially pressed', async () => {
    const choices = [
      ...PRESETS.presets,
      ...Array.from({ length: 8 }, (_, i) => ({ key: `bank-${i}`, title: `Bank ${i} statement` })),
    ];
    mockFetch({ ...BASE, 'GET /api/imports/presets': () => ok({ presets: choices }) });
    mount();
    openPresets();
    const group = screen.getByRole('group', { name: 'Statement preset' });
    await screen.findByRole('button', { name: choices.at(-1)!.title });
    expect(within(group).getAllByRole('button').map((button) => button.textContent))
      .toEqual(choices.map((choice) => choice.title));
    expect(within(group).getByRole('button', { name: choices[0].title }))
      .toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: /show more/i })).not.toBeInTheDocument();
  });

  it('requires both input and destination; paste can replace the file', async () => {
    mockFetch(ACCOUNT_ROUTES);
    const { container } = mount();
    const destination = await screen.findByRole('button', { name: 'N26' });
    const submit = screen.getByRole('button', { name: 'Import' });
    expect(submit).toBeDisabled();
    chooseFile(container);
    await screen.findByRole('button', { name: 'Choose another CSV, Excel or PDF statement file' });
    expect(submit).toBeDisabled();
    fireEvent.click(destination);
    expect(submit).toBeEnabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Statement contents', hidden: true }), {
      target: { value: 'date;amount\n2026-06-01;-10' },
    });
    expect(screen.getByRole('button', { name: 'Choose a CSV, Excel or PDF statement file' }))
      .toBeInTheDocument();
    expect(submit).toBeEnabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Statement contents', hidden: true }), {
      target: { value: '  ' },
    });
    expect(submit).toBeDisabled();
  });

  it('identifies the reading file and destination, locks Back, and removes conflicting inputs', async () => {
    let answer!: (response: Response) => void;
    mockFetch({ ...ACCOUNT_ROUTES, 'POST /api/imports': () => new Promise((resolve) => { answer = resolve; }) });
    const { container } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'N26' }));
    chooseFile(container);
    await screen.findByRole('button', { name: 'Choose another CSV, Excel or PDF statement file' });
    const submit = screen.getByRole('button', { name: 'Import' });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(countOf('POST /api/imports')).toBe(1);
    const reading = screen.getByRole('region', { name: 'Reading statement' });
    expect(reading).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('heading', { name: 'Reading statement' })).toHaveFocus();
    expect(reading).toHaveTextContent('Filestatement.csvDestinationN26');
    expect(within(reading).getByRole('status')).toHaveTextContent('Reading the file… No transactions are added yet.');
    expect(screen.getByRole('button', { name: /Back to accounts/ })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByRole('button', { name: /Choose.*statement file/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Statement contents', hidden: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Account for this import', hidden: true })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Statement preset', hidden: true })).not.toBeInTheDocument();
    expect(container.querySelector('input[type=file]')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Set up your import' })).not.toBeInTheDocument();
    await act(async () => answer(ok(summaryResult({ accountId: 'acc-3', accountName: 'N26' }))));
    expect(await screen.findByRole('button', { name: 'Confirm import' })).toBeEnabled();
    expect(screen.queryByRole('region', { name: 'Reading statement' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Import review or result' })).toHaveTextContent('DestinationN26');
  });
});

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

    // the format name and not the sentence: the sentence is copy that is expected to
    // change, and a pinned sentence would then fail for a reason that is not this one
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
    const preview = () => screen.getByRole('button', { name: 'Choose another CSV, Excel or PDF statement file' });

    const csv = new File(['date;amount\n2026-06-01;-10'], 'statement.csv', { type: 'text/csv' });
    fireEvent.change(fileInput(container), { target: { files: [csv] } });
    await settle();
    expect(preview()).toHaveTextContent('1 rows · 1 kB');

    // several lines on purpose: a build that ignored the %PDF signature would count
    // them, so the assertion below has something to catch
    const pdf = new File(['%PDF-1.7\nobj\nstream\nendobj'], 'statement.pdf', {
      type: 'application/pdf',
    });
    fireEvent.change(fileInput(container), { target: { files: [pdf] } });
    await settle();
    expect(preview()).toHaveTextContent('1 kB');
    expect(preview()).not.toHaveTextContent(/rows/);
  });

  it('uses a native button with a decorative icon and opens the same picker on click', () => {
    mockFetch(BASE);
    const { container } = mount();
    const picker = screen.getByRole('button', { name: 'Choose a CSV, Excel or PDF statement file' });
    expect(picker).toBeInstanceOf(HTMLButtonElement);
    expect(picker).toHaveAttribute('type', 'button');
    expect(picker.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    const input = fileInput(container);
    const click = vi.spyOn(input, 'click');
    picker.focus();
    expect(picker).toHaveFocus();
    fireEvent.click(picker);
    expect(click).toHaveBeenCalledOnce();
  });

  it('distinguishes drag-over from an empty or selected file without replacing the target', async () => {
    mockFetch(BASE);
    const { container } = mount();
    const picker = screen.getByRole('button', { name: 'Choose a CSV, Excel or PDF statement file' });
    expect(picker).toHaveClass('import-dropzone');
    expect(picker).not.toHaveClass('import-dropzone-active', 'import-dropzone-selected');
    fireEvent.dragOver(picker);
    expect(picker).toHaveClass('import-dropzone-active');
    fireEvent.dragLeave(picker);
    expect(picker).not.toHaveClass('import-dropzone-active');

    const csv = new File(['date;amount\n2026-06-01;-10'], 'statement.csv', { type: 'text/csv' });
    fireEvent.drop(picker, { dataTransfer: { files: [csv] } });
    await settle();
    expect(picker).toHaveClass('import-dropzone-selected');
    expect(picker).not.toHaveClass('import-dropzone-active');
    expect(fileInput(container).getAttribute('accept')).toContain('.csv');
    expect(screen.getByText('Click to choose another').closest('button')).toBe(picker);
    expect(picker.querySelector('a, button')).toBeNull();
  });

  it('shows a long file name whole and marks only the empty status as an error', async () => {
    mockFetch(BASE);
    const { container } = mount();
    const name = 'statement-' + 'very-long-name-'.repeat(10) + '.csv';
    fireEvent.change(fileInput(container), {
      target: { files: [new File(['date;amount\n2026-06-01;-10'], name, { type: 'text/csv' })] },
    });
    await settle();
    const picker = screen.getByRole('button', { name: 'Choose another CSV, Excel or PDF statement file' });
    expect(picker).toHaveAttribute('aria-describedby', screen.getByText(name).parentElement!.id);
    expect(screen.getByText(name)).toHaveClass('import-file-name');
    expect(screen.getByText(name)).toHaveTextContent(name);
    expect(picker).toHaveTextContent('1 rows · 1 kB');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    fireEvent.change(fileInput(container), {
      target: { files: [new File([], 'empty.csv', { type: 'text/csv' })] },
    });
    await settle();
    expect(picker).toHaveTextContent('0 rows · 0 kB');
    expect(screen.getByRole('status')).toHaveClass('import-file-empty');
    expect(screen.getByRole('status')).toHaveTextContent('Empty file');
    expect(picker).not.toHaveClass('import-file-empty');
  });

  it('does not label a newer binary file with the earlier text file\'s late row count', async () => {
    mockFetch(BASE);
    const { container } = mount();
    let release!: (text: string) => void;
    const stalled = new Promise<string>((resolve) => { release = resolve; });
    const first = new File(['date;amount\n2026-06-01;-10'], 'first.csv', { type: 'text/csv' });
    const read = vi.fn(() => stalled);
    Object.defineProperty(first, 'text', { value: read });
    fireEvent.change(fileInput(container), { target: { files: [first] } });
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());

    const next = new File(['%PDF-1.7\nobj'], 'next.pdf', { type: 'application/pdf' });
    fireEvent.change(fileInput(container), { target: { files: [next] } });
    await settle();
    await act(async () => release('date;amount\n2026-06-01;-10\n2026-06-02;-20'));
    const picker = screen.getByRole('button', { name: 'Choose another CSV, Excel or PDF statement file' });
    expect(picker).toHaveTextContent('next.pdf');
    expect(picker).toHaveTextContent('1 kB');
    expect(picker).not.toHaveTextContent(/rows/);
  });
});

describe('the paste fallback', () => {
  it('starts collapsed and replaces the file only after explicitly discarding the review', async () => {
    mockFetch({ ...BASE, 'POST /api/imports': () => ok(summaryResult()),
      'POST /api/imports/imp-1/discard': () => ok({ discarded: true, importId: 'imp-1' }),
    });
    const { container } = mount();
    const disclosure = screen.getByText('…or paste the contents instead').closest('details')!;
    expect(disclosure).not.toHaveAttribute('open');
    expect(disclosure.querySelector('summary')).toBeInstanceOf(HTMLElement);
    fireEvent.click(disclosure.querySelector('summary')!);
    expect(disclosure).toHaveAttribute('open');
    expect(within(disclosure).getByText('Pasting here replaces the chosen file.')).toBeInTheDocument();

    await upload(container);
    expect(await screen.findByText(/Read 12 of 14 rows/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Statement contents', hidden: true })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await returnToSetup();
    fireEvent.click(screen.getByText('…or paste the contents instead'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Statement contents' }), {
      target: { value: 'date;amount\n2026-06-01;-10' },
    });
    expect(screen.getByRole('button', { name: 'Choose a CSV, Excel or PDF statement file' }))
      .not.toHaveTextContent('statement.csv');
    expect(screen.queryByText(/Read 12 of 14 rows/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled();
  });
});

describe('the summary panel', () => {
  const details = async () => within((await screen.findByRole('heading', { name: 'Details' })).parentElement as HTMLElement);
  it('reports the counts, says nothing is imported, and names the account', async () => {
    mockFetch({ ...BASE, 'POST /api/imports': () => ok(summaryResult()) });
    const { container } = mount();
    await upload(container);

    // anchor: the summary panel, which exists only once the upload came back
    const heading = await screen.findByRole('heading', { name: /Read 12 of 14 rows/ });
    expect(heading).toHaveTextContent(/nothing imported yet/);
    expect(heading).toHaveFocus();
    expect(heading).toHaveAttribute('tabindex', '-1');
    // an upload goes to an account that already exists, so the sentence has one arm:
    // the name arm is retired, on the wire as well as here
    expect(screen.getByText(/your existing "statement"/)).toBeInTheDocument();

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
            unreadable: 2,
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
   * The whole reason the count is split by cause: the card used to print `skipped` under
   * one cause, above the backend's own line saying those same rows were read perfectly
   * and dropped by a rule. Every sentence on the card is asserted, in order, so a second
   * count of the filtered rows fails here as loudly as a missing one.
   *
   * Three DIFFERENT values, because a sentence reading the wrong bucket renders
   * identically when they match.
   */
  it('gives each reason a row was dropped its own sentence, and the filtered rows one', async () => {
    mockFetch({
      ...BASE,
      'POST /api/imports': () =>
        ok(
          summaryResult({
            accepted: 8,
            newRows: 6,
            alreadyPresent: 2,
            skipped: 6,
            unreadable: 2,
            filtered: 3,
            noMovement: 1,
            balances: { opening: 1200, closing: 59.76, currency: 'EUR' },
            supersededImportId: 'imp-0',
            problems: [
              '3 rows skipped: the "State" value is not one of the accepted ones - "В ОБРАБОТКЕ" (3)',
            ],
          }),
        ),
    });
    const { container } = mount();
    await upload(container);

    const card = (await screen.findByText(/Read 8 of 14 rows/)).closest('.import-review') as HTMLElement;
    expect([...card.querySelectorAll('.import-review-reader, .import-review-details p, .import-review-warnings p')]
      .map((p) => p.textContent)).toEqual([
      'Read by "Any statement", which found the columns in the file\'s own header — date from "Datum", amount from "Betrag", description from "Verwendungszweck".',
      'They\'ll join your existing "statement".',
      "Checked against the statement's own balances: 1,200 EUR at the start, 59.76 EUR at the end. The rows add up.",
      '6 of them are new; 2 are already in the database — this export overlaps one you imported before. Nothing will be duplicated.',
      'An earlier upload of this same file was still waiting to be confirmed. It has been dropped in favour of this one — it had imported nothing.',
      "2 rows couldn't be read. If it's the whole file, the column layout is probably wrong — discard this and try your bank's optional preset in setup.",
      '1 row moved no money, so there was nothing to import.',
      '3 rows skipped: the "State" value is not one of the accepted ones - "В ОБРАБОТКЕ" (3)',
    ]);
    expect([...card.querySelectorAll('.import-review-metric-label')].map((m) => m.textContent))
      .toEqual(['Rows', 'New rows', 'Already present', 'Omitted', 'Period', 'Net', 'Statement balance']);
    expect([...card.querySelectorAll('.import-review-metric-value')].map((m) => m.textContent?.trim()))
      .toEqual(['8 of 14', '6', '2', '6', '01.06.2026 to 30.06.2026', '−420.50 EUR', '1,200 EUR → 59.76 EUR']);
    // the pre-fix render, and the one the backend's line contradicts word for word
    expect(screen.queryByText(/6 rows couldn't be read/)).not.toBeInTheDocument();
  });

  /**
   * The plural at the boundary that made this a defect: "1 rows couldn't be read" shipped
   * for a fortnight. Both client sentences at n = 1, because a correct helper with one
   * call site not using it is the defect itself.
   */
  it('separates mixed-currency totals in text as well as in visual lines', async () => {
    mockFetch({
      ...BASE,
      'POST /api/imports': () => ok(summaryResult({
        totals: [{ currency: 'EUR', net: -420.5 }, { currency: 'USD', net: 115.25 }],
      })),
    });
    const { container } = mount();
    await upload(container);
    const card = await screen.findByRole('heading', { name: /Read 12 of 14 rows/ });
    const net = card.closest('.import-review')!.querySelector('.import-review-net')!;
    expect(net.textContent).toBe('−420.50 EUR ·\n115.25 USD');
  });

  it('says one row rather than 1 rows, in every sentence that counts rows', async () => {
    mockFetch({
      ...BASE,
      'POST /api/imports': () =>
        ok(summaryResult({ accepted: 12, skipped: 2, unreadable: 1, noMovement: 1 })),
    });
    const { container } = mount();
    await upload(container);

    expect(await screen.findByText(/^1 row couldn't be read\./)).toBeInTheDocument();
    expect(screen.getByText('1 row moved no money, so there was nothing to import.')).toBeInTheDocument();
  });

  /**
   * The card's own claim about which reader produced every number
   * under it, so its POSITION is asserted and not just its presence: below the date
   * range it would qualify nothing.
   *
   * Two arms, not one: the fixture's default is auto-detected, so every other case in
   * this file renders that arm and only that arm. The pdf-template arm is the one a
   * chip cannot decide, and the preset arm is where the title on the card
   * is asserted to be the string the chip itself renders.
   */
  it('names the reader above the numbers it qualifies, for a preset and for a PDF', async () => {
    mockFetch({
      ...BASE,
      'POST /api/imports': () =>
        ok(
          summaryResult({
            readAs: {
              kind: 'preset',
              preset: 'revolut',
              title: 'Revolut (Statement CSV)',
              columns: { date: 'Дата выполнения', amount: 'Сумма', description: ['Описание'] },
            },
          }),
        ),
    });
    const { container, unmount } = mount();
    openPresets();
    const presetButton = await screen.findByRole('button', { name: 'Revolut (Statement CSV)' });
    expect(presetButton).toBeInTheDocument();
    await upload(container);

    const line = await screen.findByText(/Read with the "Revolut \(Statement CSV\)" preset/);
    expect(line).toHaveTextContent(/date from "Дата выполнения"/);
    // the chip's own label and the summary's title are one string, off one backend
    // list — a second dictionary in this package is what the field exists to avoid
    expect(line).toHaveTextContent(presetButton.textContent!);
    // directly beneath the heading, before even the first metric
    const card = line.closest('.import-review') as HTMLElement;
    expect(card.querySelector('.import-review-reader')).toBe(line);
    expect(line.previousElementSibling).toBe(card.querySelector('.import-review-heading'));
    expect(line.compareDocumentPosition(card.querySelector('.import-review-metrics')!)
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    unmount();

    mockFetch({
      ...BASE,
      'POST /api/imports': () =>
        ok(summaryResult({ readAs: { kind: 'pdf-template', title: 'Revolut' } })),
    });
    const second = mount();
    await upload(second.container);
    expect(await screen.findByText(/Read as a Revolut PDF statement/)).toHaveTextContent(
      /a PDF has no column header/,
    );
    // no column is named for a document that has no header to name one from
    expect(screen.queryByText(/date from "/)).not.toBeInTheDocument();
  });

  /**
   * The reconciliation line, and the half that matters more: a file that states no
   * balance of any kind gets no sentence at all — neither a pair nor a reason. The
   * summary fixture carries neither field, and the first case above is where the
   * pair's absence is asserted.
   */
  it('names the balances it was checked against, and only when there are any', async () => {
    mockFetch({ ...BASE, 'POST /api/imports': () => ok(summaryResult()) });
    const { container, unmount } = mount();
    await upload(container);
    expect(await screen.findByText(/Read 12 of 14 rows/)).toBeInTheDocument();
    expect(screen.queryByText(/Checked against the statement/)).not.toBeInTheDocument();
    expect(screen.queryByText(/running balance/)).not.toBeInTheDocument();
    expect(screen.queryByText('Statement balance')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Warnings' })).not.toBeInTheDocument();
    const card = screen.getByRole('heading', { name: /Read 12 of 14 rows/ }).closest('.import-review')!;
    expect([...card.querySelectorAll('.import-review-metric-label')].map((m) => m.textContent))
      .toEqual(['Rows', 'New rows', 'Already present', 'Omitted', 'Period', 'Net']);
    expect([...card.querySelectorAll('.import-review-reader, .import-review-details p')]
      .map((p) => p.textContent)).toEqual([
      'Read by "Any statement", which found the columns in the file\'s own header — date from "Datum", amount from "Betrag", description from "Verwendungszweck".',
      'They\'ll join your existing "statement".',
    ]);
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
    expect((await details()).getByText(/Checked against the statement/)).toHaveTextContent(
      /1,200 EUR at the start, 59\.76 EUR at the end\. The rows add up\./,
    );
    const metric = screen.getByText('Statement balance').closest('.import-review-metric')!;
    expect(metric).toHaveTextContent(/1,200 EUR → 59\.76 EUR/);
    expect(metric).not.toHaveTextContent(/The rows add up/);
    expect(screen.getAllByText(/Checked against the statement/)).toHaveLength(1);
  });

  /**
   * A pair derived from the file's own running balances is a different sentence, and
   * it has to be: on the real two-product export neither number appears in any cell,
   * so a card saying "the statement's own balances: 387.40" sends the user to compare
   * it against a column that reads 134.85. And the closing claim shrinks — both ends
   * come out of these same rows, so a row lost from either END moves an end rather
   * than breaking the run, and "the rows add up" would be a completeness claim the
   * check cannot make.
   */
  it('says how many running balances a derived pair was summed from', async () => {
    mockFetch({
      ...BASE,
      'POST /api/imports': () =>
        ok(
          summaryResult({
            balances: {
              opening: 387.40,
              closing: 579.85,
              currency: 'EUR',
              series: { summed: 2, checked: 2 },
            },
          }),
        ),
    });
    const { container, unmount } = mount();
    await upload(container);
    expect((await details()).getByText(/2 running balances/)).toHaveTextContent(
      /added together: 387\.40 EUR at the start, 579\.85 EUR at the end\. The rows read run unbroken from one to the other\./,
    );
    const metric = screen.getByText('Statement balance').closest('.import-review-metric')!;
    expect(metric).toHaveTextContent(/Combined from 2 running balances in the file\. 387\.40 EUR → 579\.85 EUR/);
    expect(screen.getAllByText(/Checked against the 2 running balances/)).toHaveLength(1);
    expect(screen.queryByText(/The rows add up/)).not.toBeInTheDocument();
    unmount();

    // one series states the pair plainly, and still makes only the claim it checked
    mockFetch({
      ...BASE,
      'POST /api/imports': () =>
        ok(
          summaryResult({
            balances: {
              opening: 72.40,
              closing: 134.85,
              currency: 'EUR',
              series: { summed: 1, checked: 1 },
            },
          }),
        ),
    });
    const single = mount();
    await upload(single.container);
    expect((await details()).getByText(/Checked against the statement/)).toHaveTextContent(
      /72\.40 EUR at the start, 134\.85 EUR at the end\. The rows read run unbroken from one to the other\./,
    );
    expect(screen.getByText('Statement balance').closest('.import-review-metric'))
      .toHaveTextContent(/From a running balance in the file\. 72\.40 EUR → 134\.85 EUR/);
    expect(screen.queryByText(/running balances/)).not.toBeInTheDocument();
  });

  /**
   * The reason the count above was half the truth: a running balance of a
   * single row is one link, and one link cannot break. The pair is still shown — it is
   * true, and the closing of a one-row run is a cell the user can find — and the claim
   * shrinks to the runs the check could have failed on. On the owner's real export
   * that is one of two, and the unchecked one is four fifths of both numbers here.
   */
  it('names the part of a derived pair that nothing could check', async () => {
    mockFetch({
      ...BASE,
      'POST /api/imports': () =>
        ok(
          summaryResult({
            balances: {
              opening: 387.40,
              closing: 579.85,
              currency: 'EUR',
              series: { summed: 2, checked: 1 },
            },
          }),
        ),
    });
    const { container } = mount();
    await upload(container);
    expect((await details()).getByText(/2 running balances/)).toHaveTextContent(
      /added together: 387\.40 EUR at the start, 579\.85 EUR at the end\. 1 of them runs unbroken from one to the other; the other states a single row, so nothing could check it\./,
    );
    const metric = screen.getByText('Statement balance').closest('.import-review-metric')!;
    expect(metric).toHaveTextContent(/Combined from 2 running balances in the file\. 387\.40 EUR → 579\.85 EUR/);
    expect(metric).not.toHaveTextContent(/Checked against|nothing could check/);
    expect(screen.getAllByText(/Checked against the 2 running balances/)).toHaveLength(1);
    // the unqualified claim, which is true of neither of these two numbers
    expect(screen.queryByText(/The rows read run unbroken/)).not.toBeInTheDocument();
  });

  /**
   * And where every run is a single row, nothing ran: the lead-in gives way with the
   * claim, because "Checked against" in front of a pair nothing checked re-acquires
   * the completeness claim through the front of the sentence while the back of it
   * disclaims it. The numbers stay — they are what the file states.
   */
  it('claims no run at all for a statement whose every run is one row', async () => {
    mockFetch({
      ...BASE,
      'POST /api/imports': () =>
        ok(
          summaryResult({
            balances: {
              opening: 387.40,
              closing: 511.72,
              currency: 'EUR',
              series: { summed: 2, checked: 0 },
            },
          }),
        ),
    });
    const { container, unmount } = mount();
    await upload(container);
    expect((await details()).getByText(/2 running balances/)).toHaveTextContent(
      /Read from the 2 running balances this statement states, added together: 387\.40 EUR at the start, 511\.72 EUR at the end\. Each of them states a single row, so nothing here was checked\./,
    );
    const metric = screen.getByText('Statement balance').closest('.import-review-metric')!;
    expect(metric).toHaveTextContent(/Combined from 2 running balances in the file\. 387\.40 EUR → 511\.72 EUR/);
    expect(metric).not.toHaveTextContent(/checked/);
    expect(screen.getAllByText(/Read from the 2 running balances/)).toHaveLength(1);
    expect(screen.queryByText(/run unbroken/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Checked against/)).not.toBeInTheDocument();
    unmount();

    // the degenerate one: one row, one running balance, and no second balance anywhere
    // in the file for it to have been compared against
    mockFetch({
      ...BASE,
      'POST /api/imports': () =>
        ok(
          summaryResult({
            balances: {
              opening: 72.40,
              closing: 66.72,
              currency: 'EUR',
              series: { summed: 1, checked: 0 },
            },
          }),
        ),
    });
    const single = mount();
    await upload(single.container);
    expect((await details()).getByText(/Read from the statement/)).toHaveTextContent(
      /72\.40 EUR at the start, 66\.72 EUR at the end\. It states a single row, so nothing here was checked\./,
    );
    expect(screen.getByText('Statement balance').closest('.import-review-metric'))
      .toHaveTextContent(/From a running balance in the file\. 72\.40 EUR → 66\.72 EUR/);
    expect(screen.queryByText(/run unbroken/)).not.toBeInTheDocument();
    expect(screen.queryByText(/running balances/)).not.toBeInTheDocument();
  });

  /**
   * The third state, which must not spell like the first: a file that DOES print a
   * running balance and got no pair out of it says why. One case per slug, because a
   * missing entry in the dictionary renders a blank line rather than failing.
   */
  it('says why a file that states a running balance shows no pair', async () => {
    const cases: [BalancesNotShown, RegExp][] = [
      ['rows-outside-the-balance', /also covers rows that weren't imported/],
      ['rows-without-a-balance', /state no running balance/],
      // "a running balance", never "this file's": one series closing on itself
      // suppresses the pair for a file whose other series did move
      ['balance-closes-on-itself', /A running balance in this file ends where it began/],
      ['more-than-one-currency', /running balance per currency/],
    ];
    for (const [slug, sentence] of cases) {
      mockFetch({
        ...BASE,
        'POST /api/imports': () => ok(summaryResult({ balancesNotShown: slug })),
      });
      const { container, unmount } = mount();
      await upload(container);
      expect(await screen.findByText(sentence)).toBeInTheDocument();
      expect(screen.queryByText('Statement balance')).not.toBeInTheDocument();
      expect(screen.getAllByText(/^(Rows|Period|Net)$/)).toHaveLength(3);
      // and never a pair alongside the reason it could not be derived
      expect(screen.queryByText(/at the start,/)).not.toBeInTheDocument();
      unmount();
    }
  });

  it('keeps all parser warnings whole and before confirmation, without treating them as fatal', async () => {
    const longProblem = 'Unrecognised column value '.repeat(45).trim();
    mockFetch({
      ...BASE,
      'POST /api/imports': () => ok(summaryResult({
        problems: [longProblem, 'Second parser warning', 'Third parser warning', 'Fourth parser warning'],
      })),
    });
    const { container } = mount();
    await upload(container);
    const heading = await screen.findByRole('heading', { name: 'Warnings' });
    const warnings = heading.closest('.import-review-warnings') as HTMLElement;
    expect([...warnings.querySelectorAll('p')].map((p) => p.textContent))
      .toEqual([longProblem, 'Second parser warning', 'Third parser warning', 'Fourth parser warning']);
    expect(warnings).not.toHaveClass('error');
    expect(screen.getByText('Fourth parser warning')).toBeInTheDocument();
    expect(within(warnings).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(warnings).queryByRole('status')).not.toBeInTheDocument();
    expect(warnings.compareDocumentPosition(screen.getByRole('button', { name: 'Confirm import' }))
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('confirm', () => {
  /**
   * The server's refusal when the account was deleted while this summary sat here — the
   * headline failure of an upload that picks an account, and the one whose advice is a
   * button on this card.
   */
  const ACCOUNT_MISSING =
    'nothing was imported: the account these rows go to was deleted while this import was waiting, and it cannot be brought back. Discard this import and upload the file again into another account';

  it('keeps both review actions disabled and shows no success until Confirm returns', async () => {
    let answer!: (response: Response) => void;
    mockFetch({
      ...BASE,
      'POST /api/imports': () => ok(summaryResult()),
      'POST /api/imports/imp-1/confirm': () => new Promise((resolve) => { answer = resolve; }),
    });
    const { container } = mount();
    await upload(container);
    const discard = await screen.findByRole('button', { name: 'Discard' });
    const confirm = screen.getByRole('button', { name: 'Confirm import' });
    expect(discard.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    confirm.focus();
    act(() => {
      confirm.click();
      confirm.click();
      discard.click();
    });
    expect(countOf('POST /api/imports/imp-1/confirm')).toBe(1);
    expect(confirm).toHaveFocus();
    expect(confirm).toHaveTextContent('Confirm import');
    expect(confirm).toHaveAttribute('data-pending', 'true');
    expect(screen.getByRole('button', { name: 'Confirm import' })).toHaveAttribute('aria-disabled', 'true');
    const review = screen.getByRole('region', { name: /Read 12 of 14 rows/ });
    expect(review).toHaveAttribute('aria-busy', 'true');
    expect(within(review).getByRole('status')).toHaveTextContent('Confirming import… Transactions are being committed. Please wait.');
    expect(discard).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(discard);
    expect(countOf('POST /api/imports/imp-1/discard')).toBe(0);
    expect(screen.getByRole('heading', { name: /nothing imported yet/ })).toBeInTheDocument();
    expect(screen.queryByText(/Imported 12 of 12 rows/)).not.toBeInTheDocument();
    await act(async () => answer(ok(CONFIRMED)));
    expect(await screen.findByText(/Imported 12 of 12 rows/)).toBeInTheDocument();
    expect(countOf('POST /api/imports/imp-1/confirm')).toBe(1);
  });

  it('requests the confirm once, replaces the summary, and tells the caller once', async () => {
    mockFetch({
      ...BASE,
      'POST /api/imports': () => ok(summaryResult()),
      'POST /api/imports/imp-1/confirm': () => ok(CONFIRMED),
    });
    const { container, onImported, onAccountCreated } = mount();
    await upload(container);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm import' }));

    // anchor: the confirmed panel, which exists only once the confirm came back
    const heading = await screen.findByRole('heading', { name: 'Imported 12 of 12 rows' });
    expect(heading).toHaveFocus();
    expect(heading).toHaveAttribute('tabindex', '-1');
    expect(heading).toHaveClass('import-outcome-success');
    expect(heading.closest('.import-confirmed')).toHaveClass('card');
    expect(heading.closest('.import-confirmed')).not.toHaveClass('import-outcome-success');
    expect(screen.queryByText(/nothing imported yet/)).not.toBeInTheDocument();
    expect(countOf('POST /api/imports/imp-1/confirm')).toBe(1);
    expect(onImported).toHaveBeenCalledTimes(1);
    // two events, not one: the account was created by the upload press, the rows
    // landed by this one, and each fires its own callback exactly once
    expect(onAccountCreated).toHaveBeenCalledTimes(1);
  });

  /**
   * This panel reads imports.rows_rejected, which is the three reasons added up and
   * nothing else — so it may count the rows and may not say why. The advice it used to
   * carry was doubly dead: the import is committed and there is no Discard here.
   */
  it('counts the rows that did not import after the confirm, and claims no cause', async () => {
    mockFetch({
      ...BASE,
      'POST /api/imports': () => ok(summaryResult({ accepted: 13, skipped: 1, noMovement: 1 })),
      'POST /api/imports/imp-1/confirm': () => ok({ ...CONFIRMED, inserted: 13, total: 14, skipped: 1 }),
    });
    const { container } = mount();
    await upload(container);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm import' }));

    expect(await screen.findByText(/Imported 13 of 14 rows/)).toBeInTheDocument();
    expect(screen.getByText("1 row didn't import.")).toBeInTheDocument();
    expect(screen.queryByText(/couldn't be read/)).not.toBeInTheDocument();
    expect(screen.queryByText(/preset/)).not.toBeInTheDocument();
  });

  /**
   * The created-account sentence goes when rows land in it, and stays gone. Gating it
   * on `confirmed` instead of clearing `created` passes the assertion above and fails
   * here: newInput() clears `confirmed` for the next file, and the sentence comes back
   * saying an account that now holds the rows the user imported "exists whether or not
   * these rows land". A gate bound to a value that moves.
   */
  it('does not resurrect the created-account notice when a second file is chosen', async () => {
    mockFetch({
      ...BASE,
      'POST /api/imports': () => ok(summaryResult()),
      'POST /api/imports/imp-1/confirm': () => ok(CONFIRMED),
    });
    const { container } = mount();
    await upload(container);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm import' }));
    expect(await screen.findByText(/Imported 12 of 12 rows/)).toBeInTheDocument();
    expect(screen.queryByText(/was created when you pressed Import/)).not.toBeInTheDocument();

    await returnToSetup();
    chooseFile(container, 'next-month.csv');
    await screen.findByText(/next-month\.csv/);
    expect(screen.queryByText(/was created when you pressed Import/)).not.toBeInTheDocument();
  });

  /**
   * And it goes only when the rows landed in THAT account. The user creates "Foo",
   * the upload behind it fails, and they then import into an account they picked
   * instead: "Foo" is still standing empty, so the sentence saying it exists has to
   * survive the confirm that has nothing to do with it.
   *
   * The second upload answers a summary for `acc-1` on purpose. With the fixture's
   * default id this confirms into the created account, takes the gate's true branch,
   * and passes with the gate deleted — the vacuum this suite could not otherwise see.
   */
  it('keeps the created-account notice when the rows land in a different account', async () => {
    let uploads = 0;
    mockFetch({
      ...ACCOUNT_ROUTES,
      'POST /api/imports': () =>
        ++uploads === 1
          ? fail(500)
          : ok(summaryResult({ accountId: 'acc-1', accountName: 'Sparkasse Giro' })),
      'POST /api/imports/imp-1/confirm': () => ok(CONFIRMED),
    });
    const { container } = mount();
    await fillCreateArm(container, 'Foo');
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByRole('alert');
    expect(screen.getByText(/"Foo" was created when you pressed Import/)).toBeInTheDocument();

    await returnToSetup('Change source');
    fireEvent.click(screen.getByRole('button', { name: 'Sparkasse Giro' }));
    chooseFile(container, 'sparkasse-2026-07.csv');
    await screen.findByText(/sparkasse-2026-07\.csv/);
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm import' }));

    expect(await screen.findByText(/Imported 12 of 12 rows/)).toBeInTheDocument();
    expect(screen.getByText(/"Foo" was created when you pressed Import/)).toBeInTheDocument();
  });

  /**
   * A confirm that is refused, which until now no test in this package made happen —
   * every other one here answers 200. Two things are held, and neither by anything
   * else: the server's sentence arrives whole, and the control it tells the user to
   * press is still under it.
   *
   * Both are one edit away from silence. Replace runConfirm's catch with a no-op and
   * the refusal reaches nobody; clear `result` in it and the card goes with the
   * error, taking the only Discard on the screen — and on this refusal there is no
   * second attempt to fall back on, since the account is not coming back and every
   * retry answers the same 409.
   */
  it('prints a refused confirm whole and leaves Discard standing beneath it', async () => {
    mockFetch({
      ...BASE,
      'POST /api/imports': () => ok(summaryResult()),
      'POST /api/imports/imp-1/confirm': () => fail(409, { error: ACCOUNT_MISSING }),
    });
    const { container, onImported } = mount();
    await upload(container);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm import' }));

    // the server's own sentence and all of it: its last clause is the way out, so a
    // message this client cut or classified would lose exactly the half that acts
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Error')).toBeInTheDocument();
    expect(within(alert).getByText(ACCOUNT_MISSING)).toBeInTheDocument();
    expect(alert.parentElement).toBe(screen.getByRole('region', { name: 'Import review or result' }));
    // the control the sentence points at, still there and still pressable, on a card
    // the refused confirm left standing
    expect(screen.getByRole('button', { name: 'Discard' })).toBeEnabled();
    expect(screen.getByText(/nothing imported yet/)).toBeInTheDocument();
    // nothing landed, so nothing may tell the caller it did
    expect(onImported).not.toHaveBeenCalled();
    expect(screen.queryByText(/Imported 12 of 12 rows/)).not.toBeInTheDocument();
  });

  it('uses the confirm response for zero inserted rows, without success ink or clearing an empty new account', async () => {
    mockFetch({
      ...BASE,
      'POST /api/imports': () => ok(summaryResult({ accepted: 10, skipped: 2, newRows: 2, alreadyPresent: 8 })),
      'POST /api/imports/imp-1/confirm': () => ok({ ...CONFIRMED, inserted: 0, skipped: 2, total: 12 }),
    });
    const { container } = mount();
    await upload(container);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm import' }));

    const heading = await screen.findByRole('heading', { name: 'Imported 0 of 12 rows' });
    expect(heading).toHaveFocus();
    expect(heading).not.toHaveClass('import-outcome-success');
    const card = heading.closest('.import-confirmed') as HTMLElement;
    expect(card).toHaveClass('card');
    expect(card).not.toHaveClass('import-outcome-success');
    expect([...card.querySelectorAll('p')].map((p) => p.textContent)).toEqual([
      "2 rows didn't import.",
      '8 were already in the database — this export overlaps one you imported before. Nothing was duplicated.',
      "2 of the rows this summary called new were written by another import while it waited here. They're in your data — under that import, not this one.",
    ]);
    expect(screen.getByText(/"statement" was created when you pressed Import/)).toBeInTheDocument();
    await returnToSetup();
    expect(screen.getByText(/"statement" was created when you pressed Import/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose another CSV, Excel or PDF statement file' }))
      .toHaveTextContent('statement.csv');
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
    const heading = await screen.findByRole('heading', { name: 'Discarded — nothing was imported.' });
    expect(heading).toHaveFocus();
    expect(heading).toHaveAttribute('tabindex', '-1');
    expect(heading.closest('.import-discarded')).toHaveTextContent(
      'The file is untouched. Start another import to change the preset or destination and read it again.',
    );
    expect(screen.queryByText(/nothing imported yet/)).not.toBeInTheDocument();
    expect(countOf('POST /api/imports/imp-1/discard')).toBe(1);
    expect(countOf('POST /api/imports/imp-1/confirm')).toBe(0);
    expect(onImported).not.toHaveBeenCalled();
    // nothing was imported, and something WAS written: the account this press created
    // outlives the import it was created for, and the discard notice above says the
    // opposite on its own
    expect(screen.getByText(/was created when you pressed Import/)).toBeInTheDocument();
  });

  it('holds the review without announcing discard until its response arrives', async () => {
    let answer!: (response: Response) => void;
    mockFetch({
      ...BASE,
      'POST /api/imports': () => ok(summaryResult()),
      'POST /api/imports/imp-1/discard': () => new Promise((resolve) => { answer = resolve; }),
    });
    const { container } = mount();
    await upload(container);
    const discard = await screen.findByRole('button', { name: 'Discard' });
    const confirm = screen.getByRole('button', { name: 'Confirm import' });
    discard.focus();
    act(() => {
      discard.click();
      discard.click();
      confirm.click();
    });
    expect(discard).toHaveFocus();
    expect(discard).toHaveTextContent('Discard');
    expect(discard).toHaveAttribute('data-pending', 'true');
    expect(confirm).not.toHaveAttribute('data-pending');
    const review = screen.getByRole('region', { name: /Read 12 of 14 rows/ });
    expect(review).toHaveAttribute('aria-busy', 'true');
    expect(within(review).getByRole('status')).toHaveTextContent('Discarding review… Please wait.');
    expect(screen.getByRole('button', { name: 'Discard' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'Confirm import' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByRole('heading', { name: /Discarded/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm import' }));
    expect(countOf('POST /api/imports/imp-1/confirm')).toBe(0);
    await act(async () => answer(ok({ discarded: true, importId: 'imp-1' })));
    expect(await screen.findByRole('heading', { name: 'Discarded — nothing was imported.' }))
      .toHaveFocus();
    expect(countOf('POST /api/imports/imp-1/discard')).toBe(1);
  });

  it('keeps the review actions and shows a refused discard beside the review', async () => {
    const refusal = 'The staged upload could not be discarded. Keep the file and retry the discard.';
    mockFetch({
      ...BASE,
      'POST /api/imports': () => ok(summaryResult()),
      'POST /api/imports/imp-1/discard': () => fail(409, { error: refusal }),
    });
    const { container } = mount();
    await upload(container);
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Error')).toBeInTheDocument();
    expect(within(alert).getByText(refusal)).toBeInTheDocument();
    expect(alert.parentElement).toBe(screen.getByRole('region', { name: 'Import review or result' }));
    expect(screen.getByRole('heading', { name: /nothing imported yet/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm import' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeEnabled();
    expect(screen.queryByRole('heading', { name: /Discarded —/ })).not.toBeInTheDocument();
  });
});

describe('a file that is already in', () => {
  if (DUPLICATE.outcome !== 'duplicate') throw new Error('DUPLICATE is not the duplicate answer');
  const uploadedOn = fmtDate(DUPLICATE.uploadedAt);

  it('says so and offers nothing to confirm or discard', async () => {
    mockFetch({ ...BASE, 'POST /api/imports': () => ok({ ...DUPLICATE, total: 1 }) });
    const { container } = mount();
    await upload(container);

    // anchor: the duplicate card, which exists only once the upload came back
    const heading = await screen.findByRole('heading', { name: "You've already imported this file" });
    expect(heading).toHaveFocus();
    expect(heading).toHaveAttribute('tabindex', '-1');
    const card = heading.closest('.import-duplicate') as HTMLElement;
    expect([...card.querySelectorAll('p')].map((p) => p.textContent)).toEqual([
      `You uploaded it on ${uploadedOn}. It wasn't read again.`,
      'It had 1 row when it was read.',
      'Nothing was duplicated.',
    ]);
    expect(heading).not.toHaveClass('import-outcome-success');
    expect(card).not.toHaveClass('import-outcome-success');
    expect(screen.queryByText(/didn't import/)).not.toBeInTheDocument();
    expect(screen.queryByText(/in your data/)).not.toBeInTheDocument();

    expect(screen.queryByRole('button', { name: 'Confirm import' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Discard' })).not.toBeInTheDocument();
    // the easiest of the three no-rows-landed endings to miss, because nothing threw
    expect(screen.getByText(/was created when you pressed Import/)).toBeInTheDocument();
  });

  it('counts the rows the earlier import did not take, and places none of them in the data', async () => {
    mockFetch({ ...BASE, 'POST /api/imports': () => ok({ ...DUPLICATE, total: 73, skipped: 1 }) });
    const { container } = mount();
    await upload(container);

    expect(await screen.findByText(/You've already imported this file/)).toBeInTheDocument();
    const card = screen.getByRole('heading', { name: "You've already imported this file" }).closest('.import-duplicate') as HTMLElement;
    expect([...card.querySelectorAll('p')].map((p) => p.textContent)).toEqual([
      `You uploaded it on ${uploadedOn}. It wasn't read again.`,
      'It had 73 rows when it was read.',
      "1 of them didn't import.",
      'Nothing was duplicated.',
    ]);
    expect(screen.queryByText(/in your data/)).not.toBeInTheDocument();
  });

  it('counts every row the earlier import did not take when there are several', async () => {
    mockFetch({ ...BASE, 'POST /api/imports': () => ok({ ...DUPLICATE, total: 73, skipped: 4 }) });
    const { container } = mount();
    await upload(container);

    expect(await screen.findByText(/You've already imported this file/)).toBeInTheDocument();
    const card = screen.getByRole('heading', { name: "You've already imported this file" }).closest('.import-duplicate') as HTMLElement;
    expect([...card.querySelectorAll('p')].map((p) => p.textContent)).toEqual([
      `You uploaded it on ${uploadedOn}. It wasn't read again.`,
      'It had 73 rows when it was read.',
      "4 of them didn't import.",
      'Nothing was duplicated.',
    ]);
    expect(screen.queryByText(/in your data/)).not.toBeInTheDocument();
  });
});

/**
 * The upload picks an account instead of naming one. The whole of
 * the picker's coverage is here, because `BASE` serves an empty list and every test
 * above therefore runs the create arm.
 *
 * What jsdom cannot answer is which account the rows actually reached, so the subject
 * of every assertion below is the request: the field names on the FormData, and
 * whether a POST happened at all.
 */
describe('the account picker', () => {
  /** The FormData the upload sent, read off the handler's own init. */
  const captureUpload = (table: Routes): { sent: FormData | null } => {
    const captured: { sent: FormData | null } = { sent: null };
    mockFetch({
      ...table,
      'POST /api/imports': (init) => {
        captured.sent = (init?.body as FormData) ?? null;
        return ok(summaryResult());
      },
    });
    return captured;
  };

  it('lists the accounts the endpoint returned, with none of them preselected', async () => {
    mockFetch(ACCOUNT_ROUTES);
    mount();

    const first = await screen.findByRole('button', { name: 'Sparkasse Giro' });
    expect(first).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'N26' })).toHaveAttribute('aria-pressed', 'false');
    // and the way out of the list, for a bank that has no account yet
    expect(screen.getByRole('button', { name: '+ New account' })).toBeInTheDocument();
    expect(screen.getByText("Hidden accounts aren't listed here — unhide one first."))
      .toBeInTheDocument();
    // the create arm stays shut until it is asked for: an account chosen by the
    // screen rather than by the person is how rows land in the wrong one
    expect(screen.queryByPlaceholderText('Sparkasse Giro')).not.toBeInTheDocument();
  });

  /**
   * The group's name differs from its heading so it cannot be confused with the
   * TransactionsScreen account filter, which is named "Account" too.
   */
  it('heads the picker, and does not name its group what the transactions filter is named', async () => {
    mockFetch(ACCOUNT_ROUTES);
    mount();
    await screen.findByRole('button', { name: 'Sparkasse Giro' });

    expect(screen.getByRole('heading', { level: 3, name: 'Account' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Account' })).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: /account/i })).toBeInTheDocument();
  });

  it('keeps long account names intact and offers new account as another chip', async () => {
    const name = 'Long account name '.repeat(12).trim();
    mockFetch({ ...ACCOUNT_ROUTES, 'GET /api/accounts': () => ok([...PICKABLE, { ...PICKABLE[0], id: 'acc-long', name }]) });
    mount();
    const long = await screen.findByRole('button', { name });
    const group = screen.getByRole('group', { name: 'Account for this import' });
    expect(long).toHaveTextContent(name);
    expect(long).toHaveClass('chip');
    expect(within(group).getByRole('button', { name: '+ New account' })).toHaveClass('chip');
    fireEvent.click(within(group).getByRole('button', { name: '+ New account' }));
    expect(screen.getByLabelText('Account name')).toBeInTheDocument();
  });

  it('keeps Import disabled until an account is picked', async () => {
    mockFetch(ACCOUNT_ROUTES);
    const { container } = mount();
    await screen.findByRole('button', { name: 'N26' });
    chooseFile(container);
    await screen.findByRole('button', { name: 'Choose another CSV, Excel or PDF statement file' });

    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'N26' }));
    expect(screen.getByRole('button', { name: 'N26' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled();
  });

  it('sends the picked id and neither a name nor a currency', async () => {
    const captured = captureUpload(ACCOUNT_ROUTES);
    const { container } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'N26' }));
    chooseFile(container);
    await screen.findByRole('button', { name: 'Choose another CSV, Excel or PDF statement file' });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByText(/Read 12 of 14 rows/);

    expect(captured.sent!.get('accountId')).toBe('acc-3');
    // there is no name arm to be exclusive with any more: either field
    // on its own is a 400, so a client that sent one would be refused outright
    expect(captured.sent!.get('accountName')).toBeNull();
    expect(captured.sent!.get('currency')).toBeNull();
    // an account that exists is not created again on the way past it
    expect(countOf('POST /api/accounts')).toBe(0);
  });

  /**
   * The list is how a user reaches an account that already exists. A screen that
   * quietly offered only "create a new one" when it failed to load would manufacture
   * a second account for a bank the user already has — and pressing Import is
   * what writes it, so the duplicate would be real before the file was
   * read. The failure blocks the import instead of falling through to the create arm,
   * held by `accounts === null` and not by a boolean a handler could reset.
   */
  it('blocks the import when the accounts could not be loaded, and says so', async () => {
    mockFetch({ ...BASE, 'GET /api/accounts': () => fail(500) });
    const { container } = mount();
    chooseFile(container);

    const error = await screen.findByText(/Your accounts couldn't be loaded/);
    expect(error).toHaveTextContent('Nothing can be imported until the list is there');
    expect(error.closest('.import-step')).toContainElement(
      screen.getByRole('heading', { level: 3, name: 'Account' }),
    );
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
    // and no create arm to fall through to
    expect(screen.queryByPlaceholderText('Sparkasse Giro')).not.toBeInTheDocument();
    expect(countOf('POST /api/imports')).toBe(0);
  });

  it('keeps a loaded picker usable when the post-confirm account reload fails', async () => {
    let reads = 0;
    mockFetch({
      ...ACCOUNT_ROUTES,
      'GET /api/accounts': () => ++reads === 1 ? ok(PICKABLE) : fail(500),
      'POST /api/imports': () => ok(summaryResult({ accountId: 'acc-3', accountName: 'N26' })),
      'POST /api/imports/imp-1/confirm': () => ok(CONFIRMED),
    });
    const { container } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'N26' }));
    chooseFile(container);
    await screen.findByRole('button', { name: 'Choose another CSV, Excel or PDF statement file' });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm import' }));

    await returnToSetup();
    const error = await screen.findByText(/Your accounts couldn't be loaded/);
    expect(error).not.toHaveTextContent('Nothing can be imported until the list is there');
    expect(screen.getByRole('button', { name: 'N26' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled();
    expect(reads).toBe(2);
  });

  /**
   * With no visible accounts the endpoint answers `[]`, so the picker is gone and
   * the create arm is the only state — and this sentence is then the one thing on
   * screen saying why a hidden bank is missing. It renders on any loaded list,
   * empty included, which is why it is not inside the picker.
   */
  it("says hidden accounts aren't listed even when the list is empty", async () => {
    mockFetch(BASE);
    mount();

    expect(await screen.findByText("Hidden accounts aren't listed here — unhide one first.")).toBeInTheDocument();
    expect(screen.getByLabelText('Account name')).toHaveValue('');
    // the empty-list state, not the populated one: there is no picker above it
    expect(screen.queryByRole('button', { name: '+ New account' })).not.toBeInTheDocument();
  });

  /**
   * The prefill is gone: it is how a real database acquired an
   * account called `account-statement_2026-07-01_2026-07-31_ru_a1b2c3 — копия`.
   * Naming an account is a deliberate act, and on the id arm no name is typed at all.
   */
  it('leaves the account name empty when a file is chosen', async () => {
    mockFetch(BASE);
    const { container } = mount();
    const name = await screen.findByPlaceholderText('Sparkasse Giro');
    chooseFile(container, 'sparkasse-2026-07.csv');
    await screen.findByRole('button', { name: 'Choose another CSV, Excel or PDF statement file' });

    expect(name).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
  });
});

/**
 * The create arm creates. POST /api/accounts is the only way this
 * product makes an account, and every upload this client builds carries an id — so
 * the account exists before the file is read, and a file the backend refuses leaves
 * one standing. What that costs is covered here: the write is announced, it happens
 * once however many times Import is pressed, and a refused create never uploads.
 *
 * jsdom cannot say which account the rows reached, so the subject of most of these is
 * the request stream: what was posted, in what order, and how many times.
 */
describe('the account the create arm makes', () => {
  /** The hidden holder's refusal — the one a user cannot explain from the picker. */
  const HIDDEN_HOLDER =
    'an account called "Old DKB" already has that name, and it has been removed from the app - restore it, or pick another name';

  /** Both bodies this press sends: the create's JSON and the upload's FormData. */
  const captureBoth = (table: Routes) => {
    const captured: { created: unknown; sent: FormData | null } = { created: null, sent: null };
    mockFetch({
      ...table,
      'POST /api/accounts': (init) => {
        captured.created = JSON.parse(String(init?.body ?? '{}'));
        return createdAccount(init);
      },
      'POST /api/imports': (init) => {
        captured.sent = (init?.body as FormData) ?? null;
        return ok(summaryResult());
      },
    });
    return captured;
  };

  it('creates the account with the trimmed name and nothing else, then uploads into it', async () => {
    const captured = captureBoth(ACCOUNT_ROUTES);
    const { container } = mount();
    await fillCreateArm(container, '  Third Bank  ');
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByText(/Read 12 of 14 rows/);

    // the whole body and not one field of it: this pins the trim and the ABSENCE of a
    // currency in one assertion, which is all this client sees of the currency default
    expect(captured.created).toEqual({ name: 'Third Bank' });
    expect(captured.sent!.get('accountId')).toBe('acc-9');
    // uploadForm lives outside the component, so neither of these is a binding it
    // could reach — this is the assertion that says the compile-time fact is true
    expect(captured.sent!.get('accountName')).toBeNull();
    expect(captured.sent!.get('currency')).toBeNull();
  });

  it("prints the server's refusal of the name and sends no upload behind it", async () => {
    mockFetch({ ...ACCOUNT_ROUTES, 'POST /api/accounts': () => fail(409, { error: HIDDEN_HOLDER }) });
    const { container } = mount();
    await fillCreateArm(container, 'Old DKB');
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    // the server's own sentence, never a class this screen derived from a status: the
    // holder is hidden and so is in no picker, which nothing here could have said
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Error')).toBeInTheDocument();
    expect(within(alert).getByText(HIDDEN_HOLDER)).toBeInTheDocument();
    expect(countOf('POST /api/imports')).toBe(0);
    // and the arm is still filled in, because the name is the only thing to fix
    await returnToSetup('Change source');
    expect(screen.getByPlaceholderText('Sparkasse Giro')).toHaveValue('Old DKB');
    expect(screen.queryByText(/was created when you pressed Import/)).not.toBeInTheDocument();
  });

  /**
   * The hazard this ordering exists for: create, upload fails on the file, the user
   * fixes the file and presses Import again — and a second POST /api/accounts with
   * the same name is a 409, the app refusing the user on behalf of an account it
   * created for them one press ago. Held by writing the account into state before the
   * upload is awaited, so the second press is already on the picker arm.
   */
  it('creates the account once across a failed upload and the press that follows it', async () => {
    let uploads = 0;
    mockFetch({
      ...ACCOUNT_ROUTES,
      'POST /api/imports': () => (++uploads === 1 ? fail(500) : ok(summaryResult())),
    });
    const { container } = mount();
    await fillCreateArm(container, 'Third Bank');
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByRole('alert');
    await returnToSetup('Change source');

    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByText(/Read 12 of 14 rows/);

    expect(countOf('POST /api/accounts')).toBe(1);
    expect(countOf('POST /api/imports')).toBe(2);
  });

  it('says the account was created when the upload behind it failed', async () => {
    mockFetch({ ...ACCOUNT_ROUTES, 'POST /api/imports': () => fail(500) });
    const { container, onAccountCreated } = mount();
    await fillCreateArm(container, 'Third Bank');
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Error')).toBeInTheDocument();
    expect(within(alert).getByText('HTTP 500')).toBeInTheDocument();
    expect(alert.closest('.import-failed')).toBeInTheDocument();
    // the write the user did not press a button called "Create" for, named
    const created = screen.getByRole('complementary', { name: 'Account created' });
    expect(within(created).getByText(/"Third Bank" was created when you pressed Import/))
      .toBeInTheDocument();
    expect(created.closest('.import-layout')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Read .*nothing imported yet|Imported .*rows|Discarded|already imported/ }))
      .not.toBeInTheDocument();
    // and the caller is told here, on the one path where telling it is the whole
    // mechanism: no confirm follows to fire onImported, and onBack reloads nothing,
    // so an account announced to nobody is on the server and on no screen
    expect(onAccountCreated).toHaveBeenCalledTimes(1);
  });

  it('tells the caller, and puts the account in the picker with it pressed', async () => {
    mockFetch({ ...BASE, 'POST /api/imports': () => ok(summaryResult()),
      'POST /api/imports/imp-1/discard': () => ok({ discarded: true, importId: 'imp-1' }),
    });
    const { container, onAccountCreated } = mount();
    await upload(container);
    await screen.findByText(/Read 12 of 14 rows/);

    // Back does not reload the caller, so nothing else would put this account on the
    // rail: it would exist on the server and appear on no screen
    expect(onAccountCreated).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('complementary', { name: 'Account created' }))
      .toHaveTextContent('The account "statement" was created when you pressed Import');
    // in the LIST the picker is derived from, not only in the key that is pressed —
    // a key with no row renders a picker with nothing selected and Import disabled
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await returnToSetup();
    expect(screen.getByRole('button', { name: 'statement' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('offers no currency, and says which one the account will hold', async () => {
    mockFetch(BASE);
    mount();
    await screen.findByPlaceholderText('Sparkasse Giro');

    expect(screen.queryByLabelText('Account currency')).toBeNull();
    expect(screen.getByLabelText('Account name')).toBeInTheDocument();
    expect(screen.getByText(/created when you press Import, before the file is read/)).toBeInTheDocument();
    expect(screen.getByText(/It will hold amounts in EUR/)).toBeInTheDocument();
  });

  /**
   * The base currency comes from a fetch whose failure Overview swallows, so it can be
   * null on a working screen. The sentence goes rather than rendering "amounts in ." —
   * and nothing is disabled over it: this is the only way data enters the product.
   */
  it('leaves the currency sentence out when there is no base currency, and imports anyway', async () => {
    mockFetch({ ...BASE, 'POST /api/imports': () => ok(summaryResult()) });
    const { container } = mount(vi.fn(), { baseCurrency: null });
    const name = await screen.findByPlaceholderText('Sparkasse Giro');
    fireEvent.change(name, { target: { value: 'Third Bank' } });
    chooseFile(container);
    await screen.findByRole('button', { name: 'Choose another CSV, Excel or PDF statement file' });

    expect(screen.queryByText(/It will hold amounts in/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByText(/Read 12 of 14 rows/);
    expect(countOf('POST /api/accounts')).toBe(1);
  });
});


describe('phase recovery and source preservation', () => {
  it('locks immediately during account creation and refuses reentrant reads and Back', async () => {
    let createAnswer!: (response: Response) => void;
    let uploadAnswer!: (response: Response) => void;
    let createInit: RequestInit | undefined;
    mockFetch({
      ...BASE,
      'POST /api/accounts': (init) => {
        createInit = init;
        return new Promise((resolve) => { createAnswer = resolve; });
      },
      'POST /api/imports': () => new Promise((resolve) => { uploadAnswer = resolve; }),
    });
    const { container, onBack, onImported, onAccountCreated } = mount();
    chooseFile(container);
    fireEvent.change(await screen.findByLabelText('Account name'), { target: { value: 'New bank' } });
    const submit = screen.getByRole('button', { name: 'Import' });
    act(() => {
      submit.click();
      submit.click();
    });
    expect(countOf('POST /api/accounts')).toBe(1);
    expect(countOf('POST /api/imports')).toBe(0);
    expect(screen.getByRole('region', { name: 'Reading statement' })).toHaveTextContent('DestinationNew bank');
    fireEvent.click(screen.getByRole('button', { name: /Back to accounts/ }));
    expect(onBack).not.toHaveBeenCalled();
    expect(container.querySelector('input[type=file]')).toBeNull();
    await act(async () => createAnswer(createdAccount(createInit)));
    expect(onAccountCreated).toHaveBeenCalledOnce();
    expect(countOf('POST /api/imports')).toBe(1);
    expect(requests().filter((request) => request.startsWith('POST')))
      .toEqual(['POST /api/accounts', 'POST /api/imports']);
    expect(screen.getByRole('complementary', { name: 'Account created' })).toBeInTheDocument();
    await act(async () => uploadAnswer(ok(summaryResult({ accountName: 'New bank' }))));
    expect(screen.getByRole('region', { name: 'Import review or result' })).toHaveTextContent('DestinationNew bank');
    fireEvent.click(screen.getByRole('button', { name: /Back to accounts/ }));
    expect(onBack).not.toHaveBeenCalled();
    expect(onImported).not.toHaveBeenCalled();
    expect(countOf('POST /api/imports/imp-1/discard')).toBe(0);
  });

  it('retains the whole parser refusal and offers a supported setup remedy, then rereads the selected file', async () => {
    const tail = 'set a mapping or pick a preset. The final diagnostic clause must remain.';
    const refusal = 'Unrecognised columns: '.padEnd(MAX_ERROR_CHARS - tail.length, 'x') + tail;
    const sent: FormData[] = [];
    mockFetch({
      ...ACCOUNT_ROUTES,
      'POST /api/imports': (init) => {
        sent.push(init!.body as FormData);
        return sent.length === 1 ? fail(422, { error: refusal })
          : ok(summaryResult({ accountId: 'acc-3', accountName: 'N26' }));
      },
    });
    const { container, onImported } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'N26' }));
    chooseFile(container, 'bank-statement.csv');
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(refusal)).toBeInTheDocument();
    const remedy = alert.querySelector('.notice__remedy')!;
    expect(remedy).toHaveTextContent(/optional bank preset.*corrected CSV\/XLSX.*PDF.*recognises/);
    expect(remedy).not.toHaveTextContent(/mapping/);
    expect(screen.getByRole('heading', { name: "Couldn't read this statement" })).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Import' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Import review or result' }))
      .toHaveTextContent('Filebank-statement.csvDestinationN26');
    await returnToSetup('Change source');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose another CSV, Excel or PDF statement file' }))
      .toHaveTextContent('bank-statement.csv');
    expect(screen.getByRole('button', { name: 'N26' })).toHaveAttribute('aria-pressed', 'true');
    openPresets();
    fireEvent.click(screen.getByRole('button', { name: 'Revolut (Statement CSV)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByRole('heading', { name: /nothing imported yet/ });
    expect(sent.map((form) => [form.get('accountId'), form.get('preset'), (form.get('file') as File).name]))
      .toEqual([['acc-3', 'generic', 'bank-statement.csv'], ['acc-3', 'revolut', 'bank-statement.csv']]);
    expect(onImported).not.toHaveBeenCalled();
    expect(countOf('POST /api/accounts')).toBe(0);
  });

  it('retries a refused confirmation on the same stage without rereading or inventing success', async () => {
    let confirms = 0;
    let answer!: (response: Response) => void;
    mockFetch({
      ...BASE,
      'POST /api/imports': () => ok(summaryResult({ newRows: 7, alreadyPresent: 5 })),
      'POST /api/imports/imp-1/confirm': () => ++confirms === 1
        ? fail(503, { error: 'Confirm could not complete. Retry the confirmation.' })
        : new Promise((resolve) => { answer = resolve; }),
    });
    const { container, onImported } = mount();
    await upload(container);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm import' }));
    await screen.findByRole('alert');
    expect(onImported).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Change source' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start another import' })).not.toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'Confirm import' });
    act(() => {
      confirm.click();
      confirm.click();
    });
    expect(countOf('POST /api/imports/imp-1/confirm')).toBe(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^Imported/ })).not.toBeInTheDocument();
    await act(async () => answer(ok({ ...CONFIRMED, inserted: 4, total: 14, skipped: 2 })));
    expect(screen.getByRole('heading', { name: 'Imported 4 of 14 rows' })).toHaveFocus();
    expect(screen.getByText(/^5 were already in the database/)).toBeInTheDocument();
    expect(screen.getByText(/^3 of the rows this summary called new/)).toBeInTheDocument();
    expect(onImported).toHaveBeenCalledOnce();
    expect(countOf('POST /api/imports')).toBe(1);
  });

  it('retries Discard without abandoning the stage and restores the same destination and preset', async () => {
    let discards = 0;
    mockFetch({
      ...ACCOUNT_ROUTES,
      'POST /api/imports': () => ok(summaryResult({ accountId: 'acc-3', accountName: 'N26' })),
      'POST /api/imports/imp-1/discard': () => ++discards === 1 ? fail(503)
        : ok({ discarded: true, importId: 'imp-1' }),
    });
    const { container, onImported } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'N26' }));
    openPresets();
    fireEvent.click(screen.getByRole('button', { name: 'Revolut (Statement CSV)' }));
    chooseFile(container);
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('heading', { name: /nothing imported yet/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start another import' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await returnToSetup();
    expect(screen.getByRole('button', { name: 'N26' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Choose another CSV, Excel or PDF statement file' }))
      .toHaveTextContent('statement.csv');
    openPresets();
    expect(screen.getByRole('button', { name: 'Revolut (Statement CSV)' })).toHaveAttribute('aria-pressed', 'true');
    expect(countOf('POST /api/imports/imp-1/discard')).toBe(2);
    expect(countOf('POST /api/imports/imp-1/confirm')).toBe(0);
    expect(onImported).not.toHaveBeenCalled();
  });

  it('keeps pasted contents through discard and an explicit new setup', async () => {
    let sent: FormData | undefined;
    mockFetch({
      ...ACCOUNT_ROUTES,
      'POST /api/imports': (init) => {
        sent = init!.body as FormData;
        return ok(summaryResult({ accountId: 'acc-3', accountName: 'N26' }));
      },
      'POST /api/imports/imp-1/discard': () => ok({ discarded: true, importId: 'imp-1' }),
    });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'N26' }));
    fireEvent.click(screen.getByText('…or paste the contents instead'));
    const contents = 'date;amount\n2026-06-01;-10';
    fireEvent.change(screen.getByRole('textbox', { name: 'Statement contents' }), { target: { value: contents } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByRole('heading', { name: /nothing imported yet/ });
    expect(sent!.get('accountId')).toBe('acc-3');
    expect((sent!.get('file') as File).name).toBe('pasted.csv');
    expect(await (sent!.get('file') as File).text()).toBe(contents);
    expect(screen.getByRole('region', { name: 'Import review or result' })).toHaveTextContent('Filepasted.csvDestinationN26');
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await returnToSetup();
    fireEvent.click(screen.getByText('…or paste the contents instead'));
    expect(screen.getByRole('textbox', { name: 'Statement contents' })).toHaveValue(contents);
    expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Choose a CSV, Excel or PDF statement file' })).toBeInTheDocument();
  });

  it('requires an explicit new setup after a duplicate and keeps its newly created account notice', async () => {
    mockFetch({ ...BASE, 'POST /api/imports': () => ok(DUPLICATE) });
    const { container, onAccountCreated, onImported } = mount();
    await upload(container);
    await screen.findByRole('heading', { name: "You've already imported this file" });
    expect(screen.queryByRole('button', { name: 'Import' })).not.toBeInTheDocument();
    expect(countOf('POST /api/imports')).toBe(1);
    await returnToSetup();
    expect(screen.getByRole('button', { name: 'statement' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Choose another CSV, Excel or PDF statement file' }))
      .toHaveTextContent('statement.csv');
    expect(screen.getByRole('complementary', { name: 'Account created' })).toBeInTheDocument();
    expect(onAccountCreated).toHaveBeenCalledOnce();
    expect(onImported).not.toHaveBeenCalled();
    expect(countOf('POST /api/imports')).toBe(1);
  });

  it('gives every Field its own control and description identity across import instances', async () => {
    mockFetch(BASE);
    mount();
    mount();
    await vi.waitFor(() => expect(screen.getAllByLabelText('Account name')).toHaveLength(2));
    const controls = [...screen.getAllByLabelText('Account name'), ...screen.getAllByLabelText('Statement contents')];
    expect(new Set(controls.map((control) => control.id)).size).toBe(controls.length);
    const descriptions = controls.map((control) => control.getAttribute('aria-describedby'));
    expect(new Set(descriptions).size).toBe(controls.length);
    for (const control of controls) {
      expect(document.getElementById(control.getAttribute('aria-describedby')!)).toBeInTheDocument();
      expect(document.querySelector(`label[for="${control.id}"]`)).toBeInTheDocument();
    }
  });
});
