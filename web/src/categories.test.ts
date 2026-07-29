import { describe, expect, it } from 'vitest';
import { CATEGORIES, CATEGORY_LABELS, categoryLabel } from './categories';
import { PROVIDER_LABELS, providerLabel } from './providers';

describe('category dictionary', () => {
  it('has a label for every slug in the picker', () => {
    for (const slug of CATEGORIES) {
      expect(CATEGORY_LABELS[slug], `no label for "${slug}"`).toBeTypeOf('string');
    }
  });

  it('returns an unknown slug as-is', () => {
    expect(categoryLabel('groceries-2')).toBe('groceries-2');
  });
});

describe('provider dictionary', () => {
  it('names every provider the API can return', () => {
    // 'upload' covers every statement the user brought in themselves - the parser
    // that read it (csv, xlsx) is an implementation detail and must never surface
    expect(providerLabel('upload')).toBe('Uploaded statement');
    expect(PROVIDER_LABELS).not.toHaveProperty('csv');
    expect(PROVIDER_LABELS).not.toHaveProperty('xlsx');
  });

  it('returns an unknown provider as-is', () => {
    expect(providerLabel('revolut-direct')).toBe('revolut-direct');
  });
});
