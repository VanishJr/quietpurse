import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CONFIRMED, DUPLICATE, PRESETS, summaryResult } from '../test/fixtures';
import { fail, mockFetch, ok, renderThemed, requests, Routes } from '../test/harness';
import { Account, BalancesNotShown } from '../types';
import { CsvImport } from './CsvImport';

/**
 * The import lifecycle, and with it the confirm/discard semantics of ROADMAP 5.3:
 * an upload writes nothing, Confirm is what makes the rows data, and Discard must
 * leave the caller's data alone.
 *
 * No rendered date is asserted anywhere here - the summary carries fmtDay(from) and
 * the duplicate card fmtDate(uploadedAt), and ROADMAP 6.5 changes one of those.
 */

/**
 * The account list is EMPTY here, and that costs something worth writing down: with
 * no accounts the picker does not render at all and every test mounting through
 * `BASE` runs the *create* arm. So none of them covers the picker — its whole
 * coverage is the last describe in this file, which serves a populated list.
 */
const BASE: Routes = {
  'GET /api/imports/presets': () => ok(PRESETS),
  'GET /api/accounts': () => ok([]),
};

/**
 * What GET /api/accounts answers the import screen: visible accounts only, because
 * the server left the hidden ones out and not because this client filtered them.
 * ACCOUNTS itself carries a hidden row, so it is not what this endpoint returns.
 */
const PICKABLE: Account[] = [
  { id: 'acc-1', provider: 'upload', name: 'Sparkasse Giro', currency: 'EUR', balance: 1234.5 },
  { id: 'acc-3', provider: 'upload', name: 'N26', currency: 'EUR', balance: 40 },
];

const ACCOUNT_ROUTES: Routes = { ...BASE, 'GET /api/accounts': () => ok(PICKABLE) };

const mount = (onImported = vi.fn()) => ({
  onImported,
  ...renderThemed(<CsvImport onBack={vi.fn()} onImported={onImported} />),
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
 */
async function upload(container: HTMLElement): Promise<void> {
  chooseFile(container);
  // awaits the accounts load as well as parking takeFile's read: with `accounts`
  // still null neither the picker nor the create arm has rendered
  const name = await screen.findByPlaceholderText('Sparkasse Giro');
  fireEvent.change(name, { target: { value: 'statement' } });
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
   * ROADMAP row 56. The card's own claim about which reader produced every number
   * under it, so its POSITION is asserted and not just its presence: below the date
   * range it would qualify nothing.
   *
   * Two arms, not one: the fixture's default is auto-detected, so every other case in
   * this file renders that arm and only that arm. The pdf-template arm is the one a
   * chip cannot decide (Ruling 3), and the preset arm is where the title on the card
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
    await upload(container);

    const line = await screen.findByText(/Read with the "Revolut \(Statement CSV\)" preset/);
    expect(line).toHaveTextContent(/date from "Дата выполнения"/);
    // the chip's own label and the summary's title are one string, off one backend
    // list — a second dictionary in this package is what the field exists to avoid
    expect(screen.getByRole('button', { name: 'Revolut (Statement CSV)' })).toBeInTheDocument();
    // first paragraph of the card, above the date range and everything below it
    const card = line.closest('.card') as HTMLElement;
    expect(card.querySelectorAll('p.hint')[0]).toBe(line);
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
            balances: { opening: 387.40, closing: 579.85, currency: 'EUR', series: 2 },
          }),
        ),
    });
    const { container, unmount } = mount();
    await upload(container);
    expect(await screen.findByText(/2 running balances/)).toHaveTextContent(
      /added together: 387\.40 EUR at the start, 579\.85 EUR at the end\. The rows read run unbroken from one to the other\./,
    );
    expect(screen.queryByText(/The rows add up/)).not.toBeInTheDocument();
    unmount();

    // one series states the pair plainly, and still makes only the claim it checked
    mockFetch({
      ...BASE,
      'POST /api/imports': () =>
        ok(
          summaryResult({
            balances: { opening: 72.40, closing: 134.85, currency: 'EUR', series: 1 },
          }),
        ),
    });
    const single = mount();
    await upload(single.container);
    expect(await screen.findByText(/Checked against the statement/)).toHaveTextContent(
      /72\.40 EUR at the start, 134\.85 EUR at the end\. The rows read run unbroken from one to the other\./,
    );
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
      // and never a pair alongside the reason it could not be derived
      expect(screen.queryByText(/at the start,/)).not.toBeInTheDocument();
      unmount();
    }
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

/**
 * The upload picks an account instead of naming one (ROADMAP row 26a). The whole of
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
    // the create arm stays shut until it is asked for: an account chosen by the
    // screen rather than by the person is how rows land in the wrong one
    expect(screen.queryByPlaceholderText('Sparkasse Giro')).not.toBeInTheDocument();
  });

  /**
   * The heading is a <div> and not a <label>, because Chips renders no control for
   * htmlFor to point at. The group's own name has to differ from that heading:
   * TransactionsScreen's account filter is already a group called "Account", and this
   * row is what made the name ambiguous. jsdom cannot see the collision itself —
   * neither screen mounts the other — so what is held here is the distinctness.
   */
  it('heads the picker, and does not name its group what the transactions filter is named', async () => {
    mockFetch(ACCOUNT_ROUTES);
    mount();
    await screen.findByRole('button', { name: 'Sparkasse Giro' });

    expect(screen.getByText('Account')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Account' })).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: /account/i })).toBeInTheDocument();
  });

  it('keeps Import disabled until an account is picked', async () => {
    mockFetch(ACCOUNT_ROUTES);
    const { container } = mount();
    await screen.findByRole('button', { name: 'N26' });
    chooseFile(container);
    await screen.findByText(/click to choose another/);

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
    await screen.findByText(/click to choose another/);
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByText(/Read 12 of 14 rows/);

    expect(captured.sent!.get('accountId')).toBe('acc-3');
    // both arms at once is a 400, so a client that sent them would be refused
    expect(captured.sent!.get('accountName')).toBeNull();
    expect(captured.sent!.get('currency')).toBeNull();
  });

  it('sends a name and a currency and no id when a new account is chosen', async () => {
    const captured = captureUpload(ACCOUNT_ROUTES);
    const { container } = mount();
    fireEvent.click(await screen.findByRole('button', { name: '+ New account' }));
    fireEvent.change(screen.getByPlaceholderText('Sparkasse Giro'), {
      target: { value: 'Third Bank' },
    });
    fireEvent.change(screen.getByLabelText('Account currency'), { target: { value: 'USD' } });
    chooseFile(container);
    await screen.findByText(/click to choose another/);
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByText(/Read 12 of 14 rows/);

    expect(captured.sent!.get('accountName')).toBe('Third Bank');
    expect(captured.sent!.get('currency')).toBe('USD');
    expect(captured.sent!.get('accountId')).toBeNull();
  });

  /**
   * The list is how a user reaches an account that already exists. A screen that
   * quietly offered only "create a new one" when it failed to load would manufacture
   * a second account for a bank the user already has, and there is no delete to undo
   * that — so the failure blocks the import instead of falling through to the create
   * arm. Held by `accounts === null`, not by a boolean a handler could reset.
   */
  it('blocks the import when the accounts could not be loaded, and says so', async () => {
    mockFetch({ ...BASE, 'GET /api/accounts': () => fail(500) });
    const { container } = mount();
    chooseFile(container);

    expect(await screen.findByText(/Your accounts couldn't be loaded/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
    // and no create arm to fall through to
    expect(screen.queryByPlaceholderText('Sparkasse Giro')).not.toBeInTheDocument();
    expect(countOf('POST /api/imports')).toBe(0);
  });

  /**
   * With every account removed the endpoint answers `[]`, so the picker is gone and
   * the create arm is the only state — and this sentence is then the one thing on
   * screen saying why the bank the user is looking for is missing. It renders on any
   * loaded list, empty included, which is why it is not inside the picker.
   */
  it("says removed accounts aren't listed even when the list is empty", async () => {
    mockFetch(BASE);
    mount();

    expect(await screen.findByText(/Accounts you've removed aren't listed/)).toBeInTheDocument();
    // the empty-list state, not the populated one: there is no picker above it
    expect(screen.queryByRole('button', { name: '+ New account' })).not.toBeInTheDocument();
  });

  /**
   * The prefill is gone (ROADMAP 26(d)): it is how a real database acquired an
   * account called `account-statement_2026-07-01_2026-07-31_ru_a1b2c3 — копия`.
   * Naming an account is a deliberate act, and on the id arm no name is typed at all.
   */
  it('leaves the account name empty when a file is chosen', async () => {
    mockFetch(BASE);
    const { container } = mount();
    const name = await screen.findByPlaceholderText('Sparkasse Giro');
    chooseFile(container, 'sparkasse-2026-07.csv');
    await screen.findByText(/click to choose another/);

    expect(name).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
  });
});
