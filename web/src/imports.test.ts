import { describe, expect, it } from 'vitest';
import { importStatusLabel, importStatusNote } from './imports';

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
