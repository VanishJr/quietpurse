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
 * which is exactly what no status is allowed to imply (ROADMAP 4.4).
 */
export function importStatusNote(status: string, errorDetail: string | null): string | null {
  switch (status) {
    case 'pending':
      return 'The server stopped part-way through this import and never recorded how it ended.';
    case 'awaiting_confirmation':
      // a re-upload supersedes the outstanding import, which is the only way back to
      // the summary those numbers would be confirmed against (007 D5)
      return 'The file was read and nothing was imported. Upload the same file again to bring its summary back.';
    case 'discarded':
      // 007 D4: on a discarded row NULL means the user declined it and anything else
      // means the server did — in which case errorDetail is its own explanation
      return errorDetail === null ? 'You discarded this import — nothing was imported.' : null;
    default:
      return null;
  }
}
