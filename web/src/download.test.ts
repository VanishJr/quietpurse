import { describe, expect, it } from 'vitest';
import { safeFilename } from './download';

/**
 * originalFilename is a string the user chose, and it becomes a `download`
 * attribute — which React escapes as an attribute, not as a name the browser is
 * about to write to disk. Item 10's D28/D29 also mean this string is now the one
 * the user actually typed, so it is worth keeping.
 *
 * saveBlob is not here: it needs a DOM, and its object URL is asserted where it
 * matters, in ImportHistory.test.tsx.
 */

describe('safeFilename', () => {
  it('leaves an ordinary name alone, non-ASCII included', () => {
    expect(safeFilename('выписка.xlsx', 'imp-1', 'xlsx')).toBe('выписка.xlsx');
    expect(safeFilename('Sparkasse 2026-06.csv', 'imp-1', 'csv')).toBe('Sparkasse 2026-06.csv');
  });

  it('strips path separators and control characters', () => {
    expect(safeFilename('../../etc/passwd', 'imp-1', 'csv')).toBe('etcpasswd');
    expect(safeFilename('C:\\Users\\me\\statement.csv', 'imp-1', 'csv')).toBe(
      'C:Usersmestatement.csv',
    );
    expect(safeFilename('state\x00ment\x1f.csv\x7f', 'imp-1', 'csv')).toBe('statement.csv');
  });

  it('falls back to the id-derived name when there is none', () => {
    expect(safeFilename(null, 'imp-1', 'csv')).toBe('import-imp-1.csv');
    expect(safeFilename('', 'imp-1', 'xlsx')).toBe('import-imp-1.xlsx');
  });

  it('falls back the same way for a name that sanitises away entirely', () => {
    // the third step, || 'statement', is unreachable through this signature: the
    // derived name always starts with "import-". It is kept because the server's
    // attachmentDisposition keeps it, and for the day the template changes
    expect(safeFilename('///', 'imp-1', 'csv')).toBe('import-imp-1.csv');
    expect(safeFilename('...', 'imp-1', 'csv')).toBe('import-imp-1.csv');
    expect(safeFilename('   ', 'imp-1', 'csv')).toBe('import-imp-1.csv');
  });

  it('caps by code point, so a cap at an emoji does not leave half of one', () => {
    const name = `${'a'.repeat(99)}😀${'b'.repeat(200)}`;
    const cut = safeFilename(name, 'imp-1', 'csv');

    expect(Array.from(cut)).toHaveLength(100);
    expect(cut.endsWith('😀')).toBe(true);
    // the emoji is two UTF-16 units: a cap by .slice(0, 100) would end on a lone one
    expect(cut).toHaveLength(101);
  });
});
