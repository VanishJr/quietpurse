import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { safeFilename, saveBlob } from '../download';
import { fmtDate } from '../format';
import { importStatusLabel, importStatusNote } from '../imports';
import { ImportRecord } from '../types';

interface Props {
  /** Required: a mount with no way back strands the user here. */
  onBack: () => void;
  /**
   * The caller's data moved — the meaning CsvImport's onImported established. A
   * deleted statement file is not the caller's data, so that does not fire it.
   */
  onChanged: () => void;
}

/** Which row's confirmation is open, and for which of the two deletes. One at a time. */
type Confirm = { kind: 'import' | 'document'; id: string };

/**
 * A refusal about a row renders in that row. The list runs to a hundred of them, so
 * one shown at the top of the panel is one the reader never sees.
 */
type RowError = { id: string; message: string };

/** Also what the download saves it as, so a nameless row reads as its own file. */
const titleOf = (r: ImportRecord): string =>
  r.originalFilename ?? `import-${r.id}.${r.sourceType}`;

/**
 * Three numbers from three fields. There is no rows-read total on the record and
 * none is computed here: accepted + rejected is an arithmetic the file never stated.
 */
const countsLine = (r: ImportRecord): string => {
  const owned =
    r.transactions === 0
      ? 'no transactions belong'
      : r.transactions === 1
        ? '1 transaction belongs'
        : `${r.transactions} transactions belong`;
  return [
    `${r.rowsAccepted} row${r.rowsAccepted === 1 ? '' : 's'} accepted`,
    ...(r.rowsRejected > 0 ? [`${r.rowsRejected} couldn't be read`] : []),
    `${owned} to this import`,
  ].join(' · ');
};

/**
 * A committed import owning nothing is deduplication, not a failure. rowsAccepted > 0
 * separates it from a committed import whose rows were all unreadable, where the
 * sentence beside it would be false.
 */
const deduplicated = (r: ImportRecord): boolean =>
  r.status === 'committed' && r.rowsAccepted > 0 && r.transactions === 0;

/** The row's own `transactions` — what deleteImport removes, not the rows in the file. */
const ownedClause = (n: number): string =>
  n === 1 ? '1 transaction that belongs' : `${n} transactions that belong`;

/**
 * What has been uploaded, and the two things that can be removed: the statement file
 * on its own, or the import and the rows it wrote (ROADMAP 4.5, 5.1, 6.1).
 *
 * No Confirm control anywhere, for any status: there is no way to read a staged
 * summary back, and confirming numbers nobody read is what the confirmation step
 * exists to prevent (007 D5).
 */
export function ImportHistory({ onBack, onChanged }: Props) {
  /** null = never loaded. A failed read must never render as "nothing imported yet". */
  const [imports, setImports] = useState<ImportRecord[] | null>(null);
  /** The list's own refusal: when it did not arrive there is no row to attach one to. */
  const [error, setError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<RowError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setNotice(null);
    setRowError(null);
    setConfirm(null);
    try {
      setImports((await api.imports()).imports);
    } catch (e) {
      // `imports` is left as it was: a reload that fails after a delete that worked
      // must not blank a list that did load
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openConfirm = (kind: Confirm['kind'], id: string) => {
    setNotice(null);
    setRowError(null);
    setConfirm({ kind, id });
  };

  const runDownload = async (r: ImportRecord) => {
    setBusy(true);
    setNotice(null);
    setRowError(null);
    try {
      // a Blob or a throw: the refusal cannot become a file (010 D23)
      const blob = await api.importDocument(r.id);
      saveBlob(blob, safeFilename(r.originalFilename, r.id, r.sourceType));
    } catch (e) {
      setRowError({ id: r.id, message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const runDeleteDocument = async (id: string) => {
    setBusy(true);
    setRowError(null);
    try {
      const { bytesRemoved } = await api.deleteImportDocument(id);
      // the server is the truth about documentAvailable, and a locally patched row
      // would also carry a transactions count nothing refreshed
      await load();
      setNotice(
        bytesRemoved
          ? 'The stored statement was deleted.'
          : 'This import no longer claims a stored file, and there were no bytes to remove.',
      );
    } catch (e) {
      setRowError({ id, message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const runDeleteImport = async (id: string) => {
    setBusy(true);
    setRowError(null);
    try {
      // the count the server reports, not the one the row carried
      const { transactions } = await api.deleteImport(id);
      await load();
      const removed = transactions === 1 ? '1 transaction' : `${transactions} transactions`;
      setNotice(
        transactions === 0
          ? 'Import deleted — no transactions were removed.'
          : `Import deleted — ${removed} removed.`,
      );
      // the backend re-paired transfers and the balances moved with the rows
      onChanged();
    } catch (e) {
      setRowError({ id, message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <button className="btn-link" onClick={onBack}>
        ← Back to accounts
      </button>
      <h1 className="title">Import history</h1>

      <p className="hint">The most recent imports, newest first — older ones may not be listed.</p>
      <p className="hint">
        The statement file you uploaded is kept. "Delete file" removes it and leaves the
        import and its transactions alone.
      </p>

      {error && (
        <p className="error">
          Error: {error}
          {/* without the read there is no list at all, so a page reload would
              otherwise be the only way back to one */}
          {imports === null && (
            <>
              {' · '}
              <button className="btn-link" type="button" disabled={busy} onClick={load}>
                Retry
              </button>
            </>
          )}
        </p>
      )}
      {notice && <p className="hint">{notice}</p>}

      {imports?.map((r) => {
        const title = titleOf(r);
        const note = importStatusNote(r.status, r.errorDetail);
        const open = confirm?.id === r.id ? confirm : null;
        return (
          <div key={r.id} className="row">
            <div className="row-main">
              <div className="row-title">{title}</div>
              <div className="row-sub">
                {importStatusLabel(r.status)} · {r.accountName ?? 'no account recorded'} ·{' '}
                {fmtDate(r.uploadedAt)}
              </div>
              <div className="row-sub">{countsLine(r)}</div>
              {note && <p className="hint">{note}</p>}
              {deduplicated(r) && (
                /* about the file as it was read, not about where the rows are now:
                   deleting the import that owns them leaves this row unchanged */
                <p className="hint">
                  Every row in this file had already been imported when it was read, so
                  none of them belong to this import.
                </p>
              )}
              {/* whole, never cut: the backend composes it against a 500-character
                  budget on the premise that all of it is read */}
              {r.errorDetail && <p className="hint">{r.errorDetail}</p>}
              {!r.documentAvailable && (
                <p className="hint">No stored file this server can read.</p>
              )}
              {rowError?.id === r.id && <p className="error">Error: {rowError.message}</p>}

              {open && (
                <>
                  {open.kind === 'document' ? (
                    <p className="hint">
                      Delete the stored copy of this statement? The import and its
                      transactions stay; only the file goes.
                    </p>
                  ) : r.transactions === 0 ? (
                    <p className="hint">
                      Delete this import? No transactions belong to it, so nothing leaves
                      your data. The account stays.
                    </p>
                  ) : (
                    /* what goes is what this import first wrote, in both directions: an
                       overlapping later file did not take those rows over, and its own
                       bytes cannot be uploaded again to put them back */
                    <p className="hint">
                      Delete this import and the {ownedClause(r.transactions)} to it? Rows
                      this file shared with an earlier import stay — they belong to that
                      one. Rows a later import's file also contained go with these, and
                      re-uploading that file will not bring them back. The account stays
                      too.
                    </p>
                  )}
                  <div className="btn-row">
                    <button className="btn-ghost" disabled={busy} onClick={() => setConfirm(null)}>
                      Cancel
                    </button>
                    <button
                      className="btn-danger"
                      disabled={busy}
                      onClick={() =>
                        open.kind === 'import' ? runDeleteImport(r.id) : runDeleteDocument(r.id)
                      }
                    >
                      {open.kind === 'import' ? 'Delete import' : 'Delete file'}
                    </button>
                  </div>
                </>
              )}
            </div>

            {!open && (
              <>
                {r.documentAvailable && (
                  <button
                    className="btn-ghost"
                    disabled={busy}
                    onClick={() => runDownload(r)}
                    aria-label={`Download the file for ${title}`}
                  >
                    Download
                  </button>
                )}
                {/* ungated on purpose (010 D15): documentAvailable is READABLE, not
                    "bytes exist", and a row whose pointer was stripped is the likeliest
                    of all to still have a statement on disk. Hiding this button leaves
                    Delete import as the only way to reach it. */}
                <button
                  className="btn-danger"
                  disabled={busy}
                  onClick={() => openConfirm('document', r.id)}
                  aria-label={`Delete the file for ${title}`}
                >
                  Delete file
                </button>
                <button
                  className="btn-danger"
                  disabled={busy}
                  onClick={() => openConfirm('import', r.id)}
                  aria-label={`Delete import ${title}`}
                >
                  Delete import
                </button>
              </>
            )}
          </div>
        );
      })}

      {imports !== null && imports.length === 0 && (
        <div className="empty">
          <p>
            Nothing has been imported yet. Upload a statement and it shows up here, with the
            file it came from.
          </p>
        </div>
      )}
    </section>
  );
}
