/**
 * One component and one `kind`, not a boolean per step: "rename and delete both open"
 * would be representable, and render order would decide which of them the user is
 * looking at.
 *
 * A `Sheet` rather than a popover. Two of the steps are a paragraph apiece — hiding
 * and deleting an account are different things and have to read differently — and a
 * popover has nowhere to put a paragraph.
 */
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { Account, AccountDeleted } from '../types';
import { Sheet } from './Sheet';

/**
 * Which step is on screen. Import history is not one of them — it is a list as long as
 * the screen, and it takes the screen over rather than sitting in a panel.
 */
export type DialogKind = 'menu' | 'add' | 'rename' | 'hide' | 'delete';

/**
 * What deleting the account would take with it. Read when the step opens rather than
 * kept on the screen: it costs requests, and it is only ever read by somebody who has
 * asked the one question it answers.
 */
interface Preview {
  transactions: number;
  /**
   * Where the transaction count came from. `rows` is the account's own transactions,
   * counted directly. `imports` is the server's total over this account's imports,
   * which is how a hidden account is counted.
   */
  countedFrom: 'rows' | 'imports';
  /**
   * The row count came back at `COUNT_LIMIT`, so it is the limit and not the count.
   * Only the `rows` path can be truncated: the import sum is the server's total over
   * every import, not over a page of them.
   */
  truncated: boolean;
  /** Imports that claim a stored statement, which is not whether bytes exist. */
  files: number;
  imports: number;
}

/**
 * Ask for more than the count could plausibly be, and say so when the answer comes back
 * full. The transactions endpoint's side of it is in `web/src/SPEC.md`, under *Accounts
 * and statements, as the client handles them*.
 */
export const COUNT_LIMIT = 100_000;

interface Props {
  kind: DialogKind;
  /**
   * The step the panel was opened AT, which is not always 'menu'. Going back from a
   * step to a menu the reader never came through is a screen appearing out of nowhere —
   * so this is what says whether there is anything behind the step at all.
   */
  origin: DialogKind;
  /** null for 'add', which has no account yet. */
  account: Account | null;
  /**
   * What a new account will be created in — printed, not sent. "+ Add" asks for a
   * name and nothing else, and the server reads the same setting this came from.
   */
  baseCurrency: string;
  onStep: (kind: DialogKind) => void;
  onClose: () => void;
  onOpenHistory: (account: Account) => void;
  onCreated: (account: Account) => void;
  /** A rename or a hide came back; the screen has a newer row for this account. */
  onUpdated: (account: Account) => void;
  /**
   * The account is gone, and these are the server's own counts of what went with it.
   * The screen closes this panel, re-reads the list and composes the sentence — the
   * preview is local to this component and deliberately does not cross this callback,
   * which is what makes "the numbers on screen came off the wire" true by construction
   * rather than by care.
   */
  onDeleted: (account: Account, destroyed: AccountDeleted) => void;
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
  onDeleted,
}: Props) {
  const [name, setName] = useState('');
  /** The account's name, typed back, which is the whole of the delete's gate. */
  const [confirmName, setConfirmName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  /** The delete preview could not be read, so nothing may be said about what goes. */
  const [previewError, setPreviewError] = useState<string | null>(null);

  // the field starts at the name being changed, and a refusal from the step before
  // is not about the step now on screen. The typed confirmation clears with them:
  // menu → delete → Back → delete would otherwise arrive with the gate already open
  useEffect(() => {
    setError(null);
    setName(kind === 'rename' ? (account?.name ?? '') : '');
    setConfirmName('');
  }, [kind, account]);

  const loadPreview = useCallback(async () => {
    if (!account) return;
    setPreviewError(null);
    setPreview(null);
    try {
      // on the id, never on the name, for the reason `web/src/SPEC.md` gives under
      // *Accounts and statements, as the client handles them*. The counting is the
      // server's - these totals are over the whole history, not over the page it would
      // have sent
      const { totals } = await api.imports(account.id);
      // a hidden account's transactions are filtered out of the endpoint, so asking
      // it would answer 0 for an account that has rows
      const rows = account.hidden
        ? null
        : await api.transactions({ accountId: account.id, limit: COUNT_LIMIT });
      setPreview({
        transactions: rows ? rows.length : totals.transactions,
        countedFrom: rows ? 'rows' : 'imports',
        truncated: rows !== null && rows.length === COUNT_LIMIT,
        files: totals.documents,
        imports: totals.imports,
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
      if (kind === 'add') onCreated(await api.createAccount(value));
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

  /**
   * Case-insensitively, and trimmed on both sides, for the reason `web/src/SPEC.md`
   * gives under *Accounts and statements, as the client handles them*.
   */
  const confirmed =
    !!account && confirmName.trim().toLowerCase() === account.name.trim().toLowerCase();

  const runDelete = async () => {
    if (!account || busy || !confirmed) return;
    setBusy(true);
    setError(null);
    try {
      // the account and the server's counts, and nothing of the preview: what was
      // removed is a different fact from what was previewed, and the screen that
      // writes the sentence can only reach the first
      onDeleted(account, await api.deleteAccount(account.id));
    } catch (err) {
      // printed, never classified: the server's sentence names the refusal
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
    <Sheet open onClose={onClose} position="bottom" title={title}
      pattern={kind === 'add' || kind === 'rename' ? 'short-editor' : 'confirmation'}
      stepKey={kind} busy={busy}
      restoreFocus={() => document.querySelector<HTMLElement>('.screen:not([hidden]) .rail-add')}
    >
      {kind === 'add' && (
        <form onSubmit={submitName}>
          <h2 className="sheet-title">New account</h2>
          <p className="hint">
            A name is all it needs. Import a statement into it whenever you have one — or
            create it from the import screen while you upload the first one.
          </p>
          <label className="setting-label" htmlFor="acct-new-name">
            Name
          </label>
          <input
            id="acct-new-name"
            className="input"
            value={name}
            readOnly={busy}
            placeholder="Sparkasse, cash, Revolut…"
            onChange={(e) => setName(e.target.value)}
          />
          <p className="hint" style={{ marginTop: 6 }}>
            It will hold amounts in {baseCurrency}, your base currency.
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
          {/* the whole name, wrapped, where the tab shows it cut */}
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
          {/* the whole name, not the cut one: this is where a long name gets shortened
              to something a tab can hold */}
          <input
            id="acct-name"
            className="input"
            value={name}
            readOnly={busy}
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
          {/* the consequence to a DIFFERENT account. "can", not "will": the preview reads
              import totals, which carry nothing about transfers, so there is nothing
              here to condition on */}
          <p className="hint">
            Money you moved between this account and another stops counting as a transfer
            once this side of it is gone, so another account's monthly income and expenses
            can change.
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
          {/* a number that is silently the limit is the one number this dialog must not
              print as a fact */}
          {preview?.truncated && (
            <p className="error">
              That count came back exactly at the limit this dialog asks for, so it is the
              limit and not the answer. There are at least that many, and how many more is
              not something this screen can find out.
            </p>
          )}
          {!preview && !previewError && <p className="hint">Counting what would go…</p>}

          {/*
            Rendered with the counts rather than disabled beside them: while the preview
            is unread or unreadable there is nothing on screen that would explain a dead
            control, and the Retry above is the actionable thing. The gate below it is
            the opposite case and is disabled rather than absent — its label names the
            exact string to type, so the reason is already on screen, and a button that
            appeared as you typed would move the row under the cursor.
          */}
          {preview && (
            <>
              <label className="setting-label" htmlFor="acct-delete-confirm">
                Type <strong>{account.name}</strong> to confirm
              </label>
              <input
                id="acct-delete-confirm"
                className="input"
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
              />
            </>
          )}

          {error && <p className="error">Error: {error}</p>}

          <div className="btn-row">
            <button className="btn-ghost" disabled={busy} onClick={leave}>
              {leaveLabel}
            </button>
            {/* the way out of the refusal the server can give this button, and it is on
                the panel whether or not one has been given: deleting the staged import
                from that screen is what unblocks the account */}
            <button className="btn-ghost" disabled={busy} onClick={() => onOpenHistory(account)}>
              Open import history
            </button>
            {preview && (
              <button
                className="btn btn-destroy"
                disabled={busy || !confirmed}
                onClick={runDelete}
              >
                Delete permanently
              </button>
            )}
          </div>
        </>
      )}
    </Sheet>
  );
}
