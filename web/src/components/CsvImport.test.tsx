import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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
  { onAccountCreated = vi.fn(), baseCurrency = 'EUR' as string | null } = {},
) => ({
  onImported,
  onAccountCreated,
  ...renderThemed(
    <CsvImport
      onBack={vi.fn()}
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
  await screen.findByText(/click to choose another/);
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
  await screen.findByText(/click to choose another/);
};

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
            newRows: 8,
            skipped: 6,
            unreadable: 2,
            filtered: 3,
            noMovement: 1,
            problems: [
              '3 rows skipped: the "State" value is not one of the accepted ones - "В ОБРАБОТКЕ" (3)',
            ],
          }),
        ),
    });
    const { container } = mount();
    await upload(container);

    const card = (await screen.findByText(/Read 8 of 14 rows/)).parentElement as HTMLElement;
    expect([...card.querySelectorAll('p.hint')].map((p) => p.textContent)).toEqual([
      expect.stringContaining("which found the columns in the file's own header"),
      expect.stringContaining('in total'),
      "2 rows couldn't be read. If it's the whole file, the column layout is probably" +
        " wrong — discard this and try your bank's preset above.",
      '1 row moved no money, so there was nothing to import.',
      '3 rows skipped: the "State" value is not one of the accepted ones - "В ОБРАБОТКЕ" (3)',
    ]);
    // the pre-fix render, and the one the backend's line contradicts word for word
    expect(screen.queryByText(/6 rows couldn't be read/)).not.toBeInTheDocument();
  });

  /**
   * The plural at the boundary that made this a defect: "1 rows couldn't be read" shipped
   * for a fortnight. Both client sentences at n = 1, because a correct helper with one
   * call site not using it is the defect itself.
   */
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
    expect(await screen.findByText(/Checked against the statement/)).toHaveTextContent(
      /72\.40 EUR at the start, 134\.85 EUR at the end\. The rows read run unbroken from one to the other\./,
    );
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
    expect(await screen.findByText(/2 running balances/)).toHaveTextContent(
      /added together: 387\.40 EUR at the start, 579\.85 EUR at the end\. 1 of them runs unbroken from one to the other; the other states a single row, so nothing could check it\./,
    );
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
    expect(await screen.findByText(/2 running balances/)).toHaveTextContent(
      /Read from the 2 running balances this statement states, added together: 387\.40 EUR at the start, 511\.72 EUR at the end\. Each of them states a single row, so nothing here was checked\./,
    );
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
    expect(await screen.findByText(/Read from the statement/)).toHaveTextContent(
      /72\.40 EUR at the start, 66\.72 EUR at the end\. It states a single row, so nothing here was checked\./,
    );
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
      // and never a pair alongside the reason it could not be derived
      expect(screen.queryByText(/at the start,/)).not.toBeInTheDocument();
      unmount();
    }
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

  it('requests the confirm once, replaces the summary, and tells the caller once', async () => {
    mockFetch({
      ...BASE,
      'POST /api/imports': () => ok(summaryResult()),
      'POST /api/imports/imp-1/confirm': () => ok(CONFIRMED),
    });
    const { container, onImported, onAccountCreated } = mount();
    await upload(container);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));

    // anchor: the confirmed panel, which exists only once the confirm came back
    expect(await screen.findByText(/Imported 12 of 12 rows/)).toBeInTheDocument();
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
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));

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
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText(/Imported 12 of 12 rows/)).toBeInTheDocument();
    expect(screen.queryByText(/was created when you pressed Import/)).not.toBeInTheDocument();

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
    await screen.findByText(/^Error:/);
    expect(screen.getByText(/"Foo" was created when you pressed Import/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sparkasse Giro' }));
    chooseFile(container, 'sparkasse-2026-07.csv');
    await screen.findByText(/sparkasse-2026-07\.csv/);
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));

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
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));

    // the server's own sentence and all of it: its last clause is the way out, so a
    // message this client cut or classified would lose exactly the half that acts
    expect(await screen.findByText(/^Error:/)).toHaveTextContent(ACCOUNT_MISSING);
    // the control the sentence points at, still there and still pressable, on a card
    // the refused confirm left standing
    expect(screen.getByRole('button', { name: 'Discard' })).toBeEnabled();
    expect(screen.getByText(/nothing imported yet/)).toBeInTheDocument();
    // nothing landed, so nothing may tell the caller it did
    expect(onImported).not.toHaveBeenCalled();
    expect(screen.queryByText(/Imported 12 of 12 rows/)).not.toBeInTheDocument();
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
    // nothing was imported, and something WAS written: the account this press created
    // outlives the import it was created for, and the discard notice above says the
    // opposite on its own
    expect(screen.getByText(/was created when you pressed Import/)).toBeInTheDocument();
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
    expect(await screen.findByText(/You've already imported this file/)).toBeInTheDocument();
    expect(
      screen.getByText(/^You uploaded it on .+\. It wasn't read again, and nothing was duplicated\.$/),
    ).toBeInTheDocument();
    expect(screen.getByText('It had 1 row when it was read.')).toBeInTheDocument();
    // toBe on the whole card: toHaveTextContent with a string passes on any part of it
    const card = screen.getByText(/You've already imported this file/).closest('.card') as HTMLElement;
    expect(card.textContent).toBe(
      "You've already imported this file" +
        `You uploaded it on ${uploadedOn}. It wasn't read again, and nothing was duplicated.` +
        'It had 1 row when it was read.',
    );
    expect(screen.queryByText(/didn't import/)).not.toBeInTheDocument();
    expect(screen.queryByText(/in your data/)).not.toBeInTheDocument();

    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Discard' })).not.toBeInTheDocument();
    // the easiest of the three no-rows-landed endings to miss, because nothing threw
    expect(screen.getByText(/was created when you pressed Import/)).toBeInTheDocument();
  });

  it('counts the rows the earlier import did not take, and places none of them in the data', async () => {
    mockFetch({ ...BASE, 'POST /api/imports': () => ok({ ...DUPLICATE, total: 73, skipped: 1 }) });
    const { container } = mount();
    await upload(container);

    expect(await screen.findByText(/You've already imported this file/)).toBeInTheDocument();
    expect(
      screen.getByText("It had 73 rows when it was read, and 1 of them didn't import."),
    ).toBeInTheDocument();
    const card = screen.getByText(/You've already imported this file/).closest('.card') as HTMLElement;
    expect(card.textContent).toBe(
      "You've already imported this file" +
        `You uploaded it on ${uploadedOn}. It wasn't read again, and nothing was duplicated.` +
        "It had 73 rows when it was read, and 1 of them didn't import.",
    );
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
   * The prefill is gone: it is how a real database acquired an
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
    expect(await screen.findByText(/^Error:/)).toHaveTextContent(HIDDEN_HOLDER);
    expect(countOf('POST /api/imports')).toBe(0);
    // and the arm is still filled in, because the name is the only thing to fix
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
    await screen.findByText(/^Error:/);

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

    expect(await screen.findByText(/^Error:/)).toBeInTheDocument();
    // the write the user did not press a button called "Create" for, named
    expect(
      screen.getByText(/"Third Bank" was created when you pressed Import/),
    ).toBeInTheDocument();
    // and the caller is told here, on the one path where telling it is the whole
    // mechanism: no confirm follows to fire onImported, and onBack reloads nothing,
    // so an account announced to nobody is on the server and on no screen
    expect(onAccountCreated).toHaveBeenCalledTimes(1);
  });

  it('tells the caller, and puts the account in the picker with it pressed', async () => {
    mockFetch({ ...BASE, 'POST /api/imports': () => ok(summaryResult()) });
    const { container, onAccountCreated } = mount();
    await upload(container);
    await screen.findByText(/Read 12 of 14 rows/);

    // Back does not reload the caller, so nothing else would put this account on the
    // rail: it would exist on the server and appear on no screen
    expect(onAccountCreated).toHaveBeenCalledTimes(1);
    // in the LIST the picker is derived from, not only in the key that is pressed —
    // a key with no row renders a picker with nothing selected and Import disabled
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
    await screen.findByText(/click to choose another/);

    expect(screen.queryByText(/It will hold amounts in/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    await screen.findByText(/Read 12 of 14 rows/);
    expect(countOf('POST /api/accounts')).toBe(1);
  });
});
