import { useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api';
import { isAvailable, useDismiss } from '../dismiss';
import { safeFilename, saveBlob } from '../download';
import { useEditorSession } from '../editor';
import { fmtDate, rowCount } from '../format';
import { importStatusLabel, importStatusNote } from '../imports';
import { ScreenShown } from '../screen';
import type { Account, ImportList, ImportRecord } from '../types';
import { Button } from './Button';
import { FormActions } from './FormActions';
import { Notice } from './Notice';
import { PageHeader } from './PageHeader';
import { MoreIcon } from './SettingsActionIcons';
import { Sheet } from './Sheet';

interface Props {
  onBack: () => void;
  backLabel: string;
  onChanged: () => void;
  account?: Account;
}

type Confirm = { kind: 'import' | 'document'; record: ImportRecord };
type RowError = { id: string; message: string };

const titleOf = (r: ImportRecord): string =>
  r.originalFilename || `import-${r.id}.${r.sourceType}`;

const countsLine = (r: ImportRecord): string => {
  const owned = r.transactions === 0 ? 'no transactions belong'
    : r.transactions === 1 ? '1 transaction belongs' : `${r.transactions} transactions belong`;
  return [
    `${rowCount(r.rowsAccepted)} accepted`,
    ...(r.rowsRejected > 0 ? [`${r.rowsRejected} not imported`] : []),
    `${owned} to this import`,
  ].join(' · ');
};

const deduplicated = (r: ImportRecord): boolean =>
  r.status === 'committed' && r.rowsAccepted > 0 && r.transactions === 0;

const ownedClause = (n: number): string =>
  n === 1 ? '1 transaction that belongs' : `${n} transactions that belong`;

const orderingLine = (list: ImportList): string => {
  const n = list.totals.imports - list.imports.length;
  if (n <= 0) return 'Newest first.';
  const older = n === 1 ? 'One older import is' : `${n} older imports are`;
  return `Newest first — the most recent ${list.imports.length} of ${list.totals.imports}. ${older} not listed.`;
};

export function ImportHistory({ onBack, backLabel, onChanged, account }: Props) {
  const id = useId();
  const shown = useContext(ScreenShown);
  const [list, setList] = useState<ImportList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<RowError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const records = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const menuGroup = useRef<HTMLDivElement>(null);
  const pending = useRef<'download' | 'document' | 'import' | null>(null);
  const pendingRecord = useRef<string | null>(null);
  const lastConfirmRecord = useRef<string | undefined>(undefined);
  const focusAfter = useRef<{ id: string; removed: boolean; owner: HTMLElement | null } | null>(null);
  const sequence = useRef(0);

  const recordNode = (recordId: string): HTMLElement | null =>
    Array.from(records.current?.querySelectorAll<HTMLElement>('[data-record-actions]') ?? [])
      .find((control) => control.dataset.recordActions === recordId) ?? null;

  const recordControl = (recordId?: string, exclude?: string): HTMLElement | null => {
    const controls = Array.from(records.current?.querySelectorAll<HTMLElement>('[data-record-actions]') ?? [])
      .filter((control) => isAvailable(control) && control.dataset.recordActions !== exclude);
    return controls.find((control) => control.dataset.recordActions === recordId) ?? controls[0] ?? heading.current;
  };

  const load = useCallback(async () => {
    const request = ++sequence.current;
    setLoading(true);
    setError(null);
    setNotice(null);
    setRowError(null);
    setConfirm(null);
    setMenu(null);
    try {
      const answer = await api.imports(account?.id);
      if (request === sequence.current) setList(answer);
    } catch (e) {
      if (request === sequence.current) setError((e as Error).message);
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }, [account?.id]);

  useEffect(() => {
    void load();
    return () => { sequence.current++; };
  }, [load]);

  const session = useEditorSession({ open: confirm !== null, dirty: false, busy,
    onClose: () => setConfirm(null) });

  useDismiss(menu, (target) => !!menuGroup.current?.contains(target), () => {
    const target = recordControl(menu ?? undefined);
    setMenu(null);
    target?.focus();
  }, () => setMenu(null));

  useLayoutEffect(() => {
    if (menu && shown) menuGroup.current?.querySelector<HTMLButtonElement>('[data-record-removal]')?.focus();
  }, [menu, shown]);

  useLayoutEffect(() => {
    const recovery = focusAfter.current;
    if (!recovery || confirm || loading || !shown) return;
    const focused = document.activeElement;
    const ownsFocus = recovery.owner !== null && (focused === document.body || focused === recovery.owner);
    if (!ownsFocus) {
      if (error) recovery.owner = null;
      else focusAfter.current = null;
      return;
    }
    if (error) {
      heading.current?.focus({ preventScroll: true });
      recovery.owner = heading.current;
      return;
    }
    focusAfter.current = null;
    const target = recordControl(recovery.removed ? undefined : recovery.id, recovery.removed ? recovery.id : undefined);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView?.({ block: 'nearest' });
  }, [confirm, list, loading, error, shown]);

  const openConfirm = (kind: Confirm['kind'], record: ImportRecord) => {
    if (pending.current || loading) return;
    setMenu(null);
    setNotice(null);
    setRowError(null);
    lastConfirmRecord.current = record.id;
    setConfirm({ kind, record });
  };

  const runDownload = async (r: ImportRecord) => {
    if (pending.current) return;
    pending.current = 'download';
    pendingRecord.current = r.id;
    setBusy(true);
    setMenu(null);
    setNotice(null);
    setRowError(null);
    try {
      const blob = await api.importDocument(r.id);
      saveBlob(blob, safeFilename(r.originalFilename, r.id, r.sourceType));
    } catch (e) {
      setRowError({ id: r.id, message: (e as Error).message });
    } finally {
      pending.current = null;
      setBusy(false);
    }
  };

  const runDeleteDocument = async (recordId: string) => {
    if (pending.current) return;
    pending.current = 'document';
    setBusy(true);
    setRowError(null);
    try {
      const { bytesRemoved } = await api.deleteImportDocument(recordId);
      focusAfter.current = { id: recordId, removed: false, owner: recordNode(recordId) ?? heading.current };
      await load();
      setNotice(bytesRemoved ? 'The stored statement was deleted.'
        : 'This import no longer claims a stored file, and there were no bytes to remove.');
    } catch (e) {
      setRowError({ id: recordId, message: (e as Error).message });
    } finally {
      pending.current = null;
      setBusy(false);
    }
  };

  const runDeleteImport = async (recordId: string) => {
    if (pending.current) return;
    pending.current = 'import';
    setBusy(true);
    setRowError(null);
    try {
      const { transactions } = await api.deleteImport(recordId);
      focusAfter.current = { id: recordId, removed: true, owner: recordNode(recordId) ?? heading.current };
      await load();
      const removed = transactions === 1 ? '1 transaction' : `${transactions} transactions`;
      setNotice(transactions === 0 ? 'Import deleted — no transactions were removed.'
        : `Import deleted — ${removed} removed.`);
      onChanged();
    } catch (e) {
      setRowError({ id: recordId, message: (e as Error).message });
    } finally {
      pending.current = null;
      setBusy(false);
    }
  };

  const confirmationTitle = confirm?.kind === 'document' ? 'Delete stored file?' : 'Delete import?';
  const selected = confirm?.record;

  return (
    <section className="history-page" aria-busy={loading || undefined}>
      <PageHeader title="Import history" titleRef={heading}
        context={account?.name ?? 'All accounts'}
        returnAction={<Button type="button" variant="tertiary" size="compact" aria-disabled={busy}
          onClick={() => { if (!pending.current) onBack(); }}>← {backLabel}</Button>} />
      <div className="history-intro">
        {list && <p>{orderingLine(list)}</p>}
        <p>The statement file you uploaded is kept. "Delete file" removes it and leaves the import and its transactions alone.</p>
      </div>
      {loading && <Notice role="status">{list ? 'Updating import history…' : 'Loading import history…'}</Notice>}
      {error && <Notice title="History could not be loaded" tone="error" role="alert" remedy={
        <Button type="button" variant="secondary" size="standard" aria-disabled={busy || loading} onClick={() => {
          if (focusAfter.current) focusAfter.current.owner = heading.current;
          heading.current?.focus();
          void load();
        }}>Retry</Button>
      }><p>Error: {error}</p>{list && <p>The previously loaded records remain below; this list has not been refreshed.</p>}</Notice>}
      {notice && <Notice role="status">{notice}</Notice>}
      <div className="history-records" ref={records}>
        {list?.imports.map((r) => {
          const title = titleOf(r);
          const note = importStatusNote(r.status, r.errorDetail);
          const recordId = `${id}-${r.id}`;
          return (
            <article key={r.id} className="history-record" aria-labelledby={recordId}>
              <div className="history-record__identity">
                <h2 id={recordId}>{title}</h2>
                <p className="history-record__context">{importStatusLabel(r.status)} · {r.accountName ?? 'no account recorded'} · {fmtDate(r.uploadedAt)}</p>
                <p className="history-record__counts">{countsLine(r)}</p>
                {note && <p>{note}</p>}
                {deduplicated(r) && <p>Every row in this file had already been imported when it was read, so none of them belong to this import.</p>}
                {r.errorDetail && <p className="history-record__diagnostic">{r.errorDetail}</p>}
                {!r.documentAvailable && <p>No stored file this server can read.</p>}
                {rowError?.id === r.id && !confirm && <Notice tone="error" role="alert">Error: {rowError.message}</Notice>}
              </div>
              <div className="history-record__actions" ref={menu === r.id ? menuGroup : undefined}>
                {r.documentAvailable && <Button type="button" variant="secondary" size="touch" aria-disabled={busy || loading}
                  pending={busy && pending.current === 'download' && pendingRecord.current === r.id}
                  onClick={() => runDownload(r)} aria-label={`Download the file for ${title}`}>Download</Button>}
                <Button type="button" variant="tertiary" size="touch" aria-label={`Actions for ${title}`}
                  data-record-actions={r.id} aria-expanded={menu === r.id} aria-controls={menu === r.id ? `${recordId}-actions` : undefined}
                  aria-disabled={busy || loading} onClick={() => setMenu(menu === r.id ? null : r.id)}>
                  <MoreIcon /> Actions
                </Button>
                {menu === r.id && <div id={`${recordId}-actions`} className="history-record__popover" role="group" aria-label={`Actions for ${title}`}>
                  <Button type="button" variant="destructive-secondary" size="touch" data-record-removal
                    onClick={() => openConfirm('document', r)} aria-label={`Delete the file for ${title}`}>Delete file</Button>
                  <Button type="button" variant="destructive-secondary" size="touch"
                    onClick={() => openConfirm('import', r)} aria-label={`Delete import ${title}`}>Delete import</Button>
                </div>}
              </div>
            </article>
          );
        })}
      </div>
      {list?.imports.length === 0 && <Notice placement="content"><p>{account
        ? `Nothing has been imported into ${account.name} yet. Upload a statement into it and it shows up here, with the file it came from.`
        : 'Nothing has been imported yet. Upload a statement and it shows up here, with the file it came from.'}</p></Notice>}
      <Sheet open={confirm !== null} onClose={session.requestClose} pattern="confirmation" title={confirmationTitle}
        busy={busy} initialFocus={() => cancel.current} restoreFocus={() => recordControl(lastConfirmRecord.current)}
        header={<h2>{confirmationTitle}</h2>} footer={selected && <FormActions cancel={
          <Button ref={cancel} type="button" variant="secondary" size="standard" aria-disabled={busy} onClick={session.requestClose}>Cancel</Button>
        } completion={
          <Button type="button" variant="destructive-primary" size="standard" pending={busy} onClick={() =>
            confirm?.kind === 'document' ? runDeleteDocument(selected.id) : runDeleteImport(selected.id)}>
            {confirm?.kind === 'document' ? 'Delete file' : 'Delete import'}
          </Button>
        } />}>
        {selected && <>
          <p className="history-confirm-file">{titleOf(selected)}</p>
          <p className="history-confirm-context">{selected.accountName ?? 'no account recorded'}</p>
          {confirm?.kind === 'document' ? <p>Delete the stored copy of this statement? The import and its transactions stay; only the file goes.</p>
            : selected.transactions === 0 ? <p>Delete this import? No transactions belong to it, so nothing leaves your data. Its stored file is removed too. The account stays.</p>
            : <p>Delete this import and the {ownedClause(selected.transactions)} to it? Rows this file shared with an earlier import stay — they belong to that one. Rows a later import's file also contained go with these, and re-uploading that file will not bring them back. Its stored file is removed too. The account stays too.</p>}
          {rowError?.id === selected.id && <Notice tone="error" role="alert">Error: {rowError.message}</Notice>}
        </>}
      </Sheet>
    </section>
  );
}
