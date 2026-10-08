import { FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { api } from '../api';
import { Account, AccountDeleted } from '../types';
import { useEditorSession } from '../editor';
import { Button } from './Button';
import { Field } from './Field';
import { FormActions } from './FormActions';
import { Notice } from './Notice';
import { Sheet } from './Sheet';

export type DialogKind = 'menu' | 'add' | 'rename' | 'hide' | 'delete';

interface Preview {
  transactions: number;
  countedFrom: 'rows' | 'imports';
  truncated: boolean;
  files: number;
  imports: number;
}

export const COUNT_LIMIT = 100_000;

interface Props {
  kind: DialogKind;
  origin: DialogKind;
  account: Account | null;
  baseCurrency: string;
  onStep: (kind: DialogKind) => void;
  onClose: () => void;
  restoreFocus?: () => HTMLElement | null;
  onOpenHistory: (account: Account) => void;
  onCreated: (account: Account) => void;
  onUpdated: (account: Account) => void;
  onDeleted: (account: Account, destroyed: AccountDeleted) => void;
}

export function AccountDialog({
  kind, origin, account, baseCurrency, onStep, onClose,
  restoreFocus = () => document.querySelector<HTMLElement>('.screen:not([hidden]) .rail-add'),
  onOpenHistory, onCreated, onUpdated, onDeleted,
}: Props) {
  const [name, setName] = useState('');
  const [confirmName, setConfirmName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const formId = useId();
  const editor = useEditorSession({
    open: true,
    dirty: (kind === 'add' || kind === 'rename') && name.trim() !== (kind === 'rename' ? account?.name ?? '' : '').trim(),
    busy,
    onClose,
    onNavigationDiscard: onClose,
  });

  // Returning through the menu must not retain an armed deletion gate.
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
      const { totals } = await api.imports(account.id);
      // Hidden rows are excluded by this endpoint; its empty answer is not their count.
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
      const saved = kind === 'add'
        ? await api.createAccount(value)
        : account ? await api.renameAccount(account.id, value) : null;
      editor.finish(() => {
        if (saved) {
          if (kind === 'add') onCreated(saved);
          else onUpdated(saved);
        }
        onClose();
      });
    } catch (err) {
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
      const saved = await api.setAccountHidden(account.id, hidden);
      editor.finish(() => { onUpdated(saved); onClose(); });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Match the server's trimmed, case-insensitive account-name identity.
  const confirmed =
    !!account && confirmName.trim().toLowerCase() === account.name.trim().toLowerCase();

  const runDelete = async () => {
    if (!account || !preview || busy || !confirmed) return;
    setBusy(true);
    setError(null);
    try {
      const destroyed = await api.deleteAccount(account.id);
      editor.finish(() => onDeleted(account, destroyed));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const atOrigin = kind === origin;
  const leave = () => editor.request(() => onStep('menu'));
  const heading = kind === 'add' ? 'New account'
    : kind === 'menu' ? account?.name ?? ''
    : kind === 'rename' ? 'Rename'
    : kind === 'hide' ? account?.hidden ? 'Unhide this account?' : 'Hide this account?'
    : 'Delete this account?';
  const completion = kind === 'menu' ? (
    <Button type="button" variant="secondary" size="standard" onClick={editor.requestClose}>Close</Button>
  ) : kind === 'add' || kind === 'rename' ? (
    <Button type="submit" form={formId} variant="primary" size="standard" pending={busy} disabled={!name.trim()}>
      {kind === 'add' ? 'Create' : 'Save'}
    </Button>
  ) : kind === 'hide' && account ? (
    <Button type="button" variant="primary" size="standard" pending={busy} onClick={() => setHidden(!account.hidden)}>
      {account.hidden ? 'Unhide' : 'Hide'}
    </Button>
  ) : kind === 'delete' && preview ? (
    <Button type="button" variant="destructive-primary" size="standard" pending={busy} disabled={!confirmed} onClick={runDelete}>
      Delete permanently
    </Button>
  ) : null;

  return (
    <Sheet open onClose={editor.requestClose} guard={editor.guard} position="bottom"
      title={kind === 'add' ? 'New account' : account?.name ?? ''}
      pattern={kind === 'add' || kind === 'rename' ? 'short-editor' : 'confirmation'}
      stepKey={kind} busy={busy}
      // A late preview must not move focus off its counts; coarse pointers start at the title.
      initialFocus={() => (kind === 'add' || kind === 'rename') &&
        !window.matchMedia('(pointer: coarse)').matches ? nameRef.current : null}
      restoreFocus={restoreFocus}
      header={<>
        <h2 className="sheet-title">{heading}</h2>
        {account && kind !== 'menu' && <p className="acct-dialog-name">{account.name}</p>}
        {kind === 'menu' && <p className="sheet-meta">{account?.hidden ? 'Hidden from the app' : 'Visible'}</p>}
      </>}
      footer={<>
        {error && <Notice tone="error" role="alert">Error: {error}</Notice>}
        {kind === 'delete' && account && <div className="acct-history-remedy">
          <Button type="button" variant="secondary" size="standard" aria-disabled={busy} onClick={() => onOpenHistory(account)}>
            Open import history
          </Button>
        </div>}
        <FormActions
        back={!atOrigin && <Button type="button" variant="tertiary" size="standard" aria-disabled={busy} onClick={leave}>Back</Button>}
        cancel={kind !== 'menu' && <Button type="button" variant="secondary" size="standard" aria-disabled={busy} onClick={editor.requestClose}>Cancel</Button>}
        completion={completion}
        />
      </>}
    >
      {(kind === 'add' || kind === 'rename') && (
        <form id={formId} onSubmit={submitName} className="acct-name-form">
          {kind === 'add' && <p className="body-text">
            A name is all it needs. Import a statement into it whenever you have one — or
            create it from the import screen while you upload the first one.
          </p>}
          <Field control="input" id={kind === 'add' ? 'acct-new-name' : 'acct-name'} label="Name"
            help={kind === 'add'
              ? `It will hold amounts in ${baseCurrency}, your base currency.`
              : 'Only the tab changes. The transactions, the imports and the files stay where they are.'}
            controlProps={{ ref: nameRef, value: name, readOnly: busy,
              placeholder: kind === 'add' ? 'Sparkasse, cash, Revolut…' : undefined,
              onChange: (e) => setName(e.target.value) }}
          />
        </form>
      )}

      {kind === 'menu' && account && (
        <div className="acct-menu">
          <Button type="button" variant="tertiary" size="standard" className="acct-menu-item" onClick={() => onStep('rename')}>
            <span className="acct-menu-label">Rename</span>
            <span className="acct-menu-sub">The name on the tab. Nothing else about the account changes.</span>
          </Button>
          <Button type="button" variant="tertiary" size="standard" className="acct-menu-item" onClick={() => onOpenHistory(account)}>
            <span className="acct-menu-label">Import history</span>
            <span className="acct-menu-sub">Which files went into this account, when, and how many rows. Download the file you uploaded, or remove it.</span>
          </Button>
          <Button type="button" variant="tertiary" size="standard" className="acct-menu-item" onClick={() => onStep('hide')}>
            <span className="acct-menu-label">{account.hidden ? 'Unhide' : 'Hide'}</span>
            <span className="acct-menu-sub">{account.hidden
              ? 'Bring it back to the tabs and to every total.'
              : 'Off the screens and out of the totals. Nothing is deleted, and you can bring it back.'}</span>
          </Button>
          <Button type="button" variant="destructive-secondary" size="standard" className="acct-menu-item" onClick={() => onStep('delete')}>
            <span className="acct-menu-label">Delete</span>
            <span className="acct-menu-sub">Destroys the transactions, the imports and the uploaded files. Permanent.</span>
          </Button>
        </div>
      )}

      {kind === 'hide' && account && <p className="body-text">
        {account.hidden ? <>
          <strong>{account.name}</strong> comes back to the tabs, and its transactions
          start counting in the totals and the charts again.
        </> : <>
          <strong>{account.name}</strong> leaves the tabs, the totals and the charts.
          Its transactions stay in the database exactly as they are — nothing is
          deleted, nothing is exported differently, and you can bring it back from{' '}
          <em>Show hidden</em> under the tabs at any time.
        </>}
      </p>}

      {kind === 'delete' && account && <>
        <p className="body-text">
          This is not <em>Hide</em>. Deleting <strong>{account.name}</strong> destroys its
          data, and nothing here or in a backup taken afterwards can bring it back.
        </p>
        <p className="body-text">
          Money you moved between this account and another stops counting as a transfer
          once this side of it is gone, so another account's monthly income and expenses
          can change.
        </p>
        {previewError && <Notice tone="error" role="alert" remedy={
          <Button type="button" variant="secondary" size="compact" onClick={loadPreview}>Retry</Button>
        }>Error: {previewError}</Notice>}
        {/* Consequences precede the gate; an unread preview must offer no final delete. */}
        {preview && <ul className="acct-destroy">
          <li><strong>{preview.truncated ? `at least ${preview.transactions} transactions`
            : preview.transactions === 1 ? '1 transaction' : `${preview.transactions} transactions`}</strong>{' '}
            {preview.countedFrom === 'rows' ? 'in this account'
              : 'across its imports — this account is hidden, so its rows cannot be counted directly'}</li>
          <li><strong>{preview.imports === 1 ? '1 import' : `${preview.imports} imports`}</strong>{' '}
            and the record of what each one read</li>
          <li><strong>{preview.files === 1 ? '1 uploaded file' : `${preview.files} uploaded files`}</strong>{' '}
            still stored on this server</li>
        </ul>}
        {preview?.truncated && <Notice tone="warning">
          That count came back exactly at the limit this dialog asks for, so it is the
          limit and not the answer. There are at least that many, and how many more is
          not something this screen can find out.
        </Notice>}
        {!preview && !previewError && <Notice role="status">Counting what would go…</Notice>}
        {preview && <Field control="input" id="acct-delete-confirm"
          label={<>Type <strong>{account.name}</strong> to confirm</>}
          controlProps={{ value: confirmName, readOnly: busy, onChange: (e) => setConfirmName(e.target.value) }}
        />}
      </>}
      {busy && <Notice role="status">{kind === 'add' ? 'Creating account…'
        : kind === 'rename' ? 'Saving account name…'
        : kind === 'hide' ? account?.hidden ? 'Unhiding account…' : 'Hiding account…'
        : 'Deleting account…'}</Notice>}
    </Sheet>
  );
}
