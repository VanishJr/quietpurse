import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { CsvImportResult } from '../types';
import { Chips } from './Chips';

/** Fallback if /api/imports/presets is unreachable — the backend ships these too. */
const FALLBACK_PRESETS = [{ key: 'generic', title: 'Any statement' }];

const ACCEPTED =
  '.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const isCsvName = (name: string): boolean => /\.csv$/i.test(name);

/** Above this a file is not read in the browser just to count its lines. */
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

interface Props {
  /** Shown as a panel with a back link; omitted — inline (the first-run wizard). */
  onBack?: () => void;
  /** Called after a successful import, so the caller can refresh its data. */
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
  const fileInput = useRef<HTMLInputElement>(null);

  // the preset list lives on the backend; keeping a second copy here would drift
  useEffect(() => {
    api.importPresets().then((r) => setPresets(r.presets)).catch(() => {});
  }, []);

  const takeFile = async (picked: File | undefined) => {
    if (!picked) return;
    setError(null);
    setResult(null);
    setFile(picked);
    setCsvText('');
    // lines are a row count for a CSV and nonsense for a workbook, which is a zip —
    // and a big file is not worth reading into the tab twice just to count them
    const lines =
      isCsvName(picked.name) && picked.size <= MAX_PREVIEW_BYTES
        ? (await picked.text()).trim().split(/\r?\n/).length - 1
        : null;
    setFileRows(lines);
    // a sensible default the user can still edit
    if (!accountName.trim()) setAccountName(picked.name.replace(/\.(csv|xlsx)$/i, ''));
  };

  const runImport = async () => {
    setBusy(true);
    try {
      setError(null);
      const form = new FormData();
      form.append('accountName', accountName.trim());
      form.append('currency', currency.trim());
      form.append('preset', preset);
      // the paste fallback goes through the same endpoint: it is a file too
      form.append('file', file ?? new File([csvText], 'pasted.csv', { type: 'text/csv' }));
      const r = await api.importStatement(form);
      setResult(r);
      onImported?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

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
            setCsvText(e.target.value);
            setFile(null);
            setFileRows(null);
            // a success card left standing over new input reads as this one's result
            setError(null);
            setResult(null);
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
        {busy ? 'Importing…' : 'Import'}
      </button>

      {result && (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="switch-label">
            Imported {result.inserted} of {result.total} rows
          </div>
          {/*
            The backend counts `skipped` for rows it couldn't read. Rows it read fine but
            had already stored aren't counted anywhere — they're dropped by id on insert —
            so duplicates are whatever is left over. Without spelling that out, a second
            import of an overlapping export just reads as "0 imported" and looks broken.
          */}
          {result.total - result.skipped - result.inserted > 0 && (
            <p className="hint" style={{ marginTop: 6 }}>
              {result.total - result.skipped - result.inserted} were already in the
              database — this export overlaps one you imported before. Nothing was
              duplicated.
            </p>
          )}
          {result.skipped > 0 && (
            <p className="hint" style={{ marginTop: 6 }}>
              {result.skipped} rows couldn't be read. If it's the whole file, the column
              layout is probably wrong — try your bank's preset above.
            </p>
          )}
          {result.problems.slice(0, 3).map((p) => (
            <p key={p} className="hint" style={{ marginTop: 6 }}>
              {p}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
