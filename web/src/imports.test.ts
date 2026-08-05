import { describe, expect, it } from 'vitest';
import { GENERIC_PRESET_TITLE, importStatusLabel, importStatusNote, readAsSentence } from './imports';
import { ReadAs, ReadColumns } from './types';

describe('importStatusLabel', () => {
  it('names all five statuses the backend can write', () => {
    expect(importStatusLabel('pending')).toBe('Interrupted');
    expect(importStatusLabel('awaiting_confirmation')).toBe('Waiting for confirmation');
    expect(importStatusLabel('committed')).toBe('Imported');
    expect(importStatusLabel('failed')).toBe('Failed');
    expect(importStatusLabel('discarded')).toBe('Discarded');
  });

  it('returns an unknown slug as-is', () => {
    // the slug is the contract; a status this build has never heard of is shown
    // rather than swallowed or renamed
    expect(importStatusLabel('reparsing')).toBe('reparsing');
  });
});

describe('importStatusNote', () => {
  it('explains the statuses whose counts cannot explain themselves', () => {
    expect(importStatusNote('pending', null)).toMatch(/never recorded how it ended/);
    expect(importStatusNote('awaiting_confirmation', null)).toMatch(/Upload the same file again/);
  });

  it('separates the two ways a discarded row is reached', () => {
    expect(importStatusNote('discarded', null)).toMatch(/You discarded this import/);
    // the server declined it, and said why: its own sentence is rendered instead
    expect(importStatusNote('discarded', 'restore refused this import')).toBeNull();
  });

  it('adds nothing to a committed or a failed row, or to an unknown status', () => {
    expect(importStatusNote('committed', null)).toBeNull();
    expect(importStatusNote('failed', 'the file is not a spreadsheet')).toBeNull();
    expect(importStatusNote('reparsing', null)).toBeNull();
  });
});

describe('readAsSentence', () => {
  const RU: ReadColumns = {
    date: 'Дата выполнения',
    amount: 'Сумма',
    description: ['Описание'],
  };

  it('names the preset with the title the chip shows, and the columns it filled', () => {
    expect(
      readAsSentence({
        kind: 'preset',
        preset: 'revolut',
        title: 'Revolut (Statement CSV)',
        columns: RU,
      }),
    ).toBe(
      'Read with the "Revolut (Statement CSV)" preset — date from "Дата выполнения", ' +
        'amount from "Сумма", description from "Описание".',
    );
  });

  /**
   * The incident this whole field exists for: the same numbers, read by the reader the
   * user did not pick. The name is the one on the chip, so the two read as one thing.
   */
  it('names the generic reader the way the chip does, and says where it looked', () => {
    const sentence = readAsSentence({ kind: 'auto-detected', columns: RU });
    expect(sentence).toBe(
      `Read by "${GENERIC_PRESET_TITLE}", which found the columns in the file's own header — ` +
        'date from "Дата выполнения", amount from "Сумма", description from "Описание".',
    );
    expect(sentence).toContain('"Any statement"');
  });

  it('says a mapping came with the upload, without claiming it named every column', () => {
    expect(
      readAsSentence({
        kind: 'request-mapping',
        columns: { date: 'Datum', amount: 'Betrag', description: ['Text'] },
      }),
    ).toBe(
      'Read with a column mapping sent with this upload — date from "Datum", ' +
        'amount from "Betrag", description from "Text".',
    );
  });

  /** A PDF has no header, so naming columns would print invented words at the user. */
  it('names the PDF layout and no column, and points at no control', () => {
    const sentence = readAsSentence({ kind: 'pdf-template', title: 'Revolut' });
    expect(sentence).toBe(
      'Read as a Revolut PDF statement — a PDF has no column header, so the layout that ' +
        'matched decides the columns, not a preset.',
    );
    // "not the preset above" would point at a chip on the one screen that has one, and
    // at nothing on ImportHistory, which imports this same module
    expect(sentence).not.toContain('above');
  });

  it('joins several description columns into one readable clause', () => {
    expect(
      readAsSentence({
        kind: 'preset',
        preset: 'sparkasse',
        title: 'Sparkasse (CAMT CSV)',
        columns: {
          date: 'Buchungstag',
          amount: 'Betrag',
          description: ['Beguenstigter/Zahlungspflichtiger', 'Verwendungszweck'],
        },
      }),
    ).toContain('description from "Beguenstigter/Zahlungspflichtiger" and "Verwendungszweck".');
  });

  /**
   * types.ts is a hand-written mirror of the backend union and nothing checks the two
   * are in step, so a backend arm added without the mirror edit compiles green in both
   * packages and arrives here at runtime. There is no error boundary in this app and
   * Discard lives inside the card this sentence renders in, so a throw would leave the
   * staged import neither confirmable nor discardable. It says so instead.
   */
  it('describes an arm it has never heard of rather than taking the card down', () => {
    const unknown = { kind: 'ocr-guess', columns: RU } as unknown as ReadAs;
    expect(() => readAsSentence(unknown)).not.toThrow();
    expect(readAsSentence(unknown)).toBe(
      'Read by a reader this app does not recognise ("ocr-guess").',
    );
  });

  /** A slug quoted whole would read as the reader's name; the mark says it is not. */
  it('cuts an overlong slug with a mark rather than at a clean-looking edge', () => {
    const long = { kind: 'x'.repeat(60) } as unknown as ReadAs;
    expect(readAsSentence(long)).toBe(
      `Read by a reader this app does not recognise ("${'x'.repeat(39)}…").`,
    );
  });

  /**
   * The field is required on both sides, so this arrives only from a response the
   * backend did not build - and `readAs.kind` on it throws BEFORE the default arm can
   * answer, taking the card that holds Discard down with it.
   */
  it('says no reader was named rather than throwing on a summary without one', () => {
    const absent = undefined as unknown as ReadAs;
    expect(() => readAsSentence(absent)).not.toThrow();
    expect(readAsSentence(absent)).toBe(
      'This import did not name the reader that produced these numbers.',
    );
  });
});
