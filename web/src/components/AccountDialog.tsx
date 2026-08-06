/**
 * Everything the ⋮ on a tab opens, and the "+ Add" beside the strip, in one panel.
 *
 * One component and one `kind`, not a boolean per step: "rename and delete both open"
 * would be representable, and render order would decide which of them the user is
 * looking at. It is the same reasoning the `panel` state on the Overview screen
 * carries, one level down.
 *
 * A `Sheet` rather than a popover under the ⋮. Two of these steps are a paragraph
 * apiece — hiding and deleting an account are different things and have to read
 * differently — and a four-line popover has nowhere to put a paragraph. The sheet
 * already closes on Escape and on the backdrop, and moves focus into itself.
 */
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { Account, ImportRecord } from '../types';
import { Sheet } from './Sheet';

/**
 * Which step is on screen. 'menu' is the four items; the rest are what they open.
 * Import history is not here — it is a list as long as the screen, and it takes the
 * screen over rather than sitting in a panel.
 */
export type DialogKind = 'menu' | 'add' | 'rename' | 'hide' | 'delete';

/**
 * What deleting the account would destroy. Read when the step opens rather than kept
 * on the screen: it costs two requests, and it is only ever read by somebody who has
 * asked the one question it answers.
 */
interface Preview {
  transactions: number;
  /**
   * Where the transaction count came from. `rows` is the account's own transactions,
   * counted directly. `imports` is the sum over its imports, which is what a hidden
   * account has to be counted by: the transactions endpoint answers nothing for one.
   */
  countedFrom: 'rows' | 'imports';
  /**
   * The row count came back at `COUNT_LIMIT`, so it is the limit and not the count.
   * Only the `rows` path can be truncated: the import sum is over rows the API already
   * bounded, and that bound has its own sentence below.
   */
  truncated: boolean;
  /** Uploaded statements this server still holds bytes for. */
  files: number;
  imports: number;
}

/**
 * The transactions endpoint takes a limit and answers nothing about what it cut. Ask
 * for more than the count could plausibly be, and say so when the answer comes back
 * full — a number that is silently the limit is the one number this dialog must not
 * print.
 */
export const COUNT_LIMIT = 100_000;

interface Props {
  kind: DialogKind;
  /**
   * The step the panel was opened AT, which is not always 'menu'. A hidden account has
   * no balance card and so no ⋮ on it; its own panel opens `hide` directly. Going back
   * from a step to a menu the reader never came through is a screen appearing out of
   * nowhere — so this is what says whether there is anything behind the step at all.
   */
  origin: DialogKind;
  /** null for 'add', which has no account yet. */
  account: Account | null;
  /** What a new account is created in: "+ Add" asks for a name and nothing else. */
  baseCurrency: string;
  onStep: (kind: DialogKind) => void;
  onClose: () => void;
  onOpenHistory: (account: Account) => void;
  /** A new account arrived — the screen reloads and selects it. */
  onCreated: (account: Account) => void;
  /** A rename or a hide came back; the screen has a newer row for this account. */
  onUpdated: (account: Account) => void;
}

export function AccountDialog({
  kind,
  origin,
  account,
  baseCurrency,
  onStep,
  onClose,
  onOpenHistory,
  onCreated,
  onUpdated,
}: Props) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  /** The delete preview could not be read, so nothing may be said about what goes. */
  const [previewError, setPreviewError] = useState<string | null>(null);

  // the field starts at the name being changed, and a refusal from the step before
  // is not about the step now on screen
  useEffect(() => {
    setError(null);
    setName(kind === 'rename' ? (account?.name ?? '') : '');
  }, [kind, account]);

  const loadPreview = useCallback(async () => {
    if (!account) return;
    setPreviewError(null);
    setPreview(null);
    try {
      const { imports } = await api.imports();
      // on the id, never on the name: a rename leaves an import row's accountName
      // behind, and matching on it would attribute the file to the old name
      const mine = imports.filter((r: ImportRecord) => r.accountId === account.id);
      const owned = mine.reduce((n, r) => n + r.transactions, 0);
      // a hidden account's transactions are filtered out of the endpoint, so asking
      // it would answer 0 for an account that has thousands
      const rows = account.hidden
        ? null
        : await api.transactions({ accountId: account.id, limit: COUNT_LIMIT });
      setPreview({
        transactions: rows ? rows.length : owned,
        countedFrom: rows ? 'rows' : 'imports',
        truncated: rows !== null && rows.length === COUNT_LIMIT,
        files: mine.filter((r) => r.documentAvailable).length,
        imports: mine.length,
      });
    } catch (e) {
      setPreviewError((e as Error).message);
    }
  }, [account]);

  useEffect(() => {
    if (kind === 'delete') loadPreview();
  }, [kind, loadPreview]);

  const submitName = async (e: FormEvent) => {
    e.preventDefault();
    const value = name.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (kind === 'add') onCreated(await api.createAccount(value, baseCurrency));
      else if (account) onUpdated(await api.renameAccount(account.id, value));
      onClose();
    } catch (err) {
      // the server's own sentence: "an account called X already has that name" says
      // more than anything this form could compose from a 409
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const setHidden = async (hidden: boolean) => {
    if (!account || busy) return;
    setBusy(true);
    setError(null);
    try {
      onUpdated(await api.setAccountHidden(account.id, hidden));
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const title =
    kind === 'add' ? 'New account' : kind === 'menu' ? (account?.name ?? '') : (account?.name ?? '');

  /**
   * What the leftmost button of a step does, and what it is called. At the step the
   * panel opened at there is nothing behind it, so it closes and says so — "Back" onto
   * a menu the reader did not come through is where they end up somewhere they never
   * asked for.
   */
  const atOrigin = kind === origin;
  const leaveLabel = atOrigin ? 'Cancel' : 'Back';
  const leave = () => (atOrigin ? onClose() : onStep('menu'));

  return (
    <Sheet open onClose={onClose} position="bottom" title={title}>
      {kind === 'add' && (
        <form onSubmit={submitName}>
          <h2 className="sheet-title">New account</h2>
          <p className="hint">
            A name is all it needs. Import a statement into it whenever you have one — or
            upload the statement first and let it name the account itself.
          </p>
          <label className="setting-label" htmlFor="acct-new-name">
            Name
          </label>
          <input
            id="acct-new-name"
            className="input"
            value={name}
            autoFocus
            placeholder="Sparkasse, cash, Revolut…"
            onChange={(e) => setName(e.target.value)}
          />
          <p className="hint" style={{ marginTop: 6 }}>
            It will hold amounts in {baseCurrency}, the base currency of this workspace.
          </p>
          {error && <p className="error">Error: {error}</p>}
          <div className="btn-row">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn" disabled={busy || !name.trim()}>
              Create
            </button>
          </div>
        </form>
      )}

      {kind === 'menu' && account && (
        <>
          {/* the whole name, wrapped — this is the one place the tab's cut is undone */}
          <h2 className="sheet-title acct-full-name">{account.name}</h2>
          <p className="sheet-meta">{account.hidden ? 'Hidden from the app' : 'Visible'}</p>
          <div className="acct-menu">
            <button className="acct-menu-item" onClick={() => onStep('rename')}>
              <span className="acct-menu-label">Rename</span>
              <span className="acct-menu-sub">
                The name on the tab. Nothing else about the account changes.
              </span>
            </button>
            <button className="acct-menu-item" onClick={() => onOpenHistory(account)}>
              <span className="acct-menu-label">Import history</span>
              <span className="acct-menu-sub">
                Which files went into this account, when, and how many rows. Download the
                file you uploaded, or remove it.
              </span>
            </button>
            <button className="acct-menu-item" onClick={() => onStep('hide')}>
              <span className="acct-menu-label">{account.hidden ? 'Unhide' : 'Hide'}</span>
              <span className="acct-menu-sub">
                {account.hidden
                  ? 'Bring it back to the tabs and to every total.'
                  : 'Off the screens and out of the totals. Nothing is deleted, and you can bring it back.'}
              </span>
            </button>
            <button className="acct-menu-item is-danger" onClick={() => onStep('delete')}>
              <span className="acct-menu-label">Delete</span>
              <span className="acct-menu-sub">
                Destroys the transactions, the imports and the uploaded files. Permanent.
              </span>
            </button>
          </div>
          <div className="btn-row">
            <button className="btn-ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      )}

      {kind === 'rename' && account && (
        <form onSubmit={submitName}>
          <h2 className="sheet-title">Rename</h2>
          <label className="setting-label" htmlFor="acct-name">
            Name
          </label>
          {/* the whole name, not the cut one: this is where a name that came out of a
              filename gets shortened to something a tab can hold */}
          <input
            id="acct-name"
            className="input"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
          <p className="hint" style={{ marginTop: 6 }}>
            Only the tab changes. The transactions, the imports and the files stay where
            they are.
          </p>
          {error && <p className="error">Error: {error}</p>}
          <div className="btn-row">
            <button type="button" className="btn-ghost" onClick={leave}>
              {leaveLabel}
            </button>
            <button type="submit" className="btn" disabled={busy || !name.trim()}>
              Save
            </button>
          </div>
        </form>
      )}

      {kind === 'hide' && account && (
        <>
          <h2 className="sheet-title">{account.hidden ? 'Unhide this account?' : 'Hide this account?'}</h2>
          <p className="body-text">
            {account.hidden ? (
              <>
                <strong>{account.name}</strong> comes back to the tabs, and its transactions
                start counting in the totals and the charts again.
              </>
            ) : (
              <>
                <strong>{account.name}</strong> leaves the tabs, the totals and the charts.
                Its transactions stay in the database exactly as they are — nothing is
                deleted, nothing is exported differently, and you can bring it back from{' '}
                <em>Hidden</em> under the tabs at any time.
              </>
            )}
          </p>
          {error && <p className="error">Error: {error}</p>}
          <div className="btn-row">
            <button className="btn-ghost" disabled={busy} onClick={leave}>
              {leaveLabel}
            </button>
            <button className="btn" disabled={busy} onClick={() => setHidden(!account.hidden)}>
              {account.hidden ? 'Unhide' : 'Hide'}
            </button>
          </div>
        </>
      )}

      {kind === 'delete' && account && (
        <>
          <h2 className="sheet-title">Delete this account?</h2>
          <p className="body-text">
            This is not <em>Hide</em>. Deleting <strong>{account.name}</strong> destroys its
            data, and nothing here or in a backup taken afterwards can bring it back.
          </p>

          {previewError && (
            <p className="error">
              Error: {previewError}
              {' · '}
              <button className="btn-link" type="button" onClick={loadPreview}>
                Retry
              </button>
            </p>
          )}
          {/* the counts before the control, never after it: what is destroyed has to be
              readable at the moment the decision is made */}
          {preview && (
            <ul className="acct-destroy">
              <li>
                <strong>
                  {preview.truncated
                    ? `at least ${preview.transactions} transactions`
                    : preview.transactions === 1
                      ? '1 transaction'
                      : `${preview.transactions} transactions`}
                </strong>{' '}
                {preview.countedFrom === 'rows'
                  ? 'in this account'
                  : 'across its imports — this account is hidden, so its rows cannot be counted directly'}
              </li>
              <li>
                <strong>{preview.imports === 1 ? '1 import' : `${preview.imports} imports`}</strong>{' '}
                and the record of what each one read
              </li>
              <li>
                <strong>
                  {preview.files === 1 ? '1 uploaded file' : `${preview.files} uploaded files`}
                </strong>{' '}
                still stored on this server
              </li>
            </ul>
          )}
          {/* what COUNT_LIMIT was raised for: a number that is silently the limit is the
              one number this dialog must not print as a fact */}
          {preview?.truncated && (
            <p className="error">
              That count came back exactly at the limit this dialog asks for, so it is the
              limit and not the answer. There are at least that many, and how many more is
              not something this screen can find out.
            </p>
          )}
          {preview && (
            <p className="hint">
              Counted over the imports this workspace lists. The API sends the most recent
              ones and no total, so an import older than that is not in these numbers.
            </p>
          )}
          {!preview && !previewError && <p className="hint">Counting what would go…</p>}

          {/*
            The refusal is standing rather than fired on the button, which is where the
            auth screens put theirs. A destructive control that answers "nothing
            happened" after the click is worse than one that never offered: the reader
            has already decided by then. And unlike password recovery there is something
            real to do instead, so the panel offers that instead of a dead button.
          */}
          <p className="body-text acct-wall">
            This server has no endpoint that deletes an account, so Finto cannot do it from
            here. <strong>Import history does the same work today:</strong> deleting an
            import removes the transactions it wrote and the file it came from, and an
            account with no imports left holds nothing. Hide the empty account afterwards
            and it is gone from the app.
          </p>

          <div className="btn-row">
            <button className="btn-ghost" onClick={leave}>
              {leaveLabel}
            </button>
            <button className="btn" onClick={() => onOpenHistory(account)}>
              Open import history
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}
