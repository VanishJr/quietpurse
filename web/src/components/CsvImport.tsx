import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { fmtDate, fmtDay, fmtMoney } from '../format';
import { CsvImportResult, ImportConfirmed, ImportSummary } from '../types';
import { Chips } from './Chips';

/** Fallback if /api/imports/presets is unreachable — the backend ships these too. */
const FALLBACK_PRESETS = [{ key: 'generic', title: 'Any statement' }];

const ACCEPTED =
  '.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Above this a file is not read in the browser just to count its lines. */
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

/** How much of the file is looked at to decide whether counting lines means anything. */
const SNIFF_BYTES = 8192;

/** Zip (so .xlsx), PDF, the older Excel format, gzip — the backend's own signatures. */
const BINARY_SIGNATURES = [
  [0x50, 0x4b, 0x03, 0x04],
  [0x25, 0x50, 0x44, 0x46],
  [0xd0, 0xcf, 0x11, 0xe0],
  [0x1f, 0x8b],
];

/**
 * By content, never by the name: a bank that calls its workbook statement.csv is not
 * hypothetical, and the backend deliberately ignores the extension. Counting the
 * newlines of a decoded zip puts an invented row count on the screen.
 */
const looksLikeText = (head: Uint8Array): boolean =>
  !BINARY_SIGNATURES.some((sig) => sig.every((b, i) => head[i] === b)) && !head.includes(0);

interface Props {
  /** Shown as a panel with a back link; omitted — inline (the first-run wizard). */
  onBack?: () => void;
  /**
   * Called once rows have actually landed, so the caller can refresh its data —
   * which is after Confirm, not after the upload: an upload writes nothing.
   */
  onImported?: () => void;
}

/**
 * Importing a bank statement. The only way to get data out of a bank with no API,
 * and the way to add a month that a sync can't reach.
 *
 * Available both in the first-run wizard and from the Overview screen: a statement is
 * not a one-off setup step — next month there will be another one.
 */
export function CsvImport({ onBack, onImported }: Props) {
  const [presets, setPresets] = useState(FALLBACK_PRESETS);
  const [preset, setPreset] = useState('generic');
  const [accountName, setAccountName] = useState('');
  const [currency, setCurrency] = useState('EUR');
  const [csvText, setCsvText] = useState('');
  /** the chosen file itself: a workbook is bytes, and only the backend can read it */
  const [file, setFile] = useState<File | null>(null);
  /** row count for the preview — null for a file we can't count lines in */
  const [fileRows, setFileRows] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CsvImportResult | null>(null);
  /** what landed once the summary was accepted — the backend's counts, not the preview's */
  const [confirmed, setConfirmed] = useState<ImportConfirmed | null>(null);
  const [discarded, setDiscarded] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  /** which input a pending read belongs to — a slow one must not label a newer one */
  const pickSeq = useRef(0);

  // the preset list lives on the backend; keeping a second copy here would drift
  useEffect(() => {
    api.importPresets().then((r) => setPresets(r.presets)).catch(() => {});
  }, []);

  /**
   * New input, whichever way it arrived: the pending read no longer describes it,
   * and neither does the last import's outcome. One place, so a pick and a paste
   * cannot come to disagree about which of the three they invalidate.
   */
  const newInput = (): number => {
    setFileRows(null);
    setError(null);
    setResult(null);
    setConfirmed(null);
    setDiscarded(false);
    return ++pickSeq.current;
  };

  const takeFile = async (picked: File | undefined) => {
    if (!picked) return;
    // before the first await, and fileRows is left cleared if a read throws: the
    // previous file's count standing beside this file's name is an invented number
    const seq = newInput();
    setFile(picked);
    setCsvText('');
    // a sensible default the user can still edit
    if (!accountName.trim()) setAccountName(picked.name.replace(/\.(csv|xlsx)$/i, ''));
    // a big file is not worth reading into the tab twice just to count its lines
    if (picked.size > MAX_PREVIEW_BYTES) return;
    try {
      const head = new Uint8Array(await picked.slice(0, SNIFF_BYTES).arrayBuffer());
      if (!looksLikeText(head)) return;
      const rows = (await picked.text()).trim().split(/\r?\n/).length - 1;
      // a 1 MB .csv followed at once by a workbook, or by a paste: this read
      // finishes last, and without the check it labels whatever came after it
      if (seq === pickSeq.current) setFileRows(rows);
    } catch {
      // the size is shown instead; the import itself reads the bytes on the backend
    }
  };

  const runImport = async () => {
    setBusy(true);
    try {
      setError(null);
      setConfirmed(null);
      setDiscarded(false);
      const form = new FormData();
      form.append('accountName', accountName.trim());
      form.append('currency', currency.trim());
      form.append('preset', preset);
      // the paste fallback goes through the same endpoint: it is a file too
      form.append('file', file ?? new File([csvText], 'pasted.csv', { type: 'text/csv' }));
      // this reads the file and answers with what it found — it imports nothing, so
      // onImported() stays out of here and fires when Confirm comes back
      setResult(await api.importStatement(form));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const runConfirm = async (summary: ImportSummary) => {
    setBusy(true);
    try {
      setError(null);
      setConfirmed(await api.confirmImport(summary.importId));
      onImported?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const runDiscard = async (summary: ImportSummary) => {
    setBusy(true);
    try {
      setError(null);
      await api.discardImport(summary.importId);
      setResult(null);
      setDiscarded(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const summary = result?.outcome === 'awaiting_confirmation' ? result.summary : null;
  const duplicate = result?.outcome === 'duplicate' ? result : null;
  /**
   * Rows the summary called new that somebody else's import wrote while this one was
   * waiting. Two numbers that disagree with no explanation read as "the rows I
   * approved were not written", which is the opposite of what happened.
   */
  const shortfall = summary && confirmed ? summary.newRows - confirmed.inserted : 0;
  /**
   * Rows that were genuinely already there when the file was read. Deliberately not
   * `total − skipped − inserted`: that arithmetic absorbs the shortfall too, so the
   * same rows would be counted in both paragraphs and this one would call them rows
   * the user imported before, when they were written after this file was read.
   * With this, the two paragraphs partition the accepted rows exactly.
   */
  const alreadyPresent = summary && confirmed ? summary.alreadyPresent : 0;

  return (
    <section>
      {onBack && (
        <>
          <button className="btn-link" onClick={onBack}>
            ← Back to accounts
          </button>
          <h1 className="title">Import a statement</h1>
        </>
      )}

      <p className="hint">
        Any bank that lets you download a statement works here, whether it has an API or
        not. Export it as CSV or Excel — in most banks that's "Export" or "Download" in the
        transaction list — and drop the file below. Nothing is uploaded anywhere: the file
        goes to your own backend and into your own database.
      </p>
      <p className="hint">
        Re-importing the same file, or one that overlaps a previous export, creates no
        duplicates — rows are matched by their contents. So it's safe to grab a wider date
        range than you need.
      </p>

      {/* drop zone */}
      <div
        className={`dropzone${dragging ? ' dropzone-active' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          takeFile(e.dataTransfer.files?.[0]);
        }}
        onClick={() => fileInput.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            fileInput.current?.click();
          }
        }}
        role="button"
        tabIndex={0}
        aria-label="Choose a CSV or Excel statement file"
      >
        <div className="dropzone-icon" aria-hidden="true">
          ⭳
        </div>
        {file ? (
          <>
            <div className="dropzone-title">{file.name}</div>
            <div className="dropzone-sub">
              {fileRows === null
                ? `${Math.max(1, Math.round(file.size / 1024))} kB`
                : fileRows > 0
                  ? `${fileRows} rows`
                  : 'empty file'}{' '}
              · click to choose another
            </div>
          </>
        ) : (
          <>
            <div className="dropzone-title">Drop a .csv or .xlsx statement here</div>
            <div className="dropzone-sub">or click to choose a file</div>
          </>
        )}
      </div>
      <input
        ref={fileInput}
        type="file"
        accept={ACCEPTED}
        hidden
        onChange={(e) => takeFile(e.target.files?.[0])}
      />

      <label className="setting-label" htmlFor="csv-preset">
        Column layout
      </label>
      <Chips
        label="Statement preset"
        options={presets.map((p) => ({ key: p.key, label: p.title }))}
        selected={preset}
        onSelect={setPreset}
      />
      <p className="hint">
        Pick your bank if it's listed. "Any statement" reads the header and finds the
        date, amount and description columns on its own — try it first.
      </p>

      <label className="setting-label" htmlFor="csv-account">
        Account name and currency
      </label>
      <div className="inline-row">
        <input
          id="csv-account"
          className="input"
          value={accountName}
          onChange={(e) => setAccountName(e.target.value)}
          placeholder="Sparkasse Giro"
        />
        <input
          className="input input-code"
          value={currency}
          onChange={(e) => setCurrency(e.target.value)}
          placeholder="EUR"
          aria-label="Account currency"
        />
      </div>
      <p className="hint">
        The name groups the statement into an account in the app — reuse the same one next
        month and the rows join it instead of creating a second account. The currency is
        used when the file doesn't carry one.
      </p>

      {/* paste fallback: some banks only show the statement in a browser window */}
      <details>
        <summary className="btn-link">…or paste the contents instead</summary>
        <p className="hint" style={{ marginTop: 8 }}>
          Pasting here replaces the chosen file.
        </p>
        <textarea
          className="input csv-input"
          value={csvText}
          onChange={(e) => {
            newInput();
            setCsvText(e.target.value);
            setFile(null);
          }}
          placeholder="Buchungstag;Betrag;Verwendungszweck…"
          aria-label="Statement contents"
        />
      </details>

      {error && <p className="error">Error: {error}</p>}

      <button
        className="btn"
        style={{ display: 'block', width: '100%', marginTop: 12 }}
        disabled={busy || !accountName.trim() || (!file && !csvText.trim())}
        onClick={runImport}
      >
        {busy && !summary ? 'Reading…' : 'Import'}
      </button>

      {discarded && (
        <p className="hint" style={{ marginTop: 12 }}>
          Discarded — nothing was imported. The file is untouched, so you can fix the
          column layout or the account name above and upload it again.
        </p>
      )}

      {duplicate && (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="switch-label">You've already imported this file</div>
          <p className="hint" style={{ marginTop: 6 }}>
            Its {duplicate.total} rows came in on {fmtDate(duplicate.uploadedAt)} and are
            already in your data. It wasn't read again, and nothing was duplicated.
          </p>
        </div>
      )}

      {summary && !confirmed && (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="switch-label">
            Read {summary.accepted} of {summary.total} rows — nothing imported yet
          </div>
          <p className="hint" style={{ marginTop: 6 }}>
            {fmtDay(summary.from)} to {fmtDay(summary.to)}, {summary.totals
              .map((t) => fmtMoney(t.net, t.currency))
              .join(' · ')}{' '}
            in total. They'll join{' '}
            {summary.accountExists
              ? `your existing "${summary.accountName}"`
              : `a new account "${summary.accountName}"`}
            .
          </p>
          {/*
            The backend counts `skipped` for rows it couldn't read. Rows it read fine but
            has already stored aren't counted anywhere — they're dropped by their contents
            on insert — so duplicates are whatever is left over. Without spelling that out,
            an overlapping export just reads as "0 new" and looks broken.
          */}
          {summary.alreadyPresent > 0 && (
            <p className="hint" style={{ marginTop: 6 }}>
              {summary.newRows} of them are new; {summary.alreadyPresent} are already in the
              database — this export overlaps one you imported before. Nothing will be
              duplicated.
            </p>
          )}
          {summary.skipped > 0 && (
            <p className="hint" style={{ marginTop: 6 }}>
              {summary.skipped} rows couldn't be read. If it's the whole file, the column
              layout is probably wrong — discard this and try your bank's preset above.
            </p>
          )}
          {summary.supersededImportId && (
            <p className="hint" style={{ marginTop: 6 }}>
              An earlier upload of this same file was still waiting to be confirmed. It has
              been dropped in favour of this one — it had imported nothing.
            </p>
          )}
          {summary.problems.slice(0, 3).map((p) => (
            <p key={p} className="hint" style={{ marginTop: 6 }}>
              {p}
            </p>
          ))}
          <div className="btn-row">
            <button className="btn-ghost" disabled={busy} onClick={() => runDiscard(summary)}>
              Discard
            </button>
            <button className="btn" disabled={busy} onClick={() => runConfirm(summary)}>
              {busy ? 'Importing…' : 'Confirm'}
            </button>
          </div>
        </div>
      )}

      {confirmed && (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="switch-label">
            Imported {confirmed.inserted} of {confirmed.total} rows
          </div>
          {alreadyPresent > 0 && (
            <p className="hint" style={{ marginTop: 6 }}>
              {alreadyPresent} were already in the database — this export overlaps one you
              imported before. Nothing was duplicated.
            </p>
          )}
          {shortfall > 0 && (
            <p className="hint" style={{ marginTop: 6 }}>
              {shortfall} of the rows this summary called new were written by another import
              while it waited here. They're in your data — under that import, not this one.
            </p>
          )}
          {confirmed.skipped > 0 && (
            <p className="hint" style={{ marginTop: 6 }}>
              {confirmed.skipped} rows couldn't be read. If it's the whole file, the column
              layout is probably wrong — try your bank's preset above.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
