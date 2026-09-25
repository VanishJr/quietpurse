import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { fmtDate, fmtDay, fmtMoney, rowCount } from '../format';
import { balanceClaim, GENERIC_PRESET_TITLE, readAsSentence } from '../imports';
import {
  Account,
  BalancesNotShown,
  ImportConfirmed,
  ImportSourceType,
  ImportSummary,
  StatementImportResult,
} from '../types';
import { Chips } from './Chips';

const FALLBACK_PRESETS = [{ key: 'generic', title: GENERIC_PRESET_TITLE }];

/**
 * What the file dialog offers, per format. Total over ImportSourceType: a format the
 * backend learns to read and this map does not name is reachable by drag-and-drop and
 * by nothing else. The tuple stops a row being half-written: the dotted extension the
 * dialog filters on first, the MIME type second, because `accept` matches a file on
 * either.
 */
const ACCEPT_TOKENS: Record<ImportSourceType, readonly [`.${string}`, string, ...string[]]> = {
  csv: ['.csv', 'text/csv'],
  xlsx: ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  pdf: ['.pdf', 'application/pdf'],
};

const ACCEPTED = Object.values(ACCEPT_TOKENS).flat().join(',');

/**
 * Why a statement that does print a running balance got no start-and-end pair out of
 * it. Total over the slug union: a state the backend learns to send and this map does
 * not name would render as a blank line where a reason belongs. None of these is a
 * rejected row, so none of them goes anywhere near `problems`.
 */
const BALANCES_NOT_SHOWN: Record<BalancesNotShown, string> = {
  'rows-outside-the-balance':
    "This file's running balance also covers rows that weren't imported, so it wasn't used to check the ones that were.",
  'rows-without-a-balance':
    "Some of the rows read state no running balance, so this file's own balance wasn't used to check them.",
  // "a running balance" and not "this file's": a statement can state several, and one
  // of them closing on itself is what suppresses the pair for all of them
  'balance-closes-on-itself':
    'A running balance in this file ends where it began, so there is no start and end to show for the statement.',
  'more-than-one-currency':
    'This file states a running balance per currency, so there is no single start and end to show.',
};

/**
 * The picker's option for an account that does not exist yet. A bare literal against
 * account chips keyed `id:<uuid>`, so a collision is impossible by construction
 * rather than by a fact about how account ids happen to be shaped today.
 */
const NEW_ACCOUNT = 'new';

const chipKey = (id: string): string => `id:${id}`;

/**
 * The upload's body. Outside the component deliberately: the account name is not a
 * binding here, so a client that sends one does not compile. The
 * backend refuses `accountName` and `currency` outright — an account is created by its
 * own request and never by an upload — so what this shape buys is that the refusal
 * is never reached: there is no state of this component from which a request the
 * server would reject can be composed.
 */
const uploadForm = (account: Account, preset: string, file: File): FormData => {
  const form = new FormData();
  form.append('accountId', account.id);
  form.append('preset', preset);
  form.append('file', file);
  return form;
};

const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

const SNIFF_BYTES = 8192;

const BINARY_SIGNATURES = [
  [0x50, 0x4b, 0x03, 0x04],
  [0x25, 0x50, 0x44, 0x46],
  [0xd0, 0xcf, 0x11, 0xe0],
  [0x1f, 0x8b],
];

/**
 * By content, never by the name: a bank that gives its workbook a .csv name is not
 * hypothetical. Counting the newlines of a decoded zip puts an invented row count on
 * the screen.
 */
const looksLikeText = (head: Uint8Array): boolean =>
  !BINARY_SIGNATURES.some((sig) => sig.every((b, i) => head[i] === b)) && !head.includes(0);

interface Props {
  /** Leaves the panel. Required: a mount with no way back strands the user here. */
  onBack: () => void;
  /**
   * Called once rows have actually landed, so the caller can refresh its data —
   * which is after Confirm, not after the upload: an upload stages the rows and imports
   * none of them.
   */
  onImported: () => void;
  /**
   * An account was created here, which happens before any row lands and so is not
   * `onImported`. Required: the account is on the server and on no screen until the
   * caller reloads, and onBack reloads nothing.
   */
  onAccountCreated: () => void;
  /**
   * What a new account will be created in — printed, not sent, since the server
   * defaults it to the same setting this came from. `null` when that setting could
   * not be read: the sentence is left out, and nothing here is disabled over it —
   * a cosmetic fetch must not block an import.
   */
  baseCurrency: string | null;
}

export function CsvImport({ onBack, onImported, onAccountCreated, baseCurrency }: Props) {
  const [presets, setPresets] = useState(FALLBACK_PRESETS);
  const [preset, setPreset] = useState('generic');
  /**
   * `null` means never loaded — never "you have none". A failed load that fell through
   * to "create a new one" would manufacture a second account for a bank the user
   * already has, and pressing Import is what writes it.
   */
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  /** which chip is pressed; null until the user picks, because nothing is preselected */
  const [pickedKey, setPickedKey] = useState<string | null>(null);
  const [accountName, setAccountName] = useState('');
  /**
   * The account this screen made, which outlives the press that made it: it exists
   * on the server whether or not the upload behind it produced a single row, and
   * that is the thing the reader is owed. Cleared when rows land in it.
   */
  const [created, setCreated] = useState<Account | null>(null);
  const [csvText, setCsvText] = useState('');
  /** the chosen file itself: a workbook is bytes, and only the backend can read it */
  const [file, setFile] = useState<File | null>(null);
  /** row count for the preview — null for a file we can't count lines in */
  const [fileRows, setFileRows] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<StatementImportResult | null>(null);
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
   * No argument, so hidden accounts are absent because the server left them out and
   * not because this filtered them; `web/src/SPEC.md` gives the reason under *Accounts
   * and statements, as the client handles them*.
   *
   * The failure is kept rather than swallowed, unlike the preset load: presets have
   * FALLBACK_PRESETS and a person's accounts have no fallback constant.
   */
  const loadAccounts = (): Promise<void> =>
    api.accounts().then(
      (a) => {
        setAccounts(a);
        setAccountsError(null);
      },
      (e: Error) => setAccountsError(e.message),
    );

  useEffect(() => {
    void loadAccounts();
  }, []);

  /** The picked account itself, derived — a second copy could come to disagree. */
  const picked = accounts?.find((a) => chipKey(a.id) === pickedKey) ?? null;
  /**
   * With no accounts at all the create arm is the only state there is, so it renders
   * without a picker above it. `accounts === null` makes both this and `picked`
   * false, which is what keeps Import disabled after a failed load.
   */
  const creating = accounts !== null && (accounts.length === 0 || pickedKey === NEW_ACCOUNT);
  const destinationReady = picked !== null || (creating && accountName.trim() !== '');

  /**
   * New input, whichever way it arrived: the pending read no longer describes it,
   * and neither does the last import's outcome. One place, so a pick and a paste
   * cannot come to disagree about what they invalidate.
   */
  const newInput = (): number => {
    setFileRows(null);
    setError(null);
    setResult(null);
    setConfirmed(null);
    setDiscarded(false);
    return ++pickSeq.current;
  };

  const takeFile = async (chosen: File | undefined) => {
    if (!chosen) return;
    // before the first await, and fileRows is left cleared if a read throws: the
    // previous file's count standing beside this file's name is an invented number
    const seq = newInput();
    setFile(chosen);
    setCsvText('');
    // a big file is not worth reading into the tab twice just to count its lines
    if (chosen.size > MAX_PREVIEW_BYTES) return;
    try {
      const head = new Uint8Array(await chosen.slice(0, SNIFF_BYTES).arrayBuffer());
      if (!looksLikeText(head)) return;
      const rows = (await chosen.text()).trim().split(/\r?\n/).length - 1;
      // a large .csv followed at once by a workbook, or by a paste: this read
      // finishes last, and without the check it labels whatever came after it
      if (seq === pickSeq.current) setFileRows(rows);
    } catch {
      // the size is shown instead; the import itself reads the bytes on the backend
    }
  };

  /**
   * The create arm's account, made before the file is uploaded. Every state write lands
   * before the caller awaits the upload, so a rejected upload finds the component
   * already on the picker arm: a second press then uploads into this account instead
   * of asking the server to create a name it created one press ago — which answers
   * 409 and refuses the user on behalf of an account this screen made for them.
   *
   * The list as well as the key, because `picked` is the key looked up in the list:
   * a key with no row renders a picker with nothing pressed and Import disabled.
   */
  const createDestination = async (): Promise<Account> => {
    const made = await api.createAccount(accountName.trim());
    setAccounts((list) => [...(list ?? []), made]);
    setPickedKey(chipKey(made.id));
    setAccountName('');
    setCreated(made);
    onAccountCreated();
    return made;
  };

  const runImport = async () => {
    setBusy(true);
    try {
      setError(null);
      setConfirmed(null);
      setDiscarded(false);
      // a throw here is the whole of the create arm's refusal: nothing below runs, so
      // a refused create never becomes an upload
      const account = picked ?? (await createDestination());
      // the paste fallback goes through the same endpoint: it is a file too
      const body = file ?? new File([csvText], 'pasted.csv', { type: 'text/csv' });
      // this reads the file and answers with what it found — it imports nothing, so
      // onImported() stays out of here and fires when Confirm comes back
      setResult(await api.importStatement(uploadForm(account, preset, body)));
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
      // rows are in it now, so it is no longer an account standing on nothing — and
      // the subject is cleared rather than the sentence gated on `confirmed`, which
      // newInput() resets on the next file chosen in this same mount.
      //
      // Only when the rows landed in THIS account: confirming into one the user
      // picked instead leaves the created one standing empty, which is the case the
      // sentence exists for. One slot is an accepted limit and not an oversight — a
      // second create overwrites the first, so an account made two presses ago is
      // announced nowhere; a list of them is a different screen's problem.
      if (created?.id === summary.accountId) setCreated(null);
      onImported();
      // a refresh of a list another tab may have moved; the account this screen
      // created went in when it was created, and does not arrive here
      await loadAccounts();
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
   * Rows the summary called new that another import wrote while this one was waiting.
   * Two numbers that disagree with no explanation read as "the rows I approved were not
   * written", which is the opposite of what happened.
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
  /**
   * The pair the backend checked these rows against, and the sentence that says how
   * much of it it actually reached. Derived here rather than in the card because the
   * lead-in and the claim are two ends of one sentence, decided by one value.
   */
  const balances = summary?.balances ?? null;
  const balanceLine = balances ? balanceClaim(balances.series) : null;
  /**
   * One sentence per reason that dropped a row, and the sentence is built after the
   * filter rather than inside the literal: a server older than these fields sends
   * none of them, `undefined > 0` is false, and the card says nothing instead of
   * "undefined rows couldn't be read".
   *
   * The filtered rows are missing from here on purpose, for the reason `web/src/SPEC.md`
   * gives under *The sentences a person reads, and what is lifted out of a screen to
   * hold them*.
   */
  const drops = summary
    ? [
        {
          key: 'unreadable',
          n: summary.unreadable,
          // the one bucket the advice is true for: nothing to pick for a row a rule
          // filtered, and nothing wrong with one that moved no money
          say: (n: number) =>
            `${rowCount(n)} couldn't be read. If it's the whole file, the column layout is` +
            ` probably wrong — discard this and try your bank's preset above.`,
        },
        {
          key: 'noMovement',
          n: summary.noMovement,
          // no cause clause: the movement is what is zero, after the fee, so a row whose
          // amount cell is not zero can land here
          say: (n: number) => `${rowCount(n)} moved no money, so there was nothing to import.`,
        },
      ].filter((d) => d.n > 0)
    : [];

  return (
    <section>
      <button className="btn-link" onClick={onBack}>
        ← Back to accounts
      </button>
      <h1 className="title">Import a statement</h1>

      {/* the drop zone says what is accepted; this says what to go and fetch, and the two
          are different lists: a PDF is read only in a layout the importer recognises, and
          one in any other layout is refused with a request for the CSV or Excel export */}
      <p className="hint">
        Any bank that lets you download a statement works here, whether it has an API or
        not. Export it as CSV or Excel — in most banks that's "Export" or "Download" in the
        transaction list — and drop the file below, or drop the PDF statement itself.
        Nothing is uploaded anywhere: the file goes to your own backend and into your own
        database.
      </p>
      <p className="hint">
        Re-importing the same file, or one that overlaps a previous export, creates no
        duplicates — rows are matched by their contents. So it's safe to grab a wider date
        range than you need.
      </p>

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
        aria-label="Choose a CSV, Excel or PDF statement file"
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
            <div className="dropzone-title">Drop a .csv, .xlsx or .pdf statement here</div>
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

      {accountsError && (
        <p className="error">
          Your accounts couldn't be loaded: {accountsError}.
          {/* only while there is no list at all: after a failed reload the picker below
              is still the one that loaded, and telling the user nothing can be imported
              over a working picker is false */}
          {accounts === null &&
            ' Nothing can be imported until the list is there — reload the page and try again.'}
        </p>
      )}

      {accounts !== null && accounts.length > 0 && (
        <>
          {/* a heading and not a <label>: Chips renders no control to point htmlFor at */}
          <div className="setting-label">Account</div>
          <Chips
            // not "Account": the account filter on the Transactions screen carries that
            // name, and two controls sharing an accessible name is one ambiguity for a
            // screen reader and another for anything selecting by it
            label="Account for this import"
            options={[
              ...accounts.map((a) => ({ key: chipKey(a.id), label: a.name })),
              { key: NEW_ACCOUNT, label: '+ New account' },
            ]}
            // nothing is preselected: an account chosen by the screen rather than by
            // the person is how a statement lands in the wrong one behind a 200
            selected={pickedKey ?? ''}
            onSelect={setPickedKey}
          />
          <p className="hint">
            Pick the account this statement belongs to — its rows join what's already
            there, and nothing is duplicated.
          </p>
        </>
      )}

      {/* on any loaded list, empty included: with every account removed the picker is
          gone, and this is then the only thing on screen saying why the bank the user
          is looking for is missing */}
      {accounts !== null && (
        <p className="hint">Accounts you've removed aren't listed; restore one first.</p>
      )}

      {creating && (
        <>
          <label className="setting-label" htmlFor="csv-account">
            Account name
          </label>
          <input
            id="csv-account"
            className="input"
            value={accountName}
            onChange={(e) => setAccountName(e.target.value)}
            placeholder="Sparkasse Giro"
          />
          <p className="hint">
            The account is created when you press Import, before the file is read.
            {baseCurrency !== null &&
              ` It will hold amounts in ${baseCurrency}, your base currency.`}
          </p>
        </>
      )}

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
        disabled={busy || !destinationReady || (!file && !csvText.trim())}
        onClick={runImport}
      >
        {busy && !summary ? 'Reading…' : 'Import'}
      </button>

      {discarded && (
        <p className="hint" style={{ marginTop: 12 }}>
          Discarded — nothing was imported. The file is untouched, so you can fix the
          column layout or the account above and upload it again.
        </p>
      )}

      {/* the write this screen makes before it uploads anything, and the one the user did
          not press a button called "Create" for. It stands until rows land in it, which
          covers every way this import can end without any: an error, a duplicate, a
          discard, and the summary card the user is about to discard from */}
      {created && (
        <p className="hint" style={{ marginTop: 12 }}>
          The account "{created.name}" was created when you pressed Import, before the file
          was read — it exists whether or not these rows land. Remove it from Overview if
          you didn't want it.
        </p>
      )}

      {duplicate && (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="switch-label">You've already imported this file</div>
          {/*
            The import as it was read, never where its rows are now: `total` is the rows
            the file had, not the rows that came in, and the day is the upload's. See
            `web/src/SPEC.md` under *The sentences a person reads, and what is lifted out
            of a screen to hold them*.
          */}
          <p className="hint" style={{ marginTop: 6 }}>
            You uploaded it on {fmtDate(duplicate.uploadedAt)}. It wasn't read again, and
            nothing was duplicated.
          </p>
          <p className="hint" style={{ marginTop: 6 }}>
            It had {rowCount(duplicate.total)} when it was read
            {duplicate.skipped > 0 && `, and ${duplicate.skipped} of them didn't import`}.
          </p>
        </div>
      )}

      {summary && !confirmed && (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="switch-label">
            Read {summary.accepted} of {summary.total} rows — nothing imported yet
          </div>
          {/*
            First, and above every number on this card: it says which reader produced
            them, so it qualifies all of them. Stated unconditionally and never diffed
            against the chip above — a "you picked X but it read as Y" warning would
            fire on every PDF uploaded with a chip selected, where the mismatch is by
            design, and it is knowledge only this client has where the REST response is
            the contract a mobile client reads.
          */}
          <p className="hint" style={{ marginTop: 6 }}>
            {readAsSentence(summary.readAs)}
          </p>
          <p className="hint" style={{ marginTop: 6 }}>
            {fmtDay(summary.from)} to {fmtDay(summary.to)}, {summary.totals
              .map((t) => fmtMoney(t.net, t.currency))
              .join(' · ')}{' '}
            in total. They'll join your existing "{summary.accountName}".
          </p>
          {/*
            Only when the format states its own balances at all. A PDF prints an
            opening and a closing box; a CSV or Excel statement prints a running
            balance per row, and the backend derives the pair from it — which is why
            the numbers below can be a sum the user will find in no single cell, and
            why the sentence says how many were added. A file that states neither
            gets no line: a "couldn't be reconciled" warning about nothing.

            Both halves of the sentence come from balanceClaim: it may claim the run and
            never that the statement is complete, and only the runs it could have failed
            on.
          */}
          {balances && balanceLine && (
            <p className="hint" style={{ marginTop: 6 }}>
              {balanceLine.lead}
              {fmtMoney(balances.opening, balances.currency)} at the start,{' '}
              {fmtMoney(balances.closing, balances.currency)} at the end.{' '}
              {balanceLine.claim}
            </p>
          )}
          {summary.balancesNotShown && (
            <p className="hint" style={{ marginTop: 6 }}>
              {BALANCES_NOT_SHOWN[summary.balancesNotShown]}
            </p>
          )}
          {summary.alreadyPresent > 0 && (
            <p className="hint" style={{ marginTop: 6 }}>
              {summary.newRows} of them are new; {summary.alreadyPresent} are already in the
              database — this export overlaps one you imported before. Nothing will be
              duplicated.
            </p>
          )}
          {drops.map((d) => (
            <p key={d.key} className="hint" style={{ marginTop: 6 }}>
              {d.say(d.n)}
            </p>
          ))}
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
          {/*
            A count and no cause, and that is the honest limit rather than an omission:
            this panel reads imports.rows_rejected, which keeps no reason; see
            `web/src/SPEC.md` under *The sentences a person reads, and what is lifted out
            of a screen to hold them*.
          */}
          {confirmed.skipped > 0 && (
            <p className="hint" style={{ marginTop: 6 }}>
              {rowCount(confirmed.skipped)} didn't import.
            </p>
          )}
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
        </div>
      )}
    </section>
  );
}
