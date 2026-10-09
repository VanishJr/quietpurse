import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { importRecord, importsResponse } from '../test/fixtures';
import { fail, mockFetch, ok, renderThemed, requests, requestUrls, Routes } from '../test/harness';
import { Account, AccountDeleted } from '../types';
import { AccountDialog, COUNT_LIMIT, type DialogKind } from './AccountDialog';

/**
 * The delete panel, mounted on its own. Reaching its hidden-account branch through
 * OverviewScreen is four interactions and a fixture change, and that branch is the
 * only place `totals.transactions` is ever printed, so the component is mounted directly.
 *
 * What is asserted here is what the panel does: which numbers it prints, what it
 * offers and when, and what it hands back. What happens to the screen afterwards —
 * the rail, the reload, the sentence — is OverviewScreen.test.tsx's, and that split
 * is the design under test rather than a convenience.
 */

const ACCOUNT: Account = {
  id: 'acc-1',
  provider: 'upload',
  name: 'Sparkasse Giro',
  currency: 'EUR',
  balance: 1234.5,
  hidden: false,
};

/**
 * Two rows and totals that could not have come from them. Every number below is
 * therefore evidence about where the panel read it: counting the page gives 2, 1
 * and 24, and the assertions demand 137, 90 and 4021.
 */
const TRUNCATED = importsResponse(
  [importRecord(), importRecord({ id: 'imp-2', documentAvailable: false })],
  { imports: 137, documents: 90, transactions: 4021 },
);

/**
 * The answer of the delete route, declared with the client's own type: a fourth key
 * or a missing one is a tsc failure here rather than a sentence composed from
 * undefined. None of these three numbers could have come from the preview above.
 */
const DESTROYED: AccountDeleted = { deleted: true, transactions: 12, imports: 3, documents: 2 };

interface Spies {
  onClose?: () => void;
  onOpenHistory?: (account: Account) => void;
  onDeleted?: (account: Account, destroyed: AccountDeleted) => void;
}

const mount = (account: Account, routes: Routes, spies: Spies = {}) => {
  mockFetch(routes);
  return renderThemed(
    <AccountDialog
      kind="delete"
      origin="menu"
      account={account}
      baseCurrency="EUR"
      onStep={vi.fn()}
      onClose={spies.onClose ?? vi.fn()}
      onOpenHistory={spies.onOpenHistory ?? vi.fn()}
      onCreated={vi.fn()}
      onUpdated={vi.fn()}
      onDeleted={spies.onDeleted ?? vi.fn()}
    />,
  );
};

/** The whole gate: the counts have to be on screen before this exists at all. */
const confirmField = () => screen.findByLabelText(/to confirm/);
const destroyButton = () => screen.getByRole('button', { name: 'Delete permanently' });

describe('account name drafts', () => {
  const pendingCases = [
    { label: 'add Cancel', kind: 'add', origin: 'add', leave: 'Cancel', commit: 'Create', route: 'POST /api/accounts' },
    { label: 'rename Cancel', kind: 'rename', origin: 'rename', leave: 'Cancel', commit: 'Save', route: 'PATCH /api/accounts/acc-1' },
    { label: 'rename Back', kind: 'rename', origin: 'menu', leave: 'Back', commit: 'Save', route: 'PATCH /api/accounts/acc-1' },
  ] as const;

  it.each(pendingCases.flatMap((entry) => [{ ...entry, succeed: true }, { ...entry, succeed: false }]))(
    '$label refuses dismissal until the write settles (success=$succeed)', async ({ kind, origin, leave, commit, route, succeed }) => {
      let finish!: (response: Response) => void;
      mockFetch({ [route]: () => new Promise<Response>((resolve) => { finish = resolve; }) });
      const close = vi.fn();
      const step = vi.fn();
      const created = vi.fn();
      const updated = vi.fn();
      function Flow() {
        const [open, setOpen] = useState(true);
        const [currentKind, setKind] = useState<DialogKind>(kind);
        return open ? <AccountDialog kind={currentKind} origin={origin}
          account={kind === 'add' ? null : ACCOUNT} baseCurrency="EUR"
          onClose={() => { close(); setOpen(false); }}
          onStep={(next) => { step(next); setKind(next); }}
          onCreated={created} onUpdated={updated} onDeleted={vi.fn()} onOpenHistory={vi.fn()} /> : null;
      }
      renderThemed(<Flow />);
      const input = screen.getByRole('textbox', { name: 'Name' });
      if (kind === 'add') {
        expect(input).toHaveAttribute('aria-describedby', `${input.id}-help`);
        expect(document.getElementById(`${input.id}-help`)).toHaveTextContent('your base currency');
      } else {
        expect(input).not.toHaveAttribute('aria-describedby');
      }
      fireEvent.change(input, { target: { value: 'Draft account' } });
      fireEvent.click(screen.getByRole('button', { name: commit }));
      const leaving = screen.getByRole('button', { name: leave });
      expect(leaving).toHaveAttribute('aria-disabled', 'true');
      expect(leaving).toBeEnabled();
      expect(input).toHaveAttribute('readonly');
      leaving.focus();
      fireEvent.click(leaving);
      fireEvent.click(leaving, { detail: 0 });
      fireEvent.keyDown(document, { key: 'Escape' });
      fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
      const backdrop = screen.getByRole('dialog').parentElement!;
      fireEvent.pointerDown(backdrop);
      fireEvent.click(backdrop);
      expect(leaving).toHaveFocus();
      expect(close).not.toHaveBeenCalled();
      expect(step).not.toHaveBeenCalled();
      expect(created).not.toHaveBeenCalled();
      expect(updated).not.toHaveBeenCalled();
      expect(screen.queryByText('Discard unsaved changes?')).not.toBeInTheDocument();
      expect(requests().filter((request) => request === route)).toHaveLength(1);
      const saved = { ...ACCOUNT, id: kind === 'add' ? 'new-account' : ACCOUNT.id, name: 'Draft account', balance: kind === 'add' ? 0 : ACCOUNT.balance };
      await act(async () => { finish(succeed ? ok(saved) : fail(409, { error: 'Name rejected' })); });
      if (succeed) {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(close).toHaveBeenCalledOnce();
        expect(step).not.toHaveBeenCalled();
        expect(kind === 'add' ? created : updated).toHaveBeenCalledExactlyOnceWith(saved);
      } else {
        expect(await screen.findByText('Error: Name rejected')).toBeVisible();
        expect(input).toHaveValue('Draft account');
        expect(leaving).toHaveAttribute('aria-disabled', 'false');
        expect(close).not.toHaveBeenCalled();
        expect(step).not.toHaveBeenCalled();
        fireEvent.click(leaving);
        expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus();
        fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
        if (leave === 'Back') {
          expect(step).toHaveBeenCalledExactlyOnceWith('menu');
          expect(close).not.toHaveBeenCalled();
        } else {
          expect(close).toHaveBeenCalledOnce();
        }
        expect(created).not.toHaveBeenCalled();
        expect(updated).not.toHaveBeenCalled();
      }
    },
  );

  it.each(pendingCases.flatMap((entry) =>
    (['backdrop', 'escape', 'close', 'leave'] as const).map((dismissal) => ({ ...entry, dismissal }))))(
    '$label protects an edited name through $dismissal', ({ kind, origin, leave, dismissal }) => {
      mockFetch({});
      const close = vi.fn();
      const step = vi.fn();
      function Flow() {
        const [open, setOpen] = useState(true);
        const [currentKind, setKind] = useState<DialogKind>(kind);
        return open ? <AccountDialog kind={currentKind} origin={origin}
          account={kind === 'add' ? null : ACCOUNT} baseCurrency="EUR"
          onClose={() => { close(); setOpen(false); }}
          onStep={(next) => { step(next); setKind(next); }}
          onCreated={vi.fn()} onUpdated={vi.fn()} onDeleted={vi.fn()} onOpenHistory={vi.fn()} /> : null;
      }
      renderThemed(<Flow />);
      const input = screen.getByRole('textbox', { name: 'Name' });
      input.focus();
      fireEvent.change(input, { target: { value: 'Edited account' } });
      const dialog = screen.getByRole('dialog');
      const dismiss = () => {
        if (dismissal === 'backdrop') {
          const backdrop = dialog.parentElement!;
          fireEvent.pointerDown(backdrop);
          fireEvent.click(backdrop);
        } else if (dismissal === 'escape') fireEvent.keyDown(document, { key: 'Escape' });
        else fireEvent.click(screen.getByRole('button', { name: dismissal === 'close' ? 'Close dialog' : leave }));
      };
      dismiss();
      expect(close).not.toHaveBeenCalled();
      expect(step).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus();
      fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
      expect(screen.getByRole('textbox', { name: 'Name' })).toBe(input);
      expect(input).toHaveFocus();
      expect(input).toHaveValue('Edited account');
      dismiss();
      fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
      if (dismissal === 'leave' && leave === 'Back') {
        expect(step).toHaveBeenCalledExactlyOnceWith('menu');
        expect(close).not.toHaveBeenCalled();
      } else {
        expect(close).toHaveBeenCalledOnce();
        expect(step).not.toHaveBeenCalled();
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      }
      expect(requests()).toEqual([]);
    },
  );

  it('protects an edited name and treats an undone edit as pristine', () => {
    const close = vi.fn();
    renderThemed(<AccountDialog kind="add" origin="add" account={null} baseCurrency="EUR"
      onStep={vi.fn()} onClose={close} onOpenHistory={vi.fn()} onCreated={vi.fn()}
      onUpdated={vi.fn()} onDeleted={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: 'Name' });
    input.focus();
    fireEvent.change(input, { target: { value: 'Cash' } });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(input).toHaveValue('Cash');
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(close).toHaveBeenCalledOnce();
    expect(screen.queryByText('Discard unsaved changes?')).not.toBeInTheDocument();
  });
});

describe('the delete preview', () => {
  it('prints the totals of the whole history, not of the page it was sent', async () => {
    mount(ACCOUNT, {
      'GET /api/imports': () => ok(TRUNCATED),
      'GET /api/transactions': () => ok([]),
    });

    expect(await screen.findByText('137 imports')).toBeInTheDocument();
    expect(screen.getByText('90 uploaded files')).toBeInTheDocument();
    // and the two rows it was sent are not what any of it was counted from
    expect(screen.queryByText('2 imports')).not.toBeInTheDocument();
    expect(screen.queryByText('1 uploaded file')).not.toBeInTheDocument();
  });

  it('asks the server for this account, rather than the workspace it belongs to', async () => {
    mount(ACCOUNT, {
      'GET /api/imports': () => ok(TRUNCATED),
      'GET /api/transactions': () => ok([]),
    });
    await screen.findByText('137 imports');

    expect(requestUrls()).toContain('GET /api/imports?accountId=acc-1');
  });

  /**
   * The transactions endpoint answers nothing for a hidden account, so this branch
   * is the one that has to count from the imports — and it is the only place a
   * total that is larger than the page can be printed as a transaction count.
   */
  it('counts a hidden account from the totals, and says that is what it did', async () => {
    // no GET /api/transactions in the table: asking it for a hidden account would
    // answer 0 for an account with thousands, and the afterEach guard names it
    mount({ ...ACCOUNT, hidden: true }, { 'GET /api/imports': () => ok(TRUNCATED) });

    expect(await screen.findByText('4021 transactions')).toBeInTheDocument();
    expect(screen.getByText(/across its imports/)).toBeInTheDocument();
  });

  /**
   * The caveat this row replaces. It said an import older than the page is not in
   * these numbers; after this change every number is over the whole history, so
   * leaving it would teach the reader to disbelieve the ones that are still true.
   */
  it('no longer warns that older imports are missing from the numbers', async () => {
    mount(ACCOUNT, {
      'GET /api/imports': () => ok(TRUNCATED),
      'GET /api/transactions': () => ok([]),
    });
    await screen.findByText('137 imports');

    expect(screen.queryByText(/an import older than that is not in these numbers/)).toBeNull();
  });
});

describe('pending account consequences', () => {
  it.each(['hide', 'delete'] as const)('%s retains focus and locks conflicting actions until refusal', async (kind) => {
    let finish!: (response: Response) => void;
    const route = kind === 'delete' ? 'DELETE /api/accounts/acc-1' : 'PATCH /api/accounts/acc-1';
    mockFetch({
      'GET /api/imports': () => ok(TRUNCATED),
      'GET /api/transactions': () => ok([]),
      [route]: () => new Promise<Response>((resolve) => { finish = resolve; }),
    });
    const close = vi.fn();
    const step = vi.fn();
    const history = vi.fn();
    renderThemed(<AccountDialog kind={kind} origin="menu" account={ACCOUNT} baseCurrency="EUR"
      onStep={step} onClose={close} onOpenHistory={history} onCreated={vi.fn()}
      onUpdated={vi.fn()} onDeleted={vi.fn()} />);
    if (kind === 'delete') fireEvent.change(await confirmField(), { target: { value: ACCOUNT.name } });
    const action = screen.getByRole('button', { name: kind === 'delete' ? 'Delete permanently' : 'Hide' });
    action.focus();
    fireEvent.click(action);
    expect(action).toHaveFocus();
    expect(action).toHaveAttribute('aria-busy', 'true');
    expect(action).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(action);
    for (const label of ['Back', 'Cancel', 'Close dialog']) {
      const control = screen.getByRole('button', { name: label });
      expect(control).toHaveAttribute('aria-disabled', 'true');
      fireEvent.click(control);
    }
    if (kind === 'delete') {
      expect(await confirmField()).toHaveAttribute('readonly');
      fireEvent.click(screen.getByRole('button', { name: 'Open import history' }));
    }
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();
    expect(step).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
    expect(requests().filter((request) => request === route)).toHaveLength(1);
    await act(async () => finish(fail(409, { error: 'Account write refused' })));
    expect(screen.getByRole('alert')).toHaveTextContent('Error: Account write refused');
    expect(screen.getByRole('alert').closest('.sheet-footer')).not.toBeNull();
    expect(action).toHaveFocus();
    expect(action).not.toHaveAttribute('aria-disabled', 'true');
    expect(action).toBeEnabled();
    if (kind === 'delete') expect(await confirmField()).toHaveValue(ACCOUNT.name);
  });
});

describe('the delete itself', () => {
  const PREVIEWED: Routes = {
    'GET /api/imports': () => ok(TRUNCATED),
    'GET /api/transactions': () => ok([]),
  };

  /**
   * While the counts are unread the panel says so and offers nothing. Rendered rather
   * than disabled — nothing on screen would explain a dead control here, and the counts
   * are what the decision is made on.
   */
  it('offers nothing to click while the counts are still being read', async () => {
    mount(ACCOUNT, { 'GET /api/imports': () => new Promise<Response>(() => {}) });

    expect(await screen.findByText('Counting what would go…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete permanently' })).toBeNull();
    expect(screen.queryByLabelText(/to confirm/)).toBeNull();
  });

  /**
   * And the cost of that rule, stated rather than argued away: an account whose
   * imports cannot be read cannot be deleted from here, and the Retry is the way out.
   */
  it('keeps the Retry and still offers nothing when the counts could not be read', async () => {
    mount(ACCOUNT, { 'GET /api/imports': () => fail(500, { error: 'imports are down' }) });

    expect(await screen.findByText(/imports are down/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete permanently' })).toBeNull();
    expect(screen.queryByLabelText(/to confirm/)).toBeNull();
  });

  /** A floor is a readable count. What the rule refuses is a panel that knows nothing. */
  it('still offers the delete when the count came back at the limit', async () => {
    mount(ACCOUNT, {
      'GET /api/imports': () => ok(importsResponse()),
      'GET /api/transactions': () => ok(new Array(COUNT_LIMIT).fill(null)),
    });

    expect(await screen.findByText(`at least ${COUNT_LIMIT} transactions`)).toBeInTheDocument();
    expect(destroyButton()).toBeInTheDocument();
  });

  it('hands the screen the account and the server’s own counts, and does not close', async () => {
    const onDeleted = vi.fn();
    const onClose = vi.fn();
    mount(
      ACCOUNT,
      { ...PREVIEWED, 'DELETE /api/accounts/acc-1': () => ok(DESTROYED) },
      { onDeleted, onClose },
    );

    fireEvent.change(await confirmField(), { target: { value: 'Sparkasse Giro' } });
    fireEvent.click(destroyButton());

    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(onDeleted).toHaveBeenCalledWith(ACCOUNT, DESTROYED);
    // the aftermath is the screen's, and this is what makes an Escape mid-flight
    // harmless: there is nothing left in the unmounted panel to do
    expect(onClose).not.toHaveBeenCalled();
  });

  /**
   * accounts_name_unique is on lower(name), so the server already
   * treats two spellings as one name and a client demanding the capitals back would
   * refuse a name it calls identical.
   */
  it('takes the name in any case, padded, as the server matches it', async () => {
    const onDeleted = vi.fn();
    mount(
      ACCOUNT,
      { ...PREVIEWED, 'DELETE /api/accounts/acc-1': () => ok(DESTROYED) },
      { onDeleted },
    );

    fireEvent.change(await confirmField(), { target: { value: '  sparkasse giro  ' } });
    expect(destroyButton()).toBeEnabled();
    fireEvent.click(destroyButton());

    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
  });

  it('will not arm on a name that is nearly right', async () => {
    // no DELETE route on purpose: one sent from here is both a failed assertion below
    // and an unstubbed request the afterEach guard names
    mount(ACCOUNT, PREVIEWED);

    fireEvent.change(await confirmField(), { target: { value: 'Sparkasse Gir' } });

    expect(destroyButton()).toBeDisabled();
    fireEvent.click(destroyButton());
    expect(requests()).not.toContain('DELETE /api/accounts/acc-1');
  });

  /**
   * The refusal is printed and never classified: request() throws a bare Error and
   * the status is gone with it, so a branch could only match the backend's wording
   * across two packages nothing ties together. Import history is the real way out of
   * this one — deleting the staged import from there unblocks the account — and it is
   * on the panel whether or not a refusal has been given.
   */
  it('prints the server’s refusal and still offers the way out of it', async () => {
    mount(ACCOUNT, {
      ...PREVIEWED,
      'DELETE /api/accounts/acc-1': () =>
        fail(409, {
          error:
            'this account has an import waiting to be confirmed - confirm it or discard it, then delete the account',
        }),
    });

    fireEvent.change(await confirmField(), { target: { value: 'Sparkasse Giro' } });
    fireEvent.click(destroyButton());

    expect(
      await screen.findByText(/confirm it or discard it, then delete the account/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open import history' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open import history' }).closest('.sheet-footer')).not.toBeNull();
  });
});
