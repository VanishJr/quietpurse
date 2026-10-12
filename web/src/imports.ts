import { ReadAs, ReadColumns, SeriesCounts } from './types';

export const IMPORT_STATUS_LABELS: Record<string, string> = {
  pending: 'Interrupted',
  awaiting_confirmation: 'Waiting for confirmation',
  committed: 'Imported',
  failed: 'Failed',
  discarded: 'Discarded',
};

export const importStatusLabel = (status: string): string =>
  IMPORT_STATUS_LABELS[status] ?? status;

/**
 * The line under a row that the label and the counts cannot carry on their own.
 *
 * `committed` and `failed` get none. For a committed import the counts say it all. For
 * a failed one, a note would have to describe what happened to the rows, which is
 * exactly what no status is allowed to imply.
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
      // on a discarded row NULL means the user declined it. Anything else means the
      // server did, and then errorDetail is its own explanation
      return errorDetail === null ? 'You discarded this import. Nothing was imported.' : null;
    default:
      return null;
  }
}

/**
 * Deliberately a PREFIX of the backend's own title for the generic reader and not equal
 * to it: the long form is a chip label, and pasted into the sentence below it would put
 * a parenthetical clause in the middle of a sentence.
 */
export const GENERIC_PRESET_TITLE = 'Any statement';

/** How much of an unrecognised reader's slug is quoted back. */
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
 * pair came from and the claim says what the check could have caught. A lead-in that
 * outran its claim, such as "Checked against" over a pair nothing checked, would bring
 * back the completeness claim the sheet gate removed, through the front of the sentence.
 *
 * The arms:
 *
 * - no counts at all: the document printed the pair, and every row between them adds
 *   up to it. That is the PDF, and the gate's blindness to a row lost from either end
 *   never applied to it.
 * - every run checked: the pair is derived and the rows read run unbroken through it.
 * - some checked: the pair is still true and still shown, and the part of it that
 *   rests on a run of one row is named.
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
      ? 'The other states a single row'
      : `The other ${unchecked} state a single row each`;
  return {
    lead,
    claim: `${checked} of them run${checked === 1 ? 's' : ''} unbroken from one to the other. ${others}, so nothing could check ${unchecked === 1 ? 'it' : 'them'}.`,
  };
}

/**
 * Which reader produced the numbers on the confirmation card. The counts cannot say
 * it, and a generic reader can produce every headline figure a bank's export was
 * expected to have without one correct reason.
 *
 * Total over `kind` with a `never`, not IMPORT_STATUS_LABELS' Record-with-a-fallback:
 * a status arrives from an old database row and may legitimately be unknown, where an
 * arm nobody named here is a build this repository should not be able to produce. The
 * default arm still returns a sentence rather than throwing, because a body can come
 * from a server this client was not built against, and a throw here takes the card
 * down with the staged import inside it.
 */
export function readAsSentence(readAs: ReadAs): string {
  // Ahead of the switch, because `readAs.kind` on an absent field throws before the
  // default arm below is ever reached. That is the same card takedown the arm exists
  // to prevent. The one condition also catches a kind that is no name at all, which the
  // arm would otherwise quote back as an empty string.
  const named: unknown = (readAs as { kind?: unknown } | undefined)?.kind;
  if (typeof named !== 'string' || named === '') {
    return 'This import did not name the reader that produced these numbers.';
  }
  switch (readAs.kind) {
    case 'preset':
      return `Read with the "${readAs.title}" preset: ${columnClause(readAs.columns)}.`;
    case 'auto-detected':
      return `Read by "${GENERIC_PRESET_TITLE}" using the file's own column names: ${columnClause(readAs.columns)}.`;
    case 'request-mapping':
      // "a column mapping", never "the": the request may have named one slot of three,
      // and the names that follow would then read as three columns the caller chose
      return `Read with a column mapping sent with this upload: ${columnClause(readAs.columns)}.`;
    case 'pdf-template':
      // "not from a preset" and not "not from the preset above": nothing keeps the
      // sentence on a screen with a chip on it
      return `Read as a ${readAs.title} PDF statement. A PDF has no column header, so the columns come from the layout that matched, not from a preset.`;
    default: {
      const unhandled: never = readAs;
      const kind = String((unhandled as { kind?: unknown }).kind);
      return `Read by a reader this app does not recognise ("${bounded(kind, UNKNOWN_KIND_MAX)}").`;
    }
  }
}
