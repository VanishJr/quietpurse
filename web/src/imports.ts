import { ReadAs, ReadColumns, SeriesCounts } from './types';

/**
 * Import status dictionary: the API returns stable slugs, the sentences live here
 * only — the same rule as the providers and the categories. Nothing is ever sent
 * back, so no code path branches on a label.
 */
export const IMPORT_STATUS_LABELS: Record<string, string> = {
  pending: 'Interrupted',
  awaiting_confirmation: 'Waiting for confirmation',
  committed: 'Imported',
  failed: 'Failed',
  discarded: 'Discarded',
};

/** Status label; an unknown value is returned as-is (an older row, a new status). */
export const importStatusLabel = (status: string): string =>
  IMPORT_STATUS_LABELS[status] ?? status;

/**
 * The line under a row that the label and the counts cannot carry on their own.
 *
 * `committed` and `failed` get none: for a committed import the counts say it all,
 * and for a failed one a note would have to describe what happened to the rows —
 * which is exactly what no status is allowed to imply.
 */
export function importStatusNote(status: string, errorDetail: string | null): string | null {
  switch (status) {
    case 'pending':
      return 'The server stopped part-way through this import and never recorded how it ended.';
    case 'awaiting_confirmation':
      // a re-upload supersedes the outstanding import, which is the only way back to
      // the summary those numbers would be confirmed against
      return 'The file was read and nothing was imported. Upload the same file again to bring its summary back.';
    case 'discarded':
      // on a discarded row NULL means the user declined it and anything else
      // means the server did — in which case errorDetail is its own explanation
      return errorDetail === null ? 'You discarded this import — nothing was imported.' : null;
    default:
      return null;
  }
}

/**
 * What the generic reader is called on this screen. Deliberately a PREFIX of the
 * backend's own title for it — "Any statement (auto-detect the date, amount and
 * description columns)" — and not equal to it: the long form is a chip label, and
 * pasting it into the sentence below would put a parenthetical clause in the middle
 * of a sentence. So the online chip carries more than this sentence names, and only
 * the offline fallback chip is word for word the same; what the backend sends is
 * asserted to START with this string in backend/test/upload.test.ts.
 */
export const GENERIC_PRESET_TITLE = 'Any statement';

/** How much of an unrecognised reader's slug is quoted back — see the default arm. */
const UNKNOWN_KIND_MAX = 40;

/** Cut with a mark, so a slug with more behind it does not read as the whole one. */
const bounded = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

const quoted = (names: readonly string[]): string => {
  const q = names.map((n) => `"${n}"`);
  return q.length < 2 ? (q[0] ?? '') : `${q.slice(0, -1).join(', ')} and ${q[q.length - 1]}`;
};

const columnClause = (columns: ReadColumns): string =>
  `date from "${columns.date}", amount from "${columns.amount}", description from ${quoted(columns.description)}`;

/**
 * The two ends of the balance sentence on the confirmation card: what the numbers are,
 * and what was actually verified about them.
 *
 * One function for both halves because they are one claim. The lead-in says where the
 * pair came from and the claim says what the check could have caught, and a lead-in
 * that outran its claim — "Checked against" over a pair nothing checked — is the
 * completeness claim the sheet gate removed, re-acquired through the front of the sentence.
 *
 * Four arms:
 *
 * - no counts at all: the document printed the pair, and every row between them adds
 *   up to it. That is the PDF, and the single-row blindness never applied to it.
 * - every run checked: the pair is derived and the rows read run unbroken through it.
 * - some checked: the pair is still true and still shown, and the part of it that
 *   rests on a run of one row is named. On the owner's real export that is one of two.
 * - none checked: every run is a single row, so no balance in the file was ever
 *   compared with another. The lead-in drops to "Read from" here, because nothing was
 *   checked and "Checked against" would be the claim wearing a hat.
 *
 * A derived pair is never withheld for this: the numbers are true and readable back
 * against the file, and "no pair could be derived" (balancesNotShown) is a different
 * state that must not be spelled the same way.
 */
export function balanceClaim(series: SeriesCounts | undefined): { lead: string; claim: string } {
  if (series === undefined) {
    return {
      lead: "Checked against the statement's own balances: ",
      claim: 'The rows add up.',
    };
  }
  const { summed, checked } = series;
  // the verb is the only difference between the two lead-ins, and it is the whole of
  // what the arm below may not say: a pair summed over runs nothing could fail on was
  // read out of the file, not checked against it
  const leadIn = (verb: string): string =>
    summed > 1
      ? `${verb} the ${summed} running balances this statement states, added together: `
      : `${verb} the statement's own balances: `;
  if (checked === 0) {
    return {
      lead: leadIn('Read from'),
      claim:
        summed > 1
          ? 'Each of them states a single row, so nothing here was checked.'
          : 'It states a single row, so nothing here was checked.',
    };
  }
  const lead = leadIn('Checked against');
  if (checked === summed) {
    return { lead, claim: 'The rows read run unbroken from one to the other.' };
  }
  // an unchecked run is a run of one link and there is no other kind, so "states a
  // single row" is true of every one of them rather than true of the ones measured
  const unchecked = summed - checked;
  const others =
    unchecked === 1
      ? 'the other states a single row'
      : `the other ${unchecked} state a single row each`;
  return {
    lead,
    claim: `${checked} of them run${checked === 1 ? 's' : ''} unbroken from one to the other; ${others}, so nothing could check ${unchecked === 1 ? 'it' : 'them'}.`,
  };
}

/**
 * Which reader produced the numbers on the confirmation card. The one thing the counts
 * cannot say: the generic reader has three times now produced every headline figure a
 * Revolut export was expected to have, and not one correct reason.
 *
 * Total over `kind` with a `never`, not IMPORT_STATUS_LABELS' Record-with-a-fallback:
 * a status arrives from an old database row and may legitimately be unknown, where an
 * arm nobody named here is a build this repository should not be able to produce.
 *
 * The default arm still returns a sentence rather than throwing, and the difference is
 * the whole summary card: the union is the server's declaration by type, so a build of
 * this app cannot name an arm the server does not — but a body can still come from a
 * server of another version than the one this client was built from — `web/dist` is
 * whatever was last built, the backend runs from source — or through a proxy; there is
 * no error boundary in this app, and Discard lives inside this card and nowhere else —
 * so a throw here would leave a staged import that can be neither confirmed nor
 * discarded from the UI at all.
 */
export function readAsSentence(readAs: ReadAs): string {
  // Ahead of the switch, because `readAs.kind` on an absent field throws before the
  // default arm below is ever reached — the same card takedown that arm exists to
  // prevent. The one condition also catches a kind that is no name at all, which the
  // arm would otherwise quote back as an empty string.
  const named: unknown = (readAs as { kind?: unknown } | undefined)?.kind;
  if (typeof named !== 'string' || named === '') {
    return 'This import did not name the reader that produced these numbers.';
  }
  switch (readAs.kind) {
    case 'preset':
      return `Read with the "${readAs.title}" preset — ${columnClause(readAs.columns)}.`;
    case 'auto-detected':
      return `Read by "${GENERIC_PRESET_TITLE}", which found the columns in the file's own header — ${columnClause(readAs.columns)}.`;
    case 'request-mapping':
      // "a column mapping", never "the": the request may have named one slot of three,
      // and the names that follow would then read as three columns the caller chose
      return `Read with a column mapping sent with this upload — ${columnClause(readAs.columns)}.`;
    case 'pdf-template':
      // "not a preset" and not "not the preset above": this module is imported by
      // ImportHistory too, and nothing keeps the sentence on a screen with a chip on it
      return `Read as a ${readAs.title} PDF statement — a PDF has no column header, so the layout that matched decides the columns, not a preset.`;
    default: {
      const unhandled: never = readAs;
      const kind = String((unhandled as { kind?: unknown }).kind);
      return `Read by a reader this app does not recognise ("${bounded(kind, UNKNOWN_KIND_MAX)}").`;
    }
  }
}
