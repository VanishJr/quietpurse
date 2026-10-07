import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
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
import { Button } from './Button';
import { Chips } from './Chips';
import { Field } from './Field';
import { FormActions } from './FormActions';
import { Notice } from './Notice';
import { PageHeader } from './PageHeader';
import { ImportIcon } from './NavIcons';

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

const fileSize = (bytes: number): string =>
  `${bytes === 0 ? 0 : Math.max(1, Math.round(bytes / 1024))} kB`;

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
  const [errorArea, setErrorArea] = useState<'setup' | 'result'>('setup');
  const [result, setResult] = useState<StatementImportResult | null>(null);
  /** what landed once the summary was accepted — the backend's counts, not the preview's */
  const [confirmed, setConfirmed] = useState<ImportConfirmed | null>(null);
  const [confirmationUncertain, setConfirmationUncertain] = useState(false);
  const [discarded, setDiscarded] = useState(false);
  const id = useId();
  const busyAction = useRef<'reading' | 'confirming' | 'discarding' | null>(null);
  const setupFocusRequested = useRef(false);
  const setupHeading = useRef<HTMLHeadingElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
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
  const summary = result?.outcome === 'awaiting_confirmation' ? result.summary : null;
  const duplicate = result?.outcome === 'duplicate' ? result : null;
  const reading = busy && busyAction.current === 'reading';
  const failed = error !== null && errorArea === 'setup';
  const preparing = !reading && !summary && !duplicate && !confirmed && !discarded && !failed;

  /**
   * New input, whichever way it arrived: the pending read no longer describes it,
   * and neither does the last import's outcome. One place, so a pick and a paste
   * cannot come to disagree about what they invalidate.
   */
  const newInput = (): number => {
    setFileRows(null);
    setConfirmationUncertain(false);
    setError(null);
    setResult(null);
    setConfirmed(null);
    setDiscarded(false);
    return ++pickSeq.current;
  };

  const takeFile = async (chosen: File | undefined) => {
    if (!chosen || busyAction.current || !preparing) return;
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
    if (busyAction.current || !preparing || !destinationReady || (!file && !csvText.trim())) return;
    busyAction.current = 'reading';
    setDragging(false);
    setBusy(true);
    try {
      setError(null);
      setConfirmed(null);
      setConfirmationUncertain(false);
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
      setErrorArea('setup');
      setError((e as Error).message);
    } finally {
      busyAction.current = null;
      setBusy(false);
    }
  };

  const runConfirm = async (summary: ImportSummary) => {
    if (busyAction.current || confirmed) return;
    busyAction.current = 'confirming';
    setBusy(true);
    try {
      setError(null);
      const answer = await api.confirmImport(summary.importId);
      setConfirmed(answer);
      // rows are in it now, so it is no longer an account standing on nothing — and
      // the subject is cleared rather than the sentence gated on `confirmed`, which
      // newInput() resets on the next file chosen in this same mount.
      //
      // Only when the rows landed in THIS account: confirming into one the user
      // picked instead leaves the created one standing empty, which is the case the
      // sentence exists for. One slot is an accepted limit and not an oversight — a
      // second create overwrites the first, so an account made two presses ago is
      // announced nowhere; a list of them is a different screen's problem.
      if (answer.inserted > 0 && created?.id === summary.accountId) setCreated(null);
      onImported();
      // a refresh of a list another tab may have moved; the account this screen
      // created went in when it was created, and does not arrive here
      await loadAccounts();
    } catch (e) {
      setConfirmationUncertain(true);
      setErrorArea('result');
      setError((e as Error).message);
    } finally {
      busyAction.current = null;
      setBusy(false);
    }
  };

  const runDiscard = async (summary: ImportSummary) => {
    if (busyAction.current || confirmed) return;
    busyAction.current = 'discarding';
    setBusy(true);
    try {
      setError(null);
      await api.discardImport(summary.importId);
      setResult(null);
      setDiscarded(true);
    } catch (e) {
      setErrorArea('result');
      setError((e as Error).message);
    } finally {
      busyAction.current = null;
      setBusy(false);
    }
  };

  // Layout, not passive: the heading must hold focus in the same commit that shows it, or a reader
  // (or anything waiting on the heading) acts in the frame where focus is still on the body.
  useLayoutEffect(() => {
    if (result) {
      (result.outcome === 'awaiting_confirmation' ? reviewHeading : resultHeading).current?.focus();
    }
  }, [result]);

  useLayoutEffect(() => {
    if (confirmed) resultHeading.current?.focus();
  }, [confirmed]);

  useLayoutEffect(() => {
    if (discarded) resultHeading.current?.focus();
  }, [discarded]);

  useLayoutEffect(() => {
    if (reading || failed) resultHeading.current?.focus();
  }, [reading, failed]);

  useLayoutEffect(() => {
    if (!preparing || !setupFocusRequested.current) return;
    setupFocusRequested.current = false;
    setupHeading.current?.focus();
    setupHeading.current?.scrollIntoView?.({ block: 'nearest' });
  }, [preparing]);

  const startAnother = () => {
    if (busyAction.current || (summary && !confirmed)) return;
    setupFocusRequested.current = true;
    setConfirmationUncertain(false);
    setError(null);
    setResult(null);
    setConfirmed(null);
    setDiscarded(false);
  };

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
  const emptyFile = file !== null && (file.size === 0 || fileRows === 0);

  const drops = summary
    ? [
        {
          key: 'unreadable',
          n: summary.unreadable,
          // the one bucket the advice is true for: nothing to pick for a row a rule
          // filtered, and nothing wrong with one that moved no money
          say: (n: number) =>
            `${rowCount(n)} couldn't be read. If it's the whole file, the column layout is` +
            ` probably wrong — discard this and try your bank's optional preset in setup.`,
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

  const sourceContext = (
    <dl className="import-source-context" aria-label="Import source">
      <div><dt>File</dt><dd>{file?.name ?? 'pasted.csv'}</dd></div>
      <div><dt>Destination</dt><dd>{summary?.accountName ?? picked?.name ?? accountName.trim()}</dd></div>
    </dl>
  );

  return (
    <section className="screen-inner import-page">
      <PageHeader
        title="Import a statement"
        context="Bring in a CSV, Excel or PDF statement. Finto reads it on this device."
        returnAction={
          <Button type="button" variant="tertiary" size="compact"
            aria-disabled={busy} onClick={() => { if (!busyAction.current) onBack(); }}>
            ← Back to accounts
          </Button>
        }
      />

      <div className="import-layout">
        {preparing && (
          <section className="import-setup" aria-labelledby={`${id}-setup-heading`}>
            <h2 id={`${id}-setup-heading`} ref={setupHeading} tabIndex={-1}>Set up your import</h2>
            <div className="import-step" aria-labelledby={`${id}-file-heading`}>
              <h3 id={`${id}-file-heading`} className="import-step-heading">Choose a file</h3>
              <p className="import-step-lead">Choose a statement from your bank, or drop it below.</p>
              <Button
                type="button" variant="secondary" size="standard"
                className={`import-dropzone${dragging ? ' import-dropzone-active' : ''}${file ? ' import-dropzone-selected' : ''}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (!busyAction.current) setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  void takeFile(e.dataTransfer.files?.[0]);
                }}
                onClick={() => { if (!busyAction.current) fileInput.current?.click(); }}
                aria-label={file
                  ? 'Choose another CSV, Excel or PDF statement file'
                  : 'Choose a CSV, Excel or PDF statement file'}
                aria-describedby={file ? `${id}-selected-file` : undefined}
              >
                <span className="import-dropzone-icon"><ImportIcon /></span>
                {file ? (
                  <>
                    <span className="import-file-details" id={`${id}-selected-file`}>
                      <span className="import-file-name">{file.name}</span>
                      <span className="import-file-meta">
                        {fileRows !== null && `${fileRows} rows · `}{fileSize(file.size)}
                      </span>
                      {emptyFile && <span className="import-file-empty" role="status">Empty file</span>}
                    </span>
                    <span className="import-file-choose">Click to choose another</span>
                  </>
                ) : (
                  <>
                    <span className="import-dropzone-title">Drop a .csv, .xlsx or .pdf statement here</span>
                    <span className="import-dropzone-sub">or click to choose a file</span>
                  </>
                )}
              </Button>
              <input
                ref={fileInput} type="file" accept={ACCEPTED} hidden
                onChange={(e) => {
                  void takeFile(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
              <details className="import-disclosure import-paste">
                <summary>…or paste the contents instead</summary>
                <Field
                  id={`${id}-paste`} label="Statement contents" control="textarea"
                  help="Pasting here replaces the chosen file."
                  controlProps={{
                    className: 'import-paste-input', value: csvText,
                    onChange: (e) => {
                      if (busyAction.current || !preparing) return;
                      newInput();
                      setCsvText(e.target.value);
                      setFile(null);
                    },
                    placeholder: 'Buchungstag;Betrag;Verwendungszweck…',
                  }}
                />
              </details>
            </div>

            <div className="import-step" aria-labelledby={`${id}-account-heading`}>
              <h3 id={`${id}-account-heading`} className="import-step-heading">Account</h3>
              <p className="import-step-lead">Choose where this statement's transactions belong.</p>
              {accountsError && (
                <Notice tone="error" role="alert" className="import-accounts-error">
                  <p>
                    Your accounts couldn't be loaded: {accountsError}.
                    {accounts === null &&
                      ' Nothing can be imported until the list is there — reload the page and try again.'}
                  </p>
                </Notice>
              )}
              {accounts === null && !accountsError && (
                <Notice role="status">Loading your accounts…</Notice>
              )}
              {accounts !== null && accounts.length > 0 && (
                <>
                  <Chips
                    label="Account for this import"
                    options={[
                      ...accounts.map((a) => ({ key: chipKey(a.id), label: a.name })),
                      { key: NEW_ACCOUNT, label: '+ New account' },
                    ]}
                    selected={pickedKey ?? ''}
                    onSelect={(key) => { if (!busyAction.current) setPickedKey(key); }}
                  />
                  <p className="import-help">
                    Pick the account this statement belongs to — its rows join what's already
                    there, and nothing is duplicated.
                  </p>
                </>
              )}
              {accounts !== null && (
                <p className="import-help">Hidden accounts aren't listed here — unhide one first.</p>
              )}
              {creating && (
                <Field
                  id={`${id}-account-name`} label="Account name" control="input"
                  help={
                    <>The account is created when you press Import, before the file is read.
                      {baseCurrency !== null &&
                        ` It will hold amounts in ${baseCurrency}, your base currency.`}
                    </>
                  }
                  controlProps={{
                    value: accountName,
                    onChange: (e) => { if (!busyAction.current) setAccountName(e.target.value); },
                    placeholder: 'Sparkasse Giro',
                  }}
                />
              )}
            </div>

            <details className="import-disclosure import-presets">
              <summary>Statement preset (optional)</summary>
              <Chips
                label="Statement preset"
                options={presets.map((p) => ({ key: p.key, label: p.title }))}
                selected={preset}
                onSelect={(key) => { if (!busyAction.current) setPreset(key); }}
              />
              <p className="import-help">
                Pick your bank if it's listed. "Any statement" reads the header and finds the
                date, amount and description columns on its own — try it first.
              </p>
            </details>
            <div className="import-submit">
              <p>No transactions are added until you review and confirm.</p>
              <FormActions completion={
                <Button type="button" variant="primary" size="standard"
                  disabled={!destinationReady || (!file && !csvText.trim())} onClick={runImport}>
                  Import
                </Button>
              } />
            </div>
          </section>
        )}

        {reading && (
          <section className="import-reading" aria-labelledby={`${id}-reading-heading`} aria-busy="true">
            <h2 id={`${id}-reading-heading`} ref={resultHeading} tabIndex={-1}>Reading statement</h2>
            {sourceContext}
            <Notice role="status">Reading the file… No transactions are added yet.</Notice>
          </section>
        )}

        {(failed || discarded || duplicate || summary || confirmed) && (
          <div className="import-results" role="region" aria-label="Import review or result">
            {failed && (
              <section className="card import-outcome import-failed" aria-labelledby={`${id}-failed-heading`}>
                <h2 id={`${id}-failed-heading`} className="import-outcome-heading" ref={resultHeading} tabIndex={-1}>
                  Couldn't read this statement
                </h2>
                {sourceContext}
                <Notice title="Error" tone="error" role="alert" className="import-error"
                  remedy="Change the source to try an optional bank preset or a corrected CSV/XLSX export. PDF statements work only when Finto recognises their layout.">
                  <p>{error}</p>
                </Notice>
              </section>
            )}
            {error && errorArea === 'result' && (
              <Notice title="Error" tone="error" role="alert" className="import-error"><p>{error}</p></Notice>
            )}
            {discarded && (
              <section className="card import-outcome import-discarded" aria-labelledby={`${id}-discarded-heading`}>
                <h2 id={`${id}-discarded-heading`} className="import-outcome-heading" ref={resultHeading} tabIndex={-1}>
                  Discarded — nothing was imported.
                </h2>
                {sourceContext}
                <p>The file is untouched. Start another import to change the preset or destination and read it again.</p>
              </section>
            )}
            {duplicate && (
              <section className="card import-outcome import-duplicate" aria-labelledby={`${id}-duplicate-heading`}>
                <h2 id={`${id}-duplicate-heading`} className="import-outcome-heading" ref={resultHeading} tabIndex={-1}>
                  You've already imported this file
                </h2>
                {sourceContext}
                <p>You uploaded it on {fmtDate(duplicate.uploadedAt)}. It wasn't read again.</p>
                <p>It had {rowCount(duplicate.total)} when it was read.</p>
                {duplicate.skipped > 0 && <p>{duplicate.skipped} of them didn't import.</p>}
                <p>Nothing was duplicated.</p>
              </section>
            )}

            {summary && !confirmed && (
              <section className="card import-review" aria-labelledby={`${id}-review-heading`} aria-busy={busy}>
                <h2 id={`${id}-review-heading`} className="import-review-heading" ref={reviewHeading} tabIndex={-1}>
                  Read {summary.accepted} of {summary.total} rows — {confirmationUncertain ? 'confirmation not verified' : 'nothing imported yet'}
                </h2>
                <p className="import-review-reader">{readAsSentence(summary.readAs)}</p>
                {sourceContext}

                <div className="import-review-metrics" aria-label="Statement figures">
                  <div className="import-review-metric">
                    <span className="import-review-metric-label">Rows</span>
                    <span className="import-review-metric-value">{summary.accepted} of {summary.total}</span>
                  </div>
                  <div className="import-review-metric">
                    <span className="import-review-metric-label">New rows</span>
                    <span className="import-review-metric-value">{summary.newRows}</span>
                  </div>
                  <div className="import-review-metric">
                    <span className="import-review-metric-label">Already present</span>
                    <span className="import-review-metric-value">{summary.alreadyPresent}</span>
                  </div>
                  <div className="import-review-metric">
                    <span className="import-review-metric-label">Omitted</span>
                    <span className="import-review-metric-value">{summary.skipped}</span>
                  </div>
                  <div className="import-review-metric">
                    <span className="import-review-metric-label">Period</span>
                    <span className="import-review-metric-value">
                      {fmtDay(summary.from)} to {fmtDay(summary.to)}
                    </span>
                  </div>
                  <div className="import-review-metric">
                    <span className="import-review-metric-label">Net</span>
                    <span className="import-review-metric-value import-review-net">
                      {summary.totals.map((t) => fmtMoney(t.net, t.currency)).join(' ·\n')}
                    </span>
                  </div>
                  {balances && balanceLine && (
                    <div className="import-review-metric">
                      <span className="import-review-metric-label">Statement balance</span>{' '}
                      {balances.series && (
                        <span className="import-review-balance-context">
                          {balances.series.summed > 1
                            ? `Combined from ${balances.series.summed} running balances in the file. `
                            : 'From a running balance in the file. '}
                        </span>
                      )}
                      <span className="import-review-metric-value">
                        {fmtMoney(balances.opening, balances.currency)} →{' '}
                        {fmtMoney(balances.closing, balances.currency)}
                      </span>
                    </div>
                  )}
                </div>

                <div className="import-review-details">
                  <h3>Details</h3>
                  <p>They'll join your existing "{summary.accountName}".</p>
                  {/* The pair and its claim stay one sentence: a derived pair does not prove completeness. */}
                  {balances && balanceLine && (
                    <p>
                      {balanceLine.lead}
                      {fmtMoney(balances.opening, balances.currency)} at the start,{' '}
                      {fmtMoney(balances.closing, balances.currency)} at the end.{' '}
                      {balanceLine.claim}
                    </p>
                  )}
                  {summary.balancesNotShown && (
                    <p>{BALANCES_NOT_SHOWN[summary.balancesNotShown]}</p>
                  )}
                  {summary.alreadyPresent > 0 && (
                    <p>
                      {summary.newRows} of them are new; {summary.alreadyPresent} are already in the
                      database — this export overlaps one you imported before. Nothing will be
                      duplicated.
                    </p>
                  )}
                  {summary.supersededImportId && (
                    <p>
                      An earlier upload of this same file was still waiting to be confirmed. It has
                      been dropped in favour of this one — it had imported nothing.
                    </p>
                  )}
                </div>

                {(drops.length > 0 || summary.problems.length > 0) && (
                  <Notice tone="warning" className="import-review-warnings">
                    <h3>Warnings</h3>
                    {drops.map((d) => <p key={d.key}>{d.say(d.n)}</p>)}
                    {summary.problems.map((p, i) => <p key={i}>{p}</p>)}
                  </Notice>
                )}
                {confirmationUncertain ? (
                  <Notice tone="warning">
                    The confirmation could not be verified. It may have committed despite the error.
                    Back to accounts leaves this review without claiming a discard; check Import history
                    or Transactions before trying again.
                  </Notice>
                ) : (
                  <p className="import-help">To change the source or destination, discard this review first. Back to accounts leaves it waiting.</p>
                )}
                {busy && (
                  <Notice role="status" className="import-pending">
                    {busyAction.current === 'confirming'
                      ? 'Confirming import… Transactions are being committed. Please wait.'
                      : 'Discarding review… Please wait.'}
                  </Notice>
                )}
                <FormActions className="import-review-actions" cancel={
                  <Button type="button" variant="secondary" size="standard" aria-disabled={busy}
                    pending={busy && busyAction.current === 'discarding'} onClick={() => runDiscard(summary)}>
                    Discard
                  </Button>
                } completion={
                  <Button type="button" variant="primary" size="standard" aria-disabled={busy}
                    pending={busy && busyAction.current === 'confirming'} onClick={() => runConfirm(summary)}>
                    Confirm import
                  </Button>
                } />
              </section>
            )}

            {confirmed && (
              <section className="card import-outcome import-confirmed" aria-labelledby={`${id}-confirmed-heading`}>
                <h2 id={`${id}-confirmed-heading`} ref={resultHeading} tabIndex={-1}
                  className={`import-outcome-heading${confirmed.inserted > 0 ? ' import-outcome-success' : ''}`}>
                  Imported {confirmed.inserted} of {confirmed.total} rows
                </h2>
                {sourceContext}
                {confirmed.skipped > 0 && (
                  <p>{rowCount(confirmed.skipped)} didn't import.</p>
                )}
                {alreadyPresent > 0 && (
                  <p>{alreadyPresent} were already in the database — this export overlaps one you
                    imported before. Nothing was duplicated.</p>
                )}
                {shortfall > 0 && (
                  <p>{shortfall} of the rows this summary called new were written by another import
                    while it waited here. They're in your data — under that import, not this one.</p>
                )}
              </section>
            )}

            {(failed || discarded || duplicate || confirmed) && (
              <FormActions className="import-outcome-actions" completion={
                <Button type="button" variant="primary" size="standard" aria-disabled={busy} onClick={startAnother}>
                  {failed ? 'Change source' : 'Start another import'}
                </Button>
              } />
            )}
          </div>
        )}

        {created && (
          <aside className="import-created" aria-label="Account created">
            <Notice title="Account created" role="status">
              <p>
                The account "{created.name}" was created when you pressed Import, before the file
                was read — it exists whether or not these rows land. Remove it from Overview if
                you didn't want it.
              </p>
            </Notice>
          </aside>
        )}

        {preparing && (
          <aside className="import-guide" aria-labelledby={`${id}-guide-heading`}>
            <h2 id={`${id}-guide-heading`}>Before you import</h2>
            <div className="import-guide-item">
              <h3>Getting the file</h3>
              <p>
                In your bank's transaction list, choose Export or Download. Finto can read a PDF
                only if it recognises the layout; otherwise, use the CSV or Excel export.
              </p>
            </div>
            <div className="import-guide-item">
              <h3>Your file stays here</h3>
              <p>
                Statements are read on this device. The file and its rows stay in your Finto folder.
              </p>
            </div>
            <div className="import-guide-item">
              <h3>Re-imports are safe</h3>
              <p>
                Rows are matched by content, so re-importing won't duplicate them. You can safely
                export a wider date range than you need.
              </p>
            </div>
          </aside>
        )}
      </div>
    </section>
  );
}
