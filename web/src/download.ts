/**
 * Saving bytes the API already handed over. Split out from the components so the one
 * call to URL.createObjectURL takes a Blob and nothing else — no Response, no path,
 * so a body nobody checked cannot become a file (010 D23).
 */

/** The server's own cap, so a name is not cut differently at the two ends. */
const MAX_FILENAME_CHARS = 100;

const UNSAFE = /[\x00-\x1f\x7f\\/]/g;

/**
 * By code point rather than by UTF-16 unit: a cap that lands inside an emoji leaves
 * half of one in the name the file is written under.
 */
const clean = (name: string): string =>
  Array.from(name.replace(UNSAFE, ''))
    .slice(0, MAX_FILENAME_CHARS)
    .join('')
    .replace(/^[.\s]+/, '')
    .trim();

/**
 * The `download` attribute for a name the user chose — attachmentDisposition's three
 * steps client-side: their own name, the id-derived one, a constant. Not the
 * server's cleanName: nothing here is percent-encoded, so its lone-surrogate rule
 * has nothing to protect, and a `download` attribute is UTF-8 with no ASCII half.
 */
export function safeFilename(
  name: string | null,
  importId: string,
  sourceType: string,
): string {
  return clean(name ?? '') || clean(`import-${importId}.${sourceType}`) || 'statement';
}

/** Object URL, detached anchor, revoke. The only URL.createObjectURL in web/src. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // a tick later, not synchronously: revoking in the same tick is reported to abort
  // the download of a large blob, and a statement that silently never arrives is
  // worse than a URL held one tick longer
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
